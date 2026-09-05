import type {
  AgentProvider,
  ChatAttachment,
  HydratedTranscriptMessage,
  MemoryCheckupKind,
  MemoryCheckupSuggestionSnapshot,
  MemoryTransferSuggestionSnapshot,
  ModelOptions,
  TranscriptEntry,
} from "../../shared/types"
import { createHash } from "node:crypto"
import type { DeliveredFocusEvent } from "../experiment/logger"
import type {
  StudyOpeningAttachmentSnapshot,
  StudyOpeningAttachmentSnapshotStore,
} from "../study-opening-attachments"

type TransferMessage = Extract<HydratedTranscriptMessage, { kind: "memory_transfer" }>
type CheckupMessage = Extract<HydratedTranscriptMessage, { kind: "memory_checkup" }>

export interface MemoryBoardGateSnapshot {
  chatId: string
  projectId?: string
  gateId: string
  unresolved: number
  message: TransferMessage | CheckupMessage
}

export interface MemoryBoardBacklogSnapshot {
  transfers: MemoryBoardGateSnapshot[]
  checkups: MemoryBoardGateSnapshot[]
}

export interface MemoryBoardPendingCounts {
  candidates: number
  transfers: number
  checkups: number
  total: number
}

export interface MemoryBoardReviewState {
  reviewed: boolean
  pending: MemoryBoardPendingCounts
  backlog: MemoryBoardBacklogSnapshot
  openingPrompt?: MemoryBoardOpeningPromptState
}

export type MemoryBoardOpeningPromptPhase =
  | "dispatch_pending"
  | "preparing"
  | "long_term_ready"
  | "completed"

export interface MemoryBoardOpeningPromptState {
  taskId: string
  chatId: string
  reviewId: string
  phase: MemoryBoardOpeningPromptPhase
  /** One-way binding for clearing only the exact locally restored draft. */
  promptHash?: string
}

export interface MemoryBoardOpeningPromptBookkeeping {
  participantPromptRecorded: boolean
  turnStarted: boolean
}

export type MemoryBoardOpeningCompletionOutcome = "completed" | "invalidated"

export interface MemoryBoardOpeningPromptInput {
  taskId: string
  chatId: string
  reviewId: string
  content: string
  attachments?: unknown[]
  /** Private server admission evidence; never accepted from the browser. */
  attachmentSnapshots?: StudyOpeningAttachmentSnapshot[]
  dispatch?: {
    provider?: AgentProvider
    model?: string
    modelOptions?: ModelOptions
    effort?: string
    planMode?: boolean
  }
}

/** Private server recovery payload. `reviewState` deliberately exposes only
 * the state machine identity and never echoes participant prompt content. */
export interface MemoryBoardOpeningPromptRecovery extends MemoryBoardOpeningPromptState {
  content: string
  attachments: ChatAttachment[]
  /** Only these immutable paths may cross the provider boundary. */
  providerAttachments: ChatAttachment[]
  attachmentFailure?: string
  dispatch?: MemoryBoardOpeningPromptInput["dispatch"]
  providerDispatch?: MemoryBoardOpeningProviderDispatch
  longTermRevision?: number
}

export type MemoryBoardOpeningProviderDecision = "go_on" | "without_memory"
export type MemoryBoardOpeningProviderDispatchPhase = "dispatching" | "delivered" | "failed"

export interface MemoryBoardOpeningProviderDispatch {
  previewId: string
  decision: MemoryBoardOpeningProviderDecision
  phase: MemoryBoardOpeningProviderDispatchPhase
  /** Exact measurement receipt reserved before the provider accepts the prompt. */
  focusDelivery?: DeliveredFocusEvent
}

export interface MemoryBoardOpeningProviderDispatchInput extends MemoryBoardOpeningPromptState {
  previewId: string
  decision: MemoryBoardOpeningProviderDecision
  focusDelivery?: DeliveredFocusEvent
}

export interface MemoryBoardOpeningPromptAttempt extends MemoryBoardOpeningPromptInput {
  channel: string
}

interface BoardResolutionBase {
  taskId: string
  chatId: string
  gateId: string
}

export type MemoryBoardResolution =
  | (BoardResolutionBase & { kind: "transfer"; sourceId: string })
  | (BoardResolutionBase & {
      kind: "checkup"
      suggestionKind: MemoryCheckupKind
      memoryId: string
      otherMemoryId?: string
    })

export type MemoryBoardTransferResolution = Extract<MemoryBoardResolution, { kind: "transfer" }>

export interface MemoryBoardTrustedTransfer {
  chatId: string
  projectId?: string
  destinationContextKey: string
  suggestion: MemoryTransferSuggestionSnapshot
}

export type MemoryBoardTransferAdmission =
  | { pending: true; trusted: MemoryBoardTrustedTransfer }
  | { pending: false; resultId?: string }

export interface MemoryBoardBacklogService {
  snapshot: () => MemoryBoardBacklogSnapshot
  reviewState: (taskId: string) => MemoryBoardReviewState
  completeReview: (taskId: string) => { completed: boolean; state: MemoryBoardReviewState }
  promptRefusal: (taskId: string, attempt?: MemoryBoardOpeningPromptAttempt) => string | null
  /** Atomically names the exact first message whose full Long-term review owns the opening Board. */
  prepareOpeningPrompt: (input: MemoryBoardOpeningPromptInput) => MemoryBoardOpeningPromptState
  /** Trusted exact payload used only to re-prime an interrupted server process. */
  recoverOpeningPrompt: (taskId: string) => MemoryBoardOpeningPromptRecovery | null
  /** Claims the single server dispatch. Same exact retry is acknowledged without a second turn. */
  claimOpeningPromptDispatch: (input: MemoryBoardOpeningPromptInput) => "claimed" | "duplicate"
  /** Durable reconciliation flags for effects that follow the transcript append. */
  openingPromptBookkeeping: (
    input: Pick<MemoryBoardOpeningPromptState, "taskId" | "chatId" | "reviewId">,
  ) => MemoryBoardOpeningPromptBookkeeping
  markOpeningPromptBookkeeping: (
    input: Pick<MemoryBoardOpeningPromptState, "taskId" | "chatId" | "reviewId">,
    completed: Partial<MemoryBoardOpeningPromptBookkeeping>,
  ) => void
  /** Marks Candidate → Transfer → Checkup settled; Working Memory still waits for Continue. */
  markOpeningPromptLongTermReady: (input: MemoryBoardOpeningPromptState) => void
  /** Server-owned barrier between Long-term review and the separate Working Memory surface. */
  waitForOpeningPromptCompletion: (input: MemoryBoardOpeningPromptState) => Promise<MemoryBoardOpeningCompletionOutcome>
  /** Final explicit Continue boundary for the exact prepared prompt. */
  completeOpeningPromptReview: (input: MemoryBoardOpeningPromptState) => {
    completed: boolean
    state: MemoryBoardReviewState
  }
  /** Durable pre-provider linearization. A recovered `dispatching` state is ambiguous and must not resend. */
  claimOpeningProviderDispatch: (input: MemoryBoardOpeningProviderDispatchInput) =>
    "claimed" | MemoryBoardOpeningProviderDispatchPhase
  /** Durable provider acceptance or fail-closed terminal for that exact Working Memory decision. */
  settleOpeningProviderDispatch: (
    input: MemoryBoardOpeningProviderDispatchInput,
    outcome: "delivered" | "failed",
  ) => void
  /** Whether mutation should run, or the durable result of an earlier attempt. */
  assertPending: (input: MemoryBoardResolution) => { pending: true } | { pending: false; resultId?: string }
  /** The transcript-owned destination and immutable Transfer snapshot. */
  assertTransferPending: (input: MemoryBoardTransferResolution) => MemoryBoardTransferAdmission
  /** Persist a line-level receipt after the corresponding mutation succeeds. */
  resolve: (input: MemoryBoardResolution, outcome?: { resultId?: string }) => void
}

interface BoardTranscript {
  listChats: () => Array<{ id: string; projectId?: string }>
  getMessages: (chatId: string) => TranscriptEntry[]
  getChat: (chatId: string) => { projectId?: string } | null
}

interface BoardReceiptStore {
  getKv: <T>(key: string) => T | null
  setKv: (key: string, value: unknown) => void
  setKvBatch: (entries: ReadonlyArray<readonly [key: string, value: unknown]>) => void
}

interface MemoryBoardOpeningPromptRecord extends MemoryBoardOpeningPromptState {
  promptHash: string
  /** CAS binding for the exact Visible Memory Pool whose downstream gates settled. */
  longTermReadyHash?: string
  /** Candidates explicitly deferred by this opening review, bound to their
   * exact state so a later/external mutation cannot inherit the exemption. */
  deferredCandidates?: Array<{ id: string; dependencyHash: string }>
  /** Transfer/Checkup rows explicitly skipped by this exact opening review.
   * The owner and occurrence identity prevent another gate or a later row
   * with the same semantic key from inheriting the exemption. */
  deferredBacklogRows?: Array<{
    semanticKey: string
    chatId: string
    gateId: string
    occurrenceAt: number
  }>
  /** Increments only when a ready dependency CAS fails; retries reuse this lineage. */
  longTermRevision?: number
  content: string
  attachments: unknown[]
  attachmentSnapshots?: StudyOpeningAttachmentSnapshot[]
  providerPromptHash?: string
  dispatch?: MemoryBoardOpeningPromptInput["dispatch"]
  providerDispatch?: MemoryBoardOpeningProviderDispatch
  bookkeeping?: MemoryBoardOpeningPromptBookkeeping
  createdAt: string
  updatedAt: string
}

const openingPromptKey = (taskId: string) => `opening_prompt_review:v1:${encodeURIComponent(taskId)}`

function isChatAttachment(value: unknown): value is ChatAttachment {
  if (!value || typeof value !== "object") return false
  const attachment = value as Partial<ChatAttachment>
  return typeof attachment.id === "string"
    && typeof attachment.kind === "string"
    && typeof attachment.displayName === "string"
    && typeof attachment.absolutePath === "string"
    && typeof attachment.relativePath === "string"
    && typeof attachment.contentUrl === "string"
    && typeof attachment.mimeType === "string"
    && typeof attachment.size === "number"
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

export function hashMemoryBoardOpeningPrompt(input: Pick<MemoryBoardOpeningPromptInput, "content" | "attachments">): string {
  return createHash("sha256")
    .update(canonicalJson({ content: input.content, attachments: input.attachments ?? [] }))
    .digest("hex")
}

interface BoardMemoryItem {
  id: string
  status: string
  version: number
  createdAt: string
  content?: string
  detail?: string
  scope?: string
  type?: string
  topic?: string
  abstractionLevel?: string
  sensitive?: boolean
  projectId?: string
  sessionId?: string
}

interface BoardMemoryState {
  getById: (id: string) => BoardMemoryItem | null
  getEvents: (id: string) => Array<{ ts: string; kind: string }>
  list: () => BoardMemoryItem[]
  getRelations: (id: string) => Array<{ type: string; targetId: string }>
  hasOpenRevision: (id: string) => boolean
  getSessionExclusions?: (sessionId: string) => string[]
}

interface ResolutionReceipt {
  taskId: string
  chatId: string
  gateId: string
  throughCreatedAt: number
  resolvedAt: string
  outcome: "resolved" | "invalidated"
  reason?: string
  resultId?: string
}

interface SemanticRowBase {
  semanticKey: string
  chatId: string
  projectId?: string
  gateId: string
  occurrenceAt: number
  observedAt: number
  decision: "handled" | "skipped"
  parent: TranscriptEntry
}

interface TransferRow extends SemanticRowBase {
  kind: "transfer"
  suggestion: MemoryTransferSuggestionSnapshot
}

interface CheckupRow extends SemanticRowBase {
  kind: "checkup"
  suggestion: MemoryCheckupSuggestionSnapshot
  failedKinds?: MemoryCheckupKind[]
}

type SemanticRow = TransferRow | CheckupRow

const RECEIPT_PREFIX = "board_backlog_resolution:v1:"

function baseMessage(entry: TranscriptEntry) {
  return {
    id: entry._id,
    timestamp: new Date(entry.createdAt).toISOString(),
    ...(entry.messageId ? { messageId: entry.messageId } : {}),
    ...(entry.hidden ? { hidden: true } : {}),
  }
}

function transferSemanticKey(projectId: string | undefined, chatId: string, sourceId: string): string {
  return `transfer:${projectId ?? `chat:${chatId}`}:${sourceId}`
}

function normalizedPair(memoryId: string, otherMemoryId?: string): string {
  return otherMemoryId ? [memoryId, otherMemoryId].sort().join(":") : memoryId
}

function checkupSemanticKey(suggestion: Pick<MemoryCheckupSuggestionSnapshot, "kind" | "memoryId" | "otherMemoryId">): string {
  return `checkup:${suggestion.kind}:${normalizedPair(suggestion.memoryId, suggestion.otherMemoryId)}`
}

function semanticKey(input: MemoryBoardResolution, projectId?: string): string {
  return input.kind === "transfer"
    ? transferSemanticKey(projectId, input.chatId, input.sourceId)
    : checkupSemanticKey({
        kind: input.suggestionKind,
        memoryId: input.memoryId,
        otherMemoryId: input.otherMemoryId,
      })
}

function receiptKey(key: string): string {
  return `${RECEIPT_PREFIX}${encodeURIComponent(key)}`
}

function latestById<T extends TranscriptEntry>(entries: T[], idOf: (entry: T) => string): Map<string, T> {
  const latest = new Map<string, T>()
  for (const entry of entries) latest.set(idOf(entry), entry)
  return latest
}

function collectRows(transcript: BoardTranscript, assignedProjectIds: ReadonlySet<string>): SemanticRow[] {
  const rows: SemanticRow[] = []
  for (const chat of transcript.listChats()) {
    if (!chat.projectId || !assignedProjectIds.has(chat.projectId)) continue
    const messages = transcript.getMessages(chat.id)
    const projectId = transcript.getChat(chat.id)?.projectId ?? chat.projectId

    const transferParents = messages.filter(
      (entry): entry is Extract<TranscriptEntry, { kind: "memory_transfer" }> => entry.kind === "memory_transfer",
    )
    const transferResults = latestById(
      messages.filter(
        (entry): entry is Extract<TranscriptEntry, { kind: "memory_transfer_result" }> => entry.kind === "memory_transfer_result",
      ),
      (entry) => entry.transferId,
    )
    const transferDecisions = latestById(
      messages.filter(
        (entry): entry is Extract<TranscriptEntry, { kind: "memory_transfer_decision" }> => entry.kind === "memory_transfer_decision",
      ),
      (entry) => entry.transferId,
    )
    for (const parent of transferParents) {
      const decision = transferDecisions.get(parent.transferId)
      if (decision?.decision !== "skipped" && decision?.decision !== "handled") continue
      const suggestions = transferResults.get(parent.transferId)?.suggestions ?? parent.suggestions
      for (const suggestion of suggestions) {
        if (suggestion.widening) continue
        rows.push({
          kind: "transfer",
          semanticKey: transferSemanticKey(projectId, chat.id, suggestion.sourceId),
          chatId: chat.id,
          projectId,
          gateId: parent.transferId,
          occurrenceAt: decision.createdAt,
          observedAt: transferResults.get(parent.transferId)?.createdAt ?? parent.createdAt,
          decision: decision.decision,
          parent,
          suggestion,
        })
      }
    }

    const checkupParents = messages.filter(
      (entry): entry is Extract<TranscriptEntry, { kind: "memory_checkup" }> => entry.kind === "memory_checkup",
    )
    const checkupResults = latestById(
      messages.filter(
        (entry): entry is Extract<TranscriptEntry, { kind: "memory_checkup_result" }> => entry.kind === "memory_checkup_result",
      ),
      (entry) => entry.checkupId,
    )
    const checkupDecisions = latestById(
      messages.filter(
        (entry): entry is Extract<TranscriptEntry, { kind: "memory_checkup_decision" }> => entry.kind === "memory_checkup_decision",
      ),
      (entry) => entry.checkupId,
    )
    for (const parent of checkupParents) {
      const result = checkupResults.get(parent.checkupId)
      const decision = checkupDecisions.get(parent.checkupId)
      if (!result || (decision?.decision !== "skipped" && decision?.decision !== "handled")) continue
      for (const suggestion of result.suggestions) {
        if (suggestion.kind === "promotion") continue
        rows.push({
          kind: "checkup",
          semanticKey: checkupSemanticKey(suggestion),
          chatId: chat.id,
          projectId,
          gateId: parent.checkupId,
          occurrenceAt: decision.createdAt,
          observedAt: result.createdAt,
          decision: decision.decision,
          parent,
          suggestion,
          ...(result.failedKinds?.length ? { failedKinds: result.failedKinds } : {}),
        })
      }
    }
  }
  return rows
}

function latestSemanticRows(rows: SemanticRow[]): SemanticRow[] {
  const latest = new Map<string, SemanticRow>()
  for (const row of rows.sort((a, b) => a.occurrenceAt - b.occurrenceAt)) {
    latest.set(row.semanticKey, row)
  }
  return [...latest.values()]
}

function projectPendingRows(
  transcript: BoardTranscript,
  receiptStore: BoardReceiptStore,
  memoryState: BoardMemoryState,
  assignedProjectIds: ReadonlySet<string>,
  currentTaskId: string | null,
  onInvalidated?: (input: {
    kind: "transfer" | "checkup"
    chatId: string
    gateId: string
    semanticKey: string
    reason: string
  }) => void,
  persistInvalidations = true,
): SemanticRow[] {
  return latestSemanticRows(collectRows(transcript, assignedProjectIds)).filter((row) => {
    if (row.decision !== "skipped") return false
    const receipt = receiptStore.getKv<ResolutionReceipt>(receiptKey(row.semanticKey))
    if (receipt && receipt.throughCreatedAt >= row.occurrenceAt) return false
    const invalid = invalidReasonFor(row, memoryState, receiptStore)
    if (!invalid) return true
    // Prompt admission is a read-only authority check. It must filter stale
    // rows without turning a refused prompt into a persistence/log side effect.
    if (!persistInvalidations) return false
    receiptStore.setKv(receiptKey(row.semanticKey), {
      taskId: currentTaskId ?? "system",
      chatId: row.chatId,
      gateId: row.gateId,
      throughCreatedAt: row.occurrenceAt,
      resolvedAt: new Date().toISOString(),
      outcome: "invalidated",
      reason: invalid.reason,
      ...(invalid.resultId ? { resultId: invalid.resultId } : {}),
    } satisfies ResolutionReceipt)
    onInvalidated?.({
      kind: row.kind,
      chatId: row.chatId,
      gateId: row.gateId,
      semanticKey: row.semanticKey,
      reason: invalid.reason,
    })
    return false
  })
}

function hasEventAfter(
  memoryState: BoardMemoryState,
  id: string,
  observedAt: number,
  accepts: (kind: string) => boolean = () => true,
): boolean {
  return memoryState.getEvents(id).some((event) => {
    const eventAt = Date.parse(event.ts)
    return Number.isFinite(eventAt)
      && eventAt > observedAt
      && accepts(event.kind)
  })
}

function matchesTransferDestination(
  row: TransferRow,
  item: ReturnType<BoardMemoryState["getById"]> & {},
): boolean {
  if (item.status !== "active") return false
  // The participant may legitimately choose a different scope from the
  // suggestion. Every allowed destination is still bound to this row's
  // trusted project/chat context; unrelated projects/sessions never match.
  if (item.scope === "personal") return true
  if (item.scope === "session") return item.sessionId === row.chatId
  return item.scope === "project" && item.projectId === row.projectId
}

function transferMaterializedAfterSkip(
  row: TransferRow,
  item: ReturnType<BoardMemoryState["getById"]> & {},
  memoryState: BoardMemoryState,
): boolean {
  const createdAt = Date.parse(item.createdAt)
  if (Number.isFinite(createdAt) && createdAt > row.occurrenceAt) return true
  // Reinforce lands into a pre-existing target, so creation time cannot prove
  // causality. Its canonical reinforce event is the post-skip action proof.
  return hasEventAfter(memoryState, item.id, row.occurrenceAt, (kind) => kind === "reinforce")
}

function invalidReasonFor(
  row: SemanticRow,
  memoryState: BoardMemoryState,
  receiptStore: BoardReceiptStore,
): { reason: string; resultId?: string } | null {
  if (row.kind === "transfer") {
    const source = memoryState.getById(row.suggestion.sourceId)
    if (!source || source.status !== "active") return { reason: "source_not_active" }
    if (source.version !== row.suggestion.sourceVersion) return { reason: "source_version_changed" }
    const contextKey = row.projectId ?? row.chatId
    if (receiptStore.getKv(`transfer_declined:${row.suggestion.sourceId}:${contextKey}`) !== null) {
      return { reason: "source_declined" }
    }
    for (const item of memoryState.list()) {
      if (!matchesTransferDestination(row, item)) continue
      if (!transferMaterializedAfterSkip(row, item, memoryState)) continue
      if (memoryState.getRelations(item.id).some(
        (relation) => relation.type === "derived_from" && relation.targetId === row.suggestion.sourceId,
      )) {
        return { reason: "source_already_transferred", resultId: item.id }
      }
    }
    const targetId = row.suggestion.landing?.targetId
    if (targetId && row.suggestion.landing?.targetVersion !== undefined) {
      const target = memoryState.getById(targetId)
      if (!target || target.status !== "active") return { reason: "landing_target_not_active" }
      if (target.version !== row.suggestion.landing.targetVersion) return { reason: "landing_target_version_changed" }
    }
    if (row.suggestion.content === undefined || !row.suggestion.landing) return { reason: "transfer_not_materialized" }
    return null
  }

  const ids = [row.suggestion.memoryId, row.suggestion.otherMemoryId].filter((id): id is string => Boolean(id))
  for (const id of ids) {
    const item = memoryState.getById(id)
    if (!item || item.status !== "active") return { reason: "memory_not_active" }
  }
  if (row.suggestion.kind === "staleness") {
    if (ids.some((id) => memoryState.hasOpenRevision(id))) return { reason: "revision_open" }
    if (ids.some((id) => hasEventAfter(memoryState, id, row.observedAt, (kind) => kind !== "trace"))) {
      return { reason: "memory_freshened" }
    }
    return null
  }
  const [first, second] = ids
  if (first && second) {
    // Checkup's pair detector excludes a pair after ANY direct relation or an
    // open revision, regardless of whether the original lane was Conflict or
    // Redundancy. Mirror that structural eligibility exactly.
    const alreadyRelated = memoryState.getRelations(first).some(
      (relation) => relation.targetId === second,
    ) || memoryState.getRelations(second).some(
      (relation) => relation.targetId === first,
    )
    if (alreadyRelated) return { reason: "pair_already_related" }
    if (memoryState.hasOpenRevision(first) || memoryState.hasOpenRevision(second)) {
      return { reason: "revision_open" }
    }
  }
  const stateChangingKinds = new Set(["edit", "rescope", "promote", "status", "revert"])
  return ids.some((id) => hasEventAfter(memoryState, id, row.observedAt, (kind) => stateChangingKinds.has(kind)))
    ? { reason: "memory_version_changed" }
    : null
}

function toSnapshot(rows: SemanticRow[]): MemoryBoardBacklogSnapshot {
  const transferGroups = new Map<string, TransferRow[]>()
  const checkupGroups = new Map<string, CheckupRow[]>()
  for (const row of rows) {
    const key = `${row.chatId}\0${row.gateId}`
    if (row.kind === "transfer") {
      const group = transferGroups.get(key) ?? []
      group.push(row)
      transferGroups.set(key, group)
    } else {
      const group = checkupGroups.get(key) ?? []
      group.push(row)
      checkupGroups.set(key, group)
    }
  }
  const transfers = [...transferGroups.values()].map((group): MemoryBoardGateSnapshot => {
    const first = group[0]!
    return {
      chatId: first.chatId,
      ...(first.projectId ? { projectId: first.projectId } : {}),
      gateId: first.gateId,
      unresolved: group.length,
      message: {
        ...baseMessage(first.parent),
        kind: "memory_transfer",
        transferId: first.gateId,
        suggestions: group.map((row) => row.suggestion),
        ...(first.parent.kind === "memory_transfer" && first.parent.turn !== undefined ? { turn: first.parent.turn } : {}),
        pending: false,
      },
    }
  })
  const checkups = [...checkupGroups.values()].map((group): MemoryBoardGateSnapshot => {
    const first = group[0]!
    return {
      chatId: first.chatId,
      ...(first.projectId ? { projectId: first.projectId } : {}),
      gateId: first.gateId,
      unresolved: group.length,
      message: {
        ...baseMessage(first.parent),
        kind: "memory_checkup",
        checkupId: first.gateId,
        ...(first.parent.kind === "memory_checkup" && first.parent.turn !== undefined ? { turn: first.parent.turn } : {}),
        pending: false,
        suggestions: group.map((row) => row.suggestion),
        ...(first.failedKinds?.length ? { failedKinds: first.failedKinds } : {}),
      },
    }
  })
  return { transfers, checkups }
}

/**
 * Durable projection of suggestions the participant explicitly skipped in a
 * prior chat gate. The transcript remains the suggestion source of truth;
 * Board receipts only record that one resurfaced row was later handled.
 */
export function createMemoryBoardBacklogService(input: {
  transcript: BoardTranscript
  receiptStore: BoardReceiptStore
  memoryState: BoardMemoryState
  assignedProjectIds: () => ReadonlySet<string>
  currentTaskId?: () => string | null
  /** Exact registered project for a task; prevents another assigned project from claiming its opening prompt. */
  projectIdForTask?: (taskId: string) => string | null
  /** Formal MemoSync-only immutable attachment authority. */
  openingAttachmentSnapshots?: StudyOpeningAttachmentSnapshotStore
  onInvalidated?: (input: {
    kind: "transfer" | "checkup"
    chatId: string
    gateId: string
    semanticKey: string
    reason: string
  }) => void
}): MemoryBoardBacklogService {
  const openingCompletionWaiters = new Map<
    string,
    Set<(outcome: MemoryBoardOpeningCompletionOutcome) => void>
  >()
  const assertOpeningRecord = (
    expected: Pick<MemoryBoardOpeningPromptState, "taskId" | "chatId" | "reviewId">,
  ): MemoryBoardOpeningPromptRecord => {
    const record = input.receiptStore.getKv<MemoryBoardOpeningPromptRecord>(openingPromptKey(expected.taskId))
    if (
      !record
      || record.taskId !== expected.taskId
      || record.chatId !== expected.chatId
      || record.reviewId !== expected.reviewId
    ) {
      throw new Error("The waiting first message no longer owns this opening Memory Board")
    }
    return record
  }
  const writeOpeningRecord = (
    record: MemoryBoardOpeningPromptRecord,
    phase: MemoryBoardOpeningPromptPhase,
  ): MemoryBoardOpeningPromptRecord => {
    const next = { ...record, phase, updatedAt: new Date().toISOString() }
    input.receiptStore.setKv(openingPromptKey(record.taskId), next)
    return next
  }
  const notifyOpeningCompletion = (taskId: string, outcome: MemoryBoardOpeningCompletionOutcome) => {
    const waiters = openingCompletionWaiters.get(taskId)
    openingCompletionWaiters.delete(taskId)
    waiters?.forEach((resolve) => resolve(outcome))
  }
  const openingLongTermDependencyHash = (record: MemoryBoardOpeningPromptRecord): string => {
    const projectId = input.transcript.getChat(record.chatId)?.projectId ?? null
    const exclusions = [...new Set(input.memoryState.getSessionExclusions?.(record.chatId) ?? [])].sort()
    const excluded = new Set(exclusions)
    const items = input.memoryState.list()
      .filter((item) => item.status === "active")
      .filter((item) => {
        if (item.scope === "personal") return true
        if (item.scope === "project") return item.projectId === projectId
        if (item.scope === "session") return item.sessionId === record.chatId
        // Legacy rows without a scope remain in the conservative dependency
        // set instead of silently escaping invalidation.
        return item.scope === undefined
      })
      .filter((item) => !excluded.has(item.id))
      .map((item) => ({
        id: item.id,
        version: item.version,
        content: item.content ?? null,
        detail: item.detail ?? null,
        scope: item.scope ?? null,
        type: item.type ?? null,
        topic: item.topic ?? null,
        abstractionLevel: item.abstractionLevel ?? null,
        sensitive: item.sensitive ?? null,
        projectId: item.projectId ?? null,
        sessionId: item.sessionId ?? null,
        relations: input.memoryState.getRelations(item.id)
          .map((relation) => ({ type: relation.type, targetId: relation.targetId }))
          .sort((left, right) => `${left.type}:${left.targetId}`.localeCompare(`${right.type}:${right.targetId}`)),
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
    return createHash("sha256")
      .update(canonicalJson({ chatId: record.chatId, projectId, exclusions, items }), "utf8")
      .digest("hex")
  }
  const openingCandidateDependencyHash = (item: BoardMemoryItem): string => createHash("sha256")
    .update(canonicalJson({
      id: item.id,
      status: item.status,
      version: item.version,
      createdAt: item.createdAt,
      content: item.content ?? null,
      detail: item.detail ?? null,
      scope: item.scope ?? null,
      type: item.type ?? null,
      topic: item.topic ?? null,
      abstractionLevel: item.abstractionLevel ?? null,
      sensitive: item.sensitive ?? null,
      projectId: item.projectId ?? null,
      sessionId: item.sessionId ?? null,
      openRevision: input.memoryState.hasOpenRevision(item.id),
      relations: input.memoryState.getRelations(item.id)
        .map((relation) => ({ type: relation.type, targetId: relation.targetId }))
        .sort((left, right) => `${left.type}:${left.targetId}`.localeCompare(`${right.type}:${right.targetId}`)),
    }), "utf8")
    .digest("hex")
  const openingDeferredCandidates = (
    record: MemoryBoardOpeningPromptRecord,
  ): Array<{ id: string; dependencyHash: string }> => {
    const messages = input.transcript.getMessages(record.chatId)
    const parent = messages.filter(
      (message): message is Extract<TranscriptEntry, { kind: "memory_proposals" }> =>
        message.kind === "memory_proposals" && message.openingReviewId === record.reviewId,
    ).at(-1)
    if (!parent) return []
    const decision = messages.filter(
      (message): message is Extract<TranscriptEntry, { kind: "memory_proposals_decision" }> =>
        message.kind === "memory_proposals_decision" && message.proposalsId === parent.proposalsId,
    ).at(-1)
    if (decision?.decision !== "skipped") return []
    const result = messages.filter(
      (message): message is Extract<TranscriptEntry, { kind: "memory_proposals_result" }> =>
        message.kind === "memory_proposals_result" && message.proposalsId === parent.proposalsId,
    ).at(-1)
    const candidateIds = [...new Set((result?.candidates ?? parent.candidates).map((candidate) => candidate.id))]
    return candidateIds.flatMap((id) => {
      const item = input.memoryState.getById(id)
      return item?.status === "candidate"
        ? [{ id, dependencyHash: openingCandidateDependencyHash(item) }]
        : []
    })
  }
  const unchangedDeferredCandidateIds = (record: MemoryBoardOpeningPromptRecord | null): Set<string> => {
    if (!record || (record.phase !== "long_term_ready" && record.phase !== "completed")) return new Set()
    return new Set((record.deferredCandidates ?? []).flatMap((deferred) => {
      const item = input.memoryState.getById(deferred.id)
      return item?.status === "candidate"
        && openingCandidateDependencyHash(item) === deferred.dependencyHash
        ? [deferred.id]
        : []
    }))
  }
  const openingDeferredBacklogRows = (
    record: MemoryBoardOpeningPromptRecord,
  ): NonNullable<MemoryBoardOpeningPromptRecord["deferredBacklogRows"]> => latestSemanticRows(
    collectRows(input.transcript, input.assignedProjectIds()).filter((row) => (
      row.decision === "skipped"
      && (row.parent.kind === "memory_transfer" || row.parent.kind === "memory_checkup")
      && row.chatId === record.chatId
      && row.parent.openingReviewId === record.reviewId
    )),
  ).map((row) => ({
    semanticKey: row.semanticKey,
    chatId: row.chatId,
    gateId: row.gateId,
    occurrenceAt: row.occurrenceAt,
  }))
  const deferredBacklogOccurrenceKeys = (record: MemoryBoardOpeningPromptRecord | null): Set<string> => {
    if (!record || (record.phase !== "long_term_ready" && record.phase !== "completed")) return new Set()
    return new Set((record.deferredBacklogRows ?? []).map(
      (row) => `${row.semanticKey}\0${row.chatId}\0${row.gateId}\0${row.occurrenceAt}`,
    ))
  }
  const pendingRows = (persistInvalidations = true) => projectPendingRows(
    input.transcript,
    input.receiptStore,
    input.memoryState,
    input.assignedProjectIds(),
    input.currentTaskId?.() ?? null,
    input.onInvalidated,
    persistInvalidations,
  )
  const findLatestRow = (resolution: MemoryBoardResolution) => {
    const projectId = input.transcript.getChat(resolution.chatId)?.projectId
    const key = semanticKey(resolution, projectId)
    return latestSemanticRows(collectRows(input.transcript, input.assignedProjectIds())).find(
      (row) => row.semanticKey === key && row.chatId === resolution.chatId && row.gateId === resolution.gateId,
    )
  }
  const pendingAdmission = (
    row: SemanticRow,
  ): { pending: true } | { pending: false; resultId?: string } => {
    if (row.decision !== "skipped") return { pending: false }
    const receipt = input.receiptStore.getKv<ResolutionReceipt>(receiptKey(row.semanticKey))
    if (receipt && receipt.throughCreatedAt >= row.occurrenceAt) {
      return { pending: false, ...(receipt.resultId ? { resultId: receipt.resultId } : {}) }
    }
    const invalid = invalidReasonFor(row, input.memoryState, input.receiptStore)
    if (invalid) {
      // Materialize the auditable invalidation receipt using the same path
      // as GET; a retry after mutation-before-receipt is idempotent.
      pendingRows()
      return { pending: false, ...(invalid.resultId ? { resultId: invalid.resultId } : {}) }
    }
    return { pending: true }
  }
  const computeReviewState = (taskId: string, persistInvalidations: boolean): MemoryBoardReviewState => {
    const openingPrompt = input.receiptStore.getKv<MemoryBoardOpeningPromptRecord>(openingPromptKey(taskId))
    const deferredBacklog = deferredBacklogOccurrenceKeys(openingPrompt)
    const backlog = toSnapshot(pendingRows(persistInvalidations).filter(
      (row) => !deferredBacklog.has(
        `${row.semanticKey}\0${row.chatId}\0${row.gateId}\0${row.occurrenceAt}`,
      ),
    ))
    const deferredCandidateIds = unchangedDeferredCandidateIds(openingPrompt)
    const candidates = input.memoryState.list()
      .filter((item) => item.status === "candidate" && !deferredCandidateIds.has(item.id))
      .length
    const transfers = backlog.transfers.reduce((sum, gate) => sum + Math.max(0, gate.unresolved), 0)
    const checkups = backlog.checkups.reduce((sum, gate) => sum + Math.max(0, gate.unresolved), 0)
    return {
      reviewed: input.receiptStore.getKv<boolean>(`board_reviewed:${taskId}`) === true,
      pending: {
        candidates,
        transfers,
        checkups,
        total: candidates + transfers + checkups,
      },
      backlog,
      ...(openingPrompt
        ? {
            openingPrompt: {
              taskId: openingPrompt.taskId,
              chatId: openingPrompt.chatId,
              reviewId: openingPrompt.reviewId,
              phase: openingPrompt.phase,
              promptHash: openingPrompt.promptHash,
            },
          }
        : {}),
    }
  }
  return {
    snapshot: () => toSnapshot(pendingRows()),
    reviewState: (taskId) => computeReviewState(taskId, true),
    completeReview(taskId) {
      const state = computeReviewState(taskId, true)
      if (state.pending.total > 0) return { completed: false, state }
      input.receiptStore.setKv(`board_reviewed:${taskId}`, true)
      return { completed: true, state: { ...state, reviewed: true } }
    },
    prepareOpeningPrompt(openingInput) {
      const activeTaskId = input.currentTaskId?.()
      if (activeTaskId && activeTaskId !== openingInput.taskId) {
        throw new Error("This is not the active study session")
      }
      const chat = input.transcript.getChat(openingInput.chatId)
      if (!chat || (chat.projectId && !input.assignedProjectIds().has(chat.projectId))) {
        throw new Error("The waiting first message does not belong to an assigned study chat")
      }
      const activeProjectId = input.projectIdForTask?.(openingInput.taskId)
      if (input.projectIdForTask && (!activeProjectId || chat.projectId !== activeProjectId)) {
        throw new Error("The waiting first message does not belong to the active study project")
      }
      if (!openingInput.reviewId.trim()) throw new Error("opening review id is required")
      const promptHash = hashMemoryBoardOpeningPrompt(openingInput)
      const existing = input.receiptStore.getKv<MemoryBoardOpeningPromptRecord>(openingPromptKey(openingInput.taskId))
      if (existing) {
        if (
          existing.taskId === openingInput.taskId
          && existing.chatId === openingInput.chatId
          && existing.reviewId === openingInput.reviewId
          && existing.promptHash === promptHash
        ) {
          return {
            taskId: existing.taskId,
            chatId: existing.chatId,
            reviewId: existing.reviewId,
            phase: existing.phase,
            promptHash: existing.promptHash,
          }
        }
        throw new Error("A different first message already owns this task's opening Memory Board")
      }
      const state = computeReviewState(openingInput.taskId, true)
      if (state.pending.total > 0) {
        throw new Error(`${state.pending.total} memory review item${state.pending.total === 1 ? "" : "s"} still need attention`)
      }
      if (state.reviewed) {
        throw new Error("This task's opening Memory Board was already completed")
      }
      const attachments = openingInput.attachments ?? []
      if (!attachments.every(isChatAttachment)) {
        throw new Error("The waiting first message contains an invalid attachment")
      }
      let providerPromptHash: string | undefined
      if (input.openingAttachmentSnapshots) {
        const snapshots = openingInput.attachmentSnapshots ?? []
        if (
          snapshots.length !== attachments.length
          || snapshots.some((snapshot, index) => snapshot.attachmentId !== attachments[index]!.id)
        ) {
          throw new Error("The waiting first message is missing its immutable attachment receipt")
        }
        const verified = input.openingAttachmentSnapshots.verify(snapshots)
        if (!verified.ok) throw new Error(verified.error)
        providerPromptHash = hashMemoryBoardOpeningPrompt({
          content: openingInput.content,
          attachments: verified.attachments,
        })
      }
      const now = new Date().toISOString()
      const record: MemoryBoardOpeningPromptRecord = {
        taskId: openingInput.taskId,
        chatId: openingInput.chatId,
        reviewId: openingInput.reviewId,
        promptHash,
        content: openingInput.content,
        attachments: structuredClone(attachments),
        ...(openingInput.attachmentSnapshots
          ? { attachmentSnapshots: structuredClone(openingInput.attachmentSnapshots) }
          : {}),
        ...(providerPromptHash ? { providerPromptHash } : {}),
        ...(openingInput.dispatch ? { dispatch: structuredClone(openingInput.dispatch) } : {}),
        phase: "dispatch_pending",
        createdAt: now,
        updatedAt: now,
      }
      input.receiptStore.setKvBatch([
        [openingPromptKey(openingInput.taskId), record],
        [`board_reviewed:${openingInput.taskId}`, true],
      ])
      return {
        taskId: record.taskId,
        chatId: record.chatId,
        reviewId: record.reviewId,
        phase: record.phase,
        promptHash: record.promptHash,
      }
    },
    recoverOpeningPrompt(taskId) {
      const record = input.receiptStore.getKv<MemoryBoardOpeningPromptRecord>(openingPromptKey(taskId))
      if (!record) return null
      if (
        typeof record.content !== "string"
        || !Array.isArray(record.attachments)
        || !record.attachments.every(isChatAttachment)
      ) return null
      let providerAttachments = structuredClone(record.attachments) as ChatAttachment[]
      let attachmentFailure: string | undefined
      if (input.openingAttachmentSnapshots) {
        if ((record.attachmentSnapshots?.length ?? 0) !== record.attachments.length) {
          providerAttachments = []
          attachmentFailure = "The durable opening attachment receipt is incomplete"
        } else {
          const verified = input.openingAttachmentSnapshots.verify(record.attachmentSnapshots ?? [])
          if (verified.ok) providerAttachments = verified.attachments
          else {
            providerAttachments = []
            attachmentFailure = verified.error
          }
        }
      }
      return {
        taskId: record.taskId,
        chatId: record.chatId,
        reviewId: record.reviewId,
        phase: record.phase,
        promptHash: record.promptHash,
        content: record.content,
        attachments: structuredClone(record.attachments),
        providerAttachments,
        ...(attachmentFailure ? { attachmentFailure } : {}),
        ...(record.dispatch ? { dispatch: structuredClone(record.dispatch) } : {}),
        ...(record.providerDispatch ? { providerDispatch: structuredClone(record.providerDispatch) } : {}),
        ...(record.longTermRevision ? { longTermRevision: record.longTermRevision } : {}),
      }
    },
    claimOpeningPromptDispatch(openingInput) {
      const record = assertOpeningRecord(openingInput)
      if (record.promptHash !== hashMemoryBoardOpeningPrompt(openingInput)) {
        throw new Error("A different first message already owns this task's opening Memory Board")
      }
      if (record.phase === "dispatch_pending") {
        writeOpeningRecord(record, "preparing")
        return "claimed"
      }
      return "duplicate"
    },
    openingPromptBookkeeping(openingInput) {
      const record = assertOpeningRecord(openingInput)
      return {
        participantPromptRecorded: record.bookkeeping?.participantPromptRecorded === true,
        turnStarted: record.bookkeeping?.turnStarted === true,
      }
    },
    markOpeningPromptBookkeeping(openingInput, completed) {
      const record = assertOpeningRecord(openingInput)
      input.receiptStore.setKv(openingPromptKey(record.taskId), {
        ...record,
        bookkeeping: {
          participantPromptRecorded:
            completed.participantPromptRecorded ?? record.bookkeeping?.participantPromptRecorded ?? false,
          turnStarted: completed.turnStarted ?? record.bookkeeping?.turnStarted ?? false,
        },
        updatedAt: new Date().toISOString(),
      } satisfies MemoryBoardOpeningPromptRecord)
    },
    markOpeningPromptLongTermReady(openingInput) {
      const record = assertOpeningRecord(openingInput)
      if (record.phase === "long_term_ready" || record.phase === "completed") return
      if (record.phase !== "preparing") {
        throw new Error("The waiting first message has not started its Long-term review")
      }
      const readyRecord = {
        ...record,
        phase: "long_term_ready",
        deferredCandidates: openingDeferredCandidates(record),
        deferredBacklogRows: openingDeferredBacklogRows(record),
        updatedAt: new Date().toISOString(),
      } satisfies MemoryBoardOpeningPromptRecord
      input.receiptStore.setKv(openingPromptKey(record.taskId), {
        ...readyRecord,
        longTermReadyHash: openingLongTermDependencyHash(readyRecord),
      } satisfies MemoryBoardOpeningPromptRecord)
    },
    waitForOpeningPromptCompletion(openingInput) {
      const record = assertOpeningRecord(openingInput)
      if (record.phase === "completed") return Promise.resolve("completed")
      return new Promise<MemoryBoardOpeningCompletionOutcome>((resolve) => {
        const waiters = openingCompletionWaiters.get(record.taskId)
          ?? new Set<(outcome: MemoryBoardOpeningCompletionOutcome) => void>()
        waiters.add(resolve)
        openingCompletionWaiters.set(record.taskId, waiters)
        // Re-read after registration so a synchronous completion cannot land
        // between the first read and installing this waiter.
        if (assertOpeningRecord(openingInput).phase === "completed") {
          waiters.delete(resolve)
          resolve("completed")
        }
      })
    },
    completeOpeningPromptReview(openingInput) {
      const record = assertOpeningRecord(openingInput)
      if (record.phase === "completed") {
        return { completed: true, state: computeReviewState(record.taskId, true) }
      }
      if (record.phase !== "long_term_ready") {
        return { completed: false, state: computeReviewState(record.taskId, true) }
      }
      const state = computeReviewState(record.taskId, true)
      const currentDependencyHash = openingLongTermDependencyHash(record)
      if (state.pending.total > 0 || record.longTermReadyHash !== currentDependencyHash) {
        const {
          longTermReadyHash: _staleHash,
          deferredCandidates: _staleDeferredCandidates,
          deferredBacklogRows: _staleDeferredBacklogRows,
          ...withoutReadyHash
        } = record
        input.receiptStore.setKv(openingPromptKey(record.taskId), {
          ...withoutReadyHash,
          phase: "preparing",
          longTermRevision: (record.longTermRevision ?? 0) + 1,
          updatedAt: new Date().toISOString(),
        } satisfies MemoryBoardOpeningPromptRecord)
        notifyOpeningCompletion(record.taskId, "invalidated")
        return { completed: false, state: computeReviewState(record.taskId, true) }
      }
      writeOpeningRecord(record, "completed")
      notifyOpeningCompletion(record.taskId, "completed")
      return { completed: true, state: computeReviewState(record.taskId, true) }
    },
    claimOpeningProviderDispatch(openingInput) {
      const record = assertOpeningRecord(openingInput)
      if (record.phase !== "completed") {
        throw new Error("The opening Memory Board has not released Working Memory")
      }
      const existing = record.providerDispatch
      if (existing) {
        if (
          existing.previewId !== openingInput.previewId
          || existing.decision !== openingInput.decision
          || canonicalJson(existing.focusDelivery ?? null) !== canonicalJson(openingInput.focusDelivery ?? null)
        ) {
          throw new Error("A different Working Memory decision already owns this opening prompt")
        }
        return existing.phase
      }
      input.receiptStore.setKv(openingPromptKey(record.taskId), {
        ...record,
        providerDispatch: {
          previewId: openingInput.previewId,
          decision: openingInput.decision,
          phase: "dispatching",
          ...(openingInput.focusDelivery ? { focusDelivery: structuredClone(openingInput.focusDelivery) } : {}),
        },
        updatedAt: new Date().toISOString(),
      } satisfies MemoryBoardOpeningPromptRecord)
      return "claimed"
    },
    settleOpeningProviderDispatch(openingInput, outcome) {
      const record = assertOpeningRecord(openingInput)
      const existing = record.providerDispatch
      if (!existing || existing.previewId !== openingInput.previewId || existing.decision !== openingInput.decision) {
        throw new Error("The exact Working Memory provider dispatch was not claimed")
      }
      if (existing.phase === outcome) return
      if (existing.phase !== "dispatching") {
        throw new Error(`The opening provider dispatch already settled as ${existing.phase}`)
      }
      input.receiptStore.setKv(openingPromptKey(record.taskId), {
        ...record,
        providerDispatch: { ...existing, phase: outcome },
        updatedAt: new Date().toISOString(),
      } satisfies MemoryBoardOpeningPromptRecord)
    },
    promptRefusal(taskId, attempt) {
      const openingPrompt = input.receiptStore.getKv<MemoryBoardOpeningPromptRecord>(openingPromptKey(taskId))
      if (openingPrompt && openingPrompt.phase !== "completed") {
        const exactOpeningDispatch = attempt
          && attempt.channel === "chat.send"
          && attempt.taskId === openingPrompt.taskId
          && attempt.chatId === openingPrompt.chatId
          && attempt.reviewId === openingPrompt.reviewId
          && (
            hashMemoryBoardOpeningPrompt(attempt) === openingPrompt.promptHash
            || hashMemoryBoardOpeningPrompt(attempt) === openingPrompt.providerPromptHash
          )
        return exactOpeningDispatch
          ? null
          : "The waiting first message must finish its opening Memory Board review before another prompt can be sent."
      }
      // The Board is a once-per-task opening barrier. New memory work after
      // this receipt belongs to the normal per-turn chat gates.
      if (input.receiptStore.getKv<boolean>(`board_reviewed:${taskId}`) === true) return null
      const state = computeReviewState(taskId, false)
      return state.pending.total > 0
        ? `Review ${state.pending.total} pending memory ${state.pending.total === 1 ? "item" : "items"} on the Memory Board before sending a prompt.`
        : "Open the Memory Board and enter the session before sending a prompt."
    },
    assertPending(resolution) {
      const row = findLatestRow(resolution)
      if (!row) throw new Error("The requested suggestion is not a pending Board row")
      return pendingAdmission(row)
    },
    assertTransferPending(resolution) {
      const row = findLatestRow(resolution)
      if (!row || row.kind !== "transfer") throw new Error("The requested suggestion is not a pending Board Transfer row")
      const admission = pendingAdmission(row)
      if (!admission.pending) return admission
      return {
        pending: true,
        trusted: {
          chatId: row.chatId,
          ...(row.projectId ? { projectId: row.projectId } : {}),
          destinationContextKey: row.projectId ?? row.chatId,
          suggestion: row.suggestion,
        },
      }
    },
    resolve(resolution, outcome) {
      const row = findLatestRow(resolution)
      if (!row) throw new Error("The requested suggestion is not a pending Board row")
      input.receiptStore.setKv(receiptKey(row.semanticKey), {
        taskId: resolution.taskId,
        chatId: row.chatId,
        gateId: row.gateId,
        throughCreatedAt: row.occurrenceAt,
        resolvedAt: new Date().toISOString(),
        outcome: "resolved",
        ...(outcome?.resultId ? { resultId: outcome.resultId } : {}),
      } satisfies ResolutionReceipt)
    },
  }
}
