/**
 * MemoSync wire protocol types — trimmed copies of the shapes the mobile
 * client speaks, mirroring the host's src/shared/protocol.ts (lines 63-340)
 * and src/shared/types.ts. Keep in sync manually; the protocol is versioned
 * (`v: 1` envelopes) and additive in practice.
 */

// ---------------------------------------------------------------------------
// Envelopes (src/shared/protocol.ts lines 63-75, 308-332)
// ---------------------------------------------------------------------------

export type SubscriptionTopic =
  | { type: "sidebar"; patches?: boolean }
  | { type: "local-projects" }
  | { type: "chat"; chatId: string; recentLimit?: number }

export type ClientCommand =
  | { type: "system.ping" }
  | {
      type: "chat.send"
      memoryDisabled?: boolean
      chatId?: string
      projectId?: string
      clientTraceId?: string
      provider?: string
      content: string
      model?: string
      effort?: string
      planMode?: boolean
    }
  | { type: "chat.cancel"; chatId: string }
  | { type: "chat.markRead"; chatId: string }
  | { type: "chat.create"; projectId: string }
  | { type: "chat.loadHistory"; chatId: string; beforeCursor: string; limit: number }
  | {
      type: "message.enqueue"
      /** Interrupt via the existing message.steer path after enqueue. */
      steer?: boolean
      chatId: string
      content: string
      provider?: string
      model?: string
      planMode?: boolean
    }
  | { type: "message.steer"; chatId: string; queuedMessageId: string }
  | { type: "message.dequeue"; chatId: string; queuedMessageId: string }
  | { type: "chat.respondTool"; chatId: string; toolUseId: string; result: unknown }

export type ClientEnvelope =
  | { v: 1; type: "subscribe"; id: string; topic: SubscriptionTopic }
  | { v: 1; type: "unsubscribe"; id: string }
  | { v: 1; type: "command"; id: string; command: ClientCommand }

export type ServerSnapshot =
  | { type: "sidebar"; data: SidebarData }
  | { type: "local-projects"; data: LocalProjectsSnapshot }
  | { type: "chat"; data: ChatSnapshot | null }

export type ServerEnvelope =
  | { v: 1; type: "snapshot"; id: string; snapshot: ServerSnapshot }
  | { v: 1; type: "event"; id: string; event: unknown }
  | { v: 1; type: "ack"; id: string; result?: unknown }
  | { v: 1; type: "error"; id?: string; message: string }

// ---------------------------------------------------------------------------
// Sidebar + local projects (src/shared/types.ts lines 502-567)
// ---------------------------------------------------------------------------

export type ChatActivityStatus =
  | "idle"
  | "starting"
  /** The pre-turn memory-preview LLM pass is in flight. */
  | "previewing_memory"
  | "running"
  | "waiting_for_user"
  | "failed"

export interface SidebarChatRow {
  memoryDisabled: boolean
  chatId: string
  title: string
  status: ChatActivityStatus
  unread: boolean
  localPath: string
  provider: string | null
  lastMessageAt?: number
  hasAutomation: boolean
}

export interface SidebarProjectGroup {
  groupKey: string
  title: string
  realTitle: string
  sidebarTitle?: string
  localPath: string
  chats: SidebarChatRow[]
  previewChats: SidebarChatRow[]
  olderChats: SidebarChatRow[]
  archivedChats?: SidebarChatRow[]
  defaultCollapsed: boolean
}

export interface SidebarData {
  projectGroups: SidebarProjectGroup[]
}

export interface LocalProjectSummary {
  localPath: string
  title: string
  source: "saved" | "discovered"
  lastOpenedAt?: number
  chatCount: number
}

export interface LocalProjectsSnapshot {
  machine: {
    id: "local"
    displayName: string
    platform: string
  }
  projects: LocalProjectSummary[]
}

// ---------------------------------------------------------------------------
// Chat snapshot (src/shared/types.ts lines 112-122, 1718-1763)
// ---------------------------------------------------------------------------

export interface QueuedChatMessage {
  id: string
  content: string
  createdAt: number
  provider?: string
  model?: string
  planMode?: boolean
}

export interface ChatRuntime {
  memoryDisabled: boolean
  chatId: string
  projectId: string
  localPath: string
  title: string
  status: ChatActivityStatus
  isDraining: boolean
  provider: string | null
  planMode: boolean
  sessionToken: string | null
  /**
   * The in-flight assistant reply. REPLACEMENT-style, not deltas: each
   * snapshot carries the full accumulated text. Never overlaps the final
   * assistant_text transcript entry.
   */
  streamingText: string | null
}

export interface ChatHistorySnapshot {
  hasOlder: boolean
  olderCursor: string | null
  recentLimit: number
}

export interface ChatSnapshot {
  runtime: ChatRuntime
  queuedMessages: QueuedChatMessage[]
  messages: TranscriptEntry[]
  history: ChatHistorySnapshot
}

export interface ChatHistoryPage {
  messages: TranscriptEntry[]
  hasOlder: boolean
  olderCursor: string | null
}

// ---------------------------------------------------------------------------
// Transcript entries — the subset the mobile transcript renders, typed
// loosely where the host has a large union (memory gates etc. are ignored).
// ---------------------------------------------------------------------------

interface TranscriptEntryBase {
  /** Host wire format is the persisted event shape: `_id` + numeric createdAt. */
  _id: string
  messageId?: string
  createdAt: number
  hidden?: boolean
}

export interface UserPromptEntry extends TranscriptEntryBase {
  kind: "user_prompt"
  content: string
  /** Exact user-authored text when `content` carries a provider wrapper. */
  participantContent?: string
  steered?: boolean
}

export interface AssistantTextEntry extends TranscriptEntryBase {
  kind: "assistant_text"
  text: string
}

export interface AskUserQuestionOption {
  label: string
  description?: string
}

export interface AskUserQuestionItem {
  id?: string
  question: string
  header?: string
  options?: AskUserQuestionOption[]
  multiSelect?: boolean
}

export interface ToolCallEntry extends TranscriptEntryBase {
  kind: "tool_call"
  tool: {
    kind: string
    /** Normalized host kinds such as bash, read_file, ask_user_question. */
    toolKind?: string
    /** Stable provider tool-use id; matching tool_result entries carry it too. */
    toolId?: string
    toolName?: string
    input?: unknown
    rawInput?: Record<string, unknown>
  }
}

export interface ToolResultEntry extends TranscriptEntryBase {
  kind: "tool_result"
  toolId: string
  content: unknown
  isError?: boolean
}

export interface MemoryPreviewEntry extends TranscriptEntryBase {
  kind: "memory_preview"
  previewId: string
  task?: string
  memories?: Array<{ id: string; content: string; scope: string }>
}

export interface MemoryPreviewDecisionEntry extends TranscriptEntryBase {
  kind: "memory_preview_decision"
  previewId: string
  decision: string
}

export interface ResultEntry extends TranscriptEntryBase {
  kind: "result"
  subtype: "success" | "error" | "cancelled"
  isError: boolean
  durationMs: number
  result: string
  costUsd?: number
}

export interface StatusEntry extends TranscriptEntryBase {
  kind: "status"
  status: string
}

/** Catch-all for entries the mobile UI does not render (memory gates, system_init, …). */
export interface IgnoredEntry extends TranscriptEntryBase {
  kind: string
}

export type TranscriptEntry =
  | UserPromptEntry
  | AssistantTextEntry
  | ToolCallEntry
  | ToolResultEntry
  | MemoryPreviewEntry
  | MemoryPreviewDecisionEntry
  | ResultEntry
  | StatusEntry
  | IgnoredEntry

// ---------------------------------------------------------------------------
// Pairing REST API (frozen contract — see REMOTE_ACCESS_SPEC.md)
// ---------------------------------------------------------------------------

export interface PairingRequestResponse {
  requestId: string
  /** 12 chars from the Crockford-ish alphabet; display grouped XXXX-XXXX-XXXX. */
  code: string
}

export type PairingStatus = "pending" | "approved" | "denied" | "expired"

export interface PairingStatusResponse {
  status: PairingStatus
  /** Present only when approved; format `memosync_device_<48 hex>`. */
  token?: string
}

export interface PairingCredentials {
  host: string
  port: number
  token: string
  deviceName: string
}
