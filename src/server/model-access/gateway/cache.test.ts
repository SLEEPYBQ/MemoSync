import { expect, test } from "bun:test"
import { chatCapabilities, UNKNOWN_CHAT_CAPABILITIES } from "./capabilities"
import { encodeChat, parseRequest, type Target, type Wire } from "./request"
import { ChatDecoder, ClientEncoder } from "./stream"
import { normalizeChatUsage } from "./usage"

// Adapted from experiments/root/gateway-and-capture.ts (MemoSync@e0209db).
// All usage below is synthetic. These exercise actual converters, not cache hit rates.
const deepseek = { prompt_tokens: 4096, completion_tokens: 32, prompt_cache_hit_tokens: 3072, prompt_cache_miss_tokens: 1024 }
const caps = (model = "gpt-5.5", baseUrl = "https://api.openai.com/v1") => chatCapabilities({ protocol: "openai-chat", baseUrl }, model)
function convert(target: Target, ...snapshots: Wire[]) {
  const decoder = new ChatDecoder(), encoder = new ClientEncoder(target, "synthetic-model")
  encoder.start()
  for (const usage of snapshots) for (const ev of decoder.decode(JSON.stringify({ choices: [], usage }))) encoder.event(ev)
  for (const ev of decoder.decode(JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }))) encoder.event(ev)
  encoder.finish()
  return { result: encoder.result!, events: encoder.drain() }
}

for (const target of ["anthropic", "responses"] as const) {
  test(`${target}: DeepSeek hit=3072 survives the actual decoder and encoder`, () => {
    const { result, events } = convert(target, deepseek)
    expect(result.memosync.usage).toMatchObject({ input: 4096, output: 32, cached: 3072, uncached: 1024, basis: "per-request", sources: { cached: { kind: "reported", fields: ["prompt_cache_hit_tokens"] }, uncached: { kind: "reported", fields: ["prompt_cache_miss_tokens"] } } })
    expect(result.memosync.usage.cacheWrite).toBeUndefined()
    expect(result.memosync.wirePlaceholders).toEqual([])
    expect(result.usage).toEqual(target === "anthropic"
      ? { input_tokens: 1024, output_tokens: 32, cache_read_input_tokens: 3072 }
      : { input_tokens: 4096, output_tokens: 32, total_tokens: 4128, input_tokens_details: { cached_tokens: 3072 }, output_tokens_details: {} })
    const terminal = target === "anthropic" ? events.find(e => e.type === "message_delta") : events.at(-1)?.response
    expect(terminal?.memosync.usage).toEqual(result.memosync.usage)
  })

  test(`${target}: measured zero stays distinct from absent or invalid cache counts`, () => {
    const zero = convert(target, { prompt_tokens: 10, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } }).result
    const missing = convert(target, { prompt_tokens: 10, completion_tokens: 0 }).result
    const invalid = convert(target, { prompt_tokens: 10, completion_tokens: 0, prompt_cache_hit_tokens: -1, prompt_cache_miss_tokens: "0", prompt_tokens_details: { cached_tokens: null, cache_write_tokens: 1.5 } }).result
    expect(zero.memosync.usage.cached).toBe(0)
    expect(zero.memosync.usage.cacheWrite).toBe(0)
    expect(zero.memosync.usage.sources.cached.kind).toBe("reported")
    for (const result of [missing, invalid]) {
      expect(result.memosync.usage.cached).toBeUndefined()
      expect(result.memosync.usage.cacheWrite).toBeUndefined()
      expect(result.memosync.usage.sources.cached).toBeUndefined()
      expect(target === "anthropic" ? result.usage.cache_read_input_tokens : result.usage.input_tokens_details.cached_tokens).toBeUndefined()
      expect(target === "anthropic" ? result.usage.cache_creation_input_tokens : result.usage.input_tokens_details.cache_write_tokens).toBeUndefined()
    }
    expect(invalid.memosync.usage.diagnostics).toHaveLength(4)
  })

  test(`${target}: cache read/write are subsets of input, reasoning is a subset of output`, () => {
    const { result } = convert(target, { prompt_tokens: 10000, completion_tokens: 17, prompt_tokens_details: { cached_tokens: 1234, cache_write_tokens: 567 }, completion_tokens_details: { reasoning_tokens: 2 } })
    expect(result.memosync.usage).toMatchObject({ input: 10000, output: 17, cached: 1234, cacheWrite: 567, uncached: 8199, reasoning: 2 })
    if (target === "anthropic") {
      expect(result.usage).toEqual({ input_tokens: 8199, output_tokens: 17, cache_read_input_tokens: 1234, cache_creation_input_tokens: 567 })
      expect(result.usage.input_tokens + result.usage.cache_read_input_tokens + result.usage.cache_creation_input_tokens).toBe(10000)
    } else expect(result.usage).toEqual({ input_tokens: 10000, output_tokens: 17, total_tokens: 10017, input_tokens_details: { cached_tokens: 1234, cache_write_tokens: 567 }, output_tokens_details: { reasoning_tokens: 2 } })
  })

  test(`${target}: request snapshots replace previous snapshots and ignore cumulative SDK totals`, () => {
    const { result } = convert(target,
      { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 10 },
      { prompt_tokens: 120, completion_tokens: 7, prompt_cache_hit_tokens: 20, total: { input_tokens: 99999 }, modelUsage: { synthetic: { inputTokens: 99999 } } })
    expect(result.memosync.usage).toMatchObject({ input: 120, output: 7, cached: 20, basis: "per-request" })
    expect(result.memosync.usage.reported).toEqual({ prompt_tokens: 120, completion_tokens: 7, prompt_cache_hit_tokens: 20 })
    expect(convert(target, { total: { input_tokens: 99999 }, last: { input_tokens: 120 } }).result.memosync.usage.input).toBeUndefined()
  })

  test(`${target}: no usage reports unknown with explicit protocol placeholders`, () => {
    const { result } = convert(target)
    expect(result.memosync.usage.sources).toEqual({})
    expect(result.memosync.wirePlaceholders).toEqual(target === "anthropic" ? ["input", "output"] : ["input", "output", "total"])
    expect(result.memosync.usage.input).toBeUndefined()
    expect(result.memosync.usage.output).toBeUndefined()
    expect(result.memosync.usage.cached).toBeUndefined()
  })
}

test("DeepSeek totals can be derived, but missing cache writes never become misses", () => {
  const derived = normalizeChatUsage({ prompt_cache_hit_tokens: 3072, prompt_cache_miss_tokens: 1024 })
  expect(derived.input).toBe(4096)
  expect(derived.sources.input).toEqual({ kind: "derived", fields: ["prompt_cache_hit_tokens", "prompt_cache_miss_tokens"] })
  expect(derived.cacheWrite).toBeUndefined()
  expect(normalizeChatUsage({ prompt_tokens: 4096, prompt_tokens_details: { cached_tokens: 3072 } }).uncached).toBeUndefined()
})

test("conflicting aliases and inconsistent totals retain reported values and diagnostics", () => {
  const aliases = normalizeChatUsage({ ...deepseek, prompt_tokens_details: { cached_tokens: 0 } })
  expect(aliases.cached).toBe(3072)
  expect(aliases.reported["prompt_tokens_details.cached_tokens"]).toBe(0)
  expect(aliases.diagnostics).toEqual([{ code: "conflicting_counters", fields: ["prompt_cache_hit_tokens", "prompt_tokens_details.cached_tokens"] }])
  const { result } = convert("anthropic", { ...deepseek, prompt_tokens: 10 })
  expect(result.memosync.usage).toMatchObject({ input: 10, cached: 3072, uncached: 1024 })
  expect(result.memosync.usage.diagnostics.every((d: Wire) => d.code === "inconsistent_input")).toBe(true)
  // An impossible cache decomposition cannot inflate the Anthropic input total.
  expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 32 })
  expect(normalizeChatUsage({ prompt_tokens: 10, prompt_cache_miss_tokens: 11 }).diagnostics).toMatchObject([{ code: "inconsistent_input" }])
  expect(normalizeChatUsage({ prompt_cache_miss_tokens: 10, prompt_tokens_details: { cache_write_tokens: 11 } }).diagnostics).toMatchObject([{ code: "inconsistent_input" }])
})

test("usage provenance never echoes unrecognized upstream strings", () => {
  const { result } = convert("responses", { prompt_tokens: 1, completion_tokens: 2, prompt_cache_hit_tokens: "secret-echo", arbitrary: "secret-echo" })
  expect(JSON.stringify(result)).not.toContain("secret-echo")
  expect(result.memosync.usage.diagnostics).toEqual([{ code: "invalid_counter", fields: ["prompt_cache_hit_tokens"] }])
})

test("cache capabilities depend on exact endpoint, protocol and model", () => {
  for (const baseUrl of ["https://relay.test/v1", "https://api.openai.com.relay.test/v1", "http://api.openai.com/v1", "https://api.openai.com/custom"]) expect(caps("gpt-5.6", baseUrl)).toEqual(UNKNOWN_CHAT_CAPABILITIES)
  expect(chatCapabilities({ protocol: "openai-responses", baseUrl: "https://api.openai.com/v1" }, "gpt-5.6")).toEqual(UNKNOWN_CHAT_CAPABILITIES)
  expect(caps("gpt-5.5").implicitCacheOptions).toBe(false)
  expect(caps("gpt-5.6").implicitCacheOptions).toBe(true)
  expect(caps("gpt-5.6").promptCacheRetention).toEqual(["24h"])
  expect(caps("unknown-model").promptCacheKey).toBe(false)
  expect(caps("gpt-5-mini").promptCacheRetention).toEqual([])
  expect(caps("deepseek-flash", "https://api.deepseek.com/v1")).toMatchObject({ provider: "deepseek", instructionRoles: "system", promptCacheKey: false, implicitCacheOptions: false })
})

test("verified request options survive the actual Responses-to-Chat converter", () => {
  const request = parseRequest("responses", { model: "gpt-5.5", input: "Question", prompt_cache_key: "synthetic-affinity", prompt_cache_retention: "24h" }, caps())
  expect(encodeChat(request)).toMatchObject({ prompt_cache_key: "synthetic-affinity", prompt_cache_retention: "24h" })
  expect(request.diagnostics).toEqual([])
  const modern = parseRequest("responses", { model: "gpt-5.6", input: "Question", prompt_cache_options: { mode: "implicit", ttl: "30m" } }, caps("gpt-5.6"))
  expect(encodeChat(modern).prompt_cache_options).toEqual({ mode: "implicit", ttl: "30m" })
  expect(modern.diagnostics).toEqual([])
})

test("unsupported cache policies have diagnostics and are never silently reinterpreted", () => {
  for (const capability of [UNKNOWN_CHAT_CAPABILITIES, caps("deepseek-flash", "https://api.deepseek.com/v1")]) {
    const request = parseRequest("responses", { model: "synthetic-model", input: "Question", prompt_cache_key: "synthetic-affinity", prompt_cache_retention: "24h", prompt_cache_options: { mode: "implicit", ttl: "30m" } }, capability)
    const chat = encodeChat(request)
    for (const key of ["prompt_cache_key", "prompt_cache_retention", "prompt_cache_options"]) expect(chat[key]).toBeUndefined()
    expect(request.diagnostics.map(d => d.path)).toEqual(["$.prompt_cache_key", "$.prompt_cache_retention", "$.prompt_cache_options"])
  }
  for (const option of [{ mode: "explicit" }, { ttl: "12h" }, { prewarm: true }, { mode: "implicit", arbitrary: true }]) {
    const request = parseRequest("responses", { model: "gpt-5.6", input: "Question", prompt_cache_options: option }, caps("gpt-5.6"))
    expect(encodeChat(request).prompt_cache_options).toBeUndefined()
    expect(request.diagnostics[0]?.code).toBe("unsupported_cache_option")
  }
  const retention = parseRequest("responses", { model: "gpt-5.5", input: "Question", prompt_cache_retention: "in-memory" }, caps())
  expect(encodeChat(retention).prompt_cache_retention).toBeUndefined()
  expect(retention.diagnostics[0]?.path).toBe("$.prompt_cache_retention")
})

test("cache boundaries in protocol containers are diagnosed without inspecting tool argument/schema data", () => {
  const marker = { type: "ephemeral", ttl: "1h" }
  const request = parseRequest("anthropic", {
    model: "synthetic-model", cache_control: marker,
    system: [{ type: "text", text: "Contract", cache_control: marker }],
    tools: [{ name: "Read", cache_control: marker, input_schema: { type: "object", properties: { cache_control: { type: "string" } } } }],
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "c", name: "Read", input: { cache_control: "ordinary argument" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c", content: [{ type: "text", text: "data", cache_control: marker }] }] },
    ],
  })
  encodeChat(request)
  expect(request.diagnostics.filter(d => d.code === "unsupported_cache_option").map(d => d.path)).toEqual([
    "$.cache_control", "$.system[0].cache_control", "$.messages[1].content[0].content[0].cache_control", "$.tools[0].cache_control",
  ])
  const responses = parseRequest("responses", { model: "gpt-5.6", input: [{ role: "developer", content: [{ type: "input_text", text: "Contract", prompt_cache_breakpoint: { mode: "explicit" } }] }] }, caps("gpt-5.6"))
  expect(responses.diagnostics).toMatchObject([{ code: "unsupported_cache_option", path: "$.input[0].content[0].prompt_cache_breakpoint" }])
})

test("supported instruction roles retain order after the first assistant reply", () => {
  const body = { model: "gpt-5.5", instructions: "Base", input: [
    { role: "developer", content: "Initial memory" }, { role: "user", content: "First task" },
    { role: "assistant", content: "First result" }, { role: "developer", content: "New memory" }, { role: "user", content: "Second task" },
  ] }
  const openai = parseRequest("responses", body, caps())
  expect(encodeChat(openai).messages).toEqual([{ role: "system", content: "Base" }, ...body.input])
  expect(openai.diagnostics).toEqual([])
  const ds = parseRequest("responses", body, caps("deepseek-flash", "https://api.deepseek.com/v1"))
  expect(encodeChat(ds).messages.map((m: Wire) => m.role)).toEqual(["system", "system", "user", "assistant", "system", "user"])
  expect(ds.diagnostics.map(d => d.code)).toEqual(["instruction_role_changed", "instruction_role_changed"])
  expect(encodeChat(ds).messages[4].content).toBe("New memory")
  const unknown = parseRequest("responses", body)
  expect(encodeChat(unknown).messages.at(-2)).toEqual({ role: "user", content: "<system-reminder>\nNew memory\n</system-reminder>" })
  expect(unknown.diagnostics.some(d => d.message.includes("downgraded"))).toBe(true)
  // Re-encoding the same request must not duplicate diagnostics.
  const count = unknown.diagnostics.length
  encodeChat(unknown)
  expect(unknown.diagnostics).toHaveLength(count)
})
