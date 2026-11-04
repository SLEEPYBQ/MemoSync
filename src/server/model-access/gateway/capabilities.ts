import type { ConnectionEndpoint } from "../../../shared/model-access"

export interface ChatCapabilities {
  provider: "openai" | "deepseek" | "unknown"
  instructionRoles: "system-and-developer" | "system" | "leading-system"
  promptCacheKey: boolean
  promptCacheRetention: readonly string[]
  implicitCacheOptions: boolean
}

export const UNKNOWN_CHAT_CAPABILITIES: ChatCapabilities = {
  provider: "unknown", instructionRoles: "leading-system", promptCacheKey: false,
  promptCacheRetention: [], implicitCacheOptions: false,
}

/** Resolve against the actual endpoint, never a preset label or a model name alone.
 * Custom/relay endpoints stay conservative until their behavior is verified.
 * Sources (2026-11-05):
 * https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
 * https://developers.openai.com/api/docs/guides/prompt-caching
 * https://api-docs.deepseek.com/api/create-chat-completion
 * Responses-only options (prewarm, longer TTLs) are deliberately not inferred here.
 */
export function chatCapabilities(endpoint: ConnectionEndpoint, model: string): ChatCapabilities {
  const url = new URL(endpoint.baseUrl)
  if (endpoint.protocol !== "openai-chat" || url.protocol !== "https:" || url.port || !["", "/", "/v1", "/v1/"].includes(url.pathname)) return UNKNOWN_CHAT_CAPABILITIES
  if (url.hostname === "api.deepseek.com") return {
    ...UNKNOWN_CHAT_CAPABILITIES, provider: "deepseek", instructionRoles: "system",
  }
  if (url.hostname !== "api.openai.com") return UNKNOWN_CHAT_CAPABILITIES
  // Only known model families opt in. A new/aliased model must not acquire
  // protocol features merely because its configured provider is OpenAI.
  const gpt = model.match(/^gpt-(\d+)(?:\.(\d+))?(?:-|$)/)
  const major = gpt ? Number(gpt[1]) : 0, minor = gpt ? Number(gpt[2] ?? 0) : 0
  const modern = major >= 5 || /^o[134](?:-|$)/.test(model)
  const extendedRetention = /^(?:gpt-5\.5(?:-pro)?|gpt-5\.4|gpt-5\.2|gpt-5\.1(?:-codex(?:-max|-mini)?|-chat-latest)?|gpt-5(?:-codex)?|gpt-4\.1)(?:-\d{4}-\d{2}-\d{2})?$/.test(model)
  return {
    provider: "openai", instructionRoles: modern ? "system-and-developer" : "leading-system",
    promptCacheKey: modern || /^gpt-4(?:o|\.1)(?:-|$)/.test(model),
    // The locked SDK and current API docs disagree on the spelling of memory
    // retention. Only forward the verified 24h policy on the documented models.
    promptCacheRetention: extendedRetention || major > 5 || (major === 5 && minor >= 5) ? ["24h"] : [],
    implicitCacheOptions: major > 5 || (major === 5 && minor >= 6),
  }
}

export interface TranslationDiagnostic {
  code: "unsupported_cache_option" | "instruction_role_changed" | "instruction_position_changed"
  path: string
  message: string
}

export function addDiagnostic(diagnostics: TranslationDiagnostic[], diagnostic: TranslationDiagnostic) {
  if (!diagnostics.some(d => d.code === diagnostic.code && d.path === diagnostic.path)) diagnostics.push(diagnostic)
}
