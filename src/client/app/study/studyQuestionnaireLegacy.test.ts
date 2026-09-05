import { describe, expect, test } from "bun:test"
import {
  applyLegacyStudyQuestionnaireField,
  buildLegacyStudyQuestionnaireAnswer,
  type LegacyStudyQuestionnaireDraft,
} from "./studyQuestionnaireLegacy"

describe("legacy questionnaire v1 client adapter", () => {
  const base: LegacyStudyQuestionnaireDraft = {
    probeId: "probe-legacy",
    snapshotId: "snapshot-legacy",
  }

  test("builds the exact categorical v1 branches without translating them to ratings", () => {
    let draft = applyLegacyStudyQuestionnaireField(base, "desiredContent", "needs_edit")
    draft = applyLegacyStudyQuestionnaireField(draft, "correctedContent", "  Use pnpm instead.  ")
    draft = applyLegacyStudyQuestionnaireField(draft, "desiredScope", "project")
    draft = applyLegacyStudyQuestionnaireField(draft, "believedContent", "partial_or_distorted")
    draft = applyLegacyStudyQuestionnaireField(draft, "believedContentText", "  The agent remembers npm.  ")
    draft = applyLegacyStudyQuestionnaireField(draft, "believedScope", "unsure")
    draft = applyLegacyStudyQuestionnaireField(draft, "execution", "unsure")

    expect(buildLegacyStudyQuestionnaireAnswer(draft)).toEqual({
      probeId: "probe-legacy",
      snapshotId: "snapshot-legacy",
      desired: {
        kind: "needs_edit",
        presence: "present",
        correctedContent: "Use pnpm instead.",
        scope: "project",
      },
      assessed: {
        kind: "partial_or_distorted",
        presence: "present",
        believedContent: "The agent remembers npm.",
        scope: "unsure",
      },
      execution: "unsure",
    })
  })

  test("preserves legacy absent and unknown semantics and conditional clearing", () => {
    const notIntended = [
      ["desiredContent", "not_intended"],
      ["believedContent", "not_remembered"],
      ["execution", "not_applicable"],
    ] as const
    let draft = { ...base, desiredScope: "personal", believedScope: "project" } as LegacyStudyQuestionnaireDraft
    for (const [field, value] of notIntended) {
      draft = applyLegacyStudyQuestionnaireField(draft, field, value)
    }
    expect(buildLegacyStudyQuestionnaireAnswer(draft)).toMatchObject({
      desired: { kind: "not_intended", presence: "absent", scope: null },
      assessed: { kind: "not_remembered", presence: "absent", scope: null },
      execution: "not_applicable",
    })

    draft = applyLegacyStudyQuestionnaireField(draft, "desiredContent", "accurate")
    draft = applyLegacyStudyQuestionnaireField(draft, "desiredScope", "session")
    draft = applyLegacyStudyQuestionnaireField(draft, "believedContent", "unsure")
    draft = applyLegacyStudyQuestionnaireField(draft, "believedScope", "unsure")
    draft = applyLegacyStudyQuestionnaireField(draft, "execution", "full")
    expect(buildLegacyStudyQuestionnaireAnswer(draft)?.assessed).toEqual({
      kind: "unsure",
      presence: "unknown",
      scope: "unsure",
    })
  })
})
