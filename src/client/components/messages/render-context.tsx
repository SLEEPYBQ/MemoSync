import { createContext, useContext, type ReactNode } from "react"
import type {
  ExpectedMemoryUse,
  MemoryPreviewDecision,
  StandaloneTranscriptAttachmentMode,
} from "../../../shared/types"

export interface PreviewDemoDecision {
  previewId: string
  decision: MemoryPreviewDecision
  selectedIds?: string[]
  expectedUses?: ExpectedMemoryUse[]
  prompt?: string
}

/**
 * Guide-tour rendering of the injection preview card: seed its internal UI
 * state (pool expanded, prior ask-agent exchanges) and answer the ask box
 * locally, so the demo card behaves fully without server calls. Absent
 * outside the guide — live behavior is untouched.
 */
export interface PreviewDemoOptions {
  poolExpanded?: boolean
  exchanges?: Array<{ q: string; a: string }>
  /** Canned ask-box reply; its presence switches the card into demo mode. */
  reviseReply: string
  /** Guide-local decision sink. It never points at the participant API. */
  onDecision?: (decision: PreviewDemoDecision) => void
}

/**
 * Observable seam used by the production preview card in Guide mode. Live
 * previews return false and continue through their ordinary server handler;
 * Guide previews consume the decision locally.
 */
export function dispatchPreviewDemoDecision(
  options: PreviewDemoOptions | undefined,
  decision: PreviewDemoDecision,
): boolean {
  if (!options) return false
  options.onDecision?.(decision)
  return true
}

export interface TranscriptRenderOptions {
  readonly: boolean
  localLinkMode: "open" | "text"
  attachmentMode: "live" | StandaloneTranscriptAttachmentMode
  previewDemo?: PreviewDemoOptions
}

const DEFAULT_RENDER_OPTIONS: TranscriptRenderOptions = {
  readonly: false,
  localLinkMode: "open",
  attachmentMode: "live",
}

const TranscriptRenderOptionsContext = createContext<TranscriptRenderOptions>(DEFAULT_RENDER_OPTIONS)

export function TranscriptRenderOptionsProvider({
  children,
  value,
}: {
  children: ReactNode
  value: Partial<TranscriptRenderOptions>
}) {
  return (
    <TranscriptRenderOptionsContext.Provider
      value={{
        ...DEFAULT_RENDER_OPTIONS,
        ...value,
      }}
    >
      {children}
    </TranscriptRenderOptionsContext.Provider>
  )
}

export function useTranscriptRenderOptions() {
  return useContext(TranscriptRenderOptionsContext)
}

/**
 * The chat/project a transcript is rendered under. Memory review cards need it
 * to bind a re-scoped candidate to the right project/session on accept —
 * otherwise a scope change to Project/Session PATCHes without the required id
 * and the server 400s (BUG MSG-1). Undefined outside a live chat (e.g. the
 * standalone export viewer), where these controls are not shown.
 */
export interface TranscriptChatContextValue {
  chatId?: string
  projectId?: string
}

const TranscriptChatContext = createContext<TranscriptChatContextValue>({})

export function TranscriptChatContextProvider({
  children,
  value,
}: {
  children: ReactNode
  value: TranscriptChatContextValue
}) {
  return <TranscriptChatContext.Provider value={value}>{children}</TranscriptChatContext.Provider>
}

export function useTranscriptChatContext() {
  return useContext(TranscriptChatContext)
}

/**
 * memory_trace 'violated' verdicts folded back onto reply messages
 * (messageId → violated memory ids), so inline [M-NN] citation chips can show
 * the drift AT the sentence — the highest-value monitoring signal must never
 * sit behind a click. Provided by the transcript; null outside one.
 */
const ViolatedCitationsMapContext = createContext<ReadonlyMap<string, ReadonlySet<string>> | null>(null)

export function ViolatedCitationsMapProvider({
  children,
  value,
}: {
  children: ReactNode
  value: ReadonlyMap<string, ReadonlySet<string>> | null
}) {
  return <ViolatedCitationsMapContext.Provider value={value}>{children}</ViolatedCitationsMapContext.Provider>
}

export function useViolatedCitationsMap() {
  return useContext(ViolatedCitationsMapContext)
}

/** The violated ids for the ONE message currently being rendered. */
const MessageViolatedCitationsContext = createContext<ReadonlySet<string> | null>(null)

export function MessageViolatedCitationsProvider({
  children,
  value,
}: {
  children: ReactNode
  value: ReadonlySet<string> | null
}) {
  return (
    <MessageViolatedCitationsContext.Provider value={value}>{children}</MessageViolatedCitationsContext.Provider>
  )
}

export function useMessageViolatedCitations() {
  return useContext(MessageViolatedCitationsContext)
}
