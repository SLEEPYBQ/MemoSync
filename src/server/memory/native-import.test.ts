import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  NativeMemoryRoot,
  NativeImportOperation,
} from "../../shared/native-memory";
import { MemoryService } from "./index";
import {
  NativeMemoryDiscovery,
  nativeMarkdownBlocks,
  nativeTextSensitive,
  screenedNativeText,
} from "./native-discovery";
import {
  NativeMemoryImportService,
  type NativeImportOptions,
} from "./native-import";
import { NATIVE_BATCH_UNITS, NATIVE_REFINE_CONCURRENCY, NATIVE_REFINEMENT_RULES } from "./native-refinement";
import { EventStore } from "../event-store";
import { parseRawEntries } from "./native-parsers";
import { handleNativeMemoryRequest } from "./native-routes";
import {
  createNativeModelCaller,
  NATIVE_CODEX_CONFIG,
  type NativeModelCaller,
} from "./native-refinement-runtime";
import type { EngineRuntime } from "../model-access/runtime";

let dir: string,
  home: string,
  project: string,
  memory: MemoryService,
  service: NativeMemoryImportService,
  roots: NativeMemoryRoot[],
  topic: string;
const model = { provider: "codex" as const, model: "synthetic-only" };
function put(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
function open(
  caller?: NativeModelCaller,
  projectHomes?: NativeImportOptions["projectHomes"],
) {
  service = new NativeMemoryImportService({
    memory,
    discovery: new NativeMemoryDiscovery(home, () => roots),
    modelCaller: caller ?? fake,
    projectHomes,
    isClaimSuppressed: (content, owner) =>
      memory.store.wasMemorySuppressed(content, owner),
  });
}
function data(
  user: string,
): Array<{ unitId: string; text: string; evidenceThreadIds: string[] }> {
  return JSON.parse(
    user
      .split("UNTRUSTED UNITS (JSON):")[1]!
      .split("\n\nUNTRUSTED CORRECTIONS")[0]!
      .split("\n\nUNTRUSTED PREVIOUS PROPOSAL:")[0]!
      .trim(),
  );
}
const fake: NativeModelCaller = async (r) => ({
  value: {
    units: data(r.user).map((u) => ({
      unitId: u.unitId,
      items: [{ content: `Remember ${u.text.trim()}`, quote: u.text.trim() }],
    })),
  },
  usage: { inputTokens: 7, outputTokens: 3 },
});
function inventory() {
  return service.inventory.read();
}
function unit() {
  return inventory().units.find((u) => u.engine === "claude")!;
}
function plan(id = "plan") {
  return service.plan({ operationId: id, unitIds: [unit().unitId] });
}
function accept(op: NativeImportOperation) {
  return service.commit(op.plan.operationId, {
    approved: true,
    approvedItemKeys: op.plan.items
      .filter((i) => !["suppressed", "conflict"].includes(i.disposition))
      .map((i) => i.itemKey),
  });
}
async function refine() {
  const job = service.refinement.create({ unitIds: [unit().unitId], model });
  return service.refinement.wait(job.jobId);
}
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "memosync-native-v2-test-")));
  home = join(dir, "home");
  project = join(dir, "Project");
  mkdirSync(home);
  mkdirSync(project);
  roots = [
    {
      id: "personal",
      label: "Personal",
      path: home,
      owner: { scope: "personal" },
    },
    {
      id: "project:p",
      label: "Project",
      path: project,
      owner: { scope: "project", projectId: "p" },
    },
  ];
  topic = join(
    home,
    ".claude",
    "projects",
    project.replace(/[^a-zA-Z0-9]/g, "-"),
    "memory",
    "topic.md",
  );
  put(topic, "Keep the parser in /Src/Parser.ts.\n");
  memory = new MemoryService({
    dbPath: join(dir, "memory.sqlite"),
    dataDir: join(dir, "managed"),
  });
  open();
});
afterEach(async () => {
  await service.close();
  await new Promise((r) => setTimeout(r, 5));
  memory.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("format inventory and incremental manifest", () => {
  it("includes orphan topics, both YAML layouts, unknown metadata, conflicts, and malformed YAML", () => {
    put(
      topic,
      "---\nname: Parser\ntype: project\nmetadata:\n  type: feedback\n  originSessionId: invented\n  modified: 2026-01-01\nunknown: retained\n---\nKeep exact case.",
    );
    put(
      join(dirname(topic), "nested", "other.md"),
      "---\nname: Other\nmetadata:\n  type: user\n---\nSecond topic.",
    );
    put(
      join(dirname(topic), "bad.md"),
      "---\nname: [broken\n---\nLegacy body.",
    );
    const found = inventory();
    expect(found.units).toHaveLength(3);
    expect(
      found.units.find((u) => u.title === "Parser")!.metadata.unknown,
    ).toBe("retained");
    expect(found.anomalies.map((a) => a.code)).toContain(
      "frontmatter-conflict:type",
    );
    expect(found.anomalies.map((a) => a.code)).toContain(
      "malformed-frontmatter",
    );
    expect(found.units.find((u) => u.title === "Other")!.metadata.type).toBe(
      "user",
    );
    expect(found.units.every((u) => u.owner.projectId === "p")).toBe(true);
  });
  it("parses Codex task/shared sections outside fences and retains support edges and several projects", () => {
    put(
      join(home, ".codex", "memories", "MEMORY.md"),
      `# Task Group: Build\nscope: testing\napplies_to: cwd=${project}; reuse_rule=keep context\n\n## Task 1: Parse\n### rollout_summary_files\n- rollout_summaries/a.md (cwd=/unresolved/checkout, thread_id=11111111-1111-1111-1111-111111111111)\n### keywords\n- parser, cases\n\n## Reusable knowledge\n- Preserve case [Task 1]\n\n\`\`\`md\n# Task Group: fake\n\`\`\`\n`,
    );
    const found = inventory(),
      units = found.units.filter((u) => u.engine === "codex");
    expect(units).toHaveLength(2);
    expect(units[1]!.taskRefs).toEqual(["1"]);
    expect(units[0]!.scopes.map((s) => s.path)).toEqual(
      expect.arrayContaining([project, "/unresolved/checkout"]),
    );
    expect(units[0]!.owner.scope).toBe("personal");
    expect(units[0]!.evidenceThreadIds).toEqual([
      "11111111-1111-1111-1111-111111111111",
    ]);
  });
  it("keeps v1 evidence and v2 units separate and uses full thread identity across renames", () => {
    const rollout = `thread_id: 11111111-1111-1111-1111-111111111111\nupdated_at: 2026-01-01T00:00:00Z\nrollout_path: /synthetic/session.jsonl\ncwd: ${project}\n\n# Summary\nKeep the build command.\n`;
    put(
      join(home, ".codex", "memories", "rollout_summaries", "one.md"),
      rollout,
    );
    const path = join(
      home,
      ".codex",
      "memories_v2",
      "rollout_summaries",
      "one.md",
    );
    put(path, rollout);
    put(
      join(home, ".codex", "memories_v2", "memory_summary.md"),
      "v1\n# Navigation",
    );
    const first = inventory();
    expect(first.units.filter((u) => u.engine === "codex")).toHaveLength(1);
    const v2 = first.units.find((u) => u.namespace === "v2")!;
    expect(v2.selectedByDefault).toBe(false);
    expect(first.namespaces.find((n) => n.namespace === "v1")!.active).toBe(
      true,
    );
    renameSync(path, join(dirname(path), "renamed.md"));
    expect(inventory().units.find((u) => u.namespace === "v2")!.unitId).toBe(
      v2.unitId,
    );
  });
  it("accepts raw entries without delimited preambles and never creates raw units", () => {
    const raw =
      "## Thread `11111111-1111-1111-1111-111111111111`\nupdated_at: 2026-01-01\ncwd: /synthetic\nrollout_path: /synthetic/session\nrollout_summary_file: one.md\nLegacy key: value\n## Arbitrary heading\nbody\n---\n";
    expect(parseRawEntries(raw)[0]!.body).toContain("Legacy key");
    put(join(home, ".codex", "memories", "raw_memories.md"), raw);
    expect(inventory().units).toHaveLength(1);
  });
  it("excludes pipeline machinery, keeps assets independent, and reports actual index edges", () => {
    const root = join(home, ".codex", "memories");
    for (const file of [
      ".git/a.md",
      ".codex-baseline/a.md",
      "extensions/instructions.md",
      "phase2_workspace_diff.md",
    ])
      put(join(root, file), "Excluded.");
    put(join(root, "skills", "a", "SKILL.md"), "# Skill");
    put(join(home, ".claude", "CLAUDE.md"), "# Rule");
    put(
      join(dirname(topic), "MEMORY.md"),
      "[Parser](topic.md)\n[Missing](missing.md)",
    );
    const found = inventory();
    expect(
      found.sources.some(
        (s) =>
          s.locator.endsWith("instructions.md") || s.locator.includes(".git/"),
      ),
    ).toBe(false);
    expect(found.units).toHaveLength(1);
    expect(
      found.sources.find((s) => s.locator === topic)!.indexedBy,
    ).toHaveLength(1);
    expect(found.anomalies.map((a) => a.code)).toContain(
      "missing-index-reference",
    );
  });
  it("does not reverse unknown Claude slugs or create projects", () => {
    put(
      join(home, ".claude", "projects", "opaque-key", "memory", "orphan.md"),
      "Unresolved.",
    );
    const found = inventory();
    expect(found.units.find((u) => u.unresolvedProject)!.projectLabel).toBe(
      "Unresolved project",
    );
    expect(roots).toHaveLength(2);
  });
  it("verifies session cwd through the installed encoder shape", () => {
    const path = "/invented/repo";
    put(
      join(
        home,
        ".claude",
        "projects",
        path.replace(/[^a-zA-Z0-9]/g, "-"),
        "meta.jsonl",
      ),
      JSON.stringify({ type: "user", cwd: path }) + "\n",
    );
    put(
      join(
        home,
        ".claude",
        "projects",
        path.replace(/[^a-zA-Z0-9]/g, "-"),
        "memory",
        "orphan.md",
      ),
      "Scoped.",
    );
    const found = inventory();
    expect(
      found.units.find((u) => u.scopes.some((s) => s.path === path))!.scopes[0]!
        .verifiedBy,
    ).toBe("session-encoder");
  });
  it("imports large files verbatim and enumerates thousands of files beyond previous limits", async () => {
    const large = "Meaningful long line " + "x".repeat(300000);
    put(topic, large);
    for (let i = 0; i < 2100; i++)
      put(
        join(dirname(topic), "nested", String(i), "topic.md"),
        `Generated synthetic topic ${i}.`,
      );
    const found = inventory();
    expect(found.units).toHaveLength(2101);
    expect(found.skippedEntries).toHaveLength(0);
    const selected = found.units.find(
      (u) =>
        u.sourceId === found.sources.find((s) => s.locator === topic)!.sourceId,
    )!;
    const op = service.plan({
      operationId: "large",
      unitIds: [selected.unitId],
    });
    expect(op.plan.items[0]!.content).toContain(large);
    expect((await accept(op)).accepted).toHaveLength(1);
  }, 30000);
  it("retains accepted state on zero-byte or truncated reads, confirms valid shrinks later", async () => {
    const first = unit();
    put(topic, "");
    const empty = inventory();
    expect(empty.units[0]!.contentHash).toBe(first.contentHash);
    expect(empty.anomalies[0]!.code).toBe("unstable-read-retained");
    put(topic, "Short.");
    expect(unit().contentHash).toBe(first.contentHash);
    await new Promise((r) => setTimeout(r, 1010));
    expect(unit().contentHash).not.toBe(first.contentHash);
  });
  it("reads a Codex path out of applies_to prose, keeping spaces inside the path", () => {
    put(
      join(home, ".codex", "memories", "MEMORY.md"),
      `# Task Group: Storage\nscope: synthetic\napplies_to: cwd=/tmp/My Work/app with host scope=this machine; reuse_rule=careful\n## Task 1: Audit\nKeep it.\n`,
    );
    const codex = inventory().units.find(
      (u) => u.engine === "codex" && u.namespace === "v1",
    );
    expect(codex?.scopes[0]?.path).toBe("/tmp/My Work/app");
  });
  it("measures change against the last import, not the last scan", async () => {
    expect(unit().change).toBe("new");
    expect(unit().change).toBe("new");
    await accept(plan());
    expect(unit().change).toBe("unchanged");
    expect(unit().change).toBe("unchanged");
    put(
      topic,
      `${readFileSync(topic, "utf8")}\nAn edit made after the import.\n`,
    );
    expect(unit().change).toBe("changed");
    expect(unit().change).toBe("changed");
  });
  it("reconciles same-scope renames and flags removals without deleting memories", async () => {
    const first = unit();
    await accept(plan());
    const path = join(dirname(topic), "renamed.md");
    renameSync(topic, path);
    let found = inventory();
    expect(found.units).toHaveLength(1);
    expect(found.units[0]!.unitId).toBe(first.unitId);
    rmSync(path);
    found = inventory();
    expect(found.counts.removed).toBe(1);
    expect(memory.store.list({ status: "active" })).toHaveLength(1);
  });
  it("refuses symlinks, hardlinks, binary text and revoked roots", () => {
    put(join(dir, "outside.md"), "Outside");
    symlinkSync(join(dir, "outside.md"), join(dirname(topic), "linked.md"));
    linkSync(join(dir, "outside.md"), join(dirname(topic), "hard.md"));
    put(join(dirname(topic), "binary.md"), "\0binary");
    const found = inventory();
    expect(found.skippedEntries.map((s) => s.reason).sort()).toEqual([
      "binary",
      "symlink",
      "unreadable",
    ]);
    const id = found.units[0]!.unitId;
    roots = [];
    expect(() => service.inventory.get(id)).toThrow("no longer allowed");
  });
  it("reads a home reached through a link above it, still refusing links inside", () => {
    // macOS keeps temp homes under /var -> /private/var; external-volume homes do the same.
    const linked = join(dir, "via");
    symlinkSync(dir, linked);
    home = join(linked, "home");
    roots = [{ id: "personal", label: "Personal", path: home, owner: { scope: "personal" } }];
    put(join(dir, "outside.md"), "Outside");
    symlinkSync(join(dir, "outside.md"), join(dirname(topic), "linked.md"));
    service.close();
    open();
    const found = inventory();
    expect(found.units.some((u) => u.engine === "claude")).toBe(true);
    expect(found.skippedEntries.map((s) => s.reason)).toEqual(["symlink"]);
    expect(found.skippedEntries[0]!.path).toEndWith("linked.md");
  });
});

describe("reviewed writes, lineage and rollback", () => {
  it("is durable and idempotent, preserves source bytes, and updates changed units rather than duplicating", async () => {
    const before = readFileSync(topic, "utf8"),
      first = plan("first"),
      receipt = await accept(first),
      id = receipt.accepted[0]!.memoryId;
    expect(await accept(first)).toEqual(receipt);
    expect(readFileSync(topic, "utf8")).toBe(before);
    service.close();
    open();
    expect(plan("same").plan.items[0]!.disposition).toBe("unchanged");
    put(topic, "Keep the parser in /Src/BetterParser.ts with exact casing.\n");
    const next = plan("next");
    expect(next.plan.items[0]!.disposition).toBe("changed");
    expect(next.plan.items[0]!.target!.memoryId).toBe(id);
    expect((await accept(next)).accepted[0]!.updated).toBe(true);
    expect(memory.store.list({ status: "active" })).toHaveLength(1);
    expect(service.rollback("next", true).restored).toEqual([id]);
    expect(memory.store.getById(id)!.content).toBe(
      first.plan.items[0]!.content,
    );
  });
  it("records last-imported hash and linked IDs, rejects stale plans after edits", async () => {
    const op = plan();
    const receipt = await accept(op);
    const current = service.inventory.get(op.plan.units[0]!.unitId).unit;
    expect(current.lastImportedHash).toBeDefined();
    expect(current.linkedMemoryIds).toEqual([receipt.accepted[0]!.memoryId]);
    const stale = plan("stale");
    put(topic, "A newer and longer source revision requiring another review.");
    await expect(accept(stale)).rejects.toThrow("changed");
  });
  it("protects independent edits, exact matches and rollback ownership", async () => {
    const a = plan("a"),
      receipt = await accept(a),
      id = receipt.accepted[0]!.memoryId;
    const b = plan("b");
    expect((await accept(b)).accepted[0]!.mappingOwned).toBe(false);
    expect(service.rollback("b", true).archived).toEqual([]);
    memory.store.update(id, { content: "Independent edit" }, { actor: "user" });
    expect(service.rollback("a", true).conflicts).toHaveLength(1);
    expect(plan("c").plan.items[0]!.disposition).toBe("conflict");
  });
  it("archives only untouched created memories and retains revoked suppression", async () => {
    const op = plan(),
      receipt = await accept(op);
    expect(service.rollback("plan", true).archived).toEqual([
      receipt.accepted[0]!.memoryId,
    ]);
    expect(service.rollback("plan", true).archived).toHaveLength(1);
    expect(plan("reimport").plan.items[0]!.disposition).toBe("suppressed");
  });
  it("honors scoped rejections and shared suppression, including transaction-time rechecks", async () => {
    const op = plan();
    await service.commit("plan", {
      approved: true,
      approvedItemKeys: [],
      rejectedItemKeys: [op.plan.items[0]!.itemKey],
    });
    expect(plan("rejected").plan.items[0]!.disposition).toBe("suppressed");
    put(join(dirname(topic), "fresh.md"), "A completely different source.");
    const fresh = inventory().units.find((u) =>
      service.inventory.get(u.unitId).source.locator.endsWith("fresh.md"),
    )!;
    const next = service.plan({ operationId: "next", unitIds: [fresh.unitId] });
    const old = memory.store.create(
      {
        content: next.plan.items[0]!.content,
        scope: "project",
        projectId: "p",
        status: "candidate",
        type: "fact",
      },
      { actor: "user" },
    );
    memory.store.discardCandidate(old.id);
    await expect(accept(next)).rejects.toThrow("suppression");
  });
  it("rolls back the whole SQLite transaction on a failed mapping write", async () => {
    const op = plan();
    memory.db.exec(
      "CREATE TRIGGER fail_native_link BEFORE INSERT ON native_v2_links BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
    );
    await expect(accept(op)).rejects.toThrow();
    expect(memory.store.list({ status: "active" })).toHaveLength(0);
    expect(service.getOperation("plan")!.receipt).toBeUndefined();
  });
  it("keeps ad-hoc corrections in local context and model reconciliation, excludes extension instructions", async () => {
    put(
      join(
        home,
        ".claude",
        "projects",
        project.replace(/[^a-zA-Z0-9]/g, "-"),
        "memory",
        "extensions",
        "ad_hoc",
        "notes",
        "correction.md",
      ),
      "The older parser path is obsolete.",
    );
    const op = plan();
    expect(op.plan.items[0]!.content).toContain("Later correction");
    expect(op.plan.units[0]!.correctionSourceIds).toHaveLength(1);
  });
  it("returns exact-match only within the complete owner", async () => {
    const op = plan();
    const content = op.plan.items[0]!.content;
    memory.store.create(
      { content, scope: "personal", status: "active", type: "fact" },
      { actor: "user" },
    );
    expect(plan("other-owner").plan.items[0]!.disposition).toBe("new");
    memory.store.create(
      {
        content,
        scope: "project",
        projectId: "p",
        status: "active",
        type: "fact",
      },
      { actor: "user" },
    );
    const exact = plan("exact");
    expect(exact.plan.items[0]!.disposition).toBe("exact-match");
    const receipt = await accept(exact);
    expect(receipt.accepted[0]!.created).toBe(false);
    expect(service.rollback("exact", true).archived).toHaveLength(0);
  });
});

describe("scope proposals and reviewed project homes", () => {
  async function missingHome(caller?: NativeModelCaller) {
    await service.close();
    roots = roots.filter((r) => r.owner.scope === "personal");
    put(
      join(dirname(dirname(topic)), "session.jsonl"),
      JSON.stringify({ type: "user", cwd: project }) + "\n",
    );
    const store = new EventStore(join(dir, "projects"));
    await store.initialize();
    const homes: NativeImportOptions["projectHomes"] = {
      open: async (path, label) => {
        const existing = store.listProjects().find((p) => p.localPath === path);
        const p = await store.openProject(path, label);
        return { projectId: p.id, created: !existing };
      },
      remove: (id) => store.removeProject(id),
    };
    open(caller, homes);
    return { store, homes };
  }
  it("creates a verified missing home only for approved project items and retains it on rollback", async () => {
    const { store } = await missingHome();
    put(join(dirname(topic), "second.md"), "Another project fact.");
    const found = inventory();
    expect(store.listProjects()).toHaveLength(0);
    const job = service.refinement.create({
      unitIds: found.units.map((u) => u.unitId),
      model,
    });
    const done = await service.refinement.wait(job.jobId);
    const op = service.getOperation(done.batches[0]!.operationId!)!;
    expect(store.listProjects()).toHaveLength(0);
    expect(
      op.plan.items.every(
        (i) =>
          i.owner.scope === "project" &&
          i.projectPath === project &&
          !i.owner.projectId,
      ),
    ).toBe(true);
    const chosen = op.plan.items[0]!;
    const receipt = await service.commit(op.plan.operationId, {
      approved: true,
      approvedItemKeys: [chosen.itemKey],
    });
    expect(store.listProjects()).toHaveLength(1);
    expect(receipt.createdProjects).toEqual([
      { projectId: store.listProjects()[0]!.id, projectPath: project },
    ]);
    expect(receipt.accepted).toHaveLength(1);
    expect(memory.store.list({ scope: "personal" })).toHaveLength(0);
    expect(memory.store.getById(receipt.accepted[0]!.memoryId)!.projectId).toBe(
      store.listProjects()[0]!.id,
    );
    expect(
      service.getOperation(op.plan.operationId)!.plan.items[0]!.owner.projectId,
    ).toBe(store.listProjects()[0]!.id);
    expect(service.rollback(op.plan.operationId, true).archived).toHaveLength(
      1,
    );
    expect(store.listProjects()).toHaveLength(1);
  });
  it("does not open a home for rejection, omitted items or a personal override", async () => {
    const { store } = await missingHome();
    const op = plan();
    await service.commit("plan", {
      approved: true,
      approvedItemKeys: [],
      rejectedItemKeys: [op.plan.items[0]!.itemKey],
    });
    expect(store.listProjects()).toHaveLength(0);
    expect(plan("again").plan.items[0]!.disposition).toBe("suppressed");
    const personal = plan("personal");
    const item = personal.plan.items[0]!;
    await service.commit("personal", {
      approved: true,
      approvedItemKeys: [item.itemKey],
      scopeOverrides: { [item.itemKey]: "personal" },
    });
    expect(store.listProjects()).toHaveLength(0);
    expect(
      memory.store.list({ scope: "personal", status: "active" }),
    ).toHaveLength(1);
  });
  it("removes only newly opened homes and rolls back all memories when a commit fails", async () => {
    const { store } = await missingHome();
    const op = plan();
    memory.db.exec(
      "CREATE TRIGGER fail_native_link BEFORE INSERT ON native_v2_links BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
    );
    await expect(accept(op)).rejects.toThrow();
    expect(store.listProjects()).toHaveLength(0);
    expect(memory.store.list()).toHaveLength(0);
    expect(service.getOperation("plan")!.receipt).toBeUndefined();
    const reopened = new EventStore(join(dir, "projects"));
    await reopened.initialize();
    expect(reopened.listProjects()).toHaveLength(0);
    await store.openProject(project);
    await expect(accept(op)).rejects.toThrow();
    expect(store.listProjects()).toHaveLength(1);
  });
  it("refuses a missing home without the injected capability instead of writing personal memory", async () => {
    await missingHome();
    await service.close();
    open();
    const op = plan();
    expect(op.plan.items[0]!.owner.scope).toBe("project");
    await expect(accept(op)).rejects.toThrow("creation is unavailable");
    expect(memory.store.list()).toHaveLength(0);
  });
  it("corrects the personal fallback in a legacy saved plan at commit", async () => {
    const { store } = await missingHome();
    const op = plan();
    op.plan.items[0]!.owner = { scope: "personal" };
    delete op.plan.items[0]!.projectPath;
    delete op.plan.items[0]!.projectLabel;
    memory.db
      .query("UPDATE native_v2_operations SET plan=? WHERE operation_id=?")
      .run(JSON.stringify(op.plan), "plan");
    const receipt = await accept(op);
    expect(store.listProjects()).toHaveLength(1);
    expect(memory.store.getById(receipt.accepted[0]!.memoryId)!.scope).toBe(
      "project",
    );
    expect(memory.store.list({ scope: "personal" })).toHaveLength(0);
  });
  it("does not move an independently owned exact match when its proposal changes scope", async () => {
    const op = plan("draft");
    const independent = memory.store.create(
      {
        content: op.plan.items[0]!.content,
        scope: "project",
        projectId: "p",
        status: "active",
        type: "fact",
      },
      { actor: "user" },
    );
    const exact = plan("exact-move"),
      key = exact.plan.items[0]!.itemKey;
    expect(exact.plan.items[0]!.disposition).toBe("exact-match");
    const receipt = await service.commit("exact-move", {
      approved: true,
      approvedItemKeys: [key],
      scopeOverrides: { [key]: "personal" },
    });
    expect(receipt.accepted[0]!.created).toBe(true);
    expect(receipt.accepted[0]!.memoryId).not.toBe(independent.id);
    expect(memory.store.getById(independent.id)!.projectId).toBe("p");
    expect(service.rollback("exact-move", true).archived).toEqual([
      receipt.accepted[0]!.memoryId,
    ]);
    expect(memory.store.getById(independent.id)!.status).toBe("active");
  });
  it("compensates earlier homes when a later home cannot be opened", async () => {
    const { store, homes } = await missingHome();
    const otherPath = join(dir, "other-project");
    const otherTopic = join(
      home,
      ".claude",
      "projects",
      otherPath.replace(/[^a-zA-Z0-9]/g, "-"),
      "memory",
      "other.md",
    );
    put(otherTopic, "A fact for the second project.");
    put(
      join(dirname(dirname(otherTopic)), "session.jsonl"),
      JSON.stringify({ type: "user", cwd: otherPath }) + "\n",
    );
    await service.close();
    let calls = 0;
    open(fake, {
      open: async (path, label) => {
        if (++calls === 2) throw new Error("Synthetic project failure");
        return homes!.open(path, label);
      },
      remove: homes!.remove,
    });
    const op = service.plan({
      operationId: "two-homes",
      unitIds: inventory().units.map((u) => u.unitId),
    });
    await expect(accept(op)).rejects.toThrow("Synthetic project failure");
    expect(calls).toBe(2);
    expect(store.listProjects()).toHaveLength(0);
    expect(memory.store.list()).toHaveLength(0);
    expect(service.getOperation("two-homes")!.receipt).toBeUndefined();
  });
  it("rechecks source state after opening a home and removes it if the source changed", async () => {
    const { store, homes } = await missingHome();
    await service.close();
    open(fake, {
      open: async (path, label) => {
        const opened = await homes!.open(path, label);
        put(topic, "New source after the asynchronous project open.");
        return opened;
      },
      remove: homes!.remove,
    });
    const op = plan();
    await expect(accept(op)).rejects.toThrow("changed");
    expect(store.listProjects()).toHaveLength(0);
    expect(memory.store.list()).toHaveLength(0);
  });
  it("supports both override directions and idempotency includes the final scope", async () => {
    const op = plan(),
      key = op.plan.items[0]!.itemKey;
    const personal = await service.commit("plan", {
      approved: true,
      approvedItemKeys: [key],
      scopeOverrides: { [key]: "personal" },
    });
    expect(memory.store.getById(personal.accepted[0]!.memoryId)!.scope).toBe(
      "personal",
    );
    await expect(
      service.commit("plan", { approved: true, approvedItemKeys: [key] }),
    ).rejects.toThrow("Different decisions");
    put(join(dirname(topic), "pref.md"), "Prefer concise explanations.");
    await service.close();
    open(async (r) => ({
      value: {
        units: data(r.user).map((u) => ({
          unitId: u.unitId,
          items: [
            { scope: "personal", content: u.text.trim(), quote: u.text.trim() },
          ],
        })),
      },
    }));
    const u = inventory().units.find((u) =>
      service.inventory.get(u.unitId).source.locator.endsWith("pref.md"),
    )!;
    const job = await service.refinement.wait(
      service.refinement.create({ unitIds: [u.unitId], model }).jobId,
    );
    const refined = service.getOperation(job.batches[0]!.operationId!)!;
    const item = refined.plan.items[0]!;
    expect(item.owner.scope).toBe("personal");
    const receipt = await service.commit(refined.plan.operationId, {
      approved: true,
      approvedItemKeys: [item.itemKey],
      scopeOverrides: { [item.itemKey]: "project" },
    });
    expect(memory.store.getById(receipt.accepted[0]!.memoryId)!.projectId).toBe(
      "p",
    );
    expect(
      service.rollback(refined.plan.operationId, true).archived,
    ).toHaveLength(1);
    expect(
      service.getOperation(refined.plan.operationId)!.plan.items[0]!.owner
        .scope,
    ).toBe("project");
  });
  it("preserves importer lineage when moving an accepted memory and restores its owner on rollback", async () => {
    const initial = await accept(plan("first"));
    const id = initial.accepted[0]!.memoryId;
    const next = plan("move"),
      key = next.plan.items[0]!.itemKey;
    const moved = await service.commit("move", {
      approved: true,
      approvedItemKeys: [key],
      scopeOverrides: { [key]: "personal" },
    });
    expect(moved.accepted[0]!.memoryId).toBe(id);
    expect(moved.accepted[0]!.updated).toBe(true);
    expect(memory.store.getById(id)!.scope).toBe("personal");
    expect(service.rollback("move", true).restored).toEqual([id]);
    expect(memory.store.getById(id)!.projectId).toBe("p");
    expect(plan("after").plan.items[0]!.disposition).toBe("unchanged");
  });
  it("allows a reviewed model scope change on existing lineage and lets review correct it", async () => {
    const first = await accept(plan("first"));
    const id = first.accepted[0]!.memoryId;
    await service.close();
    open(async (r) => ({
      value: {
        units: data(r.user).map((u) => ({
          unitId: u.unitId,
          items: [
            { scope: "personal", content: u.text.trim(), quote: u.text.trim() },
          ],
        })),
      },
    }));
    const job = await refine();
    const op = service.getOperation(job.batches[0]!.operationId!)!;
    expect(op.plan.items[0]!.owner.scope).toBe("personal");
    expect(op.plan.items[0]!.target?.owner).toEqual({
      scope: "project",
      projectId: "p",
    });
    expect(op.plan.items[0]!.disposition).toBe("changed");
    const moved = await accept(op);
    expect(moved.accepted[0]!.memoryId).toBe(id);
    expect(memory.store.getById(id)!.scope).toBe("personal");
    const local = plan("back"),
      key = local.plan.items[0]!.itemKey;
    expect(local.plan.items[0]!.owner.scope).toBe("project");
    expect(local.plan.items[0]!.disposition).toBe("changed");
    await service.commit("back", {
      approved: true,
      approvedItemKeys: [key],
      scopeOverrides: { [key]: "personal" },
    });
    expect(memory.store.getById(id)!.scope).toBe("personal");
    expect(memory.store.list({ status: "active" })).toHaveLength(1);
    expect(service.rollback("back", true).restored).toEqual([id]);
    expect(memory.store.getById(id)!.scope).toBe("personal");
  });
  it("checks suppression under the final owner, including scoped rejection and revocation", async () => {
    const op = plan(),
      key = op.plan.items[0]!.itemKey;
    memory.store.archive(
      memory.store.create(
        {
          content: op.plan.items[0]!.content,
          scope: "personal",
          status: "active",
          type: "fact",
        },
        { actor: "user" },
      ).id,
      { actor: "user" },
    );
    await expect(
      service.commit("plan", {
        approved: true,
        approvedItemKeys: [key],
        scopeOverrides: { [key]: "personal" },
      }),
    ).rejects.toThrow("suppression");
    expect(
      memory.store.list({ scope: "project", status: "active" }),
    ).toHaveLength(0);
  });
  it("defaults invalid model scope to project and keeps unverified units personal and unattributed", async () => {
    put(
      join(home, ".claude", "projects", "unknown", "memory", "unattributed.md"),
      "A small preference.",
    );
    await service.close();
    open(async (r) => ({
      value: {
        units: data(r.user).map((u) => ({
          unitId: u.unitId,
          items: [
            { scope: "invalid", content: u.text.trim(), quote: u.text.trim() },
          ],
        })),
      },
    }));
    const found = inventory();
    const job = await service.refinement.wait(
      service.refinement.create({
        unitIds: found.units.map((u) => u.unitId),
        model,
      }).jobId,
    );
    const op = service.getOperation(job.batches[0]!.operationId!)!;
    expect(op.plan.items.find((i) => i.projectPath)?.owner.scope).toBe(
      "project",
    );
    const unknown = op.plan.items.find((i) => !i.projectPath)!;
    expect(unknown.owner.scope).toBe("personal");
    expect(unknown.flags).toContain("unattributed");
    await expect(
      service.commit(op.plan.operationId, {
        approved: true,
        approvedItemKeys: [unknown.itemKey],
        scopeOverrides: { [unknown.itemKey]: "project" },
      }),
    ).rejects.toThrow("verified project home");
    await expect(
      service.commit(op.plan.operationId, {
        approved: true,
        approvedItemKeys: [],
        scopeOverrides: { [unknown.itemKey]: "invalid" } as never,
      }),
    ).rejects.toThrow("Scope overrides");
    await expect(
      service.commit(op.plan.operationId, {
        approved: true,
        approvedItemKeys: [],
        scopeOverrides: { unknown: "personal" },
      }),
    ).rejects.toThrow("Unknown scope");
  });
  it("uses the first Codex scope as home and retains the others as metadata", async () => {
    const { store } = await missingHome();
    put(
      join(home, ".codex", "memories", "MEMORY.md"),
      `# Task Group: Multi\nscope: synthetic\napplies_to: cwd=${project}; reuse_rule=keep context\n## Task 1: Build\nKeep paths.\n### rollout_summary_files\n- rollout_summaries/a.md (cwd=/synthetic/other, thread_id=11111111-1111-1111-1111-111111111111)\n`,
    );
    const u = inventory().units.find((u) => u.engine === "codex")!;
    const op = service.plan({ operationId: "multi", unitIds: [u.unitId] });
    expect(op.plan.items[0]!.projectPath).toBe(project);
    expect(op.plan.units[0]!.scopes.map((s) => s.path)).toEqual([
      project,
      "/synthetic/other",
    ]);
    await accept(op);
    expect(store.listProjects().map((p) => p.localPath)).toEqual([project]);
    expect(memory.store.list({ scope: "personal" })).toHaveLength(0);
  });
  it("keeps atomic claims from every unit in one merged batch and retains short preferences", async () => {
    put(topic, "Prefer Chinese.\nUse /Src/Parser.ts.\n");
    put(
      join(dirname(topic), "second.md"),
      "Never upload raw data.\nKeep command bun test.\n",
    );
    let calls = 0;
    await service.close();
    open(async (r) => {
      calls++;
      expect(r.system).toContain(
        "Each claim is exactly one standalone fact, preference or lesson",
      );
      expect(r.system).toContain(
        "Keep claims in the language of the source text",
      );
      expect(r.system).toContain(
        "Never drop a preference, rule or lesson merely because it is short or small",
      );
      expect(NATIVE_REFINEMENT_RULES).toContain(
        '"scope":"personal or project"',
      );
      return {
        value: {
          units: data(r.user).map((u) => ({
            unitId: u.unitId,
            items: u.text
              .trim()
              .split("\n")
              .map((line) => ({
                scope: line.startsWith("Prefer") ? "personal" : "project",
                content: line,
                quote: line,
              })),
          })),
        },
      };
    });
    const selected = inventory().units;
    const job = await service.refinement.wait(
      service.refinement.create({
        unitIds: selected.map((u) => u.unitId),
        model,
      }).jobId,
    );
    expect(calls).toBe(1);
    expect(job.batches).toHaveLength(1);
    const op = service.getOperation(job.batches[0]!.operationId!)!;
    expect(op.plan.items).toHaveLength(4);
    for (const u of selected) {
      const items = op.plan.items.filter((i) => i.unitId === u.unitId);
      expect(items).toHaveLength(2);
      expect(
        items.every((i) =>
          service.inventory.get(u.unitId).text.includes(i.provenance.quote),
        ),
      ).toBe(true);
      expect(items.every((i) => i.content === i.provenance.quote)).toBe(true);
    }
  });
});

describe("durable refinement with no paid test calls", () => {
  it("quarantines credential blocks before the caller and drops invalid quotes, ignoring model identity", async () => {
    put(
      topic,
      "# Parser\nKeep exact path /Src/Parser.ts.\n\napi_key: synthetic_secret_value_123456789\n  continued secret\n\nContact user@example.test.",
    );
    service.close();
    open(async (r) => {
      expect(r.user).not.toContain("synthetic_secret");
      expect(r.user).not.toContain("continued secret");
      const u = data(r.user)[0]!;
      return {
        value: {
          units: [
            {
              unitId: u.unitId,
              items: [
                {
                  content: "Use the Parser.",
                  quote: "Keep exact path /Src/Parser.ts.",
                  owner: { scope: "personal" },
                  memoryId: "evil",
                },
                { content: "Unsupported", quote: "not in unit" },
              ],
            },
          ],
        },
      };
    });
    const job = await refine();
    expect(job.state).toBe("completed");
    expect(job.batches[0]!.droppedQuotes).toBe(1);
    const op = service.getOperation(job.batches[0]!.operationId!)!;
    expect(op.plan.items).toHaveLength(1);
    expect(op.plan.items[0]!.owner.projectId).toBe("p");
  });
  it("records provider usage, applies sample, retries only failed batches and survives restart", async () => {
    put(join(dirname(topic), "two.md"), "Second independent unit.");
    let calls = 0;
    service.close();
    open(async (r) => {
      // Fails the run's automatic retry too, leaving an explicit resume.
      if (++calls <= 2) throw new Error("private failure text");
      return fake(r);
    });
    const job = service.refinement.create({
      unitIds: inventory().units.map((u) => u.unitId),
      model,
      sample: 1,
    });
    let finished = await service.refinement.wait(job.jobId);
    expect(finished.state).toBe("failed");
    expect(JSON.stringify(finished)).not.toContain("private failure");
    service.close();
    open();
    await service.refinement.resume(job.jobId);
    finished = await service.refinement.wait(job.jobId);
    expect(finished.state).toBe("completed");
    expect(finished.batches[0]!.attempts).toBe(3);
    expect(finished.batches[0]!.usage!.inputTokens).toBe(7);
    expect(finished.input.unitIds).toHaveLength(1);
  });
  it("cancels inflight work and resumes explicitly without saving stale results", async () => {
    service.close();
    let started: () => void = () => {};
    const ready = new Promise<void>((r) => (started = r));
    open(async (r) => {
      started();
      await new Promise<void>((_resolve, reject) =>
        r.signal.addEventListener(
          "abort",
          () => reject(new Error("cancelled")),
          { once: true },
        ),
      );
      return fake(r);
    });
    const job = service.refinement.create({ unitIds: [unit().unitId], model });
    await ready;
    service.refinement.cancel(job.jobId);
    expect((await service.refinement.wait(job.jobId)).state).toBe("cancelled");
    service.close();
    open();
    await service.refinement.resume(job.jobId);
    expect((await service.refinement.wait(job.jobId)).state).toBe("completed");
  });
  it("automatically resumes interrupted jobs after construction", async () => {
    const job = service.refinement.create({ unitIds: [unit().unitId], model });
    await service.refinement.wait(job.jobId);
    const row = memory.db
      .query("SELECT payload FROM native_v2_jobs WHERE job_id=?")
      .get(job.jobId) as { payload: string };
    const saved = JSON.parse(row.payload);
    saved.job.state = "running";
    saved.job.batches[0].state = "running";
    saved.outputs = {};
    memory.db
      .query("UPDATE native_v2_jobs SET payload=? WHERE job_id=?")
      .run(JSON.stringify(saved), job.jobId);
    service.close();
    open();
    await new Promise((r) => setTimeout(r, 0));
    expect((await service.refinement.wait(job.jobId)).state).toBe("completed");
  });
  it("rejects source changes after a model await", async () => {
    service.close();
    open(async (r) => {
      put(topic, "Longer revised content while the model was running.");
      return fake(r);
    });
    expect((await refine()).state).toBe("failed");
    expect(service.listOperations().operations).toHaveLength(0);
  });
  it("batches a large unit without excluding any segment", async () => {
    const content = Array.from(
      { length: 800 },
      (_, i) => `Synthetic line ${i}: preserve this complete example.\n`,
    ).join("");
    put(topic, content);
    const job = await refine();
    expect(job.state).toBe("completed");
    expect(job.batches.length).toBeGreaterThan(1);
    const op = service.getOperation(job.batches[0]!.operationId!)!;
    const quotes = op.plan.items.map((i) => i.provenance.quote);
    expect(quotes.join("\n")).toBe(content.trim());
  });
  it("runs a few batches at once and keeps every batch's result and usage", async () => {
    put(
      topic,
      Array.from(
        { length: 6000 },
        (_, i) => `Synthetic line ${i}: preserve this complete example.\n`,
      ).join(""),
    );
    let live = 0,
      peak = 0;
    service.close();
    open(async (r) => {
      peak = Math.max(peak, ++live);
      await new Promise((done) => setTimeout(done, 20));
      live--;
      return fake(r);
    });
    const job = await refine();
    expect(job.state).toBe("completed");
    expect(job.batches.length).toBeGreaterThan(NATIVE_REFINE_CONCURRENCY);
    expect(peak).toBe(NATIVE_REFINE_CONCURRENCY);
    expect(
      job.batches.every(
        (b) => b.state === "completed" && b.usage?.inputTokens === 7,
      ),
    ).toBe(true);
  });
  it("caps the units in one call so no single batch sets the pace", async () => {
    for (let i = 1; i < 12; i++)
      put(join(dirname(topic), `topic-${i}.md`), `Synthetic fact ${i}.\n`);
    const ids = inventory()
      .units.filter((u) => u.engine === "claude")
      .map((u) => u.unitId);
    expect(ids).toHaveLength(12);
    const job = await service.refinement.wait(
      service.refinement.create({ unitIds: ids, model }).jobId,
    );
    expect(job.state).toBe("completed");
    expect(job.batches.map((b) => b.unitIds.length)).toEqual([
      NATIVE_BATCH_UNITS,
      12 - NATIVE_BATCH_UNITS,
    ]);
  });
  it("cancels every in-flight batch together", async () => {
    put(
      topic,
      Array.from(
        { length: 3000 },
        (_, i) => `Synthetic line ${i}: preserve this complete example.\n`,
      ).join(""),
    );
    let started!: () => void;
    const begun = new Promise<void>((done) => (started = done));
    service.close();
    open(
      (r) =>
        new Promise((_, fail) => {
          started();
          r.signal.addEventListener("abort", () => fail(new Error("aborted")));
        }),
    );
    const job = service.refinement.create({ unitIds: [unit().unitId], model });
    await begun;
    service.refinement.cancel(job.jobId);
    const done = await service.refinement.wait(job.jobId);
    expect(done.state).toBe("cancelled");
    expect(done.batches.some((b) => b.state === "running")).toBe(false);
  });
  it("supplies one requested evidence follow-up and allows quotes only from the original unit", async () => {
    const uuid = "11111111-1111-1111-1111-111111111111";
    put(
      join(home, ".codex", "memories", "MEMORY.md"),
      `# Task Group: Evidence\nscope: synthetic\n## Task 1: Sample\n- Read source (thread_id=${uuid})\n`,
    );
    put(
      join(home, ".codex", "memories", "rollout_summaries", "one.md"),
      `thread_id: ${uuid}\nupdated_at: 2026-01-01\nrollout_path: /invented/session\ncwd: ${project}\n\nEvidence body only.\n`,
    );
    let calls = 0;
    service.close();
    open(async (r) => {
      calls++;
      const u = data(r.user)[0]!;
      if (calls === 1)
        return {
          value: {
            units: [{ unitId: u.unitId, items: [], needEvidence: [uuid] }],
            api_key: "synthetic_model_secret_value",
          },
        };
      expect(r.user).toContain("ONE EVIDENCE FOLLOW-UP");
      expect(r.user).not.toContain("synthetic_model_secret_value");
      return {
        value: {
          units: [
            {
              unitId: u.unitId,
              items: [
                { content: "bad", quote: "Evidence body only." },
                {
                  content: "Keep source",
                  quote: "- Read source (thread_id=" + uuid + ")",
                },
              ],
              needEvidence: [uuid],
            },
          ],
        },
      };
    });
    const selected = inventory().units.find((u) => u.engine === "codex")!;
    const job = await service.refinement.wait(
      service.refinement.create({ unitIds: [selected.unitId], model }).jobId,
    );
    expect(calls).toBe(2);
    expect(job.batches[0]!.droppedQuotes).toBe(1);
  });
  it("builds navigation-only overviews and caches by navigation, model and instruction", async () => {
    put(join(dirname(topic), "MEMORY.md"), "# Index\n[Parser](topic.md)");
    let calls = 0;
    service.close();
    open(async (r) => {
      calls++;
      expect(r.user).not.toContain("Keep the parser");
      const current = service.inventory.units()[0]!;
      return {
        value: {
          topics: [
            {
              id: "ignored",
              title: "Parser",
              summary: "Parser context",
              unitIds: [current.unitId, "invented"],
              samples: ["Parser"],
            },
          ],
        },
      };
    });
    inventory();
    const first = await service.refinement.overview(
      { model },
      new AbortController().signal,
    );
    const cached = await service.refinement.overview(
      { model },
      new AbortController().signal,
    );
    expect(cached.cached).toBe(true);
    expect(cached.navigationHash).toBe(first.navigationHash);
    const oldCalls = calls;
    await service.refinement.overview(
      { model, instruction: "Keep parser context" },
      new AbortController().signal,
    );
    expect(calls).toBeGreaterThan(oldCalls);
  });
});

describe("native runtime isolation and API", () => {
  it("enforces Claude no-session, no-tools, no memory and selected connection env with a fake runtime", async () => {
    let options: any;
    const runtime: EngineRuntime = {
      engine: "claude",
      model: "synthetic-gateway-model",
      connectionId: "loopback",
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:48080",
        ANTHROPIC_API_KEY: "synthetic-loopback-only",
      },
      args: [],
      isolated: true,
      executable: { state: "ready" },
    };
    const call = createNativeModelCaller({
      resolve: async () => runtime,
      claudeQuery: (({ options: o }: any) => {
        options = o;
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "assistant",
              message: { content: [{ type: "text", text: '{"units":[]}' }] },
            };
            yield {
              type: "result",
              subtype: "success",
              is_error: false,
              usage: { input_tokens: 1, output_tokens: 1 },
            };
          },
          close() {},
        };
      }) as any,
    });
    await call({
      model: {
        provider: "claude",
        model: runtime.model,
        connectionId: "loopback",
      },
      system: "fixed rules",
      user: "synthetic",
      signal: new AbortController().signal,
    });
    expect(options.persistSession).toBe(false);
    expect(options.tools).toEqual([]);
    expect(options.settingSources).toEqual([]);
    expect(options.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    expect(options.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:48080");
    expect(options.strictMcpConfig).toBe(true);
    expect(options.settings.disableAllHooks).toBe(true);
  });
  it("disables Codex memory generation, memory reads and native tools", () => {
    expect(NATIVE_CODEX_CONFIG["memories.generate_memories"]).toBe(false);
    expect(NATIVE_CODEX_CONFIG["memories.use_memories"]).toBe(false);
    expect(NATIVE_CODEX_CONFIG["features.shell_tool"]).toBe(false);
    expect(NATIVE_CODEX_CONFIG["web_search"]).toBe("disabled");
  });
  it("screens whole multiline/fenced/heading/PEM credential blocks and flags personal info", () => {
    for (const sensitive of [
      "api_key:\n  synthetic_value\n\n  continued",
      "```env\npassword=synthetic\n```",
      "-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----",
      "# api_key: synthetic\npassword: synthetic",
    ]) {
      const screened = screenedNativeText(sensitive);
      expect(screened.trim()).toBe("");
      expect(
        nativeMarkdownBlocks(sensitive).some((b) =>
          nativeTextSensitive(b.quote),
        ),
      ).toBe(true);
    }
    put(topic, "Contact user@example.test or +1 234 567 8901.");
    expect(plan().plan.items[0]!.flags).toContain("personal-info");
  });
  it("exposes inventory, source, plan/commit, durable jobs/history and rollback; removes old per-file routes", async () => {
    const req = async (method: string, path: string, value?: unknown) => {
      const request = new Request("http://localhost/api/memories/" + path, {
        method,
        ...(value === undefined
          ? {}
          : {
              body: JSON.stringify(value),
              headers: { "content-type": "application/json" },
            }),
      });
      return (await handleNativeMemoryRequest(
        request,
        new URL(request.url),
        service,
      ))!;
    };
    const found = await (await req("POST", "inventory", {})).json();
    const id = found.data.units[0].unitId;
    expect((await req("GET", `units/${id}/source`)).status).toBe(200);
    expect(
      (await req("POST", "imports/plan", { operationId: "api", unitIds: [id] }))
        .status,
    ).toBe(200);
    const op = service.getOperation("api")!;
    expect(
      (
        await req("POST", "imports/api/commit", {
          approved: true,
          approvedItemKeys: op.plan.items.map((i) => i.itemKey),
        })
      ).status,
    ).toBe(200);
    expect((await req("GET", "imports")).status).toBe(200);
    expect(
      (await req("POST", "imports/api/rollback", { approved: true })).status,
    ).toBe(200);
    expect((await req("POST", "imports/dry-run", {})).status).toBe(405);
    expect(
      (await req("POST", "inventory", { rootIds: ["/arbitrary/path"] })).status,
    ).toBe(400);
  });
});

describe("inventory and job race regressions", () => {
  it("retains unit identity across a unique handbook heading rename and detects preamble changes", () => {
    const path = join(home, ".codex", "memories", "MEMORY.md");
    put(
      path,
      `# Task Group: Parser\nscope: synthetic\napplies_to: cwd=${project}; reuse_rule=careful\n## Task 1: Old\nKeep parser case.\n`,
    );
    const first = inventory().units.find((u) => u.engine === "codex")!;
    put(
      path,
      `# Task Group: Parser\nscope: synthetic and current\napplies_to: cwd=${project}; reuse_rule=careful\n## Task 1: Renamed\nKeep parser case.\n`,
    );
    const next = inventory().units.filter((u) => u.engine === "codex");
    expect(next).toHaveLength(1);
    expect(next[0]!.unitId).toBe(first.unitId);
  });
  it("invalidates plans when later correction contents change", async () => {
    const correction = join(
      dirname(topic),
      "extensions",
      "ad_hoc",
      "notes",
      "correction.md",
    );
    put(correction, "Reconcile the prior parser convention.");
    const op = plan();
    put(
      correction,
      "Reconcile the prior parser convention with this additional correction.",
    );
    await expect(accept(op)).rejects.toThrow("changed");
  });
  it("preserves cancellation if an uncooperative caller returns after abort", async () => {
    await service.close();
    let begin: () => void = () => {},
      release: () => void = () => {};
    const ready = new Promise<void>((r) => (begin = r)),
      gate = new Promise<void>((r) => (release = r));
    open(async (request) => {
      begin();
      await gate;
      return fake(request);
    });
    const job = service.refinement.create({ unitIds: [unit().unitId], model });
    await ready;
    service.refinement.cancel(job.jobId);
    release();
    expect((await service.refinement.wait(job.jobId)).state).toBe("cancelled");
    expect(service.listOperations().operations).toHaveLength(0);
  });
  it("persists pending work on graceful shutdown before closing its database", async () => {
    await service.close();
    let begin: () => void = () => {};
    const ready = new Promise<void>((r) => (begin = r));
    open(async (request) => {
      begin();
      await new Promise<void>((_resolve, reject) =>
        request.signal.addEventListener(
          "abort",
          () => reject(new Error("synthetic shutdown")),
          { once: true },
        ),
      );
      return fake(request);
    });
    const job = service.refinement.create({ unitIds: [unit().unitId], model });
    await ready;
    await service.close();
    expect(service.refinement.read(job.jobId).state).toBe("queued");
    open();
    await new Promise((r) => setTimeout(r, 0));
    expect((await service.refinement.wait(job.jobId)).state).toBe("completed");
  });
  it("reports omitted model unit results as retryable failure", async () => {
    await service.close();
    open(async () => ({ value: { units: [] } }));
    const job = await refine();
    expect(job.state).toBe("failed");
    expect(job.batches[0]!.error).toBe("INVALID_MODEL_RESULT");
    expect(job.batches[0]!.attempts).toBe(2);
  });
  it("retries a malformed reply once within the run", async () => {
    await service.close();
    let calls = 0;
    open(async (r) => (++calls === 1 ? { value: { units: [] } } : fake(r)));
    const job = await refine();
    expect(job.state).toBe("completed");
    expect(calls).toBe(2);
    expect(job.batches[0]).toMatchObject({ state: "completed", attempts: 2 });
  });
  it("uses explicitly configured native homes without scanning unrelated defaults", () => {
    const claude = join(dir, "custom-claude"),
      codex = join(dir, "custom-codex");
    put(
      join(claude, "projects", "opaque", "memory", "topic.md"),
      "Custom topic.",
    );
    put(
      join(codex, "memories_v2", "rollout_summaries", "one.md"),
      `thread_id: 11111111-1111-1111-1111-111111111111\nupdated_at: 2026-01-01\nrollout_path: /invented/session\ncwd: ${project}\n\nCustom rollout.`,
    );
    const discovery = new NativeMemoryDiscovery(home, () => roots, {
      claudeConfigDir: claude,
      codexHome: codex,
    });
    const found = discovery.discover(["personal"]);
    expect(found.sources.some((s) => s.locator === topic)).toBe(false);
    expect(found.sources.filter((s) => s.role === "units")).toHaveLength(2);
  });
});

it("cannot bypass earlier atomic suppression by bundling it into a verbatim unit", () => {
  const dismissed = memory.store.create(
    {
      content: "Avoid the deprecated parser.",
      scope: "project",
      projectId: "p",
      type: "fact",
      status: "candidate",
    },
    { actor: "user" },
  );
  memory.store.discardCandidate(dismissed.id);
  put(
    topic,
    "- Avoid the deprecated parser.\n- Keep a separate useful convention.\n",
  );
  expect(plan().plan.items[0]!.disposition).toBe("suppressed");
});

it("parses a delimited raw preamble and preserves historical body text without importing it", () => {
  const prefix =
    "## Thread `11111111-1111-1111-1111-111111111111`\nupdated_at: 2026-01-01\ncwd: /synthetic\nrollout_path: /synthetic/session\nrollout_summary_file: one.md\n";
  const entry = parseRawEntries(
    prefix +
      "---\nsummary: synthetic evidence\n---\n## Body\nHistorical evidence.",
  )[0]!;
  expect(entry.bodyMetadata).toEqual({ summary: "synthetic evidence" });
  expect(entry.body).toContain("Historical evidence.");
});

it("accepts legacy raw preamble prose with unquoted colons without losing values", () => {
  const raw =
    "## Thread `11111111-1111-1111-1111-111111111111`\nupdated_at: 2026-01-01\ncwd: /synthetic\nrollout_path: /synthetic/session\nrollout_summary_file: one.md\n---\nsummary: Preserve this: literal prose\n---\nHistorical body.";
  const entry = parseRawEntries(raw)[0]!;
  expect(entry.bodyPreambleFormat).toBe("legacy-key-value");
  expect(entry.bodyMetadata).toEqual({
    summary: "Preserve this: literal prose",
  });
  expect(entry.anomaly).toBeUndefined();
});

describe("removed native claims", () => {
  async function reject(id = "removed", scope?: "personal" | "project") {
    const op = plan(id);
    await service.commit(id, {
      approved: true,
      approvedItemKeys: [],
      rejectedItemKeys: op.plan.items.map((i) => i.itemKey),
      ...(scope
        ? {
            scopeOverrides: Object.fromEntries(
              op.plan.items.map((i) => [i.itemKey, scope]),
            ),
          }
        : {}),
    });
    return service.getOperation(id)!;
  }
  function removedIds() {
    return service.listRemoved().items.map((i) => i.removalId);
  }
  async function request(method: string, path: string, value?: unknown) {
    const req = new Request(
      "http://localhost/api/memories/imports/removed" + path,
      {
        method,
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      },
    );
    return (await handleNativeMemoryRequest(req, new URL(req.url), service))!;
  }
  it("lists stored rejected and rolled-back claims with metadata, never live source bodies", async () => {
    const op = await reject();
    const original = op.plan.items[0]!;
    const first = service.listRemoved().items[0]!;
    expect(first).toMatchObject({
      content: original.content,
      context: original.context,
      owner: original.owner,
      projectPath: project,
      projectLabel: original.projectLabel,
      engine: "claude",
      unitId: original.unitId,
      unitTitle: op.plan.units[0]!.title,
      operationId: op.plan.operationId,
      sourceExists: true,
    });
    expect(new Date(first.removedAt).toISOString()).toBe(first.removedAt);
    put(topic, "Changed synthetic source must not replace the saved claim.");
    expect(service.listRemoved().items[0]!.content).toBe(original.content);
    rmSync(topic);
    service.inventory.read();
    expect(service.listRemoved().items[0]).toEqual({
      ...first,
      sourceExists: false,
    });
    put(join(dirname(topic), "other.md"), "Independent synthetic fact.");
    const u = inventory().units.find((u) => u.change !== "removed")!;
    const accepted = service.plan({
      operationId: "revoked",
      unitIds: [u.unitId],
    });
    await accept(accepted);
    service.rollback("revoked", true);
    // Undoing an import sets its claims aside where they can be found again.
    const removed = service.listRemoved().items;
    expect(removed.map((i) => i.operationId)).toEqual(["revoked", op.plan.operationId]);
    expect(removed[0]!.content).toBe(accepted.plan.items[0]!.content);
    expect(inventory().units.find((x) => x.unitId === u.unitId)!.change).toBe("unchanged");
    await service.close();
    open();
    expect(removedIds()).toEqual(removed.map((i) => i.removalId));
  });
  it("uses commit time and then creation time for legacy timestamps", async () => {
    const op = await reject();
    memory.db
      .query("UPDATE native_memory_tombstones SET removed_at=NULL")
      .run();
    memory.db
      .query("UPDATE native_v2_operations SET committed_at=?")
      .run("2025-03-04T05:06:07.000Z");
    expect(service.listRemoved().items[0]!.removedAt).toBe(
      "2025-03-04T05:06:07.000Z",
    );
    memory.db.query("UPDATE native_v2_operations SET committed_at=NULL").run();
    expect(service.listRemoved().items[0]!.removedAt).toBe(op.plan.createdAt);
  });
  it("migrates the actual four-column legacy tombstone schema without losing removals", async () => {
    await reject();
    const id = removedIds()[0];
    await service.close();
    memory.db.exec(`ALTER TABLE native_memory_tombstones DROP COLUMN removed_at;
      ALTER TABLE native_v2_operations DROP COLUMN committed_at;
      ALTER TABLE native_v2_operations DROP COLUMN restore_hash;`);
    open();
    expect(removedIds()).toEqual([id]);
    expect(service.listRemoved().items[0]!.removedAt).toBe(
      service.getOperation("removed")!.plan.createdAt,
    );
  });
  it("lists every removed item newest first without a history count cap", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 55; i++) {
      put(topic, `Synthetic removed claim ${i} with unique content.`);
      await reject(`removed_${i}`);
      const stamp = new Date(Date.UTC(2025, 0, 1, 0, 0, i)).toISOString();
      memory.db
        .query(
          "UPDATE native_memory_tombstones SET removed_at=? WHERE operation_id=?",
        )
        .run(stamp, `removed_${i}`);
      ids.unshift(`removed_${i}`);
    }
    expect(service.listRemoved().items.map((i) => i.operationId)).toEqual(ids);
  });
  it("imports the final personal owner from a deleted source, issues history/receipt, and supports rollback", async () => {
    const op = await reject("removed", "personal");
    const removalIds = removedIds();
    rmSync(topic);
    inventory();
    roots = [];
    const result = await service.restoreRemoved({ mode: "import", removalIds });
    expect(result.mode).toBe("import");
    if (result.mode !== "import") throw new Error("Expected import receipt");
    const receipt = result.receipt;
    expect(receipt.accepted).toHaveLength(1);
    expect(receipt.createdProjects).toEqual([]);
    expect(service.getOperation(receipt.operationId)!.receipt).toEqual(receipt);
    expect(service.listOperations().operations).toContainEqual({
      operationId: receipt.operationId,
      unitIds: [op.plan.units[0]!.unitId],
      createdAt: service.getOperation(receipt.operationId)!.plan.createdAt,
      state: "committed",
    });
    const item = memory.store.getById(receipt.accepted[0]!.memoryId)!;
    expect(item.content).toBe(op.plan.items[0]!.content);
    expect(item.scope).toBe("personal");
    expect(item.projectId).toBeUndefined();
    expect(removedIds()).toEqual([]);
    expect(service.rollback(receipt.operationId, true).archived).toEqual([
      item.id,
    ]);
    expect(memory.store.getById(item.id)!.status).toBe("archived");
    // Undoing the restore puts the claim back in Removed.
    expect(service.listRemoved().items.map((i) => i.operationId)).toEqual([
      receipt.operationId,
    ]);
    // Retrying after undo returns the same receipt, never another import.
    expect(
      await service.restoreRemoved({ mode: "import", removalIds }),
    ).toEqual(result);
  });
  it("imports an undone claim again by reactivating its memory, and can undo that too", async () => {
    await reject("removed", "personal");
    const first = await service.restoreRemoved({ mode: "import", removalIds: removedIds() });
    if (first.mode !== "import") throw new Error("Expected import receipt");
    const id = first.receipt.accepted[0]!.memoryId;
    service.rollback(first.receipt.operationId, true);
    const undone = service.listRemoved().items;
    expect(undone.map((i) => i.undone)).toEqual([true]);
    await expect(
      service.restoreRemoved({ mode: "suggest", removalIds: [undone[0]!.removalId] }),
    ).rejects.toThrow("only be imported again");
    const again = await service.restoreRemoved({ mode: "import", removalIds: [undone[0]!.removalId] });
    if (again.mode !== "import") throw new Error("Expected import receipt");
    expect(again.receipt.accepted[0]).toMatchObject({ memoryId: id, created: true });
    expect(memory.store.getById(id)!.status).toBe("active");
    expect(memory.store.list({ status: "active" })).toHaveLength(1);
    expect(removedIds()).toEqual([]);
    expect(service.rollback(again.receipt.operationId, true).archived).toEqual([id]);
    expect(service.listRemoved().items.map((i) => i.operationId)).toEqual([
      again.receipt.operationId,
    ]);
  });
  it("restores a project-scoped claim to its reviewed project", async () => {
    await reject();
    const result = await service.restoreRemoved({
      mode: "import",
      removalIds: removedIds(),
    });
    if (result.mode !== "import") throw new Error("Expected import receipt");
    const item = memory.store.getById(result.receipt.accepted[0]!.memoryId)!;
    expect(item.scope).toBe("project");
    expect(item.projectId).toBe("p");
    expect(memory.store.list({ scope: "personal" })).toEqual([]);
    expect(
      service.rollback(result.receipt.operationId, true).conflicts,
    ).toEqual([]);
  });
  it("creates a pending project home only during import restore and compensates failure", async () => {
    await service.close();
    roots = roots.filter((r) => r.owner.scope === "personal");
    put(
      join(dirname(dirname(topic)), "session.jsonl"),
      JSON.stringify({ type: "user", cwd: project }) + "\n",
    );
    const store = new EventStore(join(dir, "restore-projects"));
    await store.initialize();
    let opens = 0;
    open(fake, {
      open: async (path, label) => {
        opens++;
        const existing = store.listProjects().find((p) => p.localPath === path);
        const p = await store.openProject(path, label);
        return { projectId: p.id, created: !existing };
      },
      remove: (id) => store.removeProject(id),
    });
    await reject();
    const ids = removedIds();
    expect(service.listRemoved().items[0]!.owner).toEqual({ scope: "project" });
    expect(opens).toBe(0);
    await expect(
      service.restoreRemoved({
        mode: "import",
        removalIds: [...ids, "f".repeat(64)],
      }),
    ).rejects.toThrow("Unknown");
    expect(opens).toBe(0);
    const create = memory.store.create.bind(memory.store);
    memory.store.create = () => {
      throw new Error("Synthetic restore failure");
    };
    await expect(
      service.restoreRemoved({ mode: "import", removalIds: ids }),
    ).rejects.toThrow("restore failure");
    memory.store.create = create;
    expect(opens).toBe(1);
    expect(store.listProjects()).toEqual([]);
    expect(removedIds()).toEqual(ids);
    const result = await service.restoreRemoved({
      mode: "import",
      removalIds: ids,
    });
    if (result.mode !== "import") throw new Error("Expected import receipt");
    const home = store.listProjects()[0]!;
    expect(result.receipt.createdProjects).toEqual([
      { projectId: home.id, projectPath: project },
    ]);
    expect(
      memory.store.getById(result.receipt.accepted[0]!.memoryId)!.projectId,
    ).toBe(home.id);
    expect(
      service.rollback(result.receipt.operationId, true).conflicts,
    ).toEqual([]);
    expect(store.listProjects()).toHaveLength(1);
  });
  it("suggest does not create a pending project home and leaves other rejections suppressed", async () => {
    await service.close();
    roots = roots.filter((r) => r.owner.scope === "personal");
    put(
      join(dirname(dirname(topic)), "session.jsonl"),
      JSON.stringify({ type: "user", cwd: project }) + "\n",
    );
    open(fake, {
      open: async () => {
        throw new Error("Suggest must not open a home");
      },
      remove: async () => {},
    });
    put(join(dirname(topic), "other.md"), "Separate synthetic removed fact.");
    const op = service.plan({
      operationId: "both",
      unitIds: inventory().units.map((u) => u.unitId),
    });
    await service.commit("both", {
      approved: true,
      approvedItemKeys: [],
      rejectedItemKeys: op.plan.items.map((i) => i.itemKey),
    });
    const [first, second] = service.listRemoved().items;
    await service.restoreRemoved({
      mode: "suggest",
      removalIds: [first!.removalId],
    });
    expect(removedIds()).toEqual([second!.removalId]);
    const next = service.plan({
      operationId: "selective",
      unitIds: op.plan.units.map((u) => u.unitId),
    });
    expect(
      next.plan.items.find((i) => i.unitId === first!.unitId)!.disposition,
    ).toBe("new");
    expect(
      next.plan.items.find((i) => i.unitId === second!.unitId)!.disposition,
    ).toBe("suppressed");
    expect(memory.store.list()).toEqual([]);
  });
  it("keeps independently edited restored memories protected during normal rollback", async () => {
    await reject();
    const result = await service.restoreRemoved({
      mode: "import",
      removalIds: removedIds(),
    });
    if (result.mode !== "import") throw new Error("Expected import receipt");
    const id = result.receipt.accepted[0]!.memoryId;
    memory.store.update(
      id,
      { content: "Independent synthetic edit." },
      { actor: "user" },
    );
    const rollback = service.rollback(result.receipt.operationId, true);
    expect(rollback.conflicts.map((c) => c.memoryId)).toEqual([id]);
    expect(memory.store.getById(id)!.status).toBe("active");
  });
  it("reuses an existing exact match and preserves it on undo", async () => {
    const op = await reject();
    const existing = memory.store.create(
      {
        content: op.plan.items[0]!.content,
        scope: "project",
        projectId: "p",
        type: "fact",
        status: "active",
      },
      { actor: "user" },
    );
    const result = await service.restoreRemoved({
      mode: "import",
      removalIds: removedIds(),
    });
    if (result.mode !== "import") throw new Error("Expected import receipt");
    expect(result.receipt.accepted[0]).toMatchObject({
      memoryId: existing.id,
      created: false,
    });
    expect(service.rollback(result.receipt.operationId, true).archived).toEqual(
      [],
    );
    expect(memory.store.getById(existing.id)!.status).toBe("active");
  });
  it("suggest lifts every hash alias, makes unchanged inventory new, and allows another proposal", async () => {
    const op = await reject();
    expect(unit().change).toBe("unchanged");
    const input = { mode: "suggest" as const, removalIds: removedIds() };
    const result = await service.restoreRemoved(input);
    expect(result).toEqual(input);
    expect(unit().change).toBe("new");
    expect(unit().change).toBe("new");
    expect(plan("again").plan.items[0]!.disposition).toBe("new");
    expect(memory.store.list()).toEqual([]);
    expect(
      memory.db.query("SELECT * FROM native_memory_tombstones").all(),
    ).toEqual([]);
    expect(
      service.listOperations().operations.map((o) => o.operationId),
    ).toEqual(["again", op.plan.operationId]);
    await service.close();
    open();
    expect(await service.restoreRemoved(input)).toEqual(result);
    expect(unit().change).toBe("new");
  });
  it("validates the entire selection before modifying tombstones or opening any home", async () => {
    await reject();
    const ids = removedIds();
    const before = memory.db
      .query("SELECT * FROM native_memory_tombstones")
      .all();
    for (const mode of ["import", "suggest"] as const) {
      await expect(
        service.restoreRemoved({ mode, removalIds: [...ids, "f".repeat(64)] }),
      ).rejects.toThrow("Unknown or already restored");
      expect(removedIds()).toEqual(ids);
      expect(
        memory.db.query("SELECT * FROM native_memory_tombstones").all(),
      ).toEqual(before);
      expect(memory.store.list()).toEqual([]);
      expect(service.listOperations().operations).toHaveLength(1);
    }
  });
  it("rejects malformed input, duplicate IDs, and already restored IDs outside an identical retry", async () => {
    await reject();
    const ids = removedIds();
    for (const input of [
      null,
      {},
      { mode: "other", removalIds: ids },
      { mode: "suggest", removalIds: [] },
      { mode: "suggest", removalIds: [4] },
      { mode: "suggest", removalIds: ["invalid"] },
      { mode: "suggest", removalIds: [...ids, ...ids] },
    ]) {
      await expect(async () => service.restoreRemoved(input as never)).toThrow(
        "Select distinct",
      );
    }
    await service.restoreRemoved({ mode: "suggest", removalIds: ids });
    await expect(
      service.restoreRemoved({ mode: "import", removalIds: ids }),
    ).rejects.toThrow("already restored");
    put(join(dirname(topic), "other.md"), "Another removable synthetic claim.");
    const other = inventory().units.find(
      (u) => u.sourceId !== unit().sourceId,
    )!;
    const op = service.plan({ operationId: "other", unitIds: [other.unitId] });
    await service.commit("other", {
      approved: true,
      approvedItemKeys: [],
      rejectedItemKeys: op.plan.items.map((i) => i.itemKey),
    });
    const remaining = removedIds();
    await expect(
      service.restoreRemoved({
        mode: "suggest",
        removalIds: [...ids, ...remaining],
      }),
    ).rejects.toThrow("already restored");
    expect(removedIds()).toEqual(remaining);
  });
  it("deduplicates simultaneous and persisted retries with reordered IDs", async () => {
    put(
      join(dirname(topic), "other.md"),
      "Another independent synthetic fact.",
    );
    const op = service.plan({
      operationId: "both",
      unitIds: inventory().units.map((u) => u.unitId),
    });
    await service.commit("both", {
      approved: true,
      approvedItemKeys: [],
      rejectedItemKeys: op.plan.items.map((i) => i.itemKey),
    });
    const ids = removedIds();
    const [a, b] = await Promise.all([
      service.restoreRemoved({ mode: "import", removalIds: ids }),
      service.restoreRemoved({
        mode: "import",
        removalIds: [...ids].reverse(),
      }),
    ]);
    expect(b).toEqual(a);
    expect(memory.store.list()).toHaveLength(2);
    expect(service.listOperations().operations).toHaveLength(2);
    await service.close();
    open();
    expect(
      await service.restoreRemoved({ mode: "import", removalIds: ids }),
    ).toEqual(a);
  });
  it("rolls back tombstone lifting, memories, receipts and retry state on a failed batch write", async () => {
    put(
      join(dirname(topic), "other.md"),
      "Another independent synthetic fact.",
    );
    const op = service.plan({
      operationId: "both",
      unitIds: inventory().units.map((u) => u.unitId),
    });
    await service.commit("both", {
      approved: true,
      approvedItemKeys: [],
      rejectedItemKeys: op.plan.items.map((i) => i.itemKey),
    });
    const ids = removedIds();
    let calls = 0;
    const create = memory.store.create.bind(memory.store);
    memory.store.create = ((...args: Parameters<typeof create>) => {
      if (++calls === 2) throw new Error("Synthetic second write failure");
      return create(...args);
    }) as typeof create;
    await expect(
      service.restoreRemoved({ mode: "import", removalIds: ids }),
    ).rejects.toThrow("second write failure");
    memory.store.create = create;
    expect(removedIds()).toEqual(ids);
    expect(memory.store.list()).toEqual([]);
    expect(service.listOperations().operations).toHaveLength(1);
    expect(memory.db.query("SELECT * FROM native_v2_restores").all()).toEqual(
      [],
    );
    expect(
      (await service.restoreRemoved({ mode: "import", removalIds: ids })).mode,
    ).toBe("import");
  });
  it("exposes the removed and restore routes before operation-ID matching", async () => {
    await reject();
    const response = await request("GET", "");
    expect(response.status).toBe(200);
    const listed = await response.json();
    expect(listed.data.items).toHaveLength(1);
    const result = await request("POST", "/restore", {
      mode: "import",
      removalIds: removedIds(),
    });
    expect(result.status).toBe(200);
    expect((await result.json()).data.receipt.state).toBe("committed");
    expect((await request("GET", "/restore")).status).toBe(405);
    expect((await request("POST", "", {})).status).toBe(405);
    expect(
      (
        await request("POST", "/restore", {
          mode: "suggest",
          removalIds: ["f".repeat(64)],
        })
      ).status,
    ).toBe(409);
    expect(
      (await request("POST", "/restore", { mode: "suggest", removalIds: [] }))
        .status,
    ).toBe(400);
  });
});
