import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import * as claudeSdk from "@anthropic-ai/claude-agent-sdk"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import {
  assertIsolatedClaudeCredentials,
  buildIsolatedClaudeEnv,
  prepareCodexRuntime,
  resolveOfficialClaudeEnv,
} from "./provider-runtime"
import { startClaudeSession } from "./agent"

describe("isolated CLI provider profiles", () => {
  let profile: string
  beforeEach(() => { profile = realpathSync(mkdtempSync(join(tmpdir(), "memosync-cli-test-"))) })
  afterEach(() => { rmSync(profile, { recursive: true, force: true }) })

  test("actual Claude query and model updates ignore a foreign inherited model without the own-provider opt-in", async () => {
    const queryOptions: claudeSdk.Options[] = []
    const modelUpdates: string[] = []
    const queryMock = spyOn(claudeSdk, "query").mockImplementation((input) => {
      queryOptions.push(input.options ?? {})
      return {
        async *[Symbol.asyncIterator]() {},
        close() {},
        async setModel(model: string) { modelUpdates.push(model) },
        async interrupt() {},
      } as ReturnType<typeof claudeSdk.query>
    })
    try {
      const session = await startClaudeSession({
        localPath: profile,
        model: "glm-5.3-flash",
        planMode: false,
        sessionToken: null,
        forkSession: false,
        onToolRequest: async () => ({}),
        subprocessEnv: {
          ANTHROPIC_MODEL: "claude-opus-4-6",
          GLM_API_KEY: "test-only-key",
          // Even an accidental mock failure cannot reach a real provider or host profile.
          GLM_BASE_URL: "http://127.0.0.1:1",
          CLAUDE_CONFIG_DIR: join(profile, "claude"),
          PATH: "",
        },
      })
      expect(queryMock).toHaveBeenCalledTimes(1)
      expect(queryOptions[0]?.model).toBe("glm-5.3-flash[1m]")
      expect(queryOptions[0]?.env?.ANTHROPIC_MODEL).toBe("glm-5.3-flash")
      expect(queryOptions[0]?.env?.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:1")
      expect(queryOptions[0]?.env?.ANTHROPIC_API_KEY).toBe("test-only-key")
      await session.setModel("glm-5.3")
      expect(modelUpdates).toEqual(["glm-5.3[1m]"])
      session.close()
    } finally {
      queryMock.mockRestore()
    }
  })

  test("opt-in leaves normal subscriber runtime unchanged", () => {
    const base = { CODEX_HOME: "/host/codex", CLAUDE_CONFIG_DIR: "/host/claude", OPENAI_API_KEY: "host-key" }
    expect(buildIsolatedClaudeEnv(base)).toEqual(base)
    expect(prepareCodexRuntime(base)).toEqual({ env: base, args: ["app-server"] })
  })

  test("Claude isolates state and strips inherited OAuth, provider routing and nested sessions", () => {
    const base = {
      MEMOSYNC_CLI_PROFILE_DIR: profile,
      GLM_API_KEY: "explicit-test-key",
      CLAUDE_CONFIG_DIR: "/host/claude",
      CODEX_HOME: "/host/codex",
      CLAUDE_CODE_OAUTH_TOKEN: "host-token",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_SESSION_ID: "host-session",
      CLAUDECODE: "nested",
      ANTHROPIC_AUTH_TOKEN: "host-anthropic-token",
      ANTHROPIC_BASE_URL: "https://host.example",
      OPENAI_API_KEY: "host-openai-key",
      PATH: "/usr/bin",
    }
    const env = buildIsolatedClaudeEnv(base)
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(profile, "claude"))
    expect(existsSync(env.CLAUDE_CONFIG_DIR!)).toBe(true)
    expect(env.GLM_API_KEY).toBe("explicit-test-key")
    expect(env.PATH).toBe("/usr/bin")
    for (const key of ["CODEX_HOME", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_SESSION_ID", "CLAUDECODE", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY"]) {
      expect(env[key]).toBeUndefined()
    }
    expect(base.CLAUDE_CONFIG_DIR).toBe("/host/claude")
    expect(base.ANTHROPIC_AUTH_TOKEN).toBe("host-anthropic-token")
    expect(() => assertIsolatedClaudeCredentials(env)).toThrow("explicit provider API key")
  })

  test("DeepSeek and explicit own API settings survive only as deliberate provider bundles", () => {
    const deepseek = buildIsolatedClaudeEnv({ MEMOSYNC_CLI_PROFILE_DIR: profile, DEEPSEEK_API_KEY: "test-deepseek", ANTHROPIC_AUTH_TOKEN: "wrong" })
    expect(deepseek.ANTHROPIC_AUTH_TOKEN).toBe("test-deepseek")
    expect(deepseek.ANTHROPIC_BASE_URL).toBe("https://api.deepseek.com/anthropic")
    expect(() => resolveOfficialClaudeEnv(deepseek)).toThrow("explicit provider API key")
    const own = buildIsolatedClaudeEnv({ MEMOSYNC_CLI_PROFILE_DIR: profile, MEMOSYNC_USE_OWN_ANTHROPIC: "1", ANTHROPIC_API_KEY: "explicit-anthropic", CLAUDE_CODE_OAUTH_TOKEN: "discard" })
    expect(resolveOfficialClaudeEnv(own).ANTHROPIC_API_KEY).toBe("explicit-anthropic")
    expect(own.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  test("Codex uses Responses with environment credentials and never writes config or auth", () => {
    const runtime = prepareCodexRuntime({
      MEMOSYNC_CLI_PROFILE_DIR: profile,
      GLM_API_KEY: "explicit-test-key",
      MEMOSYNC_CODEX_MODEL: "glm-5.3",
      CODEX_HOME: "/host/codex",
      CODEX_ACCESS_TOKEN: "host-login",
      OPENAI_API_KEY: "host-openai-key",
      ANTHROPIC_AUTH_TOKEN: "host-anthropic-token",
    })
    expect(runtime.env.CODEX_HOME).toBe(join(profile, "codex"))
    expect(runtime.env.CODEX_ACCESS_TOKEN).toBeUndefined()
    expect(runtime.env.OPENAI_API_KEY).toBeUndefined()
    expect(runtime.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(runtime.model).toBe("glm-5.3")
    expect(runtime.args).toContain('model_providers.memosync_isolated.base_url="https://open.bigmodel.cn/api/v1"')
    expect(runtime.args).toContain('model_providers.memosync_isolated.wire_api="responses"')
    expect(runtime.args).toContain('model_providers.memosync_isolated.env_key="GLM_API_KEY"')
    expect(runtime.args).toContain("model_providers.memosync_isolated.requires_openai_auth=false")
    expect(runtime.args).toContain('cli_auth_credentials_store="ephemeral"')
    expect(runtime.args.join(" ")).not.toContain("explicit-test-key")
    expect(existsSync(join(profile, "codex", "config.toml"))).toBe(false)
    expect(existsSync(join(profile, "codex", "auth.json"))).toBe(false)
  })

  test("isolated Codex fails without explicit provider credentials instead of using the host login", () => {
    expect(() => prepareCodexRuntime({ MEMOSYNC_CLI_PROFILE_DIR: profile, OPENAI_API_KEY: "inherited", CODEX_HOME: "/host" })).toThrow("host login is not used")
    expect(existsSync(join(profile, "codex"))).toBe(false)
  })

  test("a custom Responses endpoint gets only its explicit key", () => {
    const runtime = prepareCodexRuntime({
      MEMOSYNC_CLI_PROFILE_DIR: profile,
      MEMOSYNC_CODEX_PROVIDER: "custom",
      MEMOSYNC_CODEX_BASE_URL: "https://api.openai.com/v1",
      MEMOSYNC_CODEX_API_KEY: "explicit-custom-key",
      MEMOSYNC_CODEX_MODEL: "test-model",
      GLM_API_KEY: "unused-glm-key",
    })
    expect(runtime.model).toBe("test-model")
    expect(runtime.args).toContain('model_providers.memosync_isolated.env_key="MEMOSYNC_CODEX_API_KEY"')
  })

  test("existing test profile config is preserved and secrets are not persisted", () => {
    prepareCodexRuntime({ MEMOSYNC_CLI_PROFILE_DIR: profile, GLM_API_KEY: "one" })
    const config = join(profile, "codex", "config.toml")
    writeFileSync(config, "# caller-owned profile")
    prepareCodexRuntime({ MEMOSYNC_CLI_PROFILE_DIR: profile, GLM_API_KEY: "two" })
    expect(readFileSync(config, "utf8")).toBe("# caller-owned profile")
  })

  test("rejects profiles placed in or redirected to the official CLI directories", () => {
    expect(() => buildIsolatedClaudeEnv({ MEMOSYNC_CLI_PROFILE_DIR: join(homedir(), ".claude") })).toThrow("must be separate")
    symlinkSync(join(homedir(), ".codex"), join(profile, "codex"))
    expect(() => prepareCodexRuntime({ MEMOSYNC_CLI_PROFILE_DIR: profile, GLM_API_KEY: "key" })).toThrow("must be separate")
  })
})
