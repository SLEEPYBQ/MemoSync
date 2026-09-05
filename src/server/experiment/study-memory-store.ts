import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type {
  RawTlxActivity,
  StudyRawTlxActivityResponse,
  StudySusResponse,
} from "../../shared/studyScales"
import {
  getStudyTask,
  STUDY_QUESTIONNAIRE_VERSION,
  type StudyQuestionnaireVersion,
} from "../../shared/studyTasks"
import type { StudyAttentionCheckResult } from "../../shared/studyAttentionChecks"
import type { StaticFocusPayload } from "../memory/static-files"
import type { StudyWorkspaceSnapshotMetadata, StudyWorkspaceTreeState } from "../study-workspace-snapshot"
import type {
  StudyOnboardingInformation,
  StudyParticipantOnboardingRecord,
} from "../../shared/studyOnboarding"
import {
  STUDY_AGENT_MEMORY_EXPERIENCE,
  STUDY_AGENT_TOOLS,
  STUDY_AGENT_USE_FREQUENCIES,
  STUDY_ONBOARDING_GENDERS,
} from "../../shared/studyOnboarding"

export type StudyMemoryScope = "session" | "project" | "personal"

/** Server-owned Prolific completion code. Never ship this to client sources;
 * the client only renders the value the server returns after completion. */
export const STUDY_COMPLETION_CODE = "CAAML5VN"
export const STUDY_COMPLETION_CODE_VERSION = "2026-08-20-v1"
export type StudyFocusMode = "skills" | "plain" | "file"
export type StudyFocusOutcome = "delivered" | "empty" | "disabled" | "failed"
export type StudyCondition = "memosync" | "auto" | "static"

export type StudyTelemetryKind = "monitoring" | "control" | "participant_prompt" | "stage_enter" | "surface_exposure"

/**
 * Server-authoritative participant interaction evidence. The participant,
 * condition and task window are assigned by the study runtime rather than
 * accepted from browser payloads. JSONL remains only a projection of rows in
 * this table.
 */
export interface StudyTelemetryEvent {
  eventId: string
  recordedAt: string
  clientTimestamp: string | null
  participantId: string
  taskId: string | null
  sessionId: string | null
  chatId: string | null
  condition: StudyCondition
  kind: StudyTelemetryKind
  surface: string
  action: string
  payload: Record<string, unknown>
}

export interface StudyInstructionGuardEvent {
  eventId: string
  taskId: string
  recordedAt: string
  channel: "chat.send" | "message.enqueue" | "message.steer" | "queue.dispatch" | "ui"
  reason: "near_verbatim" | "ui_attempt"
  disqualifying: boolean
  chatId?: string
  projectId?: string
  surface?: "task_page" | "task_dialog"
  action?: "copy" | "cut" | "contextmenu" | "selectstart" | "dragstart" | "keyboard_copy" | "devtools_shortcut"
  ruleVersion?: string
  longestContiguousRun?: number
  lcsRatio?: number
  reference?: string | null
}

export interface StudyMemoryIdentity {
  scheme: string
  id: string
}

export interface StudyMemoryQualityRecord {
  code: string
  blocking: boolean
  taskId: string
  chatId: string
  turnId: string
  turn?: number
}

export interface StudyFocusItemInput {
  identity: StudyMemoryIdentity
  version: number
  content: string
  scope: StudyMemoryScope
  actualFocus?: boolean
  expectedUse?: string
  sourceRef: Record<string, unknown>
  qualityFlags?: string[]
  contentHash?: string
  stateHash?: string
}

export interface StudyFocusItem extends Omit<StudyFocusItemInput, "actualFocus" | "qualityFlags" | "contentHash" | "stateHash"> {
  actualFocus: boolean
  qualityFlags: string[]
  contentHash: string
  stateHash: string
}

export interface FocusDeliveryInput {
  injectionId: string
  taskId: string
  chatId: string
  turnId: string
  turn: number
  focusedAt: string
  condition: StudyCondition
  engine: "claude"
  mode: StudyFocusMode
  outcome: StudyFocusOutcome
  deliveryStage: "queued_to_claude"
  deliveryHash: string
  visiblePoolHash: string
  /** Resume delivery that continues one participant-triggered memory interrupt. */
  resumeOfInterruptId?: string
  items: StudyFocusItemInput[]
  qualityFlags?: string[]
}

export interface FocusDelivery extends Omit<FocusDeliveryInput, "items" | "qualityFlags"> {
  items: StudyFocusItem[]
  qualityFlags: string[]
}

export interface StudyFocusOccurrence extends StudyFocusItem {
  injectionId: string
  chatId: string
  turnId: string
  turn: number
  focusedAt: string
  resumeOfInterruptId?: string
}

export interface FrozenStudyMemoryState {
  present: boolean
  status: string | null
  version: number | null
  content: string | null
  contentHash: string | null
  stateHash: string | null
  scope: StudyMemoryScope | null
  sourceRef: Record<string, unknown> | null
}

export interface FrozenStaticLineageTarget {
  relation: StaticIdentityLineage["relation"]
  descendant: FrozenStudyMemoryState & { identity: StudyMemoryIdentity }
  qualityFlags: string[]
}

export interface StudyFreezeItem {
  probeId: string
  identity: StudyMemoryIdentity
  cue: Pick<StudyFocusItem, "version" | "content" | "contentHash" | "stateHash" | "scope" | "sourceRef">
  object: FrozenStudyMemoryState
  history: StudyFocusOccurrence[]
  qualityFlags: string[]
  finalLineage?: FrozenStaticLineageTarget[]
}

export interface StudyFreezeSnapshot {
  schemaVersion: 1 | 2
  /**
   * Version of the memory-questionnaire instrument this snapshot's answers
   * must use. Distinct from `schemaVersion` (the freeze payload shape) — the
   * two must never be conflated. A legacy payload without this field is
   * questionnaire v1; new snapshots persist 2.
   */
  questionnaireVersion?: StudyQuestionnaireVersion
  snapshotId: string
  taskId: string
  frozenAt: string
  qualityFlags: string[]
  items: StudyFreezeItem[]
  /** Immutable scoreable source tree captured at the same session boundary. */
  workspaceSnapshot?: StudyWorkspaceSnapshotMetadata
}

export interface StudyWorkspaceBaseline extends StudyWorkspaceTreeState {
  taskId: string
  capturedAt: string
}

/** The questionnaire version governing a freeze snapshot's answers. */
export function freezeQuestionnaireVersion(snapshot: Pick<StudyFreezeSnapshot, "questionnaireVersion">): StudyQuestionnaireVersion {
  return snapshot.questionnaireVersion ?? 1
}

export interface CreateFreezeSnapshotInput {
  snapshotId: string
  taskId: string
  frozenAt: string
  qualityFlags?: string[]
  objectStates?: FreezeObjectStateInput[]
  workspaceSnapshot?: StudyWorkspaceSnapshotMetadata
}

export interface FreezeObjectStateInput {
  identity: StudyMemoryIdentity
  present: boolean
  status: string | null
  version?: number
  content?: string
  scope?: StudyMemoryScope
  sourceRef?: Record<string, unknown>
  qualityFlags?: string[]
  contentHash?: string
  stateHash?: string
  finalLineage?: FrozenStaticLineageTarget[]
}

export interface QuestionnaireSubmissionInput {
  submissionId: string
  snapshotId: string
  submittedAt: string
  /** Must match the frozen snapshot's questionnaire version. */
  questionnaireVersion: StudyQuestionnaireVersion
  answers: unknown[]
  /** Null/omitted only for pilot data created before formal attention checks. */
  attentionCheck?: StudyAttentionCheckResult | null
}

export interface StudyQuestionnaireSubmission extends Omit<QuestionnaireSubmissionInput, "attentionCheck"> {
  attentionCheck: StudyAttentionCheckResult | null
  payloadHash: string
}

export interface QuestionnaireSubmissionResult {
  created: boolean
  submission: StudyQuestionnaireSubmission
}

export interface RawTlxSubmissionInput {
  submissionId: string
  completionId?: string
  snapshotId: string
  submittedAt: string
  response: StudyRawTlxActivityResponse
}

export interface StudyRawTlxSubmission extends Omit<RawTlxSubmissionInput, "completionId"> {
  payloadHash: string
}

export interface StudySessionCompletion {
  completionId: string
  taskId: string
  snapshotId: string
  completedAt: string
}

export interface RawTlxSubmissionResult {
  created: boolean
  submission: StudyRawTlxSubmission
  completion: StudySessionCompletion | null
}

export type BaselineProjectCopyCondition = Exclude<StudyCondition, "memosync">

export interface BaselineProjectCopyTransition {
  fromTaskId: string
  toTaskId: string
  condition: BaselineProjectCopyCondition
  sourceSnapshotId: string
  sourceFrozenAt: string
  status: "preparing" | "ready"
  startedAt: string
  preparedAt: string | null
  sourceRepresentationHash: string | null
  targetRepresentationHash: string | null
  manifest: Record<string, unknown> | null
  resultHash: string | null
}

export interface BeginBaselineProjectCopyTransitionInput {
  fromTaskId: string
  toTaskId: string
  condition: BaselineProjectCopyCondition
  sourceSnapshotId: string
  sourceFrozenAt: string
  startedAt: string
}

export interface CompleteBaselineProjectCopyTransitionInput {
  fromTaskId: string
  toTaskId: string
  preparedAt: string
  sourceRepresentationHash: string
  targetRepresentationHash: string
  manifest: Record<string, unknown>
}

export interface SusSubmissionInput {
  submissionId: string
  submittedAt: string
  /** Server-owned allocation identity recorded on the completion receipt. */
  participantId: string
  response: StudySusResponse
}

export interface StudySusSubmission extends Omit<SusSubmissionInput, "participantId"> {
  payloadHash: string
}

/**
 * Immutable Prolific completion receipt issued in the same transaction that
 * first accepts the final SUS. Exact retries return the original receipt.
 */
export interface StudyCompletionReceipt {
  participantId: string
  susSubmissionId: string
  code: string
  codeVersion: string
  issuedAt: string
}

export interface SusSubmissionResult {
  created: boolean
  submission: StudySusSubmission
  receipt: StudyCompletionReceipt
}

export type StaticAtomSourceRef = {
  relPath: string
  heading: string
  segmentOrdinal: number
} & Record<string, unknown>

export interface StaticAtomInput {
  content: string
  contentHash: string
  sourceRef: StaticAtomSourceRef
  qualityFlags?: string[]
}

export interface ResolveStaticAtomsInput {
  namespace: string
  snapshotHash: string
  observedAt: string
  atoms: StaticAtomInput[]
  /** Present only while atomizing a payload that was actually queued to Claude. */
  focusTaskId?: string
}

export interface StaticIdentityLineage {
  relation: "split" | "merge" | "ambiguous"
  ancestors: StudyMemoryIdentity[]
}

export interface StaticProjectCopyProvenance {
  schemaVersion: 1
  kind: "static_project_copy"
  transitionKey: string
  receiptHash: string
  source: {
    taskId: string
    projectId: string
    projectSlug: "apartment" | "car"
    snapshotId: string
    frozenAt: string
    representationHash: string
  }
  target: {
    taskId: string
    projectId: string
    projectSlug: "apartment" | "car"
    representationHash: string
  }
  files: Array<{
    relPath: string
    copiedFileHash: string
    focusedFileContentHashes: string[]
  }>
  targetContentHashesAtFirstFocus: string[]
  cloneOf?: {
    identity: StudyMemoryIdentity
    version: number
    contentHash: string
  }
}

export type StaticResolvedSourceRef = {
  kind: "static_measurement"
  namespace: string
  snapshotHash: string
  locations: StaticAtomSourceRef[]
  lineage?: StaticIdentityLineage
  projectCopy?: StaticProjectCopyProvenance
} & Record<string, unknown>

export interface StaticResolvedAtom {
  identity: StudyMemoryIdentity
  version: number
  content: string
  contentHash: string
  stateHash: string
  scope: "project"
  sourceRef: StaticResolvedSourceRef
  qualityFlags: string[]
}

export interface StaticResolutionResult {
  namespace: string
  snapshotHash: string
  observedAt: string
  atoms: StaticResolvedAtom[]
}

export interface ReserveStaticFocusDeliveryInput {
  injectionId: string
  taskId: string
  namespace: string
  chatId: string
  turnId: string
  turn: number
  focusedAt: string
  deliveryHash: string
  payload: StaticFocusPayload
}

export interface PendingStaticFocusDelivery extends ReserveStaticFocusDeliveryInput {
  dispatchSequence: number
  payloadHash: string
}

export interface PendingStaticFocusFilter {
  taskId?: string
  namespace?: string
}

export interface FinalizeStaticFocusDeliveryInput {
  injectionId: string
  /** SHA-256 returned by the extractor for the exact reserved payload. */
  payloadHash: string
  atoms: StaticAtomInput[]
  qualityFlags?: string[]
}

export interface FinalizedStaticFocusDelivery {
  resolution: StaticResolutionResult
  delivery: FocusDelivery
}

interface DeliveryRow {
  injection_id: string
  task_id: string
  chat_id: string
  turn_id: string
  turn_number: number
  focused_at: string
  condition: StudyCondition
  engine: "claude"
  mode: StudyFocusMode
  outcome: StudyFocusOutcome
  delivery_stage: "queued_to_claude"
  delivery_hash: string
  visible_pool_hash: string
  resume_of_interrupt_id: string | null
  quality_flags_json: string
}

interface FocusItemRow {
  identity_scheme: string
  identity_id: string
  version: number
  content: string
  content_hash: string
  state_hash: string
  scope: StudyMemoryScope
  actual_focus: number
  expected_use: string | null
  source_ref_json: string
  quality_flags_json: string
}

interface FocusOccurrenceRow extends FocusItemRow {
  injection_id: string
  chat_id: string
  turn_id: string
  turn_number: number
  focused_at: string
  resume_of_interrupt_id: string | null
}

interface FreezeSnapshotRow {
  payload_json: string
}

interface QuestionnaireSubmissionRow {
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

interface CompletionReceiptRow {
  participant_id: string
  sus_submission_id: string
  code: string
  code_version: string
  issued_at: string
}

interface RawTlxSubmissionRow {
  submission_id: string
  snapshot_id: string
  activity: RawTlxActivity
  submitted_at: string
  response_json: string
  payload_hash: string
}

interface SessionCompletionRow {
  completion_id: string
  task_id: string
  snapshot_id: string
  completed_at: string
}

interface BaselineProjectCopyTransitionRow {
  from_task_id: string
  to_task_id: string
  condition: BaselineProjectCopyCondition
  source_snapshot_id: string
  source_frozen_at: string
  status: "preparing" | "ready"
  started_at: string
  prepared_at: string | null
  source_representation_hash: string | null
  target_representation_hash: string | null
  manifest_json: string | null
  result_hash: string | null
}

interface StaticProjectCopyManifestFile {
  relPath: string
  byteLength: number
  sha256: string
}

interface ReadyStaticProjectCopyReceipt {
  transitionKey: string
  receiptHash: string
  source: {
    taskId: string
    projectId: string
    projectSlug: "apartment" | "car"
    snapshotId: string
    frozenAt: string
    representationHash: string
  }
  target: {
    taskId: string
    projectId: string
    projectSlug: "apartment" | "car"
    representationHash: string
  }
  files: StaticProjectCopyManifestFile[]
}

interface SusSubmissionRow {
  submission_id: string
  submitted_at: string
  response_json: string
  payload_hash: string
}

interface StaticIdentityRow {
  identity_id: string
  current_version: number
  last_content: string
  last_content_hash: string
  present: number
  status: "active" | "deleted"
  last_source_ref_json: string
  last_quality_flags_json: string
}

interface StaticAnchorRow {
  identity_id: string
  rel_path: string
  heading: string
  segment_ordinal: number
}

interface StaticFocusLedgerRow {
  dispatch_seq: number
  injection_id: string
  task_id: string
  namespace: string
  chat_id: string
  turn_id: string
  turn_number: number
  focused_at: string
  delivery_hash: string
  payload_hash: string
  payload_json: string
  status: "pending" | "completed"
  materialization_hash: string | null
}

const STUDY_MEMORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS study_focus_deliveries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  injection_id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  turn_number INTEGER NOT NULL,
  focused_at TEXT NOT NULL,
  condition TEXT NOT NULL,
  engine TEXT NOT NULL,
  mode TEXT NOT NULL,
  outcome TEXT NOT NULL,
  delivery_stage TEXT NOT NULL,
  delivery_hash TEXT NOT NULL,
  visible_pool_hash TEXT NOT NULL,
  resume_of_interrupt_id TEXT,
  quality_flags_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS study_focus_delivery_items (
  injection_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  identity_scheme TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  scope TEXT NOT NULL,
  actual_focus INTEGER NOT NULL,
  expected_use TEXT,
  source_ref_json TEXT NOT NULL,
  quality_flags_json TEXT NOT NULL,
  PRIMARY KEY (injection_id, identity_scheme, identity_id),
  FOREIGN KEY (injection_id) REFERENCES study_focus_deliveries(injection_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_study_focus_deliveries_task
  ON study_focus_deliveries(task_id, seq);

CREATE TABLE IF NOT EXISTS study_freeze_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE,
  frozen_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS study_questionnaire_submissions (
  submission_id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL UNIQUE,
  submitted_at TEXT NOT NULL,
  questionnaire_version INTEGER NOT NULL DEFAULT 1,
  answers_json TEXT NOT NULL,
  attention_check_id TEXT,
  attention_check_answer TEXT,
  attention_check_passed INTEGER CHECK (attention_check_passed IN (0, 1)),
  payload_hash TEXT NOT NULL,
  FOREIGN KEY (snapshot_id) REFERENCES study_freeze_snapshots(snapshot_id)
);

CREATE TABLE IF NOT EXISTS study_raw_tlx_submissions (
  submission_id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  activity TEXT NOT NULL CHECK (activity IN ('monitoring', 'control')),
  submitted_at TEXT NOT NULL,
  response_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  UNIQUE (snapshot_id, activity),
  FOREIGN KEY (snapshot_id) REFERENCES study_freeze_snapshots(snapshot_id)
);

CREATE TABLE IF NOT EXISTS study_session_completions (
  completion_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE,
  snapshot_id TEXT NOT NULL UNIQUE,
  completed_at TEXT NOT NULL,
  FOREIGN KEY (snapshot_id) REFERENCES study_freeze_snapshots(snapshot_id)
);

CREATE TABLE IF NOT EXISTS study_baseline_project_copy_transitions (
  from_task_id TEXT NOT NULL,
  to_task_id TEXT NOT NULL,
  condition TEXT NOT NULL CHECK (condition IN ('auto', 'static')),
  source_snapshot_id TEXT NOT NULL,
  source_frozen_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('preparing', 'ready')),
  started_at TEXT NOT NULL,
  prepared_at TEXT,
  source_representation_hash TEXT,
  target_representation_hash TEXT,
  manifest_json TEXT,
  result_hash TEXT,
  PRIMARY KEY (from_task_id, to_task_id),
  FOREIGN KEY (source_snapshot_id) REFERENCES study_freeze_snapshots(snapshot_id)
);

CREATE TABLE IF NOT EXISTS study_sus_submissions (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  submission_id TEXT NOT NULL UNIQUE,
  submitted_at TEXT NOT NULL,
  response_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS study_completion_receipts (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  participant_id TEXT NOT NULL,
  sus_submission_id TEXT NOT NULL,
  code TEXT NOT NULL,
  code_version TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  FOREIGN KEY (sus_submission_id) REFERENCES study_sus_submissions(submission_id)
);

CREATE TABLE IF NOT EXISTS study_static_identities (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  current_version INTEGER NOT NULL,
  last_content TEXT NOT NULL,
  last_content_hash TEXT NOT NULL,
  present INTEGER NOT NULL,
  status TEXT NOT NULL,
  last_source_ref_json TEXT NOT NULL,
  last_quality_flags_json TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  UNIQUE (namespace, identity_id)
);

CREATE TABLE IF NOT EXISTS study_static_versions (
  namespace TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_ref_json TEXT NOT NULL,
  quality_flags_json TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (namespace, identity_id, version),
  FOREIGN KEY (namespace, identity_id)
    REFERENCES study_static_identities(namespace, identity_id)
);

CREATE TABLE IF NOT EXISTS study_static_current_anchors (
  namespace TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  heading TEXT NOT NULL,
  segment_ordinal INTEGER NOT NULL,
  source_ref_json TEXT NOT NULL,
  PRIMARY KEY (namespace, identity_id, rel_path, heading, segment_ordinal),
  FOREIGN KEY (namespace, identity_id)
    REFERENCES study_static_identities(namespace, identity_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS study_static_extraction_cache (
  cache_key TEXT PRIMARY KEY,
  contents_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS study_static_focus_ledger (
  dispatch_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  injection_id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  turn_number INTEGER NOT NULL,
  focused_at TEXT NOT NULL,
  delivery_hash TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
  materialization_hash TEXT,
  completed_at TEXT,
  UNIQUE (task_id, chat_id, turn_id)
);

CREATE INDEX IF NOT EXISTS idx_study_static_focus_pending_task
  ON study_static_focus_ledger(task_id, status, dispatch_seq);

CREATE INDEX IF NOT EXISTS idx_study_static_focus_pending_namespace
  ON study_static_focus_ledger(namespace, status, dispatch_seq);

CREATE TABLE IF NOT EXISTS study_memory_quality_flags (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  code TEXT NOT NULL,
  blocking INTEGER NOT NULL,
  chat_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  turn_number INTEGER,
  recorded_at TEXT NOT NULL,
  UNIQUE (task_id, code, chat_id, turn_id)
);

CREATE INDEX IF NOT EXISTS idx_study_memory_quality_task
  ON study_memory_quality_flags(task_id, seq);

CREATE TABLE IF NOT EXISTS study_instruction_guard_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  channel TEXT NOT NULL,
  reason TEXT NOT NULL,
  disqualifying INTEGER NOT NULL,
  chat_id TEXT,
  project_id TEXT,
  surface TEXT,
  action TEXT,
  rule_version TEXT,
  longest_contiguous_run INTEGER,
  lcs_ratio REAL,
  reference_name TEXT
);

CREATE INDEX IF NOT EXISTS idx_study_instruction_guard_task
  ON study_instruction_guard_events(task_id, seq);

CREATE TABLE IF NOT EXISTS study_ui_receipts (
  receipt_key TEXT PRIMARY KEY,
  recorded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS study_workspace_baselines (
  task_id TEXT PRIMARY KEY,
  captured_at TEXT NOT NULL,
  tree_hash TEXT NOT NULL,
  file_count INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS study_participant_onboarding (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  participant_id TEXT NOT NULL,
  prolific_id TEXT NOT NULL,
  age INTEGER NOT NULL,
  gender TEXT NOT NULL,
  agent_memory_experience TEXT NOT NULL,
  agent_use_frequency TEXT NOT NULL,
  agent_tools_json TEXT NOT NULL,
  information_submitted_at TEXT NOT NULL,
  consent_version TEXT,
  consent_accepted_at TEXT,
  briefing_version TEXT,
  briefing_completed_at TEXT
);

CREATE TABLE IF NOT EXISTS study_telemetry_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  recorded_at TEXT NOT NULL,
  client_timestamp TEXT,
  participant_id TEXT NOT NULL,
  task_id TEXT,
  session_id TEXT,
  chat_id TEXT,
  condition TEXT NOT NULL CHECK (condition IN ('memosync', 'auto', 'static')),
  kind TEXT NOT NULL CHECK (kind IN ('monitoring', 'control', 'participant_prompt', 'stage_enter', 'surface_exposure')),
  surface TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_study_telemetry_task
  ON study_telemetry_events(task_id, seq);

CREATE INDEX IF NOT EXISTS idx_study_telemetry_kind
  ON study_telemetry_events(kind, surface, action, seq);
`

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function stateHash(content: string, scope: StudyMemoryScope): string {
  return sha256(JSON.stringify({ content, scope }))
}

function parseStringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown
  return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string") ? parsed : []
}

interface ParticipantOnboardingRow {
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

function isPersistedNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

function onboardingRecord(row: ParticipantOnboardingRow): StudyParticipantOnboardingRecord {
  const tools = parseStringArray(row.agent_tools_json)
  const validTools = tools.length > 0
    && new Set(tools).size === tools.length
    && tools.every((tool) => STUDY_AGENT_TOOLS.includes(tool as StudyOnboardingInformation["agentTools"][number]))
  const neverUsesAgents = row.agent_use_frequency === "Never"
  const validProlificId = isPersistedNonEmptyString(row.prolific_id)
    && row.prolific_id === row.prolific_id.trim()
    && row.prolific_id.length <= 200
  const validConsent = row.consent_version === null && row.consent_accepted_at === null
    || isPersistedNonEmptyString(row.consent_version) && isCanonicalIsoTimestamp(row.consent_accepted_at)
  const validBriefing = row.briefing_version === null && row.briefing_completed_at === null
    || isPersistedNonEmptyString(row.briefing_version) && isCanonicalIsoTimestamp(row.briefing_completed_at)
  const hasConsent = row.consent_version !== null
  const hasBriefing = row.briefing_version !== null
  if (
    !row.participant_id
    || !validProlificId
    || !Number.isInteger(row.age)
    || row.age < 18
    || row.age > 120
    || !row.gender
    || !row.agent_memory_experience
    || !row.agent_use_frequency
    || !isCanonicalIsoTimestamp(row.information_submitted_at)
    || !STUDY_ONBOARDING_GENDERS.includes(row.gender as StudyOnboardingInformation["gender"])
    || !STUDY_AGENT_MEMORY_EXPERIENCE.includes(row.agent_memory_experience as StudyOnboardingInformation["agentMemoryExperience"])
    || !STUDY_AGENT_USE_FREQUENCIES.includes(row.agent_use_frequency as StudyOnboardingInformation["agentUseFrequency"])
    || !validTools
    || (neverUsesAgents && (tools.length !== 1 || tools[0] !== "None"))
    || (!neverUsesAgents && tools.includes("None"))
    || !validConsent
    || !validBriefing
    || (hasBriefing && !hasConsent)
  ) {
    throw new Error("Stored study onboarding record is invalid")
  }
  return {
    participantId: row.participant_id,
    information: {
      prolificId: row.prolific_id,
      age: row.age,
      gender: row.gender as StudyOnboardingInformation["gender"],
      agentMemoryExperience: row.agent_memory_experience as StudyOnboardingInformation["agentMemoryExperience"],
      agentUseFrequency: row.agent_use_frequency as StudyOnboardingInformation["agentUseFrequency"],
      agentTools: tools as StudyOnboardingInformation["agentTools"],
    },
    informationSubmittedAt: row.information_submitted_at,
    consent: row.consent_version === null ? null : {
      version: row.consent_version,
      acceptedAt: row.consent_accepted_at!,
    },
    briefing: row.briefing_version === null ? null : {
      version: row.briefing_version,
      completedAt: row.briefing_completed_at!,
    },
  }
}

function parseSourceRef(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {}
}

function parseStaticLineage(value: string): StaticIdentityLineage | undefined {
  const sourceRef = parseSourceRef(value)
  const lineage = sourceRef.lineage
  if (typeof lineage !== "object" || lineage === null || Array.isArray(lineage)) return undefined
  const relation = (lineage as Record<string, unknown>).relation
  const ancestors = (lineage as Record<string, unknown>).ancestors
  if (relation !== "split" && relation !== "merge" && relation !== "ambiguous") return undefined
  if (!Array.isArray(ancestors)) return undefined
  const normalized: StudyMemoryIdentity[] = []
  for (const ancestor of ancestors) {
    if (typeof ancestor !== "object" || ancestor === null || Array.isArray(ancestor)) return undefined
    const scheme = (ancestor as Record<string, unknown>).scheme
    const id = (ancestor as Record<string, unknown>).id
    if (typeof scheme !== "string" || typeof id !== "string") return undefined
    normalized.push({ scheme, id })
  }
  return { relation, ancestors: normalized }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected an object`)
  }
  return value as Record<string, unknown>
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${label}: expected a non-empty string`)
  }
  return value
}

function requireSha256(value: unknown, label: string): string {
  const normalized = requireString(value, label)
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`Invalid ${label}: expected a lowercase SHA-256 value`)
  }
  return normalized
}

function requireProjectSlug(value: unknown, label: string): "apartment" | "car" {
  if (value !== "apartment" && value !== "car") {
    throw new Error(`Invalid ${label}: expected apartment or car`)
  }
  return value
}

function requireStaticRepresentationPath(value: unknown, label: string): string {
  const relPath = requireString(value, label)
  if (relPath !== "MEMORY.md" && !/^memory\/[^/\\]+\.md$/.test(relPath)) {
    throw new Error(`Invalid ${label}: expected MEMORY.md or a direct memory/*.md file`)
  }
  return relPath
}

function parseReadyStaticProjectCopyReceipt(
  transition: BaselineProjectCopyTransition,
): ReadyStaticProjectCopyReceipt {
  if (transition.condition !== "static" || transition.status !== "ready") {
    throw new Error("Static Project Copy provenance requires a ready Static transition")
  }
  const manifest = requireRecord(transition.manifest, "Static Project Copy manifest")
  if (manifest.schemaVersion !== 1 || manifest.kind !== "static_markdown_files") {
    throw new Error("Invalid Static Project Copy manifest schema")
  }
  if (manifest.outcome !== "copied" && manifest.outcome !== "already_present") {
    throw new Error("Invalid Static Project Copy manifest outcome")
  }
  const transitionKey = requireString(manifest.transitionKey, "Static Project Copy transitionKey")
  const expectedTransitionKey = `${transition.sourceSnapshotId}:${transition.fromTaskId}->${transition.toTaskId}`
  if (transitionKey !== expectedTransitionKey) {
    throw new Error(`Static Project Copy manifest transitionKey does not match ${expectedTransitionKey}`)
  }
  const source = requireRecord(manifest.source, "Static Project Copy source")
  const target = requireRecord(manifest.target, "Static Project Copy target")
  const sourceProjectSlug = requireProjectSlug(source.projectSlug, "Static Project Copy source projectSlug")
  const targetProjectSlug = requireProjectSlug(target.projectSlug, "Static Project Copy target projectSlug")
  const sourceTask = getStudyTask(transition.fromTaskId)
  const targetTask = getStudyTask(transition.toTaskId)
  if (
    !sourceTask
    || !targetTask
    || sourceTask.projectSlug !== sourceProjectSlug
    || targetTask.projectSlug !== targetProjectSlug
    || sourceProjectSlug === targetProjectSlug
  ) {
    throw new Error("Static Project Copy manifest project slugs do not match its study tasks")
  }
  const sourceProjectId = requireString(source.projectId, "Static Project Copy source projectId")
  const targetProjectId = requireString(target.projectId, "Static Project Copy target projectId")
  if (sourceProjectId === targetProjectId) {
    throw new Error("Static Project Copy source and target must be different projects")
  }
  const sourceRepresentationHash = requireSha256(
    source.representationHash,
    "Static Project Copy source representationHash",
  )
  const targetRepresentationHash = requireSha256(
    target.representationHash,
    "Static Project Copy target representationHash",
  )
  if (
    source.taskId !== transition.fromTaskId
    || source.snapshotId !== transition.sourceSnapshotId
    || target.taskId !== transition.toTaskId
    || sourceRepresentationHash !== transition.sourceRepresentationHash
    || targetRepresentationHash !== transition.targetRepresentationHash
  ) {
    throw new Error("Static Project Copy manifest does not match its durable transition receipt")
  }
  requireSha256(source.workspaceTreeHash, "Static Project Copy source workspaceTreeHash")
  if (sourceRepresentationHash !== targetRepresentationHash) {
    throw new Error("Static Project Copy provenance requires an exact representation copy")
  }
  if (!Array.isArray(manifest.files)) throw new Error("Invalid Static Project Copy file manifest")
  const seenPaths = new Set<string>()
  const files = manifest.files.map((value, index): StaticProjectCopyManifestFile => {
    const file = requireRecord(value, `Static Project Copy file ${index}`)
    const relPath = requireStaticRepresentationPath(file.relPath, `Static Project Copy file ${index} relPath`)
    if (seenPaths.has(relPath)) throw new Error(`Duplicate Static Project Copy file: ${relPath}`)
    seenPaths.add(relPath)
    if (!Number.isSafeInteger(file.byteLength) || (file.byteLength as number) < 0) {
      throw new Error(`Invalid Static Project Copy byteLength for ${relPath}`)
    }
    return {
      relPath,
      byteLength: file.byteLength as number,
      sha256: requireSha256(file.sha256, `Static Project Copy sha256 for ${relPath}`),
    }
  })
  if (!Number.isSafeInteger(manifest.totalBytes) || (manifest.totalBytes as number) < 0) {
    throw new Error("Invalid Static Project Copy totalBytes")
  }
  if (files.reduce((total, file) => total + file.byteLength, 0) !== manifest.totalBytes) {
    throw new Error("Static Project Copy totalBytes does not match its file manifest")
  }
  const computedRepresentationHash = sha256(JSON.stringify({
    schemaVersion: 1,
    kind: "static_markdown_files",
    files,
    totalBytes: manifest.totalBytes,
  }))
  if (computedRepresentationHash !== sourceRepresentationHash) {
    throw new Error("Static Project Copy file manifest does not match its representation hash")
  }
  const receiptHash = requireSha256(transition.resultHash, "Static Project Copy receipt hash")
  const computedReceiptHash = sha256(canonicalJson({
    sourceRepresentationHash,
    targetRepresentationHash,
    manifest,
  }))
  if (receiptHash !== computedReceiptHash) {
    throw new Error("Static Project Copy durable receipt hash is invalid")
  }
  return {
    transitionKey,
    receiptHash,
    source: {
      taskId: transition.fromTaskId,
      projectId: sourceProjectId,
      projectSlug: sourceProjectSlug,
      snapshotId: transition.sourceSnapshotId,
      frozenAt: requireString(transition.sourceFrozenAt, "Static Project Copy source frozenAt"),
      representationHash: sourceRepresentationHash,
    },
    target: {
      taskId: transition.toTaskId,
      projectId: targetProjectId,
      projectSlug: targetProjectSlug,
      representationHash: targetRepresentationHash,
    },
    files,
  }
}

function parseStaticProjectCopyProvenance(value: string): StaticProjectCopyProvenance | undefined {
  const sourceRef = parseSourceRef(value)
  if (sourceRef.projectCopy === undefined) return undefined
  const projectCopy = requireRecord(sourceRef.projectCopy, "Static projectCopy provenance")
  if (projectCopy.schemaVersion !== 1 || projectCopy.kind !== "static_project_copy") {
    throw new Error("Invalid Static projectCopy provenance schema")
  }
  const source = requireRecord(projectCopy.source, "Static projectCopy source")
  const target = requireRecord(projectCopy.target, "Static projectCopy target")
  if (!Array.isArray(projectCopy.files) || projectCopy.files.length === 0) {
    throw new Error("Invalid Static projectCopy file provenance")
  }
  const files = projectCopy.files.map((value, index) => {
    const file = requireRecord(value, `Static projectCopy file ${index}`)
    if (!Array.isArray(file.focusedFileContentHashes) || file.focusedFileContentHashes.length === 0) {
      throw new Error(`Invalid Static projectCopy file ${index} focusedFileContentHashes`)
    }
    return {
      relPath: requireStaticRepresentationPath(file.relPath, `Static projectCopy file ${index} relPath`),
      copiedFileHash: requireSha256(file.copiedFileHash, `Static projectCopy file ${index} copiedFileHash`),
      focusedFileContentHashes: [...new Set(file.focusedFileContentHashes.map((hash, hashIndex) => (
        requireSha256(hash, `Static projectCopy file ${index} focusedFileContentHashes ${hashIndex}`)
      )))].sort(),
    }
  })
  let cloneOf: StaticProjectCopyProvenance["cloneOf"]
  if (projectCopy.cloneOf !== undefined) {
    const clone = requireRecord(projectCopy.cloneOf, "Static projectCopy cloneOf")
    const identity = requireRecord(clone.identity, "Static projectCopy cloneOf identity")
    if (identity.scheme !== "static") throw new Error("Static projectCopy cloneOf must reference a Static identity")
    if (!Number.isSafeInteger(clone.version) || (clone.version as number) < 1) {
      throw new Error("Invalid Static projectCopy cloneOf version")
    }
    cloneOf = {
      identity: { scheme: "static", id: requireString(identity.id, "Static projectCopy cloneOf identity id") },
      version: clone.version as number,
      contentHash: requireSha256(clone.contentHash, "Static projectCopy cloneOf contentHash"),
    }
  }
  return {
    schemaVersion: 1,
    kind: "static_project_copy",
    transitionKey: requireString(projectCopy.transitionKey, "Static projectCopy transitionKey"),
    receiptHash: requireSha256(projectCopy.receiptHash, "Static projectCopy receiptHash"),
    source: {
      taskId: requireString(source.taskId, "Static projectCopy source taskId"),
      projectId: requireString(source.projectId, "Static projectCopy source projectId"),
      projectSlug: requireProjectSlug(source.projectSlug, "Static projectCopy source projectSlug"),
      snapshotId: requireString(source.snapshotId, "Static projectCopy source snapshotId"),
      frozenAt: requireString(source.frozenAt, "Static projectCopy source frozenAt"),
      representationHash: requireSha256(
        source.representationHash,
        "Static projectCopy source representationHash",
      ),
    },
    target: {
      taskId: requireString(target.taskId, "Static projectCopy target taskId"),
      projectId: requireString(target.projectId, "Static projectCopy target projectId"),
      projectSlug: requireProjectSlug(target.projectSlug, "Static projectCopy target projectSlug"),
      representationHash: requireSha256(
        target.representationHash,
        "Static projectCopy target representationHash",
      ),
    },
    files,
    targetContentHashesAtFirstFocus: (() => {
      if (
        !Array.isArray(projectCopy.targetContentHashesAtFirstFocus)
        || projectCopy.targetContentHashesAtFirstFocus.length === 0
      ) throw new Error("Invalid Static projectCopy targetContentHashesAtFirstFocus")
      return [...new Set(projectCopy.targetContentHashesAtFirstFocus.map((hash, index) => (
        requireSha256(hash, `Static projectCopy targetContentHashesAtFirstFocus ${index}`)
      )))].sort()
    })(),
    ...(cloneOf ? { cloneOf } : {}),
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Study memory payload contains a non-finite number")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    const entries = Object.keys(record)
      .sort()
      .map((key) => {
        if (record[key] === undefined) throw new Error("Study memory payload contains undefined")
        return `${JSON.stringify(key)}:${canonicalJson(record[key])}`
      })
    return `{${entries.join(",")}}`
  }
  throw new Error(`Study memory payload contains unsupported ${typeof value}`)
}

function identityKey(identity: StudyMemoryIdentity): string {
  return canonicalJson({ scheme: identity.scheme, id: identity.id })
}

export class StudyMemoryStore {
  private readonly db: Database

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath, { create: true })
    this.db.exec("PRAGMA journal_mode = DELETE")
    this.db.exec("PRAGMA foreign_keys = ON")
    this.db.exec("PRAGMA secure_delete = ON")
    this.db.exec(STUDY_MEMORY_SCHEMA)
    const telemetryTable = this.db.query(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'study_telemetry_events'
    `).get() as { sql: string } | null
    if (telemetryTable && !telemetryTable.sql.includes("surface_exposure")) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE study_telemetry_events RENAME TO study_telemetry_events_legacy;
        CREATE TABLE study_telemetry_events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          recorded_at TEXT NOT NULL,
          client_timestamp TEXT,
          participant_id TEXT NOT NULL,
          task_id TEXT,
          session_id TEXT,
          chat_id TEXT,
          condition TEXT NOT NULL CHECK (condition IN ('memosync', 'auto', 'static')),
          kind TEXT NOT NULL CHECK (kind IN ('monitoring', 'control', 'participant_prompt', 'stage_enter', 'surface_exposure')),
          surface TEXT NOT NULL,
          action TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
        INSERT INTO study_telemetry_events (
          seq, event_id, recorded_at, client_timestamp, participant_id, task_id,
          session_id, chat_id, condition, kind, surface, action, payload_json
        )
        SELECT seq, event_id, recorded_at, client_timestamp, participant_id, task_id,
               session_id, chat_id, condition, kind, surface, action, payload_json
          FROM study_telemetry_events_legacy;
        DROP TABLE study_telemetry_events_legacy;
        CREATE INDEX idx_study_telemetry_task ON study_telemetry_events(task_id, seq);
        CREATE INDEX idx_study_telemetry_kind ON study_telemetry_events(kind, surface, action, seq);
        COMMIT;
      `)
    }
    const deliveryColumns = this.db.query("PRAGMA table_info(study_focus_deliveries)").all() as Array<{ name: string }>
    if (!deliveryColumns.some((column) => column.name === "resume_of_interrupt_id")) {
      this.db.exec("ALTER TABLE study_focus_deliveries ADD COLUMN resume_of_interrupt_id TEXT")
    }
    // Legacy questionnaire submissions predate the versioned instrument and
    // migrate to questionnaire version 1 (2026-08-20 ledger, Slice B).
    const questionnaireColumns = this.db.query("PRAGMA table_info(study_questionnaire_submissions)").all() as Array<{ name: string }>
    if (!questionnaireColumns.some((column) => column.name === "questionnaire_version")) {
      this.db.exec("ALTER TABLE study_questionnaire_submissions ADD COLUMN questionnaire_version INTEGER NOT NULL DEFAULT 1")
    }
    if (!questionnaireColumns.some((column) => column.name === "attention_check_id")) {
      this.db.exec("ALTER TABLE study_questionnaire_submissions ADD COLUMN attention_check_id TEXT")
    }
    if (!questionnaireColumns.some((column) => column.name === "attention_check_answer")) {
      this.db.exec("ALTER TABLE study_questionnaire_submissions ADD COLUMN attention_check_answer TEXT")
    }
    if (!questionnaireColumns.some((column) => column.name === "attention_check_passed")) {
      this.db.exec("ALTER TABLE study_questionnaire_submissions ADD COLUMN attention_check_passed INTEGER")
    }
  }

  close(): void {
    this.db.close()
  }

  recordUiReceipt(key: string, recordedAt: string): void {
    this.db.query(`
      INSERT INTO study_ui_receipts (receipt_key, recorded_at)
      VALUES (?, ?)
      ON CONFLICT (receipt_key) DO NOTHING
    `).run(key, recordedAt)
  }

  hasUiReceipt(key: string): boolean {
    return this.db.query(`
      SELECT 1 AS found FROM study_ui_receipts WHERE receipt_key = ? LIMIT 1
    `).get(key) !== null
  }

  recordWorkspaceBaseline(input: StudyWorkspaceBaseline): StudyWorkspaceBaseline {
    this.db.query(`
      INSERT INTO study_workspace_baselines (task_id, captured_at, tree_hash, file_count, total_bytes)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (task_id) DO NOTHING
    `).run(input.taskId, input.capturedAt, input.treeHash, input.fileCount, input.totalBytes)
    const stored = this.getWorkspaceBaseline(input.taskId)
    if (!stored) throw new Error(`Study workspace baseline was not persisted for ${input.taskId}`)
    return stored
  }

  getWorkspaceBaseline(taskId: string): StudyWorkspaceBaseline | null {
    const row = this.db.query(`
      SELECT task_id, captured_at, tree_hash, file_count, total_bytes
        FROM study_workspace_baselines
       WHERE task_id = ?
    `).get(taskId) as {
      task_id: string
      captured_at: string
      tree_hash: string
      file_count: number
      total_bytes: number
    } | null
    return row ? {
      taskId: row.task_id,
      capturedAt: row.captured_at,
      treeHash: row.tree_hash,
      fileCount: row.file_count,
      totalBytes: row.total_bytes,
    } : null
  }

  recordStudyTelemetryEvent(input: StudyTelemetryEvent): { created: boolean; event: StudyTelemetryEvent } {
    const payloadJson = canonicalJson(input.payload)
    const result = this.db.query(`
      INSERT INTO study_telemetry_events (
        event_id, recorded_at, client_timestamp, participant_id, task_id,
        session_id, chat_id, condition, kind, surface, action, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO NOTHING
    `).run(
      input.eventId,
      input.recordedAt,
      input.clientTimestamp,
      input.participantId,
      input.taskId,
      input.sessionId,
      input.chatId,
      input.condition,
      input.kind,
      input.surface,
      input.action,
      payloadJson,
    )
    const event = this.getStudyTelemetryEvent(input.eventId)
    if (!event) throw new Error(`Study telemetry event was not persisted: ${input.eventId}`)
    if (canonicalJson(event) !== canonicalJson(input)) {
      throw new Error(`Study telemetry event id was reused with different evidence: ${input.eventId}`)
    }
    return { created: result.changes === 1, event }
  }

  getStudyTelemetryEvent(eventId: string): StudyTelemetryEvent | null {
    const row = this.db.query(`
      SELECT event_id, recorded_at, client_timestamp, participant_id, task_id,
             session_id, chat_id, condition, kind, surface, action, payload_json
        FROM study_telemetry_events
       WHERE event_id = ?
    `).get(eventId) as {
      event_id: string
      recorded_at: string
      client_timestamp: string | null
      participant_id: string
      task_id: string | null
      session_id: string | null
      chat_id: string | null
      condition: StudyCondition
      kind: StudyTelemetryKind
      surface: string
      action: string
      payload_json: string
    } | null
    return row ? {
      eventId: row.event_id,
      recordedAt: row.recorded_at,
      clientTimestamp: row.client_timestamp,
      participantId: row.participant_id,
      taskId: row.task_id,
      sessionId: row.session_id,
      chatId: row.chat_id,
      condition: row.condition,
      kind: row.kind,
      surface: row.surface,
      action: row.action,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    } : null
  }

  listStudyTelemetryEvents(): StudyTelemetryEvent[] {
    const rows = this.db.query(`
      SELECT event_id
        FROM study_telemetry_events
       ORDER BY seq ASC
    `).all() as Array<{ event_id: string }>
    return rows.map((row) => this.getStudyTelemetryEvent(row.event_id)!)
  }

  listStudySurfaceExposureEvents(exposureId: string): StudyTelemetryEvent[] {
    const rows = this.db.query(`
      SELECT event_id
        FROM study_telemetry_events
       WHERE kind = 'surface_exposure'
         AND json_extract(payload_json, '$.exposureId') = ?
       ORDER BY seq ASC
    `).all(exposureId) as Array<{ event_id: string }>
    return rows.map((row) => this.getStudyTelemetryEvent(row.event_id)!)
  }

  /**
   * Resolve only durable, server-attributed task evidence for a chat. More
   * than one result is deliberately exposed to the caller as ambiguity rather
   * than choosing whichever task happened to be active most recently.
   */
  listStudyTelemetryTaskIdsForChat(chatId: string): string[] {
    const rows = this.db.query(`
      SELECT DISTINCT task_id
        FROM study_telemetry_events
       WHERE chat_id = ?
         AND task_id IS NOT NULL
       ORDER BY task_id ASC
    `).all(chatId) as Array<{ task_id: string }>
    return rows.map((row) => row.task_id)
  }

  getStudySessionExposureAt(taskId: string): string | null {
    const row = this.db.query(`
      SELECT recorded_at
        FROM study_telemetry_events
       WHERE task_id = ?
         AND kind = 'stage_enter'
         AND surface = 'study'
         AND action = 'session_exposure'
       ORDER BY seq ASC
       LIMIT 1
    `).get(taskId) as { recorded_at: string } | null
    return row?.recorded_at ?? null
  }

  getParticipantOnboarding(): StudyParticipantOnboardingRecord | null {
    const row = this.db.query(`
      SELECT participant_id, prolific_id, age, gender, agent_memory_experience,
             agent_use_frequency, agent_tools_json, information_submitted_at,
             consent_version, consent_accepted_at, briefing_version, briefing_completed_at
        FROM study_participant_onboarding
       WHERE singleton = 1
    `).get() as ParticipantOnboardingRow | null
    return row ? onboardingRecord(row) : null
  }

  saveParticipantOnboardingInformation(input: {
    participantId: string
    information: StudyOnboardingInformation
    submittedAt: string
  }): StudyParticipantOnboardingRecord {
    const transaction = this.db.transaction(() => {
      const existing = this.getParticipantOnboarding()
      if (existing?.participantId !== undefined && existing.participantId !== input.participantId) {
        throw new Error("Stored study onboarding belongs to a different allocation participant")
      }
      if (existing?.consent) {
        const sameInformation = JSON.stringify(existing.information) === JSON.stringify(input.information)
        if (!sameInformation) throw new Error("Study onboarding information cannot be changed after consent")
        return existing
      }
      this.db.query(`
        INSERT INTO study_participant_onboarding (
          singleton, participant_id, prolific_id, age, gender, agent_memory_experience,
          agent_use_frequency, agent_tools_json, information_submitted_at,
          consent_version, consent_accepted_at, briefing_version, briefing_completed_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)
        ON CONFLICT(singleton) DO UPDATE SET
          participant_id = excluded.participant_id,
          prolific_id = excluded.prolific_id,
          age = excluded.age,
          gender = excluded.gender,
          agent_memory_experience = excluded.agent_memory_experience,
          agent_use_frequency = excluded.agent_use_frequency,
          agent_tools_json = excluded.agent_tools_json,
          information_submitted_at = excluded.information_submitted_at
      `).run(
        input.participantId,
        input.information.prolificId,
        input.information.age,
        input.information.gender,
        input.information.agentMemoryExperience,
        input.information.agentUseFrequency,
        JSON.stringify(input.information.agentTools),
        input.submittedAt,
      )
      return this.getParticipantOnboarding()!
    })
    return transaction()
  }

  recordParticipantOnboardingConsent(input: {
    participantId: string
    version: string
    acceptedAt: string
  }): StudyParticipantOnboardingRecord {
    const transaction = this.db.transaction(() => {
      const existing = this.getParticipantOnboarding()
      if (!existing) throw new Error("Study onboarding information is required before consent")
      if (existing.participantId !== input.participantId) {
        throw new Error("Stored study onboarding belongs to a different allocation participant")
      }
      if (existing.consent?.version === input.version) return existing
      this.db.query(`
        UPDATE study_participant_onboarding
           SET consent_version = ?, consent_accepted_at = ?,
               briefing_version = NULL, briefing_completed_at = NULL
         WHERE singleton = 1
      `).run(input.version, input.acceptedAt)
      return this.getParticipantOnboarding()!
    })
    return transaction()
  }

  recordParticipantOnboardingBriefing(input: {
    participantId: string
    version: string
    completedAt: string
  }): StudyParticipantOnboardingRecord {
    const transaction = this.db.transaction(() => {
      const existing = this.getParticipantOnboarding()
      if (!existing?.consent) throw new Error("Study consent is required before briefing")
      if (existing.participantId !== input.participantId) {
        throw new Error("Stored study onboarding belongs to a different allocation participant")
      }
      if (existing.briefing?.version === input.version) return existing
      this.db.query(`
        UPDATE study_participant_onboarding
           SET briefing_version = ?, briefing_completed_at = ?
         WHERE singleton = 1
      `).run(input.version, input.completedAt)
      return this.getParticipantOnboarding()!
    })
    return transaction()
  }

  beginBaselineProjectCopyTransition(
    input: BeginBaselineProjectCopyTransitionInput,
  ): BaselineProjectCopyTransition {
    const transaction = this.db.transaction(() => {
      const existing = this.getBaselineProjectCopyTransition(input.fromTaskId, input.toTaskId)
      if (existing) {
        if (
          existing.condition !== input.condition
          || existing.sourceSnapshotId !== input.sourceSnapshotId
          || existing.sourceFrozenAt !== input.sourceFrozenAt
        ) {
          throw new Error(
            `Baseline project copy transition conflicts for ${input.fromTaskId} -> ${input.toTaskId}`,
          )
        }
        return existing
      }
      this.db.query(`
        INSERT INTO study_baseline_project_copy_transitions (
          from_task_id, to_task_id, condition, source_snapshot_id,
          source_frozen_at, status, started_at
        ) VALUES (?, ?, ?, ?, ?, 'preparing', ?)
      `).run(
        input.fromTaskId,
        input.toTaskId,
        input.condition,
        input.sourceSnapshotId,
        input.sourceFrozenAt,
        input.startedAt,
      )
      return this.getBaselineProjectCopyTransition(input.fromTaskId, input.toTaskId)!
    })
    return transaction()
  }

  completeBaselineProjectCopyTransition(
    input: CompleteBaselineProjectCopyTransitionInput,
  ): BaselineProjectCopyTransition {
    const hashPattern = /^[a-f0-9]{64}$/
    if (!hashPattern.test(input.sourceRepresentationHash) || !hashPattern.test(input.targetRepresentationHash)) {
      throw new Error("Baseline project copy representation hashes must be lowercase SHA-256 values")
    }
    const manifestJson = canonicalJson(input.manifest)
    const resultHash = sha256(canonicalJson({
      sourceRepresentationHash: input.sourceRepresentationHash,
      targetRepresentationHash: input.targetRepresentationHash,
      manifest: input.manifest,
    }))
    const transaction = this.db.transaction(() => {
      const existing = this.getBaselineProjectCopyTransition(input.fromTaskId, input.toTaskId)
      if (!existing) {
        throw new Error(`Unknown baseline project copy transition ${input.fromTaskId} -> ${input.toTaskId}`)
      }
      if (existing.status === "ready") {
        if (existing.resultHash !== resultHash) {
          throw new Error(
            `Baseline project copy transition result conflicts for ${input.fromTaskId} -> ${input.toTaskId}`,
          )
        }
        return existing
      }
      this.db.query(`
        UPDATE study_baseline_project_copy_transitions
           SET status = 'ready',
               prepared_at = ?,
               source_representation_hash = ?,
               target_representation_hash = ?,
               manifest_json = ?,
               result_hash = ?
         WHERE from_task_id = ? AND to_task_id = ? AND status = 'preparing'
      `).run(
        input.preparedAt,
        input.sourceRepresentationHash,
        input.targetRepresentationHash,
        manifestJson,
        resultHash,
        input.fromTaskId,
        input.toTaskId,
      )
      const completed = this.getBaselineProjectCopyTransition(input.fromTaskId, input.toTaskId)
      if (!completed || completed.status !== "ready") {
        throw new Error(`Could not complete baseline project copy transition ${input.fromTaskId} -> ${input.toTaskId}`)
      }
      if (completed.resultHash !== resultHash) {
        throw new Error(
          `Baseline project copy transition result conflicts for ${input.fromTaskId} -> ${input.toTaskId}`,
        )
      }
      return completed
    })
    return transaction()
  }

  getBaselineProjectCopyTransition(
    fromTaskId: string,
    toTaskId: string,
  ): BaselineProjectCopyTransition | null {
    const row = this.db.query(`
      SELECT from_task_id, to_task_id, condition, source_snapshot_id,
             source_frozen_at, status, started_at, prepared_at,
             source_representation_hash, target_representation_hash,
             manifest_json, result_hash
        FROM study_baseline_project_copy_transitions
       WHERE from_task_id = ? AND to_task_id = ?
    `).get(fromTaskId, toTaskId) as BaselineProjectCopyTransitionRow | null
    return row ? this.hydrateBaselineProjectCopyTransition(row) : null
  }

  recordInstructionGuardEvent(event: StudyInstructionGuardEvent): void {
    this.db.query(`
      INSERT INTO study_instruction_guard_events (
        event_id, task_id, recorded_at, channel, reason, disqualifying,
        chat_id, project_id, surface, action, rule_version,
        longest_contiguous_run, lcs_ratio, reference_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (event_id) DO NOTHING
    `).run(
      event.eventId,
      event.taskId,
      event.recordedAt,
      event.channel,
      event.reason,
      event.disqualifying ? 1 : 0,
      event.chatId ?? null,
      event.projectId ?? null,
      event.surface ?? null,
      event.action ?? null,
      event.ruleVersion ?? null,
      event.longestContiguousRun ?? null,
      event.lcsRatio ?? null,
      event.reference ?? null,
    )
  }

  listInstructionGuardEvents(taskId: string): StudyInstructionGuardEvent[] {
    const rows = this.db.query(`
      SELECT event_id, task_id, recorded_at, channel, reason, disqualifying,
             chat_id, project_id, surface, action, rule_version,
             longest_contiguous_run, lcs_ratio, reference_name
        FROM study_instruction_guard_events
       WHERE task_id = ?
       ORDER BY seq ASC
    `).all(taskId) as Array<Record<string, string | number | null>>
    return rows.map((row) => ({
      eventId: row.event_id as string,
      taskId: row.task_id as string,
      recordedAt: row.recorded_at as string,
      channel: row.channel as StudyInstructionGuardEvent["channel"],
      reason: row.reason as StudyInstructionGuardEvent["reason"],
      disqualifying: row.disqualifying === 1,
      ...(row.chat_id ? { chatId: row.chat_id as string } : {}),
      ...(row.project_id ? { projectId: row.project_id as string } : {}),
      ...(row.surface ? { surface: row.surface as StudyInstructionGuardEvent["surface"] } : {}),
      ...(row.action ? { action: row.action as StudyInstructionGuardEvent["action"] } : {}),
      ...(row.rule_version ? { ruleVersion: row.rule_version as string } : {}),
      ...(row.longest_contiguous_run === null ? {} : { longestContiguousRun: row.longest_contiguous_run as number }),
      ...(row.lcs_ratio === null ? {} : { lcsRatio: row.lcs_ratio as number }),
      ...(row.reference_name === null ? {} : { reference: row.reference_name as string }),
    }))
  }

  hasDisqualifyingInstructionViolation(taskId?: string): boolean {
    const row = taskId
      ? this.db.query(`
          SELECT 1 AS found FROM study_instruction_guard_events
           WHERE task_id = ? AND disqualifying = 1 LIMIT 1
        `).get(taskId)
      : this.db.query(`
          SELECT 1 AS found FROM study_instruction_guard_events
           WHERE disqualifying = 1 LIMIT 1
        `).get()
    return row !== null
  }

  recordStudyMemoryQualityFlag(flag: StudyMemoryQualityRecord): void {
    this.db.query(`
      INSERT INTO study_memory_quality_flags (
        task_id, code, blocking, chat_id, turn_id, turn_number, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (task_id, code, chat_id, turn_id) DO UPDATE SET
        blocking = excluded.blocking,
        turn_number = excluded.turn_number,
        recorded_at = excluded.recorded_at
    `).run(
      flag.taskId,
      flag.code,
      flag.blocking ? 1 : 0,
      flag.chatId,
      flag.turnId,
      flag.turn ?? null,
      new Date().toISOString(),
    )
  }

  clearStudyMemoryQualityFlag(flag: Pick<StudyMemoryQualityRecord, "taskId" | "code" | "chatId" | "turnId">): void {
    this.db.query(`
      DELETE FROM study_memory_quality_flags
       WHERE task_id = ? AND code = ? AND chat_id = ? AND turn_id = ?
    `).run(flag.taskId, flag.code, flag.chatId, flag.turnId)
  }

  listStudyMemoryQualityFlags(taskId: string): StudyMemoryQualityRecord[] {
    const rows = this.db.query(`
      SELECT code, blocking, task_id, chat_id, turn_id, turn_number
        FROM study_memory_quality_flags
       WHERE task_id = ?
       ORDER BY seq ASC
    `).all(taskId) as Array<{
      code: string
      blocking: number
      task_id: string
      chat_id: string
      turn_id: string
      turn_number: number | null
    }>
    return rows.map((row) => ({
      code: row.code,
      blocking: row.blocking === 1,
      taskId: row.task_id,
      chatId: row.chat_id,
      turnId: row.turn_id,
      ...(row.turn_number === null ? {} : { turn: row.turn_number }),
    }))
  }

  get(key: string): string[] | null {
    const row = this.db.query(`
      SELECT contents_json
        FROM study_static_extraction_cache
       WHERE cache_key = ?
    `).get(key) as { contents_json: string } | null
    if (!row) return null
    const parsed = JSON.parse(row.contents_json) as unknown
    if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
      throw new Error(`Corrupt Static extraction cache entry: ${key}`)
    }
    return [...parsed]
  }

  set(key: string, contents: string[]): void {
    if (!contents.every((entry) => typeof entry === "string")) {
      throw new Error(`Static extraction cache entry contains a non-string value: ${key}`)
    }
    this.db.query(`
      INSERT INTO study_static_extraction_cache (cache_key, contents_json)
      VALUES (?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET contents_json = excluded.contents_json
    `).run(key, JSON.stringify([...contents]))
  }

  /**
   * Durably reserve one Static turn immediately after its exact text payload is
   * queued to Claude. The row is the restart-safe hand-off to the asynchronous
   * atomizer; questionnaire freeze must treat it as unfinished until finalized.
   */
  reserveStaticFocusDelivery(input: ReserveStaticFocusDeliveryInput): PendingStaticFocusDelivery {
    const payloadJson = canonicalJson(input.payload)
    const payload = JSON.parse(payloadJson) as StaticFocusPayload
    const normalized = {
      injectionId: input.injectionId,
      taskId: input.taskId,
      namespace: input.namespace,
      chatId: input.chatId,
      turnId: input.turnId,
      turn: input.turn,
      focusedAt: input.focusedAt,
      deliveryHash: input.deliveryHash,
      payload,
      payloadHash: sha256(payload.text),
    }
    const existing = this.getStaticFocusLedger(input.injectionId)
    if (existing) {
      if (existing.status !== "pending") {
        throw new Error(`Static focus delivery is already completed: ${input.injectionId}`)
      }
      const hydrated = this.hydratePendingStaticFocus(existing)
      if (canonicalJson(hydrated) === canonicalJson({ dispatchSequence: hydrated.dispatchSequence, ...normalized })) {
        return hydrated
      }
      throw new Error(`Pending Static focus already exists with different content: ${input.injectionId}`)
    }
    const sameTurn = this.db.query(`
      SELECT injection_id
        FROM study_static_focus_ledger
       WHERE task_id = ? AND chat_id = ? AND turn_id = ?
    `).get(input.taskId, input.chatId, input.turnId) as { injection_id: string } | null
    if (sameTurn) {
      throw new Error(`Static focus turn is already reserved as ${sameTurn.injection_id}`)
    }
    this.db.query(`
      INSERT INTO study_static_focus_ledger (
        injection_id, task_id, namespace, chat_id, turn_id, turn_number,
        focused_at, delivery_hash, payload_hash, payload_json, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      normalized.injectionId,
      normalized.taskId,
      normalized.namespace,
      normalized.chatId,
      normalized.turnId,
      normalized.turn,
      normalized.focusedAt,
      normalized.deliveryHash,
      normalized.payloadHash,
      payloadJson,
    )
    return this.hydratePendingStaticFocus(this.getStaticFocusLedger(input.injectionId)!)
  }

  /** Pending Static turns in their durable dispatch order, optionally scoped. */
  listPendingStaticFocusDeliveries(filter: PendingStaticFocusFilter = {}): PendingStaticFocusDelivery[] {
    const clauses = ["status = 'pending'"]
    const params: string[] = []
    if (filter.taskId !== undefined) {
      clauses.push("task_id = ?")
      params.push(filter.taskId)
    }
    if (filter.namespace !== undefined) {
      clauses.push("namespace = ?")
      params.push(filter.namespace)
    }
    const rows = this.db.query(`
      SELECT dispatch_seq, injection_id, task_id, namespace, chat_id, turn_id,
             turn_number, focused_at, delivery_hash, payload_hash, payload_json,
             status, materialization_hash
        FROM study_static_focus_ledger
       WHERE ${clauses.join(" AND ")}
       ORDER BY dispatch_seq ASC
    `).all(...params) as StaticFocusLedgerRow[]
    return rows.map((row) => this.hydratePendingStaticFocus(row))
  }

  hasPendingStaticFocusDeliveries(taskId: string): boolean {
    return this.db.query(`
      SELECT 1 AS present
        FROM study_static_focus_ledger
       WHERE task_id = ? AND status = 'pending'
       LIMIT 1
    `).get(taskId) !== null
  }

  /**
   * Apply extracted atoms and publish the corresponding focus delivery as one
   * SQLite transaction. A later turn for the same Static namespace cannot
   * overtake an earlier pending turn, even if its LLM extraction finishes first.
   */
  finalizeStaticFocusDelivery(input: FinalizeStaticFocusDeliveryInput): FinalizedStaticFocusDelivery {
    const ledger = this.getStaticFocusLedger(input.injectionId)
    if (!ledger) throw new Error(`Pending Static focus delivery not found: ${input.injectionId}`)
    if (input.payloadHash !== ledger.payload_hash) {
      throw new Error(`Static extractor payload hash does not match reserved focus: ${input.injectionId}`)
    }
    const materializationHash = sha256(canonicalJson({
      payloadHash: input.payloadHash,
      atoms: input.atoms,
      qualityFlags: input.qualityFlags ?? [],
    }))
    if (ledger.status === "completed") {
      if (ledger.materialization_hash !== materializationHash) {
        throw new Error(`Static focus delivery is already completed with different atoms: ${input.injectionId}`)
      }
      const delivery = this.getDelivery(input.injectionId)
      if (!delivery) throw new Error(`Completed Static focus is missing its delivery: ${input.injectionId}`)
      return {
        resolution: this.staticResolutionFromDelivery(ledger, delivery),
        delivery,
      }
    }
    const earlier = this.db.query(`
      SELECT injection_id
        FROM study_static_focus_ledger
       WHERE namespace = ? AND status = 'pending' AND dispatch_seq < ?
       ORDER BY dispatch_seq ASC
       LIMIT 1
    `).get(ledger.namespace, ledger.dispatch_seq) as { injection_id: string } | null
    if (earlier) {
      throw new Error(
        `Cannot finalize ${input.injectionId} before earlier pending Static focus ${earlier.injection_id}`,
      )
    }

    const transaction = this.db.transaction((): FinalizedStaticFocusDelivery => {
      const resolution = this.resolveStaticAtoms({
        namespace: ledger.namespace,
        snapshotHash: ledger.payload_hash,
        observedAt: ledger.focused_at,
        atoms: input.atoms,
        focusTaskId: ledger.task_id,
      })
      const delivery = this.recordFocusDelivery({
        injectionId: ledger.injection_id,
        taskId: ledger.task_id,
        chatId: ledger.chat_id,
        turnId: ledger.turn_id,
        turn: ledger.turn_number,
        focusedAt: ledger.focused_at,
        condition: "static",
        engine: "claude",
        mode: "file",
        outcome: resolution.atoms.length ? "delivered" : "empty",
        deliveryStage: "queued_to_claude",
        deliveryHash: ledger.delivery_hash,
        visiblePoolHash: ledger.payload_hash,
        qualityFlags: input.qualityFlags ?? [],
        items: resolution.atoms,
      })
      const updated = this.db.query(`
        UPDATE study_static_focus_ledger
           SET status = 'completed', materialization_hash = ?, completed_at = ?
         WHERE injection_id = ? AND status = 'pending'
      `).run(materializationHash, new Date().toISOString(), input.injectionId)
      if (updated.changes !== 1) {
        throw new Error(`Static focus completion lost its pending reservation: ${input.injectionId}`)
      }
      return { resolution, delivery }
    })
    return transaction()
  }

  recordFocusDelivery(input: FocusDeliveryInput): FocusDelivery {
    const normalized = this.normalizeFocusDelivery(input)
    const existing = this.getDelivery(input.injectionId)
    if (existing) {
      if (canonicalJson(existing) === canonicalJson(normalized)) return existing
      throw new Error(`Focus delivery already exists with different content: ${input.injectionId}`)
    }
    const transaction = this.db.transaction(() => {
      this.db.query(`
        INSERT INTO study_focus_deliveries (
          injection_id, task_id, chat_id, turn_id, turn_number, focused_at,
          condition, engine, mode, outcome, delivery_stage,
          delivery_hash, visible_pool_hash, resume_of_interrupt_id, quality_flags_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalized.injectionId,
        normalized.taskId,
        normalized.chatId,
        normalized.turnId,
        normalized.turn,
        normalized.focusedAt,
        normalized.condition,
        normalized.engine,
        normalized.mode,
        normalized.outcome,
        normalized.deliveryStage,
        normalized.deliveryHash,
        normalized.visiblePoolHash,
        normalized.resumeOfInterruptId ?? null,
        JSON.stringify(normalized.qualityFlags),
      )

      const insertItem = this.db.query(`
        INSERT INTO study_focus_delivery_items (
          injection_id, ordinal, identity_scheme, identity_id, version,
          content, content_hash, state_hash, scope, actual_focus,
          expected_use, source_ref_json, quality_flags_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      normalized.items.forEach((item, ordinal) => {
        insertItem.run(
          normalized.injectionId,
          ordinal,
          item.identity.scheme,
          item.identity.id,
          item.version,
          item.content,
          item.contentHash,
          item.stateHash,
          item.scope,
          item.actualFocus ? 1 : 0,
          item.expectedUse ?? null,
          JSON.stringify(item.sourceRef),
          JSON.stringify(item.qualityFlags),
        )
      })
    })
    transaction()
    return this.getDelivery(normalized.injectionId)!
  }

  listTaskDeliveries(taskId: string): FocusDelivery[] {
    const rows = this.db.query(`
      SELECT d.injection_id, d.task_id, d.chat_id, d.turn_id, d.turn_number, d.focused_at,
             d.condition, d.engine, d.mode, d.outcome, d.delivery_stage,
             d.delivery_hash, d.visible_pool_hash, d.resume_of_interrupt_id, d.quality_flags_json
        FROM study_focus_deliveries d
        LEFT JOIN study_static_focus_ledger s ON s.injection_id = d.injection_id
       WHERE d.task_id = ?
       ORDER BY COALESCE(s.dispatch_seq, d.seq) ASC, d.seq ASC
    `).all(taskId) as DeliveryRow[]
    return rows.map((row) => this.hydrateDelivery(row))
  }

  resolveStaticAtoms(input: ResolveStaticAtomsInput): StaticResolutionResult {
    const groups = new Map<string, {
      content: string
      contentHash: string
      locations: StaticAtomSourceRef[]
      locationKeys: Set<string>
      qualityFlags: string[]
    }>()
    for (const atom of input.atoms) {
      if (sha256(atom.content) !== atom.contentHash) {
        throw new Error(`Incorrect Static content hash for ${atom.sourceRef.relPath}:${atom.sourceRef.segmentOrdinal}`)
      }
      const contentKey = canonicalJson({ content: atom.content, contentHash: atom.contentHash })
      let group = groups.get(contentKey)
      if (!group) {
        group = {
          content: atom.content,
          contentHash: atom.contentHash,
          locations: [],
          locationKeys: new Set(),
          qualityFlags: [],
        }
        groups.set(contentKey, group)
      }
      const location = JSON.parse(canonicalJson(atom.sourceRef)) as StaticAtomSourceRef
      const locationKey = canonicalJson(location)
      if (!group.locationKeys.has(locationKey)) {
        group.locationKeys.add(locationKey)
        group.locations.push(location)
      }
      for (const flag of atom.qualityFlags ?? []) {
        if (!group.qualityFlags.includes(flag)) group.qualityFlags.push(flag)
      }
    }

    const transaction = this.db.transaction(() => {
      const groupList = [...groups.values()]
      const projectCopyReceipt = input.focusTaskId
        ? this.findStaticProjectCopyReceipt(input.namespace, input.focusTaskId)
        : null
      const priorAnchors = this.db.query(`
        SELECT identity_id, rel_path, heading, segment_ordinal
          FROM study_static_current_anchors
         WHERE namespace = ?
      `).all(input.namespace) as StaticAnchorRow[]
      const identitiesByAnchor = new Map<string, Set<string>>()
      for (const anchor of priorAnchors) {
        const key = canonicalJson({
          relPath: anchor.rel_path,
          heading: anchor.heading,
          segmentOrdinal: anchor.segment_ordinal,
        })
        const identities = identitiesByAnchor.get(key) ?? new Set<string>()
        identities.add(anchor.identity_id)
        identitiesByAnchor.set(key, identities)
      }
      const anchorCandidates = groupList.map((group) => {
        const candidates = new Set<string>()
        for (const location of group.locations) {
          const key = canonicalJson({
            relPath: location.relPath,
            heading: location.heading,
            segmentOrdinal: location.segmentOrdinal,
          })
          for (const identityId of identitiesByAnchor.get(key) ?? []) candidates.add(identityId)
        }
        return candidates
      })
      const candidateGroupCounts = new Map<string, number>()
      for (const candidates of anchorCandidates) {
        for (const identityId of candidates) {
          candidateGroupCounts.set(identityId, (candidateGroupCounts.get(identityId) ?? 0) + 1)
        }
      }

      const getIdentity = (identityId: string): StaticIdentityRow | null => this.db.query(`
        SELECT identity_id, current_version, last_content, last_content_hash,
               present, status, last_source_ref_json, last_quality_flags_json
          FROM study_static_identities
         WHERE namespace = ? AND identity_id = ?
      `).get(input.namespace, identityId) as StaticIdentityRow | null

      const claimedIdentityIds = new Set<string>()
      const resolved = groupList.map((group, groupIndex) => {
        const currentMatches = this.db.query(`
          SELECT identity_id, current_version, last_content, last_content_hash,
                 present, status, last_source_ref_json, last_quality_flags_json
            FROM study_static_identities
           WHERE namespace = ? AND last_content_hash = ? AND last_content = ?
           ORDER BY seq ASC
        `).all(input.namespace, group.contentHash, group.content) as StaticIdentityRow[]
        const historical = this.db.query(`
          SELECT DISTINCT identity_id
            FROM study_static_versions
           WHERE namespace = ? AND content_hash = ? AND content = ?
           ORDER BY identity_id ASC
        `).all(input.namespace, group.contentHash, group.content) as Array<{ identity_id: string }>
        let existing: StaticIdentityRow | null = null
        let lineage: StaticIdentityLineage | undefined
        if (currentMatches.length === 1 && !claimedIdentityIds.has(currentMatches[0]!.identity_id)) {
          existing = currentMatches[0]!
        } else if (currentMatches.length > 1) {
          lineage = {
            relation: "ambiguous",
            ancestors: currentMatches.map((row) => ({ scheme: "static", id: row.identity_id })),
          }
        } else if (historical.length === 1 && !claimedIdentityIds.has(historical[0]!.identity_id)) {
          existing = getIdentity(historical[0]!.identity_id)
        } else if (historical.length > 1 || (historical.length === 1 && claimedIdentityIds.has(historical[0]!.identity_id))) {
          lineage = {
            relation: "ambiguous",
            ancestors: historical.map((row) => ({ scheme: "static", id: row.identity_id })),
          }
        }
        if (!existing && !lineage) {
          const candidates = [...anchorCandidates[groupIndex]!]
          if (candidates.length === 1 && candidateGroupCounts.get(candidates[0]!) === 1) {
            if (claimedIdentityIds.has(candidates[0]!)) {
              lineage = {
                relation: "ambiguous",
                ancestors: [{ scheme: "static", id: candidates[0]! }],
              }
            } else {
              existing = getIdentity(candidates[0]!)
            }
          } else if (candidates.length === 1) {
            lineage = {
              relation: "split",
              ancestors: [{ scheme: "static", id: candidates[0]! }],
            }
          } else if (candidates.length > 1) {
            lineage = {
              relation: candidates.every((identityId) => candidateGroupCounts.get(identityId) === 1)
                ? "merge"
                : "ambiguous",
              ancestors: candidates
                .sort()
                .map((identityId) => ({ scheme: "static", id: identityId })),
            }
          }
        }
        if (existing) claimedIdentityIds.add(existing.identity_id)
        if (existing && !lineage) lineage = parseStaticLineage(existing.last_source_ref_json)
        const projectCopy = existing
          ? parseStaticProjectCopyProvenance(existing.last_source_ref_json)
          : (lineage ? this.inheritStaticProjectCopyProvenance(input.namespace, lineage) : undefined)
            ?? (projectCopyReceipt ? this.buildStaticProjectCopyProvenance(projectCopyReceipt, group) : undefined)
        if (lineage) {
          lineage = {
            relation: lineage.relation,
            ancestors: [...lineage.ancestors].sort((left, right) => (
              identityKey(left).localeCompare(identityKey(right))
            )),
          }
        }
        const deterministicLocations = [...group.locations].sort((left, right) => (
          canonicalJson(left).localeCompare(canonicalJson(right))
        ))
        const identityId = existing?.identity_id
          ?? `static-${sha256(canonicalJson(lineage
            ? {
                namespace: input.namespace,
                snapshotHash: input.snapshotHash,
                contentHash: group.contentHash,
                locations: deterministicLocations,
                lineage,
              }
            : { namespace: input.namespace, contentHash: group.contentHash })).slice(0, 32)}`
        const contentChanged = existing !== null && (
          existing.last_content_hash !== group.contentHash || existing.last_content !== group.content
        )
        const version = existing ? existing.current_version + (contentChanged ? 1 : 0) : 1
        const resolvedQualityFlags = [...new Set([
          ...group.qualityFlags,
          ...(existing
            ? parseStringArray(existing.last_quality_flags_json)
                .filter((flag) => flag.startsWith("static_identity_"))
            : []),
          ...(lineage ? [`static_identity_${lineage.relation}`] : []),
        ])]
        const sourceRef: StaticResolvedSourceRef = {
          kind: "static_measurement",
          namespace: input.namespace,
          snapshotHash: input.snapshotHash,
          locations: group.locations,
          ...(lineage ? { lineage } : {}),
          ...(projectCopy ? { projectCopy } : {}),
        }
        if (existing) {
          this.db.query(`
            UPDATE study_static_identities
               SET current_version = ?, last_content = ?, last_content_hash = ?,
                   present = 1, status = 'active', last_source_ref_json = ?,
                   last_quality_flags_json = ?, last_observed_at = ?
             WHERE namespace = ? AND identity_id = ?
          `).run(
            version,
            group.content,
            group.contentHash,
            JSON.stringify(sourceRef),
            JSON.stringify(resolvedQualityFlags),
            input.observedAt,
            input.namespace,
            identityId,
          )
          if (contentChanged) {
            this.db.query(`
              INSERT INTO study_static_versions (
                namespace, identity_id, version, content, content_hash,
                source_ref_json, quality_flags_json, observed_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              input.namespace,
              identityId,
              version,
              group.content,
              group.contentHash,
              JSON.stringify(sourceRef),
              JSON.stringify(resolvedQualityFlags),
              input.observedAt,
            )
          }
        } else {
          this.db.query(`
            INSERT INTO study_static_identities (
              namespace, identity_id, current_version, last_content,
              last_content_hash, present, status, last_source_ref_json,
              last_quality_flags_json, last_observed_at
            ) VALUES (?, ?, ?, ?, ?, 1, 'active', ?, ?, ?)
          `).run(
            input.namespace,
            identityId,
            version,
            group.content,
            group.contentHash,
            JSON.stringify(sourceRef),
            JSON.stringify(resolvedQualityFlags),
            input.observedAt,
          )
          this.db.query(`
            INSERT INTO study_static_versions (
              namespace, identity_id, version, content, content_hash,
              source_ref_json, quality_flags_json, observed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            input.namespace,
            identityId,
            version,
            group.content,
            group.contentHash,
            JSON.stringify(sourceRef),
            JSON.stringify(resolvedQualityFlags),
            input.observedAt,
          )
        }
        return {
          identity: { scheme: "static", id: identityId },
          version,
          content: group.content,
          contentHash: group.contentHash,
          stateHash: stateHash(group.content, "project"),
          scope: "project" as const,
          sourceRef,
          qualityFlags: resolvedQualityFlags,
        }
      })

      this.db.query(`DELETE FROM study_static_current_anchors WHERE namespace = ?`).run(input.namespace)
      const insertAnchor = this.db.query(`
        INSERT INTO study_static_current_anchors (
          namespace, identity_id, rel_path, heading, segment_ordinal, source_ref_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      for (const atom of resolved) {
        for (const location of atom.sourceRef.locations) {
          insertAnchor.run(
            input.namespace,
            atom.identity.id,
            location.relPath,
            location.heading,
            location.segmentOrdinal,
            JSON.stringify(location),
          )
        }
      }
      this.db.query(`
        UPDATE study_static_identities
           SET present = 0, status = 'deleted', last_observed_at = ?
         WHERE namespace = ?
           AND identity_id NOT IN (
             SELECT identity_id FROM study_static_current_anchors WHERE namespace = ?
           )
      `).run(input.observedAt, input.namespace, input.namespace)
      return {
        namespace: input.namespace,
        snapshotHash: input.snapshotHash,
        observedAt: input.observedAt,
        atoms: resolved,
      }
    })
    return transaction()
  }

  private findStaticProjectCopyReceipt(
    namespace: string,
    focusTaskId: string,
  ): ReadyStaticProjectCopyReceipt | null {
    const rows = this.db.query(`
      SELECT from_task_id, to_task_id, condition, source_snapshot_id,
             source_frozen_at, status, started_at, prepared_at,
             source_representation_hash, target_representation_hash,
             manifest_json, result_hash
        FROM study_baseline_project_copy_transitions
       WHERE condition = 'static' AND status = 'ready'
       ORDER BY started_at ASC, from_task_id ASC, to_task_id ASC
    `).all() as BaselineProjectCopyTransitionRow[]
    if (rows.length === 0) return null
    const focusTask = getStudyTask(focusTaskId)
    if (!focusTask) throw new Error(`Unknown study task for Static focus: ${focusTaskId}`)
    const matches = rows
      .map((row) => parseReadyStaticProjectCopyReceipt(this.hydrateBaselineProjectCopyTransition(row)))
      .filter((receipt) => (
        receipt.target.projectId === namespace
        && receipt.target.projectSlug === focusTask.projectSlug
      ))
    if (matches.length > 1) {
      throw new Error(`Multiple ready Static Project Copy receipts target ${namespace}`)
    }
    return matches[0] ?? null
  }

  private hydrateBaselineProjectCopyTransition(
    row: BaselineProjectCopyTransitionRow,
  ): BaselineProjectCopyTransition {
    return {
      fromTaskId: row.from_task_id,
      toTaskId: row.to_task_id,
      condition: row.condition,
      sourceSnapshotId: row.source_snapshot_id,
      sourceFrozenAt: row.source_frozen_at,
      status: row.status,
      startedAt: row.started_at,
      preparedAt: row.prepared_at,
      sourceRepresentationHash: row.source_representation_hash,
      targetRepresentationHash: row.target_representation_hash,
      manifest: row.manifest_json ? JSON.parse(row.manifest_json) as Record<string, unknown> : null,
      resultHash: row.result_hash,
    }
  }

  private buildStaticProjectCopyProvenance(
    receipt: ReadyStaticProjectCopyReceipt,
    group: {
      content: string
      contentHash: string
      locations: StaticAtomSourceRef[]
    },
  ): StaticProjectCopyProvenance | undefined {
    const copiedFiles = new Map(receipt.files.map((file) => [file.relPath, file]))
    const filesByPath = new Map<string, StaticProjectCopyProvenance["files"][number]>()
    for (const location of group.locations) {
      const copied = copiedFiles.get(location.relPath)
      const focusedFileContentHash = location.fileContentHash
      if (!copied || typeof focusedFileContentHash !== "string") continue
      const normalizedFocusedHash = requireSha256(
        focusedFileContentHash,
        `Static focused file content hash for ${location.relPath}`,
      )
      const existing = filesByPath.get(location.relPath)
      if (existing) {
        if (!existing.focusedFileContentHashes.includes(normalizedFocusedHash)) {
          existing.focusedFileContentHashes.push(normalizedFocusedHash)
          existing.focusedFileContentHashes.sort()
        }
      } else {
        filesByPath.set(location.relPath, {
          relPath: location.relPath,
          copiedFileHash: copied.sha256,
          focusedFileContentHashes: [normalizedFocusedHash],
        })
      }
    }
    const files = [...filesByPath.values()].sort((left, right) => left.relPath.localeCompare(right.relPath))
    if (files.length === 0) return undefined
    const cloneOf = this.findExactFocusedStaticCopySource(receipt, group, files)
    return {
      schemaVersion: 1,
      kind: "static_project_copy",
      transitionKey: receipt.transitionKey,
      receiptHash: receipt.receiptHash,
      source: { ...receipt.source },
      target: { ...receipt.target },
      files,
      targetContentHashesAtFirstFocus: [group.contentHash],
      ...(cloneOf ? { cloneOf } : {}),
    }
  }

  private inheritStaticProjectCopyProvenance(
    namespace: string,
    lineage: StaticIdentityLineage,
  ): StaticProjectCopyProvenance | undefined {
    const provenances = lineage.ancestors.flatMap((ancestor) => {
      const row = this.db.query(`
        SELECT last_source_ref_json
          FROM study_static_identities
         WHERE namespace = ? AND identity_id = ?
      `).get(namespace, ancestor.id) as Pick<StaticIdentityRow, "last_source_ref_json"> | null
      if (!row) throw new Error(`Static lineage ancestor is missing: ${ancestor.id}`)
      const provenance = parseStaticProjectCopyProvenance(row.last_source_ref_json)
      return provenance ? [provenance] : []
    })
    if (provenances.length === 0) return undefined
    const first = provenances[0]!
    const receiptKey = canonicalJson({
      schemaVersion: first.schemaVersion,
      kind: first.kind,
      transitionKey: first.transitionKey,
      receiptHash: first.receiptHash,
      source: first.source,
      target: first.target,
    })
    if (provenances.some((provenance) => canonicalJson({
      schemaVersion: provenance.schemaVersion,
      kind: provenance.kind,
      transitionKey: provenance.transitionKey,
      receiptHash: provenance.receiptHash,
      source: provenance.source,
      target: provenance.target,
    }) !== receiptKey)) {
      throw new Error("Static lineage ancestors have conflicting Project Copy receipts")
    }
    const filesByPath = new Map<string, StaticProjectCopyProvenance["files"][number]>()
    for (const provenance of provenances) {
      for (const file of provenance.files) {
        const existing = filesByPath.get(file.relPath)
        if (existing) {
          if (existing.copiedFileHash !== file.copiedFileHash) {
            throw new Error(`Static lineage ancestors have conflicting copied hashes for ${file.relPath}`)
          }
          existing.focusedFileContentHashes = [...new Set([
            ...existing.focusedFileContentHashes,
            ...file.focusedFileContentHashes,
          ])].sort()
        } else {
          filesByPath.set(file.relPath, {
            relPath: file.relPath,
            copiedFileHash: file.copiedFileHash,
            focusedFileContentHashes: [...file.focusedFileContentHashes],
          })
        }
      }
    }
    const cloneKeys = provenances.map((provenance) => (
      provenance.cloneOf ? canonicalJson(provenance.cloneOf) : null
    ))
    const cloneOf = provenances.length === lineage.ancestors.length
      && cloneKeys[0] !== null
      && cloneKeys.every((key) => key === cloneKeys[0])
      ? { ...first.cloneOf! }
      : undefined
    return {
      schemaVersion: 1,
      kind: "static_project_copy",
      transitionKey: first.transitionKey,
      receiptHash: first.receiptHash,
      source: { ...first.source },
      target: { ...first.target },
      files: [...filesByPath.values()].sort((left, right) => left.relPath.localeCompare(right.relPath)),
      targetContentHashesAtFirstFocus: [...new Set(
        provenances.flatMap((provenance) => provenance.targetContentHashesAtFirstFocus),
      )].sort(),
      ...(cloneOf ? { cloneOf } : {}),
    }
  }

  private findExactFocusedStaticCopySource(
    receipt: ReadyStaticProjectCopyReceipt,
    group: { content: string; contentHash: string },
    files: StaticProjectCopyProvenance["files"],
  ): NonNullable<StaticProjectCopyProvenance["cloneOf"]> | undefined {
    const snapshot = this.getFreezeSnapshot(receipt.source.snapshotId)
    if (
      !snapshot
      || snapshot.taskId !== receipt.source.taskId
      || snapshot.frozenAt !== receipt.source.frozenAt
    ) {
      throw new Error(`Static Project Copy source freeze is unavailable: ${receipt.source.snapshotId}`)
    }
    const targetPaths = new Set(files.map((file) => file.relPath))
    const copiedHashesByPath = new Map(receipt.files.map((file) => [file.relPath, file.sha256]))
    const candidates = this.db.query(`
      SELECT identity_id, current_version, last_content, last_content_hash,
             present, status, last_source_ref_json, last_quality_flags_json,
             last_observed_at
        FROM study_static_identities
       WHERE namespace = ?
         AND present = 1
         AND status = 'active'
         AND last_content_hash = ?
         AND last_content = ?
         AND last_observed_at <= ?
       ORDER BY seq ASC
    `).all(
      receipt.source.projectId,
      group.contentHash,
      group.content,
      receipt.source.frozenAt,
    ) as Array<StaticIdentityRow & { last_observed_at: string }>
    const exactFocused = candidates.filter((candidate) => {
      const sourceRef = parseSourceRef(candidate.last_source_ref_json)
      if (sourceRef.namespace !== receipt.source.projectId) return false
      if (!Array.isArray(sourceRef.locations)) return false
      let overlapsTarget = false
      const everyFinalLocationMatches = sourceRef.locations.length > 0 && sourceRef.locations.every((value) => {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return false
        const location = value as Record<string, unknown>
        if (typeof location.relPath !== "string" || typeof location.fileContentHash !== "string") return false
        if (targetPaths.has(location.relPath)) overlapsTarget = true
        return copiedHashesByPath.get(location.relPath) === location.fileContentHash
      })
      if (!everyFinalLocationMatches || !overlapsTarget) return false
      const focusedRows = this.db.query(`
        SELECT d.task_id, d.focused_at, i.source_ref_json
          FROM study_focus_delivery_items i
          JOIN study_focus_deliveries d ON d.injection_id = i.injection_id
         WHERE i.identity_scheme = 'static'
           AND i.identity_id = ?
           AND i.version = ?
           AND i.content_hash = ?
           AND i.content = ?
           AND i.actual_focus = 1
           AND d.condition = 'static'
           AND d.outcome = 'delivered'
           AND d.focused_at <= ?
      `).all(
        candidate.identity_id,
        candidate.current_version,
        candidate.last_content_hash,
        candidate.last_content,
        receipt.source.frozenAt,
      ) as Array<{ task_id: string; focused_at: string; source_ref_json: string }>
      return focusedRows.some((row) => (
        getStudyTask(row.task_id)?.projectSlug === receipt.source.projectSlug
        && parseSourceRef(row.source_ref_json).namespace === receipt.source.projectId
      ))
    })
    if (exactFocused.length !== 1) return undefined
    const source = exactFocused[0]!
    return {
      identity: { scheme: "static", id: source.identity_id },
      version: source.current_version,
      contentHash: source.last_content_hash,
    }
  }

  getStaticObjectStates(
    namespace: string,
    identities?: readonly StudyMemoryIdentity[],
  ): FreezeObjectStateInput[] {
    const requestedIds = identities
      ? new Set(identities.filter((identity) => identity.scheme === "static").map((identity) => identity.id))
      : null
    if (requestedIds?.size === 0) return []
    const rows = this.db.query(`
      SELECT identity_id, current_version, last_content, last_content_hash,
             present, status, last_source_ref_json, last_quality_flags_json
        FROM study_static_identities
       WHERE namespace = ?
       ORDER BY seq ASC
    `).all(namespace) as StaticIdentityRow[]
    return rows
      .filter((row) => requestedIds === null || requestedIds.has(row.identity_id))
      .map((row) => ({
        identity: { scheme: "static", id: row.identity_id },
        present: row.present === 1,
        status: row.status,
        version: row.current_version,
        content: row.last_content,
        contentHash: row.last_content_hash,
        stateHash: stateHash(row.last_content, "project"),
        scope: "project",
        sourceRef: parseSourceRef(row.last_source_ref_json),
        qualityFlags: parseStringArray(row.last_quality_flags_json),
      }))
  }

  createFreezeSnapshot(input: CreateFreezeSnapshotInput): StudyFreezeSnapshot {
    const existing = this.getTaskFreezeSnapshot(input.taskId)
    if (existing) return existing
    if (this.hasPendingStaticFocusDeliveries(input.taskId)) {
      throw new Error(`Cannot freeze task ${input.taskId} while a pending Static focus delivery remains`)
    }
    const transaction = this.db.transaction(() => {
      const occurrences = this.listFocusedOccurrences(input.taskId)
      const objectStates = new Map<string, FreezeObjectStateInput>()
      for (const state of input.objectStates ?? []) {
        const key = identityKey(state.identity)
        if (objectStates.has(key)) throw new Error(`Duplicate object state for ${state.identity.scheme}:${state.identity.id}`)
        objectStates.set(key, state)
      }
      const byIdentity = new Map<string, { identity: StudyMemoryIdentity; history: StudyFocusOccurrence[] }>()
      for (const occurrence of occurrences) {
        const key = identityKey(occurrence.identity)
        const existing = byIdentity.get(key)
        if (existing) existing.history.push(occurrence)
        else byIdentity.set(key, { identity: occurrence.identity, history: [occurrence] })
      }

      const items: StudyFreezeItem[] = [...byIdentity.values()].map(({ identity, history }) => {
        const last = history[history.length - 1]!
        const objectOverride = objectStates.get(identityKey(identity))
        const itemQualityFlags = [...new Set([
          ...history.flatMap((occurrence) => occurrence.qualityFlags),
          ...(objectOverride?.qualityFlags ?? []),
          ...(objectOverride?.finalLineage?.flatMap((target) => target.qualityFlags) ?? []),
        ])]
        const object = objectOverride
          ? this.normalizeObjectState(objectOverride)
          : {
              present: true,
              status: "active",
              version: last.version,
              content: last.content,
              contentHash: last.contentHash,
              stateHash: last.stateHash,
              scope: last.scope,
              sourceRef: last.sourceRef,
            }
        return {
          probeId: `probe-${sha256(`${input.snapshotId}\0${identity.scheme}\0${identity.id}`)}`,
          identity,
          cue: {
            version: last.version,
            content: last.content,
            contentHash: last.contentHash,
            stateHash: last.stateHash,
            scope: last.scope,
            sourceRef: last.sourceRef,
          },
          object,
          history,
          qualityFlags: itemQualityFlags,
          ...(objectOverride?.finalLineage?.length
            ? { finalLineage: objectOverride.finalLineage }
            : {}),
        }
      })
      const snapshot: StudyFreezeSnapshot = {
        schemaVersion: 2,
        questionnaireVersion: STUDY_QUESTIONNAIRE_VERSION,
        snapshotId: input.snapshotId,
        taskId: input.taskId,
        frozenAt: input.frozenAt,
        qualityFlags: [...new Set([
          ...(input.qualityFlags ?? []),
          ...items.flatMap((item) => item.qualityFlags),
        ])],
        items,
        ...(input.workspaceSnapshot ? { workspaceSnapshot: input.workspaceSnapshot } : {}),
      }
      this.db.query(`
        INSERT INTO study_freeze_snapshots (snapshot_id, task_id, frozen_at, payload_json)
        VALUES (?, ?, ?, ?)
      `).run(input.snapshotId, input.taskId, input.frozenAt, JSON.stringify(snapshot))
      return snapshot
    })
    return transaction()
  }

  getFreezeSnapshot(snapshotId: string): StudyFreezeSnapshot | null {
    const row = this.db.query(`
      SELECT payload_json
        FROM study_freeze_snapshots
       WHERE snapshot_id = ?
    `).get(snapshotId) as FreezeSnapshotRow | null
    return row ? JSON.parse(row.payload_json) as StudyFreezeSnapshot : null
  }

  getTaskFreezeSnapshot(taskId: string): StudyFreezeSnapshot | null {
    const row = this.db.query(`
      SELECT payload_json
        FROM study_freeze_snapshots
       WHERE task_id = ?
    `).get(taskId) as FreezeSnapshotRow | null
    return row ? JSON.parse(row.payload_json) as StudyFreezeSnapshot : null
  }

  /** Remove an unanswered freeze checkpoint for the experimenter-only reopen flow. */
  removeTaskFreezeSnapshot(taskId: string): boolean {
    const snapshot = this.getTaskFreezeSnapshot(taskId)
    if (!snapshot) return false
    if (this.getQuestionnaireSubmission(snapshot.snapshotId)) {
      throw new Error(`Cannot remove submitted freeze snapshot for task ${taskId}`)
    }
    const result = this.db.query(`
      DELETE FROM study_freeze_snapshots
       WHERE task_id = ?
    `).run(taskId)
    return result.changes > 0
  }

  recordQuestionnaireSubmission(input: QuestionnaireSubmissionInput): QuestionnaireSubmissionResult {
    const answersJson = canonicalJson(input.answers)
    const attentionCheck = input.attentionCheck ?? null
    const payloadHash = attentionCheck
      ? sha256(canonicalJson({ answers: input.answers, attentionCheck }))
      : sha256(answersJson)
    const transaction = this.db.transaction(() => {
      const snapshot = this.getFreezeSnapshot(input.snapshotId)
      if (!snapshot) throw new Error(`Unknown freeze snapshot ${input.snapshotId}`)
      if (freezeQuestionnaireVersion(snapshot) !== input.questionnaireVersion) {
        throw new Error(
          `Questionnaire version ${input.questionnaireVersion} does not match `
          + `snapshot ${input.snapshotId} (questionnaire version ${freezeQuestionnaireVersion(snapshot)})`,
        )
      }
      const existing = this.getQuestionnaireSubmission(input.snapshotId)
      if (existing) {
        if (existing.payloadHash !== payloadHash) {
          throw new Error(`Questionnaire submission already exists for snapshot ${input.snapshotId}`)
        }
        return { created: false, submission: existing }
      }
      this.db.query(`
        INSERT INTO study_questionnaire_submissions (
          submission_id, snapshot_id, submitted_at, questionnaire_version, answers_json,
          attention_check_id, attention_check_answer, attention_check_passed, payload_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.submissionId,
        input.snapshotId,
        input.submittedAt,
        input.questionnaireVersion,
        answersJson,
        attentionCheck?.checkId ?? null,
        attentionCheck?.selectedValue ?? null,
        attentionCheck ? Number(attentionCheck.passed) : null,
        payloadHash,
      )
      return {
        created: true,
        submission: {
          submissionId: input.submissionId,
          snapshotId: input.snapshotId,
          submittedAt: input.submittedAt,
          questionnaireVersion: input.questionnaireVersion,
          answers: JSON.parse(answersJson) as unknown[],
          attentionCheck,
          payloadHash,
        },
      }
    })
    return transaction()
  }

  getQuestionnaireSubmission(snapshotId: string): StudyQuestionnaireSubmission | null {
    const row = this.db.query(`
      SELECT submission_id, snapshot_id, submitted_at, questionnaire_version, answers_json,
             attention_check_id, attention_check_answer, attention_check_passed, payload_hash
        FROM study_questionnaire_submissions
       WHERE snapshot_id = ?
    `).get(snapshotId) as QuestionnaireSubmissionRow | null
    if (!row) return null
    if (row.questionnaire_version !== 1 && row.questionnaire_version !== 2) {
      throw new Error(`Invalid questionnaire version ${row.questionnaire_version} for snapshot ${snapshotId}`)
    }
    const hasNoAttentionCheck = row.attention_check_id === null
      && row.attention_check_answer === null
      && row.attention_check_passed === null
    const hasCompleteAttentionCheck = typeof row.attention_check_id === "string"
      && typeof row.attention_check_answer === "string"
      && (row.attention_check_passed === 0 || row.attention_check_passed === 1)
    if (!hasNoAttentionCheck && !hasCompleteAttentionCheck) {
      throw new Error(`Malformed attention-check response for snapshot ${snapshotId}`)
    }
    return {
      submissionId: row.submission_id,
      snapshotId: row.snapshot_id,
      submittedAt: row.submitted_at,
      questionnaireVersion: row.questionnaire_version,
      answers: JSON.parse(row.answers_json) as unknown[],
      attentionCheck: hasCompleteAttentionCheck ? {
        checkId: row.attention_check_id!,
        selectedValue: row.attention_check_answer!,
        passed: row.attention_check_passed === 1,
      } : null,
      payloadHash: row.payload_hash,
    }
  }

  recordRawTlxSubmission(input: RawTlxSubmissionInput): RawTlxSubmissionResult {
    const responseJson = canonicalJson(input.response)
    const payloadHash = sha256(responseJson)
    const transaction = this.db.transaction((): RawTlxSubmissionResult => {
      const snapshot = this.getFreezeSnapshot(input.snapshotId)
      if (!snapshot) throw new Error(`Unknown freeze snapshot ${input.snapshotId}`)
      if (!this.getQuestionnaireSubmission(input.snapshotId)) {
        throw new Error(`Memory questionnaire is not submitted for snapshot ${input.snapshotId}`)
      }
      if (input.response.activity === "control" && !this.getRawTlxSubmission(input.snapshotId, "monitoring")) {
        throw new Error(`Monitoring Raw TLX is not submitted for snapshot ${input.snapshotId}`)
      }

      const existing = this.getRawTlxSubmission(input.snapshotId, input.response.activity)
      let submission: StudyRawTlxSubmission
      let created = false
      if (existing) {
        if (existing.payloadHash !== payloadHash) {
          throw new Error(`${input.response.activity} Raw TLX already exists for snapshot ${input.snapshotId}`)
        }
        submission = existing
      } else {
        this.db.query(`
          INSERT INTO study_raw_tlx_submissions (
            submission_id, snapshot_id, activity, submitted_at, response_json, payload_hash
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          input.submissionId,
          input.snapshotId,
          input.response.activity,
          input.submittedAt,
          responseJson,
          payloadHash,
        )
        submission = {
          submissionId: input.submissionId,
          snapshotId: input.snapshotId,
          submittedAt: input.submittedAt,
          response: JSON.parse(responseJson) as StudyRawTlxActivityResponse,
          payloadHash,
        }
        created = true
      }

      let completion = this.getSessionCompletion(snapshot.taskId)
      if (input.response.activity === "control" && !completion) {
        if (!input.completionId) throw new Error("completionId is required for Control Raw TLX")
        this.db.query(`
          INSERT INTO study_session_completions (
            completion_id, task_id, snapshot_id, completed_at
          ) VALUES (?, ?, ?, ?)
        `).run(input.completionId, snapshot.taskId, input.snapshotId, submission.submittedAt)
        completion = {
          completionId: input.completionId,
          taskId: snapshot.taskId,
          snapshotId: input.snapshotId,
          completedAt: submission.submittedAt,
        }
      }
      if (completion && completion.snapshotId !== input.snapshotId) {
        throw new Error(`Session completion already exists for task ${snapshot.taskId}`)
      }
      return { created, submission, completion }
    })
    return transaction()
  }

  getRawTlxSubmission(
    snapshotId: string,
    activity: RawTlxActivity,
  ): StudyRawTlxSubmission | null {
    const row = this.db.query(`
      SELECT submission_id, snapshot_id, activity, submitted_at, response_json, payload_hash
        FROM study_raw_tlx_submissions
       WHERE snapshot_id = ? AND activity = ?
    `).get(snapshotId, activity) as RawTlxSubmissionRow | null
    if (!row) return null
    return {
      submissionId: row.submission_id,
      snapshotId: row.snapshot_id,
      submittedAt: row.submitted_at,
      response: JSON.parse(row.response_json) as StudyRawTlxActivityResponse,
      payloadHash: row.payload_hash,
    }
  }

  getSessionCompletion(taskId: string): StudySessionCompletion | null {
    const row = this.db.query(`
      SELECT completion_id, task_id, snapshot_id, completed_at
        FROM study_session_completions
       WHERE task_id = ?
    `).get(taskId) as SessionCompletionRow | null
    return row ? {
      completionId: row.completion_id,
      taskId: row.task_id,
      snapshotId: row.snapshot_id,
      completedAt: row.completed_at,
    } : null
  }

  recordSusSubmission(input: SusSubmissionInput): SusSubmissionResult {
    if (!input.participantId.trim()) throw new Error("SUS submission requires the allocation participant identity")
    const responseJson = canonicalJson(input.response)
    const payloadHash = sha256(responseJson)
    const transaction = this.db.transaction((): SusSubmissionResult => {
      const existing = this.getSusSubmission()
      if (existing) {
        if (existing.payloadHash !== payloadHash) throw new Error("SUS submission already exists")
        // An exact retry returns the original immutable receipt. A legacy
        // pre-receipt SUS row gets its missing receipt from the original SUS
        // acceptance evidence, never from the later retry time.
        const receipt = this.getOrCreateCompletionReceipt(input.participantId, existing)
        return { created: false, submission: existing, receipt }
      }
      this.db.query(`
        INSERT INTO study_sus_submissions (
          singleton, submission_id, submitted_at, response_json, payload_hash
        ) VALUES (1, ?, ?, ?, ?)
      `).run(input.submissionId, input.submittedAt, responseJson, payloadHash)
      // The durable code receipt is part of the same first acceptance.
      const receipt = this.insertCompletionReceipt({
        participantId: input.participantId,
        susSubmissionId: input.submissionId,
        issuedAt: input.submittedAt,
      })
      return {
        created: true,
        submission: {
          submissionId: input.submissionId,
          submittedAt: input.submittedAt,
          response: JSON.parse(responseJson) as StudySusResponse,
          payloadHash,
        },
        receipt,
      }
    })
    return transaction()
  }

  private insertCompletionReceipt(input: {
    participantId: string
    susSubmissionId: string
    issuedAt: string
  }): StudyCompletionReceipt {
    const receipt: StudyCompletionReceipt = {
      participantId: input.participantId,
      susSubmissionId: input.susSubmissionId,
      code: STUDY_COMPLETION_CODE,
      codeVersion: STUDY_COMPLETION_CODE_VERSION,
      issuedAt: input.issuedAt,
    }
    this.db.query(`
      INSERT INTO study_completion_receipts (
        singleton, participant_id, sus_submission_id, code, code_version, issued_at
      ) VALUES (1, ?, ?, ?, ?, ?)
    `).run(receipt.participantId, receipt.susSubmissionId, receipt.code, receipt.codeVersion, receipt.issuedAt)
    return receipt
  }

  getCompletionReceipt(): StudyCompletionReceipt | null {
    const row = this.db.query(`
      SELECT participant_id, sus_submission_id, code, code_version, issued_at
        FROM study_completion_receipts
       WHERE singleton = 1
    `).get() as CompletionReceiptRow | null
    return row ? {
      participantId: row.participant_id,
      susSubmissionId: row.sus_submission_id,
      code: row.code,
      codeVersion: row.code_version,
      issuedAt: row.issued_at,
    } : null
  }

  /**
   * Recover the server-owned completion receipt for a legacy SUS row that
   * predates receipt persistence. The SUS submission is the durable issuance
   * evidence, so its original timestamp and identity determine the receipt.
   */
  ensureCompletionReceipt(participantId: string): StudyCompletionReceipt | null {
    if (!participantId.trim()) throw new Error("Completion receipt requires the allocation participant identity")
    const transaction = this.db.transaction(() => {
      const sus = this.getSusSubmission()
      return sus ? this.getOrCreateCompletionReceipt(participantId, sus) : null
    })
    return transaction()
  }

  private getOrCreateCompletionReceipt(
    participantId: string,
    sus: StudySusSubmission,
  ): StudyCompletionReceipt {
    const existing = this.getCompletionReceipt()
    if (existing) {
      if (existing.participantId !== participantId) {
        throw new Error("Completion receipt belongs to a different allocation identity")
      }
      if (existing.susSubmissionId !== sus.submissionId) {
        throw new Error("Completion receipt references a different SUS submission")
      }
      return existing
    }
    return this.insertCompletionReceipt({
      participantId,
      susSubmissionId: sus.submissionId,
      issuedAt: sus.submittedAt,
    })
  }

  getSusSubmission(): StudySusSubmission | null {
    const row = this.db.query(`
      SELECT submission_id, submitted_at, response_json, payload_hash
        FROM study_sus_submissions
       WHERE singleton = 1
    `).get() as SusSubmissionRow | null
    return row ? {
      submissionId: row.submission_id,
      submittedAt: row.submitted_at,
      response: JSON.parse(row.response_json) as StudySusResponse,
      payloadHash: row.payload_hash,
    } : null
  }

  private getStaticFocusLedger(injectionId: string): StaticFocusLedgerRow | null {
    return this.db.query(`
      SELECT dispatch_seq, injection_id, task_id, namespace, chat_id, turn_id,
             turn_number, focused_at, delivery_hash, payload_hash, payload_json,
             status, materialization_hash
        FROM study_static_focus_ledger
       WHERE injection_id = ?
    `).get(injectionId) as StaticFocusLedgerRow | null
  }

  private hydratePendingStaticFocus(row: StaticFocusLedgerRow): PendingStaticFocusDelivery {
    const payload = JSON.parse(row.payload_json) as StaticFocusPayload
    return {
      dispatchSequence: row.dispatch_seq,
      injectionId: row.injection_id,
      taskId: row.task_id,
      namespace: row.namespace,
      chatId: row.chat_id,
      turnId: row.turn_id,
      turn: row.turn_number,
      focusedAt: row.focused_at,
      deliveryHash: row.delivery_hash,
      payloadHash: row.payload_hash,
      payload,
    }
  }

  private staticResolutionFromDelivery(
    ledger: StaticFocusLedgerRow,
    delivery: FocusDelivery,
  ): StaticResolutionResult {
    return {
      namespace: ledger.namespace,
      snapshotHash: ledger.payload_hash,
      observedAt: ledger.focused_at,
      atoms: delivery.items.map((item) => ({
        identity: item.identity,
        version: item.version,
        content: item.content,
        contentHash: item.contentHash,
        stateHash: item.stateHash,
        scope: "project",
        sourceRef: item.sourceRef as StaticResolvedSourceRef,
        qualityFlags: [...item.qualityFlags],
      })),
    }
  }

  private getDelivery(injectionId: string): FocusDelivery | null {
    const row = this.db.query(`
      SELECT injection_id, task_id, chat_id, turn_id, turn_number, focused_at,
             condition, engine, mode, outcome, delivery_stage,
             delivery_hash, visible_pool_hash, resume_of_interrupt_id, quality_flags_json
        FROM study_focus_deliveries
       WHERE injection_id = ?
    `).get(injectionId) as DeliveryRow | null
    return row ? this.hydrateDelivery(row) : null
  }

  private normalizeFocusDelivery(input: FocusDeliveryInput): FocusDelivery {
    const seen = new Set<string>()
    const items = input.items.map((item) => {
      const key = identityKey(item.identity)
      if (seen.has(key)) {
        throw new Error(`Duplicate focus identity in delivery ${input.injectionId}: ${item.identity.scheme}:${item.identity.id}`)
      }
      seen.add(key)
      const computedContentHash = sha256(item.content)
      const computedStateHash = stateHash(item.content, item.scope)
      if (item.contentHash !== undefined && item.contentHash !== computedContentHash) {
        throw new Error(`Incorrect content hash for ${item.identity.scheme}:${item.identity.id}`)
      }
      if (item.stateHash !== undefined && item.stateHash !== computedStateHash) {
        throw new Error(`Incorrect state hash for ${item.identity.scheme}:${item.identity.id}`)
      }
      return {
        identity: { ...item.identity },
        version: item.version,
        content: item.content,
        contentHash: computedContentHash,
        stateHash: computedStateHash,
        scope: item.scope,
        actualFocus: item.actualFocus !== false,
        ...(item.expectedUse ? { expectedUse: item.expectedUse } : {}),
        sourceRef: JSON.parse(canonicalJson(item.sourceRef)) as Record<string, unknown>,
        qualityFlags: [...(item.qualityFlags ?? [])],
      }
    })
    return {
      injectionId: input.injectionId,
      taskId: input.taskId,
      chatId: input.chatId,
      turnId: input.turnId,
      turn: input.turn,
      focusedAt: input.focusedAt,
      condition: input.condition,
      engine: input.engine,
      mode: input.mode,
      outcome: input.outcome,
      deliveryStage: input.deliveryStage,
      deliveryHash: input.deliveryHash,
      visiblePoolHash: input.visiblePoolHash,
      ...(input.resumeOfInterruptId
        ? { resumeOfInterruptId: requireString(input.resumeOfInterruptId, "resume interrupt id") }
        : {}),
      items,
      qualityFlags: [...(input.qualityFlags ?? [])],
    }
  }

  private listFocusedOccurrences(taskId: string): StudyFocusOccurrence[] {
    const rows = this.db.query(`
      SELECT d.injection_id, d.chat_id, d.turn_id, d.turn_number, d.focused_at,
             d.resume_of_interrupt_id,
             i.identity_scheme, i.identity_id, i.version, i.content,
             i.content_hash, i.state_hash, i.scope, i.actual_focus,
             i.expected_use, i.source_ref_json, i.quality_flags_json
        FROM study_focus_deliveries d
        JOIN study_focus_delivery_items i ON i.injection_id = d.injection_id
        LEFT JOIN study_static_focus_ledger s ON s.injection_id = d.injection_id
       WHERE d.task_id = ?
         AND d.outcome = 'delivered'
         AND i.actual_focus = 1
       ORDER BY COALESCE(s.dispatch_seq, d.seq) ASC, d.seq ASC, i.ordinal ASC
    `).all(taskId) as FocusOccurrenceRow[]
    return rows.map((row) => ({
      injectionId: row.injection_id,
      chatId: row.chat_id,
      turnId: row.turn_id,
      turn: row.turn_number,
      focusedAt: row.focused_at,
      ...(row.resume_of_interrupt_id ? { resumeOfInterruptId: row.resume_of_interrupt_id } : {}),
      identity: { scheme: row.identity_scheme, id: row.identity_id },
      version: row.version,
      content: row.content,
      contentHash: row.content_hash,
      stateHash: row.state_hash,
      scope: row.scope,
      actualFocus: true,
      ...(row.expected_use ? { expectedUse: row.expected_use } : {}),
      sourceRef: parseSourceRef(row.source_ref_json),
      qualityFlags: parseStringArray(row.quality_flags_json),
    }))
  }

  private normalizeObjectState(input: FreezeObjectStateInput): FrozenStudyMemoryState {
    const hasFrozenState = input.version !== undefined || input.content !== undefined || input.scope !== undefined
    if (!hasFrozenState) {
      return {
        present: input.present,
        status: input.status,
        version: null,
        content: null,
        contentHash: null,
        stateHash: null,
        scope: null,
        sourceRef: null,
      }
    }
    if (input.version === undefined || input.content === undefined || input.scope === undefined) {
      throw new Error(`Frozen object state requires version, content, and scope together for ${input.identity.scheme}:${input.identity.id}`)
    }
    return {
      present: input.present,
      status: input.status,
      version: input.version,
      content: input.content,
      contentHash: input.contentHash ?? sha256(input.content),
      stateHash: input.stateHash ?? stateHash(input.content, input.scope),
      scope: input.scope,
      sourceRef: input.sourceRef ?? null,
    }
  }

  private hydrateDelivery(row: DeliveryRow): FocusDelivery {
    const itemRows = this.db.query(`
      SELECT identity_scheme, identity_id, version, content, content_hash,
             state_hash, scope, actual_focus, expected_use, source_ref_json,
             quality_flags_json
        FROM study_focus_delivery_items
       WHERE injection_id = ?
       ORDER BY ordinal ASC
    `).all(row.injection_id) as FocusItemRow[]
    return {
      injectionId: row.injection_id,
      taskId: row.task_id,
      chatId: row.chat_id,
      turnId: row.turn_id,
      turn: row.turn_number,
      focusedAt: row.focused_at,
      condition: row.condition,
      engine: row.engine,
      mode: row.mode,
      outcome: row.outcome,
      deliveryStage: row.delivery_stage,
      deliveryHash: row.delivery_hash,
      visiblePoolHash: row.visible_pool_hash,
      ...(row.resume_of_interrupt_id ? { resumeOfInterruptId: row.resume_of_interrupt_id } : {}),
      qualityFlags: parseStringArray(row.quality_flags_json),
      items: itemRows.map((item) => ({
        identity: { scheme: item.identity_scheme, id: item.identity_id },
        version: item.version,
        content: item.content,
        contentHash: item.content_hash,
        stateHash: item.state_hash,
        scope: item.scope,
        actualFocus: item.actual_focus === 1,
        ...(item.expected_use ? { expectedUse: item.expected_use } : {}),
        sourceRef: parseSourceRef(item.source_ref_json),
        qualityFlags: parseStringArray(item.quality_flags_json),
      })),
    }
  }
}
