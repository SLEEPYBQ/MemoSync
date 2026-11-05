import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type {
  NativeImportCommitInput,
  NativeImportHistory,
  NativeImportItem,
  NativeImportOperation,
  NativeImportPlan,
  NativeImportPlanInput,
  NativeImportReceipt,
  NativeImportRollback,
  NativeMemoryOwner,
  NativeMemoryUnit,
  NativeRefinedClaim,
  NativeRemovedItem,
  NativeRemovedResult,
  NativeRestoreInput,
  NativeRestoreResult,
} from "../../shared/native-memory";
import type { MemoryService } from "./index";
import type { MemoryItem } from "./types";
import {
  NativeMemoryDiscovery,
  NativeMemoryError,
  nativeHash,
  nativeMarkdownBlocks,
  nativeTextPersonal,
  nativeTextSensitive,
} from "./native-discovery";
import { NativeInventory } from "./native-inventory";
import { NativeRefinementService } from "./native-refinement";
import {
  createNativeModelCaller,
  type NativeModelCaller,
} from "./native-refinement-runtime";

interface Link {
  unit_id: string;
  item_key: string;
  quote_hash: string;
  claim_hash: string;
  memory_id: string | null;
  version: number | null;
  digest: string | null;
  event_seq: number | null;
  operation_id: string;
  decision: string;
  created: number;
}
interface Undo {
  itemKey: string;
  memory?: MemoryItem;
  link?: Link;
}
interface Tombstone {
  owner_key: string;
  claim_hash: string;
  decision: "rejected" | "revoked";
  operation_id: string;
  removed_at: string | null;
}
interface Removal {
  summary: NativeRemovedItem;
  item: NativeImportItem;
  unit: NativeMemoryUnit;
  tombstones: Tombstone[];
}
interface RestoreCommit {
  plan: NativeImportPlan;
  removals: Removal[];
  requestHash: string;
  removalIds: string[];
  /** Plan item key -> the memory an earlier rollback archived; importing again reactivates it. */
  revive: Map<string, string>;
}
export interface NativeImportOptions {
  memory: MemoryService;
  discovery: NativeMemoryDiscovery;
  modelCaller?: NativeModelCaller;
  /** Uses the normal folder-opening store. Remove only homes created by a failed commit. */
  projectHomes?: {
    open(
      path: string,
      label?: string,
    ): Promise<{ projectId: string; created: boolean }>;
    remove(projectId: string): Promise<void>;
  };
  isClaimSuppressed?: (content: string, owner: NativeMemoryOwner) => boolean;
}
type ProposalOwner = NativeImportItem["owner"];
const ownerKey = (owner: ProposalOwner, projectPath?: string) =>
  JSON.stringify([
    owner.scope,
    owner.projectId ?? (owner.scope === "project" ? projectPath : null) ?? null,
  ]);
const sameOwner = (item: MemoryItem, owner: ProposalOwner) =>
  item.scope === owner.scope &&
  (item.projectId ?? null) === (owner.projectId ?? null) &&
  !item.sessionId;
const hashClaim = (text: string) => nativeHash(text.trim());
const digest = (item: MemoryItem) =>
  nativeHash(
    JSON.stringify([
      item.content,
      item.detail ?? null,
      item.scope,
      item.projectId ?? null,
      item.sessionId ?? null,
      item.status,
      item.version,
      item.type,
      item.sensitive,
      item.abstractionLevel,
      item.topic ?? null,
    ]),
  );
const bad = (message: string): never => {
  throw new NativeMemoryError(400, "BAD_REQUEST", message);
};
const conflict = (message: string): never => {
  throw new NativeMemoryError(409, "IMPORT_CONFLICT", message);
};
export function nativeOperationId(id: string): void {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id))
    bad("Expected a valid operation ID");
}
export class NativeMemoryImportService {
  readonly db: Database;
  readonly memory: MemoryService;
  readonly discovery: NativeMemoryDiscovery;
  readonly inventory: NativeInventory;
  readonly refinement: NativeRefinementService;
  constructor(private readonly options: NativeImportOptions) {
    this.db = options.memory.db;
    this.memory = options.memory;
    this.discovery = options.discovery;
    this.inventory = new NativeInventory(this.db, this.discovery);
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS native_memory_tombstones(owner_key TEXT NOT NULL,claim_hash TEXT NOT NULL,decision TEXT NOT NULL,operation_id TEXT NOT NULL,PRIMARY KEY(owner_key,claim_hash));
      CREATE TABLE IF NOT EXISTS native_v2_links(unit_id TEXT NOT NULL,item_key TEXT NOT NULL,quote_hash TEXT NOT NULL,claim_hash TEXT NOT NULL,memory_id TEXT,version INTEGER,digest TEXT,event_seq INTEGER,operation_id TEXT NOT NULL,decision TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(unit_id,item_key));
      CREATE TABLE IF NOT EXISTS native_v2_operations(operation_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,plan TEXT NOT NULL,commit_hash TEXT,receipt TEXT,rollback TEXT,undo TEXT);
      CREATE INDEX IF NOT EXISTS native_v2_link_memory ON native_v2_links(memory_id);`);
    // Additive migration: old tombstones retain their operation-time fallback.
    for (const [table, column] of [
      ["native_memory_tombstones", "removed_at"],
      ["native_v2_operations", "committed_at"],
      ["native_v2_operations", "restore_hash"],
    ]) {
      const columns = this.db
        .query(`PRAGMA table_info(${table})`)
        .all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === column))
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
    }
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS native_v2_restores(request_hash TEXT PRIMARY KEY,result TEXT NOT NULL);`,
    );
    this.refinement = new NativeRefinementService(
      this,
      options.modelCaller ?? createNativeModelCaller(),
    );
  }
  async close(): Promise<void> {
    await this.refinement.close();
    await this.commitChain;
  }
  private links(id: string): Link[] {
    return this.db
      .query("SELECT * FROM native_v2_links WHERE unit_id=?")
      .all(id) as Link[];
  }
  private eventSeq(id: string): number {
    return (
      this.db
        .query(
          "SELECT COALESCE(MAX(seq),0) seq FROM memory_events WHERE memory_id=? AND kind NOT IN ('use','trace')",
        )
        .get(id) as { seq: number }
    ).seq;
  }
  private pool(owner: ProposalOwner): MemoryItem[] {
    if (owner.scope === "project" && !owner.projectId) return [];
    return this.memory.store
      .list({ scope: owner.scope })
      .filter((m) => sameOwner(m, owner));
  }
  private suppressed(
    content: string,
    quoteHash: string,
    owner: ProposalOwner,
    projectPath?: string,
  ): boolean {
    // A verbatim unit must not reopen a previously suppressed atomic claim
    // simply by surrounding it with newly imported context or other paragraphs.
    const fragments = new Set([content]);
    for (const block of nativeMarkdownBlocks(content)) {
      if (block.kind !== "content") continue;
      fragments.add(block.content);
      fragments.add(block.quote);
      if (block.context) fragments.add(block.context + "\n" + block.content);
    }
    const discarded = this.pool(owner).filter((m) =>
      ["archived", "discarded"].includes(m.status),
    );
    for (const fragment of fragments) {
      if (
        this.db
          .query(
            "SELECT 1 FROM native_memory_tombstones WHERE owner_key IN (?,?) AND claim_hash IN (?,?)",
          )
          .get(
            ownerKey(owner, projectPath),
            owner.scope === "project"
              ? ownerKey({ scope: "project" }, projectPath)
              : ownerKey(owner),
            hashClaim(fragment),
            quoteHash,
          ) ||
        (owner.scope === "project" && !owner.projectId
          ? false
          : this.options.isClaimSuppressed?.(
              fragment,
              owner as NativeMemoryOwner,
            )) ||
        discarded.some((m) => hashClaim(m.content) === hashClaim(fragment))
      )
        return true;
    }
    return false;
  }

  getOperation(id: string): NativeImportOperation | null {
    nativeOperationId(id);
    const row = this.db
      .query(
        "SELECT plan,receipt,rollback,restore_hash FROM native_v2_operations WHERE operation_id=?",
      )
      .get(id) as {
      plan: string;
      receipt: string | null;
      rollback: string | null;
      restore_hash: string | null;
    } | null;
    if (!row) return null;
    const plan: NativeImportPlan = JSON.parse(row.plan);
    if (!row.restore_hash)
      for (const unit of plan.units) this.inventory.get(unit.unitId);
    return {
      plan,
      ...(row.receipt ? { receipt: JSON.parse(row.receipt) } : {}),
      ...(row.rollback ? { rollback: JSON.parse(row.rollback) } : {}),
    };
  }
  listOperations(): NativeImportHistory {
    const rows = this.db
      .query(
        "SELECT operation_id,plan,receipt,rollback,restore_hash FROM native_v2_operations ORDER BY rowid DESC",
      )
      .all() as Array<{
      operation_id: string;
      plan: string;
      receipt: string | null;
      rollback: string | null;
      restore_hash: string | null;
    }>;
    const operations: NativeImportHistory["operations"] = [];
    for (const row of rows) {
      const plan: NativeImportPlan = JSON.parse(row.plan);
      try {
        if (!row.restore_hash)
          for (const u of plan.units) this.inventory.get(u.unitId);
      } catch {
        continue;
      }
      operations.push({
        operationId: row.operation_id,
        unitIds: plan.units.map((u) => u.unitId),
        createdAt: plan.createdAt,
        state: row.rollback
          ? "rolled-back"
          : row.receipt
            ? "committed"
            : "proposed",
      });
      if (operations.length === 51) break;
    }
    return {
      operations: operations.slice(0, 50),
      hasMore: operations.length > 50,
    };
  }
  private removals(): Removal[] {
    const rows = this.db
      .query(
        // Rejected at review or revoked by a rollback: both are claims the user set aside.
        `SELECT owner_key,claim_hash,decision,operation_id,removed_at
         FROM native_memory_tombstones WHERE decision IN ('rejected','revoked')`,
      )
      .all() as Tombstone[];
    const operations = new Map<string, typeof rows>();
    for (const row of rows) {
      const group = operations.get(row.operation_id) ?? [];
      group.push(row);
      operations.set(row.operation_id, group);
    }
    const result: Removal[] = [];
    const sources = new Map<string, boolean>();
    for (const group of operations.values()) {
      // Load each saved plan once even when it rejected thousands of claims.
      const operationId = group[0]!.operation_id;
      const row = this.db
        .query(
          "SELECT plan,receipt,committed_at FROM native_v2_operations WHERE operation_id=?",
        )
        .get(operationId) as {
        plan: string;
        receipt: string | null;
        committed_at: string | null;
      } | null;
      if (!row) continue;
      const plan: NativeImportPlan = JSON.parse(row.plan);
      const receipt: NativeImportReceipt | undefined = row.receipt
        ? JSON.parse(row.receipt)
        : undefined;
      const rejected = new Set(receipt?.rejected ?? []);
      const accepted = new Set(receipt?.accepted.map((a) => a.itemKey) ?? []);
      const units = new Map(plan.units.map((u) => [u.unitId, u]));
      const aliases = new Map(
        group.map((t) => [JSON.stringify([t.owner_key, t.claim_hash]), t]),
      );
      for (const item of plan.items) {
        const decision = rejected.has(item.itemKey)
          ? "rejected"
          : accepted.has(item.itemKey)
            ? "revoked"
            : null;
        if (!decision) continue;
        const keys = this.tombstoneKeys(item);
        const tombstones = keys.flatMap((key) =>
          [...new Set([item.claimHash, item.quoteHash])].flatMap((hash) => {
            const row = aliases.get(JSON.stringify([key, hash]));
            return row?.decision === decision ? [row] : [];
          }),
        );
        if (!tombstones.length) continue;
        const unit = units.get(item.unitId);
        if (!unit) continue;
        if (!sources.has(item.provenance.locator)) {
          let exists = false;
          try {
            exists = statSync(item.provenance.locator).isFile();
          } catch {}
          sources.set(item.provenance.locator, exists);
        }
        result.push({
          item,
          unit,
          tombstones,
          summary: {
            removalId: nativeHash(JSON.stringify([operationId, item.itemKey])),
            content: item.content,
            context: item.context,
            owner: item.owner,
            projectPath: item.projectPath,
            projectLabel: item.projectLabel,
            engine: unit.engine,
            unitId: unit.unitId,
            unitTitle: unit.title,
            operationId,
            removedAt:
              tombstones.map((t) => t.removed_at).find((t) => t !== null) ??
              row.committed_at ??
              plan.createdAt,
            sourceExists: sources.get(item.provenance.locator)!,
            undone: decision === "revoked",
          },
        });
      }
    }
    return result.sort(
      (a, b) =>
        b.summary.removedAt.localeCompare(a.summary.removedAt) ||
        a.summary.removalId.localeCompare(b.summary.removalId),
    );
  }
  listRemoved(): NativeRemovedResult {
    return { items: this.removals().map((r) => r.summary) };
  }
  restoreRemoved(input: NativeRestoreInput): Promise<NativeRestoreResult> {
    if (
      !input ||
      !["import", "suggest"].includes(input.mode) ||
      !Array.isArray(input.removalIds) ||
      !input.removalIds.length ||
      input.removalIds.some(
        (id) => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id),
      ) ||
      new Set(input.removalIds).size !== input.removalIds.length
    )
      bad("Select distinct removal IDs and an import or suggest mode");
    const removalIds = [...input.removalIds].sort();
    const mode = input.mode;
    const run = this.commitChain.then(
      async (): Promise<NativeRestoreResult> => {
        const requestHash = nativeHash(JSON.stringify([mode, removalIds]));
        const retry = this.db
          .query("SELECT result FROM native_v2_restores WHERE request_hash=?")
          .get(requestHash) as { result: string } | null;
        if (retry) {
          const result: NativeRestoreResult = JSON.parse(retry.result);
          if (result.mode === "import") this.sync(result.receipt.operationId);
          return result;
        }
        const available = new Map(
          this.removals().map((r) => [r.summary.removalId, r]),
        );
        const removals = removalIds.map((id) => {
          const removal = available.get(id);
          if (!removal)
            throw new NativeMemoryError(
              409,
              "REMOVAL_NOT_FOUND",
              "Unknown or already restored removal ID",
            );
          return removal;
        });
        if (mode === "suggest") {
          // An undone import was already reviewed once; it can only be imported again.
          if (removals.some((r) => r.summary.undone))
            conflict("Undone imports can only be imported again");
          return this.db
            .transaction(() => {
              this.liftRemovals(removals);
              // A nonmatching fingerprint persists across scans until the next reviewed commit.
              for (const { unit } of removals)
                this.db
                  .query(
                    "UPDATE native_v2_units SET last_imported_hash=? WHERE unit_id=?",
                  )
                  .run(`restore:${requestHash}`, unit.unitId);
              const result: NativeRestoreResult = { mode, removalIds };
              this.saveRestore(requestHash, result);
              return result;
            })
            .immediate();
        }
        const operationId = randomUUID();
        const revive = new Map<string, string>();
        const plan: NativeImportPlan = {
          operationId,
          units: [
            ...new Map(removals.map((r) => [r.unit.unitId, r.unit])).values(),
          ],
          items: removals.map((removal) => {
            const restored = structuredClone(removal.item);
            restored.itemKey = randomUUID();
            const archived = this.archivedByRollback(removal);
            if (archived) revive.set(restored.itemKey, archived);
            delete restored.target;
            delete restored.reason;
            restored.disposition = "new";
            const matches = this.pool(restored.owner).filter(
              (m) =>
                hashClaim(m.content) === restored.claimHash &&
                ["active", "candidate"].includes(m.status),
            );
            if (
              matches.length > 1 ||
              matches[0]?.status === "candidate" ||
              matches[0]?.sensitive
            )
              conflict(
                "Multiple or pending/sensitive matches under final owner",
              );
            if (matches[0]) {
              restored.disposition = "exact-match";
              restored.target = {
                memoryId: matches[0].id,
                version: matches[0].version,
                digest: digest(matches[0]),
              };
            }
            return restored;
          }),
          state: "proposed",
          extraction: "local",
          droppedQuotes: 0,
          createdAt: new Date().toISOString(),
        };
        const receipt = await this.commitReviewed(
          operationId,
          {
            approved: true,
            approvedItemKeys: plan.items.map((i) => i.itemKey),
          },
          { plan, removals, requestHash, removalIds, revive },
        );
        return { mode, removalIds, receipt };
      },
    );
    this.commitChain = run.catch(() => {});
    return run;
  }
  private archivedByRollback({ item, summary }: Removal): string | undefined {
    if (!summary.undone) return undefined;
    const row = this.db
      .query(
        "SELECT memory_id FROM native_v2_links WHERE unit_id=? AND item_key=? AND operation_id=?",
      )
      .get(item.unitId, item.itemKey, summary.operationId) as {
      memory_id: string | null;
    } | null;
    const memory = row?.memory_id
      ? this.memory.store.getById(row.memory_id)
      : null;
    return memory?.status === "archived" &&
      sameOwner(memory, item.owner) &&
      hashClaim(memory.content) === item.claimHash
      ? memory.id
      : undefined;
  }
  private saveRestore(requestHash: string, result: NativeRestoreResult): void {
    this.db
      .query("INSERT INTO native_v2_restores(request_hash,result) VALUES(?,?)")
      .run(requestHash, JSON.stringify(result));
  }
  private liftRemovals(removals: Removal[]): void {
    // Check the entire selection before deleting any scoped hash aliases.
    for (const removal of removals)
      for (const t of removal.tombstones)
        if (
          !this.db
            .query(
              `SELECT 1 FROM native_memory_tombstones
          WHERE owner_key=? AND claim_hash=? AND operation_id=? AND decision=?`,
            )
            .get(t.owner_key, t.claim_hash, t.operation_id, t.decision)
        )
          conflict("Removal changed during restore");
    for (const removal of removals)
      for (const t of removal.tombstones)
        this.db
          .query(
            `DELETE FROM native_memory_tombstones
          WHERE owner_key=? AND claim_hash=? AND operation_id=? AND decision=?`,
          )
          .run(t.owner_key, t.claim_hash, t.operation_id, t.decision);
    for (const removal of removals)
      this.db
        .query(
          `DELETE FROM native_v2_links
        WHERE unit_id=? AND item_key=? AND operation_id=? AND decision IN ('rejected','revoked')`,
        )
        .run(
          removal.item.unitId,
          removal.item.itemKey,
          removal.summary.operationId,
        );
  }
  plan(input: NativeImportPlanInput): NativeImportOperation {
    if (
      !input ||
      !Array.isArray(input.unitIds) ||
      !input.unitIds.length ||
      new Set(input.unitIds).size !== input.unitIds.length ||
      input.unitIds.some((id) => typeof id !== "string")
    )
      bad("Select distinct unit IDs");
    const claims = new Map<string, NativeRefinedClaim[]>();
    for (const id of input.unitIds) {
      const { unit, text, corrections } = this.inventory.get(id);
      const context = String(unit.metadata.context ?? unit.topic);
      claims.set(
        id,
        text.trim()
          ? [
              {
                content: [
                  context,
                  text,
                  ...corrections.map(
                    (c) =>
                      `Later correction (reconcile with the historical source):\n${c.text}`,
                  ),
                ]
                  .filter(Boolean)
                  .join("\n\n"),
                scope: unit.scopes.length ? "project" : "personal",
                quote: text,
              },
            ]
          : [],
      );
    }
    return this.prepare(input.operationId, input.unitIds, claims, "local", 0);
  }
  prepare(
    id: string,
    unitIds: string[],
    claims: Map<string, NativeRefinedClaim[]>,
    extraction: "local" | "refined",
    droppedQuotes: number,
  ): NativeImportOperation {
    nativeOperationId(id);
    const units = unitIds.map((id) => this.inventory.get(id).unit);
    this.inventory.assertCurrent(units);
    const requestHash = nativeHash(
      JSON.stringify([unitIds, extraction, [...claims]]),
    );
    const existing = this.getOperation(id);
    if (existing) {
      const row = this.db
        .query(
          "SELECT request_hash FROM native_v2_operations WHERE operation_id=?",
        )
        .get(id) as { request_hash: string };
      if (row.request_hash !== requestHash)
        conflict("operationId already belongs to another plan");
      return existing;
    }
    const plan: NativeImportPlan = {
      operationId: id,
      units,
      state: "proposed",
      extraction,
      items: [],
      droppedQuotes,
      createdAt: new Date().toISOString(),
    };
    for (const unit of units) {
      if (unit.kind !== "native-memory" || unit.change === "removed")
        conflict("Removed units and independent assets cannot be imported");
      const { text, source } = this.inventory.get(unit.unitId),
        links = this.links(unit.unitId),
        available = new Set(links.map((l) => l.item_key));
      const proposals = (claims.get(unit.unitId) ?? []).filter(
        (c) =>
          c &&
          typeof c.content === "string" &&
          c.content.trim() &&
          typeof c.quote === "string" &&
          c.quote.trim(),
      );
      const context = [
        String(unit.metadata.context ?? unit.topic),
        unit.title,
      ].join("\n");
      const valid = proposals
        .filter(
          (c) =>
            text.includes(c.quote) &&
            !nativeTextSensitive(c.content) &&
            !nativeTextSensitive(c.quote),
        )
        .map((c) => ({ ...c, content: c.content.trim() }));
      plan.droppedQuotes += proposals.length - valid.length;
      const assigned = valid.map((c) => {
        const matches = links.filter(
          (l) => l.quote_hash === nativeHash(c.quote),
        );
        if (matches.length === 1 && available.delete(matches[0]!.item_key))
          return matches[0];
        return undefined;
      });
      // Unique unmatched rewrites retain their importer-owned identity. Splits or
      // many-to-many rewrites require conflict resolution, never duplicate writes.
      const unmatched = assigned.flatMap((v, i) => (v ? [] : [i])),
        remaining = links.filter((l) => available.has(l.item_key));
      if (unmatched.length === 1 && remaining.length === 1) {
        assigned[unmatched[0]!] = remaining[0];
        available.delete(remaining[0]!.item_key);
      }
      for (let i = 0; i < valid.length; i++) {
        const claim = valid[i]!,
          link = assigned[i],
          quoteHash = nativeHash(claim.quote),
          claimHash = hashClaim(claim.content);
        const item: NativeImportItem = {
          itemKey: link?.item_key ?? randomUUID(),
          unitId: unit.unitId,
          content: claim.content.trim(),
          claimHash,
          quoteHash,
          context,
          provenance: {
            locator: source.locator,
            sourceHash: source.sourceHash,
            quote: claim.quote,
            startLine:
              unit.startLine +
              text.slice(0, text.indexOf(claim.quote)).split("\n").length -
              1,
            endLine:
              unit.startLine +
              text
                .slice(0, text.indexOf(claim.quote) + claim.quote.length)
                .split("\n").length -
              1,
          },
          owner: this.proposedOwner(unit, claim.scope),
          ...(unit.scopes[0]
            ? {
                projectPath: unit.scopes[0].path,
                projectLabel: unit.scopes[0].label,
              }
            : {}),
          trust: source.trust,
          disposition: "new",
          flags: [
            ...(!unit.scopes.length ? ["unattributed" as const] : []),
            ...(nativeTextPersonal(claim.content) ||
            nativeTextPersonal(claim.quote)
              ? ["personal-info" as const]
              : []),
          ],
        };
        if (
          this.suppressed(item.content, quoteHash, item.owner, item.projectPath)
        ) {
          item.disposition = "suppressed";
          item.reason =
            "Rejected, revoked, or suppressed by scoped memory authority";
        } else if (link?.decision === "accepted") {
          const target = link.memory_id
            ? this.memory.store.getById(link.memory_id)
            : null;
          if (
            !target ||
            target.status !== "active" ||
            !!target.sessionId ||
            target.version !== link.version ||
            digest(target) !== link.digest ||
            this.eventSeq(target.id) !== link.event_seq
          ) {
            item.disposition = "conflict";
            item.reason = "Linked memory was independently changed";
          } else {
            item.disposition =
              item.claimHash === link.claim_hash &&
              sameOwner(target, item.owner)
                ? "unchanged"
                : "changed";
            item.target = {
              owner:
                target.scope === "project"
                  ? { scope: "project", projectId: target.projectId! }
                  : { scope: "personal" },
              memoryId: target.id,
              version: target.version,
              digest: digest(target),
            };
          }
        } else if (remaining.length && unmatched.length) {
          item.disposition = "conflict";
          item.reason = "Split or ambiguous rewrite of linked claims";
        } else {
          const matches = this.pool(item.owner).filter(
            (m) =>
              hashClaim(m.content) === claimHash &&
              (m.status === "active" || m.status === "candidate"),
          );
          if (
            matches.length > 1 ||
            matches[0]?.status === "candidate" ||
            matches[0]?.sensitive
          ) {
            item.disposition = "conflict";
            item.reason = "Multiple or pending/sensitive matches";
          } else if (matches[0]) {
            const target = matches[0];
            item.disposition = "exact-match";
            item.target = {
              memoryId: target.id,
              version: target.version,
              digest: digest(target),
            };
          }
        }
        if (valid.filter((c) => nativeHash(c.quote) === quoteHash).length > 1) {
          item.disposition = "conflict";
          item.reason = "Repeated quoted evidence";
        }
        plan.items.push(item);
      }
    }
    this.db
      .query(
        "INSERT INTO native_v2_operations(operation_id,request_hash,plan) VALUES(?,?,?)",
      )
      .run(id, requestHash, JSON.stringify(plan));
    return { plan };
  }
  private proposedOwner(unit: NativeMemoryUnit, scope: unknown): ProposalOwner {
    if (!unit.scopes.length || scope === "personal")
      return { scope: "personal" };
    return {
      scope: "project",
      ...(unit.scopes[0]!.projectId
        ? { projectId: unit.scopes[0]!.projectId }
        : {}),
    };
  }
  private commitChain: Promise<unknown> = Promise.resolve();
  commit(
    id: string,
    input: NativeImportCommitInput,
  ): Promise<NativeImportReceipt> {
    const run = this.commitChain.then(() => this.commitReviewed(id, input));
    this.commitChain = run.catch(() => {});
    return run;
  }
  private async commitReviewed(
    id: string,
    input: NativeImportCommitInput,
    restore?: RestoreCommit,
  ): Promise<NativeImportReceipt> {
    nativeOperationId(id);
    if (input?.approved !== true) bad("Explicit review approval is required");
    const approved = input.approvedItemKeys,
      rejected = input.rejectedItemKeys ?? [];
    if (
      !Array.isArray(approved) ||
      !Array.isArray(rejected) ||
      [...approved, ...rejected].some((k) => typeof k !== "string") ||
      new Set([...approved, ...rejected]).size !==
        approved.length + rejected.length
    )
      bad("Decisions must contain distinct item keys");
    const overrides =
      input.scopeOverrides === undefined ? {} : input.scopeOverrides;
    if (
      !overrides ||
      typeof overrides !== "object" ||
      Array.isArray(overrides) ||
      Object.values(overrides).some(
        (scope) => scope !== "personal" && scope !== "project",
      )
    )
      bad("Scope overrides must be personal or project");
    const commitHash = nativeHash(
      JSON.stringify([
        [...approved].sort(),
        [...rejected].sort(),
        ...(Object.keys(overrides).length
          ? [Object.entries(overrides).sort(([a], [b]) => a.localeCompare(b))]
          : []),
      ]),
    );
    const original = restore
      ? ({ plan: restore.plan } as NativeImportOperation)
      : this.getOperation(id);
    if (!original)
      throw new NativeMemoryError(404, "OPERATION_NOT_FOUND", "Plan not found");
    if (
      Object.keys(overrides).some(
        (key) => !original.plan.items.some((item) => item.itemKey === key),
      )
    )
      bad("Unknown scope override item key");
    const plan = structuredClone(original.plan);
    for (const item of plan.items) {
      if (restore) continue; // The saved rejection already records the reviewed final owner.
      const unit = plan.units.find((u) => u.unitId === item.unitId)!;
      const home = unit.scopes[0];
      // Plans saved before scope proposals must not retain the old personal fallback.
      const legacyProject = !!home && !item.projectPath;
      if (home) {
        item.projectPath = home.path;
        item.projectLabel = home.label;
      }
      const scope =
        overrides[item.itemKey] ??
        (legacyProject ? "project" : item.owner.scope);
      if (scope === "project" && !home)
        bad("A project override needs a verified project home");
      item.owner = this.proposedOwner(unit, scope);
    }
    const createdProjects: NativeImportReceipt["createdProjects"] = [];
    let result: NativeImportReceipt;
    try {
      // Validate IDs/source/decisions before any folder is opened, then recheck inside SQLite.
      if (
        [...approved, ...rejected].some(
          (key) => !plan.items.some((item) => item.itemKey === key),
        )
      )
        bad("Unknown item key");
      if (!original.receipt) {
        if (!restore) this.inventory.assertCurrent(plan.units);
        for (const item of plan.items.filter((item) =>
          approved.includes(item.itemKey),
        )) {
          if (
            ["conflict", "suppressed"].includes(item.disposition) &&
            !overrides[item.itemKey]
          )
            conflict("Resolve conflict or suppression before import");
          if (
            !restore &&
            this.suppressed(
              item.content,
              item.quoteHash,
              item.owner,
              item.projectPath,
            )
          )
            conflict("Resolve conflict or suppression before import");
          if (
            plan.items.filter(
              (other) =>
                other.unitId === item.unitId &&
                other.quoteHash === item.quoteHash,
            ).length > 1
          )
            conflict("Repeated quoted evidence");
        }
        const resolved = new Map<string, string>();
        for (const item of plan.items.filter(
          (item) =>
            approved.includes(item.itemKey) && item.owner.scope === "project",
        )) {
          const home = plan.units.find((u) => u.unitId === item.unitId)!
            .scopes[0]!;
          let projectId =
            resolved.get(home.path) ?? item.owner.projectId ?? home.projectId;
          if (!projectId) {
            if (!this.options.projectHomes)
              conflict("Project home creation is unavailable");
            const opened = await this.options.projectHomes!.open(
              home.path,
              home.label,
            );
            projectId = opened.projectId;
            if (!projectId) conflict("Project store returned no home");
            if (opened.created)
              createdProjects.push({ projectId, projectPath: home.path });
          }
          resolved.set(home.path, projectId!);
          item.owner = { scope: "project", projectId: projectId! };
        }
        // Rejections use the same resolved home without creating one on their own.
        for (const item of plan.items)
          if (
            item.owner.scope === "project" &&
            !item.owner.projectId &&
            item.projectPath &&
            resolved.has(item.projectPath)
          )
            item.owner = {
              scope: "project",
              projectId: resolved.get(item.projectPath)!,
            };
      }
      const revived = new Set<string>();
      result = this.db
        .transaction(() => {
          if (restore) {
            this.liftRemovals(restore.removals);
            for (const item of plan.items) {
              const memoryId = restore.revive.get(item.itemKey);
              if (!memoryId) continue;
              const memory = this.memory.store.update(
                memoryId,
                { status: "active" },
                { actor: "user" },
              );
              revived.add(memory.id);
              item.disposition = "exact-match";
              item.target = {
                memoryId: memory.id,
                version: memory.version,
                digest: digest(memory),
              };
            }
            this.db
              .query(
                `INSERT INTO native_v2_operations(operation_id,request_hash,plan,restore_hash) VALUES(?,?,?,?)`,
              )
              .run(
                id,
                restore.requestHash,
                JSON.stringify(plan),
                restore.requestHash,
              );
          }
          const operation = this.getOperation(id);
          if (!operation)
            throw new NativeMemoryError(
              404,
              "OPERATION_NOT_FOUND",
              "Plan not found",
            );
          if (operation.receipt) {
            const row = this.db
              .query(
                "SELECT commit_hash FROM native_v2_operations WHERE operation_id=?",
              )
              .get(id) as { commit_hash: string };
            if (row.commit_hash !== commitHash)
              conflict("Different decisions already committed");
            return operation.receipt;
          }
          if (
            [...approved, ...rejected].some(
              (k) => !plan.items.some((i) => i.itemKey === k),
            )
          )
            bad("Unknown item key");
          if (!restore) this.inventory.assertCurrent(plan.units);
          const receipt: NativeImportReceipt = {
            operationId: id,
            state: "committed",
            accepted: [],
            rejected,
            createdProjects,
          };
          const undo: Undo[] = [];
          for (const item of plan.items.filter((i) =>
            approved.includes(i.itemKey),
          )) {
            const reviewed = original.plan.items.find(
              (i) => i.itemKey === item.itemKey,
            )!;
            const moved =
              ownerKey(reviewed.owner, reviewed.projectPath) !==
              ownerKey(item.owner, item.projectPath);
            const acceptedLink = this.links(item.unitId).find(
              (l) => l.item_key === item.itemKey && l.decision === "accepted",
            );
            if (moved && !acceptedLink) {
              delete item.target;
              const matches = this.pool(item.owner).filter(
                (m) =>
                  hashClaim(m.content) === item.claimHash &&
                  ["active", "candidate"].includes(m.status),
              );
              item.disposition = "new";
              if (
                matches.length > 1 ||
                matches[0]?.status === "candidate" ||
                matches[0]?.sensitive
              )
                conflict(
                  "Multiple or pending/sensitive matches under final owner",
                );
              if (matches[0]) {
                item.disposition = "exact-match";
                item.target = {
                  memoryId: matches[0].id,
                  version: matches[0].version,
                  digest: digest(matches[0]),
                };
              }
            }
            if (
              (["conflict", "suppressed"].includes(item.disposition) &&
                !moved) ||
              this.suppressed(
                item.content,
                item.quoteHash,
                item.owner,
                item.projectPath,
              )
            )
              conflict("Resolve conflict or suppression before import");
            const link = this.links(item.unitId).find(
              (l) => l.item_key === item.itemKey && l.decision === "accepted",
            );
            if (
              reviewed.target &&
              reviewed.disposition !== "exact-match" &&
              !link
            )
              conflict("Mapping revoked after review");
            if (item.target) {
              const target = this.memory.store.getById(item.target.memoryId);
              if (
                !target ||
                target.status !== "active" ||
                !sameOwner(
                  target,
                  acceptedLink && reviewed.target
                    ? (reviewed.target.owner ?? reviewed.owner)
                    : item.owner,
                ) ||
                target.version !== item.target.version ||
                digest(target) !== item.target.digest ||
                (link &&
                  (link.memory_id !== target.id ||
                    link.event_seq !== this.eventSeq(target.id)))
              )
                conflict("Target changed after review");
              if (
                (item.disposition === "changed" || moved) &&
                this.db
                  .query(
                    "SELECT 1 FROM native_v2_links WHERE memory_id=? AND decision='accepted' AND NOT(unit_id=? AND item_key=?)",
                  )
                  .get(target!.id, item.unitId, item.itemKey)
              )
                conflict("Another unit also owns this target");
            } else if (
              link ||
              this.pool(item.owner).some(
                (m) => hashClaim(m.content) === item.claimHash,
              )
            )
              conflict("A memory or mapping appeared after review");
          }
          const createdDuringBatch = new Map<string, MemoryItem>();
          for (const item of plan.items) {
            const link = this.links(item.unitId).find(
              (l) => l.item_key === item.itemKey && l.decision === "accepted",
            );
            if (rejected.includes(item.itemKey)) {
              this.tombstone(item, id, "rejected");
              if (!link) this.writeLink(item, id, "rejected");
            }
            if (!approved.includes(item.itemKey)) continue;
            const batchKey = JSON.stringify([
              ownerKey(item.owner),
              item.claimHash,
            ]);
            const previous = item.target
              ? this.memory.store.getById(item.target.memoryId)!
              : createdDuringBatch.get(batchKey);
            const updated =
              item.disposition === "changed" ||
              (!!previous && !sameOwner(previous, item.owner));
            const target = updated
              ? this.memory.store.update(
                  previous!.id,
                  {
                    content: item.content,
                    scope: item.owner.scope,
                    projectId: item.owner.projectId,
                  },
                  { actor: "user" },
                )
              : (previous ??
                this.memory.store.create(
                  {
                    content: item.content,
                    scope: item.owner.scope,
                    projectId: item.owner.projectId,
                    type: "fact",
                    status: "active",
                    evidenceClass: "agent_proposed",
                  },
                  { actor: "user" },
                ));
            if (!previous) createdDuringBatch.set(batchKey, target);
            const owns = !link || updated;
            if (owns) {
              undo.push({
                itemKey: item.itemKey,
                ...(updated ? { memory: previous } : {}),
                ...(link ? { link } : {}),
              });
              this.writeLink(
                item,
                id,
                "accepted",
                target,
                !previous || revived.has(target.id),
              );
            }
            receipt.accepted.push({
              itemKey: item.itemKey,
              memoryId: target.id,
              // Reactivating an undone import is this operation's to archive again.
              created: !previous || revived.has(target.id),
              updated,
              mappingOwned: owns,
            });
          }
          for (const unit of restore ? [] : plan.units) {
            const unitItems = plan.items.filter(
              (i) => i.unitId === unit.unitId,
            );
            if (
              unitItems.length &&
              unitItems.every(
                (i) =>
                  approved.includes(i.itemKey) || rejected.includes(i.itemKey),
              )
            )
              this.inventory.markImported(
                unit,
                receipt.accepted
                  .filter((a) => unitItems.some((i) => i.itemKey === a.itemKey))
                  .map((a) => a.memoryId),
              );
          }
          this.db
            .query(
              "UPDATE native_v2_operations SET commit_hash=?,receipt=?,undo=?,plan=?,committed_at=? WHERE operation_id=?",
            )
            .run(
              commitHash,
              JSON.stringify(receipt),
              JSON.stringify(undo),
              JSON.stringify(plan),
              new Date().toISOString(),
              id,
            );
          if (restore)
            this.saveRestore(restore.requestHash, {
              mode: "import",
              removalIds: restore.removalIds,
              receipt,
            });
          return receipt;
        })
        .immediate();
    } catch (error) {
      const failures: unknown[] = [];
      for (const project of createdProjects.reverse()) {
        try {
          await this.options.projectHomes!.remove(project.projectId);
        } catch (cleanup) {
          failures.push(cleanup);
        }
      }
      if (failures.length)
        throw new NativeMemoryError(
          500,
          "PROJECT_CLEANUP_FAILED",
          "Import failed; a created project could not be removed",
        );
      throw error;
    }
    this.sync(id);
    return result;
  }
  private tombstone(
    item: NativeImportItem,
    id: string,
    decision: string,
  ): void {
    const removedAt = new Date().toISOString();
    for (const key of this.tombstoneKeys(item))
      for (const hash of [item.claimHash, item.quoteHash])
        this.db
          .query(
            "INSERT OR IGNORE INTO native_memory_tombstones(owner_key,claim_hash,decision,operation_id,removed_at) VALUES(?,?,?,?,?)",
          )
          .run(key, hash, decision, id, removedAt);
  }
  private tombstoneKeys(item: NativeImportItem): string[] {
    return [
      ...new Set([
        ownerKey(item.owner, item.projectPath),
        ...(item.owner.scope === "project" && item.projectPath
          ? [ownerKey({ scope: "project" }, item.projectPath)]
          : []),
      ]),
    ];
  }
  private writeLink(
    item: NativeImportItem,
    id: string,
    decision: string,
    memory?: MemoryItem,
    created = false,
  ): void {
    this.db
      .query(
        "INSERT OR REPLACE INTO native_v2_links VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        item.unitId,
        item.itemKey,
        item.quoteHash,
        item.claimHash,
        memory?.id ?? null,
        memory?.version ?? null,
        memory ? digest(memory) : null,
        memory ? this.eventSeq(memory.id) : null,
        id,
        decision,
        created ? 1 : 0,
      );
  }
  rollback(id: string, approved: boolean): NativeImportRollback {
    if (approved !== true) bad("Explicit review approval is required");
    const result = this.db
      .transaction(() => {
        const operation = this.getOperation(id);
        if (!operation?.receipt)
          throw new NativeMemoryError(
            404,
            "OPERATION_NOT_FOUND",
            "Committed import not found",
          );
        if (operation.rollback) return operation.rollback;
        const row = this.db
          .query("SELECT undo FROM native_v2_operations WHERE operation_id=?")
          .get(id) as { undo: string };
        const undo: Undo[] = JSON.parse(row.undo ?? "[]");
        const result: NativeImportRollback = {
          operationId: id,
          state: "rolled-back",
          archived: [],
          restored: [],
          conflicts: [],
        };
        for (const entry of operation.receipt.accepted.filter(
          (a) => a.mappingOwned,
        )) {
          const item = operation.plan.items.find(
              (i) => i.itemKey === entry.itemKey,
            )!,
            link = this.links(item.unitId).find(
              (l) => l.item_key === entry.itemKey,
            ),
            memory = this.memory.store.getById(entry.memoryId);
          const shared = this.db
            .query(
              "SELECT 1 FROM native_v2_links WHERE memory_id=? AND decision='accepted' AND NOT(unit_id=? AND item_key=?)",
            )
            .get(entry.memoryId, item.unitId, item.itemKey);
          if (
            !link ||
            link.operation_id !== id ||
            link.decision !== "accepted" ||
            !memory ||
            memory.status !== "active" ||
            !sameOwner(memory, item.owner) ||
            memory.version !== link.version ||
            digest(memory) !== link.digest ||
            this.eventSeq(memory.id) !== link.event_seq ||
            shared
          ) {
            result.conflicts.push({
              memoryId: entry.memoryId,
              reason:
                "Mapping or memory was edited, rescoped, revoked or shared",
            });
            continue;
          }
          const before = undo.find((u) => u.itemKey === entry.itemKey);
          if (entry.updated && before?.memory) {
            const restored = this.memory.store.update(
              memory.id,
              {
                content: before.memory.content,
                detail: before.memory.detail,
                scope: before.memory.scope,
                projectId: before.memory.projectId,
              },
              { actor: "user" },
            );
            result.restored.push(memory.id);
            if (before.link) {
              const old = before.link;
              this.db
                .query(
                  "INSERT OR REPLACE INTO native_v2_links VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                )
                .run(
                  old.unit_id,
                  old.item_key,
                  old.quote_hash,
                  old.claim_hash,
                  old.memory_id,
                  restored.version,
                  digest(restored),
                  this.eventSeq(restored.id),
                  old.operation_id,
                  old.decision,
                  old.created,
                );
            }
          } else {
            if (entry.created) {
              this.memory.store.archive(memory.id, { actor: "user" });
              result.archived.push(memory.id);
            }
            this.db
              .query(
                "UPDATE native_v2_links SET decision='revoked' WHERE unit_id=? AND item_key=?",
              )
              .run(item.unitId, item.itemKey);
          }
          // The claim moves to Removed; its source stays reviewed rather than pending again.
          this.tombstone(item, id, "revoked");
        }
        this.db
          .query(
            "UPDATE native_v2_operations SET rollback=? WHERE operation_id=?",
          )
          .run(JSON.stringify(result), id);
        return result;
      })
      .immediate();
    this.sync(id);
    return result;
  }
  private sync(id: string): void {
    const operation = this.getOperation(id)!;
    for (const projectId of new Set([
      ...operation.plan.units.map((u) => u.owner.projectId),
      ...operation.plan.items.map((i) => i.owner.projectId),
    ]))
      this.memory.syncProjection(projectId);
  }
}
