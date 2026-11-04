// planMemoryInjection is the source of truth for the selected MemoSync memory
// context. Later changes ride user turns as deltas.
import type { MemoryService } from './index';
import {
  buildMemoryBlock,
  buildMemoryDeltaBlock,
  type MemoryConflictPair,
  type MemoryDeltaEntry,
} from './prompt';
import type { MemoryItem } from './types';
import { baselineFor, compileMemoryView, type MemoryBaseline, type MemoryView } from './view';
export type { MemoryBaseline, MemoryView } from './view';

export interface MemoryInjectionPlan {
  mode: 'skills';
  view: MemoryView;
  baseline: MemoryBaseline;
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
  for (const [sourceId, targetId, type] of memory.store.getViewRelations([...injected])) {
    if (type !== 'conflicts_with' || !injected.has(sourceId!) || !injected.has(targetId!)) continue;
    const [id, otherId] = [sourceId!, targetId!].sort();
    const key = JSON.stringify([id, otherId]);
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ id: id!, otherId: otherId! });
  }
  pairs.sort((a, b) => a.id.localeCompare(b.id) || a.otherId.localeCompare(b.otherId));
  return pairs;
}

export function planMemoryInjection(opts: PlanMemoryInjectionOptions): MemoryInjectionPlan {
  const { memory } = opts;
  return memory.db.transaction(() => {
    const injected = memory.injectedFor(opts.projectId, opts.chatId);
    const selection = opts.restrictToIds ? new Set(opts.restrictToIds) : null;
    const restricted = selection ? injected.filter(m => selection.has(m.id)) : injected;
    const view = compileMemoryView(memory, injected, restricted, opts.projectId, opts.chatId);
    return {
      mode: 'skills' as const,
      view,
      baseline: baselineFor(restricted, view),
      block: buildMemoryBlock({
        memories: restricted,
        tools: true,
        conflicts: conflictPairsAmong(memory, restricted),
        viewRevision: view.revision,
      }),
      registerTools: true,
      injectedMemories: restricted,
      bakedMemories: restricted,
      hash: `skills:${restricted.map((m) => `${m.id}@v${m.version}`).join('|')}:${view.revision}`,
      // Semantic changes ride deltas; only a tools/mode flip rebuilds the session.
      sessionRebuildKey: 'skills-live:true',
    };
  })();
}

export interface MemoryTurnDeltaOptions {
  memory: MemoryService;
  projectId?: string;
  chatId?: string;
  /** id → version as of the last injection (boot snapshot or previous delta). */
  baseline: MemoryBaseline;
  /** Preview-gate per-turn allowlist (only these ids apply this turn). */
  restrictToIds?: string[];
}

export interface MemoryTurnDeltaResult {
  /** Delta block text ('' = quiet turn, append nothing). No envelope. */
  block: string;
  /** Baseline for the next turn (current active set). */
  nextBaseline: MemoryBaseline;
  view: MemoryView;
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
  return opts.memory.db.transaction(() => {
    const visible = opts.memory.injectedFor(opts.projectId, opts.chatId);
    const selected = opts.restrictToIds ? new Set(opts.restrictToIds) : null;
    const current = selected ? visible.filter(item => selected.has(item.id)) : visible;
    const currentById = new Map(current.map((m) => [m.id, m]));
    const view = compileMemoryView(opts.memory, visible, current, opts.projectId, opts.chatId);
    const nextBaseline = baselineFor(current, view);

    const entries: MemoryDeltaEntry[] = [];
    const conflicts = conflictPairsAmong(opts.memory, current);
    for (const item of current) {
      const baseVersion = opts.baseline.get(item.id);
      const conflictsWith = conflicts
        .filter(pair => pair.id === item.id || pair.otherId === item.id)
        .map(pair => pair.id === item.id ? pair.otherId : pair.id);
      if (baseVersion === undefined) {
        entries.push({
          kind: 'added',
          id: item.id,
          version: item.version,
          line: `(${item.scope} · ${item.type}) ${item.content}${item.detail ? ' [+detail]' : ''}`,
          conflictsWith: conflictsWith.length ? conflictsWith : undefined,
        });
      } else if (item.version !== baseVersion || !opts.baseline.view ||
        opts.baseline.view.signatures[item.id] !== view.signatures[item.id]) {
        entries.push({
          kind: item.version !== baseVersion ? 'edited' : 'view_changed',
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
      block: buildMemoryDeltaBlock({ entries, ignoreForTurn,
        viewRevision: opts.baseline.view?.revision !== view.revision ? view.revision : undefined,
      }),
      nextBaseline,
      view,
      visibleMemories: visible,
      effectiveMemories: effective,
      effectiveIds: effective.map((m) => m.id),
    };
  })();
}
