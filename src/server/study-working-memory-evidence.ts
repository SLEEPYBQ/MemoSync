import type { AgentProvider, TranscriptEntry } from "../shared/types"
import { getStudyTask, type StudyTask } from "../shared/studyTasks"
import type { ConditionPolicy } from "./experiment/condition"
import type { RegisteredStudyProject } from "./study-projects"
import type { StudyRegistry } from "./study-registry"
import type { StudySessionAttribution } from "./study-session-attribution"

export type StudyWorkingMemoryEvidenceAdmission =
  | { attribution: StudySessionAttribution }
  | { refusal: string }

export function createStudyWorkingMemoryEvidenceAdmission(args: {
  policy: ConditionPolicy
  registry: Pick<StudyRegistry, "taskWindowAt" | "freezeState">
  store: {
    getChat(chatId: string): {
      provider: AgentProvider | null
      projectId: string
      createdAt: number
    } | null
    getMessages(chatId: string): TranscriptEntry[]
  }
  assignedProjects: ReadonlyMap<StudyTask["projectSlug"], Pick<RegisteredStudyProject, "projectId">>
  getPendingPreview: (chatId: string) => { previewId: string; published: boolean } | null
  now?: () => number
}): ((input: {
  chatId: string
  previewId: string
  memoryId: string
  clientTimestamp: string
}) => StudyWorkingMemoryEvidenceAdmission) | undefined {
  if (!args.policy.studyMode || args.policy.condition !== "memosync") return undefined
  const now = args.now ?? Date.now
  return (input) => {
    const clientAt = Date.parse(input.clientTimestamp)
    const receivedAt = now()
    if (!Number.isFinite(clientAt) || clientAt > receivedAt) {
      return { refusal: "This Working Memory interaction has an invalid client timestamp." }
    }
    const chat = args.store.getChat(input.chatId)
    if (!chat) return { refusal: "This is not a study chat." }
    if (chat.provider !== "claude") {
      return { refusal: "Working Memory evidence is only accepted from a Claude study chat." }
    }

    const transcript = args.store.getMessages(input.chatId)
      .filter((message) => (
        (message.kind === "memory_preview" || message.kind === "memory_preview_update" || message.kind === "memory_preview_decision")
        && message.previewId === input.previewId
        && Number.isFinite(message.createdAt)
      ))
      .sort((left, right) => left.createdAt - right.createdAt)
    const revisions: Array<{ openedAt: number; closedAt?: number; memoryIds: string[]; taskId?: string }> = []
    let current: { openedAt: number; memoryIds: string[]; taskId?: string } | null = null
    for (const message of transcript) {
      if (message.kind === "memory_preview" || message.kind === "memory_preview_update") {
        if (current) revisions.push({ ...current, closedAt: message.createdAt })
        current = {
          openedAt: message.createdAt,
          memoryIds: message.memories.map((memory) => memory.id),
          ...(message.taskId ? { taskId: message.taskId } : {}),
        }
        continue
      }
      if (current) revisions.push({ ...current, closedAt: message.createdAt })
      current = null
      break
    }
    if (current) revisions.push(current)

    for (const revision of [...revisions].reverse()) {
      const taskWindow = args.registry.taskWindowAt(revision.openedAt)
      if (!taskWindow) continue
      if (revision.taskId && revision.taskId !== taskWindow.taskId) continue
      const task = getStudyTask(taskWindow.taskId)
      const assigned = task ? args.assignedProjects.get(task.projectSlug) : undefined
      if (!task || !assigned || assigned.projectId !== chat.projectId) continue
      const windowEnd = taskWindow.endAt
      if (chat.createdAt < taskWindow.startAt || (windowEnd !== null && chat.createdAt > windowEnd)) continue

      let closedAt = revision.closedAt
      if (windowEnd !== null) {
        closedAt = Math.min(closedAt ?? windowEnd, windowEnd)
      } else {
        if (args.registry.freezeState(taskWindow.taskId) !== "open") continue
        const pending = args.getPendingPreview(input.chatId)
        if (!closedAt && (!pending?.published || pending.previewId !== input.previewId)) continue
        closedAt = Math.min(closedAt ?? receivedAt, receivedAt)
      }
      if (clientAt < revision.openedAt || clientAt > closedAt) continue
      if (!revision.memoryIds.includes(input.memoryId)) {
        return { refusal: "This memory was not in the Working Memory preview when the interaction occurred." }
      }
      return {
        attribution: { taskId: taskWindow.taskId, sessionId: taskWindow.taskId },
      }
    }
    return { refusal: "This interaction cannot be bound to a durable Working Memory preview window." }
  }
}
