import { describe, expect, test } from "bun:test"
import {
  isStudyQuestionnaireAnswerComplete,
  parseStudyQuestionnaireAnswer,
  parseStudyQuestionnaireItem,
} from "./studyTasks"

describe("study questionnaire item schema", () => {
  test("keeps the last-focused full atomic content as the cue", () => {
    const item = {
      probeId: "probe-M-07",
      snapshotId: "snapshot-task-1",
      cue: "Run the full accessibility check before every production release, including keyboard navigation and contrast.",
    }

    expect(parseStudyQuestionnaireItem(item)).toEqual(item)
  })

  test("rejects an empty cue or an item with non-canonical keys", () => {
    expect(parseStudyQuestionnaireItem({
      probeId: "probe-M-07",
      snapshotId: "snapshot-task-1",
      cue: "   ",
    })).toBeNull()
    expect(parseStudyQuestionnaireItem({
      probeId: "probe-M-07",
      snapshotId: "snapshot-task-1",
      cue: "Use pnpm.",
      summary: "Use pnpm.",
    })).toBeNull()
  })
})

describe("study questionnaire answer schema", () => {
  test("parses a complete answer keyed by its probe and frozen snapshot", () => {
    const answer = {
      probeId: "probe-M-07",
      snapshotId: "snapshot-task-1",
      desired: { kind: "accurate", presence: "present", scope: "project" },
      assessed: { kind: "full", presence: "present", scope: "personal" },
      execution: "full",
    } as const

    expect(parseStudyQuestionnaireAnswer(answer)).toEqual(answer)
  })

  test("trims corrected desired content and believed partial content", () => {
    expect(parseStudyQuestionnaireAnswer({
      probeId: "probe-M-08",
      snapshotId: "snapshot-task-1",
      desired: {
        kind: "needs_edit",
        presence: "present",
        correctedContent: "  Run the accessibility checks before release.  ",
        scope: "project",
      },
      assessed: {
        kind: "partial_or_distorted",
        presence: "present",
        believedContent: "  The agent remembers only the release check.  ",
        scope: "unsure",
      },
      execution: "partial",
    })).toEqual({
      probeId: "probe-M-08",
      snapshotId: "snapshot-task-1",
      desired: {
        kind: "needs_edit",
        presence: "present",
        correctedContent: "Run the accessibility checks before release.",
        scope: "project",
      },
      assessed: {
        kind: "partial_or_distorted",
        presence: "present",
        believedContent: "The agent remembers only the release check.",
        scope: "unsure",
      },
      execution: "partial",
    })
  })

  test("represents not intended and not remembered as absent with no scope", () => {
    const answer = {
      probeId: "probe-M-09",
      snapshotId: "snapshot-task-1",
      desired: { kind: "not_intended", presence: "absent", scope: null },
      assessed: { kind: "not_remembered", presence: "absent", scope: null },
      execution: "not_applicable",
    } as const

    expect(parseStudyQuestionnaireAnswer(answer)).toEqual(answer)
  })

  test("retains an unsure assessment as unknown with either a known or unsure scope", () => {
    for (const scope of ["session", "unsure"] as const) {
      const answer = {
        probeId: `probe-unknown-${scope}`,
        snapshotId: "snapshot-task-1",
        desired: { kind: "accurate", presence: "present", scope: "session" },
        assessed: { kind: "unsure", presence: "unknown", scope },
        execution: "unsure",
      } as const

      expect(parseStudyQuestionnaireAnswer(answer)).toEqual(answer)
    }
  })

  test("rejects unknown fields instead of silently accepting a wider payload", () => {
    expect(parseStudyQuestionnaireAnswer({
      probeId: "probe-M-10",
      snapshotId: "snapshot-task-1",
      desired: { kind: "accurate", presence: "present", scope: "project" },
      assessed: { kind: "full", presence: "present", scope: "project" },
      execution: "none",
      memoryId: "M-10",
    })).toBeNull()
  })

  test("rejects fields that do not belong to the selected union variants", () => {
    expect(parseStudyQuestionnaireAnswer({
      probeId: "probe-M-10",
      snapshotId: "snapshot-task-1",
      desired: {
        kind: "accurate",
        presence: "present",
        scope: "project",
        correctedContent: "This field belongs only to needs_edit.",
      },
      assessed: { kind: "full", presence: "present", scope: "project" },
      execution: "none",
    })).toBeNull()
  })

  test("reports completeness only when every dependent answer is valid", () => {
    expect(isStudyQuestionnaireAnswerComplete({
      probeId: "probe-M-11",
      snapshotId: "snapshot-task-1",
      desired: { kind: "accurate", presence: "present", scope: "personal" },
      assessed: { kind: "not_remembered", presence: "absent", scope: null },
      execution: "none",
    })).toBe(true)

    expect(isStudyQuestionnaireAnswerComplete({
      probeId: "probe-M-11",
      snapshotId: "snapshot-task-1",
      desired: {
        kind: "needs_edit",
        presence: "present",
        correctedContent: "   ",
        scope: "personal",
      },
      assessed: { kind: "not_remembered", presence: "absent", scope: null },
      execution: "none",
    })).toBe(false)
  })

  test("rejects blank or whitespace-padded probe and snapshot identities", () => {
    const base = {
      desired: { kind: "accurate", presence: "present", scope: "project" },
      assessed: { kind: "full", presence: "present", scope: "project" },
      execution: "full",
    }

    expect(parseStudyQuestionnaireAnswer({ ...base, probeId: " probe-M-12 ", snapshotId: "snapshot-task-1" })).toBeNull()
    expect(parseStudyQuestionnaireAnswer({ ...base, probeId: "probe-M-12", snapshotId: "   " })).toBeNull()
  })

  test("rejects incomplete text and presence or scope contradictions", () => {
    const topLevel = {
      probeId: "probe-invalid",
      snapshotId: "snapshot-task-1",
      execution: "full",
    }
    const validDesired = { kind: "accurate", presence: "present", scope: "project" }
    const validAssessed = { kind: "full", presence: "present", scope: "project" }
    const invalidPairs = [
      {
        desired: validDesired,
        assessed: {
          kind: "partial_or_distorted",
          presence: "present",
          believedContent: "   ",
          scope: "project",
        },
      },
      {
        desired: { kind: "not_intended", presence: "absent", scope: "project" },
        assessed: validAssessed,
      },
      {
        desired: validDesired,
        assessed: { kind: "not_remembered", presence: "absent", scope: "unsure" },
      },
      {
        desired: validDesired,
        assessed: { kind: "unsure", presence: "absent", scope: "unsure" },
      },
    ]

    for (const pair of invalidPairs) {
      expect(parseStudyQuestionnaireAnswer({ ...topLevel, ...pair })).toBeNull()
    }
  })

  test("accepts each of the five execution judgments", () => {
    for (const execution of ["full", "partial", "none", "not_applicable", "unsure"] as const) {
      expect(parseStudyQuestionnaireAnswer({
        probeId: `probe-execution-${execution}`,
        snapshotId: "snapshot-task-1",
        desired: { kind: "accurate", presence: "present", scope: "project" },
        assessed: { kind: "full", presence: "present", scope: "project" },
        execution,
      })?.execution).toBe(execution)
    }
  })
})

describe("study questionnaire answer schema v2", () => {
  const validV2 = {
    probeId: "probe-v2-1",
    snapshotId: "snapshot-task-1",
    desired: { rating: 5, presence: "present", correctedContent: null, scope: "project" },
    assessed: { rating: 3, presence: "present", believedContent: "Only the release half.", scope: "session" },
    execution: 4,
  } as const

  test("parses every valid v2 branch", async () => {
    const { parseStudyQuestionnaireAnswerV2 } = await import("./studyTasks")
    expect(parseStudyQuestionnaireAnswerV2(validV2)).toEqual(validV2)

    // Q1 ratings 1..4 may carry an optional correction; 5 uses the frozen cue.
    for (const rating of [1, 2, 3, 4] as const) {
      expect(parseStudyQuestionnaireAnswerV2({
        ...validV2,
        desired: { rating, presence: "present", correctedContent: "  Remember the exact flag.  ", scope: "personal" },
      })?.desired).toEqual({ rating, presence: "present", correctedContent: "Remember the exact flag.", scope: "personal" })
    }
    expect(parseStudyQuestionnaireAnswerV2({
      ...validV2,
      desired: { rating: 2, presence: "present", correctedContent: null, scope: "project" },
      assessed: { rating: 3, presence: "present", believedContent: null, scope: "session" },
    })).toMatchObject({
      desired: { correctedContent: null },
      assessed: { believedContent: null },
    })

    // Q2 rating 1 = absent, no believed content, no scope.
    expect(parseStudyQuestionnaireAnswerV2({
      ...validV2,
      assessed: { rating: 1, presence: "absent", believedContent: null, scope: null },
    })?.assessed).toEqual({ rating: 1, presence: "absent", believedContent: null, scope: null })

    // Q2 rating 5 uses the cue; one of the three concrete scopes is required.
    for (const scope of ["session", "project", "personal"] as const) {
      expect(parseStudyQuestionnaireAnswerV2({
        ...validV2,
        assessed: { rating: 5, presence: "present", believedContent: null, scope },
      })?.assessed).toEqual({ rating: 5, presence: "present", believedContent: null, scope })
    }

    // Q2 special unknown state: outside the ordinal scale, no content, no scope.
    expect(parseStudyQuestionnaireAnswerV2({
      ...validV2,
      assessed: { rating: "unknown", presence: "unknown", believedContent: null, scope: null },
    })?.assessed).toEqual({ rating: "unknown", presence: "unknown", believedContent: null, scope: null })

    // Q3 accepts 1..5 and the distinct not-applicable state.
    for (const execution of [1, 2, 3, 4, 5, "not_applicable"] as const) {
      expect(parseStudyQuestionnaireAnswerV2({ ...validV2, execution })?.execution).toBe(execution)
    }
  })

  test("accepts blank optional follow-ups as null and rejects illegal scope combinations", async () => {
    const { parseStudyQuestionnaireAnswerV2 } = await import("./studyTasks")
    // Q1 1..4 and Q2 2..4 accept a missing optional explanation as null.
    expect(parseStudyQuestionnaireAnswerV2({
      ...validV2,
      desired: { rating: 2, presence: "present", correctedContent: null, scope: "project" },
    })?.desired).toEqual({ rating: 2, presence: "present", correctedContent: null, scope: "project" })
    expect(parseStudyQuestionnaireAnswerV2({
      ...validV2,
      assessed: { rating: 4, presence: "present", believedContent: null, scope: "project" },
    })?.assessed).toEqual({ rating: 4, presence: "present", believedContent: null, scope: "project" })
    // Q1 5 must not carry a follow-up; every Q1 value requires a scope.
    expect(parseStudyQuestionnaireAnswerV2({
      ...validV2,
      desired: { rating: 5, presence: "present", correctedContent: "extra", scope: "project" },
    })).toBeNull()
    expect(parseStudyQuestionnaireAnswerV2({
      ...validV2,
      desired: { rating: 5, presence: "present", correctedContent: null, scope: null },
    })).toBeNull()
    // Q2 rating 1 and unknown must not carry a scope.
    expect(parseStudyQuestionnaireAnswerV2({
      ...validV2,
      assessed: { rating: 1, presence: "absent", believedContent: null, scope: "project" },
    })).toBeNull()
    expect(parseStudyQuestionnaireAnswerV2({
      ...validV2,
      assessed: { rating: "unknown", presence: "unknown", believedContent: null, scope: "unsure" },
    })).toBeNull()
    // v2 has exactly one unknown branch: the item-level response above.
    // A scope-level unsure value is invalid whenever A_i is present.
    expect(parseStudyQuestionnaireAnswerV2({
      ...validV2,
      assessed: { rating: 3, presence: "present", believedContent: "Partial memory.", scope: "unsure" },
    })).toBeNull()
    expect(parseStudyQuestionnaireAnswerV2({
      ...validV2,
      assessed: { rating: 5, presence: "present", believedContent: null, scope: "unsure" },
    })).toBeNull()
    // Q2 5 with a leftover believed content.
    expect(parseStudyQuestionnaireAnswerV2({
      ...validV2,
      assessed: { rating: 5, presence: "present", believedContent: "stale", scope: "project" },
    })).toBeNull()
  })

  test("rejects midpoint-encoded unknown and presence contradictions", async () => {
    const { parseStudyQuestionnaireAnswerV2 } = await import("./studyTasks")
    // The unknown state is a distinct token, never the midpoint of the scale.
    expect(parseStudyQuestionnaireAnswerV2({
      ...validV2,
      assessed: { rating: 3, presence: "unknown", believedContent: null, scope: null },
    })).toBeNull()
    expect(parseStudyQuestionnaireAnswerV2({
      ...validV2,
      assessed: { rating: "3", presence: "present", believedContent: "text", scope: "project" },
    })).toBeNull()
    expect(parseStudyQuestionnaireAnswerV2({
      ...validV2,
      assessed: { rating: "unknown", presence: "absent", believedContent: null, scope: null },
    })).toBeNull()
  })

  test("rejects v1 vocabulary: not_intended, categorical kinds, and Q3 unsure", async () => {
    const { parseStudyQuestionnaireAnswerV2 } = await import("./studyTasks")
    expect(parseStudyQuestionnaireAnswerV2({
      ...validV2,
      desired: { kind: "not_intended", presence: "absent", scope: null },
    })).toBeNull()
    expect(parseStudyQuestionnaireAnswerV2({
      ...validV2,
      desired: { kind: "accurate", presence: "present", scope: "project" },
    })).toBeNull()
    expect(parseStudyQuestionnaireAnswerV2({ ...validV2, execution: "unsure" })).toBeNull()
    expect(parseStudyQuestionnaireAnswerV2({ ...validV2, execution: "full" })).toBeNull()
    expect(parseStudyQuestionnaireAnswerV2({ ...validV2, execution: 0 })).toBeNull()
    expect(parseStudyQuestionnaireAnswerV2({ ...validV2, execution: 3.5 })).toBeNull()
  })

  test("never accepts a v2 answer through the v1 parser or vice versa", async () => {
    const { parseStudyQuestionnaireAnswer, parseStudyQuestionnaireAnswerV2 } = await import("./studyTasks")
    expect(parseStudyQuestionnaireAnswer(validV2)).toBeNull()
    expect(parseStudyQuestionnaireAnswerV2({
      probeId: "probe-v1",
      snapshotId: "snapshot-task-1",
      desired: { kind: "accurate", presence: "present", scope: "project" },
      assessed: { kind: "full", presence: "present", scope: "project" },
      execution: "full",
    })).toBeNull()
  })
})
