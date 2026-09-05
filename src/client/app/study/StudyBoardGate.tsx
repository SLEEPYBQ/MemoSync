// Session-start Memory Board gate (2026-08-19 E1) + the reusable in-chat
// overlay. The study gate is deliberately fail-closed: a MemoSync chat stays
// covered while lifecycle/Board state is checked, and request failures expose
// only a retry surface, never the underlying live memory or chat controls.
import { useCallback, useEffect, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { Loader2 } from "lucide-react"
import { MemoryBoardPage } from "../MemoryBoardPage"
import { Button } from "../../components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog"
import { useConditionPolicy } from "../../lib/conditionApi"
import {
  memoriesApi,
  recordUiMonitor,
  type MemoryBoardReviewStatus,
} from "../../lib/memoriesApi"
import {
  createHeldStudyPrompt,
  markStudyPromptServerOwned,
  setStudyPromptInterceptor,
  studyGateCapturesPrompt,
  type HeldStudyPrompt,
} from "./studyPromptIntercept"
import {
  useRegisteredFocusedMemoryReview,
  type FocusedMemoryReviewController,
} from "./MemoryBoardLauncher"
import { useSurfaceExposure } from "./surfaceExposure"

export interface StudyBoardProgress {
  activeTaskId: string | null
  postSessionPending: boolean
  freezeState: "open" | "freezing" | "frozen" | null
}

export function getStudyBoardChatId(pathname: string): string | null {
  const match = pathname.match(/^\/chat\/([^/]+)\/?$/)
  return match ? decodeURIComponent(match[1]!) : null
}

export function isOpenStudyBoardProgress(progress: StudyBoardProgress): progress is StudyBoardProgress & { activeTaskId: string; freezeState: "open" } {
  return typeof progress.activeTaskId === "string"
    && progress.activeTaskId.length > 0
    && progress.freezeState === "open"
    && progress.postSessionPending === false
}

function parseStudyBoardProgress(value: unknown): StudyBoardProgress | null {
  if (!value || typeof value !== "object") return null
  const progress = value as Partial<StudyBoardProgress>
  const activeTaskId = progress.activeTaskId
  const freezeState = progress.freezeState
  if (activeTaskId !== null && typeof activeTaskId !== "string") return null
  if (freezeState !== null && freezeState !== "open" && freezeState !== "freezing" && freezeState !== "frozen") return null
  if (typeof progress.postSessionPending !== "boolean") return null
  return { activeTaskId, freezeState, postSessionPending: progress.postSessionPending }
}

async function fetchStudyBoardProgress(): Promise<StudyBoardProgress> {
  const progressResponse = await fetch("/api/study/progress", { cache: "no-store" })
  if (!progressResponse.ok) throw new Error(`study progress request failed (${progressResponse.status})`)
  const progressBody = await progressResponse.json() as { data?: unknown }
  const progress = parseStudyBoardProgress(progressBody.data)
  if (!progress) throw new Error("study progress response was invalid")
  return progress
}

export interface StudyBoardRequestSequence {
  begin(): number
  cancel(): void
  isCurrent(request: number): boolean
}

/** Latest-request-wins guard for route/focus checks that can resolve out of order. */
export function createStudyBoardRequestSequence(): StudyBoardRequestSequence {
  let latest = 0
  return {
    begin: () => ++latest,
    cancel: () => { latest += 1 },
    isCurrent: (request) => request === latest,
  }
}

export interface StudyBoardGateLoadResult {
  taskId: string
  chatId: string
  status: MemoryBoardReviewStatus
}

export function getOpeningPromptOwnership(status: MemoryBoardReviewStatus): {
  chatId: string
  reviewId: string
  promptHash: string
} | null {
  const opening = status.openingPrompt
  if (!opening?.promptHash) return null
  return { chatId: opening.chatId, reviewId: opening.reviewId, promptHash: opening.promptHash }
}

export function getOpeningPromptReturnRoute(
  status: MemoryBoardReviewStatus,
  currentChatId: string,
): string | null {
  const opening = status.openingPrompt
  if (!opening || opening.phase === "completed" || opening.chatId === currentChatId) return null
  return `/chat/${encodeURIComponent(opening.chatId)}`
}

export interface OpeningPreparationClaims {
  claim(
    identity: object,
    preferredReviewId: string | undefined,
    createReviewId: () => string,
  ): { claimed: boolean; reviewId: string }
  retry(identity: object): void
}

/**
 * One held object owns one stable review id and one prepare attempt. React
 * renders cannot retry it; only an explicit participant retry re-arms it.
 */
export function createOpeningPreparationClaims(): OpeningPreparationClaims {
  const claims = new WeakMap<object, { reviewId: string; attempted: boolean }>()
  return {
    claim(identity, preferredReviewId, createReviewId) {
      let claim = claims.get(identity)
      if (!claim) {
        claim = {
          reviewId: preferredReviewId ?? createReviewId(),
          attempted: false,
        }
        claims.set(identity, claim)
      } else if (preferredReviewId && claim.reviewId !== preferredReviewId) {
        // A durable server receipt is authoritative after reconciliation.
        claim.reviewId = preferredReviewId
      }
      if (claim.attempted) return { claimed: false, reviewId: claim.reviewId }
      claim.attempted = true
      return { claimed: true, reviewId: claim.reviewId }
    },
    retry(identity) {
      const claim = claims.get(identity)
      if (claim) claim.attempted = false
    },
  }
}

function isCompletedOpeningReview(status: MemoryBoardReviewStatus): boolean {
  return status.reviewed === true && status.openingPrompt?.phase === "completed"
}

export type OpeningBoardCompletionResolution =
  | { admitted: true; status: MemoryBoardReviewStatus; error: null }
  | { admitted: false; status: MemoryBoardReviewStatus; error: unknown }

/**
 * A completed POST can lose its response. Read the durable receipt before
 * surfacing failure so the participant never gets a dead Continue button.
 */
export async function completeOpeningBoardReviewWithReconciliation(input: {
  complete: () => Promise<MemoryBoardReviewStatus>
  read: () => Promise<MemoryBoardReviewStatus>
}): Promise<OpeningBoardCompletionResolution> {
  let completionError: unknown = new Error("Memory review is not complete yet.")
  try {
    const status = await input.complete()
    if (isCompletedOpeningReview(status)) return { admitted: true, status, error: null }
  } catch (error) {
    completionError = error
  }
  const status = await input.read()
  return isCompletedOpeningReview(status)
    ? { admitted: true, status, error: null }
    : { admitted: false, status, error: completionError }
}

/**
 * Transfer a durable opening receipt into exactly one client owner. A local
 * hold resolves without dispatch; after reload the composer consumes the
 * server-owned receipt by hash.
 */
export function consumeOpeningPromptOwnership(
  status: MemoryBoardReviewStatus,
  held: HeldStudyPrompt | null,
): void {
  const ownership = getOpeningPromptOwnership(status)
  if (!ownership) return
  if (held) {
    if (status.openingPrompt?.phase !== "dispatch_pending") {
      held.markExternallyPrepared(ownership.reviewId)
    }
    return
  }
  markStudyPromptServerOwned(ownership.chatId, ownership.reviewId, ownership.promptHash)
}

/**
 * One admission seam shared by the mounted gate and its tests. It deliberately
 * short-circuits before even reading study progress on non-chat surfaces, and
 * short-circuits before Board state once freezing/post-session has started.
 */
export async function loadStudyBoardGate(
  route: { pathname: string; condition: string | null; studyMode: boolean },
  dependencies: {
    progress: () => Promise<StudyBoardProgress>
    boardReview: (taskId: string) => Promise<MemoryBoardReviewStatus>
  },
): Promise<StudyBoardGateLoadResult | null> {
  const chatId = getStudyBoardChatId(route.pathname)
  if (route.condition !== "memosync" || route.studyMode !== true || !chatId) return null
  const progress = await dependencies.progress()
  if (!isOpenStudyBoardProgress(progress)) return null
  return {
    taskId: progress.activeTaskId,
    chatId,
    status: await dependencies.boardReview(progress.activeTaskId),
  }
}

type StudyBoardGateState =
  | { routeKey: string; kind: "checking" }
  | { routeKey: string; kind: "admitted" }
  | { routeKey: string; kind: "closed" }
  | { routeKey: string; kind: "error"; message: string }
  | {
      routeKey: string
      kind: "review_required"
      taskId: string
      chatId: string
      status: MemoryBoardReviewStatus
      submitting: boolean
      actionError: string | null
    }

function BoardCheckOverlay({ error, onRetry }: { error?: string; onRetry?: () => void }) {
  return (
    <Dialog open>
      <DialogContent
        showClose={false}
        size="sm"
        aria-label="Checking Long-term Memory Management"
        overlayClassName="bg-background/60 backdrop-blur-md"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        className="rounded-2xl p-6"
      >
        <DialogTitle className="sr-only">Checking Long-term Memory Management</DialogTitle>
        <DialogDescription className="sr-only">
          The first message remains in its chat draft while the study checks pending long-term memory.
        </DialogDescription>
        {error ? (
          <div className="flex max-w-sm flex-col items-center gap-3 text-center">
            <p className="text-sm text-destructive">{error}</p>
            <Button variant="outline" onClick={onRetry}>Try again</Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking the session Memory Board…
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function OpeningPromptOwnerRecovery({ onReturn }: { onReturn: () => void }) {
  return (
    <Dialog open>
      <DialogContent
        showClose={false}
        size="sm"
        aria-label="Return to the original chat"
        overlayClassName="bg-background/60 backdrop-blur-md"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        className="rounded-2xl p-6"
      >
        <DialogTitle>Return to the original chat</DialogTitle>
        <DialogDescription>
          Your first message is still waiting in its original chat. Return there to finish its Memory Board review.
        </DialogDescription>
        <div className="mt-4 flex justify-end">
          <Button data-return-to-opening-chat="true" onClick={onReturn}>Return to original chat</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function MemoryBoardOverlay({
  embedded = false,
  blocking,
  taskId,
  chatId,
  status,
  actionError,
  submitting = false,
  pendingPrompt,
  focusedReview,
  onClose,
  onEnterSession,
  onBacklogChanged,
}: {
  /** Guide-only containment: fill the mounted demo pane instead of the viewport. */
  embedded?: boolean
  blocking: boolean
  taskId?: string
  chatId?: string
  status?: MemoryBoardReviewStatus
  actionError?: string | null
  submitting?: boolean
  /** Opening flow only: the participant's message waiting behind this review. */
  pendingPrompt?: string
  /** Manual flow only: the active in-chat Long-term review to expand. */
  focusedReview?: FocusedMemoryReviewController
  onClose?: () => void
  onEnterSession?: () => void
  onBacklogChanged?: () => void
}) {
  useSurfaceExposure({
    active: !embedded && Boolean(chatId),
    surface: "memory_board",
    chatId,
    initiator: blocking ? "system" : "participant",
    closeReason: "dialog",
  })
  useEffect(() => {
    if (!blocking && chatId) recordUiMonitor("board", { sessionId: chatId, interaction: "open" })
  }, [blocking, chatId])
  const content = (
    <div className="flex h-full max-h-full w-full min-h-0 flex-col overflow-hidden rounded-2xl bg-background">
      <MemoryBoardPage
        overlay={{
          blocking,
          taskId,
          chatId,
          status,
          actionError,
          submitting,
          pendingPrompt,
          focusedReview,
          onClose,
          onEnterSession,
          onBacklogChanged,
        }}
      />
    </div>
  )
  // Guide containment stays inside its demo pane. Production uses Radix so
  // focus is trapped and the blurred chat/composer is actually inert.
  if (embedded) return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-background/60 p-4 backdrop-blur-md md:p-8"
    >
      <div className="flex h-full max-h-full w-full max-w-5xl min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl">
        {content}
      </div>
    </div>
  )
  const policy = memoryBoardDialogPolicy(blocking)
  return (
    <Dialog open onOpenChange={(open) => {
      if (!open && !blocking) onClose?.()
    }}>
      <DialogContent
        showClose={false}
        size="lg"
        aria-label={policy.ariaLabel}
        overlayClassName="bg-background/60 backdrop-blur-md"
        className="h-[calc(100dvh-2rem)] max-h-[calc(100dvh-2rem)] max-w-5xl overflow-hidden rounded-2xl p-0 md:h-[calc(100dvh-4rem)] md:max-h-[calc(100dvh-4rem)]"
        onEscapeKeyDown={(event) => { if (!policy.dismissOnEscape) event.preventDefault() }}
        onPointerDownOutside={(event) => { if (!policy.dismissOnOutside) event.preventDefault() }}
        onInteractOutside={(event) => { if (!policy.dismissOnOutside) event.preventDefault() }}
      >
        <DialogTitle className="sr-only">{policy.ariaLabel}</DialogTitle>
        <DialogDescription className="sr-only">
          {blocking
            ? "Review pending long-term memory before the waiting message continues."
            : "Review and manage long-term memory."}
        </DialogDescription>
        {content}
      </DialogContent>
    </Dialog>
  )
}

export function memoryBoardDialogPolicy(blocking: boolean) {
  return blocking
    ? { ariaLabel: "Long-term Memory Management", dismissOnEscape: false, dismissOnOutside: false }
    : { ariaLabel: "Memory Board", dismissOnEscape: true, dismissOnOutside: true }
}

type ManualBoardState =
  | { kind: "loading" }
  | { kind: "ordinary" }
  | { kind: "error"; message: string }
  | { kind: "ready"; taskId: string; chatId: string; status: MemoryBoardReviewStatus }

/**
 * The approved E3 mid-session view: same data/status as the opening Board,
 * but always closable. Non-study MemoSync keeps the ordinary Board behavior.
 */
export function ManualMemoryBoardOverlay({
  chatId,
  focusedReview,
  onClose,
}: {
  chatId: string
  focusedReview?: FocusedMemoryReviewController
  onClose: () => void
}) {
  const policy = useConditionPolicy()
  const [state, setState] = useState<ManualBoardState>(() => policy.studyMode ? { kind: "loading" } : { kind: "ordinary" })
  const sequenceRef = useRef<StudyBoardRequestSequence | null>(null)
  if (!sequenceRef.current) sequenceRef.current = createStudyBoardRequestSequence()

  const load = useCallback(async (quiet = false) => {
    const sequence = sequenceRef.current!
    const request = sequence.begin()
    if (policy.condition !== "memosync") {
      if (sequence.isCurrent(request)) setState({ kind: "error", message: "The Memory Board is unavailable in this condition." })
      return
    }
    if (!policy.studyMode) {
      if (sequence.isCurrent(request)) setState({ kind: "ordinary" })
      return
    }
    if (!quiet) setState({ kind: "loading" })
    try {
      const loaded = await loadStudyBoardGate(
        { pathname: `/chat/${encodeURIComponent(chatId)}`, condition: policy.condition, studyMode: true },
        { progress: fetchStudyBoardProgress, boardReview: (taskId) => memoriesApi.boardReview(taskId) },
      )
      if (!sequence.isCurrent(request)) return
      if (!loaded) {
        setState({ kind: "error", message: "The Memory Board is unavailable after the session starts freezing." })
        return
      }
      setState({ kind: "ready", ...loaded })
    } catch (error) {
      if (!sequence.isCurrent(request)) return
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "Could not load the Memory Board.",
      })
    }
  }, [chatId, policy.condition, policy.studyMode])

  useEffect(() => {
    void load()
    const sequence = sequenceRef.current!
    return () => sequence.cancel()
  }, [load])

  if (state.kind === "ordinary") {
    return <MemoryBoardOverlay blocking={false} chatId={chatId} focusedReview={focusedReview} onClose={onClose} />
  }
  if (state.kind === "ready") {
    return (
      <MemoryBoardOverlay
        blocking={false}
        taskId={state.taskId}
        chatId={state.chatId}
        status={state.status}
        focusedReview={focusedReview}
        onClose={onClose}
        onBacklogChanged={() => void load(true)}
      />
    )
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 px-6 backdrop-blur-md">
      <div className="flex max-w-sm flex-col items-center gap-3 rounded-2xl border border-border bg-background p-6 text-center shadow-2xl">
        {state.kind === "loading" ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading the Memory Board…
          </p>
        ) : (
          <p className="text-sm text-destructive">{state.message}</p>
        )}
        <div className="flex gap-2">
          <Button variant="outline" onClick={onClose}>Close</Button>
          {state.kind === "error" ? <Button onClick={() => void load()}>Try again</Button> : null}
        </div>
      </div>
    </div>
  )
}

/**
 * Mounted inside StudyRouteBoundary. Only an exact /chat/:id route can ask
 * for Board data; guide, study brief, questionnaire, freezing, frozen, and
 * post-session routes never issue a Board request or mount live memory.
 *
 * 2026-08-19 evening revision (E1): the gate no longer takes over the route.
 * The chat renders immediately; the Board state loads in the background. Only
 * when the participant SENDS the first prompt of an unreviewed task does the
 * gate capture that prompt and open the Board modal over a blurred backdrop —
 * completing the review dispatches the held prompt automatically. The
 * server-side studyPromptGate remains the admission authority.
 */
export function StudyBoardGate() {
  const policy = useConditionPolicy()
  const location = useLocation()
  const navigate = useNavigate()
  const chatId = getStudyBoardChatId(location.pathname)
  const routeKey = `${location.pathname}|${chatId ?? "none"}`
  const eligibleRoute = policy.condition === "memosync" && policy.studyMode === true && chatId !== null
  const [state, setState] = useState<StudyBoardGateState>({ routeKey: "", kind: "checking" })
  const [held, setHeld] = useState<HeldStudyPrompt | null>(null)
  const heldRef = useRef<HeldStudyPrompt | null>(null)
  const openingPreparationClaimsRef = useRef<OpeningPreparationClaims | null>(null)
  if (!openingPreparationClaimsRef.current) {
    openingPreparationClaimsRef.current = createOpeningPreparationClaims()
  }
  const resumedOpeningRef = useRef<Set<string>>(new Set())
  const stateRef = useRef(state)
  stateRef.current = state
  const openingReviewId = state.kind === "review_required"
    ? state.status.openingPrompt?.reviewId ?? null
    : null
  const focusedReview = useRegisteredFocusedMemoryReview(chatId, openingReviewId)
  const sequenceRef = useRef<StudyBoardRequestSequence | null>(null)
  if (!sequenceRef.current) sequenceRef.current = createStudyBoardRequestSequence()

  const check = useCallback(async () => {
    const sequence = sequenceRef.current!
    const request = sequence.begin()
    if (!eligibleRoute || !chatId) {
      if (sequence.isCurrent(request)) setState({ routeKey, kind: "closed" })
      return
    }
    setState({ routeKey, kind: "checking" })
    try {
      const loaded = await loadStudyBoardGate(
        { pathname: location.pathname, condition: policy.condition, studyMode: policy.studyMode },
        {
          progress: fetchStudyBoardProgress,
          boardReview: (taskId) => memoriesApi.boardReview(taskId),
        },
      )
      if (!sequence.isCurrent(request)) return
      if (!loaded) {
        setState({ routeKey, kind: "closed" })
        return
      }
      consumeOpeningPromptOwnership(loaded.status, heldRef.current)
      const openingReviewIncomplete = Boolean(
        loaded.status.openingPrompt && loaded.status.openingPrompt.phase !== "completed",
      )
      setState(loaded.status.reviewed && !openingReviewIncomplete
        ? { routeKey, kind: "admitted" }
        : {
            routeKey,
            kind: "review_required",
            taskId: loaded.taskId,
            chatId: loaded.chatId,
            status: loaded.status,
            submitting: false,
            actionError: null,
          })
    } catch (error) {
      if (!sequence.isCurrent(request)) return
      setState({
        routeKey,
        kind: "error",
        message: error instanceof Error ? error.message : "Could not verify the Memory Board.",
      })
    }
  }, [chatId, eligibleRoute, location.pathname, policy.condition, policy.studyMode, routeKey])

  useEffect(() => {
    if (!eligibleRoute) return
    void check()
    const onFocus = () => { void check() }
    window.addEventListener("focus", onFocus)
    const sequence = sequenceRef.current!
    return () => {
      sequence.cancel()
      window.removeEventListener("focus", onFocus)
    }
  }, [check, eligibleRoute])

  // The composer asks this seam before dispatching. Fail-closed: while the
  // background check is unsettled (or errored), the prompt is captured and the
  // modal shows progress/retry instead of racing the review receipt.
  useEffect(() => {
    if (!eligibleRoute) return
    setStudyPromptInterceptor((submission) => {
      const current = stateRef.current
      const kind = current.routeKey !== routeKey ? "checking" : current.kind
      if (kind === "admitted") return undefined
      if (kind === "closed") {
        return Promise.reject(new Error("This study session is no longer accepting prompts."))
      }
      if (!studyGateCapturesPrompt(kind)) return undefined
      if (heldRef.current) {
        return Promise.reject(new Error("Your first message is already waiting for the Memory Board review."))
      }
      const next = createHeldStudyPrompt(submission)
      heldRef.current = next
      setHeld(next)
      if (kind === "error") void check()
      return next.promise
    })
    return () => {
      setStudyPromptInterceptor(null)
      heldRef.current?.abandon()
      heldRef.current = null
    }
  }, [check, eligibleRoute, routeKey])

  // A route change abandons the captured prompt — it belonged to the chat the
  // participant left, and replaying it elsewhere would misattribute the send.
  useEffect(() => {
    heldRef.current?.abandon()
    heldRef.current = null
    setHeld(null)
  }, [routeKey])

  // Review was explicitly admitted while a prompt is held: let it go once.
  useEffect(() => {
    if (!held) return
    if (state.routeKey === routeKey && state.kind === "admitted") {
      if (heldRef.current !== held) return
      heldRef.current = null
      setHeld(null)
      void held.release()
    }
  }, [held, routeKey, state])

  // Once every pre-existing durable row is settled, bind and dispatch the
  // exact held prompt behind the same Board. The composer promise deliberately
  // remains pending: Candidate → Transfer → Checkup and final Continue still
  // own the participant-visible boundary.
  useEffect(() => {
    if (!held || state.kind !== "review_required") return
    if (state.status.pending.total > 0 && !state.status.openingPrompt) return
    const preparationClaims = openingPreparationClaimsRef.current!
    const current = state
    const existing = current.status.openingPrompt
    const preparationClaim = preparationClaims.claim(
      held,
      existing?.reviewId,
      () => crypto.randomUUID(),
    )
    if (!preparationClaim.claimed) return
    const reviewId = preparationClaim.reviewId
    let cancelled = false
    const prepare = async () => {
      try {
        if (existing && existing.chatId !== current.chatId) {
          throw new Error("The waiting first message belongs to another study chat.")
        }
        let status = current.status
        if (!existing) {
          status = await memoriesApi.prepareBoardReview(
            current.taskId,
            current.chatId,
            reviewId,
            held.submission.content,
            held.submission.attachments ?? [],
            held.submission.dispatchOptions,
          )
          if (cancelled || heldRef.current !== held) return
          setState((latest) => latest.kind === "review_required" && latest.taskId === current.taskId
            ? { ...latest, status, actionError: null }
            : latest)
        }
        if (status.openingPrompt?.phase === "dispatch_pending") {
          await held.prepare(reviewId)
        } else if (status.openingPrompt) {
          // `/prepare` eagerly starts the server-owned exact dispatch. If its
          // response has already advanced, ChatInput must not send the same
          // prompt again without the opening review id on final Continue.
          held.markExternallyPrepared(reviewId)
        }
        if (cancelled || heldRef.current !== held) return
        const refreshed = await memoriesApi.boardReview(current.taskId)
        if (cancelled || heldRef.current !== held) return
        setState((latest) => latest.kind === "review_required" && latest.taskId === current.taskId
          ? { ...latest, status: refreshed, actionError: null }
          : latest)
      } catch (error) {
        if (cancelled) return
        const message = error instanceof Error ? error.message : "Could not prepare the waiting message."
        try {
          const status = await memoriesApi.boardReview(current.taskId)
          if (cancelled || heldRef.current !== held) return
          const opening = status.openingPrompt
          if (
            opening
            && opening.chatId === current.chatId
            && opening.phase !== "dispatch_pending"
          ) {
            consumeOpeningPromptOwnership(status, held)
            setState((latest) => latest.kind === "review_required" && latest.taskId === current.taskId
              ? { ...latest, status, actionError: null }
              : latest)
            return
          }
        } catch {
          // The original prepare error is the actionable participant-facing
          // failure; a failed reconciliation must not start another attempt.
        }
        if (cancelled || heldRef.current !== held) return
        setState({ routeKey, kind: "error", message })
      }
    }
    void prepare()
    return () => { cancelled = true }
  }, [held, state])

  // Long-term preparation finishes asynchronously in AgentCoordinator. Poll
  // only while this exact blocking Board owns the route; manual Boards keep
  // their existing event-driven refresh behavior.
  useEffect(() => {
    if (state.kind !== "review_required" || !state.status.openingPrompt) return
    if (state.status.openingPrompt.phase === "completed") return
    const timer = window.setInterval(() => {
      void memoriesApi.boardReview(state.taskId).then((status) => {
        setState((latest) => latest.kind === "review_required" && latest.taskId === state.taskId
          ? { ...latest, status }
          : latest)
      }).catch(() => undefined)
    }, 500)
    return () => window.clearInterval(timer)
  }, [
    state.kind === "review_required" ? state.taskId : null,
    state.kind === "review_required" ? state.status.openingPrompt?.reviewId : null,
    state.kind === "review_required" ? state.status.openingPrompt?.phase : null,
  ])

  useEffect(() => {
    if (held || state.kind !== "review_required") return
    const ownership = getOpeningPromptOwnership(state.status)
    if (ownership) {
      markStudyPromptServerOwned(ownership.chatId, ownership.reviewId, ownership.promptHash)
    }
  }, [
    held,
    state.kind === "review_required" ? state.status.openingPrompt?.reviewId : null,
    state.kind === "review_required" ? state.status.openingPrompt?.promptHash : null,
  ])

  // Browser reload loses the local HeldStudyPrompt but not the server-owned
  // exact payload. Ask the server to re-prime that same review id; this never
  // reconstructs participant text in the client and is idempotent with the
  // prepare route's eager dispatch.
  useEffect(() => {
    if (held || state.kind !== "review_required") return
    const openingPrompt = state.status.openingPrompt
    if (!openingPrompt) return
    if (openingPrompt.chatId !== chatId) return
    const phase = openingPrompt.phase
    if (phase !== "dispatch_pending" && phase !== "preparing") return
    const recoveryKey = `${state.taskId}:${openingPrompt.reviewId}`
    if (resumedOpeningRef.current.has(recoveryKey)) return
    resumedOpeningRef.current.add(recoveryKey)
    void memoriesApi.resumeBoardReview(state.taskId).catch((error) => {
      resumedOpeningRef.current.delete(recoveryKey)
      setState((latest) => latest.kind === "review_required" && latest.taskId === state.taskId
        ? { ...latest, actionError: error instanceof Error ? error.message : "Could not resume the waiting message." }
        : latest)
    })
  }, [chatId, held, state])

  const enterSession = useCallback(async () => {
    if (state.kind !== "review_required") return
    const current = state
    const openingPrompt = current.status.openingPrompt
    if (!openingPrompt || openingPrompt.phase !== "long_term_ready") return
    setState({ ...current, submitting: true, actionError: null })
    try {
      const resolution = await completeOpeningBoardReviewWithReconciliation({
        complete: () => memoriesApi.completeBoardReview(
          current.taskId,
          openingPrompt.chatId,
          openingPrompt.reviewId,
        ),
        read: () => memoriesApi.boardReview(current.taskId),
      })
      if (!resolution.admitted) {
        setState({
          ...current,
          status: resolution.status,
          submitting: false,
          actionError: resolution.error instanceof Error
            ? resolution.error.message
            : "Could not enter the session.",
        })
        return
      }
      consumeOpeningPromptOwnership(resolution.status, heldRef.current)
      recordUiMonitor("board_enter_session", { sessionId: current.chatId, interaction: "click" })
      setState({ routeKey, kind: "admitted" })
    } catch (error) {
      setState({
        routeKey,
        kind: "error",
        message: error instanceof Error ? error.message : "Could not verify the Memory Board.",
      })
    }
  }, [routeKey, state])

  const retry = useCallback(() => {
    const currentHeld = heldRef.current
    if (currentHeld) openingPreparationClaimsRef.current!.retry(currentHeld)
    void check()
  }, [check])

  const refreshBacklog = useCallback(async () => {
    if (state.kind !== "review_required") return
    const current = state
    try {
      const status = await memoriesApi.boardReview(current.taskId)
      setState((latest) => latest.kind === "review_required" && latest.taskId === current.taskId
        ? { ...latest, status, actionError: null }
        : latest)
    } catch (error) {
      setState((latest) => latest.kind === "review_required" && latest.taskId === current.taskId
        ? {
            ...latest,
            actionError: error instanceof Error ? error.message : "Could not refresh the Memory Board.",
          }
        : latest)
    }
  }, [state])

  // Nothing renders until a prompt is actually captured: entering the chat,
  // reading, and typing are all free. The modal exists only between "send"
  // and "review complete".
  const durableOpeningReview = state.kind === "review_required"
    && state.status.openingPrompt !== undefined
    && state.status.openingPrompt.phase !== "completed"
  if (!eligibleRoute || (!held && !durableOpeningReview)) return null
  if (state.routeKey !== routeKey || state.kind === "checking") return <BoardCheckOverlay />
  if (state.kind === "error") return <BoardCheckOverlay error={state.message} onRetry={retry} />
  if (state.kind === "admitted" || state.kind === "closed") return null
  const openingPromptReturnRoute = chatId
    ? getOpeningPromptReturnRoute(state.status, chatId)
    : null
  if (openingPromptReturnRoute) {
    return <OpeningPromptOwnerRecovery onReturn={() => navigate(openingPromptReturnRoute)} />
  }
  return (
    <MemoryBoardOverlay
      blocking
      taskId={state.taskId}
      chatId={state.chatId}
      status={state.status}
      actionError={state.actionError}
      submitting={state.submitting}
      pendingPrompt={held?.submission.content}
      focusedReview={focusedReview}
      onEnterSession={() => void enterSession()}
      onBacklogChanged={() => void refreshBacklog()}
    />
  )
}
