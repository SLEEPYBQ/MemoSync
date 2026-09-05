import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs"
import {
  basename,
  dirname,
  isAbsolute as pathIsAbsolute,
  join,
  relative as relativePath,
  resolve,
  sep as pathSeparator,
} from "node:path"
import {
  calculateRawTlxScore,
  calculateSusScore,
  parseStudyRawTlxActivityResponse,
  parseStudySusResponse,
  type StudyRawTlxActivityResponse,
  type StudySusResponse,
} from "../../shared/studyScales"
import {
  STUDY_TASKS,
  parseStudyQuestionnaireAnswer,
  parseStudyQuestionnaireAnswerV2,
  type StudyAssessedMemoryAnswer,
  type StudyAssessedMemoryAnswerV2,
  type StudyDesiredMemoryAnswer,
  type StudyDesiredMemoryAnswerV2,
  type StudyExecutionAnswer,
  type StudyExecutionAnswerV2,
  type StudyOrdinalRating,
  type StudyQuestionnaireAnswer,
  type StudyQuestionnaireAnswerV2,
  type StudyQuestionnaireVersion,
} from "../../shared/studyTasks"
import {
  scoreStudyAttentionCheck,
  type StudyAttentionCheckResult,
} from "../../shared/studyAttentionChecks"
import {
  freezeQuestionnaireVersion,
  type FrozenStudyMemoryState,
  type StudyFocusOccurrence,
  type StudyFreezeItem,
  type StudyFreezeSnapshot,
  type StudyTelemetryEvent,
} from "./study-memory-store"
import {
  verifyStudyWorkspaceSnapshot,
  type StudyWorkspaceSnapshotMetadata,
} from "../study-workspace-snapshot"
import {
  STUDY_AGENT_MEMORY_EXPERIENCE,
  STUDY_AGENT_TOOLS,
  STUDY_AGENT_USE_FREQUENCIES,
  STUDY_ONBOARDING_GENDERS,
  type StudyOnboardingBriefing,
  type StudyOnboardingConsent,
  type StudyOnboardingInformation,
} from "../../shared/studyOnboarding"

const REQUIRED_STUDY_TABLES = [
  "study_freeze_snapshots",
  "study_questionnaire_submissions",
  "study_raw_tlx_submissions",
  "study_session_completions",
  "study_sus_submissions",
  "study_telemetry_events",
] as const

const KNOWN_TASK_IDS = new Set(STUDY_TASKS.map((task) => task.id))
const KNOWN_CONDITIONS = new Set(["memosync", "auto", "static"])

export type StudyAllocationMode = "study" | "internal_qa"
export type ExportedSessionStatus =
  | "not_started"
  | "frozen"
  | "questionnaire_submitted"
  | "monitoring_tlx_submitted"
  | "completed"

export interface StudyAllocationManifest {
  schemaVersion: 1
  participantId: string
  allocationMode: StudyAllocationMode
  condition: "memosync" | "auto" | "static"
  studyTaskOrder: string[]
  issuedAt: string
  claimedAt: string | null
}

/**
 * Actual E_i is evaluator evidence from the frozen output, never the
 * participant's questionnaire judgment. The current study database does not
 * persist it, so callers supply an adapter only after a benchmark/judge run.
 */
export type ActualExecutionVerdict =
  | "fully_realized"
  | "partially_realized"
  | "not_realized"
  | "not_applicable"
  | "uncertain"

export interface ActualExecutionEvidence {
  verdict: ActualExecutionVerdict
  /** Binary projection used only for fully/not realized; every other verdict is null. */
  realized: boolean | null
  evaluator: {
    name: string
    version: string
    model: string
  }
  evaluatedAt: string
  evidenceRef: string
  evidenceSha256: string
  binding: {
    snapshotId: string
    workspaceTreeHash: string
    desiredContentSha256: string
  }
}

export interface ActualExecutionEvidenceQuery {
  participantId: string
  taskId: string
  probeId: string
  desired: ExportedDesiredMemory | null
  workspaceSnapshot: StudyFreezeSnapshot["workspaceSnapshot"] | null
}

/** The seam where a later FullStack-Bench-backed E_i judge plugs in. */
export interface ActualExecutionEvidenceAdapter {
  readonly name: string
  resolve(query: ActualExecutionEvidenceQuery): ActualExecutionEvidence | null
  /** Fail closed when signed evaluator rows did not bind to a canonical frozen probe. */
  assertFullyConsumed?(): void
}

export const missingActualExecutionEvidence: ActualExecutionEvidenceAdapter = {
  name: "missing",
  resolve: () => null,
}

export interface JsonActualExecutionEvidenceDocument {
  schemaVersion: 2
  records: Array<{
    participantId: string
    taskId: string
    snapshotId: string
    probeId: string
    workspaceTreeHash: string
    desiredContentSha256: string
    verdict: ActualExecutionVerdict
    evaluator: {
      name: string
      version: string
      model: string
    }
    evaluatedAt: string
    evidenceRef: string
    evidenceSha256: string
  }>
}

export interface ExportedDesiredMemory {
  presence: "present" | "absent"
  content: string | null
  scope: "session" | "project" | "personal" | null
  /** v1 categorical response; null for a v2 (ordinal) answer. */
  responseKind: StudyDesiredMemoryAnswer["kind"] | null
  /** v2 raw ordinal rating; null for a v1 (categorical) answer. */
  rating: StudyOrdinalRating | null
}

export interface ExportedAssessedMemory {
  presence: "present" | "absent" | "unknown"
  content: string | null
  scope: "session" | "project" | "personal" | "unsure" | null
  /** v1 categorical response; null for a v2 (ordinal) answer. */
  responseKind: StudyAssessedMemoryAnswer["kind"] | null
  /** v2 raw rating or its explicit unknown state; null for a v1 answer. */
  rating: StudyOrdinalRating | "unknown" | null
}

export type DerivedMeasurementStatus = "available" | "unknown" | "missing" | "not_applicable" | "unavailable"

export interface ExportedStateComparison {
  status: DerivedMeasurementStatus
  exactMatch: boolean | null
  contentMatch: boolean | null
  scopeMatch: boolean | null
  reason:
    | "questionnaire_not_submitted"
    | "assessed_memory_unknown"
    | "assessed_scope_unknown"
    | "object_state_incomplete"
    | null
}

export interface ExportedPerceivedDiscrepancy {
  status: DerivedMeasurementStatus
  discrepant: boolean | null
  contentDiscrepant: boolean | null
  scopeDiscrepant: boolean | null
  reason: "questionnaire_not_submitted" | "assessed_memory_unknown" | "assessed_scope_unknown" | null
}

export interface ExportedControlAccuracy {
  status: DerivedMeasurementStatus
  realized: boolean | null
  reason:
    | "questionnaire_not_submitted"
    | "desired_memory_absent"
    | "actual_execution_missing"
    | "actual_execution_partial_unscored"
    | "actual_execution_not_applicable"
    | "actual_execution_uncertain"
    | null
}

export interface ExportedMemoryMeasurements {
  /** Strict equality of canonical A_i and O_i Memory States. */
  monitoringAccuracy: ExportedStateComparison
  /** Strict equality of canonical D_i and O_i Memory States. */
  memoryAlignment: ExportedStateComparison
  /** Strict inequality of canonical D_i and A_i Memory States. */
  perceivedDiscrepancy: ExportedPerceivedDiscrepancy
  /** D_i realization, available only from external actual E_i evidence. */
  controlAccuracy: ExportedControlAccuracy
}

export interface ExportedRawTlx {
  submissionId: string
  submittedAt: string
  payloadHash: string
  response: StudyRawTlxActivityResponse
  score: number
}

export interface ExportedSus {
  submissionId: string
  submittedAt: string
  payloadHash: string
  response: StudySusResponse
  score: number
}

export interface StudyParticipantRow {
  participantId: string
  allocationMode: StudyAllocationMode
  condition: StudyAllocationManifest["condition"]
  taskOrder: string[]
  issuedAt: string
  claimedAt: string | null
  onboarding: ExportedStudyOnboarding | null
  sus: ExportedSus | null
  /** Durable Prolific completion-code issuance evidence. */
  completionReceipt: ExportedCompletionReceipt | null
}

export interface ExportedCompletionReceipt {
  participantId: string
  susSubmissionId: string
  code: string
  codeVersion: string
  issuedAt: string
}

export interface ExportedStudyOnboarding extends StudyOnboardingInformation {
  informationSubmittedAt: string
  consent: StudyOnboardingConsent | null
  briefing: StudyOnboardingBriefing | null
}

export interface StudySessionRow {
  participantId: string
  allocationMode: StudyAllocationMode
  condition: StudyAllocationManifest["condition"]
  task: {
    id: string
    title: string
    orderIndex: number
    projectSlug: "apartment" | "car"
    projectTitle: string
    projectOrderIndex: number
    sessionIndexWithinProject: number
  }
  lifecycle: {
    status: ExportedSessionStatus
    snapshotId: string | null
    frozenAt: string | null
    questionnaireVersion: StudyQuestionnaireVersion | null
    questionnaireSubmittedAt: string | null
    completedAt: string | null
  }
  /** Null only for pilot submissions created before the formal checks. */
  attentionCheck: StudyAttentionCheckResult | null
  workspaceSnapshot: StudyFreezeSnapshot["workspaceSnapshot"] | null
  freezeQualityFlags: string[]
  monitoringRawTlx: ExportedRawTlx | null
  controlRawTlx: ExportedRawTlx | null
  sus: ExportedSus | null
  memoryItemCount: number
  actualExecutionAvailableCount: number
  actualExecutionPartialCount: number
  actualExecutionMissingCount: number
  actualExecutionNotApplicableCount: number
  actualExecutionUncertainCount: number
}

export interface StudyMemoryItemRow {
  participantId: string
  allocationMode: StudyAllocationMode
  condition: StudyAllocationManifest["condition"]
  taskId: string
  taskOrderIndex: number
  projectSlug: "apartment" | "car"
  snapshotId: string
  frozenAt: string
  probeId: string
  identity: StudyFreezeItem["identity"]
  cue: StudyFreezeItem["cue"]
  /** The questionnaire instrument governing this item's answers. */
  questionnaireVersion: StudyQuestionnaireVersion
  desired: ExportedDesiredMemory | null
  assessed: ExportedAssessedMemory | null
  object: FrozenStudyMemoryState
  /** Self-report only (v1 categorical or v2 rating); never actual E_i. */
  participantExecutionJudgment: StudyExecutionAnswer | StudyExecutionAnswerV2 | null
  actualExecution: ActualExecutionEvidence | null
  actualExecutionStatus: "available" | "partial" | "missing" | "not_applicable" | "uncertain"
  controlAccuracyEligible: boolean | null
  measurements: ExportedMemoryMeasurements
  injectionHistory: StudyFocusOccurrence[]
  qualityFlags: string[]
  finalLineage: StudyFreezeItem["finalLineage"] | null
  workspaceSnapshot: StudyFreezeSnapshot["workspaceSnapshot"] | null
}

export interface StudyDataSourceReceipt {
  participantId: string
  databaseSha256: string
  allocationManifestSha256: string
}

export interface StudyDataExport {
  schemaVersion: 6
  actualExecutionEvidenceAdapter: string
  sources: StudyDataSourceReceipt[]
  excludedParticipants: Array<{
    participantId: string
    allocationMode: StudyAllocationMode
    reason: "internal_qa"
  }>
  participants: StudyParticipantRow[]
  sessions: StudySessionRow[]
  memoryItems: StudyMemoryItemRow[]
  /** Raw server-authoritative behavior/timing rows; Raw TLX remains separate. */
  interactions: StudyTelemetryEvent[]
  /** Every raw kind=control row across all arms; standalone actions stay observed. */
  controlActions: ExportedControlAction[]
  /** Only operations that carry attempted/terminal phases. */
  controlOperations: ExportedControlOperation[]
  interactionIntervals: ExportedStudyInteractionInterval[]
  /** Client-observed visibility intervals; not cognitive or active-thinking time. */
  surfaceExposureIntervals: ExportedStudySurfaceExposureInterval[]
  stageIntervals: ExportedStudyStageInterval[]
}

export interface ExportedControlAction {
  eventId: string
  participantId: string
  allocationMode: StudyAllocationMode
  condition: StudyAllocationManifest["condition"]
  taskId: string | null
  chatId: string | null
  serverTimestamp: string
  clientTimestamp: string | null
  surface: string
  action: string
  operationId: string | null
  controlType: string | null
  evidenceKind: "observed" | "phased_operation"
  outcome: "observed" | "completed" | "failed" | "incomplete"
  terminalTimestamp: string | null
  payload: Record<string, unknown>
}

export interface ExportedControlOperation {
  participantId: string
  allocationMode: StudyAllocationMode
  condition: StudyAllocationManifest["condition"]
  taskId: string
  operationId: string
  surface: string
  action: string
  controlType: string
  attemptedAt: string | null
  completedAt: string | null
  failedAt: string | null
  outcome: "incomplete" | "completed" | "failed"
}

export interface ExportedStudyInteractionInterval {
  participantId: string
  allocationMode: StudyAllocationMode
  condition: StudyAllocationManifest["condition"]
  taskId: string
  operationId: string
  interval: "static_memory_edit"
  enteredAt: string | null
  submittedAt: string | null
  durationMs: number | null
  clientDurationMs: number | null
  status: "available" | "client_only" | "late_entered" | "missing_entered" | "missing_submitted" | "missing_both"
}

export interface ExportedStudySurfaceExposureTransition {
  eventId: string
  sequence: number | null
  transition: string
  clientTimestamp: string | null
  serverRecordedAt: string
}

export interface ExportedStudySurfaceExposureInterval {
  exposureId: string
  participantId: string
  allocationMode: StudyAllocationMode
  condition: StudyAllocationManifest["condition"]
  taskId: string | null
  chatId: string | null
  surface: string
  initiator: "participant" | "system" | null
  memoryIds: string[]
  closeReason: string | null
  clientOpenedAt: string | null
  clientClosedAt: string | null
  clientVisibleDurationMs: number | null
  serverReceiptSpanMs: number | null
  status: "available" | "missing_closed" | "invalid"
  serverRecordedTransitions: ExportedStudySurfaceExposureTransition[]
}

export type ExportedStudyStage =
  | "whole_study"
  | "session_exposure"
  | "active_session"
  | "memory_questionnaire"
  | "monitoring_tlx"
  | "control_tlx"
  | "sus"

export interface ExportedStudyStageInterval {
  participantId: string
  allocationMode: StudyAllocationMode
  condition: StudyAllocationManifest["condition"]
  taskId: string | null
  stage: ExportedStudyStage
  enteredAt: string | null
  submittedAt: string | null
  durationMs: number | null
  status: "available" | "missing_entered" | "missing_submitted" | "missing_both"
}

export interface BuildStudyDataExportInput {
  participantDataDirs: string[]
  includeInternalQa?: boolean
  actualExecutionEvidence?: ActualExecutionEvidenceAdapter
}

interface ParticipantStudyPaths {
  dataDir: string
  experimentsDir: string
  databasePath: string
  allocationManifestPath: string
}

interface FreezeRow {
  snapshot_id: string
  task_id: string
  frozen_at: string
  payload_json: string
}

interface QuestionnaireRow {
  submission_id: string
  snapshot_id: string
  submitted_at: string
  questionnaire_version: number
  answers_json: string
  attention_check_id: string | null
  attention_check_answer: string | null
  attention_check_passed: number | null
  payload_hash: string
}

interface RawTlxRow {
  submission_id: string
  snapshot_id: string
  activity: "monitoring" | "control"
  submitted_at: string
  response_json: string
  payload_hash: string
}

interface CompletionRow {
  completion_id: string
  task_id: string
  snapshot_id: string
  completed_at: string
}

interface SusRow {
  submission_id: string
  submitted_at: string
  response_json: string
  payload_hash: string
}

interface CompletionReceiptRow {
  participant_id: string
  sus_submission_id: string
  code: string
  code_version: string
  issued_at: string
}

interface OnboardingRow {
  participant_id: string
  prolific_id: string
  age: number
  gender: string
  agent_memory_experience: string
  agent_use_frequency: string
  agent_tools_json: string
  information_submitted_at: string
  consent_version: string | null
  consent_accepted_at: string | null
  briefing_version: string | null
  briefing_completed_at: string | null
}

interface TelemetryRow {
  event_id: string
  recorded_at: string
  client_timestamp: string | null
  participant_id: string
  task_id: string | null
  session_id: string | null
  chat_id: string | null
  condition: "memosync" | "auto" | "static"
  kind: StudyTelemetryEvent["kind"]
  surface: string
  action: string
  payload_json: string
}

interface ParticipantDatabaseRecords {
  freezes: FreezeRow[]
  questionnaires: QuestionnaireRow[]
  rawTlx: RawTlxRow[]
  completions: CompletionRow[]
  sus: SusRow | null
  completionReceipt: CompletionReceiptRow | null
  onboarding: OnboardingRow | null
  telemetry: TelemetryRow[]
}

export class StudyDataExportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StudyDataExportError"
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new StudyDataExportError(`${label} must be a non-empty string`)
  }
  return value
}

function requireSha256(value: unknown, label: string): string {
  const hash = requireNonEmptyString(value, label)
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new StudyDataExportError(`${label} must be a lowercase SHA-256 digest`)
  }
  return hash
}

function requireIsoTimestamp(value: unknown, label: string): string {
  const timestamp = requireNonEmptyString(value, label)
  const parsed = new Date(timestamp)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    throw new StudyDataExportError(`${label} must be a canonical ISO timestamp`)
  }
  return timestamp
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function locateParticipantStudyPaths(inputPath: string): ParticipantStudyPaths {
  const source = resolve(inputPath)
  let dataDir: string
  let experimentsDir: string
  let databasePath: string

  if (basename(source) === "study.sqlite") {
    databasePath = source
    experimentsDir = dirname(source)
    dataDir = dirname(experimentsDir)
  } else if (existsSync(join(source, "experiments", "study.sqlite"))) {
    dataDir = source
    experimentsDir = join(source, "experiments")
    databasePath = join(experimentsDir, "study.sqlite")
  } else if (existsSync(join(source, "study.sqlite"))) {
    experimentsDir = source
    dataDir = dirname(source)
    databasePath = join(source, "study.sqlite")
  } else {
    throw new StudyDataExportError(`No experiments/study.sqlite found under ${source}`)
  }

  const allocationManifestPath = join(experimentsDir, "study-allocation.json")
  if (!existsSync(allocationManifestPath)) {
    throw new StudyDataExportError(`Missing study-allocation.json beside ${databasePath}`)
  }
  return { dataDir, experimentsDir, databasePath, allocationManifestPath }
}

/** Resolve the participant data root that owns a canonical study.sqlite source. */
export function resolveParticipantStudyDataDir(inputPath: string): string {
  return locateParticipantStudyPaths(inputPath).dataDir
}

/**
 * Accept either one participant data directory or an orchestrator data root.
 * Discovery never reads events.jsonl.
 */
export function discoverParticipantDataDirs(sourcePath: string): string[] {
  const source = resolve(sourcePath)
  const participantsDir = join(source, "participants")
  if (!existsSync(participantsDir)) return [locateParticipantStudyPaths(source).dataDir]

  const found = readdirSync(participantsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(participantsDir, entry.name, "data"))
    .filter((dataDir) => existsSync(join(dataDir, "experiments", "study.sqlite")))
    .sort()
  if (found.length === 0) {
    throw new StudyDataExportError(`No participant study data found under ${participantsDir}`)
  }
  return found
}

function parseAllocationManifest(path: string): StudyAllocationManifest {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    throw new StudyDataExportError(`Could not parse ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isRecord(raw) || raw.schemaVersion !== 1) {
    throw new StudyDataExportError(`${path} is not a supported study allocation manifest`)
  }
  const participantId = requireNonEmptyString(raw.participantId, "participantId")
  if (raw.allocationMode !== "study" && raw.allocationMode !== "internal_qa") {
    throw new StudyDataExportError(`Invalid allocationMode for ${participantId}`)
  }
  if (typeof raw.condition !== "string" || !KNOWN_CONDITIONS.has(raw.condition)) {
    throw new StudyDataExportError(`Invalid condition for ${participantId}`)
  }
  if (
    !Array.isArray(raw.studyTaskOrder)
    || raw.studyTaskOrder.length !== STUDY_TASKS.length
    || new Set(raw.studyTaskOrder).size !== STUDY_TASKS.length
    || raw.studyTaskOrder.some((taskId) => typeof taskId !== "string" || !KNOWN_TASK_IDS.has(taskId))
  ) {
    throw new StudyDataExportError(`Invalid studyTaskOrder for ${participantId}`)
  }
  return {
    schemaVersion: 1,
    participantId,
    allocationMode: raw.allocationMode,
    condition: raw.condition as StudyAllocationManifest["condition"],
    studyTaskOrder: [...raw.studyTaskOrder] as string[],
    issuedAt: requireNonEmptyString(raw.issuedAt, "issuedAt"),
    claimedAt: raw.claimedAt === null ? null : requireNonEmptyString(raw.claimedAt, "claimedAt"),
  }
}

function readParticipantDatabase(path: string): ParticipantDatabaseRecords {
  let db: Database
  try {
    db = new Database(path, { readonly: true, create: false })
  } catch (error) {
    throw new StudyDataExportError(`Could not open ${path} read-only: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    const tableRows = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    const tables = new Set(tableRows.map((row) => row.name))
    const missing = REQUIRED_STUDY_TABLES.filter((table) => !tables.has(table))
    if (missing.length > 0) {
      throw new StudyDataExportError(`Study database is missing required tables: ${missing.join(", ")}`)
    }

    db.exec("BEGIN")
    try {
      // A legacy database that never ran the store migration has no
      // questionnaire_version column; its rows are questionnaire v1.
      const questionnaireColumns = db
        .query("PRAGMA table_info(study_questionnaire_submissions)")
        .all() as Array<{ name: string }>
      const versionSelect = questionnaireColumns.some((column) => column.name === "questionnaire_version")
        ? "questionnaire_version"
        : "1 AS questionnaire_version"
      const attentionSelect = ["attention_check_id", "attention_check_answer", "attention_check_passed"]
        .every((name) => questionnaireColumns.some((column) => column.name === name))
        ? "attention_check_id, attention_check_answer, attention_check_passed"
        : "NULL AS attention_check_id, NULL AS attention_check_answer, NULL AS attention_check_passed"
      const records: ParticipantDatabaseRecords = {
        freezes: db.query(`
          SELECT snapshot_id, task_id, frozen_at, payload_json
            FROM study_freeze_snapshots
           ORDER BY frozen_at, task_id
        `).all() as FreezeRow[],
        questionnaires: db.query(`
          SELECT submission_id, snapshot_id, submitted_at, ${versionSelect}, answers_json,
                 ${attentionSelect}, payload_hash
            FROM study_questionnaire_submissions
           ORDER BY submitted_at, snapshot_id
        `).all() as QuestionnaireRow[],
        rawTlx: db.query(`
          SELECT submission_id, snapshot_id, activity, submitted_at, response_json, payload_hash
            FROM study_raw_tlx_submissions
           ORDER BY submitted_at, snapshot_id, activity
        `).all() as RawTlxRow[],
        completions: db.query(`
          SELECT completion_id, task_id, snapshot_id, completed_at
            FROM study_session_completions
           ORDER BY completed_at, task_id
        `).all() as CompletionRow[],
        sus: db.query(`
          SELECT submission_id, submitted_at, response_json, payload_hash
            FROM study_sus_submissions
           WHERE singleton = 1
        `).get() as SusRow | null,
        // Legacy databases predate the durable completion receipt.
        completionReceipt: tables.has("study_completion_receipts")
          ? db.query(`
              SELECT participant_id, sus_submission_id, code, code_version, issued_at
                FROM study_completion_receipts
               WHERE singleton = 1
            `).get() as CompletionReceiptRow | null
          : null,
        onboarding: tables.has("study_participant_onboarding")
          ? db.query(`
              SELECT participant_id, prolific_id, age, gender, agent_memory_experience,
                     agent_use_frequency, agent_tools_json, information_submitted_at,
                     consent_version, consent_accepted_at, briefing_version, briefing_completed_at
                FROM study_participant_onboarding
               WHERE singleton = 1
            `).get() as OnboardingRow | null
          : null,
        telemetry: db.query(`
          SELECT event_id, recorded_at, client_timestamp, participant_id,
                 task_id, session_id, chat_id, condition, kind, surface,
                 action, payload_json
            FROM study_telemetry_events
           ORDER BY seq ASC
        `).all() as TelemetryRow[],
      }
      db.exec("COMMIT")
      return records
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
    }
  } finally {
    db.close()
  }
}

function parseFreeze(row: FreezeRow): StudyFreezeSnapshot {
  const raw = JSON.parse(row.payload_json) as unknown
  if (
    !isRecord(raw)
    || (raw.schemaVersion !== 1 && raw.schemaVersion !== 2)
    || (raw.questionnaireVersion !== undefined && raw.questionnaireVersion !== 1 && raw.questionnaireVersion !== 2)
    || raw.snapshotId !== row.snapshot_id
    || raw.taskId !== row.task_id
    || raw.frozenAt !== row.frozen_at
    || !Array.isArray(raw.items)
    || !Array.isArray(raw.qualityFlags)
  ) {
    throw new StudyDataExportError(`Invalid freeze snapshot payload for ${row.snapshot_id}`)
  }
  if (!raw.qualityFlags.every((flag) => typeof flag === "string")) {
    throw new StudyDataExportError(`Invalid freeze quality flags for ${row.snapshot_id}`)
  }
  const seenProbes = new Set<string>()
  for (const [index, value] of raw.items.entries()) {
    if (!isRecord(value) || !isRecord(value.identity) || !isRecord(value.cue) || !isRecord(value.object)) {
      throw new StudyDataExportError(`Invalid freeze item ${index} for ${row.snapshot_id}`)
    }
    const probeId = requireNonEmptyString(value.probeId, `freeze item ${index} probeId`)
    if (seenProbes.has(probeId)) throw new StudyDataExportError(`Duplicate freeze probe ${probeId}`)
    seenProbes.add(probeId)
    requireNonEmptyString(value.identity.scheme, `freeze item ${index} identity scheme`)
    requireNonEmptyString(value.identity.id, `freeze item ${index} identity id`)
    requireNonEmptyString(value.cue.content, `freeze item ${index} cue content`)
    if (typeof value.object.present !== "boolean" || !Array.isArray(value.history) || !Array.isArray(value.qualityFlags)) {
      throw new StudyDataExportError(`Invalid freeze state/history for ${probeId}`)
    }
  }
  if (raw.workspaceSnapshot !== undefined) {
    if (
      !isRecord(raw.workspaceSnapshot)
      || raw.workspaceSnapshot.taskId !== row.task_id
      || raw.workspaceSnapshot.snapshotId !== row.snapshot_id
      || raw.workspaceSnapshot.frozenAt !== row.frozen_at
    ) {
      throw new StudyDataExportError(`Workspace snapshot metadata does not match freeze ${row.snapshot_id}`)
    }
  }
  return raw as unknown as StudyFreezeSnapshot
}

function parseQuestionnaireAnswers(
  row: QuestionnaireRow,
  snapshot: StudyFreezeSnapshot,
): Map<string, StudyQuestionnaireAnswer | StudyQuestionnaireAnswerV2> {
  if (row.questionnaire_version !== 1 && row.questionnaire_version !== 2) {
    throw new StudyDataExportError(`Questionnaire ${row.submission_id} has invalid questionnaire version ${row.questionnaire_version}`)
  }
  // The submission must use the instrument its immutable snapshot froze with;
  // old categorical answers and new ordinal answers are never cross-parsed.
  if (row.questionnaire_version !== freezeQuestionnaireVersion(snapshot)) {
    throw new StudyDataExportError(
      `Questionnaire ${row.submission_id} questionnaire version ${row.questionnaire_version} `
      + `contradicts freeze snapshot ${snapshot.snapshotId} (questionnaire version ${freezeQuestionnaireVersion(snapshot)})`,
    )
  }
  const raw = JSON.parse(row.answers_json) as unknown
  if (!Array.isArray(raw)) throw new StudyDataExportError(`Questionnaire ${row.submission_id} answers are not an array`)
  const answers = new Map<string, StudyQuestionnaireAnswer | StudyQuestionnaireAnswerV2>()
  for (const value of raw) {
    const answer = row.questionnaire_version === 2
      ? parseStudyQuestionnaireAnswerV2(value)
      : parseStudyQuestionnaireAnswer(value)
    if (!answer || answer.snapshotId !== snapshot.snapshotId || answers.has(answer.probeId)) {
      throw new StudyDataExportError(`Questionnaire ${row.submission_id} contains a malformed or duplicate answer`)
    }
    answers.set(answer.probeId, answer)
  }
  const expected = new Set(snapshot.items.map((item) => item.probeId))
  if (answers.size !== expected.size || [...expected].some((probeId) => !answers.has(probeId))) {
    throw new StudyDataExportError(`Questionnaire ${row.submission_id} does not answer the frozen universe exactly once`)
  }
  return answers
}

function parseQuestionnaireAttentionCheck(
  row: QuestionnaireRow,
  snapshot: StudyFreezeSnapshot,
): StudyAttentionCheckResult | null {
  const missing = row.attention_check_id === null
    && row.attention_check_answer === null
    && row.attention_check_passed === null
  if (missing) return null
  if (
    typeof row.attention_check_id !== "string"
    || typeof row.attention_check_answer !== "string"
    || (row.attention_check_passed !== 0 && row.attention_check_passed !== 1)
  ) {
    throw new StudyDataExportError(`Questionnaire ${row.submission_id} has a malformed attention-check response`)
  }
  const scored = scoreStudyAttentionCheck(snapshot.taskId, {
    checkId: row.attention_check_id,
    selectedValue: row.attention_check_answer,
  })
  if (!scored || scored.passed !== (row.attention_check_passed === 1)) {
    throw new StudyDataExportError(`Questionnaire ${row.submission_id} has an inconsistent attention-check score`)
  }
  return scored
}

function parseExportedOnboarding(row: OnboardingRow | null, participantId: string): ExportedStudyOnboarding | null {
  if (row === null) return null
  if (row.participant_id !== participantId) {
    throw new StudyDataExportError(`Onboarding participant identity does not match allocation for ${participantId}`)
  }
  let rawTools: unknown
  try {
    rawTools = JSON.parse(row.agent_tools_json)
  } catch {
    throw new StudyDataExportError(`Invalid onboarding agent tools for ${participantId}`)
  }
  if (
    typeof row.prolific_id !== "string" || row.prolific_id.trim().length === 0
    || !Number.isInteger(row.age) || row.age < 18 || row.age > 120
    || !STUDY_ONBOARDING_GENDERS.includes(row.gender as StudyOnboardingInformation["gender"])
    || !STUDY_AGENT_MEMORY_EXPERIENCE.includes(row.agent_memory_experience as StudyOnboardingInformation["agentMemoryExperience"])
    || !STUDY_AGENT_USE_FREQUENCIES.includes(row.agent_use_frequency as StudyOnboardingInformation["agentUseFrequency"])
    || !Array.isArray(rawTools)
    || rawTools.length === 0
    || !rawTools.every((tool) => typeof tool === "string" && STUDY_AGENT_TOOLS.includes(tool as StudyOnboardingInformation["agentTools"][number]))
    || new Set(rawTools).size !== rawTools.length
    || typeof row.information_submitted_at !== "string" || row.information_submitted_at.length === 0
    || (row.consent_version === null) !== (row.consent_accepted_at === null)
    || (row.briefing_version === null) !== (row.briefing_completed_at === null)
  ) {
    throw new StudyDataExportError(`Invalid participant onboarding record for ${participantId}`)
  }
  const agentTools = rawTools as StudyOnboardingInformation["agentTools"]
  const never = row.agent_use_frequency === "Never"
  if ((never && (agentTools.length !== 1 || agentTools[0] !== "None")) || (!never && agentTools.includes("None"))) {
    throw new StudyDataExportError(`Invalid participant onboarding tool selection for ${participantId}`)
  }
  return {
    prolificId: row.prolific_id,
    age: row.age,
    gender: row.gender as StudyOnboardingInformation["gender"],
    agentMemoryExperience: row.agent_memory_experience as StudyOnboardingInformation["agentMemoryExperience"],
    agentUseFrequency: row.agent_use_frequency as StudyOnboardingInformation["agentUseFrequency"],
    agentTools: [...agentTools],
    informationSubmittedAt: row.information_submitted_at,
    consent: row.consent_version === null ? null : { version: row.consent_version, acceptedAt: row.consent_accepted_at! },
    briefing: row.briefing_version === null ? null : { version: row.briefing_version, completedAt: row.briefing_completed_at! },
  }
}

function exportDesired(answer: StudyDesiredMemoryAnswer, cueContent: string): ExportedDesiredMemory {
  switch (answer.kind) {
    case "accurate":
      return { presence: "present", content: cueContent, scope: answer.scope, responseKind: answer.kind, rating: null }
    case "needs_edit":
      return { presence: "present", content: answer.correctedContent, scope: answer.scope, responseKind: answer.kind, rating: null }
    case "not_intended":
      return { presence: "absent", content: null, scope: null, responseKind: answer.kind, rating: null }
  }
}

function exportAssessed(answer: StudyAssessedMemoryAnswer, cueContent: string): ExportedAssessedMemory {
  switch (answer.kind) {
    case "full":
      return { presence: "present", content: cueContent, scope: answer.scope, responseKind: answer.kind, rating: null }
    case "partial_or_distorted":
      return { presence: "present", content: answer.believedContent, scope: answer.scope, responseKind: answer.kind, rating: null }
    case "not_remembered":
      return { presence: "absent", content: null, scope: null, responseKind: answer.kind, rating: null }
    case "unsure":
      return { presence: "unknown", content: null, scope: answer.scope, responseKind: answer.kind, rating: null }
  }
}

/** v2 D_i: rating 5 adopts the frozen cue; 1..4 carry the corrected content. */
function exportDesiredV2(answer: StudyDesiredMemoryAnswerV2, cueContent: string): ExportedDesiredMemory {
  return {
    presence: "present",
    content: answer.rating === 5 ? cueContent : answer.correctedContent,
    scope: answer.scope,
    responseKind: null,
    rating: answer.rating,
  }
}

/** v2 A_i: 5 adopts the cue, 2..4 carry believed content, 1 is absent, and
 * the unknown state stays a separate non-ordinal export value. */
function exportAssessedV2(answer: StudyAssessedMemoryAnswerV2, cueContent: string): ExportedAssessedMemory {
  if (answer.rating === "unknown") {
    return { presence: "unknown", content: null, scope: null, responseKind: null, rating: "unknown" }
  }
  if (answer.rating === 1) {
    return { presence: "absent", content: null, scope: null, responseKind: null, rating: 1 }
  }
  return {
    presence: "present",
    content: answer.rating === 5 ? cueContent : answer.believedContent,
    scope: answer.scope,
    responseKind: null,
    rating: answer.rating,
  }
}

interface ComparableMemoryState {
  presence: "present" | "absent"
  content: string | null
  scope: "session" | "project" | "personal" | null
}

function compareMemoryStates(left: ComparableMemoryState, right: ComparableMemoryState): ExportedStateComparison {
  const bothAbsent = left.presence === "absent" && right.presence === "absent"
  const presenceMatch = left.presence === right.presence
  const contentMatch = bothAbsent ? true : presenceMatch && left.content === right.content
  const scopeMatch = bothAbsent ? true : presenceMatch && left.scope === right.scope
  return {
    status: "available",
    exactMatch: presenceMatch && contentMatch && scopeMatch,
    contentMatch,
    scopeMatch,
    reason: null,
  }
}

function comparableObjectState(object: FrozenStudyMemoryState): ComparableMemoryState | null {
  if (!object.present) return { presence: "absent", content: null, scope: null }
  if (object.content === null || object.scope === null) return null
  return { presence: "present", content: object.content, scope: object.scope }
}

function missingStateComparison(
  status: "missing" | "unknown" | "unavailable",
  reason: Exclude<ExportedStateComparison["reason"], null>,
): ExportedStateComparison {
  return { status, exactMatch: null, contentMatch: null, scopeMatch: null, reason }
}

function deriveMeasurements(input: {
  desired: ExportedDesiredMemory | null
  assessed: ExportedAssessedMemory | null
  object: FrozenStudyMemoryState
  actualExecution: ActualExecutionEvidence | null
}): ExportedMemoryMeasurements {
  const { desired, assessed, object, actualExecution } = input
  const objectState = comparableObjectState(object)
  const questionnaireMissing = desired === null || assessed === null

  const monitoringAccuracy = questionnaireMissing
    ? missingStateComparison("missing", "questionnaire_not_submitted")
    : assessed.presence === "unknown"
      ? missingStateComparison("unknown", "assessed_memory_unknown")
      : objectState === null
        ? missingStateComparison("unavailable", "object_state_incomplete")
        : assessed.scope === "unsure"
          ? {
              status: "unknown" as const,
              exactMatch: null,
              contentMatch: assessed.presence === objectState.presence && assessed.content === objectState.content,
              scopeMatch: null,
              reason: "assessed_scope_unknown" as const,
            }
          : compareMemoryStates(assessed as ComparableMemoryState, objectState)

  const memoryAlignment = questionnaireMissing
    ? missingStateComparison("missing", "questionnaire_not_submitted")
    : objectState === null
      ? missingStateComparison("unavailable", "object_state_incomplete")
      : compareMemoryStates(desired as ComparableMemoryState, objectState)

  let perceivedDiscrepancy: ExportedPerceivedDiscrepancy
  if (questionnaireMissing) {
    perceivedDiscrepancy = {
      status: "missing",
      discrepant: null,
      contentDiscrepant: null,
      scopeDiscrepant: null,
      reason: "questionnaire_not_submitted",
    }
  } else if (assessed.presence === "unknown") {
    perceivedDiscrepancy = {
      status: "unknown",
      discrepant: null,
      contentDiscrepant: null,
      scopeDiscrepant: null,
      reason: "assessed_memory_unknown",
    }
  } else if (assessed.scope === "unsure") {
    perceivedDiscrepancy = {
      status: "unknown",
      discrepant: null,
      contentDiscrepant: desired.presence !== assessed.presence || desired.content !== assessed.content,
      scopeDiscrepant: null,
      reason: "assessed_scope_unknown",
    }
  } else {
    const equality = compareMemoryStates(desired as ComparableMemoryState, assessed as ComparableMemoryState)
    perceivedDiscrepancy = {
      status: "available",
      discrepant: !equality.exactMatch,
      contentDiscrepant: !equality.contentMatch,
      scopeDiscrepant: !equality.scopeMatch,
      reason: null,
    }
  }

  let controlAccuracy: ExportedControlAccuracy
  if (desired === null) {
    controlAccuracy = { status: "missing", realized: null, reason: "questionnaire_not_submitted" }
  } else if (desired.presence === "absent") {
    controlAccuracy = { status: "not_applicable", realized: null, reason: "desired_memory_absent" }
  } else if (!actualExecution) {
    controlAccuracy = { status: "missing", realized: null, reason: "actual_execution_missing" }
  } else if (actualExecution.verdict === "fully_realized") {
    controlAccuracy = { status: "available", realized: true, reason: null }
  } else if (actualExecution.verdict === "not_realized") {
    controlAccuracy = { status: "available", realized: false, reason: null }
  } else if (actualExecution.verdict === "partially_realized") {
    controlAccuracy = { status: "unavailable", realized: null, reason: "actual_execution_partial_unscored" }
  } else if (actualExecution.verdict === "not_applicable") {
    controlAccuracy = { status: "not_applicable", realized: null, reason: "actual_execution_not_applicable" }
  } else {
    controlAccuracy = { status: "unavailable", realized: null, reason: "actual_execution_uncertain" }
  }

  return { monitoringAccuracy, memoryAlignment, perceivedDiscrepancy, controlAccuracy }
}

function exportRawTlx(row: RawTlxRow): ExportedRawTlx {
  const response = parseStudyRawTlxActivityResponse(JSON.parse(row.response_json))
  if (!response || response.activity !== row.activity) {
    throw new StudyDataExportError(`Raw TLX ${row.submission_id} is malformed`)
  }
  return {
    submissionId: row.submission_id,
    submittedAt: row.submitted_at,
    payloadHash: row.payload_hash,
    response,
    score: calculateRawTlxScore(response.ratings),
  }
}

function parseCompletionReceipt(
  records: ParticipantDatabaseRecords,
  participantId: string,
  sus: ExportedSus | null,
): ExportedCompletionReceipt | null {
  const row = records.completionReceipt
  if (!row) return null
  if (!sus) throw new StudyDataExportError(`Completion receipt exists without a SUS submission for ${participantId}`)
  if (row.participant_id !== participantId) {
    throw new StudyDataExportError(`Completion receipt participant identity does not match allocation for ${participantId}`)
  }
  if (row.sus_submission_id !== sus.submissionId) {
    throw new StudyDataExportError(`Completion receipt does not reference the SUS submission for ${participantId}`)
  }
  if (!row.code.trim() || !row.code_version.trim() || !row.issued_at.trim()) {
    throw new StudyDataExportError(`Completion receipt is malformed for ${participantId}`)
  }
  return {
    participantId: row.participant_id,
    susSubmissionId: row.sus_submission_id,
    code: row.code,
    codeVersion: row.code_version,
    issuedAt: row.issued_at,
  }
}

function exportSus(row: SusRow | null): ExportedSus | null {
  if (!row) return null
  const response = parseStudySusResponse(JSON.parse(row.response_json))
  if (!response) throw new StudyDataExportError(`SUS ${row.submission_id} is malformed`)
  return {
    submissionId: row.submission_id,
    submittedAt: row.submitted_at,
    payloadHash: row.payload_hash,
    response,
    score: calculateSusScore(response.ratings),
  }
}

function exportTelemetry(rows: TelemetryRow[], manifest: StudyAllocationManifest): StudyTelemetryEvent[] {
  const kinds = new Set(["monitoring", "control", "participant_prompt", "stage_enter", "surface_exposure"])
  const seen = new Set<string>()
  return rows.map((row) => {
    if (seen.has(row.event_id)) throw new StudyDataExportError(`Duplicate telemetry event ${row.event_id}`)
    seen.add(row.event_id)
    if (row.participant_id !== manifest.participantId || row.condition !== manifest.condition) {
      throw new StudyDataExportError(`Telemetry allocation identity mismatch for ${row.event_id}`)
    }
    if (!kinds.has(row.kind)) throw new StudyDataExportError(`Unknown telemetry kind for ${row.event_id}`)
    if (row.task_id !== null && !KNOWN_TASK_IDS.has(row.task_id)) {
      throw new StudyDataExportError(`Telemetry event ${row.event_id} references an unknown task`)
    }
    if ((row.task_id === null) !== (row.session_id === null) || (row.task_id !== null && row.session_id !== row.task_id)) {
      throw new StudyDataExportError(`Telemetry event ${row.event_id} has inconsistent task/session attribution`)
    }
    let payload: unknown
    try {
      payload = JSON.parse(row.payload_json)
    } catch {
      throw new StudyDataExportError(`Telemetry payload is malformed for ${row.event_id}`)
    }
    if (!isRecord(payload)) throw new StudyDataExportError(`Telemetry payload must be an object for ${row.event_id}`)
    const declaresPhasedProvenance = row.event_id.startsWith("control-operation:")
      || payload.sourceEventType === "study.control_operation"
    if (declaresPhasedProvenance) {
      const operationId = typeof payload.operationId === "string" && payload.operationId.trim()
        ? payload.operationId
        : null
      const controlType = typeof payload.controlType === "string" && payload.controlType.trim()
        ? payload.controlType
        : null
      const outcome = payload.outcome === "attempted" || payload.outcome === "completed" || payload.outcome === "failed"
        ? payload.outcome
        : null
      if (
        row.kind !== "control"
        || operationId === null
        || controlType === null
        || outcome === null
        || row.event_id !== `control-operation:${operationId}:${outcome}`
      ) {
        throw new StudyDataExportError(`Control receipt ${row.event_id} has invalid phased provenance`)
      }
    }
    return {
      eventId: requireNonEmptyString(row.event_id, "telemetry event id"),
      recordedAt: requireIsoTimestamp(row.recorded_at, `telemetry ${row.event_id} recordedAt`),
      clientTimestamp: row.client_timestamp === null
        ? null
        : requireIsoTimestamp(row.client_timestamp, `telemetry ${row.event_id} clientTimestamp`),
      participantId: row.participant_id,
      taskId: row.task_id,
      sessionId: row.session_id,
      chatId: row.chat_id,
      condition: row.condition,
      kind: row.kind,
      surface: requireNonEmptyString(row.surface, `telemetry ${row.event_id} surface`),
      action: requireNonEmptyString(row.action, `telemetry ${row.event_id} action`),
      payload,
    }
  })
}

function stageInterval(input: {
  manifest: StudyAllocationManifest
  taskId: string | null
  stage: ExportedStudyStage
  enteredAt: string | null
  submittedAt: string | null
}): ExportedStudyStageInterval {
  const { enteredAt, submittedAt } = input
  if (enteredAt && submittedAt && Date.parse(submittedAt) < Date.parse(enteredAt)) {
    throw new StudyDataExportError(
      `Study stage ${input.stage} ends before it begins for ${input.manifest.participantId}/${input.taskId ?? "study"}`,
    )
  }
  const status = enteredAt && submittedAt
    ? "available" as const
    : enteredAt
      ? "missing_submitted" as const
      : submittedAt
        ? "missing_entered" as const
        : "missing_both" as const
  return {
    participantId: input.manifest.participantId,
    allocationMode: input.manifest.allocationMode,
    condition: input.manifest.condition,
    taskId: input.taskId,
    stage: input.stage,
    enteredAt,
    submittedAt,
    durationMs: enteredAt && submittedAt ? Date.parse(submittedAt) - Date.parse(enteredAt) : null,
    status,
  }
}

function firstTelemetryAt(
  rows: StudyTelemetryEvent[],
  predicate: (row: StudyTelemetryEvent) => boolean,
): string | null {
  return rows.find(predicate)?.recordedAt ?? null
}

function telemetryPayloadText(row: StudyTelemetryEvent, key: string): string | null {
  const value = row.payload[key]
  return typeof value === "string" && value.trim() ? value : null
}

function exportControlOperations(
  rows: StudyTelemetryEvent[],
  manifest: StudyAllocationManifest,
): ExportedControlOperation[] {
  const grouped = new Map<string, StudyTelemetryEvent[]>()
  for (const row of rows) {
    if (row.kind !== "control") continue
    if (!("outcome" in row.payload)) continue
    const operationId = telemetryPayloadText(row, "operationId")
    const outcome = telemetryPayloadText(row, "outcome")
    if (!outcome || !["attempted", "completed", "failed"].includes(outcome)) {
      throw new StudyDataExportError(`Control event ${row.eventId} has an invalid outcome`)
    }
    if (!operationId) {
      throw new StudyDataExportError(`Control event ${row.eventId} has an outcome without an operation ID`)
    }
    if (row.taskId === null) throw new StudyDataExportError(`Control operation ${operationId} is missing its task`)
    const group = grouped.get(operationId)
    if (group) group.push(row)
    else grouped.set(operationId, [row])
  }
  return [...grouped.entries()].map(([operationId, events]) => {
    const first = events[0]!
    const surface = first.surface
    const action = first.action
    const controlType = telemetryPayloadText(first, "controlType")
    if (!controlType) {
      throw new StudyDataExportError(`Control operation ${operationId} is missing its control type`)
    }
    if (events.some((row) => (
      row.surface !== surface
      || row.action !== action
      || telemetryPayloadText(row, "controlType") !== controlType
      || row.taskId !== first.taskId
    ))) {
      throw new StudyDataExportError(`Control operation ${operationId} has inconsistent phase evidence`)
    }
    const byOutcome = (outcome: "attempted" | "completed" | "failed") => {
      const matches = events.filter((row) => telemetryPayloadText(row, "outcome") === outcome)
      if (matches.length > 1) throw new StudyDataExportError(`Control operation ${operationId} repeats ${outcome}`)
      return matches[0]?.recordedAt ?? null
    }
    const attemptedAt = byOutcome("attempted")
    const completedAt = byOutcome("completed")
    const failedAt = byOutcome("failed")
    if (!attemptedAt) throw new StudyDataExportError(`Control operation ${operationId} has an outcome without attempted evidence`)
    if (completedAt && failedAt) throw new StudyDataExportError(`Control operation ${operationId} is both completed and failed`)
    const terminalAt = completedAt ?? failedAt
    if (terminalAt && Date.parse(terminalAt) < Date.parse(attemptedAt)) {
      throw new StudyDataExportError(`Control operation ${operationId} ends before it was attempted`)
    }
    return {
      participantId: manifest.participantId,
      allocationMode: manifest.allocationMode,
      condition: manifest.condition,
      taskId: first.taskId!,
      operationId,
      surface,
      action,
      controlType,
      attemptedAt,
      completedAt,
      failedAt,
      outcome: completedAt ? "completed" : failedAt ? "failed" : "incomplete",
    }
  })
}

function exportControlActions(
  rows: StudyTelemetryEvent[],
  manifest: StudyAllocationManifest,
  operations: ExportedControlOperation[],
): ExportedControlAction[] {
  const standalone = rows.filter((row) => (
    row.kind === "control"
    && !["attempted", "completed", "failed"].includes(telemetryPayloadText(row, "outcome") ?? "")
  )).map((row): ExportedControlAction => ({
    eventId: row.eventId,
    participantId: row.participantId,
    allocationMode: manifest.allocationMode,
    condition: row.condition,
    taskId: row.taskId,
    chatId: row.chatId,
    serverTimestamp: row.recordedAt,
    clientTimestamp: row.clientTimestamp,
    surface: row.surface,
    action: row.action,
    operationId: telemetryPayloadText(row, "operationId"),
    controlType: telemetryPayloadText(row, "controlType"),
    evidenceKind: "observed",
    outcome: "observed",
    terminalTimestamp: null,
    payload: row.payload,
  }))
  const phased = operations.map((operation): ExportedControlAction => {
    const attempted = rows.find((row) => (
      row.kind === "control"
      && telemetryPayloadText(row, "operationId") === operation.operationId
      && telemetryPayloadText(row, "outcome") === "attempted"
    ))
    if (!attempted) throw new StudyDataExportError(`Control operation ${operation.operationId} is missing its attempted row`)
    return {
      eventId: attempted.eventId,
      participantId: attempted.participantId,
      allocationMode: manifest.allocationMode,
      condition: attempted.condition,
      taskId: attempted.taskId,
      chatId: attempted.chatId,
      serverTimestamp: attempted.recordedAt,
      clientTimestamp: attempted.clientTimestamp,
      surface: operation.surface,
      action: operation.action,
      operationId: operation.operationId,
      controlType: operation.controlType,
      evidenceKind: "phased_operation",
      outcome: operation.outcome,
      terminalTimestamp: operation.completedAt ?? operation.failedAt,
      payload: attempted.payload,
    }
  })
  return [...standalone, ...phased]
}

function exportInteractionIntervals(
  rows: StudyTelemetryEvent[],
  manifest: StudyAllocationManifest,
): ExportedStudyInteractionInterval[] {
  const relevant = rows.filter((row) => (
    row.surface === "static_memory"
    && (
      row.action === "edit_entered"
      || row.action === "edit_submitted"
      || (
        row.action === "edit"
        && telemetryPayloadText(row, "controlType") === "static_edit"
        && telemetryPayloadText(row, "outcome") === "completed"
      )
    )
  ))
  const operationIds = [...new Set(relevant.map((row) => telemetryPayloadText(row, "operationId")).filter((id): id is string => Boolean(id)))]
  return operationIds.map((operationId) => {
    const entered = relevant.find((row) => row.action === "edit_entered" && telemetryPayloadText(row, "operationId") === operationId) ?? null
    const submitted = relevant.find((row) => (
      telemetryPayloadText(row, "operationId") === operationId
      && (
        row.action === "edit_submitted"
        || (
          row.action === "edit"
          && telemetryPayloadText(row, "controlType") === "static_edit"
          && telemetryPayloadText(row, "outcome") === "completed"
        )
      )
    )) ?? null
    const taskId = entered?.taskId ?? submitted?.taskId ?? null
    if (!taskId) throw new StudyDataExportError(`Static edit ${operationId} is missing its task`)
    if (entered?.taskId && submitted?.taskId && entered.taskId !== submitted.taskId) {
      throw new StudyDataExportError(`Static edit ${operationId} crosses task windows`)
    }
    const operationReceipts = rows.filter((row) => (
      row.kind === "control"
      && telemetryPayloadText(row, "operationId") === operationId
      && ["attempted", "completed", "failed"].includes(telemetryPayloadText(row, "outcome") ?? "")
    ))
    const identityRows = [entered, submitted, ...operationReceipts]
      .filter((row): row is StudyTelemetryEvent => row !== null)
    const expectedChatId = identityRows[0]?.chatId ?? null
    const expectedPath = identityRows.length === 0 ? null : telemetryPayloadText(identityRows[0]!, "path")
    if (
      identityRows.length > 0
      && (
        expectedPath === null
        || identityRows.some((row) => (
          row.taskId !== taskId
          || row.sessionId !== taskId
          || row.chatId !== expectedChatId
          || row.surface !== "static_memory"
          || (row.action !== "edit_entered" && row.action !== "edit_submitted" && row.action !== "edit")
          || telemetryPayloadText(row, "operationId") !== operationId
          || telemetryPayloadText(row, "path") !== expectedPath
          || (row.action === "edit" && telemetryPayloadText(row, "controlType") !== "static_edit")
        ))
      )
    ) {
      throw new StudyDataExportError(`Static edit ${operationId} has inconsistent entry and operation evidence`)
    }
    const enteredAt = entered?.recordedAt ?? null
    const submittedAt = submitted?.recordedAt ?? null
    const clientDuration = submitted?.payload.durationMs
    const clientDurationMs = typeof clientDuration === "number" && Number.isFinite(clientDuration) && clientDuration >= 0
      ? clientDuration
      : null
    const lateEntered = enteredAt !== null
      && submittedAt !== null
      && Date.parse(submittedAt) < Date.parse(enteredAt)
    return {
      participantId: manifest.participantId,
      allocationMode: manifest.allocationMode,
      condition: manifest.condition,
      taskId,
      operationId,
      interval: "static_memory_edit",
      enteredAt,
      submittedAt,
      durationMs: enteredAt && submittedAt && !lateEntered ? Date.parse(submittedAt) - Date.parse(enteredAt) : null,
      clientDurationMs,
      status: lateEntered
        ? "late_entered"
        : enteredAt && submittedAt
          ? "available"
        : enteredAt
          ? "missing_submitted"
        : submittedAt
            ? clientDurationMs === null ? "missing_entered" : "client_only"
            : "missing_both",
    }
  })
}

function exportSurfaceExposureIntervals(
  rows: StudyTelemetryEvent[],
  manifest: StudyAllocationManifest,
): ExportedStudySurfaceExposureInterval[] {
  const grouped = new Map<string, StudyTelemetryEvent[]>()
  for (const row of rows) {
    if (row.kind !== "surface_exposure") continue
    const rawId = row.payload.exposureId
    const exposureId = typeof rawId === "string" && rawId.trim() ? rawId : `invalid:${row.eventId}`
    const group = grouped.get(exposureId)
    if (group) group.push(row)
    else grouped.set(exposureId, [row])
  }
  return [...grouped.entries()].map(([exposureId, events]) => {
    const first = events[0]!
    const initiator = first.payload.initiator === "participant" || first.payload.initiator === "system"
      ? first.payload.initiator
      : null
    const firstMemoryIds = Array.isArray(first.payload.memoryIds)
      && first.payload.memoryIds.every((id) => typeof id === "string")
      ? [...first.payload.memoryIds as string[]]
      : []
    let valid = initiator !== null && first.taskId !== null && first.chatId !== null
    let state: "visible" | "hidden" | "closed" | null = null
    let visibleStartedAt: number | null = null
    let visibleDurationMs = 0
    let previousClientMs = Number.NEGATIVE_INFINITY
    let clientOpenedAt: string | null = null
    let clientClosedAt: string | null = null
    let closeReason: string | null = null
    const transitions = events.map((event, index): ExportedStudySurfaceExposureTransition => {
      const sequence = Number.isSafeInteger(event.payload.sequence) ? event.payload.sequence as number : null
      const clientMs = event.clientTimestamp === null ? Number.NaN : Date.parse(event.clientTimestamp)
      const equalTimeInitialHidden = index === 1
        && events[0]?.action === "opened"
        && event.action === "hidden"
        && clientMs === previousClientMs
      if (
        sequence !== index
        || event.taskId !== first.taskId
        || event.chatId !== first.chatId
        || event.surface !== first.surface
        || event.condition !== first.condition
        || event.payload.initiator !== initiator
        || JSON.stringify(event.payload.memoryIds ?? []) !== JSON.stringify(firstMemoryIds)
        || !Number.isFinite(clientMs)
        || clientMs < previousClientMs
        || (clientMs === previousClientMs && !equalTimeInitialHidden)
      ) {
        valid = false
      }
      previousClientMs = clientMs
      if (index === 0) {
        if (event.action !== "opened") valid = false
        else {
          state = "visible"
          visibleStartedAt = clientMs
          clientOpenedAt = event.clientTimestamp
        }
      } else if (state === "visible" && event.action === "hidden") {
        if (visibleStartedAt !== null && Number.isFinite(clientMs)) visibleDurationMs += clientMs - visibleStartedAt
        visibleStartedAt = null
        state = "hidden"
      } else if (state === "hidden" && event.action === "visible") {
        visibleStartedAt = clientMs
        state = "visible"
      } else if ((state === "visible" || state === "hidden") && event.action === "closed") {
        if (state === "visible" && visibleStartedAt !== null && Number.isFinite(clientMs)) {
          visibleDurationMs += clientMs - visibleStartedAt
        }
        state = "closed"
        clientClosedAt = event.clientTimestamp
        closeReason = typeof event.payload.closeReason === "string" ? event.payload.closeReason : null
        if (!closeReason || index !== events.length - 1) valid = false
      } else {
        valid = false
      }
      if (event.action !== "closed" && event.payload.closeReason !== undefined) valid = false
      return {
        eventId: event.eventId,
        sequence,
        transition: event.action,
        clientTimestamp: event.clientTimestamp,
        serverRecordedAt: event.recordedAt,
      }
    })
    const closed = state === "closed" && clientClosedAt !== null
    const serverSpan = closed
      ? Date.parse(events[events.length - 1]!.recordedAt) - Date.parse(first.recordedAt)
      : null
    if (serverSpan !== null && serverSpan < 0) valid = false
    return {
      exposureId,
      participantId: manifest.participantId,
      allocationMode: manifest.allocationMode,
      condition: manifest.condition,
      taskId: first.taskId,
      chatId: first.chatId,
      surface: first.surface,
      initiator,
      memoryIds: firstMemoryIds,
      closeReason,
      clientOpenedAt,
      clientClosedAt,
      clientVisibleDurationMs: valid && closed ? visibleDurationMs : null,
      serverReceiptSpanMs: valid && closed ? serverSpan : null,
      status: !valid ? "invalid" : closed ? "available" : "missing_closed",
      serverRecordedTransitions: transitions,
    }
  })
}

function sessionStatus(input: {
  snapshot: StudyFreezeSnapshot | null
  questionnaire: QuestionnaireRow | null
  monitoring: ExportedRawTlx | null
  control: ExportedRawTlx | null
  completion: CompletionRow | null
}): ExportedSessionStatus {
  if (!input.snapshot) return "not_started"
  if (!input.questionnaire) return "frozen"
  if (!input.monitoring) return "questionnaire_submitted"
  if (!input.control) return "monitoring_tlx_submitted"
  if (!input.completion) {
    throw new StudyDataExportError(`Control Raw TLX exists without Session Completion for ${input.snapshot.taskId}`)
  }
  return "completed"
}

function addParticipant(
  dataset: StudyDataExport,
  paths: ParticipantStudyPaths,
  manifest: StudyAllocationManifest,
  evidence: ActualExecutionEvidenceAdapter,
): void {
  const records = readParticipantDatabase(paths.databasePath)
  const sus = exportSus(records.sus)
  const freezes = records.freezes.map((row) => {
    const freeze = parseFreeze(row)
    if (!KNOWN_TASK_IDS.has(freeze.taskId)) throw new StudyDataExportError(`Unknown task in freeze snapshot: ${freeze.taskId}`)
    return freeze
  })
  const freezesByTask = new Map(freezes.map((freeze) => [freeze.taskId, freeze] as const))
  const knownSnapshotIds = new Set(freezes.map((freeze) => freeze.snapshotId))
  const orphanQuestionnaire = records.questionnaires.find((row) => !knownSnapshotIds.has(row.snapshot_id))
  if (orphanQuestionnaire) {
    throw new StudyDataExportError(`Questionnaire references unknown freeze snapshot ${orphanQuestionnaire.snapshot_id}`)
  }
  const orphanRawTlx = records.rawTlx.find((row) => !knownSnapshotIds.has(row.snapshot_id))
  if (orphanRawTlx) throw new StudyDataExportError(`Raw TLX references unknown freeze snapshot ${orphanRawTlx.snapshot_id}`)
  const unknownCompletion = records.completions.find((row) => !KNOWN_TASK_IDS.has(row.task_id))
  if (unknownCompletion) throw new StudyDataExportError(`Session Completion references unknown task ${unknownCompletion.task_id}`)
  const questionnaireBySnapshot = new Map(records.questionnaires.map((row) => [row.snapshot_id, row]))
  const tlxBySnapshotActivity = new Map(records.rawTlx.map((row) => [`${row.snapshot_id}\0${row.activity}`, exportRawTlx(row)]))
  const completionByTask = new Map(records.completions.map((row) => [row.task_id, row]))
  const onboarding = parseExportedOnboarding(records.onboarding, manifest.participantId)
  const completionReceipt = parseCompletionReceipt(records, manifest.participantId, sus)
  const telemetry = exportTelemetry(records.telemetry, manifest)

  dataset.sources.push({
    participantId: manifest.participantId,
    databaseSha256: sha256File(paths.databasePath),
    allocationManifestSha256: sha256File(paths.allocationManifestPath),
  })
  dataset.participants.push({
    participantId: manifest.participantId,
    allocationMode: manifest.allocationMode,
    condition: manifest.condition,
    taskOrder: [...manifest.studyTaskOrder],
    issuedAt: manifest.issuedAt,
    claimedAt: manifest.claimedAt,
    onboarding,
    sus,
    completionReceipt,
  })
  dataset.interactions.push(...telemetry)
  const controlOperations = exportControlOperations(telemetry, manifest)
  dataset.controlActions.push(...exportControlActions(telemetry, manifest, controlOperations))
  dataset.controlOperations.push(...controlOperations)
  dataset.interactionIntervals.push(...exportInteractionIntervals(telemetry, manifest))
  dataset.surfaceExposureIntervals.push(...exportSurfaceExposureIntervals(telemetry, manifest))
  dataset.stageIntervals.push(stageInterval({
    manifest,
    taskId: null,
    stage: "whole_study",
    enteredAt: firstTelemetryAt(telemetry, (row) => row.kind === "stage_enter" && row.action === "information"),
    submittedAt: completionReceipt?.issuedAt ?? null,
  }))
  dataset.stageIntervals.push(stageInterval({
    manifest,
    taskId: null,
    stage: "sus",
    enteredAt: firstTelemetryAt(telemetry, (row) => row.kind === "stage_enter" && row.action === "sus"),
    submittedAt: sus?.submittedAt ?? null,
  }))

  const seenProjects: string[] = []
  manifest.studyTaskOrder.forEach((taskId, orderIndex) => {
    const task = STUDY_TASKS.find((candidate) => candidate.id === taskId)!
    if (!seenProjects.includes(task.projectSlug)) seenProjects.push(task.projectSlug)
    const snapshot = freezesByTask.get(taskId) ?? null
    const questionnaire = snapshot ? questionnaireBySnapshot.get(snapshot.snapshotId) ?? null : null
    const answers: Map<string, StudyQuestionnaireAnswer | StudyQuestionnaireAnswerV2> =
      questionnaire && snapshot ? parseQuestionnaireAnswers(questionnaire, snapshot) : new Map()
    const attentionCheck = questionnaire && snapshot
      ? parseQuestionnaireAttentionCheck(questionnaire, snapshot)
      : null
    const monitoring = snapshot ? tlxBySnapshotActivity.get(`${snapshot.snapshotId}\0monitoring`) ?? null : null
    const control = snapshot ? tlxBySnapshotActivity.get(`${snapshot.snapshotId}\0control`) ?? null : null
    const completion = completionByTask.get(taskId) ?? null
    if (completion && (!snapshot || completion.snapshot_id !== snapshot.snapshotId)) {
      throw new StudyDataExportError(`Session Completion does not match the freeze snapshot for ${taskId}`)
    }
    if ((monitoring || control || questionnaire) && !snapshot) {
      throw new StudyDataExportError(`Post-session data exists without a freeze snapshot for ${taskId}`)
    }
    const taskTelemetry = telemetry.filter((row) => row.taskId === taskId)
    dataset.stageIntervals.push(
      stageInterval({
        manifest,
        taskId,
        stage: "session_exposure",
        enteredAt: firstTelemetryAt(taskTelemetry, (row) => row.kind === "stage_enter" && row.action === "session_exposure"),
        submittedAt: snapshot?.frozenAt ?? null,
      }),
      stageInterval({
        manifest,
        taskId,
        stage: "active_session",
        enteredAt: firstTelemetryAt(taskTelemetry, (row) =>
          row.kind === "participant_prompt"
        ),
        submittedAt: snapshot?.frozenAt ?? null,
      }),
      stageInterval({
        manifest,
        taskId,
        stage: "memory_questionnaire",
        enteredAt: firstTelemetryAt(taskTelemetry, (row) => row.kind === "stage_enter" && row.action === "memory_questionnaire"),
        submittedAt: questionnaire?.submitted_at ?? null,
      }),
      stageInterval({
        manifest,
        taskId,
        stage: "monitoring_tlx",
        enteredAt: firstTelemetryAt(taskTelemetry, (row) => row.kind === "stage_enter" && row.action === "monitoring_tlx"),
        submittedAt: monitoring?.submittedAt ?? null,
      }),
      stageInterval({
        manifest,
        taskId,
        stage: "control_tlx",
        enteredAt: firstTelemetryAt(taskTelemetry, (row) => row.kind === "stage_enter" && row.action === "control_tlx"),
        submittedAt: control?.submittedAt ?? null,
      }),
    )

    let actualExecutionAvailableCount = 0
    let actualExecutionPartialCount = 0
    let actualExecutionMissingCount = 0
    let actualExecutionNotApplicableCount = 0
    let actualExecutionUncertainCount = 0
    for (const item of snapshot?.items ?? []) {
      const answer = answers.get(item.probeId) ?? null
      const desired = answer
        ? "kind" in answer.desired
          ? exportDesired(answer.desired, item.cue.content)
          : exportDesiredV2(answer.desired, item.cue.content)
        : null
      const assessed = answer
        ? "kind" in answer.assessed
          ? exportAssessed(answer.assessed, item.cue.content)
          : exportAssessedV2(answer.assessed, item.cue.content)
        : null
      const actualExecution = desired?.presence === "present"
        ? evidence.resolve({
            participantId: manifest.participantId,
            taskId,
            probeId: item.probeId,
            desired,
            workspaceSnapshot: snapshot?.workspaceSnapshot ?? null,
          })
        : null
      const actualExecutionStatus = desired?.presence === "absent"
        ? "not_applicable" as const
        : !actualExecution
          ? "missing" as const
          : actualExecution.verdict === "partially_realized"
            ? "partial" as const
            : actualExecution.verdict === "not_applicable"
              ? "not_applicable" as const
              : actualExecution.verdict === "uncertain"
                ? "uncertain" as const
                : "available" as const
      const measurements = deriveMeasurements({ desired, assessed, object: item.object, actualExecution })
      if (actualExecutionStatus === "available") actualExecutionAvailableCount += 1
      else if (actualExecutionStatus === "partial") actualExecutionPartialCount += 1
      else if (actualExecutionStatus === "not_applicable") actualExecutionNotApplicableCount += 1
      else if (actualExecutionStatus === "uncertain") actualExecutionUncertainCount += 1
      else actualExecutionMissingCount += 1
      dataset.memoryItems.push({
        participantId: manifest.participantId,
        allocationMode: manifest.allocationMode,
        condition: manifest.condition,
        taskId,
        taskOrderIndex: orderIndex,
        projectSlug: task.projectSlug,
        snapshotId: snapshot!.snapshotId,
        frozenAt: snapshot!.frozenAt,
        probeId: item.probeId,
        identity: item.identity,
        cue: item.cue,
        questionnaireVersion: freezeQuestionnaireVersion(snapshot!),
        desired,
        assessed,
        object: item.object,
        participantExecutionJudgment: answer?.execution ?? null,
        actualExecution,
        actualExecutionStatus,
        controlAccuracyEligible: desired ? desired.presence === "present" : null,
        measurements,
        injectionHistory: item.history,
        qualityFlags: [...item.qualityFlags],
        finalLineage: item.finalLineage ?? null,
        workspaceSnapshot: snapshot!.workspaceSnapshot ?? null,
      })
    }

    dataset.sessions.push({
      participantId: manifest.participantId,
      allocationMode: manifest.allocationMode,
      condition: manifest.condition,
      task: {
        id: task.id,
        title: task.title,
        orderIndex,
        projectSlug: task.projectSlug,
        projectTitle: task.projectTitle,
        projectOrderIndex: seenProjects.indexOf(task.projectSlug),
        sessionIndexWithinProject: Number(task.id.endsWith("S2")) + 1,
      },
      lifecycle: {
        status: sessionStatus({ snapshot, questionnaire, monitoring, control, completion }),
        snapshotId: snapshot?.snapshotId ?? null,
        frozenAt: snapshot?.frozenAt ?? null,
        questionnaireVersion: snapshot ? freezeQuestionnaireVersion(snapshot) : null,
        questionnaireSubmittedAt: questionnaire?.submitted_at ?? null,
        completedAt: completion?.completed_at ?? null,
      },
      attentionCheck,
      workspaceSnapshot: snapshot?.workspaceSnapshot ?? null,
      freezeQualityFlags: [...(snapshot?.qualityFlags ?? [])],
      monitoringRawTlx: monitoring,
      controlRawTlx: control,
      sus,
      memoryItemCount: snapshot?.items.length ?? 0,
      actualExecutionAvailableCount,
      actualExecutionPartialCount,
      actualExecutionMissingCount,
      actualExecutionNotApplicableCount,
      actualExecutionUncertainCount,
    })
  })
}

export function buildStudyDataExport(input: BuildStudyDataExportInput): StudyDataExport {
  const evidence = input.actualExecutionEvidence ?? missingActualExecutionEvidence
  const dataset: StudyDataExport = {
    schemaVersion: 6,
    actualExecutionEvidenceAdapter: evidence.name,
    sources: [],
    excludedParticipants: [],
    participants: [],
    sessions: [],
    memoryItems: [],
    interactions: [],
    controlActions: [],
    controlOperations: [],
    interactionIntervals: [],
    surfaceExposureIntervals: [],
    stageIntervals: [],
  }
  const seenParticipants = new Set<string>()
  for (const dataDir of [...new Set(input.participantDataDirs.map((path) => resolve(path)))].sort()) {
    const paths = locateParticipantStudyPaths(dataDir)
    const manifest = parseAllocationManifest(paths.allocationManifestPath)
    if (seenParticipants.has(manifest.participantId)) {
      throw new StudyDataExportError(`Duplicate participant source: ${manifest.participantId}`)
    }
    seenParticipants.add(manifest.participantId)
    if (manifest.allocationMode === "internal_qa" && input.includeInternalQa !== true) {
      dataset.excludedParticipants.push({
        participantId: manifest.participantId,
        allocationMode: manifest.allocationMode,
        reason: "internal_qa",
      })
      continue
    }
    addParticipant(dataset, paths, manifest, evidence)
  }
  evidence.assertFullyConsumed?.()
  return dataset
}

/**
 * Canonical researcher export. When actual E_i is joined, re-verify every
 * SQLite-bound frozen workspace immediately before building the dataset.
 */
export async function buildVerifiedStudyDataExport(input: BuildStudyDataExportInput): Promise<StudyDataExport> {
  if (input.actualExecutionEvidence) {
    for (const dataDir of [...new Set(input.participantDataDirs.map((value) => resolve(value)))].sort()) {
      const paths = locateParticipantStudyPaths(dataDir)
      const manifest = parseAllocationManifest(paths.allocationManifestPath)
      if (manifest.allocationMode === "internal_qa" && input.includeInternalQa !== true) continue
      const records = readParticipantDatabase(paths.databasePath)
      for (const row of records.freezes) {
        const freeze = parseFreeze(row)
        if (freeze.workspaceSnapshot) await verifyStudyWorkspaceSnapshot(paths.dataDir, freeze.workspaceSnapshot)
      }
    }
  }
  return buildStudyDataExport(input)
}

function sameWorkspaceSnapshot(
  left: StudyWorkspaceSnapshotMetadata,
  right: StudyWorkspaceSnapshotMetadata,
): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.taskId === right.taskId
    && left.snapshotId === right.snapshotId
    && left.project.slug === right.project.slug
    && left.project.title === right.project.title
    && left.frozenAt === right.frozenAt
    && left.exportedPath === right.exportedPath
    && left.treeHash === right.treeHash
    && left.fileCount === right.fileCount
    && left.totalBytes === right.totalBytes
    && left.exclusions.length === right.exclusions.length
    && left.exclusions.every((value, index) => value === right.exclusions[index])
}

function actualExecutionEvidenceAdapterFromJson(
  raw: unknown,
  artifactWorkspaces: ReadonlyMap<string, StudyWorkspaceSnapshotMetadata>,
): ActualExecutionEvidenceAdapter {
  if (!isRecord(raw) || raw.schemaVersion !== 2 || !Array.isArray(raw.records)) {
    throw new StudyDataExportError("Actual-execution evidence must use schemaVersion 2 with a records array")
  }
  const evidenceByKey = new Map<string, ActualExecutionEvidence>()
  const consumedKeys = new Set<string>()
  for (const [index, value] of raw.records.entries()) {
    if (!isRecord(value) || !isRecord(value.evaluator)) {
      throw new StudyDataExportError(`Malformed actual-execution record ${index}`)
    }
    const participantId = requireNonEmptyString(value.participantId, `record ${index} participantId`)
    const taskId = requireNonEmptyString(value.taskId, `record ${index} taskId`)
    const snapshotId = requireNonEmptyString(value.snapshotId, `record ${index} snapshotId`)
    const probeId = requireNonEmptyString(value.probeId, `record ${index} probeId`)
    const workspaceTreeHash = requireSha256(value.workspaceTreeHash, `record ${index} workspaceTreeHash`)
    const desiredContentSha256 = requireSha256(value.desiredContentSha256, `record ${index} desiredContentSha256`)
    const evidenceSha256 = requireSha256(value.evidenceSha256, `record ${index} evidenceSha256`)
    const verdict = value.verdict
    if (
      verdict !== "fully_realized"
      && verdict !== "partially_realized"
      && verdict !== "not_realized"
      && verdict !== "not_applicable"
      && verdict !== "uncertain"
    ) {
      throw new StudyDataExportError(`Malformed actual-execution verdict for record ${index}`)
    }
    const key = `${participantId}\0${taskId}\0${probeId}`
    if (evidenceByKey.has(key)) throw new StudyDataExportError(`Duplicate actual-execution evidence for ${participantId}/${taskId}/${probeId}`)
    evidenceByKey.set(key, {
      verdict,
      realized: verdict === "fully_realized" ? true : verdict === "not_realized" ? false : null,
      evaluator: {
        name: requireNonEmptyString(value.evaluator.name, `record ${index} evaluator name`),
        version: requireNonEmptyString(value.evaluator.version, `record ${index} evaluator version`),
        model: requireNonEmptyString(value.evaluator.model, `record ${index} evaluator model`),
      },
      evaluatedAt: requireIsoTimestamp(value.evaluatedAt, `record ${index} evaluatedAt`),
      evidenceRef: requireNonEmptyString(value.evidenceRef, `record ${index} evidenceRef`),
      evidenceSha256,
      binding: { snapshotId, workspaceTreeHash, desiredContentSha256 },
    })
  }
  return {
    name: "actual-execution-json-v2",
    resolve(query) {
      const key = `${query.participantId}\0${query.taskId}\0${query.probeId}`
      const evidence = evidenceByKey.get(key) ?? null
      if (!evidence) return null
      if (!query.workspaceSnapshot || query.desired?.presence !== "present" || !query.desired.content) {
        throw new StudyDataExportError(
          `Actual-execution evidence cannot bind to incomplete frozen output for ${query.participantId}/${query.taskId}/${query.probeId}`,
        )
      }
      if (
        evidence.binding.snapshotId !== query.workspaceSnapshot.snapshotId
        || evidence.binding.workspaceTreeHash !== query.workspaceSnapshot.treeHash
        || evidence.binding.desiredContentSha256 !== sha256Text(query.desired.content)
      ) {
        throw new StudyDataExportError(
          `Actual-execution evidence binding mismatch for ${query.participantId}/${query.taskId}/${query.probeId}`,
        )
      }
      const artifactWorkspace = artifactWorkspaces.get(key)
      if (artifactWorkspace && !sameWorkspaceSnapshot(artifactWorkspace, query.workspaceSnapshot)) {
        throw new StudyDataExportError(
          `Actual-execution artifact workspace mismatch for ${query.participantId}/${query.taskId}/${query.probeId}`,
        )
      }
      consumedKeys.add(key)
      return evidence
    },
    assertFullyConsumed() {
      const unconsumed = [...evidenceByKey.keys()].filter((key) => !consumedKeys.has(key))
      if (unconsumed.length > 0) {
        throw new StudyDataExportError(
          `Actual-execution evidence did not bind to a canonical frozen probe: ${unconsumed[0]!.replaceAll("\0", "/")}`,
        )
      }
    },
  }
}

export function actualExecutionEvidenceFromJson(raw: unknown): ActualExecutionEvidenceAdapter {
  return actualExecutionEvidenceAdapterFromJson(raw, new Map())
}

function resolveEvidenceArtifact(documentPath: string, evidenceRef: string): string {
  if (
    pathIsAbsolute(evidenceRef)
    || evidenceRef.includes("\\")
    || evidenceRef.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new StudyDataExportError(`Actual-execution evidenceRef must be a safe relative path: ${evidenceRef}`)
  }
  const base = realpathSync(dirname(documentPath))
  const artifact = realpathSync(resolve(base, ...evidenceRef.split("/")))
  const relative = relativePath(base, artifact)
  if (relative === ".." || relative.startsWith(`..${pathSeparator}`) || pathIsAbsolute(relative)) {
    throw new StudyDataExportError(`Actual-execution evidenceRef escapes its document directory: ${evidenceRef}`)
  }
  return artifact
}

function parseWorkspaceSnapshotMetadata(value: unknown, label: string): StudyWorkspaceSnapshotMetadata {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.project)) {
    throw new StudyDataExportError(`${label} is not valid workspace snapshot metadata`)
  }
  const taskId = requireNonEmptyString(value.taskId, `${label} taskId`)
  const snapshotId = requireNonEmptyString(value.snapshotId, `${label} snapshotId`)
  const projectSlug = value.project.slug
  if (projectSlug !== "apartment" && projectSlug !== "car") {
    throw new StudyDataExportError(`${label} project slug is invalid`)
  }
  if (
    !Number.isSafeInteger(value.fileCount)
    || (value.fileCount as number) < 0
    || !Number.isSafeInteger(value.totalBytes)
    || (value.totalBytes as number) < 0
    || !Array.isArray(value.exclusions)
    || value.exclusions.some((entry) => typeof entry !== "string")
  ) {
    throw new StudyDataExportError(`${label} counts or exclusions are invalid`)
  }
  return {
    schemaVersion: 1,
    taskId,
    snapshotId,
    project: {
      slug: projectSlug,
      title: requireNonEmptyString(value.project.title, `${label} project title`),
    },
    frozenAt: requireIsoTimestamp(value.frozenAt, `${label} frozenAt`),
    exportedPath: requireNonEmptyString(value.exportedPath, `${label} exportedPath`),
    treeHash: requireSha256(value.treeHash, `${label} treeHash`),
    fileCount: value.fileCount as number,
    totalBytes: value.totalBytes as number,
    exclusions: [...value.exclusions] as string[],
  }
}

function parseArtifactTask(value: unknown, label: string): {
  brief: string[]
  officialChecks: Array<{ kind: "ui" | "backend" | "design"; instruction: string; expectedResult: string }>
} {
  if (
    !isRecord(value)
    || !Array.isArray(value.brief)
    || value.brief.some((entry) => typeof entry !== "string" || !entry.trim())
    || !Array.isArray(value.officialChecks)
  ) {
    throw new StudyDataExportError(`${label} task context is malformed`)
  }
  const officialChecks = value.officialChecks.map((check, index) => {
    if (
      !isRecord(check)
      || (check.kind !== "ui" && check.kind !== "backend" && check.kind !== "design")
    ) {
      throw new StudyDataExportError(`${label} official check ${index} is malformed`)
    }
    return {
      kind: check.kind as "ui" | "backend" | "design",
      instruction: requireNonEmptyString(check.instruction, `${label} official check ${index} instruction`),
      expectedResult: requireNonEmptyString(check.expectedResult, `${label} official check ${index} expectedResult`),
    }
  })
  return { brief: [...value.brief] as string[], officialChecks }
}

function parseArtifactEvidence(value: unknown, label: string): Array<{
  path: string
  startLine: number
  endLine: number
  excerpt: string
  description: string
}> {
  if (!Array.isArray(value)) throw new StudyDataExportError(`${label} evidence is malformed`)
  return value.map((entry, index) => {
    if (
      !isRecord(entry)
      || !Number.isSafeInteger(entry.startLine)
      || !Number.isSafeInteger(entry.endLine)
      || (entry.startLine as number) < 1
      || (entry.endLine as number) < (entry.startLine as number)
    ) {
      throw new StudyDataExportError(`${label} evidence ${index} is malformed`)
    }
    const evidencePath = requireNonEmptyString(entry.path, `${label} evidence ${index} path`)
    if (
      pathIsAbsolute(evidencePath)
      || evidencePath.includes("\\")
      || evidencePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      throw new StudyDataExportError(`${label} evidence ${index} path is unsafe`)
    }
    return {
      path: evidencePath,
      startLine: entry.startLine as number,
      endLine: entry.endLine as number,
      excerpt: requireNonEmptyString(entry.excerpt, `${label} evidence ${index} excerpt`),
      description: requireNonEmptyString(entry.description, `${label} evidence ${index} description`),
    }
  })
}

function verifyActualExecutionArtifact(
  raw: unknown,
  record: JsonActualExecutionEvidenceDocument["records"][number],
  index: number,
): StudyWorkspaceSnapshotMetadata {
  const label = `Actual-execution record ${index}`
  if (
    !isRecord(raw)
    || raw.schemaVersion !== 1
    || !isRecord(raw.binding)
    || !isRecord(raw.desired)
    || !isRecord(raw.evaluator)
    || !isRecord(raw.result)
  ) {
    throw new StudyDataExportError(`${label} evidence artifact is malformed`)
  }
  const binding = {
    participantId: requireNonEmptyString(raw.binding.participantId, `${label} artifact participantId`),
    taskId: requireNonEmptyString(raw.binding.taskId, `${label} artifact taskId`),
    snapshotId: requireNonEmptyString(raw.binding.snapshotId, `${label} artifact snapshotId`),
    probeId: requireNonEmptyString(raw.binding.probeId, `${label} artifact probeId`),
  }
  const desiredContentSha256 = requireSha256(
    raw.binding.desiredContentSha256,
    `${label} artifact desiredContentSha256`,
  )
  const desired = {
    content: requireNonEmptyString(raw.desired.content, `${label} artifact Desired Content`),
    scope: raw.desired.scope,
  }
  if (desired.scope !== "session" && desired.scope !== "project" && desired.scope !== "personal") {
    throw new StudyDataExportError(`${label} artifact Desired Scope is invalid`)
  }
  const task = parseArtifactTask(raw.task, label)
  const workspace = parseWorkspaceSnapshotMetadata(raw.workspace, `${label} artifact workspace`)
  const evaluator = {
    name: requireNonEmptyString(raw.evaluator.name, `${label} artifact evaluator name`),
    version: requireNonEmptyString(raw.evaluator.version, `${label} artifact evaluator version`),
    model: requireNonEmptyString(raw.evaluator.model, `${label} artifact evaluator model`),
  }
  const evaluatedAt = requireIsoTimestamp(raw.evaluatedAt, `${label} artifact evaluatedAt`)
  const verdict = raw.result.verdict
  if (
    verdict !== "fully_realized"
    && verdict !== "partially_realized"
    && verdict !== "not_realized"
    && verdict !== "not_applicable"
    && verdict !== "uncertain"
  ) {
    throw new StudyDataExportError(`${label} artifact verdict is invalid`)
  }
  requireNonEmptyString(raw.result.rationale, `${label} artifact rationale`)
  const evidence = parseArtifactEvidence(raw.result.evidence, label)
  if (
    (verdict === "fully_realized" || verdict === "partially_realized" || verdict === "not_realized")
    && evidence.length === 0
  ) {
    throw new StudyDataExportError(`${label} artifact verdict requires frozen-output evidence`)
  }
  const expectedInputHash = sha256Text(JSON.stringify({
    schemaVersion: 1,
    binding,
    desired,
    task,
    workspace,
    evaluator,
  }))
  const inputHash = requireSha256(raw.inputHash, `${label} artifact inputHash`)
  if (inputHash !== expectedInputHash || desiredContentSha256 !== sha256Text(desired.content)) {
    throw new StudyDataExportError(`${label} evidence artifact has a stale input binding`)
  }
  if (
    binding.participantId !== record.participantId
    || binding.taskId !== record.taskId
    || binding.snapshotId !== record.snapshotId
    || binding.probeId !== record.probeId
    || desiredContentSha256 !== record.desiredContentSha256
    || workspace.taskId !== record.taskId
    || workspace.snapshotId !== record.snapshotId
    || workspace.treeHash !== record.workspaceTreeHash
    || evaluator.name !== record.evaluator.name
    || evaluator.version !== record.evaluator.version
    || evaluator.model !== record.evaluator.model
    || evaluatedAt !== record.evaluatedAt
    || verdict !== record.verdict
  ) {
    throw new StudyDataExportError(`${label} does not match its evidence artifact`)
  }
  return workspace
}

/** Load evaluator evidence and verify every referenced immutable artifact. */
export function actualExecutionEvidenceFromFile(filePath: string): ActualExecutionEvidenceAdapter {
  const documentPath = resolve(filePath)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(documentPath, "utf8"))
  } catch (error) {
    throw new StudyDataExportError(
      `Could not read actual-execution evidence document ${documentPath}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  actualExecutionEvidenceFromJson(raw)
  const document = raw as JsonActualExecutionEvidenceDocument
  const artifactWorkspaces = new Map<string, StudyWorkspaceSnapshotMetadata>()
  for (const [index, record] of document.records.entries()) {
    let artifactPath: string
    try {
      artifactPath = resolveEvidenceArtifact(documentPath, record.evidenceRef)
    } catch (error) {
      if (error instanceof StudyDataExportError) throw error
      throw new StudyDataExportError(`Could not resolve actual-execution evidence artifact ${record.evidenceRef}`)
    }
    if (sha256File(artifactPath) !== record.evidenceSha256) {
      throw new StudyDataExportError(
        `Actual-execution evidence artifact SHA-256 mismatch for ${record.participantId}/${record.taskId}/${record.probeId}`,
      )
    }
    let artifact: unknown
    try {
      artifact = JSON.parse(readFileSync(artifactPath, "utf8"))
    } catch (error) {
      throw new StudyDataExportError(
        `Could not parse actual-execution evidence artifact ${record.evidenceRef}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const key = `${record.participantId}\0${record.taskId}\0${record.probeId}`
    artifactWorkspaces.set(key, verifyActualExecutionArtifact(artifact, record, index))
  }
  return actualExecutionEvidenceAdapterFromJson(raw, artifactWorkspaces)
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ""
  const text = typeof value === "object" ? JSON.stringify(value) : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function csv<T>(columns: Array<[string, (row: T) => unknown]>, rows: T[]): string {
  return `${columns.map(([name]) => csvCell(name)).join(",")}\n${rows
    .map((row) => columns.map(([, select]) => csvCell(select(row))).join(","))
    .join("\n")}${rows.length ? "\n" : ""}`
}

/** One row per allocated participant, including the pre-Guide intake record. */
export function studyParticipantsCsv(dataset: StudyDataExport): string {
  return csv<StudyParticipantRow>([
    ["participant_id", (row) => row.participantId],
    ["allocation_mode", (row) => row.allocationMode],
    ["condition", (row) => row.condition],
    ["issued_at", (row) => row.issuedAt],
    ["claimed_at", (row) => row.claimedAt],
    ["prolific_id", (row) => row.onboarding?.prolificId],
    ["age", (row) => row.onboarding?.age],
    ["gender", (row) => row.onboarding?.gender],
    ["agent_memory_experience", (row) => row.onboarding?.agentMemoryExperience],
    ["agent_use_frequency", (row) => row.onboarding?.agentUseFrequency],
    ["agent_tools_json", (row) => row.onboarding?.agentTools],
    ["information_submitted_at", (row) => row.onboarding?.informationSubmittedAt],
    ["consent_version", (row) => row.onboarding?.consent?.version],
    ["consent_accepted_at", (row) => row.onboarding?.consent?.acceptedAt],
    ["briefing_version", (row) => row.onboarding?.briefing?.version],
    ["briefing_completed_at", (row) => row.onboarding?.briefing?.completedAt],
    ["sus_score", (row) => row.sus?.score],
    ["completion_code", (row) => row.completionReceipt?.code],
    ["completion_code_version", (row) => row.completionReceipt?.codeVersion],
    ["completion_issued_at", (row) => row.completionReceipt?.issuedAt],
    ["completion_sus_submission_id", (row) => row.completionReceipt?.susSubmissionId],
  ], dataset.participants)
}

export function studySessionsCsv(dataset: StudyDataExport): string {
  return csv<StudySessionRow>([
    ["participant_id", (row) => row.participantId],
    ["allocation_mode", (row) => row.allocationMode],
    ["condition", (row) => row.condition],
    ["task_id", (row) => row.task.id],
    ["task_order_index", (row) => row.task.orderIndex],
    ["project_slug", (row) => row.task.projectSlug],
    ["project_order_index", (row) => row.task.projectOrderIndex],
    ["session_index_within_project", (row) => row.task.sessionIndexWithinProject],
    ["status", (row) => row.lifecycle.status],
    ["snapshot_id", (row) => row.lifecycle.snapshotId],
    ["frozen_at", (row) => row.lifecycle.frozenAt],
    ["questionnaire_version", (row) => row.lifecycle.questionnaireVersion],
    ["questionnaire_submitted_at", (row) => row.lifecycle.questionnaireSubmittedAt],
    ["attention_check_id", (row) => row.attentionCheck?.checkId],
    ["attention_check_answer", (row) => row.attentionCheck?.selectedValue],
    ["attention_check_passed", (row) => row.attentionCheck?.passed],
    ["completed_at", (row) => row.lifecycle.completedAt],
    ["memory_item_count", (row) => row.memoryItemCount],
    ["monitoring_raw_tlx_score", (row) => row.monitoringRawTlx?.score],
    ["control_raw_tlx_score", (row) => row.controlRawTlx?.score],
    ["sus_score", (row) => row.sus?.score],
    ["workspace_tree_hash", (row) => row.workspaceSnapshot?.treeHash],
    ["workspace_exported_path", (row) => row.workspaceSnapshot?.exportedPath],
    ["workspace_file_count", (row) => row.workspaceSnapshot?.fileCount],
    ["workspace_total_bytes", (row) => row.workspaceSnapshot?.totalBytes],
    ["actual_execution_available_count", (row) => row.actualExecutionAvailableCount],
    ["actual_execution_partial_count", (row) => row.actualExecutionPartialCount],
    ["actual_execution_missing_count", (row) => row.actualExecutionMissingCount],
    ["actual_execution_not_applicable_count", (row) => row.actualExecutionNotApplicableCount],
    ["actual_execution_uncertain_count", (row) => row.actualExecutionUncertainCount],
    ["freeze_quality_flags", (row) => row.freezeQualityFlags],
    ["monitoring_raw_tlx_response", (row) => row.monitoringRawTlx?.response],
    ["control_raw_tlx_response", (row) => row.controlRawTlx?.response],
    ["sus_response", (row) => row.sus?.response],
  ], dataset.sessions)
}

export function studyInteractionsCsv(dataset: StudyDataExport): string {
  return csv<StudyTelemetryEvent>([
    ["event_id", (row) => row.eventId],
    ["participant_id", (row) => row.participantId],
    ["condition", (row) => row.condition],
    ["task_id", (row) => row.taskId],
    ["session_id", (row) => row.sessionId],
    ["chat_id", (row) => row.chatId],
    ["server_timestamp", (row) => row.recordedAt],
    ["client_timestamp", (row) => row.clientTimestamp],
    ["kind", (row) => row.kind],
    ["surface", (row) => row.surface],
    ["action", (row) => row.action],
    ["raw_payload", (row) => row.payload],
  ], dataset.interactions)
}

export function studyControlActionsCsv(dataset: StudyDataExport): string {
  return csv<ExportedControlAction>([
    ["event_id", (row) => row.eventId],
    ["participant_id", (row) => row.participantId],
    ["allocation_mode", (row) => row.allocationMode],
    ["condition", (row) => row.condition],
    ["task_id", (row) => row.taskId],
    ["chat_id", (row) => row.chatId],
    ["server_timestamp", (row) => row.serverTimestamp],
    ["client_timestamp", (row) => row.clientTimestamp],
    ["surface", (row) => row.surface],
    ["action", (row) => row.action],
    ["operation_id", (row) => row.operationId],
    ["control_type", (row) => row.controlType],
    ["evidence_kind", (row) => row.evidenceKind],
    ["outcome", (row) => row.outcome],
    ["terminal_timestamp", (row) => row.terminalTimestamp],
    ["raw_payload", (row) => row.payload],
  ], dataset.controlActions)
}

export function studyControlOperationsCsv(dataset: StudyDataExport): string {
  return csv<ExportedControlOperation>([
    ["participant_id", (row) => row.participantId],
    ["allocation_mode", (row) => row.allocationMode],
    ["condition", (row) => row.condition],
    ["task_id", (row) => row.taskId],
    ["operation_id", (row) => row.operationId],
    ["surface", (row) => row.surface],
    ["action", (row) => row.action],
    ["control_type", (row) => row.controlType],
    ["attempted_at", (row) => row.attemptedAt],
    ["completed_at", (row) => row.completedAt],
    ["failed_at", (row) => row.failedAt],
    ["outcome", (row) => row.outcome],
  ], dataset.controlOperations)
}

export function studyInteractionIntervalsCsv(dataset: StudyDataExport): string {
  return csv<ExportedStudyInteractionInterval>([
    ["participant_id", (row) => row.participantId],
    ["allocation_mode", (row) => row.allocationMode],
    ["condition", (row) => row.condition],
    ["task_id", (row) => row.taskId],
    ["operation_id", (row) => row.operationId],
    ["interval", (row) => row.interval],
    ["entered_at", (row) => row.enteredAt],
    ["submitted_at", (row) => row.submittedAt],
    ["duration_ms", (row) => row.durationMs],
    ["client_duration_ms", (row) => row.clientDurationMs],
    ["status", (row) => row.status],
  ], dataset.interactionIntervals)
}

export function studySurfaceExposureIntervalsCsv(dataset: StudyDataExport): string {
  return csv<ExportedStudySurfaceExposureInterval>([
    ["exposure_id", (row) => row.exposureId],
    ["participant_id", (row) => row.participantId],
    ["allocation_mode", (row) => row.allocationMode],
    ["condition", (row) => row.condition],
    ["task_id", (row) => row.taskId],
    ["chat_id", (row) => row.chatId],
    ["surface", (row) => row.surface],
    ["initiator", (row) => row.initiator],
    ["memory_ids", (row) => row.memoryIds],
    ["close_reason", (row) => row.closeReason],
    ["client_opened_at", (row) => row.clientOpenedAt],
    ["client_closed_at", (row) => row.clientClosedAt],
    ["client_visible_duration_ms", (row) => row.clientVisibleDurationMs],
    ["server_receipt_span_ms", (row) => row.serverReceiptSpanMs],
    ["status", (row) => row.status],
    ["server_recorded_transitions", (row) => row.serverRecordedTransitions],
  ], dataset.surfaceExposureIntervals)
}

export function studyStageIntervalsCsv(dataset: StudyDataExport): string {
  return csv<ExportedStudyStageInterval>([
    ["participant_id", (row) => row.participantId],
    ["allocation_mode", (row) => row.allocationMode],
    ["condition", (row) => row.condition],
    ["task_id", (row) => row.taskId],
    ["stage", (row) => row.stage],
    ["entered_at", (row) => row.enteredAt],
    ["submitted_at", (row) => row.submittedAt],
    ["duration_ms", (row) => row.durationMs],
    ["status", (row) => row.status],
  ], dataset.stageIntervals)
}

export function studyMemoryItemsCsv(dataset: StudyDataExport): string {
  return csv<StudyMemoryItemRow>([
    ["participant_id", (row) => row.participantId],
    ["allocation_mode", (row) => row.allocationMode],
    ["condition", (row) => row.condition],
    ["task_id", (row) => row.taskId],
    ["task_order_index", (row) => row.taskOrderIndex],
    ["project_slug", (row) => row.projectSlug],
    ["snapshot_id", (row) => row.snapshotId],
    ["frozen_at", (row) => row.frozenAt],
    ["probe_id", (row) => row.probeId],
    ["identity_scheme", (row) => row.identity.scheme],
    ["identity_id", (row) => row.identity.id],
    ["cue_content", (row) => row.cue.content],
    ["cue_scope", (row) => row.cue.scope],
    ["questionnaire_version", (row) => row.questionnaireVersion],
    ["desired_presence", (row) => row.desired?.presence],
    ["desired_content", (row) => row.desired?.content],
    ["desired_scope", (row) => row.desired?.scope],
    ["desired_response_kind", (row) => row.desired?.responseKind],
    ["desired_rating", (row) => row.desired?.rating],
    ["assessed_presence", (row) => row.assessed?.presence],
    ["assessed_content", (row) => row.assessed?.content],
    ["assessed_scope", (row) => row.assessed?.scope],
    ["assessed_response_kind", (row) => row.assessed?.responseKind],
    ["assessed_rating", (row) => row.assessed?.rating],
    ["object_present", (row) => row.object.present],
    ["object_status", (row) => row.object.status],
    ["object_version", (row) => row.object.version],
    ["object_content", (row) => row.object.content],
    ["object_scope", (row) => row.object.scope],
    ["participant_execution_judgment", (row) => row.participantExecutionJudgment],
    ["actual_execution", (row) => row.actualExecution?.realized],
    ["actual_execution_status", (row) => row.actualExecutionStatus],
    ["actual_execution_evidence", (row) => row.actualExecution],
    ["control_accuracy_eligible", (row) => row.controlAccuracyEligible],
    ["monitoring_accuracy_status", (row) => row.measurements.monitoringAccuracy.status],
    ["monitoring_accuracy", (row) => row.measurements.monitoringAccuracy.exactMatch],
    ["monitoring_content_match", (row) => row.measurements.monitoringAccuracy.contentMatch],
    ["monitoring_scope_match", (row) => row.measurements.monitoringAccuracy.scopeMatch],
    ["monitoring_accuracy_reason", (row) => row.measurements.monitoringAccuracy.reason],
    ["memory_alignment_status", (row) => row.measurements.memoryAlignment.status],
    ["memory_alignment", (row) => row.measurements.memoryAlignment.exactMatch],
    ["memory_content_alignment", (row) => row.measurements.memoryAlignment.contentMatch],
    ["memory_scope_alignment", (row) => row.measurements.memoryAlignment.scopeMatch],
    ["memory_alignment_reason", (row) => row.measurements.memoryAlignment.reason],
    ["perceived_discrepancy_status", (row) => row.measurements.perceivedDiscrepancy.status],
    ["perceived_discrepancy", (row) => row.measurements.perceivedDiscrepancy.discrepant],
    ["perceived_content_discrepancy", (row) => row.measurements.perceivedDiscrepancy.contentDiscrepant],
    ["perceived_scope_discrepancy", (row) => row.measurements.perceivedDiscrepancy.scopeDiscrepant],
    ["perceived_discrepancy_reason", (row) => row.measurements.perceivedDiscrepancy.reason],
    ["control_accuracy_status", (row) => row.measurements.controlAccuracy.status],
    ["control_accuracy", (row) => row.measurements.controlAccuracy.realized],
    ["control_accuracy_reason", (row) => row.measurements.controlAccuracy.reason],
    ["injection_occurrence_count", (row) => row.injectionHistory.length],
    ["injection_history", (row) => row.injectionHistory],
    ["quality_flags", (row) => row.qualityFlags],
    ["final_lineage", (row) => row.finalLineage],
    ["workspace_tree_hash", (row) => row.workspaceSnapshot?.treeHash],
    ["workspace_exported_path", (row) => row.workspaceSnapshot?.exportedPath],
  ], dataset.memoryItems)
}
