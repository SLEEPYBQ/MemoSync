import type { HydratedTranscriptMessage } from "../../shared/types"

/**
 * Whether the current turn still has an OPEN pre-turn memory step (Step 1
 * proposals / Transfer / Step 2 checkup / preview gate). While one is open
 * the transcript footer hides the streaming reply and the processing row so
 * the gate card is the single focus.
 *
 * "Open" means the step has no decision yet. Every stage settles its
 * container even when it finds nothing (proposals/transfer/checkup all
 * record "empty") — a step that stayed undecided for the whole turn would
 * otherwise suppress streaming until the final reply lands at once.
 */
export function hasOpenMemoryPreparationStep(messages: HydratedTranscriptMessage[]): boolean {
  let latestUserPromptIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.kind === "user_prompt") {
      latestUserPromptIndex = index
      break
    }
  }
  return messages.slice(Math.max(0, latestUserPromptIndex)).some((message) => (
    (message.kind === "memory_proposals" || message.kind === "memory_transfer" || message.kind === "memory_checkup" || message.kind === "memory_preview")
    && message.decision === undefined
  ))
}
