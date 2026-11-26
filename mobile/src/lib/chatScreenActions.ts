import {
  EMPTY_DRAFT_STATE,
  applyFailedSendRestore,
  applyStartInFlightSend,
  applyStartPendingDequeueRestore,
  canApplySnapshotSynchronously,
  captureColdStartBaseline,
  capturePreSendBaseline,
  clearInFlightSendState,
  clearPendingDequeueRestore,
  completePendingDequeueRestore,
  createClientRequestId,
  isAmbiguousSendTransportError,
  isStaleNativeCommandRestore,
  mergeTranscriptEntries,
  modelCommandFields,
  reconcileColdStartInFlightSend,
  reconcilePendingDequeueRestoreAgainstSnapshot,
  reconcilePendingRetryAgainstSnapshot,
  resolveSendClientRequestId,
  wasSendCommittedInSnapshot,
  type ComposerModelSelection,
  type PersistedDraftState,
  type PreSendBaseline,
  type SendRetryAction,
} from "./chatState"
import {
  clearDequeueActive,
  clearInFlightSendActive,
  clearPersistedDraftState,
  getCachedDraftState,
  isDequeueActive,
  isInFlightSendActive,
  markDequeueActive,
  markInFlightSendActive,
  updatePersistedDraftState,
} from "./draftStore"
import type {
  ChatHistoryPage,
  ChatSnapshot,
  ClientCommand,
  QueuedChatMessage,
  TranscriptEntry,
} from "../types"

export const SEND_RECONCILE_TIMEOUT_MS = 8_000

export interface ChatCommandSocket {
  command<T = unknown>(command: ClientCommand): Promise<T>
}

export interface CommittedChatView {
  snapshot: ChatSnapshot | null
  knownEntries: TranscriptEntry[]
}

export const EMPTY_CHAT_VIEW: CommittedChatView = {
  snapshot: null,
  knownEntries: [],
}

export interface PendingSendReconciliation {
  content: string
  clientRequestId: string
  action: SendRetryAction
  baseline: PreSendBaseline
  errorMessage: string
  timer: ReturnType<typeof setTimeout>
}

/** The host intentionally returns stable machine codes for model-access
 * preparation failures; translate the common ones instead of exposing kebab-case. */
export function describeSendError(error: unknown): string {
  const raw = error instanceof Error ? error.message : ""
  switch (raw) {
    case "account-signed-out":
      return "Sign in to the agent CLI or choose an API connection on the host."
    case "connection-missing":
    case "connection-key-missing":
      return "Choose or configure an API connection in MemoSync settings on the host."
    case "executable-missing":
    case "executable-broken":
    case "executable-incompatible":
      return "Repair the agent CLI installation in MemoSync settings on the host."
    default:
      return raw || "Message could not be sent"
  }
}

/** Reconcile persisted cold-start in-flight sends, post-timeout `pendingRetry`
 * drafts (checking BOTH `messages` and `queuedMessages`), and interrupted
 * expired-command `pendingDequeueRestore` records against an authoritative
 * host `ChatSnapshot`. */
export function reconcilePersistedDraftAgainstChatSnapshot(
  chatId: string,
  snapshot: ChatSnapshot,
  entriesOverride?: readonly TranscriptEntry[],
  fallbackState?: PersistedDraftState,
): void {
  const entries = entriesOverride ?? snapshot.messages
  const live = getCachedDraftState(chatId) ?? fallbackState ?? EMPTY_DRAFT_STATE
  const canReconcileInFlight = Boolean(
    live.inFlightSend && !isInFlightSendActive(chatId, live.inFlightSend.clientRequestId),
  )
  const hasPendingRetry = Boolean(live.pendingRetry?.clientRequestId)
  const canReconcileDequeueRestore = Boolean(
    live.pendingDequeueRestore && !isDequeueActive(chatId, live.pendingDequeueRestore.queuedMessageId),
  )
  if (!canReconcileInFlight && !hasPendingRetry && !canReconcileDequeueRestore) return
  updatePersistedDraftState(
    chatId,
    (current) => {
      let next = current
      if (next.inFlightSend && !isInFlightSendActive(chatId, next.inFlightSend.clientRequestId)) {
        next = reconcileColdStartInFlightSend(
          next,
          entries,
          snapshot.queuedMessages,
          snapshot.history.hasOlder,
        ).state
      }
      next = reconcilePendingRetryAgainstSnapshot(next, entries, snapshot.queuedMessages)
      if (next.pendingDequeueRestore && !isDequeueActive(chatId, next.pendingDequeueRestore.queuedMessageId)) {
        next = reconcilePendingDequeueRestoreAgainstSnapshot(next, snapshot.queuedMessages).state
      }
      return next
    },
    { immediate: true },
  )
}

export interface PerformSendArgs {
  chatId: string
  content: string
  active: boolean
  action: SendRetryAction
  pendingRetry: PersistedDraftState["pendingRetry"]
  socket: ChatCommandSocket
  effectivePlanMode: boolean
  composerModelSelection: ComposerModelSelection | null
  combinedEntries: TranscriptEntry[]
  baselineQueue: QueuedChatMessage[]
  getLatestSnapshot: () => ChatSnapshot | null
  getKnownEntries: () => TranscriptEntry[]
  isMounted: () => boolean
  clearPendingSendReconciliation: () => PendingSendReconciliation | null
  setPendingSendReconciliation: (next: PendingSendReconciliation | null) => void
  getPendingSendReconciliation: () => PendingSendReconciliation | null
  setSending: (value: boolean) => void
  setReconcilingSend: (value: boolean) => void
  setSendError: (value: string | null) => void
  reconcileTimeoutMs?: number
  generateId?: () => string
  now?: () => number
}

/** Execute the full mobile composer send/enqueue/steer lifecycle, including
 * live snapshot reconciliation, unmount persistence, and post-timeout recovery. */
export async function performChatSendAction(args: PerformSendArgs): Promise<void> {
  const {
    chatId,
    content,
    active,
    action,
    pendingRetry,
    socket,
    effectivePlanMode,
    composerModelSelection,
    combinedEntries,
    baselineQueue,
    getLatestSnapshot,
    getKnownEntries,
    isMounted,
    clearPendingSendReconciliation,
    setPendingSendReconciliation,
    getPendingSendReconciliation,
    setSending,
    setReconcilingSend,
    setSendError,
    reconcileTimeoutMs = SEND_RECONCILE_TIMEOUT_MS,
    generateId = createClientRequestId,
    now = Date.now,
  } = args

  const clientRequestId = resolveSendClientRequestId(content, pendingRetry, { action, generateId })
  const baseline = capturePreSendBaseline(combinedEntries, baselineQueue)
  const coldStartBaseline = captureColdStartBaseline(combinedEntries, baselineQueue)
  setSending(true)
  setSendError(null)
  markInFlightSendActive(chatId, clientRequestId)
  updatePersistedDraftState(
    chatId,
    (current) =>
      applyStartInFlightSend(current, {
        clientRequestId,
        content,
        action,
        baseline: coldStartBaseline,
        sentAt: now(),
      }),
    { immediate: true },
  )
  try {
    if (active) {
      await socket.command({
        type: "message.enqueue",
        chatId,
        clientRequestId,
        content,
        ...modelCommandFields(composerModelSelection),
        planMode: effectivePlanMode,
        steer: action === "steer",
      })
    } else {
      await socket.command({
        type: "chat.send",
        chatId,
        clientTraceId: generateId(),
        clientRequestId,
        content,
        ...modelCommandFields(composerModelSelection),
        planMode: effectivePlanMode,
      })
    }
    clearInFlightSendActive(chatId, clientRequestId)
    updatePersistedDraftState(
      chatId,
      (live) => clearInFlightSendState(live, clientRequestId),
      { immediate: true },
    )
  } catch (error) {
    const errorMessage = describeSendError(error)
    if (!isMounted()) {
      clearInFlightSendActive(chatId, clientRequestId)
      if (isAmbiguousSendTransportError(error)) {
        updatePersistedDraftState(
          chatId,
          (live) =>
            live.inFlightSend?.clientRequestId === clientRequestId
              ? { ...live, inFlightSend: { ...live.inFlightSend, errorMessage } }
              : live,
          { immediate: true },
        )
      } else {
        updatePersistedDraftState(
          chatId,
          (live) =>
            applyFailedSendRestore(
              clearInFlightSendState(live, clientRequestId),
              content,
              errorMessage,
              clientRequestId,
              action,
            ),
          { immediate: true },
        )
      }
      return
    }
    if (isAmbiguousSendTransportError(error)) {
      const latestSnapshot = getLatestSnapshot()
      const latestEntries = mergeTranscriptEntries(getKnownEntries(), latestSnapshot?.messages ?? [])
      if (
        wasSendCommittedInSnapshot(
          content,
          baseline,
          latestEntries,
          latestSnapshot?.queuedMessages ?? [],
          clientRequestId,
        )
      ) {
        clearInFlightSendActive(chatId, clientRequestId)
        updatePersistedDraftState(
          chatId,
          (live) => clearInFlightSendState(live, clientRequestId),
          { immediate: true },
        )
        return
      }
      clearPendingSendReconciliation()
      setReconcilingSend(true)
      updatePersistedDraftState(
        chatId,
        (live) =>
          live.inFlightSend?.clientRequestId === clientRequestId
            ? { ...live, inFlightSend: { ...live.inFlightSend, errorMessage } }
            : live,
        { immediate: true },
      )
      const timer = setTimeout(() => {
        if (getPendingSendReconciliation()?.timer !== timer) return
        setPendingSendReconciliation(null)
        setReconcilingSend(false)
        clearInFlightSendActive(chatId, clientRequestId)
        const settledSnapshot = getLatestSnapshot()
        const settledEntries = mergeTranscriptEntries(getKnownEntries(), settledSnapshot?.messages ?? [])
        if (
          !wasSendCommittedInSnapshot(
            content,
            baseline,
            settledEntries,
            settledSnapshot?.queuedMessages ?? [],
            clientRequestId,
          )
        ) {
          updatePersistedDraftState(
            chatId,
            (live) =>
              applyFailedSendRestore(
                clearInFlightSendState(live, clientRequestId),
                content,
                errorMessage,
                clientRequestId,
                action,
              ),
            { immediate: true },
          )
        } else {
          updatePersistedDraftState(
            chatId,
            (live) => clearInFlightSendState(live, clientRequestId),
            { immediate: true },
          )
        }
      }, reconcileTimeoutMs)
      setPendingSendReconciliation({
        content,
        clientRequestId,
        action,
        baseline,
        errorMessage,
        timer,
      })
      return
    }
    clearInFlightSendActive(chatId, clientRequestId)
    updatePersistedDraftState(
      chatId,
      (live) =>
        applyFailedSendRestore(
          clearInFlightSendState(live, clientRequestId),
          content,
          errorMessage,
          clientRequestId,
          action,
        ),
      { immediate: true },
    )
  } finally {
    if (isMounted()) setSending(false)
  }
}

export interface PerformDequeueArgs {
  chatId: string
  message: QueuedChatMessage
  mode: "remove" | "restore_empty" | "replace"
  socket: ChatCommandSocket | null
  getLatestSnapshot: () => ChatSnapshot | null
  isMounted: () => boolean
  onDequeueStart?: (queuedMessageId: string) => void
  onDequeueEnd?: (queuedMessageId: string) => void
  onError?: (message: string) => void
}

/** Execute `message.dequeue` with double-tap protection and disconnect/unmount-safe
 * expired slash-command restoration (F-7). */
export async function performQueuedMessageDequeueAction(args: PerformDequeueArgs): Promise<void> {
  const {
    chatId,
    message,
    mode,
    socket,
    getLatestSnapshot,
    isMounted,
    onDequeueStart,
    onDequeueEnd,
    onError,
  } = args
  if (!socket || isDequeueActive(chatId, message.id)) return
  const shouldRestore = mode === "replace" || (mode === "restore_empty" && isStaleNativeCommandRestore(message))
  markDequeueActive(chatId, message.id)
  onDequeueStart?.(message.id)
  if (shouldRestore) {
    updatePersistedDraftState(
      chatId,
      (live) =>
        applyStartPendingDequeueRestore(live, {
          queuedMessageId: message.id,
          content: message.content,
          mode: mode === "replace" ? "replace" : "restore_empty",
        }),
      { immediate: true },
    )
  }
  try {
    await socket.command({ type: "message.dequeue", chatId, queuedMessageId: message.id })
    clearDequeueActive(chatId, message.id)
    if (shouldRestore) {
      updatePersistedDraftState(
        chatId,
        (live) =>
          completePendingDequeueRestore(
            live,
            message.id,
            message.content,
            mode === "replace" ? "replace" : "restore_empty",
          ),
        { immediate: true },
      )
    }
  } catch (error) {
    clearDequeueActive(chatId, message.id)
    if (shouldRestore) {
      if (isAmbiguousSendTransportError(error)) {
        // If a snapshot already arrived while `message.dequeue` was timing out
        // and proved the host already deleted the row, complete the restore now;
        // otherwise keep `pendingDequeueRestore` persisted in draftStore so the
        // next post-reconnect / post-remount ChatSnapshot reconciles it.
        const latestSnapshot = getLatestSnapshot()
        if (latestSnapshot && !latestSnapshot.queuedMessages.some((item) => item.id === message.id)) {
          updatePersistedDraftState(
            chatId,
            (live) => reconcilePendingDequeueRestoreAgainstSnapshot(live, latestSnapshot.queuedMessages).state,
            { immediate: true },
          )
        } else if (isMounted()) {
          onError?.(describeSendError(error))
        }
      } else {
        updatePersistedDraftState(
          chatId,
          (live) => clearPendingDequeueRestore(live, message.id),
          { immediate: true },
        )
        if (isMounted()) onError?.(describeSendError(error))
      }
    } else if (isMounted()) {
      onError?.(describeSendError(error))
    }
  } finally {
    clearDequeueActive(chatId, message.id)
    if (isMounted()) onDequeueEnd?.(message.id)
  }
}

export interface SnapshotCoordinatorRefs {
  chatId: string
  socket: ChatCommandSocket
  getSnapshot: () => ChatSnapshot | null
  setSnapshot: (value: ChatSnapshot | null) => void
  getKnownEntries: () => TranscriptEntry[]
  setKnownEntries: (entries: TranscriptEntry[]) => void
  getHistoryInitialized: () => boolean
  setHistoryInitialized: (value: boolean) => void
  getHistoryGeneration: () => number
  bumpHistoryGeneration: () => number
  getPendingWindowUpdates: () => number
  setPendingWindowUpdates: (value: number) => void
  getWindowUpdates: () => Promise<void>
  setWindowUpdates: (promise: Promise<void>) => void
  getPendingSendReconciliation: () => PendingSendReconciliation | null
  clearPendingSendReconciliation: () => PendingSendReconciliation | null
  getDraftStateFallback: () => PersistedDraftState
  setChatView: (view: CommittedChatView) => void
  setMissing: (missing: boolean) => void
  setOlderEntries: (entries: TranscriptEntry[]) => void
  setHistoryCursor: (cursor: string | null) => void
  setHasOlderHistory: (hasOlder: boolean) => void
  setHistoryError: (error: string | null) => void
}

/** Process an incoming live `ChatSnapshot` atomically (null deletion cleanup,
 * pending send + dequeue-restore reconciliation, synchronous contiguous fast-path,
 * and gap-bridging async backfill). */
export function applyIncomingChatSnapshot(refs: SnapshotCoordinatorRefs, value: ChatSnapshot | null): void {
  const { chatId, socket } = refs
  if (!value) {
    refs.bumpHistoryGeneration()
    refs.setPendingWindowUpdates(0)
    const pendingSend = refs.clearPendingSendReconciliation()
    if (pendingSend) {
      clearInFlightSendActive(chatId, pendingSend.clientRequestId)
    } else {
      clearInFlightSendActive(chatId)
    }
    clearDequeueActive(chatId)
    clearPersistedDraftState(chatId)
    refs.setSnapshot(null)
    refs.setKnownEntries([])
    refs.setChatView(EMPTY_CHAT_VIEW)
    refs.setMissing(true)
    return
  }

  refs.setSnapshot(value)
  refs.setMissing(false)

  const pendingSend = refs.getPendingSendReconciliation()
  if (pendingSend) {
    refs.clearPendingSendReconciliation()
    clearInFlightSendActive(chatId, pendingSend.clientRequestId)
    if (
      !wasSendCommittedInSnapshot(
        pendingSend.content,
        pendingSend.baseline,
        value.messages,
        value.queuedMessages,
        pendingSend.clientRequestId,
      )
    ) {
      updatePersistedDraftState(
        chatId,
        (live) => {
          let next = applyFailedSendRestore(
            clearInFlightSendState(live, pendingSend.clientRequestId),
            pendingSend.content,
            pendingSend.errorMessage,
            pendingSend.clientRequestId,
            pendingSend.action,
          )
          if (next.pendingDequeueRestore && !isDequeueActive(chatId, next.pendingDequeueRestore.queuedMessageId)) {
            next = reconcilePendingDequeueRestoreAgainstSnapshot(next, value.queuedMessages).state
          }
          return next
        },
        { immediate: true },
      )
    } else {
      updatePersistedDraftState(
        chatId,
        (live) => {
          let next = clearInFlightSendState(live, pendingSend.clientRequestId)
          if (next.pendingDequeueRestore && !isDequeueActive(chatId, next.pendingDequeueRestore.queuedMessageId)) {
            next = reconcilePendingDequeueRestoreAgainstSnapshot(next, value.queuedMessages).state
          }
          return next
        },
        { immediate: true },
      )
    }
  } else {
    reconcilePersistedDraftAgainstChatSnapshot(chatId, value, undefined, refs.getDraftStateFallback())
  }

  if (!refs.getHistoryInitialized()) {
    refs.setHistoryInitialized(true)
    refs.setKnownEntries(value.messages)
    refs.setChatView({ snapshot: value, knownEntries: value.messages })
    refs.setHistoryCursor(value.history.olderCursor)
    refs.setHasOlderHistory(value.history.hasOlder)
    return
  }

  if (canApplySnapshotSynchronously(refs.getKnownEntries(), value.messages, refs.getPendingWindowUpdates() > 0)) {
    const merged = mergeTranscriptEntries(refs.getKnownEntries(), value.messages)
    refs.setKnownEntries(merged)
    refs.setChatView({ snapshot: value, knownEntries: merged })
    return
  }

  const generation = refs.getHistoryGeneration()
  refs.setPendingWindowUpdates(refs.getPendingWindowUpdates() + 1)
  const applyWindow = async () => {
    if (refs.getHistoryGeneration() !== generation) return
    const current = refs.getKnownEntries()
    const anchorId = current[current.length - 1]?._id
    let incoming = value.messages
    if (anchorId && value.messages.length > 0 && !value.messages.some((entry) => entry._id === anchorId)) {
      let cursor = value.history.olderCursor
      let bridge: TranscriptEntry[] = []
      let foundAnchor = false
      const visited = new Set<string>()
      while (cursor && !visited.has(cursor)) {
        if (refs.getHistoryGeneration() !== generation) return
        visited.add(cursor)
        const page = await socket.command<ChatHistoryPage>({
          type: "chat.loadHistory",
          chatId,
          beforeCursor: cursor,
          limit: 100,
        })
        if (refs.getHistoryGeneration() !== generation) return
        const anchorIndex = page.messages.findIndex((entry) => entry._id === anchorId)
        bridge = mergeTranscriptEntries(
          anchorIndex >= 0 ? page.messages.slice(anchorIndex + 1) : page.messages,
          bridge,
        )
        if (anchorIndex >= 0) {
          foundAnchor = true
          break
        }
        cursor = page.hasOlder ? page.olderCursor : null
      }
      if (!foundAnchor) throw new Error("Chat history changed while reconnecting; reload the chat")
      incoming = mergeTranscriptEntries(bridge, value.messages)
    }
    if (refs.getHistoryGeneration() !== generation) return
    const merged = mergeTranscriptEntries(refs.getKnownEntries(), incoming)
    refs.setKnownEntries(merged)
    reconcilePersistedDraftAgainstChatSnapshot(chatId, value, merged, refs.getDraftStateFallback())
    refs.setChatView({ snapshot: value, knownEntries: merged })
  }

  const chained = refs
    .getWindowUpdates()
    .then(applyWindow)
    .catch((error) => {
      if (refs.getHistoryGeneration() !== generation) return
      refs.setKnownEntries(value.messages)
      refs.setChatView({ snapshot: value, knownEntries: value.messages })
      refs.setOlderEntries([])
      refs.setHistoryCursor(value.history.olderCursor)
      refs.setHasOlderHistory(value.history.hasOlder)
      refs.setHistoryError(error instanceof Error ? error.message : "Chat history could not be synchronized")
    })
    .finally(() => {
      if (refs.getHistoryGeneration() === generation) {
        refs.setPendingWindowUpdates(Math.max(0, refs.getPendingWindowUpdates() - 1))
      }
    })
  refs.setWindowUpdates(chained)
}
