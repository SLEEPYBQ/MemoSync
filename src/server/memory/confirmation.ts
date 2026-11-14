import type { MemoryConfirmationReason } from "../../shared/types";
import type { MemoryStore } from "./MemoryStore";
import type { MemoryItem } from "./types";
import type { FileDrift } from "./file-drift";

export interface MemoryConfirmationState {
  confirmedVersions: Record<string, number>;
  confirmedDrift: Record<string, string>;
  removedIds: string[];
}
const key = (chatId: string) => `confirmed_memories:${chatId}`;

export function getMemoryConfirmation(store: MemoryStore, chatId: string): MemoryConfirmationState {
  const state = store.getKv<MemoryConfirmationState>(key(chatId));
  return { confirmedVersions: state?.confirmedVersions ?? {}, confirmedDrift: state?.confirmedDrift ?? {}, removedIds: state?.removedIds ?? [] };
}

export function clearMemoryRemoval(store: MemoryStore, chatId: string, memoryId: string): void {
  const state = getMemoryConfirmation(store, chatId);
  if (!state.removedIds.includes(memoryId)) return;
  store.setKv(key(chatId), { ...state, removedIds: state.removedIds.filter(id => id !== memoryId) });
}

export function memoryConfirmationReasons(items: readonly MemoryItem[], state: MemoryConfirmationState, enforcedIds: readonly string[], drift?: FileDrift, store?: MemoryStore): MemoryConfirmationReason[] {
  const removed = new Set(state.removedIds), enforced = new Set(enforcedIds);
  const refs = drift?.refsFor(items.map(item => item.id));
  return items.flatMap(item => {
    const previousVersion = state.confirmedVersions[item.id];
    const signature = drift?.driftSignature(item.id) ?? '';
    const reason = enforced.has(item.id) ? "enforced" : removed.has(item.id) ? "removed" : previousVersion === undefined ? "first" : previousVersion !== item.version ? "changed" : signature && signature !== (state.confirmedDrift[item.id] ?? '') ? "file_changed" : undefined;
    return reason ? [{ id: item.id, reason, version: item.version, ...(previousVersion === undefined ? {} : { previousVersion }),
      ...(store?.isTeamLinked(item.id) ? { team: true as const } : {}),
      ...(reason === "file_changed" ? { files: (refs?.get(item.id) ?? []).flatMap(ref => ref.drift ? [{ path: ref.path, drift: ref.drift }] : []) } : {}) }] : [];
  });
}

export function recordMemoryConfirmation(store: MemoryStore, chatId: string, selected: readonly MemoryItem[], removedIds: readonly string[], drift?: FileDrift): void {
  const state = getMemoryConfirmation(store, chatId);
  const removed = new Set([...state.removedIds, ...removedIds]);
  for (const item of selected) {
    state.confirmedVersions[item.id] = item.version;
    state.confirmedDrift[item.id] = drift?.driftSignature(item.id) ?? '';
    removed.delete(item.id);
  }
  store.setKv(key(chatId), { confirmedVersions: state.confirmedVersions, confirmedDrift: state.confirmedDrift, removedIds: [...removed] });
}
