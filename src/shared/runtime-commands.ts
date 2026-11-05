import type { AgentProvider, ModelOptions } from "./types"

/** The composer's full choice, including connections and native launch options. */
export interface RuntimeCommandSelection {
  provider: AgentProvider
  model?: string
  modelOptions?: ModelOptions
  planMode?: boolean
}
export function runtimeCommandSelectionKey(selection: RuntimeCommandSelection): string {
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)])) : value
  return JSON.stringify(stable({ ...selection, planMode: Boolean(selection.planMode) }))
}

export function isRuntimeCommandSelection(value: unknown): value is RuntimeCommandSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const s = value as Record<string, unknown>
  if (Object.keys(s).some(key => !['provider', 'model', 'modelOptions', 'planMode'].includes(key))) return false
  if (typeof s.provider !== 'string' || !['claude', 'codex', 'pi', 'opencode'].includes(s.provider)) return false
  if (s.model !== undefined && (typeof s.model !== 'string' || s.model.length > 1024)) return false
  if (s.planMode !== undefined && typeof s.planMode !== 'boolean') return false
  if (s.modelOptions === undefined) return true
  const options = s.modelOptions
  if (!options || typeof options !== 'object' || Array.isArray(options)) return false
  return Object.entries(options).every(([key, v]) => {
    if (key === 'connectionId') return typeof v === 'string' && v.length <= 1024
    if (!['claude', 'codex', 'pi', 'opencode'].includes(key) || !v || typeof v !== 'object' || Array.isArray(v)) return false
    const fields = key === 'claude' ? ['connectionId', 'reasoningEffort', 'contextWindow', 'ultracode']
      : key === 'codex' ? ['connectionId', 'reasoningEffort', 'fastMode'] : key === 'pi' ? ['connectionId', 'reasoningEffort'] : []
    return Object.entries(v).every(([name, option]) => fields.includes(name) && (name === 'fastMode' || name === 'ultracode' ? typeof option === 'boolean'
      : typeof option === 'string' && option.length <= 1024))
  })
}

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
/** Public app-server review/start targets; reviews run inline on the current thread. */
export type CodexReviewTarget =
  | { type: "uncommittedChanges" }
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; sha: string; title: string | null }
  | { type: "custom"; instructions: string }
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
  route: "native-prompt" | "native-skill" | "session-command" | "compact" | "review-start" | "host-prompt"
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
  selection?: RuntimeCommandSelection
  selectionKey?: string
  preparation?: { status: "preparing" | "ready" | "error"; message?: string }
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
  | { type: "chat.readCommandCatalog"; chatId: string; refresh?: boolean; selection?: RuntimeCommandSelection }
  | ExecuteRuntimeCommand
  | { type: "chat.cancelCommand"; chatId: string; operationId: string }
