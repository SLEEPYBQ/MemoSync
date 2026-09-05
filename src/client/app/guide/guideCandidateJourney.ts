export type GuideCandidateDecisionStep = "memosync.long-term-card" | "memosync.candidate-reopened"

/**
 * Candidate controls are real, local practice, but never a navigation gate.
 * A participant may try Accept, Undo, Dismiss, or Restore, then continue from
 * either Step 1 surface regardless of the sandbox state they leave behind.
 */
export function resolveGuideCandidateJourneyDecision(
  stepId: GuideCandidateDecisionStep,
): { targetStepId: "memosync.candidate-summary" | "memosync.board-library"; blocker: null } {
  return {
    targetStepId: stepId === "memosync.candidate-reopened"
      ? "memosync.board-library"
      : "memosync.candidate-summary",
    blocker: null,
  }
}
