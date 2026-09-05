import { describe, expect, test } from "bun:test"
import { resolveGuideCandidateJourneyDecision } from "./guideCandidateJourney"

describe("Guide Candidate journey", () => {
  test("keeps Candidate actions optional on both real Step 1 surfaces", () => {
    expect(resolveGuideCandidateJourneyDecision("memosync.long-term-card")).toEqual({
      targetStepId: "memosync.candidate-summary",
      blocker: null,
    })
    expect(resolveGuideCandidateJourneyDecision("memosync.candidate-reopened")).toEqual({
      targetStepId: "memosync.board-library",
      blocker: null,
    })
  })
})
