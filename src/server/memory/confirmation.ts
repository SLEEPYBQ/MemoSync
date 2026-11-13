import type { MemoryConfirmationReason } from "../../shared/types";
import type { MemoryStore } from "./MemoryStore";
import type { MemoryItem } from "./types";

export interface MemoryConfirmationState {
  confirmedVersions: Record<string, number>;
  removedIds: string[];
}
const key = (chatId: string) => `confirmed_memories:${chatId}`;

export function getMemoryConfirmation(store: MemoryStore, chatId: string): MemoryConfirmationState {
  return store.getKv<MemoryConfirmationState>(key(chatId)) ?? { confirmedVersions: {}, removedIds: [] };
}

export function memoryConfirmationReasons(items: readonly MemoryItem[], state: MemoryConfirmationState, enforcedIds: readonly string[]): MemoryConfirmationReason[] {
  const removed = new Set(state.removedIds), enforced = new Set(enforcedIds);
  return items.flatMap(item => {
    const previousVersion = state.confirmedVersions[item.id];
    const reason = enforced.has(item.id) ? "enforced" : removed.has(item.id) ? "removed" : previousVersion === undefined ? "first" : previousVersion !== item.version ? "changed" : undefined;
    return reason ? [{ id: item.id, reason, version: item.version, ...(previousVersion === undefined ? {} : { previousVersion }) }] : [];
  });
}

export function recordMemoryConfirmation(store: MemoryStore, chatId: string, selected: readonly MemoryItem[], removedIds: readonly string[]): void {
  const state = getMemoryConfirmation(store, chatId);
  const removed = new Set([...state.removedIds, ...removedIds]);
  for (const item of selected) { state.confirmedVersions[item.id] = item.version; removed.delete(item.id); }
  store.setKv(key(chatId), { confirmedVersions: state.confirmedVersions, removedIds: [...removed] });
}
