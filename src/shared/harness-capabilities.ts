import type { AgentProvider } from "./types"

/** Execution authorization is independent of memory auto/review and plan intent. */
export type NativeExecutionPolicy =
  | { engine: "claude"; permissionMode: "default" | "acceptEdits" | "dontAsk" | "bypassPermissions" | "auto" }
  | { engine: "codex"; approvalPolicy: "on-request" | "untrusted" | "never"; approvalsReviewer: "user" | "auto_review"; sandbox: "read-only" | "workspace-write" | "danger-full-access" }
  | { engine: "pi"; toolGate: "read-only" | "ask" | "allow" }
  | { engine: "opencode"; permission: "ask" | "allow" | "deny" }

export type CapabilityAvailability = "available" | "unavailable" | "needs-auth" | "unknown"
export interface CapabilityProof {
  /** Exact installed/runtime version when known; never an assumed latest version. */
  version: string
  source: string
  level: "type" | "versioned-api" | "runtime"
}
export interface HarnessCapability {
  id: string
  availability: CapabilityAvailability
  revision: number
  executionOwner: "host" | "native-engine"
  proof: CapabilityProof
  reason?: string
}
export interface ExecutionPolicyChoice extends HarnessCapability {
  label: string
  policy: NativeExecutionPolicy
  /** Tool gates do not imply subprocess or operating-system isolation. */
  boundary: "native-permissions" | "native-sandbox" | "tool-gating"
}
export interface EngineCapabilities {
  engine: AgentProvider
  revision: number
  capabilities: HarnessCapability[]
  executionPolicies: ExecutionPolicyChoice[]
}

export type PolicyStatus = "applied" | "pending" | "partial" | "rejected" | "unknown" | "unsupported"
export interface PolicyBoundaryState {
  boundary: "host-dispatch" | "native-runtime" | "existing-processes"
  status: PolicyStatus
  revision: number | null
  effectiveFrom: "immediate" | "next-turn" | "restart" | "unknown"
  nativeSessionId?: string
  turnId?: string
  generation?: number
  reason?: string
}
export interface ExecutionPolicyState {
  desired: NativeExecutionPolicy
  effective: NativeExecutionPolicy | null
  desiredRevision: number
  effectiveRevision: number | null
  status: PolicyStatus
  boundaries: PolicyBoundaryState[]
  reason?: string
}
export interface ChatHarnessSnapshot {
  capabilities: EngineCapabilities
  policy: ExecutionPolicyState
}

/** Frozen at admission. Revalidate against the current revision before dispatch/reply. */
export interface PolicyCallScope {
  chatId: string
  engine: AgentProvider
  requestId: string
  turnId: string
  generation: number
  policyRevision: number
}
export interface NativeApprovalRequest {
  scope: PolicyCallScope
  kind: "command" | "file-change" | "tool" | "permission"
  toolName: string
  input: Record<string, unknown>
  description?: string
}
export interface NativeApprovalReply {
  /** Approvals are single-call only; no blanket/session authorization. */
  decision: "allow-once" | "deny"
}

/** WS API: chat.setExecutionPolicy acknowledges desired state, not native application. */
export interface SetExecutionPolicyCommand {
  type: "chat.setExecutionPolicy"
  chatId: string
  policy: NativeExecutionPolicy
  expectedRevision: number
}
