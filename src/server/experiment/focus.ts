import type { DeliveredFocusEvent, ExperimentLogger } from "./logger"
import type { StudyMemoryStore } from "./study-memory-store"
import { buildDeliveredStoreFocusEvent, type BuildDeliveredStoreFocusArgs } from "../usage/focus"
export { buildDeliveredStoreFocusEvent, type BuildDeliveredStoreFocusArgs } from "../usage/focus"

export function persistDeliveredStoreFocusEvent(args: {
  event: DeliveredFocusEvent
  condition: "memosync"
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
