import type {
  ChatActivityStatus,
  ChatSnapshot,
  MemoryCheckupDecisionEntry,
  MemoryCheckupEntry,
  MemoryCheckupResultEntry,
  MemoryCheckupSuggestionSummary,
  MemoryPreparationResetEntry,
  MemoryPreviewDecisionEntry,
  MemoryPreviewEntry,
  MemoryPreviewUpdateEntry,
  MemoryProposalsDecisionEntry,
  MemoryProposalsEntry,
  MemoryProposalsResultEntry,
  MemoryTransferDecisionEntry,
  MemoryTransferEntry,
  MemoryTransferResultEntry,
  MemoryTransferSuggestionSummary,
  ModelAccessSnapshot,
  ModelOptions,
  QueuedChatMessage,
  ToolCallEntry,
  ToolResultEntry,
  TranscriptEntry,
  UserPromptEntry,
} from "../types"

export function isActiveStatus(status: ChatActivityStatus | undefined): boolean {
  return (
    status === "running" ||
    status === "starting" ||
    status === "previewing_memory" ||
    status === "waiting_for_user"
  )
}

export function normalizedToolKind(entry: ToolCallEntry): string {
  if (entry.tool.toolKind) return entry.tool.toolKind
  const name = (entry.tool.toolName ?? "").toLowerCase()
  if (name === "askuserquestion") return "ask_user_question"
  if (name === "exitplanmode") return "exit_plan_mode"
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`).replace(/^_/, "")
}

export function isToolResultEntry(entry: TranscriptEntry): entry is ToolResultEntry {
  return entry.kind === "tool_result" && "toolId" in entry
}

// ---------------------------------------------------------------------------
// Composer model & connection selection recovery (Finding 1.3)
// ---------------------------------------------------------------------------

export interface ComposerModelSelection {
  provider?: string
  model?: string
  modelOptions?: ModelOptions
}

function hasModelOptions(options: ModelOptions | undefined): boolean {
  if (!options) return false
  return Boolean(
    options.connectionId ||
      options.claude ||
      options.codex ||
      options.pi ||
      (options.opencode && Object.keys(options.opencode).length > 0),
  )
}

export function modelCommandFields(selection: ComposerModelSelection | null): {
  provider?: string
  model?: string
  modelOptions?: ModelOptions
} {
  return {
    ...(selection?.provider ? { provider: selection.provider } : {}),
    ...(selection?.model ? { model: selection.model } : {}),
    ...(selection?.modelOptions ? { modelOptions: selection.modelOptions } : {}),
  }
}

export function commandCatalogModelSelection(snapshot: ChatSnapshot | null): ComposerModelSelection | null {
  const selection = snapshot?.runtime.commandCatalog?.selection
  const provider = snapshot?.runtime.provider ?? null
  if (!selection?.provider) return null
  const model = selection.model?.trim() || undefined
  if (!model && !hasModelOptions(selection.modelOptions)) return null
  if (provider && selection.provider !== provider) return null
  return {
    provider: selection.provider,
    ...(model ? { model } : {}),
    ...(selection.modelOptions ? { modelOptions: selection.modelOptions } : {}),
  }
}

export function latestSystemInitModelSelection(
  entries: TranscriptEntry[],
  provider: string | null,
): ComposerModelSelection | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as TranscriptEntry & { provider?: unknown; model?: unknown }
    if (entry.kind !== "system_init" || typeof entry.model !== "string" || !entry.model.trim()) continue
    if (typeof entry.provider !== "string" || (provider && entry.provider !== provider)) continue
    return { provider: entry.provider, model: entry.model }
  }
  return null
}

function selectionConnectionId(selection: ComposerModelSelection): string | undefined {
  const options = selection.modelOptions
  if (!selection.provider || !options) return undefined
  if (options.connectionId) return options.connectionId
  if (selection.provider === "claude") return options.claude?.connectionId
  if (selection.provider === "codex") return options.codex?.connectionId
  if (selection.provider === "pi") return options.pi?.connectionId
  return undefined
}

function stripDeletedConnectionFromOptions(options: ModelOptions | undefined): ModelOptions | undefined {
  if (!options) return undefined
  const next: ModelOptions = {}
  if (options.claude) {
    const { connectionId: _removed, ...rest } = options.claude
    if (Object.keys(rest).length > 0) next.claude = rest
  }
  if (options.codex) {
    const { connectionId: _removed, ...rest } = options.codex
    if (Object.keys(rest).length > 0) next.codex = rest
  }
  if (options.pi) {
    const { connectionId: _removed, ...rest } = options.pi
    if (Object.keys(rest).length > 0) next.pi = rest
  }
  if (options.opencode && Object.keys(options.opencode).length > 0) {
    next.opencode = options.opencode
  }
  return hasModelOptions(next) ? next : undefined
}

/**
 * Recover a remembered connection/model selection when the host edits or
 * deletes API connections:
 * - If the connection itself was deleted (`!connection`), strip `connectionId`
 *   and clear the connection-scoped `model` so the host uses its current
 *   engine setup instead of failing every send with `"connection-missing"`.
 * - If the connection still exists and its model list changed, pick a valid
 *   model still offered by that same connection.
 */
export function recoverConnectionModelSelection(
  selection: ComposerModelSelection | null,
  modelAccess: ModelAccessSnapshot | null,
): ComposerModelSelection | null {
  if (!selection?.provider || !modelAccess) return selection
  const connectionId = selectionConnectionId(selection)
  if (!connectionId) return selection
  const connection = modelAccess.connections.find((candidate) => candidate.id === connectionId)
  if (!connection) {
    const cleanedOptions = stripDeletedConnectionFromOptions(selection.modelOptions)
    return {
      provider: selection.provider,
      ...(cleanedOptions ? { modelOptions: cleanedOptions } : {}),
    }
  }
  if (!selection.model || connection.models.length === 0) return selection
  if (selection.provider === "pi" && connection.readOnly) return selection
  const requested = selection.model.replace(/\[1m\]$/, "")
  if (connection.models.some((model) => model.id === requested)) return selection
  const engineAccess = modelAccess.engines[selection.provider]?.setup?.access
  const configuredDefault =
    engineAccess?.mode === "connection" && engineAccess.connectionId === connectionId
      ? engineAccess.defaultModel
      : undefined
  const replacement = [configuredDefault, connection.models[0]?.id].find((candidate): candidate is string =>
    Boolean(candidate && connection.models.some((model) => model.id === candidate)),
  )
  return replacement ? { ...selection, model: replacement } : { ...selection, model: undefined }
}

// ---------------------------------------------------------------------------
// Post-approval planMode derivation from transcript (Finding 1.2)
// ---------------------------------------------------------------------------

function parseExitPlanDecision(content: unknown): boolean | null {
  let parsed: unknown = content
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return null
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const record = parsed as { confirmed?: unknown; discarded?: unknown }
  if (record.discarded === true) return false
  if (typeof record.confirmed === "boolean") return record.confirmed
  return null
}

/**
 * Derive whether an `exit_plan_mode` approval (`confirmed: true`) has occurred
 * without a subsequent non-prequeued `user_prompt` consuming it yet.
 *
 * On the host, approving a plan continues implementation in the same turn and
 * leaves `runtime.planMode === true` until the NEXT user turn starts. Reading
 * the persisted `tool_result` directly ensures approvals made on desktop or
 * before a mobile app restart still switch the next mobile prompt out of plan
 * mode.
 */
export function hasUnconsumedPlanApproval(
  entries: TranscriptEntry[],
  preApprovedQueuedContents: readonly string[] = [],
): boolean {
  const exitPlanToolIds = new Set<string>()
  for (const entry of entries) {
    if (entry.kind !== "tool_call") continue
    const toolEntry = entry as ToolCallEntry
    if (normalizedToolKind(toolEntry) === "exit_plan_mode") {
      exitPlanToolIds.add(toolEntry.tool.toolId ?? toolEntry._id)
    }
  }
  if (exitPlanToolIds.size === 0) return false

  let approved = false
  let remainingPreQueued: string[] = []

  for (const entry of entries) {
    if (isToolResultEntry(entry) && exitPlanToolIds.has(entry.toolId)) {
      const decision = parseExitPlanDecision(entry.content)
      if (decision === true) {
        approved = true
        remainingPreQueued = [...preApprovedQueuedContents]
      } else if (decision === false) {
        approved = false
        remainingPreQueued = []
      }
      continue
    }
    if (approved && entry.kind === "user_prompt" && !entry.hidden) {
      const promptText = (entry as UserPromptEntry).content
      const queuedIndex = remainingPreQueued.indexOf(promptText)
      if (queuedIndex >= 0) {
        remainingPreQueued.splice(queuedIndex, 1)
        continue
      }
      approved = false
      remainingPreQueued = []
    }
  }

  return approved
}

// ---------------------------------------------------------------------------
// Pending tool & memory-gate state derivation (Findings 2.1, 2.2, 2.3)
// ---------------------------------------------------------------------------

export interface OpenProposalsGate {
  proposalsId: string
  count: number
  scanning: boolean
  superseded: boolean
}

export interface OpenTransferGate {
  transferId: string
  count: number
  scanning: boolean
  superseded: boolean
  suggestions: MemoryTransferSuggestionSummary[]
}

export interface OpenCheckupGate {
  checkupId: string
  count: number
  scanning: boolean
  waiting: boolean
  superseded: boolean
  suggestions: MemoryCheckupSuggestionSummary[]
}

export interface MemoryGateState {
  /** Preview id that the wire state proves is actively parked on the host. */
  pendingPreviewId: string | null
  /** Current-turn preview id whose host park was dropped/reopened or is no longer active. */
  supersededPreviewId: string | null
  supersededPreviewReason: "reopened" | "inactive" | null
  previewMemoriesById: Map<string, Array<{ id: string; content: string; scope: string }>>
  openProposalsById: Map<string, OpenProposalsGate>
  openTransfersById: Map<string, OpenTransferGate>
  openCheckupsById: Map<string, OpenCheckupGate>
  hasOpenGate: boolean
  hasParkedGate: boolean
}

/**
 * Fold append-only memory preparation events (results, updates, decisions, and
 * reopen resets) and inspect only the current turn's pre-boot tail, mirroring
 * `src/client/lib/parseTranscript.ts` and `src/client/app/derived.ts`.
 *
 * Any undecided gate followed by `assistant_text`, `tool_call`, `result`,
 * `interrupted`, or a newer `user_prompt` is an orphaned historical entry and
 * is never treated as live.
 *
 * When host wire state is provided, a memory gate is interactive ONLY when the
 * wire state proves the host is still parked on it:
 * - A `memory_preparation_reset` for a preview drops the host's parked preview
 *   until a matching `memory_preview_update` (revision >= reset.revision) lands.
 * - Step-one gates (proposals / transfer / checkup) only park while the host
 *   holds `runtime.status === "previewing_memory"`.
 * - When `pendingMemoryPreviewId` is provided by the host (authoritative runtime
 *   state), a preview is parked if and only if `pendingMemoryPreviewId` matches
 *   it — keeping live cards active even when `lastTurnOutcome === "failed"`
 *   (`wireStatus === "failed"`) and deactivating orphaned cards immediately
 *   after a host restart (`pendingMemoryPreviewId === null`, `wireStatus === "idle"`).
 * - Against older hosts that omit `pendingMemoryPreviewId` (`undefined`), fall
 *   back to `wireStatus` allowing `"idle"`, `"previewing_memory"`, and `"failed"`
 *   (a current-turn failure always appends a post-preview `result` entry that
 *   stops the backward scan before reaching the preview).
 */
export function deriveMemoryGateState(
  entries: TranscriptEntry[],
  wireStatus?: ChatActivityStatus,
  pendingMemoryPreviewId?: string | null,
): MemoryGateState {
  const previewDecisions = new Map<string, string>()
  const previewMemoriesById = new Map<string, Array<{ id: string; content: string; scope: string }>>()
  const previewRefreshing = new Set<string>()
  const previewRefreshVersions = new Map<string, number>()
  const proposalsDecisions = new Map<string, string>()
  const proposalsResults = new Map<string, Array<{ id: string }>>()
  const transferDecisions = new Map<string, string>()
  const transferResults = new Map<string, MemoryTransferSuggestionSummary[]>()
  const transferResultsDone = new Set<string>()
  const transferScanning = new Set<string>()
  const checkupDecisions = new Map<string, string>()
  const checkupResults = new Map<string, MemoryCheckupSuggestionSummary[]>()
  const checkupResetStates = new Map<string, "waiting" | "pending">()

  for (const entry of entries) {
    switch (entry.kind) {
      case "memory_preview": {
        const preview = entry as MemoryPreviewEntry
        if (preview.memories) previewMemoriesById.set(preview.previewId, preview.memories)
        previewRefreshing.delete(preview.previewId)
        previewRefreshVersions.set(preview.previewId, 0)
        break
      }
      case "memory_preview_update": {
        const update = entry as MemoryPreviewUpdateEntry
        previewMemoriesById.set(update.previewId, update.memories)
        const currentVersion = previewRefreshVersions.get(update.previewId) ?? 0
        if (update.revision >= currentVersion) {
          previewRefreshing.delete(update.previewId)
          previewRefreshVersions.set(update.previewId, update.revision)
        }
        break
      }
      case "memory_preview_decision": {
        const decision = entry as MemoryPreviewDecisionEntry
        previewDecisions.set(decision.previewId, decision.decision)
        previewRefreshing.delete(decision.previewId)
        break
      }
      case "memory_proposals_result": {
        const result = entry as MemoryProposalsResultEntry
        proposalsResults.set(result.proposalsId, result.candidates)
        break
      }
      case "memory_proposals_decision": {
        const decision = entry as MemoryProposalsDecisionEntry
        proposalsDecisions.set(decision.proposalsId, decision.decision)
        break
      }
      case "memory_transfer": {
        const transfer = entry as MemoryTransferEntry
        if (transfer.pending) transferScanning.add(transfer.transferId)
        else transferScanning.delete(transfer.transferId)
        break
      }
      case "memory_transfer_result": {
        const result = entry as MemoryTransferResultEntry
        transferResults.set(result.transferId, result.suggestions)
        // Recomputed transfer passes (e.g. after proposals reopen in memoryBranches
        // mode) re-park an existing transferId without a transfer reset entry.
        transferDecisions.delete(result.transferId)
        if (result.done) {
          transferResultsDone.add(result.transferId)
          transferScanning.delete(result.transferId)
        } else {
          transferResultsDone.delete(result.transferId)
          transferScanning.add(result.transferId)
        }
        break
      }
      case "memory_transfer_decision": {
        const decision = entry as MemoryTransferDecisionEntry
        transferDecisions.set(decision.transferId, decision.decision)
        transferScanning.delete(decision.transferId)
        break
      }
      case "memory_checkup_result": {
        const result = entry as MemoryCheckupResultEntry
        checkupResults.set(result.checkupId, result.suggestions)
        checkupResetStates.delete(result.checkupId)
        break
      }
      case "memory_checkup_decision": {
        const decision = entry as MemoryCheckupDecisionEntry
        checkupDecisions.set(decision.checkupId, decision.decision)
        break
      }
      case "memory_preparation_reset": {
        const reset = entry as MemoryPreparationResetEntry
        if (reset.previewId) {
          previewRefreshing.add(reset.previewId)
          previewRefreshVersions.set(
            reset.previewId,
            Math.max(previewRefreshVersions.get(reset.previewId) ?? 0, reset.revision),
          )
        }
        if (reset.checkupId) {
          checkupResults.delete(reset.checkupId)
          checkupDecisions.delete(reset.checkupId)
          checkupResetStates.set(reset.checkupId, reset.from === "checkup" ? "pending" : "waiting")
        }
        if ((reset.from === "proposals" || reset.openingReviewId) && reset.proposalsId) {
          proposalsDecisions.delete(reset.proposalsId)
        }
        if ((reset.from === "transfer" || reset.openingReviewId) && reset.transferId) {
          transferDecisions.delete(reset.transferId)
          transferScanning.delete(reset.transferId)
        }
        break
      }
    }
  }

  let candidatePreviewId: string | null = null
  const openProposalsById = new Map<string, OpenProposalsGate>()
  const openTransfersById = new Map<string, OpenTransferGate>()
  const openCheckupsById = new Map<string, OpenCheckupGate>()

  const stepOneActiveOnHost = wireStatus === undefined || wireStatus === "previewing_memory"

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (!entry || entry.hidden) continue

    if (
      entry.kind === "assistant_text" ||
      entry.kind === "tool_call" ||
      entry.kind === "result" ||
      entry.kind === "interrupted"
    ) {
      break
    }

    if (entry.kind === "memory_preview") {
      const preview = entry as MemoryPreviewEntry
      if (candidatePreviewId === null && !previewDecisions.has(preview.previewId)) {
        candidatePreviewId = preview.previewId
      }
    } else if (entry.kind === "memory_proposals") {
      const proposals = entry as MemoryProposalsEntry
      if (!proposalsDecisions.has(proposals.proposalsId) && !openProposalsById.has(proposals.proposalsId)) {
        const candidates = proposalsResults.get(proposals.proposalsId) ?? proposals.candidates ?? []
        const rawScanning = Boolean(proposals.pending && !proposalsResults.has(proposals.proposalsId))
        const superseded = !stepOneActiveOnHost
        openProposalsById.set(proposals.proposalsId, {
          proposalsId: proposals.proposalsId,
          count: candidates.length,
          scanning: superseded ? false : rawScanning,
          superseded,
        })
      }
    } else if (entry.kind === "memory_transfer") {
      const transfer = entry as MemoryTransferEntry
      if (!transferDecisions.has(transfer.transferId) && !openTransfersById.has(transfer.transferId)) {
        const suggestions = transferResults.get(transfer.transferId) ?? transfer.suggestions ?? []
        const rawScanning =
          transferScanning.has(transfer.transferId) ||
          Boolean(transfer.pending && !transferResultsDone.has(transfer.transferId) && !transferResults.has(transfer.transferId))
        const superseded = !stepOneActiveOnHost
        openTransfersById.set(transfer.transferId, {
          transferId: transfer.transferId,
          count: suggestions.length,
          scanning: superseded ? false : rawScanning,
          superseded,
          suggestions,
        })
      }
    } else if (entry.kind === "memory_checkup") {
      const checkup = entry as MemoryCheckupEntry
      if (!checkupDecisions.has(checkup.checkupId) && !openCheckupsById.has(checkup.checkupId)) {
        const resetState = checkupResetStates.get(checkup.checkupId)
        const suggestions = checkupResults.get(checkup.checkupId) ?? []
        const rawScanning = Boolean(
          resetState === "pending" ||
            (resetState === undefined && checkup.pending && !checkupResults.has(checkup.checkupId)),
        )
        const rawWaiting = resetState === "waiting"
        const superseded = !stepOneActiveOnHost
        openCheckupsById.set(checkup.checkupId, {
          checkupId: checkup.checkupId,
          count: suggestions.length,
          scanning: superseded ? false : rawScanning,
          waiting: superseded ? false : rawWaiting,
          superseded,
          suggestions,
        })
      }
    }

    if (entry.kind === "user_prompt") {
      break
    }
  }

  const hasAnyStepOneGate =
    openProposalsById.size > 0 || openTransfersById.size > 0 || openCheckupsById.size > 0
  const hasLiveStepOneGate =
    [...openProposalsById.values()].some((gate) => !gate.superseded) ||
    [...openTransfersById.values()].some((gate) => !gate.superseded) ||
    [...openCheckupsById.values()].some((gate) => !gate.superseded)

  const previewStatusAllowsPark =
    pendingMemoryPreviewId !== undefined
      ? candidatePreviewId !== null && pendingMemoryPreviewId === candidatePreviewId
      : wireStatus === undefined ||
        wireStatus === "idle" ||
        wireStatus === "previewing_memory" ||
        wireStatus === "failed"

  let pendingPreviewId: string | null = null
  let supersededPreviewId: string | null = null
  let supersededPreviewReason: "reopened" | "inactive" | null = null

  if (candidatePreviewId !== null) {
    const previewReopened = previewRefreshing.has(candidatePreviewId) || hasLiveStepOneGate
    if (!previewReopened && !hasAnyStepOneGate && previewStatusAllowsPark) {
      pendingPreviewId = candidatePreviewId
    } else {
      supersededPreviewId = candidatePreviewId
      supersededPreviewReason = previewReopened ? "reopened" : "inactive"
    }
  }

  const hasOpenGate = pendingPreviewId !== null || hasLiveStepOneGate

  const hasParkedGate =
    pendingPreviewId !== null ||
    [...openProposalsById.values()].some((gate) => !gate.superseded && !gate.scanning) ||
    [...openTransfersById.values()].some((gate) => !gate.superseded && !gate.scanning) ||
    [...openCheckupsById.values()].some((gate) => !gate.superseded && !gate.scanning && !gate.waiting)

  return {
    pendingPreviewId,
    supersededPreviewId,
    supersededPreviewReason,
    previewMemoriesById,
    openProposalsById,
    openTransfersById,
    openCheckupsById,
    hasOpenGate,
    hasParkedGate,
  }
}

export function deriveEffectiveChatStatus(
  wireStatus: ChatActivityStatus | undefined,
  gateState: MemoryGateState,
): ChatActivityStatus | undefined {
  if (isActiveStatus(wireStatus)) {
    if (wireStatus === "previewing_memory" && gateState.hasParkedGate) {
      return "waiting_for_user"
    }
    return wireStatus
  }
  if (gateState.hasOpenGate) {
    return gateState.hasParkedGate ? "waiting_for_user" : "previewing_memory"
  }
  return wireStatus
}

export function findPendingInteractiveToolId(
  entries: TranscriptEntry[],
  runtimeStatus: ChatActivityStatus | undefined,
): string | null {
  if (runtimeStatus !== "waiting_for_user") return null
  const answered = new Set<string>()
  for (const entry of entries) {
    if (isToolResultEntry(entry)) answered.add(entry.toolId)
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (!entry) continue
    if (entry.kind === "user_prompt" || entry.kind === "result" || entry.kind === "interrupted") {
      return null
    }
    if (entry.kind !== "tool_call") continue
    const toolEntry = entry as ToolCallEntry
    const kind = normalizedToolKind(toolEntry)
    if (kind !== "ask_user_question" && kind !== "exit_plan_mode") continue
    const toolId = toolEntry.tool.toolId ?? toolEntry._id
    if (!answered.has(toolId)) return toolId
  }
  return null
}

// ---------------------------------------------------------------------------
// Send reconciliation across mid-boot disconnects / ack timeouts (Finding 1.1)
// ---------------------------------------------------------------------------

export interface PreSendBaseline {
  promptIds: ReadonlySet<string>
  queueIds: ReadonlySet<string>
}

export function capturePreSendBaseline(
  entries: TranscriptEntry[],
  queuedMessages: QueuedChatMessage[],
): PreSendBaseline {
  const promptIds = new Set<string>()
  for (const entry of entries) {
    if (entry.kind === "user_prompt") promptIds.add(entry._id)
  }
  const queueIds = new Set<string>()
  for (const item of queuedMessages) {
    queueIds.add(item.id)
  }
  return { promptIds, queueIds }
}

/** True only when the command frame had already left the device and its
 * outcome became uncertain because the socket closed or timed out before ack. */
export function isAmbiguousSendTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : ""
  return (
    message === "Disconnected from the MemoSync host" ||
    message.startsWith("Timed out waiting for the server (")
  )
}

export function wasSendCommittedInSnapshot(
  content: string,
  baseline: PreSendBaseline,
  entries: TranscriptEntry[],
  queuedMessages: QueuedChatMessage[],
  clientRequestId?: string,
): boolean {
  if (clientRequestId) {
    for (const entry of entries) {
      if (entry.kind === "user_prompt" && (entry as UserPromptEntry).clientRequestId === clientRequestId) {
        return true
      }
    }
    for (const item of queuedMessages) {
      if (item.clientRequestId === clientRequestId) {
        return true
      }
    }
  }
  const normalized = content.trim()
  for (const entry of entries) {
    // The host reuses a queued message's id as the transcript prompt id when
    // the queue dispatches it, so a baseline queue row that merely STARTED
    // must not count as delivery of the new send.
    if (entry.kind !== "user_prompt" || baseline.promptIds.has(entry._id) || baseline.queueIds.has(entry._id)) continue
    const prompt = entry as UserPromptEntry
    const text = (prompt.participantContent ?? prompt.content).trim()
    if (text === normalized) return true
  }
  for (const item of queuedMessages) {
    if (baseline.queueIds.has(item.id)) continue
    if (item.content.trim() === normalized) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Idempotency key & draft restoration lifecycle (Fix 1), stale command
// restore guard (Fix 2), and atomic snapshot window helpers (F-5.3)
// ---------------------------------------------------------------------------

export type SendRetryAction = "send" | "queue" | "steer"

export interface PendingRetryKey {
  clientRequestId: string
  /** Exact trimmed content this key was issued for (empty only for oversized hash-only fallback). */
  content: string
  /** Deterministic content digest used when an oversized prompt could not be persisted verbatim. */
  contentHash?: string
  /** Dispatch mode this key was issued for; switching queue <-> steer mints a fresh key. */
  action?: SendRetryAction
}

export interface ColdStartBaselineCursor {
  lastPromptId: string | null
  lastPromptCreatedAt: number | null
  queueIds: string[]
}

export interface InFlightSendState {
  clientRequestId: string
  /** Exact trimmed content sent over the socket (empty only for oversized hash-only fallback). */
  content: string
  contentHash?: string
  action: SendRetryAction
  baseline: ColdStartBaselineCursor
  errorMessage?: string | null
  sentAt: number
}

export interface PendingDequeueRestore {
  queuedMessageId: string
  content: string
  mode: "restore_empty" | "replace"
}

export interface PersistedDraftState {
  draft: string
  pendingRetry: PendingRetryKey | null
  sendError: string | null
  /** Unacked send currently in flight or awaiting cold-start snapshot reconciliation. Kept separate from visible `draft`. */
  inFlightSend?: InFlightSendState | null
  /** Already-dequeued expired slash command preserved across unmount/navigation until user decides. */
  pendingRestoredCommand?: string | null
  /** In-flight or ambiguous-error expired-command dequeue awaiting ack or snapshot reconciliation. */
  pendingDequeueRestore?: PendingDequeueRestore | null
}

export const EMPTY_DRAFT_STATE: PersistedDraftState = {
  draft: "",
  pendingRetry: null,
  sendError: null,
}

export const MAX_SECURE_STORE_DRAFT_BYTES = 1_900
export const MAX_DRAFT_STORAGE_CHUNKS = 8
export const OVERSIZED_UNCOMMITTED_SEND_ERROR =
  "Previous large message did not finish before the app closed and was too large to restore."

export function utf8ByteLength(value: string): number {
  let bytes = 0
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      bytes += 4
      i += 1
    } else bytes += 3
  }
  return bytes
}

/** Split a string into UTF-8 byte-bounded chunks without breaking surrogate pairs. */
export function splitStringByUtf8Bytes(value: string, maxChunkBytes: number): string[] {
  if (!value) return []
  if (maxChunkBytes < 4) throw new Error("maxChunkBytes must be at least 4")
  const chunks: string[] = []
  let start = 0
  let chunkBytes = 0
  for (let i = 0; i < value.length; ) {
    const code = value.charCodeAt(i)
    const isSurrogatePair = code >= 0xd800 && code <= 0xdbff && i + 1 < value.length
    const charUnits = isSurrogatePair ? 2 : 1
    const charBytes = code < 0x80 ? 1 : code < 0x800 ? 2 : isSurrogatePair ? 4 : 3
    if (chunkBytes + charBytes > maxChunkBytes && i > start) {
      chunks.push(value.slice(start, i))
      start = i
      chunkBytes = 0
    }
    chunkBytes += charBytes
    i += charUnits
  }
  if (start < value.length) {
    chunks.push(value.slice(start))
  }
  return chunks
}

/** Fast pure-JS 64-bit FNV-1a digest over trimmed prompt text for oversized fallback matching. */
export function hashDraftContent(content: string): string {
  const normalized = content.trim()
  let h1 = 0x811c9dc5
  let h2 = 0x811c9dc5 ^ 0x9e3779b9
  for (let i = 0; i < normalized.length; i += 1) {
    const c = normalized.charCodeAt(i)
    h1 ^= c & 0xff
    h1 = Math.imul(h1, 0x01000193)
    h1 ^= (c >>> 8) & 0xff
    h1 = Math.imul(h1, 0x01000193)
    h2 ^= ((c + i) & 0xff)
    h2 = Math.imul(h2, 0x01000193)
    h2 ^= ((c >>> 8) ^ (i & 0xff))
    h2 = Math.imul(h2, 0x01000193)
  }
  const part1 = (h1 >>> 0).toString(16).padStart(8, "0")
  const part2 = (h2 >>> 0).toString(16).padStart(8, "0")
  return `fnv64:${part1}${part2}`
}

function isValidSendRetryAction(value: unknown): value is SendRetryAction {
  return value === "send" || value === "queue" || value === "steer"
}

function isValidDequeueRestoreMode(value: unknown): value is PendingDequeueRestore["mode"] {
  return value === "restore_empty" || value === "replace"
}

function normalizePersistedDraftState(state: PersistedDraftState): PersistedDraftState {
  const normalized: PersistedDraftState = {
    draft: state.draft,
    pendingRetry: state.pendingRetry,
    sendError: state.sendError,
  }
  if (state.inFlightSend) normalized.inFlightSend = state.inFlightSend
  if (state.pendingRestoredCommand) normalized.pendingRestoredCommand = state.pendingRestoredCommand
  if (state.pendingDequeueRestore) normalized.pendingDequeueRestore = state.pendingDequeueRestore
  return normalized
}

export function isDraftStateEmpty(state: PersistedDraftState): boolean {
  return (
    !state.draft &&
    !state.pendingRetry &&
    !state.sendError &&
    !state.inFlightSend &&
    !state.pendingRestoredCommand &&
    !state.pendingDequeueRestore
  )
}

export function captureColdStartBaseline(
  entries: readonly TranscriptEntry[],
  queuedMessages: readonly QueuedChatMessage[],
): ColdStartBaselineCursor {
  let lastPromptId: string | null = null
  let lastPromptCreatedAt: number | null = null
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]
    if (entry && entry.kind === "user_prompt") {
      lastPromptId = entry._id
      lastPromptCreatedAt = entry.createdAt
      break
    }
  }
  return {
    lastPromptId,
    lastPromptCreatedAt,
    queueIds: queuedMessages.slice(-24).map((item) => item.id),
  }
}

export function wasInFlightSendCommittedInSnapshot(
  inFlight: InFlightSendState,
  entries: readonly TranscriptEntry[],
  queuedMessages: readonly QueuedChatMessage[],
  hasOlderHistory = false,
): boolean {
  const targetTrimmed = inFlight.content.trim()
  const targetHash = inFlight.contentHash ?? (targetTrimmed ? hashDraftContent(targetTrimmed) : "")
  const matchesText = (candidate: string): boolean => {
    const trimmed = candidate.trim()
    if (!trimmed) return false
    if (targetTrimmed) return trimmed === targetTrimmed
    return Boolean(targetHash && hashDraftContent(trimmed) === targetHash)
  }

  for (const entry of entries) {
    if (entry.kind === "user_prompt" && (entry as UserPromptEntry).clientRequestId === inFlight.clientRequestId) {
      return true
    }
  }
  for (const item of queuedMessages) {
    if (item.clientRequestId === inFlight.clientRequestId) {
      return true
    }
  }

  const baselineQueueSet = new Set(inFlight.baseline.queueIds)
  let startIndex = 0
  let requireTimestampAfter = false
  if (inFlight.baseline.lastPromptId !== null) {
    const anchorIndex = entries.findIndex(
      (entry) => entry.kind === "user_prompt" && entry._id === inFlight.baseline.lastPromptId,
    )
    if (anchorIndex >= 0) {
      startIndex = anchorIndex + 1
    } else if (hasOlderHistory) {
      // The pre-send prompt fell off the 200-entry tail window; every row in
      // this newer window is strictly after the pre-send cursor.
      startIndex = 0
    } else {
      requireTimestampAfter = true
      startIndex = 0
    }
  }

  for (let index = startIndex; index < entries.length; index += 1) {
    const entry = entries[index]
    if (!entry || entry.kind !== "user_prompt") continue
    if (baselineQueueSet.has(entry._id)) continue
    if (
      requireTimestampAfter &&
      inFlight.baseline.lastPromptCreatedAt !== null &&
      entry.createdAt <= inFlight.baseline.lastPromptCreatedAt
    ) {
      continue
    }
    const prompt = entry as UserPromptEntry
    if (matchesText(prompt.participantContent ?? prompt.content)) return true
  }

  for (const item of queuedMessages) {
    if (baselineQueueSet.has(item.id)) continue
    if (matchesText(item.content)) return true
  }

  return false
}

let csprngUuidGenerator: (() => string) | null = null

/** Register a native CSPRNG UUIDv4 provider (e.g. `expo-crypto`'s `randomUUID`
 * on Hermes, where `globalThis.crypto` is absent). */
export function registerClientRequestIdGenerator(generator: (() => string) | null): void {
  csprngUuidGenerator = generator
}

export function createClientRequestId(): string {
  if (csprngUuidGenerator) {
    return csprngUuidGenerator()
  }
  const cryptoObj = (globalThis as {
    crypto?: { randomUUID?: () => string; getRandomValues?: (array: Uint8Array) => Uint8Array }
  }).crypto
  if (typeof cryptoObj?.randomUUID === "function") {
    return cryptoObj.randomUUID()
  }
  if (typeof cryptoObj?.getRandomValues === "function") {
    const bytes = cryptoObj.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6]! & 0x0f) | 0x40
    bytes[8] = (bytes[8]! & 0x3f) | 0x80
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === "x" ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/** Reuse the stored idempotency key ONLY for pure retries of identical trimmed
 * content and compatible follow-up mode (switching queue <-> steer mints a fresh key). */
export function resolveSendClientRequestId(
  content: string,
  pendingRetry: PendingRetryKey | null,
  optionsOrGenerateId?:
    | (() => string)
    | { action?: SendRetryAction; generateId?: () => string },
): string {
  const generateId =
    typeof optionsOrGenerateId === "function"
      ? optionsOrGenerateId
      : optionsOrGenerateId?.generateId ?? createClientRequestId
  const action = typeof optionsOrGenerateId === "function" ? undefined : optionsOrGenerateId?.action
  const trimmed = content.trim()
  if (pendingRetry && pendingRetry.clientRequestId.trim()) {
    const contentMatches = pendingRetry.content
      ? pendingRetry.content === trimmed
      : Boolean(pendingRetry.contentHash && trimmed && hashDraftContent(trimmed) === pendingRetry.contentHash)
    const actionConflicts =
      (action === "queue" && pendingRetry.action === "steer") ||
      (action === "steer" && pendingRetry.action === "queue")
    const actionMatches =
      action === undefined ||
      pendingRetry.action === undefined ||
      !actionConflicts
    if (contentMatches && actionMatches) {
      return pendingRetry.clientRequestId
    }
  }
  return generateId()
}

/** Editing the draft text away from the unacked content clears the retry key
 * so modified content always sends under a fresh idempotency key. */
export function applyDraftEdit(
  state: PersistedDraftState,
  nextDraft: string,
): PersistedDraftState {
  const trimmed = nextDraft.trim()
  const keepRetry = Boolean(
    state.pendingRetry &&
      (state.pendingRetry.content
        ? trimmed === state.pendingRetry.content
        : Boolean(state.pendingRetry.contentHash && trimmed && hashDraftContent(trimmed) === state.pendingRetry.contentHash)),
  )
  return normalizePersistedDraftState({
    ...state,
    draft: nextDraft,
    pendingRetry: keepRetry ? state.pendingRetry : null,
    sendError: null,
  })
}

/** Record an in-flight unacked send separately from the visible composer draft. */
export function applyStartInFlightSend(
  state: PersistedDraftState,
  inFlightSend: InFlightSendState,
): PersistedDraftState {
  return normalizePersistedDraftState({
    ...state,
    draft: "",
    pendingRetry: null,
    sendError: null,
    inFlightSend,
  })
}

/** Remove an in-flight send record without touching any newer visible draft. */
export function clearInFlightSendState(
  state: PersistedDraftState,
  clientRequestId?: string,
): PersistedDraftState {
  if (!state.inFlightSend) return state
  if (clientRequestId && state.inFlightSend.clientRequestId !== clientRequestId) return state
  return normalizePersistedDraftState({
    draft: state.draft,
    pendingRetry: state.pendingRetry,
    sendError: state.sendError,
    pendingRestoredCommand: state.pendingRestoredCommand,
    pendingDequeueRestore: state.pendingDequeueRestore,
  })
}

/** Restore an unacked or failed send into the composer. Preserves the retry key
 * ONLY when the composer was empty (so retrying sends identical content); if
 * the user already started typing another draft:
 * - For slash commands (`/...`), never merge into the nonempty composer (owner
 *   decision 2B — merging would submit the user's draft as command arguments);
 *   preserve `state.draft` untouched and surface `failedContent` in
 *   `pendingRestoredCommand`.
 * - For ordinary text, concatenate and clear the retry key because the merged
 *   body is new content. */
export function applyFailedSendRestore(
  state: PersistedDraftState,
  failedContent: string,
  errorMessage: string,
  clientRequestId?: string,
  action?: SendRetryAction,
): PersistedDraftState {
  const trimmed = failedContent.trim()
  if (!state.draft.trim()) {
    return normalizePersistedDraftState({
      ...state,
      draft: failedContent,
      pendingRetry:
        clientRequestId && trimmed
          ? { clientRequestId, content: trimmed, ...(action ? { action } : {}) }
          : null,
      sendError: errorMessage,
    })
  }
  if (failedContent.trimStart().startsWith("/")) {
    return normalizePersistedDraftState({
      ...state,
      pendingRestoredCommand: failedContent,
      sendError: errorMessage,
    })
  }
  return normalizePersistedDraftState({
    ...state,
    draft: `${failedContent}\n\n${state.draft}`,
    pendingRetry: null,
    sendError: errorMessage,
  })
}

/** Reconcile a rehydrated `inFlightSend` against the first received ChatSnapshot
 * on cold start so committed sends never resurrect phantom drafts or armed dedup keys. */
export function reconcileColdStartInFlightSend(
  state: PersistedDraftState,
  entries: readonly TranscriptEntry[],
  queuedMessages: readonly QueuedChatMessage[],
  hasOlderHistory = false,
): { state: PersistedDraftState; reconciled: boolean; committed: boolean } {
  const inFlight = state.inFlightSend
  if (!inFlight) return { state, reconciled: false, committed: false }
  const withoutInFlight = clearInFlightSendState(state, inFlight.clientRequestId)
  if (wasInFlightSendCommittedInSnapshot(inFlight, entries, queuedMessages, hasOlderHistory)) {
    const clearStaleRetry = withoutInFlight.pendingRetry?.clientRequestId === inFlight.clientRequestId
    const next = normalizePersistedDraftState({
      ...withoutInFlight,
      pendingRetry: clearStaleRetry ? null : withoutInFlight.pendingRetry,
      sendError: clearStaleRetry ? null : withoutInFlight.sendError,
    })
    return { state: next, reconciled: true, committed: true }
  }
  if (inFlight.content.trim()) {
    const errorMessage =
      inFlight.errorMessage ?? "Previous send did not finish before the app closed. Tap send to retry."
    return {
      state: applyFailedSendRestore(
        withoutInFlight,
        inFlight.content,
        errorMessage,
        inFlight.clientRequestId,
        inFlight.action,
      ),
      reconciled: true,
      committed: false,
    }
  }
  // Oversized hash-only fallback (exceeded multi-chunk storage cap): preserve
  // the retry key + contentHash if the composer is empty so pasting the exact
  // same prompt still deduplicates, and surface truthful non-actionable copy.
  const next = normalizePersistedDraftState({
    ...withoutInFlight,
    pendingRetry:
      !withoutInFlight.draft.trim() && inFlight.contentHash
        ? {
            clientRequestId: inFlight.clientRequestId,
            content: "",
            contentHash: inFlight.contentHash,
            action: inFlight.action,
          }
        : withoutInFlight.pendingRetry,
    sendError: OVERSIZED_UNCOMMITTED_SEND_ERROR,
  })
  return { state: next, reconciled: true, committed: false }
}

/** Clear a restored `pendingRetry` draft if a later ChatSnapshot proves the host
 * already committed a `user_prompt` or `queuedMessages` row carrying the exact
 * same `clientRequestId` (e.g. after an >8s offline gap past the live timeout). */
export function reconcilePendingRetryAgainstSnapshot(
  state: PersistedDraftState,
  entries: readonly TranscriptEntry[],
  queuedMessages: readonly QueuedChatMessage[] = [],
): PersistedDraftState {
  const pendingRetry = state.pendingRetry
  if (!pendingRetry?.clientRequestId) return state
  const committed =
    entries.some(
      (entry) =>
        entry.kind === "user_prompt" &&
        (entry as UserPromptEntry).clientRequestId === pendingRetry.clientRequestId,
    ) ||
    queuedMessages.some(
      (item) => item.clientRequestId === pendingRetry.clientRequestId,
    )
  if (!committed) return state
  const trimmedDraft = state.draft.trim()
  const draftUnedited =
    !trimmedDraft ||
    (pendingRetry.content
      ? trimmedDraft === pendingRetry.content
      : Boolean(pendingRetry.contentHash && hashDraftContent(trimmedDraft) === pendingRetry.contentHash))
  return normalizePersistedDraftState({
    ...state,
    draft: draftUnedited ? "" : state.draft,
    pendingRetry: null,
    sendError: draftUnedited ? null : state.sendError,
  })
}

export function applyPendingRestoredCommand(
  state: PersistedDraftState,
  commandContent: string,
): PersistedDraftState {
  return normalizePersistedDraftState({
    ...state,
    pendingRestoredCommand: commandContent,
  })
}

export function clearPendingRestoredCommand(state: PersistedDraftState): PersistedDraftState {
  if (!state.pendingRestoredCommand) return state
  return normalizePersistedDraftState({
    draft: state.draft,
    pendingRetry: state.pendingRetry,
    sendError: state.sendError,
    inFlightSend: state.inFlightSend,
    pendingDequeueRestore: state.pendingDequeueRestore,
  })
}

export function applyStartPendingDequeueRestore(
  state: PersistedDraftState,
  pending: PendingDequeueRestore,
): PersistedDraftState {
  return normalizePersistedDraftState({
    ...state,
    pendingDequeueRestore: pending,
  })
}

export function clearPendingDequeueRestore(
  state: PersistedDraftState,
  queuedMessageId?: string,
): PersistedDraftState {
  if (!state.pendingDequeueRestore) return state
  if (queuedMessageId && state.pendingDequeueRestore.queuedMessageId !== queuedMessageId) return state
  return normalizePersistedDraftState({
    draft: state.draft,
    pendingRetry: state.pendingRetry,
    sendError: state.sendError,
    inFlightSend: state.inFlightSend,
    pendingRestoredCommand: state.pendingRestoredCommand,
  })
}

/** Finalize an expired slash-command restore after `message.dequeue` succeeded
 * or a post-reconnect ChatSnapshot proved the host already removed the row. */
export function completePendingDequeueRestore(
  state: PersistedDraftState,
  queuedMessageId: string,
  content: string,
  mode: PendingDequeueRestore["mode"],
): PersistedDraftState {
  const withoutPending = clearPendingDequeueRestore(state, queuedMessageId)
  if (mode === "replace" || !withoutPending.draft.trim()) {
    return applyRestoredCommandReplace(content, withoutPending)
  }
  return applyPendingRestoredCommand(withoutPending, content)
}

/** Reconcile a persisted `pendingDequeueRestore` after an ambiguous disconnect /
 * unmount / cold restart against the next authoritative `ChatSnapshot.queuedMessages`. */
export function reconcilePendingDequeueRestoreAgainstSnapshot(
  state: PersistedDraftState,
  queuedMessages: readonly QueuedChatMessage[],
): { state: PersistedDraftState; reconciled: boolean; restored: boolean } {
  const pending = state.pendingDequeueRestore
  if (!pending) return { state, reconciled: false, restored: false }
  const stillQueued = queuedMessages.some((item) => item.id === pending.queuedMessageId)
  if (!stillQueued) {
    return {
      state: completePendingDequeueRestore(state, pending.queuedMessageId, pending.content, pending.mode),
      reconciled: true,
      restored: true,
    }
  }
  // Host still holds the expired command row — clear pending restore state so
  // the user can tap Restore again without a later Dismiss restoring stale text.
  return {
    state: clearPendingDequeueRestore(state, pending.queuedMessageId),
    reconciled: true,
    restored: false,
  }
}

interface SerializedInFlightV2 {
  id: string
  c?: string
  ch?: string
  a: SendRetryAction
  lp: string | null
  lt: number | null
  q: string[]
  e?: string
  t: number
}

interface SerializedDequeueRestoreV2 {
  id: string
  c: string
  m: PendingDequeueRestore["mode"]
}

interface SerializedDraftV2 {
  v: 2
  d?: string
  r?: string
  rh?: string
  ra?: SendRetryAction
  e?: string
  f?: SerializedInFlightV2
  p?: string
  dr?: SerializedDequeueRestoreV2
}

function buildSerializedDraftV2(
  state: PersistedDraftState,
  options?: { omitLargeContent?: boolean },
): SerializedDraftV2 | null {
  const omitLarge = Boolean(options?.omitLargeContent)
  const payload: SerializedDraftV2 = { v: 2 }

  if (!omitLarge && state.draft) {
    payload.d = state.draft
  }

  if (state.pendingRetry && state.pendingRetry.clientRequestId.trim()) {
    const trimmedDraft = state.draft.trim()
    const matchesVerbatim = Boolean(state.pendingRetry.content && trimmedDraft === state.pendingRetry.content)
    const hasHash = Boolean(state.pendingRetry.contentHash || state.pendingRetry.content)
    if (!omitLarge && matchesVerbatim) {
      payload.r = state.pendingRetry.clientRequestId.trim()
      if (state.pendingRetry.action) payload.ra = state.pendingRetry.action
    } else if (hasHash && (omitLarge || !state.pendingRetry.content)) {
      payload.r = state.pendingRetry.clientRequestId.trim()
      payload.rh = state.pendingRetry.contentHash ?? hashDraftContent(state.pendingRetry.content)
      if (state.pendingRetry.action) payload.ra = state.pendingRetry.action
    }
  }

  if (state.inFlightSend && state.inFlightSend.clientRequestId.trim()) {
    const f = state.inFlightSend
    const trimmed = f.content.trim()
    const compact: SerializedInFlightV2 = {
      id: f.clientRequestId.trim(),
      a: f.action,
      lp: f.baseline.lastPromptId,
      lt: f.baseline.lastPromptCreatedAt,
      q: f.baseline.queueIds.slice(omitLarge ? -10 : -24),
      t: f.sentAt,
    }
    if (!omitLarge && trimmed) {
      compact.c = trimmed
    } else {
      const digest = f.contentHash ?? (trimmed ? hashDraftContent(trimmed) : "")
      if (digest) compact.ch = digest
    }
    if (f.errorMessage && f.errorMessage.trim()) {
      compact.e = omitLarge ? f.errorMessage.trim().slice(0, 180) : f.errorMessage.trim()
    }
    payload.f = compact
  }

  if (state.pendingRestoredCommand && (!omitLarge || utf8ByteLength(state.pendingRestoredCommand) <= 400)) {
    payload.p = state.pendingRestoredCommand
  }

  if (
    state.pendingDequeueRestore &&
    state.pendingDequeueRestore.queuedMessageId.trim() &&
    state.pendingDequeueRestore.content.trim() &&
    (!omitLarge || utf8ByteLength(state.pendingDequeueRestore.content) <= 400)
  ) {
    payload.dr = {
      id: state.pendingDequeueRestore.queuedMessageId.trim(),
      c: state.pendingDequeueRestore.content,
      m: state.pendingDequeueRestore.mode,
    }
  }

  if (omitLarge && payload.r && !payload.d && !payload.f) {
    payload.e = OVERSIZED_UNCOMMITTED_SEND_ERROR
  } else if (state.sendError && state.sendError.trim()) {
    if (!omitLarge || payload.r || payload.f || payload.p || payload.dr) {
      payload.e = omitLarge ? state.sendError.trim().slice(0, 180) : state.sendError.trim()
    }
  }

  if (!payload.d && !payload.r && !payload.e && !payload.f && !payload.p && !payload.dr) return null
  return payload
}

/** Compact serialization that never duplicates `draft` text inside `pendingRetry`. */
export function serializePersistedDraftState(state: PersistedDraftState): string | null {
  const payload = buildSerializedDraftV2(state)
  return payload ? JSON.stringify(payload) : null
}

/** Serialize for `expo-secure-store` within its per-entry byte ceiling. If the
 * full draft exceeds `maxBytes`, falls back to a compact hash-only metadata
 * payload so `clientRequestId` and cold-start reconciliation still survive. */
export function serializePersistedDraftStateForStorage(
  state: PersistedDraftState,
  maxBytes = MAX_SECURE_STORE_DRAFT_BYTES,
): string | null {
  const full = serializePersistedDraftState(state)
  if (!full) return null
  if (utf8ByteLength(full) <= maxBytes) return full
  const compact = buildSerializedDraftV2(state, { omitLargeContent: true })
  if (!compact) return null
  let encoded = JSON.stringify(compact)
  if (utf8ByteLength(encoded) <= maxBytes) return encoded
  delete compact.p
  delete compact.dr
  delete compact.e
  if (compact.f) {
    delete compact.f.e
    compact.f.q = compact.f.q.slice(-6)
  }
  encoded = JSON.stringify(compact)
  return utf8ByteLength(encoded) <= maxBytes ? encoded : null
}

export function parsePersistedDraftState(raw: string | null | undefined): PersistedDraftState | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null

    if (parsed.v === 2) {
      const v2 = parsed as Partial<SerializedDraftV2>
      const draft = typeof v2.d === "string" ? v2.d : ""
      const retryId = typeof v2.r === "string" && v2.r.trim() ? v2.r.trim() : null
      const retryHash = typeof v2.rh === "string" && v2.rh.trim() ? v2.rh.trim() : null
      const retryAction = isValidSendRetryAction(v2.ra) ? v2.ra : undefined
      let pendingRetry: PendingRetryKey | null = null
      if (retryId) {
        if (draft.trim() && !retryHash) {
          pendingRetry = {
            clientRequestId: retryId,
            content: draft.trim(),
            ...(retryAction ? { action: retryAction } : {}),
          }
        } else if (retryHash) {
          pendingRetry = {
            clientRequestId: retryId,
            content: "",
            contentHash: retryHash,
            ...(retryAction ? { action: retryAction } : {}),
          }
        }
      }
      const sendError = typeof v2.e === "string" && v2.e.trim() ? v2.e : null
      let inFlightSend: InFlightSendState | null = null
      if (v2.f && typeof v2.f === "object" && !Array.isArray(v2.f)) {
        const f = v2.f as Partial<SerializedInFlightV2>
        const id = typeof f.id === "string" && f.id.trim() ? f.id.trim() : null
        const c = typeof f.c === "string" ? f.c.trim() : ""
        const ch = typeof f.ch === "string" && f.ch.trim() ? f.ch.trim() : undefined
        if (id && (c || ch)) {
          inFlightSend = {
            clientRequestId: id,
            content: c,
            ...(ch ? { contentHash: ch } : {}),
            action: isValidSendRetryAction(f.a) ? f.a : "send",
            baseline: {
              lastPromptId: typeof f.lp === "string" ? f.lp : null,
              lastPromptCreatedAt: typeof f.lt === "number" && Number.isFinite(f.lt) ? f.lt : null,
              queueIds: Array.isArray(f.q) ? f.q.filter((item): item is string => typeof item === "string") : [],
            },
            ...(typeof f.e === "string" && f.e.trim() ? { errorMessage: f.e.trim() } : {}),
            sentAt: typeof f.t === "number" && Number.isFinite(f.t) ? f.t : 0,
          }
        }
      }
      const pendingRestoredCommand =
        typeof v2.p === "string" && v2.p.trim() ? v2.p : null
      let pendingDequeueRestore: PendingDequeueRestore | null = null
      if (v2.dr && typeof v2.dr === "object" && !Array.isArray(v2.dr)) {
        const dr = v2.dr as Partial<SerializedDequeueRestoreV2>
        if (
          typeof dr.id === "string" &&
          dr.id.trim() &&
          typeof dr.c === "string" &&
          dr.c.trim() &&
          isValidDequeueRestoreMode(dr.m)
        ) {
          pendingDequeueRestore = {
            queuedMessageId: dr.id.trim(),
            content: dr.c,
            mode: dr.m,
          }
        }
      }
      const state = normalizePersistedDraftState({
        draft,
        pendingRetry,
        sendError,
        inFlightSend,
        pendingRestoredCommand,
        pendingDequeueRestore,
      })
      return isDraftStateEmpty(state) ? null : state
    }

    // Backwards-compatible parser for legacy v1 entries.
    const legacy = parsed as Partial<PersistedDraftState>
    const draft = typeof legacy.draft === "string" ? legacy.draft : ""
    const retryCandidate = legacy.pendingRetry
    const pendingRetry =
      retryCandidate &&
      typeof retryCandidate === "object" &&
      typeof retryCandidate.clientRequestId === "string" &&
      retryCandidate.clientRequestId.trim().length > 0 &&
      typeof retryCandidate.content === "string" &&
      retryCandidate.content.trim().length > 0 &&
      draft.trim() === retryCandidate.content.trim()
        ? {
            clientRequestId: retryCandidate.clientRequestId.trim(),
            content: retryCandidate.content.trim(),
            ...(isValidSendRetryAction(retryCandidate.action) ? { action: retryCandidate.action } : {}),
          }
        : null
    const sendError = typeof legacy.sendError === "string" && legacy.sendError.trim() ? legacy.sendError : null
    if (!draft && !pendingRetry && !sendError) return null
    return { draft, pendingRetry, sendError }
  } catch {
    return null
  }
}

export function isStaleNativeCommandRestore(message: QueuedChatMessage): boolean {
  return message.rejection === "stale_native_command" && message.content.trim().length > 0
}

export function shouldConfirmStaleCommandRestore(
  message: QueuedChatMessage,
  currentDraft: string,
): boolean {
  return isStaleNativeCommandRestore(message) && currentDraft.trim().length > 0
}

export function applyRestoredCommandReplace(
  commandContent: string,
  existingState?: PersistedDraftState,
): PersistedDraftState {
  return normalizePersistedDraftState({
    draft: commandContent,
    pendingRetry: null,
    sendError: null,
    ...(existingState?.inFlightSend ? { inFlightSend: existingState.inFlightSend } : {}),
    ...(existingState?.pendingDequeueRestore ? { pendingDequeueRestore: existingState.pendingDequeueRestore } : {}),
  })
}

/** Append live entries without dropping rows that fall out of the host's
 * 200-message sliding subscription window. Existing rows are replaced so hidden
 * corrections/redactions still propagate. */
export function mergeTranscriptEntries(
  first: readonly TranscriptEntry[],
  second: readonly TranscriptEntry[],
): TranscriptEntry[] {
  const merged = [...first]
  const positions = new Map(merged.map((entry, index) => [entry._id, index]))
  for (const entry of second) {
    const existing = positions.get(entry._id)
    if (existing == null) {
      positions.set(entry._id, merged.length)
      merged.push(entry)
    } else {
      merged[existing] = entry
    }
  }
  return merged
}

/** True when a live ChatSnapshot can update transcript + runtime status
 * synchronously in a single atomic render without awaiting `chat.loadHistory`. */
export function canApplySnapshotSynchronously(
  knownEntries: readonly TranscriptEntry[],
  incomingMessages: readonly TranscriptEntry[],
  hasPendingBackfill: boolean,
): boolean {
  if (hasPendingBackfill) return false
  if (knownEntries.length === 0 || incomingMessages.length === 0) return true
  const anchorId = knownEntries[knownEntries.length - 1]?._id
  if (!anchorId) return true
  return incomingMessages.some((entry) => entry._id === anchorId)
}
