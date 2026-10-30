import type { ApiConnection, EngineId, EngineSetup } from "../../shared/model-access"
import type { LlmProviderSnapshot } from "../../shared/types"
import { CONNECTION_PRESETS } from "./presets"

export type RuntimeEnv = Readonly<Record<string, string | undefined>>
export const LEGACY_PI_ID = "env-llm-provider"

export function legacyConnections(env: RuntimeEnv, pi?: LlmProviderSnapshot | null): ApiConnection[] {
  const out: ApiConnection[] = []
  const add = (id: string, preset: string, key: string, endpoints?: ApiConnection["endpoints"], models?: ApiConnection["models"]) => {
    if (!env[key]?.trim()) return
    const p = CONNECTION_PRESETS.find(p => p.id === preset)
    out.push({ id, name: `${p?.name ?? preset} (env)`, presetId: preset, endpoints: endpoints ?? p?.endpoints ?? [], models: models ?? p?.models ?? [], keySource: "env", envKeyName: key, readOnly: true })
  }
  const deepseekBase = (env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com").replace(/\/+$/, "")
  add("env-deepseek", "deepseek", "DEEPSEEK_API_KEY", [
    { protocol: "anthropic-messages", baseUrl: `${deepseekBase}/anthropic` },
    { protocol: "openai-responses", baseUrl: `${deepseekBase}/v1` },
    { protocol: "openai-chat", baseUrl: `${deepseekBase}/v1` },
  ], [...new Set([env.DEEPSEEK_MODEL?.trim() || "deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp"])].map(id => ({ id, contextWindow: 1_048_576, supportsReasoning: true })))
  add("env-glm", "zhipu", "GLM_API_KEY", [
    { protocol: "anthropic-messages", baseUrl: env.GLM_BASE_URL?.trim() || "https://open.bigmodel.cn/api/anthropic" },
    { protocol: "openai-responses", baseUrl: env.GLM_CODEX_BASE_URL?.trim() || "https://open.bigmodel.cn/api/v1" },
    { protocol: "openai-chat", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4" },
  ], [...new Set([
    env.GLM_MODEL?.trim() || "glm-5.3-flash", "glm-5.3",
    // MEMOSYNC_CODEX_PROVIDER=glm points Codex here; its configured model must be one this connection lists.
    ...(env.MEMOSYNC_CODEX_PROVIDER === "glm" ? [env.MEMOSYNC_CODEX_MODEL?.trim() || env.CODEX_MODEL?.trim()].filter((id): id is string => Boolean(id)) : []),
  ])].map(id => ({ id, contextWindow: 1_000_000, supportsReasoning: true })))
  if (env.MEMOSYNC_USE_OWN_ANTHROPIC === "1" || (!env.DEEPSEEK_API_KEY && (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN))) {
    const key = env.ANTHROPIC_AUTH_TOKEN?.trim() ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY"
    add("env-anthropic", "anthropic", key, [{ protocol: "anthropic-messages", baseUrl: env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com", authHeader: key === "ANTHROPIC_API_KEY" ? "x-api-key" : "bearer" }], [{ id: env.ANTHROPIC_MODEL?.trim() || "sonnet" }])
  }
  add("env-codex", "openai", "MEMOSYNC_CODEX_API_KEY", [{ protocol: "openai-responses", baseUrl: env.MEMOSYNC_CODEX_BASE_URL?.trim() || "https://api.openai.com/v1" }], [{ id: env.MEMOSYNC_CODEX_MODEL?.trim() || env.CODEX_MODEL?.trim() || "gpt-5.5" }])
  add("env-openrouter", "openrouter", "OPENROUTER_API_KEY", undefined, [{ id: "anthropic/claude-sonnet-4.6" }])
  if (pi?.apiKey && pi.resolvedBaseUrl) out.push({ id: LEGACY_PI_ID, name: "Model Registry (legacy)", endpoints: [{ protocol: "openai-chat", baseUrl: pi.resolvedBaseUrl }], models: [{ id: pi.model }], readOnly: true, keySource: "env" })
  return out
}

export function legacyEngineSetup(engine: EngineId, env: RuntimeEnv, connections: ApiConnection[]): EngineSetup {
  let id: string | undefined
  if (engine === "claude") id = env.MEMOSYNC_USE_OWN_ANTHROPIC === "1" ? "env-anthropic" : connections.some(c => c.id === "env-deepseek") ? "env-deepseek" : connections.some(c => c.id === "env-anthropic") ? "env-anthropic" : "env-glm"
  if (engine === "codex") id = env.MEMOSYNC_CODEX_PROVIDER === "glm" ? "env-glm" : env.MEMOSYNC_CODEX_PROVIDER === "custom" ? "env-codex" : connections.some(c => c.id === "env-codex") ? "env-codex" : "env-glm"
  if (engine === "pi") id = connections.some(c => c.id === LEGACY_PI_ID) ? LEGACY_PI_ID : "env-openrouter"
  const c = connections.find(c => c.id === id)
  if (engine === "codex" && env.MEMOSYNC_CODEX_PROVIDER && !c) return { access: { mode: "connection", connectionId: id! } }
  return c ? { access: { mode: "connection", connectionId: c.id, defaultModel: engine === "codex" ? env.MEMOSYNC_CODEX_MODEL?.trim() || env.CODEX_MODEL?.trim() || c.models[0]?.id : c.models[0]?.id } } : { access: { mode: "account" } }
}

// Compatibility API for older scripts; new launches use resolveEngineRuntime.
export const DEEPSEEK_ANTHROPIC_PATH = "/anthropic"

// Compaction budget for the 1M window (only effective on a [1m] model id).
// If long sessions
// repeatedly drop mid-stream around ~500k (observed once), fall back to
// "400000" so compaction lands below that range.
export const DEEPSEEK_AUTO_COMPACT_WINDOW = "786432"

export function deriveDeepSeekEngineEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> | null {
  const apiKey = env.DEEPSEEK_API_KEY?.trim()
  if (!apiKey) return null
  if (env.MEMOSYNC_USE_OWN_ANTHROPIC === "1") return null

  const base = (env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com").replace(/\/+$/, "")
  const model = env.DEEPSEEK_MODEL?.trim() || "deepseek-v4-flash"
  return {
    ANTHROPIC_BASE_URL: `${base}${DEEPSEEK_ANTHROPIC_PATH}`,
    // Claude Code reads AUTH_TOKEN; Anthropic-compatible SDK callers read
    // API_KEY. Both intentionally originate from the one DeepSeek credential.
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ANTHROPIC_API_KEY: apiKey,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    // Haiku-class and subagent work goes to Flash regardless of the main
    // model, matching the official guide (cheap sidecar traffic).
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-flash",
    ANTHROPIC_SMALL_FAST_MODEL: "deepseek-v4-flash",
    CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-v4-flash",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: env.CLAUDE_CODE_AUTO_COMPACT_WINDOW?.trim() || DEEPSEEK_AUTO_COMPACT_WINDOW,
  }
}


// Compatibility API for older scripts; new launches use resolveEngineRuntime.
export const KNOWN_CATALOG_PREFIXES = ["deepseek-", "glm-"] as const

/** True for any model id the picker can offer (DeepSeek or GLM). Used to keep a
 * catalog pick from being overridden by the DeepSeek env default, while still
 * letting a foreign own-Anthropic model (MEMOSYNC_USE_OWN_ANTHROPIC) win. */
export function isKnownCatalogModel(modelId: string): boolean {
  return KNOWN_CATALOG_PREFIXES.some((prefix) => modelId.startsWith(prefix))
}

export interface ChatProviderRoute {
  /** ANTHROPIC_BASE_URL for this vendor's Anthropic-compatible endpoint. */
  baseUrl: string
  /** The vendor's API key, from its own env var (may be undefined if unset). */
  apiKey: string | undefined
  /** CLAUDE_CODE_AUTO_COMPACT_WINDOW for this vendor. */
  autoCompactWindow: string
  /** Cheap model for haiku-class / subagent traffic on this vendor. */
  subagentModel: string
  /** CLI context-window selector; both DeepSeek and current GLM require it. */
  appendOneMillionSuffix: boolean
}

/**
 * The endpoint override for a non-default vendor, or null for DeepSeek /
 * own-Anthropic (whose ANTHROPIC_* already live in process.env from boot).
 */
export function resolveChatProviderRoute(
  modelId: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ChatProviderRoute | null {
  if (modelId.startsWith("glm-")) {
    return {
      // Domestic 智谱 BigModel endpoint — reachable from mainland China without
      // a VPN. Override with GLM_BASE_URL for Z.AI (https://api.z.ai/api/anthropic).
      baseUrl: env.GLM_BASE_URL?.trim() || "https://open.bigmodel.cn/api/anthropic",
      apiKey: env.GLM_API_KEY?.trim() || undefined,
      // https://docs.bigmodel.cn/cn/coding-plan/latest-model specifies both
      // the [1m] selector and this compact window for current Claude Code.
      autoCompactWindow: env.GLM_AUTO_COMPACT_WINDOW?.trim() || "1000000",
      subagentModel: env.GLM_SUBAGENT_MODEL?.trim() || "glm-5.3-flash",
      appendOneMillionSuffix: true,
    }
  }
  return null
}

/** Version/executable probes never receive provider credentials. */
export function executableEnvironment(base: RuntimeEnv): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(base).filter(([key]) =>
    !/^(ANTHROPIC_|OPENAI_|DEEPSEEK_|GLM_|OPENROUTER_)/.test(key)
    && !/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD|SECRET_ACCESS_KEY)$/.test(key),
  ))
}
