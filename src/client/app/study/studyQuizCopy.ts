// The post-session quiz wording, verbatim from the study-owner corrections
// (2026-08-20 collaboration ledger §3.3, questionnaire v2) in blinding-safe
// English: every arm says "the agent". Kept as data so the page renders it
// and tests can lock it (option coverage, blinding, no em dashes).
import {
  ASSESSED_UNKNOWN_OPTION,
  DESIRED_SCOPE_OPTIONS,
  EXECUTION_NOT_APPLICABLE_OPTION,
  ORDINAL_RATING_OPTIONS,
} from "../../../shared/studyTasks"
import type { StudyQuizQuestionField } from "./studyQuestionnaireDraft"

export interface QuizQuestion {
  field: StudyQuizQuestionField
  prompt: string
  /** Extra guidance under the prompt (scope explainers). */
  hint?: string
  options: Array<{ value: string; label: string }>
}

export interface QuizSection {
  title: string
  questions: QuizQuestion[]
}

const SCOPE_HINT =
  "Session: only this conversation. Project: future sessions in this project. Personal: all of your projects."

export const CORRECTED_CONTENT_PROMPT =
  "What did you want the agent to remember instead?"

export const BELIEVED_CONTENT_PROMPT =
  "What do you believe the agent currently remembers?"

export const UNKNOWN_ASSESSMENT_NOTE =
  "This response is recorded as a separate unknown state, not as a point on the rating scale. No believed content or scope is collected for it."

const DESIRED_RATING_LABELS: Record<(typeof ORDINAL_RATING_OPTIONS)[number], string> = {
  1: "Not at all accurately",
  2: "Slightly accurately",
  3: "Partly accurately",
  4: "Mostly accurately",
  5: "Completely accurately",
}

const ASSESSED_RATING_LABELS: Record<(typeof ORDINAL_RATING_OPTIONS)[number], string> = {
  1: "Not remembered at all",
  2: "Remembered a little, with major gaps or distortions",
  3: "Remembered partly",
  4: "Remembered mostly, with minor gaps or distortions",
  5: "Remembered fully and accurately",
}

export const ASSESSED_UNKNOWN_LABEL =
  "I do not know whether the agent currently remembers this item."

const EXECUTION_RATING_LABELS: Record<(typeof ORDINAL_RATING_OPTIONS)[number], string> = {
  1: "Not applied at all",
  2: "Applied slightly",
  3: "Applied partly",
  4: "Applied mostly",
  5: "Applied fully",
}

export const EXECUTION_NOT_APPLICABLE_LABEL = "Not applicable to this output"

function ordinalOptions(labels: Record<(typeof ORDINAL_RATING_OPTIONS)[number], string>) {
  return ORDINAL_RATING_OPTIONS.map((rating) => ({
    value: String(rating),
    label: `${rating} · ${labels[rating]}`,
  }))
}

export const QUIZ_SECTIONS: QuizSection[] = [
  {
    title: "1 · What you wanted remembered",
    questions: [
      {
        field: "desiredContent",
        prompt: "How accurately does this memory item express what you wanted the agent to remember?",
        options: ordinalOptions(DESIRED_RATING_LABELS),
      },
      {
        field: "desiredScope",
        prompt: "In which scope do you want it to stay in effect?",
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
        prompt: "How completely and accurately do you believe the agent currently remembers this memory item?",
        options: [
          ...ordinalOptions(ASSESSED_RATING_LABELS),
          { value: ASSESSED_UNKNOWN_OPTION, label: ASSESSED_UNKNOWN_LABEL },
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
        ],
      },
    ],
  },
  {
    title: "3 · Application in this session's output",
    questions: [
      {
        field: "execution",
        prompt: "To what extent did the agent apply this memory item in the output produced during this session?",
        options: [
          ...ordinalOptions(EXECUTION_RATING_LABELS),
          { value: EXECUTION_NOT_APPLICABLE_OPTION, label: EXECUTION_NOT_APPLICABLE_LABEL },
        ],
      },
    ],
  },
]

/** field → the option values its choices must cover exactly (schema lock). */
export const QUIZ_FIELD_OPTIONS: Record<QuizQuestion["field"], readonly string[]> = {
  desiredContent: ORDINAL_RATING_OPTIONS.map(String),
  desiredScope: DESIRED_SCOPE_OPTIONS,
  believedContent: [...ORDINAL_RATING_OPTIONS.map(String), ASSESSED_UNKNOWN_OPTION],
  believedScope: DESIRED_SCOPE_OPTIONS,
  execution: [...ORDINAL_RATING_OPTIONS.map(String), EXECUTION_NOT_APPLICABLE_OPTION],
}
