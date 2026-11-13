import { createHash } from 'node:crypto';
import type { MemoryService } from './index';
import type { MemoryItem } from './types';

/** A server-owned detail grant for the exact semantic view admitted to a turn. */
export interface MemoryView {
  revision: string;
  versions: Readonly<Record<string, number>>;
  signatures: Readonly<Record<string, string>>;
  projectId?: string;
  chatId?: string;
  /** Canonical effective selection; live eligibility is checked again on reads. */
  selectedIds: readonly string[];
  visibleIds?: readonly string[];
  eventSeq?: number;
}

/** Version-only baselines remain readable and receive one conservative refresh. */
export interface MemoryBaseline extends Map<string, number> {
  view?: MemoryView;
}

export function semanticHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function relationLifecycleOverrides(
  memory: MemoryService, visibleIds: readonly string[], eventSeq: number | undefined,
): { archivedAsActive: Set<string>; restoredAsArchived: Set<string> } {
  const archivedAsActive = new Set<string>();
  const restoredAsArchived = new Set<string>();
  if (eventSeq === undefined) return { archivedAsActive, restoredAsArchived };
  for (const row of memory.store.getViewRelations(visibleIds)) {
    for (const [id, status] of [[row[0]!, row[3]!], [row[1]!, row[7]!]]) {
      const wasArchived = memory.store.wasArchivedAt(id!, eventSeq);
      if (status === 'archived' && !wasArchived) archivedAsActive.add(id!);
      if (status === 'active' && wasArchived) restoredAsArchived.add(id!);
    }
  }
  return { archivedAsActive, restoredAsArchived };
}

export function compileMemoryView(
  memory: MemoryService,
  visible: MemoryItem[],
  selected: MemoryItem[],
  projectId?: string,
  chatId?: string,
  archivedAsActiveIds: ReadonlySet<string> = new Set(),
  restoredAsArchivedIds: ReadonlySet<string> = new Set(),
): MemoryView {
  const relations = memory.store.getViewRelations(visible.map(item => item.id)).map(row => {
    const relation = [...row];
    if (archivedAsActiveIds.has(relation[0]!) && relation[3] === 'archived') relation[3] = 'active';
    if (archivedAsActiveIds.has(relation[1]!) && relation[7] === 'archived') relation[7] = 'active';
    if (restoredAsArchivedIds.has(relation[0]!) && relation[3] === 'active') relation[3] = 'archived';
    if (restoredAsArchivedIds.has(relation[1]!) && relation[7] === 'active') relation[7] = 'archived';
    return relation;
  });
  const states = visible.map(item => [
    item.id, item.version, item.content, item.detail ?? null, item.scope,
    item.projectId ?? null, item.sessionId ?? null, item.status, item.type,
    item.topic ?? null, item.abstractionLevel, item.sensitive, item.evidenceClass ?? null,
  ]);
  const selectedIds = selected.map(item => item.id);
  const signatures = Object.fromEntries(states.map(state => [
    state[0] as string,
    semanticHash([state, relations.filter(relation => relation[0] === state[0] || relation[1] === state[0])]),
  ]));
  return {
    revision: semanticHash([projectId ?? null, chatId ?? null, states, relations, selectedIds,
      chatId ? [...new Set(memory.store.getSessionExclusions(chatId))].sort() : []]),
    versions: Object.fromEntries(selected.map(item => [item.id, item.version])),
    signatures,
    projectId,
    chatId,
    selectedIds,
    visibleIds: visible.map(item => item.id),
    eventSeq: memory.store.latestEventSeq(),
  };
}

export function baselineFor(items: MemoryItem[], view: MemoryView): MemoryBaseline {
  return Object.assign(new Map(items.map(item => [item.id, item.version])), { view });
}
