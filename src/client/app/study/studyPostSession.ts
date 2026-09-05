import {
  RAW_TLX_DIMENSION_IDS,
  RAW_TLX_INSTRUMENT_ID,
  RAW_TLX_INSTRUMENT_VERSION,
  SUS_INSTRUMENT_ID,
  SUS_INSTRUMENT_VERSION,
  SUS_ITEM_IDS,
  parseStudyRawTlxActivityResponse,
  parseStudySusResponse,
  type RawTlxActivity,
  type RawTlxDimensionId,
  type StudyRawTlxActivityResponse,
  type StudySusResponse,
  type SusItemId,
} from "../../../shared/studyScales"

export const STUDY_POST_SESSION_STEPS = [
  "memory_questionnaire",
  "monitoring_tlx",
  "control_tlx",
  "next_session",
  "sus",
  "complete",
] as const

export type StudyPostSessionStep = (typeof STUDY_POST_SESSION_STEPS)[number]

export interface StudyPostSessionPayload {
  taskId: string
  snapshotId: string
  requiredStep: StudyPostSessionStep
  nextTaskId: string | null
  monitoringSubmitted: boolean
  controlSubmitted: boolean
  sessionCompleted: boolean
  susSubmitted: boolean
  /** Server-issued Prolific code; present only after study completion. */
  completionCode?: string | null
  /** Server-configured Prolific return URL; present only after completion. */
  completionUrl?: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export type RawTlxDraft = Partial<Record<RawTlxDimensionId, number>>

export function buildRawTlxResponse(
  activity: RawTlxActivity,
  draft: RawTlxDraft,
): StudyRawTlxActivityResponse | null {
  const ratings = Object.fromEntries(
    RAW_TLX_DIMENSION_IDS.map((dimension) => [dimension, draft[dimension]]),
  )
  return parseStudyRawTlxActivityResponse({
    instrument: RAW_TLX_INSTRUMENT_ID,
    instrumentVersion: RAW_TLX_INSTRUMENT_VERSION,
    activity,
    ratings,
  })
}

export type SusDraft = Partial<Record<SusItemId, number>>

export function buildSusResponse(draft: SusDraft): StudySusResponse | null {
  const ratings = Object.fromEntries(SUS_ITEM_IDS.map((itemId) => [itemId, draft[itemId]]))
  return parseStudySusResponse({
    instrument: SUS_INSTRUMENT_ID,
    instrumentVersion: SUS_INSTRUMENT_VERSION,
    ratings,
  })
}

export function parseStudyPostSessionPayload(raw: unknown): StudyPostSessionPayload | null {
  if (!isRecord(raw)) return null
  const requiredStep = raw.requiredStep as StudyPostSessionStep
  if (
    typeof raw.taskId !== "string"
    || raw.taskId.length === 0
    || typeof raw.snapshotId !== "string"
    || raw.snapshotId.length === 0
    || !STUDY_POST_SESSION_STEPS.includes(requiredStep)
    || (raw.nextTaskId !== null && (typeof raw.nextTaskId !== "string" || raw.nextTaskId.length === 0))
    || (requiredStep === "next_session" && raw.nextTaskId === null)
    || typeof raw.monitoringSubmitted !== "boolean"
    || typeof raw.controlSubmitted !== "boolean"
    || typeof raw.sessionCompleted !== "boolean"
    || typeof raw.susSubmitted !== "boolean"
    || (raw.completionCode !== undefined
      && raw.completionCode !== null
      && (typeof raw.completionCode !== "string" || raw.completionCode.length === 0))
    || (raw.completionUrl !== undefined
      && raw.completionUrl !== null
      && (typeof raw.completionUrl !== "string" || !raw.completionUrl.startsWith("https://app.prolific.com/submissions/complete?")))
  ) return null

  return {
    taskId: raw.taskId,
    snapshotId: raw.snapshotId,
    requiredStep,
    nextTaskId: raw.nextTaskId,
    monitoringSubmitted: raw.monitoringSubmitted,
    controlSubmitted: raw.controlSubmitted,
    sessionCompleted: raw.sessionCompleted,
    susSubmitted: raw.susSubmitted,
    ...(raw.completionCode !== undefined ? { completionCode: raw.completionCode as string | null } : {}),
    ...(raw.completionUrl !== undefined ? { completionUrl: raw.completionUrl as string | null } : {}),
  }
}
