import { describe, expect, test } from "bun:test"
import { createRegistryModelLoader as createLoader, parseRegistryModelCard } from "./registry-models"
import { piEffortOptions, resolvePiEffort, toPiThinkingLevel } from "../shared/model-capabilities"
import { buildRegistryModel } from "./pi-agent"

import { ModelsDevCatalog } from "./models-dev"

const createRegistryModelLoader = (deps: Parameters<typeof createLoader>[0]) => createLoader({ catalog: async () => new ModelsDevCatalog({}), ...deps })

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

  test("synchronous snapshots never fetch, keep stale cards during refresh, and isolate credentials", async () => {
    let now = 0, calls = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const load = createRegistryModelLoader({ now: () => now, fallback: async () => [], fetch: async () => {
      if (++calls > 1) await gate
      return Response.json({ data: [glm] })
    } })
    expect(load.peek(connection, glm.id)).toBeUndefined()
    expect(calls).toBe(0)
    const [card] = await load(connection)
    now = 300_001
    const refresh = load(connection)
    expect(load.peek(connection, glm.id)).toBe(card)
    expect(load.peek({ ...connection, apiKey: "different" }, glm.id)).toBeUndefined()
    expect(calls).toBe(2)
    release(); await refresh
  })

  test("plain /models IDs retain the exact bundled capability metadata on fallback", async () => {
    const known = parseRegistryModelCard(glm)!
    const load = createRegistryModelLoader({ fallback: async () => [known], fetch: (async () => Response.json({ data: [{ id: glm.id }] })) })
    expect((await load(connection))[0]!.reasoningEfforts).toEqual(["max", "high", "low"])
  })

  test("missing live efforts never replace live context, costs, modalities or output support", async () => {
    const bundled = { ...parseRegistryModelCard(glm)!, contextWindow: 200_000, maxTokens: 8192,
      inputModalities: ["text", "image"], supportsStructuredOutput: false,
      cost: { input: 5, output: 15, cacheRead: 1, cacheWrite: 2 }, metadataSource: "pi" as const }
    const live = { ...glm, reasoning: { mandatory: true }, architecture: { input_modalities: ["text"] },
      pricing: { prompt: "0", completion: "0.0000002" }, top_provider: { max_completion_tokens: 60_000 } }
    const load = createRegistryModelLoader({ fallback: async () => [bundled], fetch: async () => Response.json({ data: [live] }) })
    const card = (await load(connection))[0]!
    expect(card.reasoningEfforts).toEqual(["max", "high", "low"])
    expect(card.contextWindow).toBe(1_048_576)
    expect(card.maxTokens).toBe(60_000)
    expect(card.cost).toMatchObject({ input: 0, cacheRead: 1, cacheWrite: 2 })
    expect(card.cost?.output).toBeCloseTo(0.2)
    expect(card.inputModalities).toEqual(["text"])
    expect(card.supportsStructuredOutput).toBe(true)
    const model = buildRegistryModel(connection, card.id, card)
    expect(model.contextWindow).toBe(1_048_576)
    expect(model.cost.input).toBe(0)
    expect(model.input).toEqual(["text"])
  })

  test("false, empty arrays and zero prices stay distinct from absent metadata", async () => {
    const bundled = { ...parseRegistryModelCard(glm)!, supportsStructuredOutput: true, inputModalities: ["text", "image"], cost: { input: 5, output: 15 } }
    const load = createRegistryModelLoader({ fallback: async () => [bundled], fetch: async () => Response.json({ data: [{
      id: glm.id, reasoning: false, supported_parameters: [], architecture: { input_modalities: [] }, pricing: { prompt: "0", completion: 0 },
    }] }) })
    const card = (await load(connection))[0]!
    expect(card.reasoningEfforts).toEqual(["off"])
    expect(card.reasoningMandatory).toBeUndefined()
    expect(card.supportsStructuredOutput).toBe(false)
    expect(card.inputModalities).toEqual([])
    expect(card.cost?.input).toBe(0)
    expect(card.cost?.output).toBe(0)
    expect(buildRegistryModel(connection, card.id, card).input).toEqual([])
    const absent = parseRegistryModelCard({ id: "unknown" })!
    expect(absent.supportsStructuredOutput).toBeUndefined()
    expect(absent.inputModalities).toBeUndefined()
    expect(absent.cost).toBeUndefined()
    expect(parseRegistryModelCard({ id: "bad-prices", pricing: { prompt: null, completion: "" } })!.cost).toEqual({ input: undefined, output: undefined, cacheRead: undefined, cacheWrite: undefined })
  })

  test("live mandatory and preferred default constrain supplemented reasoning", async () => {
    const known = parseRegistryModelCard({ id: glm.id, reasoning: { supported_efforts: ["none", "low", "high"], default_effort: "none" } })!
    const load = createRegistryModelLoader({ fallback: async () => [known], fetch: async () => Response.json({ data: [{
      id: glm.id, reasoning: { mandatory: true, default_effort: "high" },
    }] }) })
    const card = (await load(connection))[0]!
    expect(card.reasoningEfforts).toEqual(["low", "high"])
    expect(card.reasoningMandatory).toBe(true)
    expect(card.defaultReasoningEffort).toBe("high")
    const disabled = createRegistryModelLoader({ fallback: async () => [known], fetch: async () => Response.json({ data: [{
      id: glm.id, reasoning: { mandatory: false, default_enabled: false, default_effort: "high" },
    }] }) })
    expect((await disabled(connection))[0]!.defaultReasoningEffort).toBe("off")
  })

  test("a gateway's explicit empty level list and toggle-only records block borrowed levels", async () => {
    const bundled = parseRegistryModelCard(glm)!
    for (const metadata of [{ reasoning: true, supported_reasoning_levels: [] }, { reasoning_options: [{ type: "toggle" }] }]) {
      const load = createRegistryModelLoader({ fallback: async () => [bundled], fetch: async () => Response.json({ data: [{ id: glm.id, ...metadata }] }) })
      expect((await load(connection))[0]!.reasoningEfforts).toEqual(["default"])
    }
    const gateway = parseRegistryModelCard({ id: "group/fast", display_name: "Fast route", reasoning: true,
      supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }], context_length: 1_000_000, max_output_tokens: 8192 })!
    expect(gateway.reasoningEfforts).toEqual(["low", "high"])
    expect(gateway.maxTokens).toBe(8192)
    expect(gateway.label).toBe("Fast route")
  })

  test("exact provider metadata beats bundled efforts; explicit live efforts beat both", async () => {
    const catalog = async () => new ModelsDevCatalog({ openrouter: { api: connection.baseUrl, models: {
      [glm.id]: { reasoning: true, reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }] },
    } } })
    const bundled = parseRegistryModelCard({ id: glm.id, reasoning: { supported_efforts: ["low", "medium", "high"] } })!
    for (const reasoning of [undefined, { supported_efforts: ["high", "max"] }]) {
      const load = createRegistryModelLoader({ catalog, fallback: async () => [bundled], fetch: async () => Response.json({ data: [{ id: glm.id, reasoning }] }) })
      const card = (await load(connection))[0]!
      expect(card.reasoningEfforts).toEqual(reasoning ? ["high", "max"] : ["low", "high", "max"])
      expect(card.metadataSource).toBe(reasoning ? "provider" : "models.dev")
    }
  })

  test("a custom endpoint's listed and manually entered models share pre-send capability lookup", async () => {
    const custom = { ...connection, provider: "custom" as const, baseUrl: "https://relay.example/v1" }
    const catalog = async () => new ModelsDevCatalog({ zai: { api: "https://api.z.ai/api/paas/v4", models: {
      "glm-5.3-flash": { canonical_model_id: "zhipuai/glm-5.3-flash", reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }], limit: { context: 1_000_000 }, cost: { input: 20 } },
    } } })
    let calls = 0
    const load = createRegistryModelLoader({ catalog, fallback: async () => [], fetch: async () => {
      calls++; return Response.json({ data: [{ id: "other-model" }] })
    } })
    const card = (await load(custom, "zhipuai/GLM-5.3-Flash")).find(c => c.id === "zhipuai/GLM-5.3-Flash")!
    expect(load.peek(custom, card.id)).toEqual(card)
    expect(card.reasoningEfforts).toEqual(["low", "high", "max"])
    expect(card.contextWindow).toBeUndefined()
    expect(card.cost).toBeUndefined() // A reseller's price isn't the maker's price.
    const model = buildRegistryModel(custom, card.id, card, "max")
    expect(model.id).toBe("zhipuai/GLM-5.3-Flash")
    expect(model.baseUrl).toBe(custom.baseUrl)
    expect(model.thinkingLevelMap?.xhigh).toBe("max")
    expect(piEffortOptions(card).map(e => e.id)).toEqual(["low", "high", "max"])
    await load(custom, "glm-5.3-flash")
    expect(calls).toBe(1)
    expect((await load(custom)).map(c => c.id)).toEqual(["other-model"])
  })
})
