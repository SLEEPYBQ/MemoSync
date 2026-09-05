import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react"
import type { HydratedTranscriptMessage } from "../../../shared/types"
import type { TranscriptChatContextValue } from "../../components/messages/render-context"

export type FocusedMemoryReviewMessage = Extract<
  HydratedTranscriptMessage,
  { kind: "memory_proposals" | "memory_transfer" | "memory_checkup" }
>

export interface FocusedMemoryReviewProgress {
  settledTransferRows: ReadonlyMap<string, string>
  resolvedCheckupRows: ReadonlyMap<string, string>
}

export interface FocusedMemoryReviewSnapshot {
  reviewId: string
  chatContext: TranscriptChatContextValue
  messages: FocusedMemoryReviewMessage[]
  stale: boolean
  onMemoryProposalsRespond?: (proposalsId: string, decision: "reviewed" | "skipped") => Promise<void> | void
  onMemoryCheckupRespond?: (checkupId: string, decision: "handled" | "skipped") => Promise<void> | void
  onMemoryTransferRespond?: (transferId: string, decision: "handled" | "skipped") => Promise<void> | void
  canReopenProposals?: boolean
  canReopenTransfer?: boolean
  canReopenCheckup?: boolean
  onMemoryPreparationReopen?: (from: "proposals" | "checkup" | "transfer", stageId: string) => Promise<void> | void
  progress: FocusedMemoryReviewProgress
  onTransferSettled: (sourceId: string, outcome: string) => void
  onCheckupResolved: (memoryId: string, outcome: string) => void
}

export interface FocusedMemoryReviewController {
  getSnapshot: () => FocusedMemoryReviewSnapshot
  subscribe: (listener: () => void) => () => void
  update: (snapshot: FocusedMemoryReviewSnapshot) => void
}

export interface FocusedMemoryReviewRegistry {
  register: (
    chatId: string,
    reviewId: string,
    controller: FocusedMemoryReviewController,
  ) => () => void
  get: (chatId: string, reviewId: string) => FocusedMemoryReviewController | undefined
  subscribe: (listener: () => void) => () => void
}

function focusedReviewKey(chatId: string, reviewId: string) {
  return `${chatId}\u0000${reviewId}`
}

/**
 * Shared live controller index. The transcript owns the controller because it
 * already owns the canonical gate callbacks; the opening Board only borrows
 * the exact chat/review pair, so no second review implementation can drift.
 */
export function createFocusedMemoryReviewRegistry(): FocusedMemoryReviewRegistry {
  const controllers = new Map<string, FocusedMemoryReviewController>()
  const listeners = new Set<() => void>()
  const publish = () => listeners.forEach((listener) => listener())
  return {
    register(chatId, reviewId, controller) {
      const key = focusedReviewKey(chatId, reviewId)
      if (controllers.get(key) !== controller) {
        controllers.set(key, controller)
        publish()
      }
      return () => {
        // A stale React cleanup must not remove a replacement controller that
        // already registered for the same durable review after remount.
        if (controllers.get(key) !== controller) return
        controllers.delete(key)
        publish()
      }
    },
    get: (chatId, reviewId) => controllers.get(focusedReviewKey(chatId, reviewId)),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export function createFocusedMemoryReviewController(
  initialSnapshot: FocusedMemoryReviewSnapshot,
): FocusedMemoryReviewController {
  let snapshot = initialSnapshot
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    update: (next) => {
      if (Object.is(snapshot, next)) return
      snapshot = next
      listeners.forEach((listener) => listener())
    },
  }
}

export function useFocusedMemoryReview(controller: FocusedMemoryReviewController) {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
}

export type MemoryBoardLaunchSource = "study_sidebar" | "memory_record" | "chat_long_term"

export interface MemoryBoardLaunchRequest {
  source: MemoryBoardLaunchSource
  chatId?: string
  focusedReview?: FocusedMemoryReviewController
}

export interface ResolvedMemoryBoardLaunchRequest extends MemoryBoardLaunchRequest {
  chatId: string
}

export function resolveMemoryBoardLaunchRequest(
  request: MemoryBoardLaunchRequest,
  activeChatId: string | null,
): ResolvedMemoryBoardLaunchRequest | null {
  if (!activeChatId) return null
  if (request.chatId && request.chatId !== activeChatId) return null
  const focusedReviewChatId = request.focusedReview?.getSnapshot().chatContext.chatId
  if (focusedReviewChatId && focusedReviewChatId !== activeChatId) return null
  return {
    ...request,
    chatId: activeChatId,
  }
}

export function reconcileMemoryBoardRequestWithActiveChat(
  request: ResolvedMemoryBoardLaunchRequest | null,
  activeChatId: string | null,
): ResolvedMemoryBoardLaunchRequest | null {
  if (!request || !activeChatId || request.chatId !== activeChatId) return null
  const focusedReviewChatId = request.focusedReview?.getSnapshot().chatContext.chatId
  return !focusedReviewChatId || focusedReviewChatId === activeChatId ? request : null
}

interface MemoryBoardLauncher {
  available: boolean
  openMemoryBoard: (request: MemoryBoardLaunchRequest) => void
  focusedReviews: FocusedMemoryReviewRegistry
}

const unavailableFocusedReviews = createFocusedMemoryReviewRegistry()
const unavailableLauncher: MemoryBoardLauncher = {
  available: false,
  openMemoryBoard: () => undefined,
  focusedReviews: unavailableFocusedReviews,
}

const MemoryBoardLauncherContext = createContext<MemoryBoardLauncher>(unavailableLauncher)

export function MemoryBoardLauncherProvider({
  onOpenMemoryBoard,
  children,
}: {
  onOpenMemoryBoard: (request: MemoryBoardLaunchRequest) => void
  children: ReactNode
}) {
  const focusedReviews = useMemo(() => createFocusedMemoryReviewRegistry(), [])
  const launcher = useMemo<MemoryBoardLauncher>(() => ({
    available: true,
    openMemoryBoard: onOpenMemoryBoard,
    focusedReviews,
  }), [focusedReviews, onOpenMemoryBoard])

  return (
    <MemoryBoardLauncherContext.Provider value={launcher}>
      {children}
    </MemoryBoardLauncherContext.Provider>
  )
}

export function useMemoryBoardLauncher() {
  return useContext(MemoryBoardLauncherContext)
}

export function useRegisteredFocusedMemoryReview(
  chatId: string | null,
  reviewId: string | null,
) {
  const launcher = useMemoryBoardLauncher()
  return useSyncExternalStore(
    launcher.focusedReviews.subscribe,
    () => chatId && reviewId ? launcher.focusedReviews.get(chatId, reviewId) : undefined,
    () => undefined,
  )
}
