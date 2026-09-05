// Local deployments talk to DeepSeek with ONE credential: DEEPSEEK_API_KEY.
// The Claude Code engine (Agent SDK subprocess) authenticates through
// ANTHROPIC_* variables, so entrypoints call this once at boot to derive the
// full engine bundle from that single key — exactly the wiring the Docker
// compose file used to hardcode. Users never install or log in to Claude Code;
// the SDK ships its own runtime and these variables take precedence over any
// host login.
//
// DEEPSEEK_API_KEY wins over stray ANTHROPIC_* variables: many machines carry
// leftover ANTHROPIC_BASE_URL exports from other Claude Code setups, and
// letting those silently hijack the engine produced "model may not exist"
// failures against endpoints that never heard of deepseek-*. When we derive,
// we overwrite the whole bundle coherently. Operators who really want their
// own ANTHROPIC_* setup say so explicitly with MEMOSYNC_USE_OWN_ANTHROPIC=1.
import { DEFAULT_DEEPSEEK_MODEL_ID } from "../shared/types"

export const DEEPSEEK_ANTHROPIC_PATH = "/anthropic"

// Compaction budget for the 1M window (only effective on a [1m] model id).
// 786432 is DeepSeek's own documented value for Claude Code — the researcher
// chose it 2026-08-24 over the more conservative 400k. If long sessions
// repeatedly drop mid-stream around ~500k (observed once), fall back to
// "400000" so compaction lands below that range.
export const DEEPSEEK_AUTO_COMPACT_WINDOW = "786432"

export function deriveDeepSeekEngineEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> | null {
  const apiKey = env.DEEPSEEK_API_KEY?.trim()
  if (!apiKey) return null
  if (env.MEMOSYNC_USE_OWN_ANTHROPIC === "1") return null

  const base = (env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com").replace(/\/+$/, "")
  const model = env.DEEPSEEK_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL_ID
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
    ANTHROPIC_DEFAULT_HAIKU_MODEL: DEFAULT_DEEPSEEK_MODEL_ID,
    ANTHROPIC_SMALL_FAST_MODEL: DEFAULT_DEEPSEEK_MODEL_ID,
    CLAUDE_CODE_SUBAGENT_MODEL: DEFAULT_DEEPSEEK_MODEL_ID,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: env.CLAUDE_CODE_AUTO_COMPACT_WINDOW?.trim() || DEEPSEEK_AUTO_COMPACT_WINDOW,
  }
}

/** Apply the derived bundle to process.env (no-op without a DeepSeek key or
 * with MEMOSYNC_USE_OWN_ANTHROPIC=1). Returns what was applied. */
export function applyDeepSeekEngineEnvDefaults(): Record<string, string> | null {
  const derived = deriveDeepSeekEngineEnv(process.env)
  if (!derived) return null
  const displaced = process.env.ANTHROPIC_BASE_URL?.trim()
  if (displaced && displaced !== derived.ANTHROPIC_BASE_URL) {
    console.log(`[engine] ignoring inherited ANTHROPIC_BASE_URL=${displaced} — DEEPSEEK_API_KEY takes precedence (set MEMOSYNC_USE_OWN_ANTHROPIC=1 to keep your own ANTHROPIC_* setup)`)
  }
  Object.assign(process.env, derived)
  console.log(`[engine] Claude Code engine → DeepSeek (${derived.ANTHROPIC_BASE_URL}, default model ${derived.ANTHROPIC_MODEL})`)
  return derived
}
