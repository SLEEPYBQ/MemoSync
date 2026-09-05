import {
  isStudyQuestionnaireAnswerV2Complete,
  parseStudyQuestionnaireItem,
  parseStudyQuestionnaireAnswerV2,
  type StudyExecutionAnswerV2,
  type StudyMemoryScope,
  type StudyOrdinalRating,
  type StudyQuestionnaireAnswerV2,
  type StudyQuestionnaireItem,
  type StudyQuestionnaireVersion,
} from "../../../shared/studyTasks"
import type { PublicStudyAttentionCheck } from "../../../shared/studyAttentionChecks"

export interface StudyQuestionnairePayload {
  snapshotId: string
  questionnaireVersion: StudyQuestionnaireVersion
  attentionCheck: PublicStudyAttentionCheck
  submitted?: boolean
  items: StudyQuestionnaireItem[]
}

export function parseStudyQuestionnairePayload(raw: unknown): StudyQuestionnairePayload | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  if (
    typeof record.snapshotId !== "string"
    || !record.snapshotId.trim()
    || record.snapshotId !== record.snapshotId.trim()
  ) return null
  if (record.questionnaireVersion !== 1 && record.questionnaireVersion !== 2) return null
  if (!record.attentionCheck || typeof record.attentionCheck !== "object" || Array.isArray(record.attentionCheck)) return null
  const rawCheck = record.attentionCheck as Record<string, unknown>
  if (
    typeof rawCheck.checkId !== "string"
    || !rawCheck.checkId
    || typeof rawCheck.prompt !== "string"
    || !rawCheck.prompt
    || !Array.isArray(rawCheck.options)
  ) return null
  const attentionOptions: Array<{ value: string; label: string }> = []
  const seenAttentionValues = new Set<string>()
  for (const rawOption of rawCheck.options) {
    if (!rawOption || typeof rawOption !== "object" || Array.isArray(rawOption)) return null
    const option = rawOption as Record<string, unknown>
    if (
      typeof option.value !== "string"
      || !option.value
      || typeof option.label !== "string"
      || !option.label
      || seenAttentionValues.has(option.value)
    ) return null
    seenAttentionValues.add(option.value)
    attentionOptions.push({ value: option.value, label: option.label })
  }
  if (attentionOptions.length < 2) return null
  if (!Array.isArray(record.items)) return null
  if (record.submitted !== undefined && typeof record.submitted !== "boolean") return null
  const items: StudyQuestionnaireItem[] = []
  const seen = new Set<string>()
  for (const entry of record.items) {
    const item = parseStudyQuestionnaireItem(entry)
    if (!item || item.snapshotId !== record.snapshotId || seen.has(item.probeId)) return null
    seen.add(item.probeId)
    items.push(item)
  }
  return {
    snapshotId: record.snapshotId,
    questionnaireVersion: record.questionnaireVersion,
    attentionCheck: {
      checkId: rawCheck.checkId,
      prompt: rawCheck.prompt,
      options: attentionOptions,
    },
    ...(typeof record.submitted === "boolean" ? { submitted: record.submitted } : {}),
    items,
  }
}

/** Questionnaire v2 draft (2026-08-20 ledger §3.3): ordinal ratings plus the
 * explicit out-of-scale states. There is no not_intended and no Q3 unsure. */
export interface StudyQuestionnaireDraft {
  probeId: string
  snapshotId: string
  desiredRating?: StudyOrdinalRating
  correctedContent?: string
  desiredScope?: StudyMemoryScope
  assessedRating?: StudyOrdinalRating | "unknown"
  believedContent?: string
  believedScope?: StudyMemoryScope
  execution?: StudyExecutionAnswerV2
}

export type StudyQuizQuestionField =
  | "desiredContent"
  | "desiredScope"
  | "believedContent"
  | "believedScope"
  | "execution"

/** Radio fields plus the two conditional free-text follow-ups. */
export type StudyQuizDraftField = StudyQuizQuestionField | "correctedContent" | "believedContentText"

export function shouldShowStudyQuestion(
  draft: Partial<Pick<StudyQuestionnaireDraft, "desiredRating" | "assessedRating">>,
  field: StudyQuizQuestionField
): boolean {
  // Every Q1 rating requires a desired scope; the question waits for a rating.
  if (field === "desiredScope") return draft.desiredRating !== undefined
  // Q2 scope applies only when the participant believes something is held
  // (ratings 2..5); absent (1) and the unknown state have no scope.
  if (field === "believedScope") {
    return typeof draft.assessedRating === "number" && draft.assessedRating >= 2
  }
  return true
}

function parseOrdinal(value: string): StudyOrdinalRating | null {
  const rating = Number(value)
  return Number.isInteger(rating) && rating >= 1 && rating <= 5 ? (rating as StudyOrdinalRating) : null
}

/**
 * One pure reducer for every questionnaire input, shared by the production
 * quiz page and the Guide practice so their conditional-clearing rules can
 * never drift apart.
 */
export function applyStudyQuestionnaireField(
  draft: StudyQuestionnaireDraft,
  field: StudyQuizDraftField,
  value: string,
): StudyQuestionnaireDraft {
  const next: StudyQuestionnaireDraft = { ...draft }
  if (field === "desiredContent") {
    const rating = parseOrdinal(value)
    if (rating === null) return draft
    next.desiredRating = rating
    if (rating === 5) delete next.correctedContent
  } else if (field === "correctedContent") {
    next.correctedContent = value
  } else if (field === "desiredScope") {
    next.desiredScope = value as StudyMemoryScope
  } else if (field === "believedContent") {
    if (value === "unknown") {
      next.assessedRating = "unknown"
      delete next.believedContent
      delete next.believedScope
    } else {
      const rating = parseOrdinal(value)
      if (rating === null) return draft
      next.assessedRating = rating
      if (rating === 1) {
        delete next.believedContent
        delete next.believedScope
      } else if (rating === 5) {
        delete next.believedContent
      }
    }
  } else if (field === "believedContentText") {
    next.believedContent = value
  } else if (field === "believedScope") {
    if (value !== "session" && value !== "project" && value !== "personal") return draft
    next.believedScope = value
  } else {
    next.execution = value === "not_applicable" ? "not_applicable" : parseOrdinal(value) ?? draft.execution
  }
  return next
}

export function buildStudyQuestionnaireAnswer(
  draft: StudyQuestionnaireDraft
): StudyQuestionnaireAnswerV2 | null {
  if (draft.desiredRating === undefined || draft.assessedRating === undefined) return null
  const desired = draft.desiredRating === 5
    ? { rating: 5, presence: "present", correctedContent: null, scope: draft.desiredScope }
    : {
        rating: draft.desiredRating,
        presence: "present",
        correctedContent: draft.correctedContent?.trim() || null,
        scope: draft.desiredScope,
      }
  const assessed = draft.assessedRating === "unknown"
    ? { rating: "unknown", presence: "unknown", believedContent: null, scope: null }
    : draft.assessedRating === 1
      ? { rating: 1, presence: "absent", believedContent: null, scope: null }
      : draft.assessedRating === 5
        ? { rating: 5, presence: "present", believedContent: null, scope: draft.believedScope }
        : {
            rating: draft.assessedRating,
            presence: "present",
            believedContent: draft.believedContent?.trim() || null,
            scope: draft.believedScope,
          }
  const raw = {
    probeId: draft.probeId,
    snapshotId: draft.snapshotId,
    desired,
    assessed,
    execution: draft.execution,
  }
  if (!isStudyQuestionnaireAnswerV2Complete(raw)) return null
  return parseStudyQuestionnaireAnswerV2(raw)
}
