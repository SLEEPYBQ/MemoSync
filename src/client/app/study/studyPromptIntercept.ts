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

const SHA256_INITIAL_STATE = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]
const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

function rotateRight(value: number, bits: number) {
  return (value >>> bits) | (value << (32 - bits))
}

function sha256Hex(bytes: Uint8Array) {
  const bitLength = bytes.length * 8
  const paddedLength = ((bytes.length + 9 + 63) >> 6) << 6
  const padded = new Uint8Array(paddedLength)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 2 ** 32))
  view.setUint32(paddedLength - 4, bitLength >>> 0)

  const hash = [...SHA256_INITIAL_STATE]
  const words = new Uint32Array(64)
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4)
    }
    for (let index = 16; index < 64; index += 1) {
      const word15 = words[index - 15]!
      const word2 = words[index - 2]!
      const sigma0 = rotateRight(word15, 7) ^ rotateRight(word15, 18) ^ (word15 >>> 3)
      const sigma1 = rotateRight(word2, 17) ^ rotateRight(word2, 19) ^ (word2 >>> 10)
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) | 0
    }

    let [a, b, c, d, e, f, g, h] = hash
    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choose = (e & f) ^ (~e & g)
      const temp1 = (h + sigma1 + choose + SHA256_ROUND_CONSTANTS[index]! + words[index]!) | 0
      const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (sigma0 + majority) | 0
      h = g
      g = f
      f = e
      e = (d + temp1) | 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) | 0
    }
    hash[0] = (hash[0]! + a) | 0
    hash[1] = (hash[1]! + b) | 0
    hash[2] = (hash[2]! + c) | 0
    hash[3] = (hash[3]! + d) | 0
    hash[4] = (hash[4]! + e) | 0
    hash[5] = (hash[5]! + f) | 0
    hash[6] = (hash[6]! + g) | 0
    hash[7] = (hash[7]! + h) | 0
  }
  return hash.map((word) => (word >>> 0).toString(16).padStart(8, "0")).join("")
}

/** Browser equivalent of the server's immutable opening-prompt hash. */
export async function hashStudyPromptDraft(input: StudyPromptDraftSnapshot): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson({
    content: input.content,
    attachments: input.attachments,
  }))
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  }
  return sha256Hex(bytes)
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
