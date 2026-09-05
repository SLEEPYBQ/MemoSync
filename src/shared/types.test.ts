import { describe, expect, test } from "bun:test"
import {
  normalizeClaudeModelId,
  normalizeCodexModelId,
  supportsClaudeMaxReasoningEffort,
} from "./types"

describe("shared model normalization", () => {
  test("normalizes DeepSeek ids and legacy Claude aliases via the provider catalog", () => {
    expect(normalizeClaudeModelId()).toBe("deepseek-v4-flash")
    expect(normalizeClaudeModelId("deepseek-v4-pro")).toBe("deepseek-v4-pro")
    expect(normalizeClaudeModelId("opus")).toBe("deepseek-v4-pro")
    expect(normalizeClaudeModelId("claude-opus-4-8")).toBe("deepseek-v4-pro")
    expect(normalizeClaudeModelId("fable")).toBe("deepseek-v4-flash")
    expect(normalizeClaudeModelId("sonnet")).toBe("deepseek-v4-flash")
    expect(normalizeClaudeModelId("haiku")).toBe("deepseek-v4-flash")
  })

  test("normalizes legacy Codex aliases and defaults to the latest catalog model", () => {
    expect(normalizeCodexModelId()).toBe("gpt-5.5")
    expect(normalizeCodexModelId("gpt-5-codex")).toBe("gpt-5.3-codex")
  })

  test("uses declarative metadata for DeepSeek max-effort support", () => {
    // Both DeepSeek models expose the full high/max thinking range.
    expect(supportsClaudeMaxReasoningEffort("deepseek-v4-pro")).toBe(true)
    expect(supportsClaudeMaxReasoningEffort("opus")).toBe(true)
    expect(supportsClaudeMaxReasoningEffort("fable")).toBe(true)
    expect(supportsClaudeMaxReasoningEffort("deepseek-v4-flash")).toBe(true)
  })
})
