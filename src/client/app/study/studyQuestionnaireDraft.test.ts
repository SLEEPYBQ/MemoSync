import { describe, expect, test } from "bun:test"
import {
  applyStudyQuestionnaireField,
  buildStudyQuestionnaireAnswer,
  parseStudyQuestionnairePayload,
  shouldShowStudyQuestion,
  type StudyQuestionnaireDraft,
} from "./studyQuestionnaireDraft"

describe("buildStudyQuestionnaireAnswer (v2)", () => {
  test("builds the canonical answer for top ratings with no follow-ups", () => {
    expect(buildStudyQuestionnaireAnswer({
      probeId: "probe-M-01",
      snapshotId: "snapshot-1",
      desiredRating: 5,
      desiredScope: "project",
      assessedRating: 5,
      believedScope: "personal",
      execution: 4,
    })).toEqual({
      probeId: "probe-M-01",
      snapshotId: "snapshot-1",
      desired: { rating: 5, presence: "present", correctedContent: null, scope: "project" },
      assessed: { rating: 5, presence: "present", believedContent: null, scope: "personal" },
      execution: 4,
    })
  })

  test("canonicalizes the two optional conditional content fields", () => {
    const base: StudyQuestionnaireDraft = {
      probeId: "probe-M-02",
      snapshotId: "snapshot-1",
      desiredRating: 2,
      desiredScope: "project",
      assessedRating: 3,
      believedScope: "session",
      execution: 2,
    }

    expect(buildStudyQuestionnaireAnswer({
      ...base,
      correctedContent: "  Always run the complete release check.  ",
      believedContent: "  The agent remembers only the unit tests.  ",
    })).toEqual({
      probeId: "probe-M-02",
      snapshotId: "snapshot-1",
      desired: {
        rating: 2,
        presence: "present",
        correctedContent: "Always run the complete release check.",
        scope: "project",
      },
      assessed: {
        rating: 3,
        presence: "present",
        believedContent: "The agent remembers only the unit tests.",
        scope: "session",
      },
      execution: 2,
    })
    expect(buildStudyQuestionnaireAnswer({
      ...base,
      correctedContent: "   ",
      believedContent: "   ",
    })).toEqual({
      probeId: "probe-M-02",
      snapshotId: "snapshot-1",
      desired: {
        rating: 2,
        presence: "present",
        correctedContent: null,
        scope: "project",
      },
      assessed: {
        rating: 3,
        presence: "present",
        believedContent: null,
        scope: "session",
      },
      execution: 2,
    })
  })

  test("encodes not-remembered and unknown assessments with no content or scope", () => {
    const base: StudyQuestionnaireDraft = {
      probeId: "probe-M-03",
      snapshotId: "snapshot-1",
      desiredRating: 5,
      desiredScope: "personal",
      execution: "not_applicable",
    }

    expect(buildStudyQuestionnaireAnswer({
      ...base,
      assessedRating: 1,
      believedContent: "stale hidden text",
      believedScope: "personal",
    })?.assessed).toEqual({ rating: 1, presence: "absent", believedContent: null, scope: null })

    expect(buildStudyQuestionnaireAnswer({
      ...base,
      assessedRating: "unknown",
      believedContent: "stale hidden text",
      believedScope: "session",
    })?.assessed).toEqual({ rating: "unknown", presence: "unknown", believedContent: null, scope: null })
  })

  test("stays incomplete until every visible required response exists", () => {
    const incomplete: StudyQuestionnaireDraft = {
      probeId: "probe-M-04",
      snapshotId: "snapshot-1",
      desiredRating: 4,
      correctedContent: "Remember the exact deploy flag.",
      assessedRating: 2,
      believedContent: "Half of it.",
      believedScope: "project",
      execution: 3,
    }
    // Missing desired scope.
    expect(buildStudyQuestionnaireAnswer(incomplete)).toBeNull()
    expect(buildStudyQuestionnaireAnswer({ ...incomplete, desiredScope: "session" })).not.toBeNull()
  })
})

describe("applyStudyQuestionnaireField", () => {
  const base: StudyQuestionnaireDraft = { probeId: "probe-M-05", snapshotId: "snapshot-1" }

  test("clears the corrected content when the desired rating becomes 5", () => {
    let draft = applyStudyQuestionnaireField(base, "desiredContent", "2")
    draft = applyStudyQuestionnaireField(draft, "correctedContent", "Remember X.")
    expect(draft).toMatchObject({ desiredRating: 2, correctedContent: "Remember X." })
    draft = applyStudyQuestionnaireField(draft, "desiredContent", "5")
    expect(draft.desiredRating).toBe(5)
    expect(draft.correctedContent).toBeUndefined()
  })

  test("clears believed content and scope for absent and unknown assessments", () => {
    let draft = applyStudyQuestionnaireField(base, "believedContent", "3")
    draft = applyStudyQuestionnaireField(draft, "believedContentText", "Some half memory.")
    draft = applyStudyQuestionnaireField(draft, "believedScope", "project")
    draft = applyStudyQuestionnaireField(draft, "believedContent", "1")
    expect(draft).toMatchObject({ assessedRating: 1 })
    expect(draft.believedContent).toBeUndefined()
    expect(draft.believedScope).toBeUndefined()

    draft = applyStudyQuestionnaireField(draft, "believedContent", "unknown")
    expect(draft.assessedRating).toBe("unknown")
    expect(draft.believedContent).toBeUndefined()
    expect(draft.believedScope).toBeUndefined()
  })

  test("drops the believed content when the assessed rating becomes 5", () => {
    let draft = applyStudyQuestionnaireField(base, "believedContent", "4")
    draft = applyStudyQuestionnaireField(draft, "believedContentText", "Most of it.")
    draft = applyStudyQuestionnaireField(draft, "believedContent", "5")
    expect(draft.assessedRating).toBe(5)
    expect(draft.believedContent).toBeUndefined()
  })

  test("records the execution rating and the distinct not-applicable state", () => {
    expect(applyStudyQuestionnaireField(base, "execution", "4").execution).toBe(4)
    expect(applyStudyQuestionnaireField(base, "execution", "not_applicable").execution).toBe("not_applicable")
  })

  test("does not admit a second unknown branch through assessed scope", () => {
    const withScope = applyStudyQuestionnaireField(base, "believedScope", "project")
    expect(withScope.believedScope).toBe("project")
    expect(applyStudyQuestionnaireField(withScope, "believedScope", "unsure")).toEqual(withScope)
  })
})

describe("parseStudyQuestionnairePayload", () => {
  const attentionCheck = {
    checkId: "attention-038-s1",
    prompt: "This is an attention check. Select Option B.",
    options: [
      { value: "option_a", label: "Option A" },
      { value: "option_b", label: "Option B" },
    ],
  }

  test("restores a frozen questionnaire without rewriting its full cues", () => {
    const payload = {
      snapshotId: "snapshot-1",
      questionnaireVersion: 2 as const,
      attentionCheck,
      items: [{
        probeId: "probe-M-01",
        snapshotId: "snapshot-1",
        cue: "Run the full accessibility check before every production release, including keyboard navigation and contrast.",
      }],
    }

    expect(parseStudyQuestionnairePayload(payload)).toEqual(payload)
  })

  test("accepts a legitimate zero-item snapshot and rejects cross-snapshot probes", () => {
    expect(parseStudyQuestionnairePayload({ snapshotId: "snapshot-empty", questionnaireVersion: 2, attentionCheck, items: [] })).toEqual({
      snapshotId: "snapshot-empty",
      questionnaireVersion: 2,
      attentionCheck,
      items: [],
    })
    expect(parseStudyQuestionnairePayload({
      snapshotId: "snapshot-1",
      questionnaireVersion: 2,
      attentionCheck,
      items: [{ probeId: "probe-M-01", snapshotId: "snapshot-2", cue: "Use pnpm." }],
    })).toBeNull()
  })

  test("preserves the server's submitted state so reload cannot reopen a completed questionnaire", () => {
    expect(parseStudyQuestionnairePayload({
      snapshotId: "snapshot-submitted",
      questionnaireVersion: 1,
      attentionCheck,
      taskId: "038-S1",
      frozenAt: "2026-08-15T12:00:00.000Z",
      submitted: true,
      items: [],
    })).toEqual({
      snapshotId: "snapshot-submitted",
      questionnaireVersion: 1,
      attentionCheck,
      submitted: true,
      items: [],
    })
  })

  test("requires an explicit supported version so the client never guesses an instrument", () => {
    expect(parseStudyQuestionnairePayload({ snapshotId: "snapshot-1", items: [] })).toBeNull()
    expect(parseStudyQuestionnairePayload({ snapshotId: "snapshot-1", questionnaireVersion: 3, items: [] })).toBeNull()
  })
})

describe("shouldShowStudyQuestion (v2)", () => {
  test("requires a scope for every desired rating and hides it before one is chosen", () => {
    expect(shouldShowStudyQuestion({}, "desiredScope")).toBe(false)
    for (const desiredRating of [1, 2, 3, 4, 5] as const) {
      expect(shouldShowStudyQuestion({ desiredRating }, "desiredScope")).toBe(true)
    }
  })

  test("asks for the assessed scope only for ratings 2..5", () => {
    expect(shouldShowStudyQuestion({}, "believedScope")).toBe(false)
    expect(shouldShowStudyQuestion({ assessedRating: 1 }, "believedScope")).toBe(false)
    expect(shouldShowStudyQuestion({ assessedRating: "unknown" }, "believedScope")).toBe(false)
    for (const assessedRating of [2, 3, 4, 5] as const) {
      expect(shouldShowStudyQuestion({ assessedRating }, "believedScope")).toBe(true)
    }
  })
})
