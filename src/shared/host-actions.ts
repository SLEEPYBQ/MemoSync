/** MemoSync host views v1. No URL, external application, write, or execution action. */
export const HOST_ACTION_CAPABILITY = "readonly-file-snapshot-v1" as const
export const HOST_ACTION_TOOL_NAMES = {
  openFile: "memosync_open_file",
  actionStatus: "memosync_action_status",
} as const

export interface HostOpenFileInput {
  /** Omitted means the admitted chat's workspace. Never an arbitrary filesystem root. */
  workspaceRef?: string
  path: string
  view?: "source" | "preview"
  selection?: { startLine: number; endLine?: number }
  /** Retry key scoped to the immutable admission and native engine instance. */
  idempotencyKey?: string
}

export interface HostSnapshotVersion {
  /** Both fields describe the exact immutable UTF-8 bytes returned by readSnapshot. */
  version: string
  digest: string
  origin: "snapshot"
  byteLength: number
  mediaType: "text/plain" | "text/markdown"
}
export interface HostFileSnapshot extends HostSnapshotVersion {
  content: string
}
export type HostActionStatus = "accepted" | "presented" | "unavailable" | "rejected" | "failed" | "cancelled" | "expired" | "unknown"
export interface HostActionReceipt {
  operationId: string
  status: HostActionStatus
  delivery: "not-sent" | "sent" | "stopped"
  cancellation: "none" | "requested" | "confirmed"
  target?: { workspaceRef: string; path: string }
  observedContent?: HostSnapshotVersion
  /** A stopped delivery can later gain this old-operation fact without being re-delivered. */
  presented?: { at: number; viewInstanceId: string; fileVersion: string; digest: string }
  reason?: string
  expiresAt?: number
}
export interface HostActionRequested {
  v: 1
  type: "host.action.requested"
  operationId: string
  chatId: string
  turnId: string
  generation: number
  targetClientId: string
  expiresAt: number
  action: {
    kind: "open_file"
    workspaceRef: string
    path: string
    view: "source" | "preview"
    selection?: { startLine: number; endLine?: number }
  }
  snapshot: HostSnapshotVersion
}
export interface HostActionUpdated {
  v: 1
  type: "host.action.updated"
  chatId: string
  targetClientId: string
  receipt: HostActionReceipt
}
export type HostActionServerEvent = HostActionRequested | HostActionUpdated

/** Sent over the existing authenticated WS command/ack transport. No model/client supplied clientId. */
export type HostActionCommand =
  | { type: "host.actions.bind"; resumeToken?: string; capabilities: typeof HOST_ACTION_CAPABILITY[] }
  | { type: "host.action.readSnapshot"; operationId: string }
  | { type: "host.action.presented"; operationId: string; viewInstanceId: string; fileVersion: string; digest: string }
  | { type: "host.action.status"; operationId: string }

/** Keep the resume token private to this browser window (e.g. sessionStorage). */
export interface HostActionClientBinding { clientId: string; resumeToken: string }

/** Parent UI contract: use a separate immutable readonly tab, preserve existing dirty tabs.
 * Resolve only after render commits. Deduplicate operationId across reconnects. Never navigate
 * from host.action.updated (a late ACK is historical). Stop pending presentation on a
 * stopped receipt, local expiry, chat/generation change, or an aborted signal. A replay of
 * an already rendered operation should repeat its exact ACK without navigating again.
 * Render Markdown without raw HTML,
 * embedded network resources, executable content, or automatic link navigation.
 */
export interface HostActionWorkbenchController {
  presentReadonlySnapshot(request: HostActionRequested, snapshot: HostFileSnapshot, signal: AbortSignal): Promise<{
    viewInstanceId: string
    fileVersion: string
    digest: string
  }>
}

/** Trusted adapter metadata; supplied by native callbacks, never tool arguments. */
export interface HostNativeToolContext {
  engineInstanceId: string
  nativeSessionId: string
  nativeToolCallId: string
  nativeTurnId?: string
}
