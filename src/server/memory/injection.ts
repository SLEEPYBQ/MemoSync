// planMemoryInjection — the single source of truth for what a study arm
// injects into an engine session (STUDY_PLAN §2.2/§2.3).
//
// REDESIGN 2026-08-04 (docs/MEMORY_REDESIGN_PLAN_2026-08-04.md, D1):
// - skills mode (memosync arm, Claude): the plan's block is a BOOT block
//   (rules + versioned snapshot) baked once per session; later changes ride
//   user turns as delta blocks (computeMemoryTurnDelta below). The Claude
//   coordinator therefore no longer rebuilds sessions on memory content
//   changes — only on mode/tools flips (see startClaudeTurn).
// - plain/file modes (auto/static arms) keep their boot snapshot and content-
//   change rebuild contract, and the same plan block is repeated as TEXT on
//   every Claude turn because the baseline treatment focuses the full set.
// - Codex passes the full block per turn (developer_instructions), so it is
//   unaffected by the delta model.
import type { ConditionPolicy } from '../experiment/condition';
import type { AgentProvider } from '../../shared/types';
import type { MemoryService } from './index';
import type { MemoryItem } from './types';
import {
  buildMemoryBlock,
  buildMemoryDeltaBlock,
  buildPlainMemoryBlock,
  formatMemoryLine,
  type MemoryConflictPair,
  type MemoryDeltaEntry,
} from './prompt';
import {
  buildStudyStaticFocusPayload,
  buildStaticFocusPayload,
  ensureStaticMemoryScaffold,
  hashStaticMemoryFiles,
  readStaticMemoryFiles,
  readStudyStaticMemoryFiles,
  type StaticFocusPayload,
} from './static-files';

export interface MemoryInjectionPlan {
  mode: 'skills' | 'plain' | 'file';
  /** Exact text block: boot context in every mode and per-turn focus in plain/file modes. */
  block: string;
  /** Whether the load_memory_detail tool should be registered. */
  registerTools: boolean;
  /** Items in play for the turn (per-turn restriction applied) — logging, preview, trace. */
  injectedMemories: MemoryItem[];
  /**
   * Items actually baked into `block` ([] in file mode). In skills mode this is
   * the FULL set even under a per-turn restriction — it seeds the delta
   * baseline, which must mirror what the context really contains.
   */
  bakedMemories: MemoryItem[];
  /** Workspace-relative paths backing a file-mode block ([] otherwise). */
  staticFiles: string[];
  /** Exact immutable text + participant-controlled slices for Static measurement only. */
  staticPayload: StaticFocusPayload | null;
  /**
   * Fingerprint of the injectable state. For plain/file modes a change requires
   * an engine-session rebuild. For skills mode the CONTENT no longer forces a
   * rebuild (deltas carry it) — consumers should use `sessionRebuildKey` below.
   */
  hash: string;
  /**
   * What actually requires a Claude session rebuild under the delta model:
   * mode/tool changes only for skills; full content hash for plain/file.
   */
  sessionRebuildKey: string;
}

export interface PlanMemoryInjectionOptions {
  policy: ConditionPolicy;
  /** The Auto study treatment is defined only for Claude Code. */
  provider: AgentProvider;
  memory: MemoryService;
  projectId?: string;
  chatId?: string;
  /** Chat workspace root — where file-mode memory files live. */
  workspaceDir: string;
  /**
   * Per-turn override from an EDITED preview gate: only these ids inject this
   * turn. Under the delta model this no longer filters the skills BOOT block
   * (the restriction rides the turn's delta as an ignore line); it still
   * filters plain-mode blocks, Codex per-turn blocks, and the trace snapshot.
   */
  restrictToIds?: string[];
}

export interface NormalizeMemorySelectionOptions {
  memory: MemoryService;
  projectId?: string;
  chatId?: string;
  /** Untrusted or stale ids supplied by a client-side selection surface. */
  selectedIds: readonly string[];
}

/**
 * Resolve a client selection against the server-owned Visible Memory Pool for
 * this project/chat. The pool supplies membership and canonical order, so the
 * result also drops duplicates, unknown ids, stale status, wrong scope, and
 * session exclusions without trusting a client snapshot.
 */
export function normalizeMemorySelection(opts: NormalizeMemorySelectionOptions): string[] {
  const selected = new Set(opts.selectedIds);
  return opts.memory
    .injectedFor(opts.projectId, opts.chatId)
    .filter((item) => selected.has(item.id))
    .map((item) => item.id);
}

/** Unresolved conflicts among `items` (active↔active), deduped as ordered pairs. */
function conflictPairsAmong(memory: MemoryService, items: MemoryItem[]): MemoryConflictPair[] {
  const injected = new Set(items.map((m) => m.id));
  const seen = new Set<string>();
  const pairs: MemoryConflictPair[] = [];
  for (const item of items) {
    for (const other of memory.store.getConflicts(item.id)) {
      if (other.status !== 'active' || !injected.has(other.id)) continue;
      const key = [item.id, other.id].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ id: item.id, otherId: other.id });
    }
  }
  return pairs;
}

export function planMemoryInjection(opts: PlanMemoryInjectionOptions): MemoryInjectionPlan {
  const { policy, memory } = opts;

  if (policy.injection === 'file') {
    // Static arm: the workspace files ARE the memory. A controlled-study
    // project's first representation is intentionally empty; later projects
    // receive their predecessor only through the durable Project Copy gate.
    // Keep legacy seed scaffolding for non-study callers of file injection.
    const studyStatic = policy.studyMode && policy.condition === 'static';
    const scaffoldSeeds = studyStatic
      ? []
      : memory.injectedFor(opts.projectId);
    ensureStaticMemoryScaffold(opts.workspaceDir, scaffoldSeeds);
    const files = studyStatic
      ? readStudyStaticMemoryFiles(opts.workspaceDir)
      : readStaticMemoryFiles(opts.workspaceDir);
    const staticPayload = studyStatic
      ? buildStudyStaticFocusPayload(files)
      : buildStaticFocusPayload(files);
    const hash = `file:${hashStaticMemoryFiles(files)}`;
    return {
      mode: 'file',
      block: staticPayload.text,
      registerTools: false,
      injectedMemories: [],
      bakedMemories: [],
      staticFiles: files.map((f) => f.relPath),
      staticPayload,
      hash,
      sessionRebuildKey: hash,
    };
  }

  // Auto's Project Copy treatment belongs only to the controlled Claude Code study
  // path. Codex is a non-study product path and retains its original scoped
  // injection semantics even when an Auto policy is passed accidentally.
  const projectCopyAuto = policy.studyMode && policy.condition === 'auto' && opts.provider === 'claude';
  let injected = projectCopyAuto
    ? memory.autoProjectMemories(opts.projectId)
    : memory.injectedFor(opts.projectId, opts.chatId);
  if (opts.restrictToIds && policy.injection !== 'skills' && !projectCopyAuto) {
    const allowed = new Set(opts.restrictToIds);
    injected = injected.filter((m) => allowed.has(m.id));
  }
  const setHash = injected.map((m) => `${m.id}@v${m.version}`).join('|');

  if (policy.injection === 'plain') {
    const hash = `plain:${setHash}`;
    return {
      mode: 'plain',
      block: buildPlainMemoryBlock(injected),
      registerTools: false,
      injectedMemories: injected,
      bakedMemories: injected,
      staticFiles: [],
      staticPayload: null,
      hash,
      sessionRebuildKey: hash,
    };
  }

  // skills mode: restriction is reported (for preview/trace consumers) via
  // injectedMemories filtering below, but the BOOT block always carries the
  // full set — a per-turn edit must not bake into a persistent session.
  const restricted = opts.restrictToIds
    ? injected.filter((m) => new Set(opts.restrictToIds).has(m.id))
    : injected;
  return {
    mode: 'skills',
    block: buildMemoryBlock({
      memories: injected,
      tools: policy.memoryTools,
      conflicts: conflictPairsAmong(memory, injected),
    }),
    registerTools: policy.memoryTools,
    injectedMemories: restricted,
    bakedMemories: injected,
    staticFiles: [],
    staticPayload: null,
    hash: `skills:${setHash}`,
    // Content changes ride deltas; only a tools/mode flip rebuilds the session.
    sessionRebuildKey: `skills-live:${policy.memoryTools}`,
  };
}

export interface MemoryTurnDeltaOptions {
  memory: MemoryService;
  projectId?: string;
  chatId?: string;
  /** id → version as of the last injection (boot snapshot or previous delta). */
  baseline: Map<string, number>;
  /** Preview-gate per-turn allowlist (only these ids apply this turn). */
  restrictToIds?: string[];
}

export interface MemoryTurnDeltaResult {
  /** Delta block text ('' = quiet turn, append nothing). No envelope. */
  block: string;
  /** Baseline for the next turn (current active set). */
  nextBaseline: Map<string, number>;
  /** Exact active pool snapshot used to compose this turn's delta. */
  visibleMemories: MemoryItem[];
  /** Exact focused subset from that same snapshot. */
  effectiveMemories: MemoryItem[];
  /** Items now in play (current actives minus per-turn ignores) — trace ground truth. */
  effectiveIds: string[];
}

/**
 * Diff the current injectable set against the session's last-injected baseline
 * and render the per-turn delta block. Pure read — callers own baseline state.
 */
export function computeMemoryTurnDelta(opts: MemoryTurnDeltaOptions): MemoryTurnDeltaResult {
  const current = opts.memory.injectedFor(opts.projectId, opts.chatId);
  const currentById = new Map(current.map((m) => [m.id, m]));
  const nextBaseline = new Map(current.map((m) => [m.id, m.version]));

  const entries: MemoryDeltaEntry[] = [];
  for (const item of current) {
    const baseVersion = opts.baseline.get(item.id);
    const conflictsWith = opts.memory.store
      .getConflicts(item.id)
      .filter((o) => o.status === 'active' && currentById.has(o.id))
      .map((o) => o.id);
    if (baseVersion === undefined) {
      entries.push({
        kind: 'added',
        id: item.id,
        version: item.version,
        line: `(${item.scope} · ${item.type}) ${item.content}${item.detail ? ' [+detail]' : ''}`,
        conflictsWith: conflictsWith.length ? conflictsWith : undefined,
      });
    } else if (item.version > baseVersion) {
      entries.push({
        kind: 'edited',
        id: item.id,
        version: item.version,
        fromVersion: baseVersion,
        line: `(${item.scope} · ${item.type}) ${item.content}${item.detail ? ' [+detail]' : ''}`,
        conflictsWith: conflictsWith.length ? conflictsWith : undefined,
      });
    }
  }
  for (const id of opts.baseline.keys()) {
    if (!currentById.has(id)) entries.push({ kind: 'removed', id });
  }

  const ignoreForTurn = opts.restrictToIds
    ? current.filter((m) => !new Set(opts.restrictToIds).has(m.id)).map((m) => m.id)
    : undefined;

  const effective = opts.restrictToIds
    ? current.filter((m) => new Set(opts.restrictToIds).has(m.id))
    : current;

  return {
    block: buildMemoryDeltaBlock({ entries, ignoreForTurn }),
    nextBaseline,
    visibleMemories: current,
    effectiveMemories: effective,
    effectiveIds: effective.map((m) => m.id),
  };
}

export { formatMemoryLine };
