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
}

export interface OpenTransferGate {
  transferId: string
  count: number
  scanning: boolean
  suggestions: MemoryTransferSuggestionSummary[]
}

export interface OpenCheckupGate {
  checkupId: string
  count: number
  scanning: boolean
  waiting: boolean
  suggestions: MemoryCheckupSuggestionSummary[]
}

export interface MemoryGateState {
  pendingPreviewId: string | null
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
 */
export function deriveMemoryGateState(entries: TranscriptEntry[]): MemoryGateState {
  const previewDecisions = new Map<string, string>()
  const previewMemoriesById = new Map<string, Array<{ id: string; content: string; scope: string }>>()
  const proposalsDecisions = new Map<string, string>()
  const proposalsResults = new Map<string, Array<{ id: string }>>()
  const transferDecisions = new Map<string, string>()
  const transferResults = new Map<string, MemoryTransferSuggestionSummary[]>()
  const transferResultsDone = new Set<string>()
  const checkupDecisions = new Map<string, string>()
  const checkupResults = new Map<string, MemoryCheckupSuggestionSummary[]>()
  const checkupResetStates = new Map<string, "waiting" | "pending">()

  for (const entry of entries) {
    switch (entry.kind) {
      case "memory_preview": {
        const preview = entry as MemoryPreviewEntry
        if (preview.memories) previewMemoriesById.set(preview.previewId, preview.memories)
        break
      }
      case "memory_preview_update": {
        const update = entry as MemoryPreviewUpdateEntry
        previewMemoriesById.set(update.previewId, update.memories)
        break
      }
      case "memory_preview_decision": {
        const decision = entry as MemoryPreviewDecisionEntry
        previewDecisions.set(decision.previewId, decision.decision)
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
      case "memory_transfer_result": {
        const result = entry as MemoryTransferResultEntry
        transferResults.set(result.transferId, result.suggestions)
        if (result.done) transferResultsDone.add(result.transferId)
        break
      }
      case "memory_transfer_decision": {
        const decision = entry as MemoryTransferDecisionEntry
        transferDecisions.set(decision.transferId, decision.decision)
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
        }
        break
      }
    }
  }

  let pendingPreviewId: string | null = null
  const openProposalsById = new Map<string, OpenProposalsGate>()
  const openTransfersById = new Map<string, OpenTransferGate>()
  const openCheckupsById = new Map<string, OpenCheckupGate>()

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
      if (pendingPreviewId === null && !previewDecisions.has(preview.previewId)) {
        pendingPreviewId = preview.previewId
      }
    } else if (entry.kind === "memory_proposals") {
      const proposals = entry as MemoryProposalsEntry
      if (!proposalsDecisions.has(proposals.proposalsId) && !openProposalsById.has(proposals.proposalsId)) {
        const candidates = proposalsResults.get(proposals.proposalsId) ?? proposals.candidates ?? []
        const scanning = Boolean(proposals.pending && !proposalsResults.has(proposals.proposalsId))
        openProposalsById.set(proposals.proposalsId, {
          proposalsId: proposals.proposalsId,
          count: candidates.length,
          scanning,
        })
      }
    } else if (entry.kind === "memory_transfer") {
      const transfer = entry as MemoryTransferEntry
      if (!transferDecisions.has(transfer.transferId) && !openTransfersById.has(transfer.transferId)) {
        const suggestions = transferResults.get(transfer.transferId) ?? transfer.suggestions ?? []
        const scanning = Boolean(transfer.pending && !transferResultsDone.has(transfer.transferId))
        openTransfersById.set(transfer.transferId, {
          transferId: transfer.transferId,
          count: suggestions.length,
          scanning,
          suggestions,
        })
      }
    } else if (entry.kind === "memory_checkup") {
      const checkup = entry as MemoryCheckupEntry
      if (!checkupDecisions.has(checkup.checkupId) && !openCheckupsById.has(checkup.checkupId)) {
        const resetState = checkupResetStates.get(checkup.checkupId)
        const suggestions = checkupResults.get(checkup.checkupId) ?? []
        const scanning = Boolean(
          resetState === "pending" ||
            (resetState === undefined && checkup.pending && !checkupResults.has(checkup.checkupId)),
        )
        const waiting = resetState === "waiting"
        openCheckupsById.set(checkup.checkupId, {
          checkupId: checkup.checkupId,
          count: suggestions.length,
          scanning,
          waiting,
          suggestions,
        })
      }
    }

    if (entry.kind === "user_prompt") {
      break
    }
  }

  const hasOpenGate =
    pendingPreviewId !== null ||
    openProposalsById.size > 0 ||
    openTransfersById.size > 0 ||
    openCheckupsById.size > 0

  const hasParkedGate =
    pendingPreviewId !== null ||
    [...openProposalsById.values()].some((gate) => !gate.scanning) ||
    [...openTransfersById.values()].some((gate) => !gate.scanning) ||
    [...openCheckupsById.values()].some((gate) => !gate.scanning && !gate.waiting)

  return {
    pendingPreviewId,
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
): boolean {
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
