import { describe, expect, test } from "bun:test"
import {
  normalizeClaudeModelId,
  normalizeCodexModelId,
  supportsClaudeMaxReasoningEffort,
} from "./types"

describe("shared model normalization", () => {
  test("keeps official Claude aliases separate from explicit DeepSeek models", () => {
    expect(normalizeClaudeModelId()).toBe("deepseek-v4-flash")
    expect(normalizeClaudeModelId("deepseek-v4-pro")).toBe("deepseek-v4-pro")
    expect(normalizeClaudeModelId("opus")).toBe("opus")
    expect(normalizeClaudeModelId("claude-opus-4-8")).toBe("opus")
    expect(normalizeClaudeModelId("fable")).toBe("deepseek-v4-flash")
    expect(normalizeClaudeModelId("sonnet")).toBe("sonnet")
    expect(normalizeClaudeModelId("haiku")).toBe("deepseek-v4-flash")
  })

  test("normalizes legacy Codex aliases and defaults to the latest catalog model", () => {
    expect(normalizeCodexModelId()).toBe("gpt-5.5")
    expect(normalizeCodexModelId("gpt-5-codex")).toBe("gpt-5.3-codex")
    expect(normalizeCodexModelId("glm-5.3-flash")).toBe("glm-5.3-flash")
    expect(normalizeCodexModelId("custom-provider-model")).toBe("custom-provider-model")
  })

  test("uses declarative metadata for DeepSeek max-effort support", () => {
    // Both DeepSeek models expose the full high/max thinking range.
    expect(supportsClaudeMaxReasoningEffort("deepseek-v4-pro")).toBe(true)
    expect(supportsClaudeMaxReasoningEffort("opus")).toBe(true)
    expect(supportsClaudeMaxReasoningEffort("fable")).toBe(true)
    expect(supportsClaudeMaxReasoningEffort("deepseek-v4-flash")).toBe(true)
  })
})
