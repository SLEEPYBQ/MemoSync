// The experiment's task catalog and post-session quiz schema, straight from
// the study design (MemoSync Experiment Final): each session ends with a
// three-question probe per INJECTED memory item, yielding D_i (desired
// content/scope), A_i (believed content/scope), and the participant's own
// execution judgment; the system snapshots O_i (actual content/scope) behind
// the scenes. Wording is blinding-safe: every arm says "the agent".

// The brief TEXT deliberately lives server-side only (src/server/study-briefs.ts):
// participants must not be able to read a locked task's instructions out of
// the client bundle. This module carries only ids, titles, and the quiz schema.
export interface StudyTask {
  id: string
  /** Neutral display title (no product names, no benchmark jargon). */
  title: string
  /** Stable workspace slug. S1 and S2 deliberately share one project tree. */
  projectSlug: "apartment" | "car"
  /** Participant-facing project title, matching the registered sidebar row. */
  projectTitle: string
}

export const STUDY_TASKS: StudyTask[] = [
  { id: "038-S1", title: "Apartment rentals · Session 1", projectSlug: "apartment", projectTitle: "Apartment rentals" },
  { id: "038-S2", title: "Apartment rentals · Session 2", projectSlug: "apartment", projectTitle: "Apartment rentals" },
  { id: "098-S1", title: "Car rentals · Session 1", projectSlug: "car", projectTitle: "Car rentals" },
  { id: "098-S2", title: "Car rentals · Session 2", projectSlug: "car", projectTitle: "Car rentals" },
]

/** Bump when participant-facing training or task-wrapper rules materially change. */
export const STUDY_GUIDE_VERSION = "2026-08-22-v10"
export const STUDY_BRIEF_VERSION = "v1"

/** Serial gate: completed = D/A/E and both Raw TLX blocks submitted. */
export type StudyTaskStatus = "completed" | "active" | "locked"

export function getStudyTask(id: string): StudyTask | undefined {
  return STUDY_TASKS.find((task) => task.id === id)
}

// --- Quiz schema (one record per injected memory item) ---------------------

export const DESIRED_CONTENT_OPTIONS = ["accurate", "needs_edit", "not_intended"] as const
export const DESIRED_SCOPE_OPTIONS = ["session", "project", "personal"] as const
export const BELIEVED_CONTENT_OPTIONS = ["full", "partial_or_distorted", "not_remembered", "unsure"] as const
export const BELIEVED_SCOPE_OPTIONS = ["session", "project", "personal", "unsure"] as const
export const EXECUTION_OPTIONS = ["full", "partial", "none", "not_applicable", "unsure"] as const

export type StudyMemoryScope = (typeof DESIRED_SCOPE_OPTIONS)[number]
export type StudyAssessedScope = (typeof BELIEVED_SCOPE_OPTIONS)[number]
export type StudyExecutionAnswer = (typeof EXECUTION_OPTIONS)[number]

export type StudyDesiredMemoryAnswer =
  | { kind: "accurate"; presence: "present"; scope: StudyMemoryScope }
  | { kind: "needs_edit"; presence: "present"; correctedContent: string; scope: StudyMemoryScope }
  | { kind: "not_intended"; presence: "absent"; scope: null }

export type StudyAssessedMemoryAnswer =
  | { kind: "full"; presence: "present"; scope: StudyAssessedScope }
  | { kind: "partial_or_distorted"; presence: "present"; believedContent: string; scope: StudyAssessedScope }
  | { kind: "not_remembered"; presence: "absent"; scope: null }
  | { kind: "unsure"; presence: "unknown"; scope: StudyAssessedScope }

/** One frozen probe. `cue` is the last-focused full atomic memory content. */
export interface StudyQuestionnaireItem {
  probeId: string
  snapshotId: string
  cue: string
}

/** Canonical answer tied to one probe in one immutable freeze snapshot. */
export interface StudyQuestionnaireAnswer {
  probeId: string
  snapshotId: string
  desired: StudyDesiredMemoryAnswer
  assessed: StudyAssessedMemoryAnswer
  execution: StudyExecutionAnswer
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys)
  const actual = Object.keys(value)
  return actual.length === expected.size && actual.every((key) => expected.has(key))
}

function includesLiteral<const T extends readonly string[]>(options: T, value: unknown): value is T[number] {
  return typeof value === "string" && options.includes(value)
}

/** Parse a frozen questionnaire item without truncating or rewriting its cue. */
export function parseStudyQuestionnaireItem(raw: unknown): StudyQuestionnaireItem | null {
  if (!isRecord(raw)) return null
  if (!hasExactKeys(raw, ["probeId", "snapshotId", "cue"])) return null
  if (!isNonEmptyString(raw.probeId) || raw.probeId !== raw.probeId.trim()) return null
  if (!isNonEmptyString(raw.snapshotId) || raw.snapshotId !== raw.snapshotId.trim()) return null
  if (!isNonEmptyString(raw.cue)) return null
  return { probeId: raw.probeId, snapshotId: raw.snapshotId, cue: raw.cue }
}

/** Parse an answer into the canonical questionnaire representation. */
export function parseStudyQuestionnaireAnswer(raw: unknown): StudyQuestionnaireAnswer | null {
  if (!isRecord(raw) || !isNonEmptyString(raw.probeId) || !isNonEmptyString(raw.snapshotId)) return null
  if (raw.probeId !== raw.probeId.trim() || raw.snapshotId !== raw.snapshotId.trim()) return null
  if (!hasExactKeys(raw, ["probeId", "snapshotId", "desired", "assessed", "execution"])) return null
  if (!includesLiteral(EXECUTION_OPTIONS, raw.execution)) return null
  if (!isRecord(raw.desired) || !isRecord(raw.assessed)) return null

  let desired: StudyDesiredMemoryAnswer
  if (
    hasExactKeys(raw.desired, ["kind", "presence", "scope"])
    && raw.desired.kind === "accurate"
    && raw.desired.presence === "present"
    && includesLiteral(DESIRED_SCOPE_OPTIONS, raw.desired.scope)
  ) {
    desired = { kind: "accurate", presence: "present", scope: raw.desired.scope }
  } else if (
    hasExactKeys(raw.desired, ["kind", "presence", "correctedContent", "scope"])
    && raw.desired.kind === "needs_edit"
    && raw.desired.presence === "present"
    && isNonEmptyString(raw.desired.correctedContent)
    && includesLiteral(DESIRED_SCOPE_OPTIONS, raw.desired.scope)
  ) {
    desired = {
      kind: "needs_edit",
      presence: "present",
      correctedContent: raw.desired.correctedContent.trim(),
      scope: raw.desired.scope,
    }
  } else if (
    hasExactKeys(raw.desired, ["kind", "presence", "scope"])
    && raw.desired.kind === "not_intended"
    && raw.desired.presence === "absent"
    && raw.desired.scope === null
  ) {
    desired = { kind: "not_intended", presence: "absent", scope: null }
  } else {
    return null
  }

  let assessed: StudyAssessedMemoryAnswer
  if (
    hasExactKeys(raw.assessed, ["kind", "presence", "scope"])
    && raw.assessed.kind === "full"
    && raw.assessed.presence === "present"
    && includesLiteral(BELIEVED_SCOPE_OPTIONS, raw.assessed.scope)
  ) {
    assessed = { kind: "full", presence: "present", scope: raw.assessed.scope }
  } else if (
    hasExactKeys(raw.assessed, ["kind", "presence", "believedContent", "scope"])
    && raw.assessed.kind === "partial_or_distorted"
    && raw.assessed.presence === "present"
    && isNonEmptyString(raw.assessed.believedContent)
    && includesLiteral(BELIEVED_SCOPE_OPTIONS, raw.assessed.scope)
  ) {
    assessed = {
      kind: "partial_or_distorted",
      presence: "present",
      believedContent: raw.assessed.believedContent.trim(),
      scope: raw.assessed.scope,
    }
  } else if (
    hasExactKeys(raw.assessed, ["kind", "presence", "scope"])
    && raw.assessed.kind === "not_remembered"
    && raw.assessed.presence === "absent"
    && raw.assessed.scope === null
  ) {
    assessed = { kind: "not_remembered", presence: "absent", scope: null }
  } else if (
    hasExactKeys(raw.assessed, ["kind", "presence", "scope"])
    && raw.assessed.kind === "unsure"
    && raw.assessed.presence === "unknown"
    && includesLiteral(BELIEVED_SCOPE_OPTIONS, raw.assessed.scope)
  ) {
    assessed = { kind: "unsure", presence: "unknown", scope: raw.assessed.scope }
  } else {
    return null
  }

  return {
    probeId: raw.probeId,
    snapshotId: raw.snapshotId,
    desired,
    assessed,
    execution: raw.execution,
  }
}

/** True only when the draft can be parsed as one complete canonical answer. */
export function isStudyQuestionnaireAnswerComplete(raw: unknown): boolean {
  return parseStudyQuestionnaireAnswer(raw) !== null
}

// --- Quiz schema v2 (study-owner corrections, 2026-08-20 ledger §3.3) -------
//
// v2 replaces the categorical probes with 1..5 ordinal ratings plus explicit
// out-of-scale states: Q2 has one unknown state, Q3 has not_applicable. Q1
// no longer has a not_intended branch. The v1 types above stay untouched so
// legacy submissions remain readable; the two encodings are never cross-parsed.

export type StudyQuestionnaireVersion = 1 | 2
export const STUDY_QUESTIONNAIRE_VERSION = 2 as const

export const ORDINAL_RATING_OPTIONS = [1, 2, 3, 4, 5] as const
export type StudyOrdinalRating = (typeof ORDINAL_RATING_OPTIONS)[number]

/** Q2's unknown state lives outside the 1..5 scale, never at its midpoint. */
export const ASSESSED_UNKNOWN_OPTION = "unknown" as const
/** Q3's not-applicable state, distinct from ordinal value 1 (not applied). */
export const EXECUTION_NOT_APPLICABLE_OPTION = "not_applicable" as const

export type StudyDesiredMemoryAnswerV2 =
  | { rating: 5; presence: "present"; correctedContent: null; scope: StudyMemoryScope }
  | { rating: 1 | 2 | 3 | 4; presence: "present"; correctedContent: string | null; scope: StudyMemoryScope }

export type StudyAssessedMemoryAnswerV2 =
  | { rating: 1; presence: "absent"; believedContent: null; scope: null }
  | { rating: 2 | 3 | 4; presence: "present"; believedContent: string | null; scope: StudyMemoryScope }
  | { rating: 5; presence: "present"; believedContent: null; scope: StudyMemoryScope }
  | { rating: typeof ASSESSED_UNKNOWN_OPTION; presence: "unknown"; believedContent: null; scope: null }

export type StudyExecutionAnswerV2 = StudyOrdinalRating | typeof EXECUTION_NOT_APPLICABLE_OPTION

export interface StudyQuestionnaireAnswerV2 {
  probeId: string
  snapshotId: string
  desired: StudyDesiredMemoryAnswerV2
  assessed: StudyAssessedMemoryAnswerV2
  execution: StudyExecutionAnswerV2
}

function isOrdinalRating(value: unknown): value is StudyOrdinalRating {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5
}

function parseOptionalText(value: unknown): string | null | undefined {
  if (value === null) return null
  if (typeof value !== "string") return undefined
  return value.trim() || null
}

/**
 * Strict v2 parser. Every branch is matched exactly: a missing follow-up,
 * a scope where the branch forbids one, a midpoint-encoded unknown, or any
 * v1 categorical vocabulary (not_intended, kind fields, Q3 unsure) is null.
 */
export function parseStudyQuestionnaireAnswerV2(raw: unknown): StudyQuestionnaireAnswerV2 | null {
  if (!isRecord(raw) || !isNonEmptyString(raw.probeId) || !isNonEmptyString(raw.snapshotId)) return null
  if (raw.probeId !== raw.probeId.trim() || raw.snapshotId !== raw.snapshotId.trim()) return null
  if (!hasExactKeys(raw, ["probeId", "snapshotId", "desired", "assessed", "execution"])) return null
  if (!isRecord(raw.desired) || !isRecord(raw.assessed)) return null

  const execution = raw.execution
  if (!isOrdinalRating(execution) && execution !== EXECUTION_NOT_APPLICABLE_OPTION) return null

  const d = raw.desired
  if (!hasExactKeys(d, ["rating", "presence", "correctedContent", "scope"])) return null
  if (d.presence !== "present" || !includesLiteral(DESIRED_SCOPE_OPTIONS, d.scope)) return null
  let desired: StudyDesiredMemoryAnswerV2
  if (d.rating === 5 && d.correctedContent === null) {
    desired = { rating: 5, presence: "present", correctedContent: null, scope: d.scope }
  } else if (
    isOrdinalRating(d.rating)
    && d.rating !== 5
    && parseOptionalText(d.correctedContent) !== undefined
  ) {
    desired = {
      rating: d.rating,
      presence: "present",
      correctedContent: parseOptionalText(d.correctedContent)!,
      scope: d.scope,
    }
  } else {
    return null
  }

  const a = raw.assessed
  if (!hasExactKeys(a, ["rating", "presence", "believedContent", "scope"])) return null
  let assessed: StudyAssessedMemoryAnswerV2
  if (a.rating === 1 && a.presence === "absent" && a.believedContent === null && a.scope === null) {
    assessed = { rating: 1, presence: "absent", believedContent: null, scope: null }
  } else if (
    a.rating === ASSESSED_UNKNOWN_OPTION
    && a.presence === "unknown"
    && a.believedContent === null
    && a.scope === null
  ) {
    assessed = { rating: "unknown", presence: "unknown", believedContent: null, scope: null }
  } else if (
    a.rating === 5
    && a.presence === "present"
    && a.believedContent === null
    && includesLiteral(DESIRED_SCOPE_OPTIONS, a.scope)
  ) {
    assessed = { rating: 5, presence: "present", believedContent: null, scope: a.scope }
  } else if (
    isOrdinalRating(a.rating)
    && a.rating !== 1
    && a.rating !== 5
    && a.presence === "present"
    && parseOptionalText(a.believedContent) !== undefined
    && includesLiteral(DESIRED_SCOPE_OPTIONS, a.scope)
  ) {
    assessed = {
      rating: a.rating,
      presence: "present",
      believedContent: parseOptionalText(a.believedContent)!,
      scope: a.scope,
    }
  } else {
    return null
  }

  return { probeId: raw.probeId, snapshotId: raw.snapshotId, desired, assessed, execution }
}

/** True only when the draft parses as one complete canonical v2 answer. */
export function isStudyQuestionnaireAnswerV2Complete(raw: unknown): boolean {
  return parseStudyQuestionnaireAnswerV2(raw) !== null
}

/** @deprecated Flat compatibility shape for the existing route/UI migration. */
export interface StudyQuizAnswer {
  memoryId: string
  /** Q1 · D_i: does the item express what the participant wanted remembered? */
  desiredContent: (typeof DESIRED_CONTENT_OPTIONS)[number]
  desiredScope: (typeof DESIRED_SCOPE_OPTIONS)[number]
  /** Q2 · A_i: what the participant believes the agent currently remembers. */
  believedContent: (typeof BELIEVED_CONTENT_OPTIONS)[number]
  believedScope: (typeof BELIEVED_SCOPE_OPTIONS)[number]
  /** Q3 · the participant's own execution judgment for the current output. */
  execution: (typeof EXECUTION_OPTIONS)[number]
}

/** @deprecated Compatibility shape for the existing route/UI migration. */
export interface StudyQuizItem {
  id: string
  summary: string
}
