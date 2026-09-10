// Per-chat provider routing for the main Claude Code engine.
//
// The deployment's default vendor is DeepSeek: its Anthropic-compatible
// endpoint + key are derived into process.env once at boot
// (deepseek-engine-env.ts), and every DeepSeek chat inherits that env.
//
// A GLM chat instead needs its OWN endpoint + key injected into just that
// session's subprocess env — because each Claude session is a separate
// subprocess with its own env, we can route per chat without a second server.
// Memory branches inherit the main session's resolved provider environment.
//
// Adding a vendor = one entry here + its models in the shared catalog
// (src/shared/types.ts). Keep the model-id prefixes in sync with
// KNOWN_CATALOG_PREFIXES.

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
