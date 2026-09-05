import { expect, test } from "bun:test"
import { deriveDeepSeekEngineEnv } from "./deepseek-engine-env"

test("a lone DEEPSEEK_API_KEY derives the full Claude engine bundle", () => {
  const derived = deriveDeepSeekEngineEnv({ DEEPSEEK_API_KEY: "sk-test" })
  expect(derived).toMatchObject({
    ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
    ANTHROPIC_AUTH_TOKEN: "sk-test",
    ANTHROPIC_API_KEY: "sk-test",
    ANTHROPIC_MODEL: "deepseek-v4-flash",
    CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-v4-flash",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "786432",
  })
})

test("DEEPSEEK_BASE_URL and DEEPSEEK_MODEL flow into the derived bundle", () => {
  const derived = deriveDeepSeekEngineEnv({
    DEEPSEEK_API_KEY: "sk-test",
    DEEPSEEK_BASE_URL: "https://mirror.example.com/",
    DEEPSEEK_MODEL: "deepseek-v4-pro",
  })
  expect(derived?.ANTHROPIC_BASE_URL).toBe("https://mirror.example.com/anthropic")
  expect(derived?.ANTHROPIC_MODEL).toBe("deepseek-v4-pro")
  expect(derived?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("deepseek-v4-pro")
  // Haiku-class/subagent traffic stays on Flash even with a Pro main model.
  expect(derived?.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("deepseek-v4-flash")
  expect(derived?.CLAUDE_CODE_SUBAGENT_MODEL).toBe("deepseek-v4-flash")
})

test("an explicit CLAUDE_CODE_AUTO_COMPACT_WINDOW wins over the default", () => {
  const derived = deriveDeepSeekEngineEnv({
    DEEPSEEK_API_KEY: "sk-test",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "500000",
  })
  expect(derived?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("500000")
})

test("no key or an explicit own-anthropic opt-out leaves the environment alone", () => {
  expect(deriveDeepSeekEngineEnv({})).toBeNull()
  expect(deriveDeepSeekEngineEnv({ DEEPSEEK_API_KEY: "  " })).toBeNull()
  expect(deriveDeepSeekEngineEnv({
    DEEPSEEK_API_KEY: "sk-test",
    MEMOSYNC_USE_OWN_ANTHROPIC: "1",
  })).toBeNull()
})

test("a stray inherited ANTHROPIC_BASE_URL is overridden, not obeyed", () => {
  // Leftover exports from other Claude Code setups must not hijack the
  // engine when the deployment credential is present.
  const derived = deriveDeepSeekEngineEnv({
    DEEPSEEK_API_KEY: "sk-test",
    ANTHROPIC_BASE_URL: "https://some-other-harness.example.com",
    ANTHROPIC_MODEL: "claude-opus-4-8",
  })
  expect(derived?.ANTHROPIC_BASE_URL).toBe("https://api.deepseek.com/anthropic")
  expect(derived?.ANTHROPIC_MODEL).toBe("deepseek-v4-flash")
})
