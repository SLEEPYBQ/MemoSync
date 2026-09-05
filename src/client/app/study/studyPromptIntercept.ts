// Held-prompt interception seam (2026-08-19 evening revision, E1): the opening
// Memory Board no longer takes over the chat route. The chat is freely usable;
// the FIRST prompt of an unreviewed task is captured here, the Board modal
// runs over a blurred backdrop, and the captured prompt is dispatched
// automatically once the review receipt is written. The server-side
// studyPromptGate stays the admission authority — this seam only shapes the
// participant-facing information flow.
import type { AgentProvider, ChatAttachment, ModelOptions } from "../../../shared/types"

export interface StudyPromptSubmission {
  /** Participant-authored text shown back to them while the opening Board holds it. */
  content: string
  /** Exact upload records sent with this draft; the server binds them into the opening claim. */
  attachments?: ChatAttachment[]
  /** Exact composer dispatch preferences retained for process-restart recovery. */
  dispatchOptions?: {
    provider?: AgentProvider
    model?: string
    modelOptions?: ModelOptions
    planMode?: boolean
  }
  /** The real chat send. Its rejection must reach ChatInput so the draft is restored. */
  dispatch: (openingReviewId?: string) => Promise<void>
}

type StudyPromptInterceptor = (submission: StudyPromptSubmission) => Promise<void> | undefined

let interceptor: StudyPromptInterceptor | null = null

export interface StudyPromptDraftSnapshot {
  content: string
  attachments: unknown[]
}

export interface StudyPromptServerOwnership {
  openingReviewId: string
  promptHash: string
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

/** Browser equivalent of the server's immutable opening-prompt hash. */
export async function hashStudyPromptDraft(input: StudyPromptDraftSnapshot): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson({
    content: input.content,
    attachments: input.attachments,
  }))
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * Hash first, then compare the live draft again after the async boundary. A
 * participant edit that races a delayed Board GET is therefore preserved.
 */
export async function settleServerOwnedStudyPromptDraft(input: {
  promptHash: string
  getCurrent: () => StudyPromptDraftSnapshot
  clear: (matched: StudyPromptDraftSnapshot) => void
}): Promise<boolean> {
  const candidate = structuredClone(input.getCurrent())
  if (await hashStudyPromptDraft(candidate) !== input.promptHash) return false
  if (canonicalJson(input.getCurrent()) !== canonicalJson(candidate)) return false
  input.clear(candidate)
  return true
}

type ServerOwnershipListener = (ownership: StudyPromptServerOwnership) => void
const pendingServerOwnership = new Map<string, StudyPromptServerOwnership>()
const deliveredServerOwnership = new Set<string>()
const serverOwnershipListeners = new Map<string, Set<ServerOwnershipListener>>()

/**
 * A reload destroys the local HeldStudyPrompt, but the durable opening claim
 * still owns the exact composer text and uploads. Hand that authority back to
 * the mounted composer once so it can clear the stale local draft instead of
 * offering the already-dispatched prompt for a second send.
 */
export function markStudyPromptServerOwned(chatId: string, openingReviewId: string, promptHash: string): void {
  if (!promptHash) return
  const receiptKey = `${chatId}:${openingReviewId}`
  if (deliveredServerOwnership.has(receiptKey)) return
  deliveredServerOwnership.add(receiptKey)
  const listeners = serverOwnershipListeners.get(chatId)
  if (!listeners?.size) {
    pendingServerOwnership.set(chatId, { openingReviewId, promptHash })
    return
  }
  pendingServerOwnership.delete(chatId)
  for (const listener of listeners) listener({ openingReviewId, promptHash })
}

/** Late subscribers consume a pending server receipt synchronously. */
export function subscribeStudyPromptServerOwnership(
  chatId: string,
  listener: ServerOwnershipListener,
): () => void {
  const listeners = serverOwnershipListeners.get(chatId) ?? new Set<ServerOwnershipListener>()
  listeners.add(listener)
  serverOwnershipListeners.set(chatId, listeners)
  const pending = pendingServerOwnership.get(chatId)
  if (pending) {
    pendingServerOwnership.delete(chatId)
    listener(pending)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) serverOwnershipListeners.delete(chatId)
  }
}

/** Mounted StudyBoardGate registers itself; null on unmount. */
export function setStudyPromptInterceptor(next: StudyPromptInterceptor | null) {
  interceptor = next
}

/**
 * One submit seam for ChatInput. When the opening Board captures a message,
 * this promise stays pending until that exact message is either dispatched or
 * deliberately abandoned with its chat. Dispatch failures therefore travel
 * back to ChatInput's existing draft-restoration path.
 */
export function submitStudyPrompt(submission: StudyPromptSubmission): Promise<void> {
  return interceptor?.(submission) ?? submission.dispatch()
}

export interface HeldStudyPrompt {
  readonly submission: StudyPromptSubmission
  readonly promise: Promise<void>
  /** Dispatch behind the Board once, but leave the composer promise pending. */
  prepare(openingReviewId: string): Promise<void>
  /** Server already owns this review's exact dispatch; Continue only settles the composer promise. */
  markExternallyPrepared(openingReviewId: string): void
  /** Dispatch once; later calls observe the same terminal promise. */
  release(): Promise<void>
  /** Reject without dispatch when the participant leaves the owning chat. */
  abandon(reason?: string): void
}

/**
 * Small lifecycle module for one held first message. React owns when to show
 * the Board; this object owns the async contract the composer is awaiting.
 */
export function createHeldStudyPrompt(submission: StudyPromptSubmission): HeldStudyPrompt {
  let state: "held" | "preparing" | "prepared" | "released" | "abandoned" = "held"
  let preparation: Promise<void> | null = null
  let resolvePromise!: () => void
  let rejectPromise!: (reason: unknown) => void
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })

  return {
    submission,
    promise,
    prepare(openingReviewId) {
      if (preparation) return preparation
      if (state !== "held") return Promise.reject(new Error("The waiting first message is no longer available for preparation."))
      state = "preparing"
      preparation = Promise.resolve()
        .then(() => submission.dispatch(openingReviewId))
        .then(
          () => {
            if (state === "preparing") state = "prepared"
          },
          (error) => {
            if (state !== "abandoned") {
              state = "abandoned"
              rejectPromise(error)
            }
            throw error
          },
        )
      return preparation
    },
    markExternallyPrepared(_openingReviewId) {
      if (state === "held") state = "prepared"
    },
    release() {
      if (state === "released" || state === "abandoned") return promise
      if (state === "preparing") {
        state = "released"
        void preparation!.then(resolvePromise, () => undefined)
        return promise
      }
      if (state === "prepared") {
        state = "released"
        resolvePromise()
        return promise
      }
      state = "released"
      void Promise.resolve()
        .then(() => submission.dispatch())
        .then(resolvePromise, rejectPromise)
      return promise
    },
    abandon(reason = "The message stayed in its original chat draft because you left before memory review finished.") {
      if (state === "released" || state === "abandoned") return
      if (state === "preparing") {
        // The opening-id dispatch is already crossing the server boundary.
        // Resolve only if that preparation is accepted; a real rejection
        // still restores the draft through ChatInput's normal error path.
        state = "released"
        void preparation!.then(resolvePromise, rejectPromise)
        return
      }
      if (state === "prepared") {
        // Server authority has replaced local hold ownership. Unmount/back
        // must settle the composer as accepted, never resurrect its draft.
        state = "released"
        resolvePromise()
        return
      }
      state = "abandoned"
      rejectPromise(new Error(reason))
    },
  }
}

/**
 * Fail-closed capture rule: only a settled "nothing pending" state lets a
 * prompt through. While the gate is still checking (or failed to check), the
 * prompt is captured and the modal shows progress/retry instead of racing the
 * durable review receipt.
 */
export type StudyPromptAdmissionKind = "checking" | "review_required" | "admitted" | "closed" | "error"

export function studyGateCapturesPrompt(stateKind: StudyPromptAdmissionKind): boolean {
  return stateKind === "checking" || stateKind === "review_required" || stateKind === "error"
}
