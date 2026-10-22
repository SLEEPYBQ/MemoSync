import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createModelsDevCatalogLoader, ModelsDevCatalog } from "./models-dev"

const connection = { provider: "custom" as const, baseUrl: "https://relay.example/v1", apiKey: "registry-secret-must-not-leak" }
const glm = { name: "GLM Flash", canonical_model_id: "zhipuai/glm-5.3-flash", reasoning: true,
  reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }], limit: { context: 1_000_000 }, cost: { input: 0.15 } }
const data = { zai: { api: "https://api.z.ai/api/paas/v4", models: { "glm-5.3-flash": glm } } }

describe("models.dev capability catalog", () => {
  test("matches actual endpoint first and exposes only its pricing/context there", () => {
    const catalog = new ModelsDevCatalog({ ...data, relay: { api: connection.baseUrl, models: {
      "glm-5.3-flash": { ...glm, reasoning_options: [{ type: "effort", values: ["high"] }], cost: { input: 0 }, limit: { input: 123_000, context: 200_000 } },
    } } })
    const exact = catalog.lookup(connection, "glm-5.3-flash")!
    expect(exact.scope).toBe("provider")
    expect(exact.card.reasoningEfforts).toEqual(["high"])
    expect(exact.card.cost?.input).toBe(0)
    expect(exact.card.contextWindow).toBe(123_000)
    const custom = catalog.lookup({ ...connection, baseUrl: "https://other.example/v1" }, "ZHIPUAI/GLM-5.3-FLASH")!
    expect(custom.scope).toBe("model")
    expect(custom.card.reasoningEfforts).toEqual(["low", "high", "max"])
  })

  test("toggle and token budget aren't invented effort levels or permission to send none", () => {
    const catalog = new ModelsDevCatalog({ deepseek: { models: {
      "a": { canonical_model_id: "deepseek/a", reasoning: true, reasoning_options: [{ type: "toggle" }] },
      "b": { reasoning: true, reasoning_options: [{ type: "budget_tokens" }] },
      "c": { reasoning: false }, "d": { reasoning: true },
    } } })
    expect(catalog.lookup(connection, "a")!.card.reasoningKind).toBe("toggle")
    expect(catalog.lookup(connection, "a")!.card.reasoningEfforts).toEqual(["default"])
    expect(catalog.lookup(connection, "b")!.card.reasoningKind).toBe("budget")
    expect(catalog.lookup(connection, "c")!.card.reasoningEfforts).toEqual(["off"])
    expect(catalog.lookup(connection, "d")).toBeUndefined()
  })

  test("a maker's toggle-only record blocks reseller effort guesses", () => {
    const catalog = new ModelsDevCatalog({ xiaomi: { models: { "mimo-v2": { canonical_model_id: "xiaomi/mimo-v2", reasoning: true, reasoning_options: [{ type: "toggle" }] } } },
      relay: { models: { "xiaomi/mimo-v2": { canonical_model_id: "xiaomi/mimo-v2", reasoning: true, reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }] } } } })
    expect(catalog.lookup(connection, "xiaomi/mimo-v2")!.card.reasoningKind).toBe("toggle")
  })

  test("different canonical models sharing a name stay ambiguous", () => {
    const catalog = new ModelsDevCatalog({ a: { models: { "chat": { canonical_model_id: "a/chat", reasoning: false } } },
      b: { models: { "chat": { canonical_model_id: "b/chat", reasoning: true, reasoning_options: [{ type: "effort", values: ["high"] }] } } } })
    expect(catalog.lookup(connection, "chat")).toBeUndefined()
    expect(catalog.lookup(connection, "a/chat")!.card.reasoningEfforts).toEqual(["off"])
    expect(catalog.lookup(connection, "made-up-glm-5.3-flash")).toBeUndefined()
  })

  test("namespaces require a full ID or canonical link, even on matching endpoints", () => {
    const catalog = new ModelsDevCatalog({ ...data, openrouter: { api: "https://openrouter.ai/api/v1", models: { "z-ai/glm-5.3-flash": glm } } })
    for (const baseUrl of [connection.baseUrl, "https://api.z.ai/api/paas/v4"]) {
      expect(catalog.lookup({ ...connection, baseUrl }, "other/glm-5.3-flash")).toBeUndefined()
    }
    expect(catalog.lookup(connection, "z-ai/glm-5.3-flash")!.card.reasoningEfforts).toEqual(["low", "high", "max"])
    expect(catalog.lookup(connection, "zhipuai/glm-5.3-flash")!.card.reasoningEfforts).toEqual(["low", "high", "max"])
    expect(catalog.lookup(connection, "glm-5.3-flash")!.card.reasoningEfforts).toEqual(["low", "high", "max"])
  })

  test("public fetch is shared, cached on disk, and never sends provider credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memosync-modelsdev-"))
    try {
      const cachePath = join(dir, "models.json")
      let calls = 0, now = 1_000
      const fetchCatalog = async (url: string, init?: RequestInit) => {
        calls++; expect(String(url)).toBe("https://models.dev/api.json")
        expect(new Headers(init?.headers).has("Authorization")).toBe(false)
        expect(JSON.stringify(init)).not.toContain(connection.apiKey)
        return Response.json(data)
      }
      const load = createModelsDevCatalogLoader({ cachePath, now: () => now, fetch: fetchCatalog })
      const [a, b] = await Promise.all([load(), load()])
      expect(a).toBe(b); expect(calls).toBe(1)
      expect((await load()).size).toBe(1); expect(calls).toBe(1)
      expect(await readFile(cachePath, "utf8")).not.toContain(connection.apiKey)
      const restarted = createModelsDevCatalogLoader({ cachePath, now: () => now, fetch: fetchCatalog })
      expect((await restarted()).size).toBe(1); expect(calls).toBe(1)
      now += 24 * 60 * 60_000 + 1
      await load(); expect(calls).toBe(2)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  test("offline refresh keeps disk metadata and throttles failures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memosync-modelsdev-"))
    try {
      const cachePath = join(dir, "models.json")
      await writeFile(cachePath, JSON.stringify({ fetchedAt: 1, data }))
      let now = 25 * 60 * 60_000, calls = 0
      const load = createModelsDevCatalogLoader({ cachePath, now: () => now, fetch: async () => { calls++; throw Error("offline") } })
      expect((await load()).lookup(connection, "glm-5.3-flash")!.card.reasoningEfforts).toEqual(["low", "high", "max"])
      await load(); expect(calls).toBe(1)
      now += 60_001; await load(); expect(calls).toBe(2)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  test("a malformed catalog leaves the last good result in memory", async () => {
    let calls = 0, now = 0
    const load = createModelsDevCatalogLoader({ cachePath: false, now: () => now,
      fetch: async () => Response.json(++calls === 1 ? data : { error: "failed" }) })
    const first = await load()
    now = 24 * 60 * 60_000 + 1
    expect(await load()).toBe(first)
    expect((await load()).size).toBe(1)
    expect(calls).toBe(2)
  })
})
