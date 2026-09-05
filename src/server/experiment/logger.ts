// Structured experiment event log — the SHARED logging schema across all three
// study conditions (Static-config / Auto-extract / MemoSync). Every event is
// tagged with `condition` so a single log stream is comparable across arms.
//
// Sinks: append one JSON object per line to `<dataDir>/experiments/events.jsonl`
// (a mounted volume in Docker → readable from the host for offline analysis) AND
// stdout (so it shows up in `docker logs`). Both gated by env:
//   EXPERIMENT_LOG=0     → disable entirely (default: enabled)
//   EXPERIMENT_CONDITION → 'memosync' (default) | 'static' | 'auto'
//
// These are the metamemory-relevant signals the study measures (Write / Structure
// / Utilization / Maintenance, plus monitoring & control acts). Fine-grained UI
// telemetry (board views, citation hover dwell) is intentionally deferred.
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type {
  StudyAssessedMemoryAnswer,
  StudyAssessedMemoryAnswerV2,
  StudyDesiredMemoryAnswer,
  StudyDesiredMemoryAnswerV2,
  StudyExecutionAnswer,
  StudyExecutionAnswerV2,
  StudyQuestionnaireVersion,
} from "../../shared/studyTasks"
import type { StudyAttentionCheckResult } from "../../shared/studyAttentionChecks"
import type { RawTlxActivity, RawTlxRatings, SusRatings } from "../../shared/studyScales"

export type ExperimentCondition = "memosync" | "static" | "auto"
export type ExperimentAllocationMode = "study" | "internal_qa"

export interface ExperimentDurableSinkInput {
  recordedAt: string
  condition: ExperimentCondition
  participant: string | null
  allocationMode: ExperimentAllocationMode | null
  event: ExperimentEvent
}

export interface ExperimentDurableSinkResult {
  created: boolean
}

export interface ExperimentLogResult {
  durableCreated: boolean | null
}

type MemoryRef = { id: string; scope: string }

export interface DeliveredFocusMemoryRef {
  id: string
  identity: { scheme: string; id: string }
  version: number
  content: string
  contentHash: string
  stateHash: string
  scope: "personal" | "project" | "session"
  actualFocus: true
  expectedUse?: string
  sourceRef: Record<string, unknown>
  qualityFlags?: string[]
}

export interface DeliveredFocusEvent {
  type: "memory.inject"
  schemaVersion: 2
  semantics: "turn_focus"
  injectionId: string
  taskId: string | null
  sessionId: string
  chatId: string
  turnId: string
  turn: number
  engine: "claude"
  focusedAt: string
  outcome: "delivered" | "empty" | "disabled"
  /** Resume linkage (2026-08-19 C4): this delivery re-dispatches the turn the named interrupt stopped. */
  resumeOfInterruptId?: string
  /** sendPrompt accepted the exact prompt into Claude's local SDK queue. */
  deliveryStage: "queued_to_claude"
  mode: "skills" | "plain" | "file"
  deliveryHash: string
  focusPayloadHash?: string
  visiblePoolHash: string
  memories: DeliveredFocusMemoryRef[]
  qualityFlags?: string[]
}

/** Discriminated union of logged events (extend as new signals are wired). */
export type ExperimentEvent =
  | {
      type: "study.control_operation"
      operationId: string
      phase: "attempted" | "completed" | "failed"
      taskId: string
      sessionId: string
      chatId?: string
      /** Original client action time for trusted semantic outbox controls. */
      clientTimestamp?: string
      surface: "board" | "chat_gate" | "static_memory" | "audit" | "working_memory"
      action: string
      controlType: "crud" | "transfer" | "checkup" | "static_edit" | "audit" | "working_memory"
      payload?: Record<string, unknown>
      errorClass?: string
    }
  | { type: "memory.inject"; schemaVersion?: 1; sessionId?: string; engine?: string; memories: MemoryRef[]; tokenEstimate?: number; mode?: "skills" | "plain" | "file"; staticFiles?: string[] }
  | DeliveredFocusEvent
  | { type: "memory.propose"; sessionId?: string; engine?: string; id: string; memType: string; scope: string; via?: string; targetId?: string; drift?: string; revisionAction?: string; reason?: string }
  // carryoverIds ⊆ countedIds: cited via conversation history, NOT injected
  // this turn (a without-memory/edited-selection turn can still cite earlier
  // ids — inherent to session engines; analysis must not read it as injection).
  | { type: "memory.cite"; sessionId?: string; citedIds: string[]; countedIds: string[]; carryoverIds?: string[] }
  | { type: "memory.decision"; taskId?: string; sessionId?: string; action: "create" | "accept" | "edit" | "dismiss" | "rescope" | "archive" | "revert" | "restore" | "unmute" | "promote"; id: string; fromScope?: string; toScope?: string; via?: string }
  // Exactly ONE terminal memory.capture per invocation — success (with
  // counts, zeros included) or failure (with stage + error class). Analysis
  // must be able to tell "no candidates" from "pass failed" from "never ran".
  | { type: "memory.capture"; sessionId?: string; engine?: string; turn?: number; status: "ok" | "failed"; stage?: "capture_pass" | "necessity_pass" | "persist"; errorClass?: string; errorCategory?: "cancelled" | "timeout" | "network" | "rate_limited" | "provider_5xx" | "provider_4xx" | "empty_response" | "truncated" | "invalid_json" | "invalid_response" | "unknown"; httpStatus?: number; channel?: "hook" | "agent" | "prompt"; proposed?: number; surfaced?: number; dropped?: number; sensitive?: number; reinforced?: number; revisions?: number; sameTurnDuplicates?: number }
  | { type: "memory.conflict"; sessionId?: string; engine?: string; turn?: number; newId: string; staleId: string }
  // Step-one proposals gate (redesign 2026-08-07): one terminal event per
  // parked gate — how many candidates it held and how it settled.
  | { type: "memory.proposals"; sessionId?: string; engine?: string; turn?: number; count: number; decision: "reviewed" | "skipped" | "cancelled" | "expired" | "empty" }
  // Step-one library checkup (redesign 2026-08-07): one terminal event per
  // run — suggestion count, result reuse, and how the gate settled ("clear"
  // is reserved for a complete no-finding result; failed lanes stay explicit).
  | { type: "memory.checkup"; sessionId?: string; engine?: string; turn?: number; suggestions: number; cached?: boolean; failedKinds?: Array<"conflict" | "redundancy" | "staleness">; decision: "clear" | "handled" | "skipped" | "cancelled" | "expired" | "failed" }
  // User returns to a settled pre-turn review while the engine is still
  // parked. This is a direct control action; downstream stages are recomputed.
  | { type: "memory.preparation_reopen"; sessionId?: string; engine?: string; turn?: number; from: "proposals" | "checkup" | "transfer"; revision: number }
  // Exactly ONE terminal memory.trace per eligible turn: a committed verdict,
  // a failed model pass, or a verdict discarded by the live-memory CAS.
  | { type: "memory.trace"; sessionId?: string; engine?: string; turn?: number; status?: "ok" | "failed" | "discarded" | "empty"; stage?: "trace_pass" | "cas"; errorClass?: string; dropped?: number; labels: Array<{ id: string; label: string }>; via?: "fork" | "sidecar" }
  | { type: "memory.detail_load"; sessionId?: string; engine?: string; ids: string[] }
  | { type: "memory.bringin"; sessionId?: string; ids: string[] } // legacy (pre-D7 bring-in); kept so old logs still parse
  // Working-set curation (REDESIGN D7): the session's full exclusion list after an update.
  | { type: "memory.exclude"; sessionId?: string; ids: string[] }
  // One observed Add/Remove toggle on the Working Memory confirmation card.
  // Study mode records these through the durable telemetry store instead;
  // outside it this plain log line keeps the control act in the record.
  | { type: "memory.working_memory_selection"; eventId?: string; clientTimestamp?: string; sessionId?: string; chatId: string; previewId: string; memoryId: string; action: "add" | "remove" }
  | { type: "memory.transfer"; taskId?: string; sessionId?: string; sourceId: string; newId?: string; fromScope?: string; targetScope: string; targetProjectId?: string; verdict?: string; edited?: boolean; archivedOriginal?: boolean; surface?: "board" | "chat_gate" }
  | { type: "memory.transfer_decline"; taskId?: string; sessionId?: string; id: string; contextKey: string; surface?: "board" | "chat_gate" }
  | { type: "memory.transfer_card"; sessionId: string; engine?: string; turn?: number; suggestions: number; decision: "handled" | "skipped" | "cancelled" | "expired" | "empty" }
  | { type: "memory.board_backlog"; kind: "transfer" | "checkup"; chatId: string; gateId: string; semanticKey: string; outcome: "invalidated"; reason: string }
  | { type: "memory.sanitize"; sessionId?: string; id: string; redactions: number }
  // A raw Auto summary-panel submission. It is durable coding evidence, not
  // Control: the model has not yet classified the participant's intent.
  | { type: "study.participant_prompt"; eventId: string; sessionId?: string; surface: "auto_summary_chat"; action: "submit"; projectId: string; content: string }
  // Participant explicitly asked the condition's agent-facing control channel
  // to update memory. Count the request once; `applied` is an outcome, not the
  // control-effort unit. Silent/agent-initiated writes never emit this event.
  | { type: "memory.control_request"; eventId?: string; sessionId?: string; via: "auto_summary_chat"; requestedAction: "update_memory"; causalRequestId?: string; applied?: number }
  // One successful, content-changing participant save to Static memory through
  // the memory sidebar or Files panel. Agent file-tool writes bypass both.
  | { type: "memory.static_edit"; eventId?: string; sessionId?: string; projectId: string; path: string; durationMs?: number }
  | { type: "ui.monitor"; eventId?: string; clientTimestamp?: string; taskId?: string; sessionId?: string; chatId?: string; surface: string; interaction?: "open" | "click" | "scroll" | "hover"; ids?: string[] }
  // One client-observed surface visibility transition (opened/hidden/visible/
  // closed). In study mode these route through the durable study telemetry
  // store; outside it they land here directly so longitudinal deployments
  // keep the monitoring-exposure record.
  | { type: "ui.surface_exposure"; eventId?: string; clientTimestamp?: string; sessionId?: string; chatId?: string; surface: string; action: "opened" | "hidden" | "visible" | "closed"; exposureId?: string; sequence?: number; initiator?: "participant" | "system"; memoryIds?: string[]; closeReason?: string }
  | { type: "memory.attention"; taskId?: string; sessionId?: string; kind: "conflict" | "revision" | "redundant" | "stale" | "promotion"; id: string; action: "shown" | "defer" | "renew" | "archive" | "keep" | "merge" | "promote" | "decline"; surface?: "board" | "chat_gate" }
  // Audit-row follow-ups (redesign 2026-08-07, 4.3.4): pay_attention queues
  // the id for the next turn's injected list; draft_fix drafts a revision.
  | { type: "memory.audit_action"; eventId?: string; operationId?: string; taskId?: string; sessionId?: string; chatId?: string; id: string; action: "pay_attention" | "draft_fix" | "enforce" }
  // Per-memory interrupt (2026-08-19 C1/C3): the participant stopped the turn over one memory.
  | { type: "memory.interrupt"; eventId?: string; interruptId?: string; taskId?: string; sessionId?: string; chatId?: string; id: string; turn?: number; quote?: string }
  | { type: "memory.resume"; eventId: string; interruptId: string; taskId: string; sessionId: string; chatId: string; id: string; enforced: boolean }
  | { type: "memory.preview"; operationId?: string; sessionId?: string; engine?: string; turn?: number; memoryIds: string[]; decision?: "go_on" | "dismiss" | "without_memory" | "auto_go_on" | "expired"; selectedIds?: string[] }
  // "Ask agent to revise" on the injection gate (4.3.2 Adjusting): the plain-
  // language instruction and the selection it produced. Logged even when the
  // selection is unchanged — a question about the pool is also an Adjusting-
  // stage act, and the final commit is still the gate's memory.preview.
  | { type: "memory.revise_injection"; operationId?: string; sessionId?: string; instruction: string; beforeIds: string[]; afterIds: string[]; changed: boolean }
  // The sidecar relevance PREDICTION for a turn (REDESIGN D6) — logged apart
  // from injection/citation facts; analysis must never read it as ground truth.
  | { type: "memory.relevance"; sessionId?: string; turn?: number; ids: string[] }
  | { type: "memory.setting"; sessionId?: string; section: string; value: Record<string, unknown> }
  | { type: "turn.usage"; sessionId?: string; engine?: string; model?: string; tokens?: number; ms?: number }
  // The engine compacted the conversation mid-session (context summarized,
  // earlier verbatim turns dropped). Analysis needs this: citations and
  // recall behavior change character across a compaction boundary.
  | { type: "turn.compacted"; sessionId?: string; engine?: string; turn?: number }
  // Post-session probe (MemoSync Experiment Final): one record per injected
  // memory item. desired* = D_i, believed* = A_i, execution = the
  // participant's own E_i judgment; object* = the O_i snapshot at submit.
  | { type: "quiz.answer"; sessionId?: string; taskId: string; memoryId: string; desiredContent: string; desiredScope: string; believedContent: string; believedScope: string; execution: string; objectContent?: string; objectScope?: string; objectStatus?: string }
  | {
      type: "quiz.answer"
      schemaVersion: 2
      questionnaireVersion: StudyQuestionnaireVersion
      taskId: string
      snapshotId: string
      probeId: string
      cue: string
      desired: StudyDesiredMemoryAnswer | StudyDesiredMemoryAnswerV2
      assessed: StudyAssessedMemoryAnswer | StudyAssessedMemoryAnswerV2
      execution: StudyExecutionAnswer | StudyExecutionAnswerV2
      object: Record<string, unknown>
      qualityFlags?: string[]
      finalLineage?: unknown[]
      controlApplicable: boolean
    }
  // `chats` records which chats (and their projects) the task's window
  // covered — the task↔workspace mapping as a logged fact.
  | { type: "quiz.submit"; sessionId?: string; taskId: string; snapshotId?: string; submissionId?: string; items: number; attentionCheck?: StudyAttentionCheckResult; chats?: Array<{ chatId: string; title?: string; projectId?: string }> }
  // Durable Prolific completion receipt issuance (the code value itself stays
  // in SQLite; JSONL records only the version and timing evidence).
  | { type: "study.completion.receipt"; taskId: string; susSubmissionId: string; codeVersion: string; issuedAt: string }
  // Ending a session closes the active task's time window (serial gate).
  | {
      type: "study.freeze"
      sessionId?: string
      taskId: string
      snapshotId?: string
      qualityFlags?: string[]
      workspaceSnapshotPath?: string
      workspaceTreeHash?: string
    }
  // Experimenter-only: reopen an accidentally ended session (admin key).
  | { type: "study.unfreeze"; taskId: string }
  | { type: "study.raw_tlx.submit"; taskId: string; snapshotId: string; submissionId: string; activity: RawTlxActivity; ratings: RawTlxRatings; score: number }
  | { type: "study.session.complete"; taskId: string; snapshotId: string; completionId: string }
  | { type: "study.sus.submit"; taskId: string; submissionId: string; ratings: SusRatings; score: number }
  | {
      type: "study.instruction_guard"
      eventId: string
      taskId: string
      channel: "chat.send" | "message.enqueue" | "message.steer" | "queue.dispatch" | "ui"
      reason: "near_verbatim" | "ui_attempt"
      disqualifying: boolean
      chatId?: string
      projectId?: string
      surface?: "task_page" | "task_dialog"
      action?: string
      ruleVersion?: string
      longestContiguousRun?: number
      lcsRatio?: number
      reference?: string | null
    }

export class ExperimentLogger {
  private readonly filePath: string | null
  private readonly condition: ExperimentCondition
  private readonly participant: string | null
  private readonly allocationMode: ExperimentAllocationMode | null
  private readonly toStdout: boolean
  private readonly enabled: boolean
  private readonly durableSink: ((input: ExperimentDurableSinkInput) => ExperimentDurableSinkResult | void) | null

  constructor(opts: {
    filePath?: string | null
    condition?: string
    participant?: string
    allocationMode?: ExperimentAllocationMode
    stdout?: boolean
    /**
     * Authoritative SQLite sink for formal measurement events. It runs before
     * JSONL/stdout and is deliberately not caught: callers must never project
     * a study action that failed its durable write.
     */
    durableSink?: (input: ExperimentDurableSinkInput) => ExperimentDurableSinkResult | void
  } = {}) {
    this.enabled = process.env.EXPERIMENT_LOG !== "0"
    this.condition = (opts.condition ?? process.env.EXPERIMENT_CONDITION ?? "memosync") as ExperimentCondition
    // Stamped by the orchestrator on per-participant instances (PARTICIPANT_ID
    // env); absent on solo/dev instances so their logs stay shape-compatible.
    this.participant = opts.participant ?? process.env.PARTICIPANT_ID ?? null
    const allocationMode = opts.allocationMode ?? process.env.STUDY_ALLOCATION_MODE ?? null
    if (allocationMode !== null && allocationMode !== "study" && allocationMode !== "internal_qa") {
      throw new Error(`Invalid STUDY_ALLOCATION_MODE: ${allocationMode}`)
    }
    this.allocationMode = allocationMode
    this.toStdout = opts.stdout ?? true
    this.durableSink = opts.durableSink ?? null
    this.filePath = opts.filePath ?? null
    if (this.enabled && this.filePath) {
      try {
        mkdirSync(dirname(this.filePath), { recursive: true })
      } catch {
        /* best-effort; fall back to stdout only */
      }
    }
  }

  // `unknown` preserves compatibility with the many lightweight structural
  // logger adapters whose callbacks return `void` (or Array#push's number).
  // Authority-aware callers narrow the runtime ExperimentLogResult.
  event(e: ExperimentEvent): unknown {
    const recordedAt = new Date().toISOString()
    const durableResult = this.durableSink?.({
      recordedAt,
      condition: this.condition,
      participant: this.participant,
      allocationMode: this.allocationMode,
      event: e,
    })
    const result = { durableCreated: durableResult?.created ?? null }
    if (!this.enabled) return result
    const record = {
      ts: recordedAt,
      condition: this.condition,
      ...(this.participant ? { participant: this.participant } : {}),
      ...(this.allocationMode ? { allocationMode: this.allocationMode } : {}),
      ...e,
    }
    const line = JSON.stringify(record)
    if (this.toStdout) console.log(`[experiment] ${line}`)
    if (this.filePath) {
      try {
        appendFileSync(this.filePath, line + "\n")
      } catch {
        /* never let logging break a turn */
      }
    }
    return result
  }
}

/** No-op logger for tests / when logging is not wired. */
export const NoopExperimentLogger: Pick<ExperimentLogger, "event"> = { event: () => ({ durableCreated: null }) }
