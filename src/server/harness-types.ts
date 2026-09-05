import type { AccountInfo, AgentProvider, NormalizedToolCall, TranscriptEntry } from "../shared/types"

export interface HarnessEvent {
  type: "transcript" | "session_token" | "assistant_delta"
  entry?: TranscriptEntry
  sessionToken?: string
  /** Normalized Claude SDK turn provenance; unknown fails closed in study mode. */
  origin?: "human" | "task-notification" | "auto-continuation" | "channel" | "peer" | "coordinator" | "unknown"
  /** assistant_delta: id of the engine message item this chunk belongs to. */
  itemId?: string
  /** assistant_delta: the raw text chunk (append to same-item chunks). */
  delta?: string
}

export interface HarnessToolRequest {
  tool: NormalizedToolCall & { toolKind: "ask_user_question" | "exit_plan_mode" }
}

export interface HarnessTurn {
  provider: AgentProvider
  stream: AsyncIterable<HarnessEvent>
  getAccountInfo?: () => Promise<AccountInfo | null>
  interrupt: () => Promise<void>
  close: () => void
}
