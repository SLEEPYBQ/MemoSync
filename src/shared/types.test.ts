import { describe, expect, test } from "bun:test"
import {
  normalizeClaudeModelId,
  normalizeCodexModelId,
  resolveModelReasoningEffort,
  supportsClaudeMaxReasoningEffort,
} from "./types"

describe("model reasoning capabilities", () => {
  test("omits effort for models that do not support it", () => {
    expect(resolveModelReasoningEffort({ id: "haiku", label: "Haiku", supportsEffort: false }, "high")).toBeUndefined()
    expect(resolveModelReasoningEffort({ id: "local", label: "Local", supportsEffort: true, reasoningEfforts: [] }, "high")).toBeUndefined()
  })

  test("keeps supported levels and replaces stale choices with the advertised default", () => {
    const model = { id: "gpt-live", label: "Live", supportsEffort: true, reasoningEfforts: ["low", "max"], defaultReasoningEffort: "max" }
    expect(resolveModelReasoningEffort(model, "low")).toBe("low")
    expect(resolveModelReasoningEffort(model, "xhigh")).toBe("max")
    expect(resolveModelReasoningEffort({ ...model, defaultReasoningEffort: "invalid" }, "high")).toBe("low")
    expect(resolveModelReasoningEffort(undefined, "high")).toBe("high")
  })
})

describe("shared model normalization", () => {
  test("keeps official Claude aliases separate from explicit DeepSeek models", () => {
    expect(normalizeClaudeModelId()).toBe("deepseek-v4-flash")
    expect(normalizeClaudeModelId("deepseek-v4-pro")).toBe("deepseek-v4-pro")
    expect(normalizeClaudeModelId("opus")).toBe("opus")
    expect(normalizeClaudeModelId("claude-opus-4-8")).toBe("claude-opus-4-8")
    expect(normalizeClaudeModelId("fable")).toBe("fable")
    expect(normalizeClaudeModelId("claude-fable-5-1[1m]")).toBe("claude-fable-5-1[1m]")
    expect(normalizeClaudeModelId("sonnet")).toBe("sonnet")
    expect(normalizeClaudeModelId("haiku")).toBe("haiku")
    expect(normalizeClaudeModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5-20251001")
  })

  test("preserves Codex IDs until the server resolves them against the current catalog", () => {
    expect(normalizeCodexModelId()).toBe("gpt-5.5")
    expect(normalizeCodexModelId("gpt-5-codex")).toBe("gpt-5-codex")
    expect(normalizeCodexModelId("glm-5.3-flash")).toBe("glm-5.3-flash")
    expect(normalizeCodexModelId("custom-provider-model")).toBe("custom-provider-model")
  })

  test("uses declarative metadata for DeepSeek max-effort support", () => {
    // Both DeepSeek models expose the full high/max thinking range.
    expect(supportsClaudeMaxReasoningEffort("deepseek-v4-pro")).toBe(true)
    expect(supportsClaudeMaxReasoningEffort("opus")).toBe(true)
    expect(supportsClaudeMaxReasoningEffort("deepseek-v4-flash")).toBe(true)
  })
})
