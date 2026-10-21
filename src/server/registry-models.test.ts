import { describe, expect, test } from "bun:test"
import { createRegistryModelLoader, parseRegistryModelCard } from "./registry-models"
import { piEffortOptions, resolvePiEffort, toPiThinkingLevel } from "../shared/model-capabilities"
import { buildRegistryModel } from "./pi-agent"

const glm = { id: "z-ai/glm-5.3-flash", name: "GLM Flash", context_length: 1_048_576,
  supported_parameters: ["reasoning", "reasoning_effort", "structured_outputs", "response_format"],
  reasoning: { mandatory: true, supported_efforts: ["max", "high", "low"], default_effort: "max" },
  pricing: { prompt: "0.00000005", completion: "0.00000016" }, top_provider: { max_completion_tokens: 65536 } }
const connection = { provider: "openrouter" as const, baseUrl: "https://openrouter.ai/api/v1", apiKey: "test-key" }

describe("registry model capabilities", () => {
  test("the picker and transport use exact live GLM levels, including max", () => {
    const card = parseRegistryModelCard(glm)!
    expect(piEffortOptions(card).map(e => e.id)).toEqual(["low", "high", "max"])
    expect(resolvePiEffort(card, "off")).toBe("max")
    expect(resolvePiEffort(card, "medium")).toBe("max")
    expect(resolvePiEffort(card, "low")).toBe("low")
    expect(toPiThinkingLevel("max")).toBe("xhigh")
    const model = buildRegistryModel(connection, card.id, card)
    expect(model.thinkingLevelMap).toEqual({ off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: "max" })
    expect(model.contextWindow).toBe(1_048_576)
    expect(model.maxTokens).toBe(32_000)
    expect(model.cost.input).toBeCloseTo(0.05)
    expect(card.supportsStructuredOutput).toBe(true)
  })

  test("none is Off only when the model permits it; unknown metadata stays provider default", () => {
    const optional = parseRegistryModelCard({ id: "optional", reasoning: { supported_efforts: ["none", "low"], default_effort: "none" } })!
    expect(optional.reasoningEfforts).toEqual(["off", "low"])
    const mandatory = parseRegistryModelCard({ id: "mandatory", reasoning: { mandatory: true, supported_efforts: ["none", "high"] } })!
    expect(mandatory.reasoningEfforts).toEqual(["high"])
    expect(parseRegistryModelCard({ id: "plain" })!.reasoningEfforts).toEqual(["default"])
    expect(parseRegistryModelCard({ id: "plain", supported_parameters: ["tools"] })!.reasoningEfforts).toEqual(["off"])
    expect(piEffortOptions(undefined).map(e => e.id)).toEqual(["default"])
    expect(buildRegistryModel(connection, "unknown").thinkingLevelMap?.off).toBeNull()
  })

  test("one fetch is shared, expires, and is isolated by endpoint and credentials", async () => {
    let calls = 0, now = 0
    const load = createRegistryModelLoader({ now: () => now, fallback: async () => [], fetch: (async (_url, init) => {
      calls++; expect(new Headers(init?.headers).has("Authorization")).toBe(true)
      return Response.json({ data: [glm] })
    }) })
    const [a, b] = await Promise.all([load(connection), load(connection)])
    expect(a).toEqual(b); expect(calls).toBe(1)
    await load(connection); expect(calls).toBe(1)
    await load({ ...connection, apiKey: "other" }); expect(calls).toBe(2)
    await load({ ...connection, baseUrl: "https://other.example/v1" }); expect(calls).toBe(3)
    now = 300_001; await load(connection); expect(calls).toBe(4)
  })

  test("an offline refresh retains the last good model card without indefinite retries", async () => {
    let now = 0, calls = 0
    const load = createRegistryModelLoader({ now: () => now, fallback: async () => [], fetch: (async () => {
      if (++calls > 1) throw Error("offline")
      return Response.json({ data: [glm] })
    }) })
    const first = await load(connection)
    now = 300_001; expect(await load(connection)).toEqual(first)
    await load(connection); expect(calls).toBe(2)
  })

  test("plain /models IDs retain the exact bundled capability metadata on fallback", async () => {
    const known = parseRegistryModelCard(glm)!
    const load = createRegistryModelLoader({ fallback: async () => [known], fetch: (async () => Response.json({ data: [{ id: glm.id }] })) })
    expect((await load(connection))[0]!.reasoningEfforts).toEqual(["max", "high", "low"])
  })
})
