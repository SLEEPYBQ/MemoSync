import { describe, expect, test } from "bun:test"
import type { StudyQuestionnaireItem } from "../../../shared/studyTasks"
import {
  applyVersionedStudyQuestionnaireField,
  buildVersionedStudyQuestionnaireAnswer,
  createVersionedStudyQuestionnaireDraft,
} from "./studyQuestionnaireInstrument"

const item: StudyQuestionnaireItem = {
  probeId: "probe-resume",
  snapshotId: "snapshot-resume",
  cue: "Use pnpm.",
}

describe("versioned questionnaire client seam", () => {
  test("restores v1 and emits only the legacy categorical representation", () => {
    let draft = createVersionedStudyQuestionnaireDraft(1, item)
    for (const [field, value] of [
      ["desiredContent", "accurate"],
      ["desiredScope", "project"],
      ["believedContent", "full"],
      ["believedScope", "project"],
      ["execution", "full"],
    ] as const) {
      draft = applyVersionedStudyQuestionnaireField(draft, field, value)
    }
    expect(buildVersionedStudyQuestionnaireAnswer(draft)).toMatchObject({
      desired: { kind: "accurate" },
      assessed: { kind: "full" },
      execution: "full",
    })
  })

  test("keeps v2 on the ordinal representation", () => {
    let draft = createVersionedStudyQuestionnaireDraft(2, item)
    for (const [field, value] of [
      ["desiredContent", "5"],
      ["desiredScope", "project"],
      ["believedContent", "5"],
      ["believedScope", "project"],
      ["execution", "5"],
    ] as const) {
      draft = applyVersionedStudyQuestionnaireField(draft, field, value)
    }
    expect(buildVersionedStudyQuestionnaireAnswer(draft)).toMatchObject({
      desired: { rating: 5 },
      assessed: { rating: 5 },
      execution: 5,
    })
  })
})
