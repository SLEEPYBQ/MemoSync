import { createHash, randomUUID } from 'node:crypto';
import type { StaticFocusPayload } from '../memory/static-files';
import type { ExperimentLogger, DeliveredFocusEvent, DeliveredFocusMemoryRef } from './logger';
import type { StaticMemoryExtractor } from './static-memory-extractor';
import type {
  PendingStaticFocusDelivery,
  StudyMemoryStore,
} from './study-memory-store';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function reserveDeliveredStaticFocus(args: {
  store: Pick<StudyMemoryStore, 'reserveStaticFocusDelivery'>;
  taskId: string;
  namespace: string;
  chatId: string;
  turnId: string;
  turn: number;
  promptText: string;
  payload: StaticFocusPayload;
  injectionId?: string;
  focusedAt?: string;
}): PendingStaticFocusDelivery {
  const injectionId = args.injectionId ?? randomUUID();
  const focusedAt = args.focusedAt ?? new Date().toISOString();
  return args.store.reserveStaticFocusDelivery({
    injectionId,
    taskId: args.taskId,
    namespace: args.namespace,
    chatId: args.chatId,
    turnId: args.turnId,
    turn: args.turn,
    focusedAt,
    deliveryHash: sha256(args.promptText),
    payload: args.payload,
  });
}

/**
 * Finish one previously reserved Static focus. This never reads the workspace:
 * restart recovery extracts the exact payload stored at Claude queue time.
 */
export async function materializePendingStaticFocus(args: {
  store: Pick<StudyMemoryStore, 'finalizeStaticFocusDelivery'>;
  extractor: StaticMemoryExtractor;
  logger: Pick<ExperimentLogger, 'event'>;
  pending: PendingStaticFocusDelivery;
}): Promise<DeliveredFocusEvent> {
  const extraction = await args.extractor.extract(args.pending.payload);
  const finalized = args.store.finalizeStaticFocusDelivery({
    injectionId: args.pending.injectionId,
    payloadHash: extraction.payloadHash,
    qualityFlags: extraction.qualityFlags,
    atoms: extraction.atoms.map((atom) => ({
      content: atom.content,
      contentHash: atom.contentHash,
      sourceRef: atom.sourceRef,
      qualityFlags: atom.qualityFlags,
    })),
  });
  const memories: DeliveredFocusMemoryRef[] = finalized.delivery.items.map((item) => ({
    id: item.identity.id,
    identity: item.identity,
    version: item.version,
    content: item.content,
    contentHash: item.contentHash,
    stateHash: item.stateHash,
    scope: item.scope,
    actualFocus: true,
    sourceRef: item.sourceRef,
    ...(item.qualityFlags.length ? { qualityFlags: item.qualityFlags } : {}),
  }));
  const event: DeliveredFocusEvent = {
    type: 'memory.inject',
    schemaVersion: 2,
    semantics: 'turn_focus',
    injectionId: args.pending.injectionId,
    taskId: args.pending.taskId,
    sessionId: args.pending.chatId,
    chatId: args.pending.chatId,
    turnId: args.pending.turnId,
    turn: args.pending.turn,
    engine: 'claude',
    focusedAt: args.pending.focusedAt,
    outcome: finalized.delivery.outcome === 'delivered' ? 'delivered' : 'empty',
    deliveryStage: 'queued_to_claude',
    mode: 'file',
    deliveryHash: args.pending.deliveryHash,
    focusPayloadHash: extraction.payloadHash,
    visiblePoolHash: extraction.payloadHash,
    memories,
    ...(extraction.qualityFlags.length ? { qualityFlags: extraction.qualityFlags } : {}),
  };

  args.logger.event(event);
  return event;
}

/** Convenience path used by unit tests and freeze fixtures. Production turns
 * reserve synchronously first, then enqueue `materializePendingStaticFocus`. */
export async function materializeDeliveredStaticFocus(args: {
  store: Pick<
    StudyMemoryStore,
    'reserveStaticFocusDelivery' | 'finalizeStaticFocusDelivery'
  >;
  extractor: StaticMemoryExtractor;
  logger: Pick<ExperimentLogger, 'event'>;
  taskId: string;
  namespace: string;
  chatId: string;
  turnId: string;
  turn: number;
  promptText: string;
  payload: StaticFocusPayload;
  injectionId?: string;
  focusedAt?: string;
}): Promise<DeliveredFocusEvent> {
  const pending = reserveDeliveredStaticFocus(args);
  return materializePendingStaticFocus({
    store: args.store,
    extractor: args.extractor,
    logger: args.logger,
    pending,
  });
}
