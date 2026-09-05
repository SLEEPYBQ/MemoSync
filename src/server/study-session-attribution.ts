import type { ConditionPolicy } from "./experiment/condition"
import type { StudyRegistry } from "./study-registry"

/**
 * Formal-study interaction metrics use the active task window as their
 * session domain. A task may contain more than one chat, so a client-selected
 * chat id is never the session key for participant-facing memory controls.
 */
export interface StudySessionAttribution {
  taskId: string
  sessionId: string
}

export type StudySessionAttributionResolver = () => StudySessionAttribution | null

export function createStudySessionAttribution(args: {
  policy: ConditionPolicy
  registry: Pick<StudyRegistry, "activeTaskId" | "freezeState" | "postSessionPending">
}): StudySessionAttributionResolver | undefined {
  if (!args.policy.studyMode || args.policy.condition !== "memosync") return undefined

  return () => {
    const taskId = args.registry.activeTaskId()
    if (!taskId || args.registry.postSessionPending() || args.registry.freezeState(taskId) !== "open") {
      return null
    }
    return { taskId, sessionId: taskId }
  }
}
