import { afterEach, describe, expect, test } from "bun:test"
import {
  SERVER_PROVIDERS,
  applyClaudeSdkModels,
  applyStudyModelPin,
  codexServiceTierFromModelOptions,
  normalizeClaudeModelOptions,
  normalizeCodexModelOptions,
  normalizeServerModel,
  resetServerProvidersForTests,
} from "./provider-catalog"
import { resolveClaudeApiModelId } from "../shared/types"

describe("provider catalog normalization", () => {
  afterEach(() => {
    resetServerProvidersForTests()
  })

  test("maps legacy Claude effort into shared DeepSeek model options", () => {
    expect(normalizeClaudeModelOptions("deepseek-v4-pro", undefined, "max")).toEqual({
      reasoningEffort: "max",
      contextWindow: "1m",
    })
  })

  test("normalizes DeepSeek context window to the supported 1M option", () => {
    // A stored legacy "200k" (from before the catalog carried real windows)
    // coerces to the model's actual 1M window.
    expect(normalizeClaudeModelOptions("deepseek-v4-pro", {
      claude: {
        reasoningEffort: "max",
        contextWindow: "200k",
      },
    })).toEqual({
      reasoningEffort: "max",
      contextWindow: "1m",
    })

    // Legacy tiers below "high" no longer exist for DeepSeek — stored prefs
    // holding one fall back to the default.
    expect(normalizeClaudeModelOptions("deepseek-v4-flash", {
      claude: {
        reasoningEffort: "medium" as never,
        contextWindow: "1m",
      },
    })).toMatchObject({
      reasoningEffort: "high",
    })
  })

  test("normalizes Codex model options and fast mode defaults", () => {
    expect(normalizeCodexModelOptions(undefined)).toEqual({
      reasoningEffort: "high",
      fastMode: false,
    })

    const normalized = normalizeCodexModelOptions({
      codex: {
        reasoningEffort: "xhigh",
        fastMode: true,
      },
    })

    expect(normalized).toEqual({
      reasoningEffort: "xhigh",
      fastMode: true,
    })
    expect(codexServiceTierFromModelOptions(normalized)).toBe("fast")
  })

  test("normalizes server model ids through the shared alias catalog", () => {
    expect(normalizeServerModel("codex")).toBe("gpt-5.5")
    expect(normalizeServerModel("claude", "fable")).toBe("deepseek-v4-flash")
    expect(normalizeServerModel("claude", "opus")).toBe("deepseek-v4-pro")
    expect(normalizeServerModel("codex", "gpt-5-codex")).toBe("gpt-5.3-codex")
  })

  test("keeps DeepSeek API model ids unchanged regardless of context window", () => {
    expect(resolveClaudeApiModelId("deepseek-v4-pro", "1m")).toBe("deepseek-v4-pro")
    expect(resolveClaudeApiModelId("deepseek-v4-flash", "1m")).toBe("deepseek-v4-flash")
  })

  test("does not replace the DeepSeek catalog with Claude SDK labels", () => {
    expect(applyClaudeSdkModels([
      { value: "claude-fable-5[1m]", displayName: "Fable from SDK", supportsEffort: true },
      { value: "claude-opus-4-7", displayName: "Opus 4.7", supportsEffort: true },
      { value: "claude-opus-4-8", displayName: "Opus from SDK", supportsEffort: true },
    ])).toBe(false)

    const claude = SERVER_PROVIDERS.find((provider) => provider.id === "claude")
    expect(claude?.label).toBe("DeepSeek")
    expect(claude?.models.map((model) => model.id)).toEqual(["deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "deepseek-v4-pro", "glm-5.3-flash"])
  })
})

describe("applyStudyModelPin", () => {
  afterEach(() => {
    resetServerProvidersForTests()
  })

  test("narrows the catalog to Claude Code on the pinned model at effort high", () => {
    applyStudyModelPin("deepseek-v4-flash")
    expect(SERVER_PROVIDERS).toHaveLength(1)
    const claude = SERVER_PROVIDERS[0]!
    expect(claude.id).toBe("claude")
    expect(claude.models.map((m) => m.id)).toEqual(["deepseek-v4-flash"])
    expect(claude.defaultModel).toBe("deepseek-v4-flash")
    expect(claude.efforts.map((e) => e.id)).toEqual(["high"])
    expect(claude.defaultEffort).toBe("high")
  })

  test("an operator model id outside the catalog still pins to a single entry", () => {
    applyStudyModelPin("deepseek-v5-preview")
    const claude = SERVER_PROVIDERS[0]!
    expect(claude.models.map((m) => m.id)).toEqual(["deepseek-v5-preview"])
    expect(claude.models[0]!.supportsEffort).toBe(true)
    expect(claude.defaultModel).toBe("deepseek-v5-preview")
  })
})
