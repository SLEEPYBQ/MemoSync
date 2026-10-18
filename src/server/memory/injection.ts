// planMemoryInjection is the source of truth for the selected MemoSync memory
// context. Later changes ride user turns as deltas.
import type { ConditionPolicy } from '../experiment/condition';
import type { MemoryService } from './index';
import type { MemoryItem } from './types';
import {
  buildMemoryBlock,
  buildMemoryDeltaBlock,
  type MemoryConflictPair,
  type MemoryDeltaEntry,
} from './prompt';

export interface MemoryInjectionPlan {
  mode: 'skills';
  /** Exact text block baked once into the session context. */
  block: string;
  /** Whether the load_memory_detail tool should be registered. */
  registerTools: boolean;
  /** Items in play for the turn (per-turn restriction applied) — logging, preview, trace. */
  injectedMemories: MemoryItem[];
  /** Items baked into `block`; seeds the next turn's delta baseline. */
  bakedMemories: MemoryItem[];
  /**
   * Fingerprint of the injectable state. Content changes ride deltas;
   * consumers use `sessionRebuildKey` to decide whether to rebuild.
   */
  hash: string;
  /** What requires a session rebuild under the delta model. */
  sessionRebuildKey: string;
}

export interface PlanMemoryInjectionOptions {
  policy: ConditionPolicy;
  memory: MemoryService;
  projectId?: string;
  chatId?: string;
  /**
   * Only these confirmed ids inject this turn, including the skills boot
   * block, subsequent deltas, Codex developer instructions and audit snapshot.
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
  const injected = memory.injectedFor(opts.projectId, opts.chatId);
  const restricted = opts.restrictToIds
    ? injected.filter((m) => new Set(opts.restrictToIds).has(m.id))
    : injected;
  return {
    mode: 'skills',
    block: buildMemoryBlock({
      memories: restricted,
      tools: policy.memoryTools,
      conflicts: conflictPairsAmong(memory, restricted),
    }),
    registerTools: policy.memoryTools,
    injectedMemories: restricted,
    bakedMemories: restricted,
    hash: `skills:${restricted.map((m) => `${m.id}@v${m.version}`).join('|')}`,
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
  const visible = opts.memory.injectedFor(opts.projectId, opts.chatId);
  const selected = opts.restrictToIds ? new Set(opts.restrictToIds) : null;
  const current = selected ? visible.filter(item => selected.has(item.id)) : visible;
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
    ? [...opts.baseline.keys()].filter(id => !currentById.has(id))
    : undefined;

  const effective = opts.restrictToIds
    ? current.filter((m) => new Set(opts.restrictToIds).has(m.id))
    : current;

  return {
    block: buildMemoryDeltaBlock({ entries, ignoreForTurn }),
    nextBaseline,
    visibleMemories: visible,
    effectiveMemories: effective,
    effectiveIds: effective.map((m) => m.id),
  };
}
