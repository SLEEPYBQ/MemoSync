import type {
  StudyQuestionnaireAnswer,
  StudyQuestionnaireAnswerV2,
  StudyQuestionnaireItem,
  StudyQuestionnaireVersion,
} from "../../../shared/studyTasks"
import {
  applyLegacyStudyQuestionnaireField,
  buildLegacyStudyQuestionnaireAnswer,
  type LegacyStudyQuestionnaireDraft,
} from "./studyQuestionnaireLegacy"
import {
  applyStudyQuestionnaireField,
  buildStudyQuestionnaireAnswer,
  type StudyQuestionnaireDraft,
  type StudyQuizDraftField,
} from "./studyQuestionnaireDraft"

export type VersionedStudyQuestionnaireDraft =
  | { questionnaireVersion: 1; draft: LegacyStudyQuestionnaireDraft }
  | { questionnaireVersion: 2; draft: StudyQuestionnaireDraft }

export function createVersionedStudyQuestionnaireDraft(
  questionnaireVersion: StudyQuestionnaireVersion,
  item: StudyQuestionnaireItem,
): VersionedStudyQuestionnaireDraft {
  const identity = { probeId: item.probeId, snapshotId: item.snapshotId }
  return questionnaireVersion === 1
    ? { questionnaireVersion: 1, draft: identity }
    : { questionnaireVersion: 2, draft: identity }
}

export function applyVersionedStudyQuestionnaireField(
  value: VersionedStudyQuestionnaireDraft,
  field: StudyQuizDraftField,
  answer: string,
): VersionedStudyQuestionnaireDraft {
  return value.questionnaireVersion === 1
    ? {
        questionnaireVersion: 1,
        draft: applyLegacyStudyQuestionnaireField(value.draft, field, answer),
      }
    : {
        questionnaireVersion: 2,
        draft: applyStudyQuestionnaireField(value.draft, field, answer),
      }
}

export function buildVersionedStudyQuestionnaireAnswer(
  value: VersionedStudyQuestionnaireDraft,
): StudyQuestionnaireAnswer | StudyQuestionnaireAnswerV2 | null {
  return value.questionnaireVersion === 1
    ? buildLegacyStudyQuestionnaireAnswer(value.draft)
    : buildStudyQuestionnaireAnswer(value.draft)
}
