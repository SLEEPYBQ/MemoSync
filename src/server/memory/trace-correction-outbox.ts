import type { MemoryTraceCorrectionEntry } from '../../shared/types';
import type { EventStore } from '../event-store';
import type { MemoryService } from './index';

export interface TraceCorrectionTransport {
  hasChat: (chatId: string) => boolean;
  cited?: (chatId: string, turn: number, memoryId: string) => boolean | undefined;
  append: (chatId: string, entry: MemoryTraceCorrectionEntry) => Promise<void>;
}

const tails = new WeakMap<MemoryService, Promise<void>>();

export async function flushTraceCorrections(memory: MemoryService, transport: TraceCorrectionTransport): Promise<void> {
  const previous = tails.get(memory) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    for (const delivery of memory.store.pendingTraceCorrectionDeliveries()) {
      for (const projectId of delivery.projectionProjectIds) memory.syncProjection(projectId ?? undefined);
      if (!transport.hasChat(delivery.chatId)) {
        memory.store.acknowledgeTraceCorrectionDelivery(delivery.seq);
        continue;
      }
      await transport.append(delivery.chatId, delivery.entry);
      memory.store.acknowledgeTraceCorrectionDelivery(delivery.seq);
    }
  });
  tails.set(memory, next);
  try {
    await next;
  } finally {
    if (tails.get(memory) === next) tails.delete(memory);
  }
}

export function createTraceCorrectionTransport(
  store: EventStore,
  broadcast: (chatId: string) => Promise<void>,
): TraceCorrectionTransport {
  return {
    hasChat: chatId => Boolean(store.getChat(chatId)),
    cited: (chatId, turn, memoryId) => {
      for (const entry of store.getMessages(chatId).reverse()) {
        if (entry.kind !== 'memory_trace' || entry.turn !== turn || entry.status === 'pending') continue;
        const label = entry.labels.find(value => value.id === memoryId);
        if (label) return label.cited === true;
      }
      return undefined;
    },
    append: async (chatId, entry) => {
      await store.appendMessage(chatId, entry, { shouldAppend: () => !store.getMessages(chatId).some(value => value._id === entry._id) });
      try {
        await broadcast(chatId);
      } catch {
        console.warn('[memory] Audit correction saved; chat broadcast failed');
      }
    },
  };
}

export function startTraceCorrectionDelivery(memory: MemoryService, transport: TraceCorrectionTransport): () => Promise<void> {
  const flush = () => { void flushTraceCorrections(memory, transport).catch(() => {}); };
  flush();
  const interval = setInterval(flush, 1000);
  interval.unref?.();
  return async () => {
    clearInterval(interval);
    await (tails.get(memory) ?? Promise.resolve()).catch(() => {});
  };
}
