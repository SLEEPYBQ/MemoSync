import type { HydratedTranscriptMessage } from "../../shared/types"
import type { ProcessedToolCall } from "../components/messages/types"

const SPECIAL_TOOL_NAMES = ["AskUserQuestion", "ExitPlanMode", "TodoWrite"] as const
const RESOLVED_TOOL_NAMES = new Set<string>(["TodoWrite"])

function findLatestUnresolvedToolId(messages: HydratedTranscriptMessage[], toolName: string): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.kind !== "tool") continue
    const toolCall = message as ProcessedToolCall
    if (toolCall.toolName === toolName && !toolCall.result) {
      return toolCall.id
    }
  }
  return null
}

function findLatestToolId(messages: HydratedTranscriptMessage[], toolName: string): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.kind !== "tool") continue
    const toolCall = message as ProcessedToolCall
    if (toolCall.toolName === toolName) {
      return toolCall.id
    }
  }
  return null
}

export function getLatestToolIds(messages: HydratedTranscriptMessage[]) {
  const ids: Record<string, string | null> = {}
  for (const toolName of SPECIAL_TOOL_NAMES) {
    ids[toolName] = RESOLVED_TOOL_NAMES.has(toolName)
      ? findLatestToolId(messages, toolName)
      : findLatestUnresolvedToolId(messages, toolName)
  }
  return ids
}

export function canCancelStatus(status?: string) {
  return status === "starting" || status === "running" || status === "waiting_for_user"
}

export function isProcessingStatus(status?: string) {
  return status === "starting" || status === "previewing_memory" || status === "running" || status === "waiting_for_user"
}

/**
 * An undecided per-turn memory preview parks the turn SERVER-side, but no
 * ActiveTurn exists yet so runtime.status stays "idle" — sends during this
 * window must take the enqueue path (queued-message UI) instead of looking
 * delivered. Scanning from the end: a user_prompt/result after the preview
 * means the turn moved past it (stale), not pending.
 */
export function hasPendingMemoryPreview(messages: Array<{ kind: string; decision?: unknown }>): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.kind === "memory_preview") return message.decision === undefined
    if (message.kind === "user_prompt" || message.kind === "result") return false
  }
  return false
}
