import { getStudyTask, type StudyTask } from "../shared/studyTasks"
import type { TranscriptEntry } from "../shared/types"
import type { RegisteredStudyProject } from "./study-projects"
import type { StudyRegistry } from "./study-registry"
import type { StudyTelemetryService } from "./study-telemetry"

interface TranscriptChat {
  id: string
  projectId: string
  createdAt: number
  provider: string | null
  pendingForkSessionToken?: string | null
}

interface ParticipantPromptTranscript {
  listStudyTranscriptChats(): TranscriptChat[]
  getMessages(chatId: string): TranscriptEntry[]
}

export interface StudyParticipantPromptReconciliation {
  scanned: number
  created: number
  existing: number
  skipped: number
}

/**
 * Rebuild durable prompt evidence from the transcript write that precedes it.
 * The reconciler never guesses a task from receive time: the original entry
 * timestamp, serial task window, chat lineage and assigned project must agree.
 */
export function createStudyParticipantPromptReconciler(input: {
  transcript: ParticipantPromptTranscript
  registry: StudyRegistry
  telemetry: Pick<StudyTelemetryService, "recordRecoveredParticipantPrompt">
  assignedProjects: ReadonlyMap<StudyTask["projectSlug"], Pick<RegisteredStudyProject, "projectId">>
}) {
  return {
    reconcile(): StudyParticipantPromptReconciliation {
      const result: StudyParticipantPromptReconciliation = {
        scanned: 0,
        created: 0,
        existing: 0,
        skipped: 0,
      }
      for (const chat of input.transcript.listStudyTranscriptChats()) {
        for (const entry of input.transcript.getMessages(chat.id)) {
          if (entry.kind !== "user_prompt") continue
          result.scanned += 1
          const taskWindow = input.registry.taskWindowAt(entry.createdAt)
          const task = taskWindow ? getStudyTask(taskWindow.taskId) : undefined
          const assigned = task ? input.assignedProjects.get(task.projectSlug) : undefined
          const admitted = chat.provider === "claude"
            && !chat.pendingForkSessionToken
            && taskWindow !== null
            && chat.createdAt >= taskWindow.startAt
            && chat.createdAt <= entry.createdAt
            && entry.createdAt >= taskWindow.startAt
            && assigned?.projectId === chat.projectId
          if (!admitted || !taskWindow) {
            result.skipped += 1
            continue
          }
          const hasParticipantContent = typeof entry.participantContent === "string"
          const recorded = input.telemetry.recordRecoveredParticipantPrompt({
            taskId: taskWindow.taskId,
            turnId: entry._id,
            chatId: chat.id,
            content: hasParticipantContent ? entry.participantContent! : entry.content,
            contentSource: hasParticipantContent ? "participant" : "legacy_transcript",
            attachments: entry.attachments ?? [],
            acceptedAt: new Date(entry.createdAt).toISOString(),
          })
          if (recorded.created) result.created += 1
          else result.existing += 1
        }
      }
      return result
    },
  }
}
