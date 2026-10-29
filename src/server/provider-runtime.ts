import { existsSync, mkdirSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, relative, resolve, sep } from "node:path"
import { getDataRootDir } from "../shared/branding"
import { deriveDeepSeekEngineEnv } from "./deepseek-engine-env"

type RuntimeEnv = Readonly<Record<string, string | undefined>>

export const GLM_CODEX_BASE_URL = "https://open.bigmodel.cn/api/v1"
export const DEFAULT_GLM_MODEL = "glm-5.3-flash"

export function isCliIsolationEnabled(env: RuntimeEnv = process.env): boolean {
  return env.MEMOSYNC_ISOLATE_CLI === "1" || Boolean(env.MEMOSYNC_CLI_PROFILE_DIR?.trim())
}

/** Read-only path lookup, also used when checking whether a fork can resume. */
export function resolveClaudeConfigDir(env: RuntimeEnv = process.env, homeDir = homedir()): string {
  if (isCliIsolationEnabled(env)) {
    return join(resolve(env.MEMOSYNC_CLI_PROFILE_DIR?.trim() || join(getDataRootDir(homeDir, env), "cli-profiles")), "claude")
  }
  return env.CLAUDE_CONFIG_DIR?.trim() || join(homeDir, ".claude")
}

/** Explicit official model picks cannot inherit a previously derived vendor route. */
export function resolveOfficialClaudeEnv(baseEnv: RuntimeEnv = process.env): Record<string, string | undefined> {
  const env = { ...baseEnv }
  if (baseEnv.MEMOSYNC_USE_OWN_ANTHROPIC !== "1") {
    for (const key of Object.keys(env)) {
      if (key.startsWith("ANTHROPIC_") || key === "CLAUDE_CODE_SUBAGENT_MODEL" ||
        key === "CLAUDE_CODE_AUTO_COMPACT_WINDOW") delete env[key]
    }
  }
  assertIsolatedClaudeCredentials(env)
  return env
}

function canonicalPath(path: string): string {
  if (existsSync(path)) return realpathSync(path)
  const parent = dirname(path)
  return join(canonicalPath(parent), relative(parent, path))
}

function contains(parent: string, child: string): boolean {
  const remainder = relative(parent, child)
  return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${sep}`) && !remainder.startsWith(sep))
}

/** Stable across the main session and its forks; never reuse a host CLI home. */
function prepareProfileDir(engine: "claude" | "codex", env: RuntimeEnv): string {
  const root = resolve(env.MEMOSYNC_CLI_PROFILE_DIR?.trim() || join(getDataRootDir(homedir(), env), "cli-profiles"))
  const target = canonicalPath(join(root, engine))
  const protectedPaths = [join(homedir(), ".claude"), join(homedir(), ".codex")]
  // An explicitly inherited host profile must not accidentally become the test profile.
  for (const value of [env.CLAUDE_CONFIG_DIR, env.CODEX_HOME]) {
    if (value?.trim() && !contains(canonicalPath(root), canonicalPath(resolve(value)))) {
      protectedPaths.push(resolve(value))
    }
  }
  if (protectedPaths.some((path) => contains(canonicalPath(path), target))) {
    throw new Error("MEMOSYNC_CLI_PROFILE_DIR must be separate from your Claude and Codex configuration directories")
  }
  mkdirSync(target, { recursive: true, mode: 0o700 })
  return target
}

const CLAUDE_RUNTIME_SETTINGS = new Set([
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_EFFORT_LEVEL",
])

/** Called before per-chat provider routing. No mutation of process.env or host configuration. */
export function buildIsolatedClaudeEnv(baseEnv: RuntimeEnv = process.env): Record<string, string | undefined> {
  const env = { ...baseEnv }
  if (!isCliIsolationEnabled(baseEnv)) return env

  for (const key of Object.keys(env)) {
    if (key === "CLAUDECODE" || key.startsWith("CODEX_") || key.startsWith("OPENAI_") ||
      ((key.startsWith("CLAUDE_") || key.startsWith("ANTHROPIC_")) && !CLAUDE_RUNTIME_SETTINGS.has(key))) {
      delete env[key]
    }
  }
  if (baseEnv.MEMOSYNC_USE_OWN_ANTHROPIC === "1") {
    // Deliberately supplied API settings only; OAuth, cloud-provider auth and custom headers
    // do not cross this boundary. These settings also cover Anthropic-compatible gateways.
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL"]) {
      if (baseEnv[key]) env[key] = baseEnv[key]
    }
  } else {
    Object.assign(env, deriveDeepSeekEngineEnv(baseEnv) ?? {})
  }
  env.CLAUDE_CONFIG_DIR = prepareProfileDir("claude", baseEnv)
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"
  return env
}

/** Validate after model routing, before any SDK subprocess can consult saved credentials. */
export function assertIsolatedClaudeCredentials(env: RuntimeEnv): void {
  if (isCliIsolationEnabled(env) && !env.ANTHROPIC_API_KEY?.trim() && !env.ANTHROPIC_AUTH_TOKEN?.trim()) {
    throw new Error("Isolated Claude requires an explicit provider API key; configure GLM_API_KEY, DEEPSEEK_API_KEY, or MEMOSYNC_USE_OWN_ANTHROPIC=1 with ANTHROPIC_API_KEY")
  }
}

interface CodexProvider {
  baseUrl: string
  envKey: "GLM_API_KEY" | "MEMOSYNC_CODEX_API_KEY"
  model: string
}

function isolatedCodexProvider(env: RuntimeEnv): CodexProvider {
  const provider = env.MEMOSYNC_CODEX_PROVIDER?.trim() || (env.GLM_API_KEY?.trim() ? "glm" : "custom")
  if (provider === "glm") {
    if (!env.GLM_API_KEY?.trim()) throw new Error("Isolated Codex with GLM requires GLM_API_KEY")
    return {
      baseUrl: env.GLM_CODEX_BASE_URL?.trim() || GLM_CODEX_BASE_URL,
      envKey: "GLM_API_KEY",
      model: env.MEMOSYNC_CODEX_MODEL?.trim() || env.CODEX_MODEL?.trim() || env.GLM_MODEL?.trim() || DEFAULT_GLM_MODEL,
    }
  }
  if (provider !== "custom") throw new Error("MEMOSYNC_CODEX_PROVIDER must be glm or custom")
  if (!env.MEMOSYNC_CODEX_API_KEY?.trim() || !env.MEMOSYNC_CODEX_BASE_URL?.trim() ||
    !(env.MEMOSYNC_CODEX_MODEL?.trim() || env.CODEX_MODEL?.trim())) {
    throw new Error("Isolated Codex requires GLM_API_KEY or all of MEMOSYNC_CODEX_API_KEY, MEMOSYNC_CODEX_BASE_URL and MEMOSYNC_CODEX_MODEL; host login is not used")
  }
  return {
    baseUrl: env.MEMOSYNC_CODEX_BASE_URL.trim(),
    envKey: "MEMOSYNC_CODEX_API_KEY",
    model: env.MEMOSYNC_CODEX_MODEL?.trim() || env.CODEX_MODEL!.trim(),
  }
}

export function resolveCodexRuntimeModel(model: string, env: RuntimeEnv = process.env): string {
  return isCliIsolationEnabled(env) ? isolatedCodexProvider(env).model : env.CODEX_MODEL || model
}

/** Config travels as argv values, credentials as env values. No config/auth file is written. */
export function prepareCodexRuntime(baseEnv: RuntimeEnv = process.env): {
  env: Record<string, string | undefined>
  args: string[]
  model?: string
} {
  if (!isCliIsolationEnabled(baseEnv)) return { env: { ...baseEnv }, args: ["app-server"] }
  const provider = isolatedCodexProvider(baseEnv)
  const env = { ...baseEnv }
  for (const key of Object.keys(env)) {
    if (key === "CLAUDECODE" || key.startsWith("CLAUDE_") || key.startsWith("ANTHROPIC_") ||
      key.startsWith("OPENAI_") || key.startsWith("CODEX_") || key.startsWith("CHATGPT_")) delete env[key]
  }
  env.CODEX_HOME = prepareProfileDir("codex", baseEnv)
  // This exact provider is command-line configuration so project config cannot select
  // OpenAI auth instead. env_key never reads auth.json or the system credential store.
  const config: Record<string, string | boolean> = {
    model: provider.model,
    model_provider: "memosync_isolated",
    cli_auth_credentials_store: "ephemeral",
    check_for_update_on_startup: false,
    "model_providers.memosync_isolated.name": "MemoSync isolated provider",
    "model_providers.memosync_isolated.base_url": provider.baseUrl,
    "model_providers.memosync_isolated.env_key": provider.envKey,
    "model_providers.memosync_isolated.wire_api": "responses",
    "model_providers.memosync_isolated.requires_openai_auth": false,
    "model_providers.memosync_isolated.supports_websockets": false,
  }
  return {
    env,
    args: ["app-server", ...Object.entries(config).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`])],
    model: provider.model,
  }
}
