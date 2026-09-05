// Library checkup (redesign 2026-08-07 §3, step-one container 2). Three
// parallel LLM queries — conflicts / redundancy / staleness — each returning
// suggestions WITH a grounded one-line reason, followed by a merge pass that
// guarantees one row per memory and never silently drops a finding. The old
// numeric thresholds ("3 sessions quiet", "confirmed 3×") are demoted to
// loose shortlist filters: they decide who gets LOOKED AT, the model decides
// what to suggest, and the reason — not the number — is what the user sees.
//
// Proactive scope widening is retired. Step 2 keeps only the CONTENT problems
// of what is already saved.
//
// Result reuse is keyed on every input that can change a Checkup verdict:
// active memory identity/version/scope/reinforcement, quiet-shortlist
// membership, acknowledged relations, pending revisions, and (only while a
// staleness shortlist exists) today's date. Usage counters deliberately stay
// OUT — they move every turn, while a real use already changes quiet evidence.
import type { LlmJsonCaller } from './deepseek';
import type { MemoryService } from './index';
import type { MemoryItem } from './types';
import type { SessionClockEntry } from './maintenance';

export type CheckupKind = 'conflict' | 'redundancy' | 'staleness';

export interface CheckupSuggestion {
  kind: CheckupKind;
  memoryId: string;
  /** conflict/redundancy: the other half of the pair. */
  otherMemoryId?: string;
  /** One line, grounded in the item's text/evidence — this IS the suggestion's justification. */
  reason: string;
}

export interface CheckupResult {
  suggestions: CheckupSuggestion[];
  /** Legacy field name: true when a prior Checkup result was reused and no queries ran. */
  cached: boolean;
  /** Independent sidecar lanes that did not return a structurally valid result. */
  failedKinds?: CheckupKind[];
}

export interface CheckupContext {
  projectId?: string;
  sessionId?: string;
}

export interface CheckupForkPrompt {
  prompt: string;
  dependencyKey: string;
}

export interface CheckupService {
  /** True when `run` would actually fire queries — lets the gate show a skeleton only for real work. */
  needsRecompute(ctx: CheckupContext): boolean;
  run(ctx: CheckupContext): Promise<CheckupResult>;
  /**
   * Prewarm path (user decision 2026-08-08, option B): ONE combined
   * out-of-band question covering all three checks, asked on a fork of the
   * finished session at turn end — the trajectory context informs staleness
   * and conflict judgment, and the next gate can reuse the result. Null when
   * the pool is empty.
   */
  buildForkPrompt?(ctx: CheckupContext): CheckupForkPrompt | null;
  /** Validate + merge a fork reply for the exact dependency state that produced its prompt. */
  primeFromForkResult?(
    ctx: CheckupContext,
    dependencyKey: string,
    raw: Record<string, unknown>,
  ): Promise<CheckupResult | null>;
}

/** Loose shortlist floor — half the old hard threshold. */
const SHORTLIST_QUIET_SESSIONS = 2;
const REASON_MAX_LEN = 160;
const QUERY_TIMEOUT_MS = 60_000;
const RESULT_REUSE_MAX_ENTRIES = 20;
const MAX_DEPENDENCY_RETRIES = 1;

const CONFLICTS_SYSTEM = `You audit a developer's agent-memory library for CONTRADICTIONS. Given the \
items (id + scope + content), name pairs that give incompatible instructions or state incompatible \
facts — following both at once is impossible or incoherent. Only real contradictions; stylistic \
overlap is NOT a conflict. An empty list is the normal outcome.

Respond with strict JSON only: {"findings": [{"memoryId": "M-3", "otherMemoryId": "M-19", "reason": \
"<one short line grounded in both texts>"}, ...]}.`;

const REDUNDANCY_SYSTEM = `You audit a developer's agent-memory library for NEAR-DUPLICATES. Given the \
items (id + scope + content), name pairs that state the same fact or rule with no meaningful extra \
information in either — keeping both adds noise, merging loses nothing. Same-subject items that \
DIFFER in what they prescribe are not duplicates (that is a conflict, not your lane). An empty list \
is the normal outcome.

Respond with strict JSON only: {"findings": [{"memoryId": "M-3", "otherMemoryId": "M-19", "reason": \
"<one short line saying what both state>"}, ...]}.`;

const STALENESS_SYSTEM = `You audit a developer's agent-memory library for items that have likely \
STOPPED BEING TRUE OR USEFUL. You are given today's date and, per item: content, created date, \
usage evidence (times used, times re-confirmed, sessions since last reference). Flag an item only \
when its CONTENT argues for expiry — a time-bound fact past its window, a temporary circumstance \
that has clearly passed, a pointer to something the evidence says no longer exists. Low usage alone \
is NOT expiry: a rarely-needed but still-true fact must not be flagged. An empty list is the normal \
outcome.

Respond with strict JSON only: {"findings": [{"memoryId": "M-3", "reason": "<one short line citing \
the content/evidence>"}, ...]}.`;

const MERGE_SYSTEM = `You consolidate audit findings about a developer's memory library. Input: raw \
findings from three independent checks (conflict / redundancy / staleness); the same \
memory may appear in several. Output: final suggestion rows with EXACTLY ONE row per memoryId.

Rules: never drop a finding silently — when one memory drew several findings, either pick the \
primary suggestion and fold the others into the reason ("also flagged as …"), or state in the \
reason that the evidence points both ways and the user must decide. Keep every reason to one line. \
Keep kind/otherMemoryId values from the inputs; do not invent new ids.

Respond with strict JSON only: {"suggestions": [{"kind": "conflict" | "redundancy" | "staleness", \
"memoryId": "...", "otherMemoryId": "... or null", "reason": "..."}, ...]}.`;

const VALID_KINDS: readonly CheckupKind[] = ['conflict', 'redundancy', 'staleness'];

interface CheckupServiceOptions {
  memory: MemoryService;
  callJson: LlmJsonCaller;
  /** Session clock (same contract as maintenance): prior sessions with turns, newest first. */
  listRecentSessions: (projectId: string | undefined, excludeSessionId?: string) => SessionClockEntry[];
  /** Test hook: today's date for the staleness prompt. */
  now?: () => Date;
}

interface CheckupDependencySnapshot {
  key: string;
  pool: MemoryItem[];
  poolById: Map<string, MemoryItem>;
  quiet: Set<string>;
  quietItems: MemoryItem[];
  relatedPairs: Set<string>;
  openRevisionIds: Set<string>;
  today: string;
}

function itemLine(m: MemoryItem): string {
  return `[${m.id}] (${m.scope}) ${m.content}`;
}

function normalizeReason(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().slice(0, REASON_MAX_LEN) : '';
}

function normalizedPairKey(a: string, b: string): string {
  return [a, b].sort().join('~');
}

export function createCheckupService(opts: CheckupServiceOptions): CheckupService {
  const { memory, callJson, listRecentSessions } = opts;
  const now = opts.now ?? (() => new Date());
  const reusableResults = new Map<string, { key: string; suggestions: CheckupSuggestion[] }>();

  function activePool(ctx: CheckupContext): MemoryItem[] {
    return [
      ...memory.store.list({ scope: 'personal', status: 'active' }),
      ...(ctx.projectId ? memory.store.list({ scope: 'project', projectId: ctx.projectId, status: 'active' }) : []),
      ...(ctx.sessionId ? memory.store.list({ scope: 'session', sessionId: ctx.sessionId, status: 'active' }) : []),
    ];
  }

  /** Items unreferenced for the last SHORTLIST_QUIET_SESSIONS sessions (loose shortlist, not a verdict). */
  function quietShortlist(ctx: CheckupContext): Set<string> {
    const sessions = listRecentSessions(ctx.projectId, ctx.sessionId);
    if (sessions.length < SHORTLIST_QUIET_SESSIONS) return new Set();
    const boundary = sessions[SHORTLIST_QUIET_SESSIONS - 1]!.startedAt;
    return new Set(memory.store.listExpired({ boundaryTs: boundary, projectId: ctx.projectId }).map((m) => m.id));
  }

  function dependencySnapshot(ctx: CheckupContext): CheckupDependencySnapshot {
    const pool = activePool(ctx);
    const poolById = new Map(pool.map((item) => [item.id, item]));
    const quiet = quietShortlist(ctx);
    const quietItems = pool.filter((item) => quiet.has(item.id));
    const today = now().toISOString().slice(0, 10);
    const relatedPairs = new Set<string>();
    const relationFingerprint = new Set<string>();

    for (const item of pool) {
      for (const relation of memory.store.getRelations(item.id)) {
        if (!poolById.has(relation.targetId)) continue;
        relatedPairs.add(normalizedPairKey(item.id, relation.targetId));
        relationFingerprint.add(`${item.id}>${relation.type}>${relation.targetId}`);
      }
    }

    const openRevisionIds = new Set(pool.filter((item) => memory.store.hasOpenRevision(item.id)).map((item) => item.id));
    const key = JSON.stringify({
      projectId: ctx.projectId ?? '',
      sessionId: ctx.sessionId ?? '',
      items: pool
        .map((item) => ({
          id: item.id,
          version: item.version,
          scope: item.scope,
          reinforcedCount: item.reinforcedCount,
          quiet: quiet.has(item.id),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      relations: [...relationFingerprint].sort(),
      openRevisions: [...openRevisionIds].sort(),
      today: quietItems.length ? today : '',
    });

    return { key, pool, poolById, quiet, quietItems, relatedPairs, openRevisionIds, today };
  }

  /** Validate one pair-shaped finding list (conflict/redundancy). */
  function validatePairFindings(
    kind: CheckupKind,
    raw: Record<string, unknown>,
    snapshot: CheckupDependencySnapshot,
  ): CheckupSuggestion[] {
    // Lane completion is decided before this validator: a top-level
    // `findings` array means the call completed. Rows inside it remain
    // untrusted and may be dropped for malformed fields, unknown/stale ids,
    // acknowledged relations, open revisions, or duplication without
    // turning the entire lane into a transport/schema failure.
    const list = Array.isArray(raw.findings) ? (raw.findings as unknown[]) : [];
    const out: CheckupSuggestion[] = [];
    const seenPairs = new Set<string>();
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      const a = typeof rec.memoryId === 'string' ? rec.memoryId : '';
      const b = typeof rec.otherMemoryId === 'string' ? rec.otherMemoryId : '';
      const reason = normalizeReason(rec.reason);
      if (!a || !b || a === b || !snapshot.poolById.has(a) || !snapshot.poolById.has(b) || !reason) continue;
      const pairKey = normalizedPairKey(a, b);
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      // A direct acknowledged relation or a pending revision is already a
      // review lane. Both come from the same immutable dependency snapshot as
      // the prompt, so an in-flight mutation cannot rewrite old evidence.
      if (
        snapshot.relatedPairs.has(pairKey) ||
        snapshot.openRevisionIds.has(a) ||
        snapshot.openRevisionIds.has(b)
      ) continue;
      out.push({ kind, memoryId: a, otherMemoryId: b, reason });
    }
    return out;
  }

  /** Validate one per-item finding list (staleness). */
  function validateItemFindings(
    kind: CheckupKind,
    raw: Record<string, unknown>,
    allowed: Set<string>,
  ): CheckupSuggestion[] {
    const list = Array.isArray(raw.findings) ? (raw.findings as unknown[]) : [];
    const out: CheckupSuggestion[] = [];
    const seen = new Set<string>();
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      const id = typeof rec.memoryId === 'string' ? rec.memoryId : '';
      const reason = normalizeReason(rec.reason);
      if (!id || !allowed.has(id) || seen.has(id) || !reason) continue;
      seen.add(id);
      out.push({ kind, memoryId: id, reason });
    }
    return out;
  }

  /** Deterministic fallback merge: group by memoryId, first kind wins the row, extra reasons append. */
  function codeMerge(findings: CheckupSuggestion[]): CheckupSuggestion[] {
    const byId = new Map<string, CheckupSuggestion>();
    for (const f of findings) {
      const existing = byId.get(f.memoryId);
      if (!existing) {
        byId.set(f.memoryId, { ...f });
        continue;
      }
      existing.reason = `${existing.reason}; also flagged (${f.kind}): ${f.reason}`.slice(0, REASON_MAX_LEN * 2);
    }
    return [...byId.values()];
  }

  /** Model merge with a no-silent-drop guarantee; falls back to codeMerge. */
  async function mergeFindings(findings: CheckupSuggestion[]): Promise<CheckupSuggestion[]> {
    const ids = new Set(findings.map((f) => f.memoryId));
    const validatedTuples = new Set(
      findings.map((finding) => JSON.stringify([
        finding.memoryId,
        finding.kind,
        finding.otherMemoryId ?? null,
      ])),
    );
    const hasOverlap = ids.size < findings.length;
    if (!hasOverlap) return findings;
    try {
      const raw = await callJson({
        system: MERGE_SYSTEM,
        user: `Raw findings:\n${JSON.stringify(findings, null, 2)}`,
        timeoutMs: QUERY_TIMEOUT_MS,
      });
      const list = Array.isArray(raw.suggestions) ? (raw.suggestions as unknown[]) : [];
      const out: CheckupSuggestion[] = [];
      const seen = new Set<string>();
      for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue;
        const rec = entry as Record<string, unknown>;
        const id = typeof rec.memoryId === 'string' ? rec.memoryId : '';
        const kind = VALID_KINDS.includes(rec.kind as CheckupKind) ? (rec.kind as CheckupKind) : null;
        const reason = normalizeReason(rec.reason);
        const other = typeof rec.otherMemoryId === 'string' && rec.otherMemoryId ? rec.otherMemoryId : undefined;
        const tuple = JSON.stringify([id, kind, other ?? null]);
        // The merge model may consolidate reasons, but it cannot invent a new
        // actionable pair or change the finding kind. Only tuples already
        // accepted by the snapshot validator are eligible for the final row.
        if (!id || !kind || !reason || !ids.has(id) || seen.has(id) || !validatedTuples.has(tuple)) continue;
        seen.add(id);
        out.push({ kind, memoryId: id, ...(other ? { otherMemoryId: other } : {}), reason });
      }
      // Coverage guarantee: any memory the model dropped gets its original
      // finding(s) back through the deterministic merge.
      const covered = new Set(out.map((s) => s.memoryId));
      const dropped = findings.filter((f) => !covered.has(f.memoryId));
      return [...out, ...codeMerge(dropped)];
    } catch {
      return codeMerge(findings);
    }
  }

  const evidenceLineFor = (m: MemoryItem, quiet: Set<string>) =>
    `[${m.id}] (${m.scope}, created ${m.createdAt.slice(0, 10)}, used ${m.usageCount}×, re-confirmed ` +
    `${m.reinforcedCount}×${quiet.has(m.id) ? `, no reference in the last ${SHORTLIST_QUIET_SESSIONS}+ sessions` : ''}) ${m.content}`;

  function resultSlot(ctx: CheckupContext): string {
    return `${ctx.projectId ?? ''}#${ctx.sessionId ?? ''}`;
  }

  /** Store only a result whose prompt/validation snapshot is still current. */
  function storeReusableResult(ctx: CheckupContext, key: string, suggestions: CheckupSuggestion[]): void {
    const slot = resultSlot(ctx);
    reusableResults.set(slot, { key, suggestions });
    if (reusableResults.size > RESULT_REUSE_MAX_ENTRIES) {
      const oldest = reusableResults.keys().next().value;
      if (oldest !== undefined) reusableResults.delete(oldest);
    }
  }

  function dependencyIsCurrent(ctx: CheckupContext, key: string): boolean {
    return dependencySnapshot(ctx).key === key;
  }

  async function analyzeSnapshot(snapshot: CheckupDependencySnapshot): Promise<{
    findings: CheckupSuggestion[];
    failedKinds: CheckupKind[];
  }> {
    const poolText = snapshot.pool.map(itemLine).join('\n');
    const quietIds = new Set(snapshot.quietItems.map((item) => item.id));

    type LaneResult = { suggestions: CheckupSuggestion[]; failedKind?: CheckupKind };
    const runPairLane = async (
      kind: 'conflict' | 'redundancy',
      system: string,
    ): Promise<LaneResult> => {
      try {
        const raw = await callJson({ system, user: `Library:\n${poolText}`, timeoutMs: QUERY_TIMEOUT_MS });
        if (!Array.isArray(raw.findings)) return { suggestions: [], failedKind: kind };
        return { suggestions: validatePairFindings(kind, raw, snapshot) };
      } catch {
        return { suggestions: [], failedKind: kind };
      }
    };
    const runStalenessLane = async (): Promise<LaneResult> => {
      if (!snapshot.quietItems.length) return { suggestions: [] };
      try {
        const raw = await callJson({
          system: STALENESS_SYSTEM,
          user: `Today: ${snapshot.today}\n\nItems:\n${snapshot.quietItems.map((item) => evidenceLineFor(item, snapshot.quiet)).join('\n')}`,
          timeoutMs: QUERY_TIMEOUT_MS,
        });
        if (!Array.isArray(raw.findings)) return { suggestions: [], failedKind: 'staleness' };
        return { suggestions: validateItemFindings('staleness', raw, quietIds) };
      } catch {
        return { suggestions: [], failedKind: 'staleness' };
      }
    };

    // Independent sidecars stay concurrent. A failed lane contributes no
    // untrusted rows, but its failure remains explicit so successful lanes
    // can still be reviewed without turning an incomplete audit into a clear.
    const lanes = await Promise.all([
      runPairLane('conflict', CONFLICTS_SYSTEM),
      runPairLane('redundancy', REDUNDANCY_SYSTEM),
      runStalenessLane(),
    ]);

    return {
      findings: lanes.flatMap((lane) => lane.suggestions),
      failedKinds: lanes.flatMap((lane) => lane.failedKind ? [lane.failedKind] : []),
    };
  }

  return {
    buildForkPrompt(ctx: CheckupContext): CheckupForkPrompt | null {
      const snapshot = dependencySnapshot(ctx);
      if (snapshot.pool.length === 0) return null;
      const prompt = [
        'OUT-OF-BAND MEMORY LIBRARY CHECKUP — not part of the task above; your answer is never shown in the conversation. Use the full working context above to judge.',
        '',
        "Audit the developer's saved memory library below in THREE ways:",
        '1. "conflicts": pairs giving incompatible instructions or facts — following both at once is impossible. Only real contradictions; stylistic overlap is not a conflict.',
        '2. "redundancy": pairs stating the same fact or rule with no meaningful extra information in either. Same-subject items that DIFFER in what they prescribe are conflicts, not duplicates.',
        '3. "staleness": STALENESS-SHORTLIST items whose CONTENT has likely stopped being true or useful — time-bound facts past their window, circumstances the context above shows have passed, pointers to things that no longer exist. Low usage alone is NOT staleness.',
        '',
        `Library:\n${snapshot.pool.map(itemLine).join('\n')}`,
        '',
        `STALENESS SHORTLIST (today: ${snapshot.today}):\n${snapshot.quietItems.length ? snapshot.quietItems.map((item) => evidenceLineFor(item, snapshot.quiet)).join('\n') : '(none — return an empty staleness list)'}`,
        '',
        'Every reason: one short line grounded in the item text, evidence, or context. Empty lists are the normal outcome.',
        'Respond with STRICT JSON only — no prose before or after: {"conflicts":[{"memoryId":"M-3","otherMemoryId":"M-19","reason":"…"}],"redundancy":[{"memoryId":"M-3","otherMemoryId":"M-19","reason":"…"}],"staleness":[{"memoryId":"M-3","reason":"…"}]}',
      ].join('\n');
      return { prompt, dependencyKey: snapshot.key };
    },

    async primeFromForkResult(
      ctx: CheckupContext,
      dependencyKey: string,
      raw: Record<string, unknown>,
    ): Promise<CheckupResult | null> {
      const snapshot = dependencySnapshot(ctx);
      if (snapshot.pool.length === 0 || snapshot.key !== dependencyKey) return null;
      // The combined fork is complete only when every requested lane is
      // present. A partial reply must fall back to the independent sidecars;
      // treating a missing lane as empty would create a reusable false-clear.
      const keys = ['conflicts', 'redundancy', 'staleness'] as const;
      if (!keys.every((key) => Array.isArray(raw[key]))) return null;
      const findings: CheckupSuggestion[] = [
        ...validatePairFindings('conflict', { findings: raw.conflicts }, snapshot),
        ...validatePairFindings('redundancy', { findings: raw.redundancy }, snapshot),
        ...validateItemFindings('staleness', { findings: raw.staleness }, new Set(snapshot.quietItems.map((item) => item.id))),
      ];
      const merged = await mergeFindings(findings);
      if (!dependencyIsCurrent(ctx, dependencyKey)) return null;
      storeReusableResult(ctx, dependencyKey, merged);
      return { suggestions: merged, cached: false };
    },

    needsRecompute(ctx: CheckupContext): boolean {
      const snapshot = dependencySnapshot(ctx);
      if (snapshot.pool.length === 0) return false;
      const reused = reusableResults.get(resultSlot(ctx));
      return !reused || reused.key !== snapshot.key;
    },

    async run(ctx: CheckupContext): Promise<CheckupResult> {
      for (let attempt = 0; attempt <= MAX_DEPENDENCY_RETRIES; attempt += 1) {
        const snapshot = dependencySnapshot(ctx);
        if (snapshot.pool.length === 0) return { suggestions: [], cached: false };
        const reused = reusableResults.get(resultSlot(ctx));
        if (reused && reused.key === snapshot.key) {
          return { suggestions: reused.suggestions, cached: true };
        }

        const analysis = await analyzeSnapshot(snapshot);
        if (!dependencyIsCurrent(ctx, snapshot.key)) continue;
        const merged = await mergeFindings(analysis.findings);
        if (!dependencyIsCurrent(ctx, snapshot.key)) continue;

        // The result slot represents the complete three-lane verdict for one
        // dependency snapshot. Saving a partial answer there would prevent
        // the failed lanes from retrying on the next gate.
        if (analysis.failedKinds.length === 0) {
          storeReusableResult(ctx, snapshot.key, merged);
          return { suggestions: merged, cached: false };
        }
        return { suggestions: merged, cached: false, failedKinds: analysis.failedKinds };
      }

      throw new Error('Memory Checkup inputs changed repeatedly while analysis was running');
    },
  };
}
