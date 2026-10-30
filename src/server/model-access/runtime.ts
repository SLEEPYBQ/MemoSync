// Adapted from Magpie (https://github.com/yetone/magpie), MIT License, Copyright (c) 2026 yetone
// internal/agent/claude.go and codex.go: native provider mapping, child env/argv only.
import type { ApiConnection, ConnectionEndpoint, ConnectionModel, EngineId, ExecutableStatus } from "../../shared/model-access"
import { endpointForEngine } from "../../shared/model-access"
import type { PiConnection } from "../pi-agent"
import { isCliIsolationEnabled, prepareProfileDir } from "../provider-runtime"
import { executableLauncher } from "./executables"
import type { ExecutableLauncher } from "./launcher"
import { connectionNeedsKey, getModelAccessService, ModelAccessService, validateConnection } from "./service"
import { executableEnvironment, type RuntimeEnv } from "./legacy"

export interface EngineRuntime {
  engine: EngineId
  executable: ExecutableStatus
  env: Record<string, string | undefined>
  args: string[]
  model: string
  isolated: boolean
  connectionId?: string
  piConnection?: PiConnection
  /** How to start a Codex executable: a JS entry needs a runtime even on a GUI's node-less PATH. */
  launcher?: ExecutableLauncher
}

// An inherited environment is a capability, not a serialized credential bundle.
// Forks and compatibility helpers reuse the resolved runtime instead of resolving again.
const resolved = new WeakMap<object, EngineRuntime>()
export function runtimeForEnv(env?: RuntimeEnv) { return env ? resolved.get(env) : undefined }
export function rememberRuntime(runtime: EngineRuntime) { resolved.set(runtime.env, runtime); return runtime }

export function cleanConnectionEnv(base: RuntimeEnv): Record<string, string | undefined> {
  const env = { ...base }
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDE_|CODEX_|OPENAI_|CHATGPT_)/.test(key) || key === "CLAUDECODE" || /(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET)$/.test(key) || key === "MEMOSYNC_CODEX_API_KEY") delete env[key]
  }
  return env
}

export function claudeConnectionEnv(base: RuntimeEnv, endpoint: ConnectionEndpoint, key: string | undefined, model: ConnectionModel, connectionId?: string) {
  const env = cleanConnectionEnv(base)
  const bare = model.id.replace(/\[1m\]$/, "")
  const legacyDeepseek = connectionId === "env-deepseek"
  const legacyGlm = connectionId === "env-glm"
  const small = legacyDeepseek ? "deepseek-v4-flash" : legacyGlm ? base.GLM_SUBAGENT_MODEL?.trim() || "glm-5.3-flash" : bare
  Object.assign(env, {
    ANTHROPIC_BASE_URL: endpoint.baseUrl,
    [endpoint.authHeader === "x-api-key" ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN"]: key,
    ANTHROPIC_MODEL: bare,
    ANTHROPIC_DEFAULT_OPUS_MODEL: bare, ANTHROPIC_DEFAULT_SONNET_MODEL: bare,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: small, ANTHROPIC_SMALL_FAST_MODEL: small, CLAUDE_CODE_SUBAGENT_MODEL: small,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  })
  if (model.contextWindow) {
    env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(model.contextWindow)
    env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = legacyDeepseek ? base.CLAUDE_CODE_AUTO_COMPACT_WINDOW || "786432" : legacyGlm ? base.GLM_AUTO_COMPACT_WINDOW || "1000000" : String(Math.floor(model.contextWindow * 0.8))
  }
  if (model.maxOutputTokens) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(Math.min(model.maxOutputTokens, 128000))
  if (connectionId === "env-anthropic") {
    for (const name of ["ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_AUTO_COMPACT_WINDOW"]) {
      if (base[name]?.trim()) env[name] = base[name]
    }
  }
  if (base.CLAUDE_CODE_EFFORT_LEVEL) env.CLAUDE_CODE_EFFORT_LEVEL = base.CLAUDE_CODE_EFFORT_LEVEL
  return { env, model: (model.contextWindow ?? 0) >= 1_000_000 ? `${bare}[1m]` : model.id }
}

async function withLauncher(runtime: EngineRuntime): Promise<EngineRuntime> {
  if (runtime.engine === "codex" && runtime.executable.path && !runtime.launcher) {
    runtime.launcher = await executableLauncher(runtime.executable.path, executableEnvironment(runtime.env))
  }
  return rememberRuntime(runtime)
}

export async function resolveEngineRuntime(input: {
  engine: EngineId; model?: string; connectionId?: string; env?: RuntimeEnv; service?: ModelAccessService; inherited?: EngineRuntime
}): Promise<EngineRuntime> {
  if (input.inherited) {
    if (input.inherited.engine !== input.engine) throw new Error("engine-runtime-mismatch")
    return input.inherited
  }
  const previous = runtimeForEnv(input.env)
  if (previous?.engine === input.engine) return previous
  const service = input.service ?? (input.env ? undefined : getModelAccessService()) ?? await new ModelAccessService({ env: input.env }).initialize()
  const base = input.env ?? service.env
  const setup = service.setup(input.engine)
  let access = setup.access
  if (input.connectionId) access = { mode: "connection", connectionId: input.connectionId }
  else if (!service.hasExplicitSetup(input.engine) && input.model && input.engine === "claude") {
    // Old chats saved a vendor model, before connectionId existed.
    const legacy = input.model.startsWith("glm-") ? "env-glm" : input.model.startsWith("deepseek-") ? "env-deepseek" : undefined
    if (legacy && (service.connection(legacy) || access.mode === "connection") && !(base.MEMOSYNC_USE_OWN_ANTHROPIC === "1" && legacy === "env-deepseek")) access = { mode: "connection", connectionId: legacy }
    else if (/^(sonnet|opus|haiku|claude-)/.test(input.model) && base.MEMOSYNC_USE_OWN_ANTHROPIC !== "1") access = { mode: "account" }
  }
  const executable = await service.resolveExecutable(input.engine, setup, executableEnvironment(base))
  if (!["ready", "not-needed"].includes(executable.state)) throw new Error(`executable-${executable.state}`)
  if (access.mode === "account") {
    if (input.engine === "pi") throw new Error("connection-missing")
    if (isCliIsolationEnabled(base)) throw new Error("account-signed-out")
    // Own CLI login/profile; never inject a vendor or inherit ambient API credentials.
    const env = cleanConnectionEnv(base)
    if (base.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = base.CLAUDE_CONFIG_DIR
    if (base.CODEX_HOME) env.CODEX_HOME = base.CODEX_HOME
    return withLauncher({ engine: input.engine, executable, env, args: input.engine === "codex" ? ["app-server"] : [], model: (input.engine === "codex" ? base.CODEX_MODEL : undefined) || input.model || (input.engine === "claude" ? "sonnet" : "gpt-5.5"), isolated: false })
  }
  const connection: ApiConnection | undefined = service.connection(access.connectionId)
  if (!connection) throw new Error("connection-missing")
  validateConnection(connection)
  const endpoint = endpointForEngine(input.engine, connection)
  if (!endpoint) throw new Error("connection-protocol-unsupported")
  const key = await service.getKey(connection.id)
  if (!key && connectionNeedsKey(connection)) throw new Error("connection-key-missing")
  const requested = input.model?.replace(/\[1m\]$/, "")
  const defaultModel = access.defaultModel && ((input.engine === "pi" && connection.readOnly) || connection.models.some(m => m.id === access.defaultModel)) ? access.defaultModel : undefined
  const selected = requested && (input.engine === "pi" || connection.models.some(m => m.id === requested)) ? requested : defaultModel || connection.models[0]?.id || requested
  if (!selected) throw new Error("model-unavailable")
  // Legacy Pi registry accepts arbitrary model ids, including a cold remote catalog.
  if (input.connectionId && requested && !(input.engine === "pi" && connection.readOnly) && connection.models.length && !connection.models.some(m => m.id === requested)) throw new Error("model-unavailable")
  const model: ConnectionModel = connection.models.find(m => m.id === selected) ?? { id: selected }
  const runtime: EngineRuntime = { engine: input.engine, executable, env: cleanConnectionEnv(base), args: [], model: model.id, isolated: true, connectionId: connection.id }
  const profileEnv = { ...base, MEMOSYNC_CLI_PROFILE_DIR: base.MEMOSYNC_CLI_PROFILE_DIR || `${service.dataDir}/cli-profiles` }
  if (input.engine === "claude") {
    const mapped = claudeConnectionEnv(base, endpoint, key, model, connection.id)
    runtime.env = mapped.env; runtime.model = mapped.model
    runtime.env.CLAUDE_CONFIG_DIR = prepareProfileDir("claude", profileEnv)
  } else if (input.engine === "codex") {
    runtime.env.CODEX_HOME = prepareProfileDir("codex", profileEnv)
    // Fixed variable name is the only credential reference in argv.
    runtime.env.MEMOSYNC_MODEL_API_KEY = key
    const config: Record<string, string | number | boolean> = {
      model: model.id, model_provider: "memosync", cli_auth_credentials_store: "ephemeral", check_for_update_on_startup: false,
      "model_providers.memosync.name": "MemoSync", "model_providers.memosync.base_url": endpoint.baseUrl,
      "model_providers.memosync.env_key": "MEMOSYNC_MODEL_API_KEY", "model_providers.memosync.wire_api": "responses",
      "model_providers.memosync.requires_openai_auth": false, "model_providers.memosync.supports_websockets": false,
    }
    if (!key) delete config["model_providers.memosync.env_key"]
    if (model.contextWindow) { config.model_context_window = model.contextWindow; config.model_auto_compact_token_limit = Math.floor(model.contextWindow * 0.8) }
    if (model.supportsReasoning !== undefined) config.model_supports_reasoning_summaries = model.supportsReasoning
    runtime.args = ["app-server", ...Object.entries(config).flatMap(([k, v]) => ["-c", `${k}=${JSON.stringify(v)}`])]
  } else {
    runtime.piConnection = { provider: connection.presetId === "openrouter" || connection.id === "env-openrouter" ? "openrouter" : "custom", baseUrl: endpoint.baseUrl, apiKey: key || "", protocol: endpoint.protocol === "openai-responses" ? "openai-responses" : "openai-chat", contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens }
  }
  return withLauncher(runtime)
}
