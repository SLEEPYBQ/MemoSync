import { createHash, randomUUID } from "node:crypto"
import type { ExpectedMemoryUse } from "../memory/use-plan"
import type { AutoProjectCloneProvenance } from "../memory"
import type { MemoryItem } from "../memory/types"
import type {
  DeliveredFocusEvent,
  DeliveredFocusMemoryRef,
  ExperimentCondition,
  ExperimentLogger,
} from "./logger"
import type { StudyMemoryStore } from "./study-memory-store"

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function canonicalState(item: Pick<MemoryItem, "content" | "scope">): string {
  return JSON.stringify({ content: item.content, scope: item.scope })
}

function visiblePoolHash(items: MemoryItem[]): string {
  return sha256(JSON.stringify(items.map((item) => ({
    id: item.id,
    version: item.version,
    content: item.content,
    scope: item.scope,
    status: item.status,
  }))))
}

export interface BuildDeliveredStoreFocusArgs {
  condition: Extract<ExperimentCondition, "memosync" | "auto">
  taskId: string | null
  chatId: string
  turnId: string
  turn: number
  mode: Extract<DeliveredFocusEvent["mode"], "skills" | "plain">
  resumeOfInterruptId?: string
  promptText: string
  /** Exact repeated focus text when the condition has a dedicated turn block. */
  focusPayloadText?: string
  visiblePool: MemoryItem[]
  focusedMemories: MemoryItem[]
  /** Auto-only lineage for identities created by Baseline Project Copy. */
  getAutoProjectCloneRef?: (memoryId: string) => AutoProjectCloneProvenance | null
  expectedUses?: ExpectedMemoryUse[]
  disabled?: boolean
  focusedAt?: string
  injectionId?: string
}

export function buildDeliveredStoreFocusEvent(args: BuildDeliveredStoreFocusArgs): DeliveredFocusEvent {
  const uses = new Map((args.expectedUses ?? []).map((use) => [use.id, use.expectedUse]))
  const seen = new Set<string>()
  const memories: DeliveredFocusMemoryRef[] = []
  for (const item of args.focusedMemories) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    const expectedUse = uses.get(item.id)?.trim()
    const cloneRef = args.condition === "auto"
      ? args.getAutoProjectCloneRef?.(item.id) ?? null
      : null
    memories.push({
      id: item.id,
      identity: { scheme: "store", id: item.id },
      version: item.version,
      content: item.content,
      contentHash: sha256(item.content),
      stateHash: sha256(canonicalState(item)),
      scope: item.scope,
      actualFocus: true,
      ...(expectedUse ? { expectedUse } : {}),
      sourceRef: {
        kind: args.condition === "memosync" ? "memosync_store" : "auto_store",
        memoryId: item.id,
        storeVersion: item.version,
        ...(cloneRef ?? {}),
      },
    })
  }

  const event: DeliveredFocusEvent = {
    type: "memory.inject",
    schemaVersion: 2,
    semantics: "turn_focus",
    injectionId: args.injectionId ?? randomUUID(),
    taskId: args.taskId,
    sessionId: args.chatId,
    chatId: args.chatId,
    turnId: args.turnId,
    turn: args.turn,
    engine: "claude",
    focusedAt: args.focusedAt ?? new Date().toISOString(),
    outcome: args.disabled ? "disabled" : memories.length > 0 ? "delivered" : "empty",
    ...(args.resumeOfInterruptId ? { resumeOfInterruptId: args.resumeOfInterruptId } : {}),
    deliveryStage: "queued_to_claude",
    mode: args.mode,
    deliveryHash: sha256(args.promptText),
    ...(args.focusPayloadText ? { focusPayloadHash: sha256(args.focusPayloadText) } : {}),
    visiblePoolHash: visiblePoolHash(args.visiblePool),
    memories,
  }
  return event
}

export function persistDeliveredStoreFocusEvent(args: {
  event: DeliveredFocusEvent
  condition: Extract<ExperimentCondition, "memosync" | "auto">
  logger: Pick<ExperimentLogger, "event">
  studyStore?: Pick<StudyMemoryStore, "recordFocusDelivery">
}): DeliveredFocusEvent {
  const { event } = args
  let persistenceError: unknown = null
  try {
    if (event.taskId && args.studyStore) {
      args.studyStore.recordFocusDelivery({
        injectionId: event.injectionId,
        taskId: event.taskId,
        chatId: event.chatId,
        turnId: event.turnId,
        turn: event.turn,
        focusedAt: event.focusedAt,
        condition: args.condition,
        engine: "claude",
        mode: event.mode,
        outcome: event.outcome,
        deliveryStage: event.deliveryStage,
        deliveryHash: event.deliveryHash,
        visiblePoolHash: event.visiblePoolHash,
        ...(event.resumeOfInterruptId ? { resumeOfInterruptId: event.resumeOfInterruptId } : {}),
        items: event.memories,
      })
    }
  } catch (error) {
    persistenceError = error
  }
  args.logger.event(event)
  if (persistenceError) throw persistenceError
  return event
}

export function recordDeliveredStoreFocus(args: BuildDeliveredStoreFocusArgs & {
  logger: Pick<ExperimentLogger, "event">
  studyStore?: Pick<StudyMemoryStore, "recordFocusDelivery">
}): DeliveredFocusEvent {
  const event = buildDeliveredStoreFocusEvent(args)
  return persistDeliveredStoreFocusEvent({
    event,
    condition: args.condition,
    logger: args.logger,
    studyStore: args.studyStore,
  })
}
