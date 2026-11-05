import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  lstatSync,
  opendirSync,
  openSync,
  closeSync,
  constants,
  readSync,
} from "node:fs";
import type {
  NativeMemoryRoot,
  NativeMemorySource,
  NativeMemoryUnit,
  NativeParseAnomaly,
  NativeProjectScope,
} from "../../shared/native-memory";
import {
  nativeHash,
  nativeMarkdownBlocks,
  nativeReferences,
  screenedNativeText,
} from "./native-discovery";

export const NATIVE_PARSER_VERSION = "native-v2.1";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export interface NativeParsedUnit {
  unit: NativeMemoryUnit;
  text: string;
}
export interface NativeRolloutHeader {
  thread_id?: string;
  updated_at?: string;
  rollout_path?: string;
  cwd?: string;
  git_branch?: string;
}
/** applies_to can run on in prose after the path. A path itself may still contain spaces. */
const scopePath = (value: string) =>
  value
    .replace(
      /\s+(?:(?:with|and|plus|including|for|on|at|via|from|using)\b|\(|[a-z_]+=).*$/s,
      "",
    )
    .trim();

export function parseRolloutHeader(text: string): {
  metadata: NativeRolloutHeader;
  valid: boolean;
} {
  const metadata: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match =
      /^(thread_id|updated_at|rollout_path|cwd|git_branch): (.*)$/.exec(line);
    if (!match) break;
    metadata[match[1]!] = match[2]!;
  }
  return {
    metadata,
    valid:
      new RegExp(`^${UUID}$`, "i").test(metadata.thread_id ?? "") &&
      ["updated_at", "rollout_path", "cwd"].every((k) => !!metadata[k]),
  };
}
/** Historical raw bodies need no YAML preamble. This parser never emits import units. */
export function parseRawEntries(text: string): Array<{
  threadId: string;
  metadata: Record<string, string>;
  body: string;
  bodyMetadata?: unknown;
  bodyPreambleFormat?: "yaml" | "legacy-key-value";
  anomaly?: string;
}> {
  const pattern = new RegExp(
    "^## Thread `(" +
      UUID +
      ")`\\r?\\nupdated_at: ([^\\n]+)\\ncwd: ([^\\n]+)\\nrollout_path: ([^\\n]+)\\nrollout_summary_file: ([^\\n]+)\\n",
    "gmi",
  );
  const matches = [...text.replace(/\r\n/g, "\n").matchAll(pattern)];
  const normalized = text.replace(/\r\n/g, "\n");
  return matches.map((m, i) => {
    const body = normalized
      .slice(m.index! + m[0].length, matches[i + 1]?.index)
      .trim();
    let bodyMetadata: unknown,
      bodyPreambleFormat: "yaml" | "legacy-key-value" | undefined,
      anomaly: string | undefined;
    if (body.startsWith("---\n")) {
      const end = body.indexOf("\n---", 4);
      if (end < 0) anomaly = "malformed-raw-preamble";
      else
        try {
          bodyMetadata = Bun.YAML.parse(body.slice(4, end));
          bodyPreambleFormat = "yaml";
        } catch {
          // Historical native outputs also used loose key/value preambles with
          // unquoted colons in prose. Preserve values verbatim instead of
          // treating these known variants as invalid YAML or discarding them.
          const fields: Record<string, string> = {};
          let key: string | undefined;
          for (const line of body.slice(4, end).split("\n")) {
            const field = /^([A-Za-z_][\w.-]*):\s*(.*)$/.exec(line);
            if (field) {
              key = field[1]!;
              fields[key] = field[2]!;
            } else if (key) fields[key] += "\n" + line;
          }
          if (Object.keys(fields).length) {
            bodyMetadata = fields;
            bodyPreambleFormat = "legacy-key-value";
          } else anomaly = "malformed-raw-preamble";
        }
    }
    return {
      threadId: m[1]!,
      metadata: {
        updated_at: m[2]!,
        cwd: m[3]!,
        rollout_path: m[4]!,
        rollout_summary_file: m[5]!,
      },
      body,
      ...(bodyMetadata !== undefined
        ? { bodyMetadata, bodyPreambleFormat }
        : {}),
      ...(anomaly ? { anomaly } : {}),
    };
  });
}
export function claudeProjectKey(path: string): string | undefined {
  const encoded = path.replace(/[^a-zA-Z0-9]/g, "-");
  // Long keys need the installed native hash implementation; never guess a hash.
  return encoded.length <= 200 ? encoded : undefined;
}
/** Read only session metadata lines, not session bodies. No slug reversal. */
export function claudeProjectPaths(
  home: string,
  roots: NativeMemoryRoot[],
  claudeConfigDir = join(home, ".claude"),
): Map<string, string> {
  const result = new Map<string, string>(),
    candidates = new Set(
      roots
        .filter((r) => r.owner.scope === "project")
        .map((r) => resolve(r.path)),
    );
  const projects = join(claudeConfigDir, "projects");
  let dirs;
  try {
    if (lstatSync(projects).isSymbolicLink()) return result;
    dirs = opendirSync(projects);
    for (;;) {
      const dir = dirs.readSync();
      if (!dir) break;
      if (!dir.isDirectory() || dir.isSymbolicLink()) continue;
      let entries;
      try {
        entries = opendirSync(join(projects, dir.name));
        for (;;) {
          const file = entries.readSync();
          if (!file) break;
          if (
            !file.isFile() ||
            file.isSymbolicLink() ||
            !file.name.endsWith(".jsonl")
          )
            continue;
          const fd = openSync(
            join(projects, dir.name, file.name),
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          try {
            // Transport-sized reads, no file-count bound. Stop at first metadata line with cwd.
            const buffer = Buffer.alloc(8192);
            let pending = "",
              done = false;
            for (;;) {
              const n = readSync(fd, buffer, 0, buffer.length, null);
              if (!n) break;
              pending += buffer.subarray(0, n).toString("utf8");
              let newline;
              while ((newline = pending.indexOf("\n")) >= 0) {
                const line = pending.slice(0, newline);
                pending = pending.slice(newline + 1);
                try {
                  const record = JSON.parse(line);
                  if (
                    typeof record.cwd === "string" &&
                    isAbsolute(record.cwd)
                  ) {
                    candidates.add(resolve(record.cwd));
                    done = true;
                    break;
                  }
                } catch {}
              }
              if (done) break;
            }
          } finally {
            closeSync(fd);
          }
        }
      } catch {
      } finally {
        entries?.closeSync();
      }
    }
  } catch {
  } finally {
    dirs?.closeSync();
  }
  for (const path of candidates) {
    const key = claudeProjectKey(path);
    if (key) result.set(key, path);
  }
  return result;
}
export function parseNativeUnits(
  source: NativeMemorySource,
  original: string,
  roots: NativeMemoryRoot[],
  claudePaths: Map<string, string>,
  anomalies: NativeParseAnomaly[],
): NativeParsedUnit[] {
  if (source.role !== "units") return [];
  const text = screenedNativeText(original),
    lines = text.split(/\r?\n/),
    originalLines = original.split(/\r?\n/);
  const paths = new Map<string, NativeProjectScope["verifiedBy"]>();
  const anomaly = (code: string) =>
    anomalies.push({ locator: source.locator, code });
  let metadata: Record<string, unknown> = {};
  if (source.engine === "claude") {
    const key = source.namespace.startsWith("auto:")
      ? source.namespace.slice(5)
      : undefined;
    const path = key
      ? claudePaths.get(key)
      : source.owner.scope === "project"
        ? roots.find((r) => r.id === source.rootId)?.path
        : undefined;
    if (path) paths.set(path, key ? "session-encoder" : "selected-root");
    if (text.startsWith("---\n") || text.startsWith("---\r\n")) {
      const end = lines
        .slice(1)
        .findIndex((line) => /^(?:---|\.\.\.)\s*$/.test(line));
      if (end < 0) anomaly("malformed-frontmatter");
      else
        try {
          const parsed = Bun.YAML.parse(lines.slice(1, end + 1).join("\n"));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            metadata = parsed as Record<string, unknown>;
            const nested =
              metadata.metadata && typeof metadata.metadata === "object"
                ? (metadata.metadata as Record<string, unknown>)
                : {};
            for (const field of [
              "type",
              "originSessionId",
              "modified",
              "node_type",
            ]) {
              if (
                metadata[field] !== undefined &&
                nested[field] !== undefined &&
                JSON.stringify(metadata[field]) !==
                  JSON.stringify(nested[field])
              )
                anomaly(`frontmatter-conflict:${field}`);
              if (metadata[field] === undefined && nested[field] !== undefined)
                metadata[field] = nested[field];
            }
          } else anomaly("malformed-frontmatter");
        } catch {
          anomaly("malformed-frontmatter");
        }
    }
  }
  const make = (
    start: number,
    end: number,
    title: string,
    headingPath: string,
    occurrence: number,
    extra: Record<string, unknown> = {},
    scopePaths = paths,
  ): NativeParsedUnit => {
    const scopes: NativeProjectScope[] = [...scopePaths]
      .filter(([p]) => isAbsolute(p))
      .map(([p, verifiedBy]) => {
        const project = roots.find(
          (r) => r.owner.scope === "project" && resolve(r.path) === resolve(p),
        );
        return {
          path: p,
          projectId: project?.owner.projectId,
          label: project?.label ?? p,
          verifiedBy,
        };
      });
    const resolvedProjectIds = new Set(
      scopes.map((s) => s.projectId).filter(Boolean),
    );
    const owner =
      resolvedProjectIds.size === 1 && scopes.every((s) => s.projectId)
        ? { scope: "project" as const, projectId: [...resolvedProjectIds][0]! }
        : { scope: "personal" as const };
    const body = lines.slice(start - 1, end).join("\n"),
      raw = originalLines.slice(start - 1, end).join("\n");
    const stableLocator = JSON.stringify([
      source.engine,
      source.namespace,
      source.memoryRoot ?? dirname(source.locator),
      source.relativePath ?? source.locator,
      headingPath,
      occurrence,
    ]);
    const unitId = nativeHash(stableLocator),
      bytes = Buffer.byteLength(body);
    const threadIds = [
      ...body.matchAll(/thread_id[=:]\s*([0-9a-f-]{36})/gi),
    ].map((m) => m[1]!);
    return {
      text: body,
      unit: {
        unitId,
        stableLocator,
        sourceId: source.sourceId,
        engine: source.engine,
        namespace: source.namespace,
        title,
        topic: headingPath.split(" > ")[0] ?? title,
        kind: source.kind,
        owner,
        scopes,
        unresolvedProject: !scopes.length,
        projectLabel:
          scopes.map((s) => s.label).join(" · ") || "Unresolved project",
        contentHash: nativeHash(raw + JSON.stringify(extra)),
        parserVersion: NATIVE_PARSER_VERSION,
        linkedMemoryIds: [],
        change: "new",
        selectedByDefault: source.namespace !== "v2",
        startLine: start,
        endLine: end,
        bytes,
        estimatedTokens: Math.ceil(bytes / 4),
        metadata: { ...metadata, ...extra },
        taskRefs: [
          ...new Set([...body.matchAll(/\[Task (\d+)\]/g)].map((m) => m[1]!)),
        ],
        evidenceThreadIds: [...new Set(threadIds)],
        correctionSourceIds: [],
        correctionHash: nativeHash(""),
        screening: source.screening,
        quarantinedBlocks: source.quarantinedBlocks,
      },
    };
  };
  if (source.engine === "codex" && source.namespace === "v2") {
    const header = parseRolloutHeader(text);
    if (!header.valid) anomaly("malformed-rollout-header");
    if (header.metadata.cwd) paths.set(header.metadata.cwd, "cwd");
    const unit = make(
      1,
      lines.length,
      String(lines.find((l) => /^# /.test(l))?.slice(2) ?? source.relativePath),
      header.metadata.thread_id ?? source.relativePath!,
      0,
      { ...header.metadata },
    );
    if (header.valid) {
      unit.unit.stableLocator = JSON.stringify([
        "codex",
        "v2",
        header.metadata.thread_id,
      ]);
      unit.unit.unitId = nativeHash(unit.unit.stableLocator);
      unit.unit.evidenceThreadIds = [header.metadata.thread_id!];
    }
    return [unit];
  }
  if (
    source.engine !== "codex" ||
    source.namespace !== "v1" ||
    !/MEMORY\.md$/.test(source.locator)
  ) {
    return [
      make(
        1,
        lines.length,
        String(metadata.name ?? source.relativePath ?? source.locator),
        source.relativePath ?? source.locator,
        0,
      ),
    ];
  }
  const headings = nativeMarkdownBlocks(text)
    .filter((b) => b.kind === "heading")
    .map((b) => ({
      line: b.startLine,
      title: lines[b.startLine - 1]!.replace(/^#+\s*/, ""),
      level: /^#+/.exec(lines[b.startLine - 1]!)?.[0].length,
    }));
  const groups = headings.filter(
    (h) => h.level === 1 && h.title.startsWith("Task Group:"),
  );
  if (!groups.length) {
    anomaly("handbook-without-task-groups");
    return [make(1, lines.length, "Legacy handbook", "Legacy handbook", 0)];
  }
  const result: NativeParsedUnit[] = [],
    seen = new Map<string, number>();
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index]!,
      end = (groups[index + 1]?.line ?? lines.length + 1) - 1;
    const groupText = lines.slice(group.line - 1, end).join("\n"),
      groupPaths = new Map<string, NativeProjectScope["verifiedBy"]>();
    for (const m of groupText.matchAll(
      /\bcwd[=:]\s*(\/.*?)(?=; reuse_rule=|;\s*cwd=|,\s*(?:rollout_path|updated_at|thread_id)=|\)|$)/gm,
    ))
      groupPaths.set(
        scopePath(m[1]!),
        /applies_to:/.test(m.input!.slice(Math.max(0, m.index! - 20), m.index!))
          ? "applies_to"
          : "cwd",
      );
    const apply = /^applies_to:\s*(.*?)(?:; reuse_rule=.*)?$/m.exec(
      groupText,
    )?.[1];
    if (apply && isAbsolute(apply.trim()))
      groupPaths.set(scopePath(apply), "applies_to");
    const sections = headings.filter(
      (h) => h.level === 2 && h.line > group.line && h.line <= end,
    );
    const preamble = lines
      .slice(group.line - 1, (sections[0]?.line ?? end + 1) - 1)
      .join("\n");
    if (!sections.length) {
      anomaly("group-without-sections");
      sections.push({ line: group.line, title: group.title, level: 2 });
    }
    for (let j = 0; j < sections.length; j++) {
      const section = sections[j]!,
        sectionEnd = (sections[j + 1]?.line ?? end + 1) - 1;
      const path = `${group.title} > ${section.title}`,
        occurrence = seen.get(path) ?? 0;
      seen.set(path, occurrence + 1);
      const parsed = make(
        section.line,
        sectionEnd,
        section.title,
        path,
        occurrence,
        {
          group: group.title,
          context: preamble,
          applies_to: apply,
          keywords:
            /### keywords\s*\n([^#]*)/
              .exec(lines.slice(section.line - 1, sectionEnd).join("\n"))?.[1]
              ?.trim() ?? "",
        },
        groupPaths,
      );
      // Shared guidance can request any supporting thread in this group.
      parsed.unit.evidenceThreadIds = [
        ...new Set(
          [...groupText.matchAll(/thread_id[=:]\s*([0-9a-f-]{36})/gi)].map(
            (m) => m[1]!,
          ),
        ),
      ];
      result.push(parsed);
    }
  }
  return result;
}
export function nativeSourceLinks(
  source: NativeMemorySource,
  text: string,
): string[] {
  return nativeReferences(screenedNativeText(text)).map((path) =>
    resolve(dirname(source.locator), path),
  );
}
