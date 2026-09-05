import { describe, expect, test } from "bun:test"
import { STUDY_BRIEFS } from "./study-briefs"
import { assessStudyInstructionOverlap, STUDY_INSTRUCTION_GUARD_RULE_VERSION } from "./study-instruction-guard"

describe("study instruction overlap guard", () => {
  const apartmentBrief = STUDY_BRIEFS["038-S1"]!

  test("rejects exact text and formatting-only variants", () => {
    const exact = assessStudyInstructionOverlap(apartmentBrief[1]!, apartmentBrief)
    const formatting = assessStudyInstructionOverlap(
      `USERS SHOULD BE ABLE TO BROWSE different types of apartments;\nsearch for apartments, and filter apartments based on their criteria!`,
      apartmentBrief,
    )

    expect(exact.rejected).toBe(true)
    expect(formatting.rejected).toBe(true)
    expect(exact.ruleVersion).toBe(STUDY_INSTRUCTION_GUARD_RULE_VERSION)
  })

  test("rejects a copied sentence with a few inserted or removed words", () => {
    const result = assessStudyInstructionOverlap(
      "Users should easily browse many types of apartments, search apartments, and filter them based on their own criteria.",
      apartmentBrief,
    )
    expect(result.rejected).toBe(true)
    expect(result.lcsRatio).toBeGreaterThanOrEqual(0.75)
  })

  test("rejects an eight-token verbatim run even inside a longer prompt", () => {
    const result = assessStudyInstructionOverlap(
      "First inspect the repo. Then use linen as the page background color and maroon, but decide the implementation yourself.",
      apartmentBrief,
    )
    expect(result.rejected).toBe(true)
    expect(result.longestContiguousRun).toBeGreaterThanOrEqual(8)
  })

  test("allows a genuine own-words task description and short technical overlap", () => {
    expect(assessStudyInstructionOverlap(
      "Build the apartment discovery flow first. Please make search and filters usable, and follow the warm neutral brand palette described to me.",
      apartmentBrief,
    ).rejected).toBe(false)
    expect(assessStudyInstructionOverlap("Please build apartment search and filters.", apartmentBrief).rejected).toBe(false)
  })

  test("compares against both individual paragraphs and the joined brief", () => {
    const result = assessStudyInstructionOverlap(
      "implement browsing discovery features browse different apartments search linen page background color maroon accent components",
      apartmentBrief,
    )
    expect(result.rejected).toBe(true)
    expect(result.reference).toBe("full_brief")
  })
})
