import { LocalUsageLog } from "../usage/local-log";

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
export type UsageEvent =
  { type: "memory.branch"; sessionId: string; engine: string; purpose: string; branchId: string; mode: "fork" | "empty-history" }
  | { type: "memory.inject"; schemaVersion?: 1; sessionId?: string; engine?: string; memories: MemoryRef[]; tokenEstimate?: number; mode?: "skills" | "plain" | "file"; staticFiles?: string[] }
  | DeliveredFocusEvent
  | { type: "memory.propose"; sessionId?: string; engine?: string; id: string; memType: string; scope: string; via?: string; targetId?: string; drift?: string; revisionAction?: string; reason?: string }
  | { type: "memory.cite"; sessionId?: string; citedIds: string[]; countedIds: string[]; carryoverIds?: string[] }
  | { type: "memory.decision"; sessionId?: string; action: "create" | "accept" | "edit" | "dismiss" | "rescope" | "archive" | "revert" | "restore" | "unmute" | "promote"; id: string; fromScope?: string; toScope?: string; via?: string }
  | { type: "memory.capture"; sessionId?: string; engine?: string; turn?: number; status: "ok" | "failed"; stage?: "capture_pass" | "necessity_pass" | "persist"; errorClass?: string; errorCategory?: "cancelled" | "timeout" | "network" | "rate_limited" | "provider_5xx" | "provider_4xx" | "empty_response" | "truncated" | "invalid_json" | "invalid_response" | "unknown"; httpStatus?: number; channel?: "hook" | "agent" | "prompt"; proposed?: number; surfaced?: number; dropped?: number; sensitive?: number; reinforced?: number; revisions?: number; sameTurnDuplicates?: number }
  | { type: "memory.conflict"; sessionId?: string; engine?: string; turn?: number; newId: string; staleId: string }
  | { type: "memory.proposals"; sessionId?: string; engine?: string; turn?: number; count: number; decision: "reviewed" | "skipped" | "cancelled" | "expired" | "empty" }
  | { type: "memory.checkup"; sessionId?: string; engine?: string; turn?: number; suggestions: number; cached?: boolean; failedKinds?: Array<"conflict" | "redundancy" | "staleness">; decision: "clear" | "handled" | "skipped" | "cancelled" | "expired" | "failed" }
  | { type: "memory.preparation_reopen"; sessionId?: string; engine?: string; turn?: number; from: "proposals" | "checkup" | "transfer"; revision: number }
  | { type: "memory.trace"; sessionId?: string; engine?: string; turn?: number; status?: "ok" | "failed" | "discarded" | "empty"; stage?: "trace_pass" | "cas"; errorClass?: string; dropped?: number; labels: Array<{ id: string; label: string }>; via?: "fork" | "sidecar" }
  | { type: "memory.detail_load"; sessionId?: string; engine?: string; ids: string[] }
  | { type: "memory.bringin"; sessionId?: string; ids: string[] }
  | { type: "memory.exclude"; sessionId?: string; ids: string[] }
  | { type: "memory.working_memory_selection"; eventId?: string; clientTimestamp?: string; sessionId?: string; chatId: string; previewId: string; memoryId: string; action: "add" | "remove" }
  | { type: "memory.transfer"; sessionId?: string; sourceId: string; newId?: string; fromScope?: string; targetScope: string; targetProjectId?: string; verdict?: string; edited?: boolean; archivedOriginal?: boolean; surface?: "board" | "chat_gate" }
  | { type: "memory.transfer_decline"; sessionId?: string; id: string; contextKey: string; surface?: "board" | "chat_gate" }
  | { type: "memory.transfer_card"; sessionId: string; engine?: string; turn?: number; suggestions: number; decision: "handled" | "skipped" | "cancelled" | "expired" | "empty" }
  | { type: "memory.sanitize"; sessionId?: string; id: string; redactions: number }
  | { type: "ui.monitor"; eventId?: string; clientTimestamp?: string; sessionId?: string; chatId?: string; surface: string; interaction?: "open" | "click" | "scroll" | "hover"; ids?: string[] }
  | { type: "ui.surface_exposure"; eventId?: string; clientTimestamp?: string; sessionId?: string; chatId?: string; surface: string; action: "opened" | "hidden" | "visible" | "closed"; exposureId?: string; sequence?: number; initiator?: "participant" | "system"; memoryIds?: string[]; closeReason?: string }
  | { type: "memory.attention"; sessionId?: string; kind: "conflict" | "revision" | "redundant" | "stale" | "promotion"; id: string; action: "shown" | "defer" | "renew" | "archive" | "keep" | "merge" | "promote" | "decline"; surface?: "board" | "chat_gate" }
  | { type: "memory.audit_action"; eventId?: string; operationId?: string; sessionId?: string; chatId?: string; id: string; action: "pay_attention" | "draft_fix" | "enforce" }
  | { type: "memory.interrupt"; eventId?: string; interruptId?: string; sessionId?: string; chatId?: string; id: string; turn?: number; quote?: string }
  | { type: "memory.resume"; eventId: string; interruptId: string; sessionId: string; chatId: string; id: string; enforced: boolean }
  | { type: "memory.preview"; operationId?: string; sessionId?: string; engine?: string; turn?: number; memoryIds: string[]; decision?: "go_on" | "dismiss" | "without_memory" | "auto_go_on" | "expired"; selectedIds?: string[] }
  | { type: "memory.revise_injection"; operationId?: string; sessionId?: string; instruction: string; beforeIds: string[]; afterIds: string[]; changed: boolean }
  | { type: "memory.relevance"; sessionId?: string; turn?: number; ids: string[] }
  | { type: "memory.setting"; sessionId?: string; section: string; value: Record<string, unknown> }
  | { type: "turn.usage"; sessionId?: string; engine?: string; model?: string; tokens?: number; ms?: number }
  | { type: "turn.compacted"; sessionId?: string; engine?: string; turn?: number }

export class UsageLogger {
  private readonly output: LocalUsageLog
  private readonly installId?: string
  constructor(options: { filePath?: string | null; stdout?: boolean; installId?: string } = {}) {
    this.output = new LocalUsageLog(options)
    this.installId = options.installId
  }
  event(event: UsageEvent): void {
    this.output.write({ ts: new Date().toISOString(), ...(this.installId ? { installId: this.installId } : {}), ...event })
  }
}
export const NoopUsageLogger: Pick<UsageLogger, "event"> = { event: () => undefined }
