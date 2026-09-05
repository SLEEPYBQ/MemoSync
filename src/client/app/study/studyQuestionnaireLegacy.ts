import {
  BELIEVED_CONTENT_OPTIONS,
  BELIEVED_SCOPE_OPTIONS,
  DESIRED_CONTENT_OPTIONS,
  DESIRED_SCOPE_OPTIONS,
  EXECUTION_OPTIONS,
  parseStudyQuestionnaireAnswer,
  type StudyAssessedScope,
  type StudyExecutionAnswer,
  type StudyMemoryScope,
  type StudyQuestionnaireAnswer,
} from "../../../shared/studyTasks"
import type { QuizSection } from "./studyQuizCopy"
import type { StudyQuizDraftField } from "./studyQuestionnaireDraft"

export interface LegacyStudyQuestionnaireDraft {
  probeId: string
  snapshotId: string
  desiredKind?: (typeof DESIRED_CONTENT_OPTIONS)[number]
  correctedContent?: string
  desiredScope?: StudyMemoryScope
  assessedKind?: (typeof BELIEVED_CONTENT_OPTIONS)[number]
  believedContent?: string
  believedScope?: StudyAssessedScope
  execution?: StudyExecutionAnswer
}

function includesLiteral<const T extends readonly string[]>(options: T, value: string): value is T[number] {
  return options.includes(value)
}

export function applyLegacyStudyQuestionnaireField(
  draft: LegacyStudyQuestionnaireDraft,
  field: StudyQuizDraftField,
  value: string,
): LegacyStudyQuestionnaireDraft {
  const next = { ...draft }
  if (field === "desiredContent") {
    if (!includesLiteral(DESIRED_CONTENT_OPTIONS, value)) return draft
    next.desiredKind = value
    if (value !== "needs_edit") delete next.correctedContent
    if (value === "not_intended") delete next.desiredScope
  } else if (field === "correctedContent") {
    next.correctedContent = value
  } else if (field === "desiredScope") {
    if (!includesLiteral(DESIRED_SCOPE_OPTIONS, value)) return draft
    next.desiredScope = value
  } else if (field === "believedContent") {
    if (!includesLiteral(BELIEVED_CONTENT_OPTIONS, value)) return draft
    next.assessedKind = value
    if (value !== "partial_or_distorted") delete next.believedContent
    if (value === "not_remembered") delete next.believedScope
  } else if (field === "believedContentText") {
    next.believedContent = value
  } else if (field === "believedScope") {
    if (!includesLiteral(BELIEVED_SCOPE_OPTIONS, value)) return draft
    next.believedScope = value
  } else {
    if (!includesLiteral(EXECUTION_OPTIONS, value)) return draft
    next.execution = value
  }
  return next
}

export function buildLegacyStudyQuestionnaireAnswer(
  draft: LegacyStudyQuestionnaireDraft,
): StudyQuestionnaireAnswer | null {
  if (!draft.desiredKind || !draft.assessedKind || !draft.execution) return null
  const desired = draft.desiredKind === "not_intended"
    ? { kind: "not_intended", presence: "absent", scope: null }
    : draft.desiredKind === "needs_edit"
      ? {
          kind: "needs_edit",
          presence: "present",
          correctedContent: draft.correctedContent,
          scope: draft.desiredScope,
        }
      : { kind: "accurate", presence: "present", scope: draft.desiredScope }
  const assessed = draft.assessedKind === "not_remembered"
    ? { kind: "not_remembered", presence: "absent", scope: null }
    : draft.assessedKind === "partial_or_distorted"
      ? {
          kind: "partial_or_distorted",
          presence: "present",
          believedContent: draft.believedContent,
          scope: draft.believedScope,
        }
      : draft.assessedKind === "full"
        ? { kind: "full", presence: "present", scope: draft.believedScope }
        : { kind: "unsure", presence: "unknown", scope: draft.believedScope }
  return parseStudyQuestionnaireAnswer({
    probeId: draft.probeId,
    snapshotId: draft.snapshotId,
    desired,
    assessed,
    execution: draft.execution,
  })
}

const SCOPE_HINT =
  "Session: only this conversation. Project: future sessions in this project. Personal: all of your projects."

export const LEGACY_QUIZ_SECTIONS: QuizSection[] = [
  {
    title: "1 · What you wanted remembered",
    questions: [
      {
        field: "desiredContent",
        prompt: "Does this memory item accurately express what you wanted the agent to remember?",
        options: [
          { value: "accurate", label: "Yes, it expresses it accurately" },
          { value: "needs_edit", label: "Partially, it would need edits" },
          { value: "not_intended", label: "No, this is not something I intended" },
        ],
      },
      {
        field: "desiredScope",
        prompt: "In which scope did you want it to stay in effect?",
        hint: SCOPE_HINT,
        options: [
          { value: "session", label: "Session" },
          { value: "project", label: "Project" },
          { value: "personal", label: "Personal" },
        ],
      },
    ],
  },
  {
    title: "2 · What you believe the agent remembers",
    questions: [
      {
        field: "believedContent",
        prompt: "What do you believe the agent currently remembers of this item?",
        options: [
          { value: "full", label: "Remembered fully and correctly" },
          { value: "partial_or_distorted", label: "Only partially, or with distortions" },
          { value: "not_remembered", label: "Not remembered" },
          { value: "unsure", label: "I am not sure" },
        ],
      },
      {
        field: "believedScope",
        prompt: "In which scope do you believe the agent currently keeps it?",
        hint: SCOPE_HINT,
        options: [
          { value: "session", label: "Session" },
          { value: "project", label: "Project" },
          { value: "personal", label: "Personal" },
          { value: "unsure", label: "I am not sure" },
        ],
      },
    ],
  },
  {
    title: "3 · Application in this session's output",
    questions: [{
      field: "execution",
      prompt: "Did the agent apply this item in the output it produced this session?",
      options: [
        { value: "full", label: "Fully applied" },
        { value: "partial", label: "Partially applied" },
        { value: "none", label: "Not applied" },
        { value: "not_applicable", label: "Not applicable to this output" },
        { value: "unsure", label: "I am not sure" },
      ],
    }],
  },
]
