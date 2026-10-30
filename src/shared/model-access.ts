// Model access: which agent executable each engine runs, and which model
// endpoint it talks to. Shared by the server (runtime resolution, storage,
// WebSocket topic) and the client (Settings → Providers, composer picker).
//
// Two independent choices per engine:
//   1. Executable — the user's installed CLI (`claude`, `codex`) found on this
//      machine, an explicit path, or the SDK's bundled CLI as a last resort.
//   2. Access — the user's own sign-in to that agent ("account"), or an API
//      connection the user configured (base URL + key + models) ("connection").
//      Connection mode always runs in a MemoSync-owned profile so the user's
//      own CLI configuration is never read or changed.
//
// Native protocols take precedence; Chat translation is a fallback for Claude and Codex.

export type EngineId = "claude" | "codex" | "pi"

/** Wire protocol an endpoint speaks. */
export type ApiProtocol = "anthropic-messages" | "openai-responses" | "openai-chat"

/** Protocols each engine can use without translation, in preference order. */
export const ENGINE_PROTOCOLS: Readonly<Record<EngineId, readonly ApiProtocol[]>> = {
  claude: ["anthropic-messages"],
  codex: ["openai-responses"],
  pi: ["openai-chat", "openai-responses"],
}

/** Fallback protocols translated by the loopback gateway. Pi uses native endpoints. */
export const ENGINE_TRANSLATED_PROTOCOLS: Readonly<Record<EngineId, readonly ApiProtocol[]>> = {
  claude: ["openai-chat"], codex: ["openai-chat"], pi: [],
}

export function connectionSupport(engine: EngineId, connection: Pick<ApiConnection, "endpoints">): "native" | "translated" | "unsupported" {
  if (endpointForEngine(engine, connection)) return "native"
  return connection.endpoints.some(e => ENGINE_TRANSLATED_PROTOCOLS[engine].includes(e.protocol)) ? "translated" : "unsupported"
}

/** The upstream endpoint, preferring native access. Does not start the gateway. */
export function compatibleEndpointForEngine(engine: EngineId, connection: Pick<ApiConnection, "endpoints">): ConnectionEndpoint | null {
  return endpointForEngine(engine, connection) ?? connection.endpoints.find(e => ENGINE_TRANSLATED_PROTOCOLS[engine].includes(e.protocol)) ?? null
}

/** Engines that can use the agent's own sign-in. Pi has none. */
export const ENGINES_WITH_ACCOUNT_MODE: readonly EngineId[] = ["claude", "codex"]

export interface ConnectionEndpoint {
  protocol: ApiProtocol
  /** Root URL as the vendor documents it, e.g. "https://api.deepseek.com/anthropic"
   * or "https://api.openai.com/v1". No trailing slash. */
  baseUrl: string
  /** Anthropic-protocol endpoints differ: official Anthropic wants `x-api-key`,
   * many compatible gateways want a Bearer token. Default "bearer". */
  authHeader?: "bearer" | "x-api-key"
}

export interface ConnectionModel {
  id: string
  label?: string
  /** Full context window in tokens, if known. Drives compaction settings. */
  contextWindow?: number
  maxOutputTokens?: number
  supportsReasoning?: boolean
  supportsImages?: boolean
}

/** A configured connection as the client sees it. Never carries the secret. */
export interface ApiConnection {
  id: string
  name: string
  /** Preset this connection was created from, if any. */
  presetId?: string
  endpoints: ConnectionEndpoint[]
  models: ConnectionModel[]
  /** Where the key comes from: stored by MemoSync, an environment variable, or none. */
  keySource: "stored" | "env" | "none"
  /** For keySource "env": the variable name (read-only in the UI). */
  envKeyName?: string
  /** Connections derived from environment variables can't be edited in the UI. */
  readOnly?: boolean
}

/** Create or update a connection. `apiKey`: undefined = keep, null = remove, string = set. */
export interface ApiConnectionInput {
  id?: string
  name: string
  presetId?: string
  endpoints: ConnectionEndpoint[]
  models: ConnectionModel[]
  apiKey?: string | null
}

/** A vendor MemoSync already knows: creating a connection from it only asks for the key. */
export interface ConnectionPreset {
  id: string
  name: string
  kind: "vendor" | "relay" | "local"
  endpoints: ConnectionEndpoint[]
  models: ConnectionModel[]
  /** Where the user gets a key. */
  keysUrl?: string
  /** Local servers (Ollama, LM Studio): a key is optional. */
  noKey?: boolean
  /** Environment variable that older MemoSync setups used for this vendor. */
  legacyEnvKey?: string
}

export type EngineAccess =
  | { mode: "account" }
  | { mode: "connection"; connectionId: string; defaultModel?: string }

export interface EngineSetup {
  access: EngineAccess
  /** Explicit executable path; null/undefined = discover automatically. */
  executablePath?: string | null
}

export type ExecutableState = "ready" | "missing" | "broken" | "incompatible" | "not-needed"

export interface ExecutableStatus {
  state: ExecutableState
  path?: string
  version?: string
  /** How it was found. "bundled" = the Claude Agent SDK's own CLI (fallback). */
  source?: "configured" | "path" | "known-dir" | "bundled"
  minimumVersion?: string
  /** Human-readable reason for broken/incompatible/missing (English; the client localizes by state). */
  detail?: string
}

export interface EngineStatus {
  engine: EngineId
  setup: EngineSetup
  executable: ExecutableStatus
  /** True when a turn on this engine can start right now. */
  ready: boolean
  /** Connection uses the local protocol translation gateway. */
  translated?: boolean
  /** Why it isn't ready, as a stable code the client translates. */
  problem?:
    | "executable-missing"
    | "executable-incompatible"
    | "executable-broken"
    | "connection-missing"
    | "connection-key-missing"
    | "connection-protocol-unsupported"
    | "account-signed-out"
}

/** Snapshot published on the "model-access" WebSocket topic. */
export interface ModelAccessSnapshot {
  connections: ApiConnection[]
  engines: Record<EngineId, EngineStatus>
  presets: ConnectionPreset[]
}

export interface ConnectionTestResult {
  ok: boolean
  protocol: ApiProtocol
  latencyMs?: number
  /** Stable code: "unauthorized" | "not-found" | "network" | "model-unavailable" | "unknown". */
  errorCode?: string
  /** Raw provider message, shown as detail. */
  message?: string
}

/** True when an engine can use a connection without protocol translation. */
export function endpointForEngine(engine: EngineId, connection: Pick<ApiConnection, "endpoints">): ConnectionEndpoint | null {
  for (const protocol of ENGINE_PROTOCOLS[engine]) {
    const endpoint = connection.endpoints.find(candidate => candidate.protocol === protocol)
    if (endpoint) return endpoint
  }
  return null
}
