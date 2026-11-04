import type { AgentProvider } from "./types"

/** A catalog belongs to one live native instance; never reuse a provider-wide cache. */
export interface CommandRuntimeIdentity {
  engine: AgentProvider
  nativeInstance: string
  nativeSession: string
  version: string
  profile: string
  workspace: string
  mode: string
  /** P1 effective acknowledgement, with zero denoting no native acknowledgement yet. */
  policyRevision?: number
  desiredPolicyRevision?: number
}
export interface RuntimeSourceProof {
  api: string
  version: string
  evidence: "native-response" | "public-api" | "host-config"
}
export type DiscoveryStatus = "unknown" | "ready" | "failed" | "unsupported" | "stale"
export interface RuntimeDiscovery<T> {
  status: DiscoveryStatus
  items: T[]
  source: RuntimeSourceProof
  reason?: string
}
export interface RuntimeCommand {
  id: string
  name: string
  description: string
  namespace: "native" | "skill" | "host"
  owner: "native-engine" | "memosync"
  arguments: { type: "string"; hint?: string }
  requiresIdle: boolean
  sideEffect: "model-turn" | "context-compaction"
  route: "native-prompt" | "native-skill" | "session-command" | "compact"
  source: RuntimeSourceProof
  requiredRuntimeVersion: string
  nativeSkill?: { name: string; path: string }
}
export interface RuntimeSkill {
  id: string
  name: string
  description: string
  discovered: boolean
  /** null = the native API cannot prove instruction content was loaded in this session. */
  loaded: boolean | null
  enabled: boolean | null
  instructionVersion?: string
  source: RuntimeSourceProof
}
export interface RuntimeConnector {
  id: string
  name: string
  kind: "model-provider" | "mcp" | "hosted-service"
  state: "unknown" | "discovered" | "connected" | "needs-auth" | "disabled" | "failed" | "stale-schema" | "unsupported"
  schemaRevision?: string
  source: RuntimeSourceProof
}
export interface CommandOperation {
  id: string
  commandId: string
  status: "available" | "busy" | "running" | "completed" | "failed" | "cancelled"
  phase: "native" | "restoring" | "settled"
  /** Only set after a public native append API acknowledges the current view. */
  contextRestored: boolean
  delivery?: "queued" | "native-accepted"
  reason?: string
}
export interface ChatCommandCatalog {
  runtime: CommandRuntimeIdentity | null
  runtimeKey: string | null
  /** Increases on every invalidation and completed discovery, including successful EMPTY lists. */
  revision: number
  commands: RuntimeDiscovery<RuntimeCommand>
  skills: RuntimeDiscovery<RuntimeSkill>
  connectors: RuntimeDiscovery<RuntimeConnector>
  compact: { status: "available" | "busy" | "unsupported" | "unknown"; reason?: string }
  operation: CommandOperation | null
}
export interface ExecuteRuntimeCommand {
  type: "chat.executeCommand"
  chatId: string
  runtimeKey: string
  expectedRevision: number
  commandId: string
  arguments?: string
}
export type RuntimeCatalogCommand =
  | { type: "chat.readCommandCatalog"; chatId: string; refresh?: boolean }
  | ExecuteRuntimeCommand
  | { type: "chat.cancelCommand"; chatId: string; operationId: string }
