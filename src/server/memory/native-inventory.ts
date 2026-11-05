import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  NATIVE_MEMORY_POLICY,
  type NativeInventoryInput,
  type NativeInventoryResult,
  type NativeMemorySource,
  type NativeMemoryUnit,
  type NativeParseAnomaly,
  type NativeUnitSource,
} from "../../shared/native-memory";
import {
  NativeMemoryDiscovery,
  NativeMemoryError,
  nativeHash,
  screenedNativeText,
} from "./native-discovery";
import {
  claudeProjectPaths,
  nativeSourceLinks,
  parseNativeUnits,
  parseRawEntries,
  parseRolloutHeader,
} from "./native-parsers";

interface StoredSource {
  manifest: string;
  text: string;
  pending_hash: string | null;
  pending_at: number | null;
}
/** What an import saw: a later correction changes the meaning of unchanged text. */
const importFingerprint = (unit: Pick<NativeMemoryUnit, "contentHash" | "correctionHash">) =>
  nativeHash(JSON.stringify([unit.contentHash, unit.correctionHash]));

export class NativeInventory {
  constructor(
    readonly db: Database,
    readonly discovery: NativeMemoryDiscovery,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS native_v2_sources(source_id TEXT PRIMARY KEY, manifest TEXT NOT NULL, text TEXT NOT NULL, pending_hash TEXT, pending_at INTEGER);
      CREATE TABLE IF NOT EXISTS native_v2_units(unit_id TEXT PRIMARY KEY, manifest TEXT NOT NULL, text TEXT NOT NULL, last_imported_hash TEXT);
      CREATE INDEX IF NOT EXISTS native_v2_unit_source ON native_v2_units(json_extract(manifest,'$.sourceId'));`);
  }
  private allowed(unit: NativeMemoryUnit): boolean {
    const source = this.source(unit.sourceId);
    const roots = this.discovery.allowedRoots();
    return (
      !!source &&
      roots.some(
        (r) =>
          r.id === source.rootId &&
          JSON.stringify(r.owner) === JSON.stringify(source.owner),
      ) &&
      (unit.owner.scope === "personal" ||
        roots.some(
          (r) =>
            r.owner.projectId === unit.owner.projectId &&
            unit.scopes.some(
              (s) => s.projectId === r.owner.projectId && s.path === r.path,
            ),
        ))
    );
  }
  source(id: string): NativeMemorySource | null {
    const row = this.db
      .query("SELECT manifest FROM native_v2_sources WHERE source_id=?")
      .get(id) as { manifest: string } | null;
    return row ? JSON.parse(row.manifest) : null;
  }
  units(): NativeMemoryUnit[] {
    return (
      this.db
        .query("SELECT manifest,last_imported_hash FROM native_v2_units")
        .all() as Array<{ manifest: string; last_imported_hash: string | null }>
    ).map((row) => ({
      ...JSON.parse(row.manifest),
      ...(row.last_imported_hash
        ? { lastImportedHash: row.last_imported_hash }
        : {}),
    }));
  }
  get(id: string): NativeUnitSource {
    const row = this.db
      .query(
        "SELECT manifest,text,last_imported_hash FROM native_v2_units WHERE unit_id=?",
      )
      .get(id) as {
      manifest: string;
      text: string;
      last_imported_hash: string | null;
    } | null;
    if (!row)
      throw new NativeMemoryError(
        404,
        "UNIT_NOT_FOUND",
        "Inventory the unit first",
      );
    const unit: NativeMemoryUnit = {
      ...JSON.parse(row.manifest),
      ...(row.last_imported_hash
        ? { lastImportedHash: row.last_imported_hash }
        : {}),
    };
    if (!this.allowed(unit))
      throw new NativeMemoryError(
        409,
        "SOURCE_UNAVAILABLE",
        "Unit root is no longer allowed",
      );
    const source = this.source(unit.sourceId)!;
    const corrections = unit.correctionSourceIds.flatMap((sourceId) => {
      const row = this.db
        .query("SELECT text FROM native_v2_sources WHERE source_id=?")
        .get(sourceId) as { text: string } | null;
      return row ? [{ sourceId, text: row.text }] : [];
    });
    return { unit, source, text: row.text, corrections };
  }
  assertCurrent(units: NativeMemoryUnit[]): void {
    const checked = new Set<string>();
    for (const unit of units) {
      const current = this.get(unit.unitId);
      if (
        current.unit.change === "removed" ||
        current.unit.contentHash !== unit.contentHash ||
        current.unit.parserVersion !== unit.parserVersion ||
        current.unit.correctionHash !== unit.correctionHash ||
        JSON.stringify(current.unit.owner) !== JSON.stringify(unit.owner)
      )
        throw new NativeMemoryError(
          409,
          "SOURCE_CHANGED",
          "Unit changed; refresh inventory and review again",
        );
      for (const source of [
        current.source,
        ...current.corrections.map((c) => this.source(c.sourceId)!),
      ]) {
        if (checked.has(source.sourceId)) continue;
        checked.add(source.sourceId);
        if (nativeHash(this.discovery.readSource(source)) !== source.sourceHash)
          throw new NativeMemoryError(
            409,
            "SOURCE_CHANGED",
            "Source changed or is being consolidated",
          );
      }
    }
  }
  read(input: NativeInventoryInput = {}): NativeInventoryResult {
    const roots = this.discovery.allowedRoots();
    if (
      !input ||
      (input.rootIds !== undefined &&
        (!Array.isArray(input.rootIds) ||
          input.rootIds.some((id) => typeof id !== "string")))
    )
      throw new NativeMemoryError(
        400,
        "BAD_REQUEST",
        "Expected allowed root IDs",
      );
    const ids = [...(input.rootIds ?? roots.map((r) => r.id))];
    // HOME is scanned first so project roots don't steal the namespace's identity.
    ids.sort(
      (a, b) =>
        Number(roots.find((r) => r.id === a)?.owner.scope !== "personal") -
        Number(roots.find((r) => r.id === b)?.owner.scope !== "personal"),
    );
    const found = this.discovery.discover(ids),
      second = this.discovery.discover(ids);
    const anomalies: NativeParseAnomaly[] = [],
      paths = claudeProjectPaths(
        this.discovery.homeDir,
        roots,
        this.discovery.claudeConfigDir,
      );
    const previousUnits = this.units(),
      accepted: Array<{ source: NativeMemorySource; text: string }> = [];
    const retained = new Set<string>();
    this.db.transaction(() => {
      for (let source of found.sources) {
        const raw = found.texts.get(source.sourceId)!;
        const secondSource = second.sources.find(
          (s) => s.sourceId === source.sourceId,
        );
        const previous = this.db
          .query("SELECT * FROM native_v2_sources WHERE source_id=?")
          .get(source.sourceId) as StoredSource | null;
        const old: NativeMemorySource | undefined = previous
          ? JSON.parse(previous.manifest)
          : undefined;
        const incomplete =
          !secondSource ||
          secondSource.sourceHash !== source.sourceHash ||
          (old && old.bytes > 0 && !raw.trim());
        // A stable shrink is accepted only after a later observation; an empty file never erases accepted units.
        const shrinking =
          old &&
          source.bytes < old.bytes &&
          source.sourceHash !== old.sourceHash;
        if (
          incomplete ||
          (shrinking &&
            !(
              previous?.pending_hash === source.sourceHash &&
              Date.now() - (previous.pending_at ?? Date.now()) >= 1000
            ))
        ) {
          anomalies.push({
            locator: source.locator,
            code: incomplete
              ? "unstable-read-retained"
              : "shrink-awaiting-confirmation",
          });
          if (old && previous) {
            retained.add(source.sourceId);
            accepted.push({ source: old, text: previous.text });
            if (!incomplete)
              this.db
                .query(
                  "UPDATE native_v2_sources SET pending_hash=?,pending_at=CASE WHEN pending_hash=? THEN pending_at ELSE ? END WHERE source_id=?",
                )
                .run(
                  source.sourceHash,
                  source.sourceHash,
                  Date.now(),
                  source.sourceId,
                );
          }
          continue;
        }
        source = {
          ...source,
          sourceVersion: old
            ? old.sourceVersion + Number(old.sourceHash !== source.sourceHash)
            : 1,
        };
        const text = screenedNativeText(raw);
        this.db
          .query(
            "INSERT INTO native_v2_sources(source_id,manifest,text) VALUES(?,?,?) ON CONFLICT(source_id) DO UPDATE SET manifest=excluded.manifest,text=excluded.text,pending_hash=NULL,pending_at=NULL",
          )
          .run(source.sourceId, JSON.stringify(source), text);
        accepted.push({ source, text: raw });
      }
      const sources = accepted.map((s) => s.source),
        byPath = new Map(sources.map((s) => [s.locator, s]));
      for (const entry of accepted)
        for (const path of nativeSourceLinks(entry.source, entry.text)) {
          const child = byPath.get(path);
          if (child === entry.source) continue;
          if (
            child &&
            child !== entry.source &&
            child.namespace === entry.source.namespace
          ) {
            child.indexedBy ??= [];
            child.indexedBy.push(entry.source.locator);
          } else if (
            entry.source.role === "navigation" &&
            path.startsWith(entry.source.memoryRoot ?? "\0")
          )
            anomalies.push({
              locator: entry.source.locator,
              code: "missing-index-reference",
            });
        }
      const fresh = accepted.flatMap(({ source, text }) =>
        retained.has(source.sourceId)
          ? previousUnits
              .filter((u) => u.sourceId === source.sourceId)
              .map((unit) => ({ unit, text: this.get(unit.unitId).text }))
          : parseNativeUnits(source, text, roots, paths, anomalies),
      );
      const freshIds = new Set(fresh.map((p) => p.unit.unitId)),
        usedOld = new Set<string>();
      for (const parsed of fresh) {
        let previous = previousUnits.find(
          (u) => u.unitId === parsed.unit.unitId,
        );
        if (!previous) {
          const matches = previousUnits.filter(
            (u) =>
              !freshIds.has(u.unitId) &&
              !usedOld.has(u.unitId) &&
              u.engine === parsed.unit.engine &&
              u.namespace === parsed.unit.namespace &&
              JSON.stringify(u.owner) === JSON.stringify(parsed.unit.owner) &&
              u.contentHash === parsed.unit.contentHash,
          );
          if (matches.length === 1) {
            previous = matches[0];
            parsed.unit.unitId = previous!.unitId;
            usedOld.add(previous!.unitId);
          }
        }
        if (!previous) {
          const fingerprint = (text: string) =>
            nativeHash(text.replace(/^#{1,6}[^\n]*(?:\n|$)/, "").trim());
          const candidates = previousUnits.filter(
            (old) =>
              !freshIds.has(old.unitId) &&
              !usedOld.has(old.unitId) &&
              old.sourceId === parsed.unit.sourceId &&
              JSON.stringify(old.owner) === JSON.stringify(parsed.unit.owner) &&
              fingerprint(this.get(old.unitId).text) ===
                fingerprint(parsed.text),
          );
          if (candidates.length === 1) {
            previous = candidates[0];
            parsed.unit.unitId = previous!.unitId;
            usedOld.add(previous!.unitId);
          } else if (candidates.length > 1)
            anomalies.push({
              locator: this.source(parsed.unit.sourceId)!.locator,
              code: "ambiguous-unit-lineage",
            });
        }
        const corrections = sources.filter(
          (s) =>
            s.role === "correction" &&
            s.engine === parsed.unit.engine &&
            s.namespace === parsed.unit.namespace,
        );
        parsed.unit.correctionSourceIds = corrections.map((s) => s.sourceId);
        parsed.unit.correctionHash = nativeHash(
          JSON.stringify(corrections.map((s) => [s.sourceId, s.sourceHash])),
        );
        // Measured against the last import, not the last scan: opening the
        // dialog must never turn something unimported into "up to date".
        // A unit re-suggested from Removed reads as new until it is reviewed again.
        parsed.unit.change = !previous?.lastImportedHash ||
          previous.lastImportedHash.startsWith("restore:")
          ? "new"
          : previous.lastImportedHash === importFingerprint(parsed.unit)
            ? "unchanged"
            : "changed";
        parsed.unit.linkedMemoryIds = previous?.linkedMemoryIds ?? [];
        this.db
          .query(
            "INSERT INTO native_v2_units(unit_id,manifest,text) VALUES(?,?,?) ON CONFLICT(unit_id) DO UPDATE SET manifest=excluded.manifest,text=excluded.text",
          )
          .run(parsed.unit.unitId, JSON.stringify(parsed.unit), parsed.text);
      }
      const nowIds = new Set(fresh.map((p) => p.unit.unitId));
      for (const old of previousUnits) {
        if (nowIds.has(old.unitId)) continue;
        const source = this.source(old.sourceId);
        if (!source || !ids.includes(source.rootId)) continue;
        const skipped = [...found.skippedEntries, ...second.skippedEntries];
        if (
          skipped.some(
            (e) =>
              source.locator === e.path ||
              source.locator.startsWith(e.path + "/"),
          )
        ) {
          anomalies.push({
            locator: source.locator,
            code: "unavailable-source-retained",
          });
          continue;
        }
        if (
          !second.sources.some((s) => s.sourceId === old.sourceId) ||
          accepted.some((s) => s.source.sourceId === old.sourceId)
        ) {
          old.change = "removed";
          this.db
            .query("UPDATE native_v2_units SET manifest=? WHERE unit_id=?")
            .run(JSON.stringify(old), old.unitId);
        }
      }
      // Validate evidence joins including historical raw bodies, without importing them.
      for (const { source, text } of accepted.filter(
        (s) => s.source.role === "evidence",
      )) {
        if (source.relativePath === "raw_memories.md") {
          const entries = parseRawEntries(text);
          if (text.trim() && !entries.length)
            anomalies.push({
              locator: source.locator,
              code: "raw-header-unrecognized",
            });
          for (const entry of entries) {
            if (entry.anomaly)
              anomalies.push({ locator: source.locator, code: entry.anomaly });
            const summary = accepted.find(
              (s) =>
                s.source.namespace === source.namespace &&
                s.source.relativePath ===
                  `rollout_summaries/${entry.metadata.rollout_summary_file}`,
            );
            if (
              summary &&
              parseRolloutHeader(summary.text).metadata.thread_id !==
                entry.threadId
            )
              anomalies.push({
                locator: source.locator,
                code: "raw-rollout-thread-mismatch",
              });
          }
        } else if (!parseRolloutHeader(text).valid)
          anomalies.push({
            locator: source.locator,
            code: "malformed-evidence-header",
          });
      }
      for (const source of sources)
        this.db
          .query("UPDATE native_v2_sources SET manifest=? WHERE source_id=?")
          .run(JSON.stringify(source), source.sourceId);
    })();
    const sources = accepted.map((s) => s.source),
      units = this.units().filter((u) => {
        const s = this.source(u.sourceId);
        return s && ids.includes(s.rootId);
      });
    const counts = { new: 0, changed: 0, unchanged: 0, removed: 0 };
    const groups = new Map<string, NativeInventoryResult["groups"][number]>();
    for (const unit of units) {
      counts[unit.change]++;
      const key = JSON.stringify([
        unit.engine,
        unit.namespace,
        unit.projectLabel,
      ]);
      const group = groups.get(key) ?? {
        engine: unit.engine,
        namespace: unit.namespace,
        projectLabel: unit.projectLabel,
        projectIds: [
          ...new Set(
            unit.scopes.flatMap((s) => (s.projectId ? [s.projectId] : [])),
          ),
        ],
        unitIds: [],
        counts: { new: 0, changed: 0, unchanged: 0, removed: 0 },
        estimatedTokens: 0,
      };
      group.unitIds.push(unit.unitId);
      group.counts[unit.change]++;
      if (unit.change !== "removed")
        group.estimatedTokens += unit.estimatedTokens;
      groups.set(key, group);
    }
    let version: string | null = existsSync(
        join(this.discovery.codexHome, "memories"),
      )
        ? "v1"
        : null,
      reason = version
        ? "Native default preserves the existing v1 profile; per-session overrides are unknown"
        : "No explicit default namespace established; directory presence alone is insufficient";
    try {
      const config = readFileSync(
        join(this.discovery.codexHome, "config.toml"),
        "utf8",
      );
      const match =
        /^\s*(?:memory_version|version)\s*=\s*["'](v[12])["']/m.exec(
          config.match(/\[memories\]([\s\S]*?)(?=\n\[|$)/)?.[1] ?? "",
        );
      if (match) {
        version = match[1]!;
        reason = "Explicit native memories configuration";
      }
    } catch {}
    const namespaces = [
      ...new Set(
        sources
          .filter((s) => s.kind === "native-memory")
          .map((s) => JSON.stringify([s.engine, s.namespace])),
      ),
    ].map((key) => {
      const [engine, namespace] = JSON.parse(key);
      return {
        engine,
        namespace,
        active: engine === "codex" && version ? namespace === version : null,
        activeReason:
          engine === "codex" ? reason : "Project or agent scoped namespace",
        selectedByDefault: namespace !== "v2",
      };
    });
    return {
      roots,
      sources,
      units,
      namespaces,
      groups: [...groups.values()],
      counts,
      estimatedTokens: units
        .filter((u) => u.change !== "removed")
        .reduce((n, u) => n + u.estimatedTokens, 0),
      anomalies,
      skippedEntries: found.skippedEntries,
      policy: NATIVE_MEMORY_POLICY,
    };
  }
  markImported(unit: NativeMemoryUnit, ids: string[]): void {
    const current = this.get(unit.unitId).unit;
    current.linkedMemoryIds = [
      ...new Set([...current.linkedMemoryIds, ...ids]),
    ];
    this.db
      .query(
        "UPDATE native_v2_units SET manifest=?,last_imported_hash=? WHERE unit_id=?",
      )
      .run(JSON.stringify(current), importFingerprint(unit), unit.unitId);
  }
  navigation(
    unitIds: string[],
  ): Array<{ source: NativeMemorySource; text: string }> {
    const units = unitIds.map((id) => this.get(id).unit),
      namespaces = new Set(units.map((u) => `${u.engine}:${u.namespace}`));
    return (
      this.db
        .query("SELECT manifest,text FROM native_v2_sources")
        .all() as Array<{ manifest: string; text: string }>
    )
      .map((row) => ({
        source: JSON.parse(row.manifest) as NativeMemorySource,
        text: row.text,
      }))
      .filter(
        (row) =>
          row.source.role === "navigation" &&
          namespaces.has(`${row.source.engine}:${row.source.namespace}`) &&
          this.discovery.allowedRoots().some((r) => r.id === row.source.rootId),
      );
  }
  evidence(
    unit: NativeMemoryUnit,
    threadIds: string[],
  ): Array<{ threadId: string; text: string }> {
    const rows = this.db
      .query("SELECT manifest,text FROM native_v2_sources")
      .all() as Array<{ manifest: string; text: string }>;
    return rows.flatMap((row) => {
      const source: NativeMemorySource = JSON.parse(row.manifest),
        header = parseRolloutHeader(row.text);
      return source.engine === unit.engine &&
        source.namespace === unit.namespace &&
        source.relativePath?.startsWith("rollout_summaries/") &&
        header.valid &&
        threadIds.includes(header.metadata.thread_id!) &&
        unit.evidenceThreadIds.includes(header.metadata.thread_id!)
        ? [{ threadId: header.metadata.thread_id!, text: row.text }]
        : [];
    });
  }
}
