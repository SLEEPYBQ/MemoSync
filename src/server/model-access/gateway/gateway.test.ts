// Adapted from Magpie (https://github.com/yetone/magpie), MIT License, Copyright (c) 2026 yetone
// internal/gateway/translate_severed_test.go and translate_stream_test.go;
// local Bun servers replace httptest and exercise MemoSync's credential boundary.
import { afterEach, expect, test } from "bun:test"
import Anthropic from "@anthropic-ai/sdk"
import OpenAI from "openai"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ModelAccessService } from "../service"
import { fakeExecutableResolver } from "../test-fixtures"
import { resolveEngineRuntime } from "../runtime"
import { compatibleEndpointForEngine, connectionSupport, endpointForEngine } from "../../../shared/model-access"
import { gatewayEndpoint, stopGateway } from "./index"
import { readSSE } from "./stream"
import type { Target, Wire } from "./request"
import fixtures from "./fixtures/magpie-streams.json"

const dirs: string[] = [], servers: ReturnType<typeof Bun.serve>[] = []
afterEach(() => { stopGateway(); for (const s of servers.splice(0)) s.stop(true); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const chunk = (delta: Wire, finish_reason: string | null = null) => JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })
const textChunks = [chunk({ content: "Hel" }), chunk({ content: "lo" }, "stop"), JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } })]
function sse(chunks: string[], done = true) { return new Response([...chunks, ...(done ? ["[DONE]"] : [])].map(c => `data: ${c}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }) }
async function fixture(fetch: (r: Request) => Response | Promise<Response> = () => sse(textChunks)) {
  const up = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch }); servers.push(up)
  const dir = mkdtempSync(join(tmpdir(), "protocol-gateway-")); dirs.push(dir)
  const service = await new ModelAccessService({ dataDir: dir, env: { MEMOSYNC_CLI_PROFILE_DIR: join(dir, "profiles"), MEMOSYNC_ISOLATE_CLI: "1", OPENAI_API_KEY: "ambient-key" }, resolveExecutable: fakeExecutableResolver, readLegacyPi: async () => null }).initialize()
  const connection = await service.saveConnection({ name: "Chat only", apiKey: "upstream-secret", endpoints: [{ protocol: "openai-chat", baseUrl: `http://127.0.0.1:${up.port}/v1` }], models: [{ id: "m" }] })
  return { service, connection, up }
}
function body(target: Target, stream = true): Wire { return target === "anthropic" ? { model: "m", max_tokens: 100, stream, messages: [{ role: "user", content: "Hello" }] } : { model: "m", stream, input: "Hello" } }
function url(route: ReturnType<typeof gatewayEndpoint>, target: Target) { return route.endpoint.baseUrl + (target === "anthropic" ? "/v1/messages" : "/responses") }
async function post(route: ReturnType<typeof gatewayEndpoint>, target: Target, value = body(target)) {
  return fetch(url(route, target), { method: "POST", headers: { authorization: `Bearer ${route.key}`, "content-type": "application/json" }, body: JSON.stringify(value) })
}
async function events(response: Response): Promise<Wire[]> { const out = []; for await (const data of readSSE(response.body!)) out.push(JSON.parse(data)); return out }

for (const target of ["anthropic", "responses"] as const) {
  test(`${target}: real HTTP request through gateway sends only upstream credentials`, async () => {
    const received: Wire[] = []
    const f = await fixture(async r => { received.push({ auth: r.headers.get("authorization"), path: new URL(r.url).pathname, body: await r.json() }); return sse(textChunks) })
    const route = gatewayEndpoint(f.service, f.connection.id, target)
    const response = await post(route, target)
    expect(response.status).toBe(200)
    const out = await events(response)
    expect(out.map(e => e.type)).toEqual(target === "anthropic" ? ["message_start", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "message_delta", "message_stop"] : ["response.created", "response.in_progress", "response.output_item.added", "response.content_part.added", "response.output_text.delta", "response.output_text.delta", "response.output_text.done", "response.content_part.done", "response.output_item.done", "response.completed"])
    expect(received).toEqual([{ auth: "Bearer upstream-secret", path: "/v1/chat/completions", body: { model: "m", messages: [{ role: "user", content: "Hello" }], stream: true, stream_options: { include_usage: true }, ...(target === "anthropic" ? { max_tokens: 100 } : {}) } }])
    expect(JSON.stringify(out)).not.toContain("upstream-secret")
    expect(route.key).not.toBe("upstream-secret")
  })
  test(`${target}: streamed tool call followed by real tool-result request`, async () => {
    const requests: Wire[] = []
    const f = await fixture(async r => { requests.push(await r.json()); return sse(requests.length === 1 ? fixtures.TestChatTranslationToolCallIDRepeated : textChunks) })
    const route = gatewayEndpoint(f.service, f.connection.id, target)
    const out = await events(await post(route, target))
    const calls = target === "anthropic" ? out.filter(e => e.type === "content_block_start").map(e => ({ ...e.content_block, input: { city: "SF" } })) : out.filter(e => e.type === "response.output_item.done").map(e => e.item)
    const next = body(target)
    if (target === "anthropic") next.messages.push({ role: "assistant", content: calls }, { role: "user", content: [{ type: "tool_result", tool_use_id: calls[0].id, content: "Sunny" }] })
    else next.input = [{ role: "user", content: "Hello" }, ...calls, { type: "function_call_output", call_id: calls[0].call_id, output: "Sunny" }]
    await events(await post(route, target, next))
    expect(requests[1].messages.at(-1)).toEqual({ role: "tool", tool_call_id: "call_1", content: "Sunny" })
    expect(requests[1].messages.at(-2).tool_calls[0]).toEqual({ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } })
  })
  for (const status of [401, 404, 429]) test(`${target}: upstream ${status} retains status and safe client error shape`, async () => {
    const f = await fixture(() => Response.json({ error: { message: "echo upstream-secret" } }, { status }))
    const res = await post(gatewayEndpoint(f.service, f.connection.id, target), target)
    expect(res.status).toBe(status)
    const value = await res.json()
    expect(value.error.type).toBe(status === 401 ? "authentication_error" : status === 404 ? "not_found_error" : "rate_limit_error")
    if (target === "anthropic") expect(value.type).toBe("error")
    else expect(value.error.code).toBe(value.error.type)
    expect(JSON.stringify(value)).not.toContain("upstream-secret")
  })
  // A bare [DONE] after partial output is no more complete than EOF: only a finish reason ends an answer.
  for (const stream of [true, false]) for (const done of [false, true]) test(`${target}: ${done ? "[DONE] without a finish reason" : "early EOF"} is failure (stream=${stream})`, async () => {
    const f = await fixture(() => sse([chunk({ content: "partial" })], done))
    const res = await post(gatewayEndpoint(f.service, f.connection.id, target), target, body(target, stream))
    if (stream) {
      expect(res.status).toBe(200)
      const out = await events(res)
      expect(out.at(-1)?.type).toBe(target === "anthropic" ? "error" : "response.failed")
      expect(out.some(e => ["message_stop", "response.completed"].includes(e.type))).toBe(false)
    } else { expect(res.status).toBe(502); expect((await res.json()).error.message).toContain("disconnected") }
  })
  test(`${target}: socket read error does not emit a successful ending`, async () => {
    const f = await fixture()
    const tcp = createServer(socket => socket.once("data", () => {
      const partial = `data: ${chunk({ content: "partial" })}\n\n`
      socket.write(`HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: ${Buffer.byteLength(partial) + 100}\r\nConnection: close\r\n\r\n${partial}`)
      setTimeout(() => socket.end(), 20)
    }))
    await new Promise<void>(resolve => tcp.listen(0, "127.0.0.1", resolve))
    try {
      const address = tcp.address()
      if (!address || typeof address === "string") throw new Error("TCP fixture did not bind")
      await f.service.saveConnection({ ...f.connection, endpoints: [{ protocol: "openai-chat", baseUrl: `http://127.0.0.1:${address.port}` }] })
      const out = await events(await post(gatewayEndpoint(f.service, f.connection.id, target), target))
      expect(out.at(-1)?.type).toBe(target === "anthropic" ? "error" : "response.failed")
      expect(out.some(e => ["message_stop", "response.completed"].includes(e.type))).toBe(false)
    } finally { await new Promise<void>(resolve => tcp.close(() => resolve())) }
  })
  test(`${target}: malformed input and unsupported content fail before contacting upstream`, async () => {
    let count = 0
    const f = await fixture(() => { count++; return sse(textChunks) })
    const route = gatewayEndpoint(f.service, f.connection.id, target)
    const bad = body(target)
    const image = [{ type: target === "anthropic" ? "image" : "input_image", source: { type: "base64", media_type: "image/png", data: "AA" }, image_url: "https://example.test/i.png" }]
    if (target === "anthropic") bad.messages = [{ role: "user", content: image }]
    else bad.input = [{ role: "user", content: image }]
    expect((await post(route, target, bad)).status).toBe(400)
    expect((await post(route, target, { model: "m" })).status).toBe(400)
    expect(count).toBe(0)
  })
  test(`${target}: official SDK consumes both streaming and buffered responses`, async () => {
    const f = await fixture()
    const route = gatewayEndpoint(f.service, f.connection.id, target)
    if (target === "anthropic") {
      const client = new Anthropic({ baseURL: route.endpoint.baseUrl, apiKey: route.key, maxRetries: 0 })
      const final = await client.messages.stream({ model: "m", max_tokens: 100, messages: [{ role: "user", content: "Hello" }] }).finalMessage()
      expect(final.content).toMatchObject([{ type: "text", text: "Hello" }])
      expect((await client.messages.create({ model: "m", max_tokens: 100, messages: [{ role: "user", content: "Hello" }] })).content).toEqual(final.content)
    } else {
      const client = new OpenAI({ baseURL: route.endpoint.baseUrl, apiKey: route.key, maxRetries: 0 })
      const stream = await client.responses.create({ model: "m", input: "Hello", stream: true })
      const out = []
      for await (const ev of stream) out.push(ev.type)
      expect(out.at(-1)).toBe("response.completed")
      const final = await client.responses.create({ model: "m", input: "Hello" })
      expect(final.output_text).toBe("Hello")
    }
  })
  test(`${target}: official SDK consumes interleaved text, reasoning and parallel tools`, async () => {
    const chunks = [
      chunk({ tool_calls: [{ index: 0, id: "call_weather", function: { name: "weather", arguments: '{"city":' } }] }),
      chunk({ tool_calls: [{ index: 1, id: "call_units", function: { name: "units", arguments: '{"unit":' } }] }),
      chunk({ content: "Checking" }),
      chunk({ reasoning_content: "Think" }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"SF"}' } }] }),
      chunk({ content: " now" }),
      chunk({ tool_calls: [{ index: 1, function: { arguments: '"C"}' } }] }, "tool_calls"),
    ]
    const f = await fixture(() => sse(chunks))
    const route = gatewayEndpoint(f.service, f.connection.id, target)
    const buffered = await (await post(route, target, body(target, false))).json()
    if (target === "anthropic") {
      const client = new Anthropic({ baseURL: route.endpoint.baseUrl, apiKey: route.key, maxRetries: 0 })
      const completed: Wire[] = []
      const stream = client.messages.stream({ model: "m", max_tokens: 100, messages: [{ role: "user", content: "Hello" }] })
      stream.on("contentBlock", block => completed.push(block))
      const final = await stream.finalMessage()
      expect(final.stop_reason).toBe("tool_use")
      expect(final.content).toEqual(buffered.content)
      expect(completed).toEqual(final.content)
      expect(final.content).toMatchObject([
        { type: "tool_use", id: "call_weather", name: "weather", input: { city: "SF" } },
        { type: "text", text: "Checking" },
        { type: "thinking", thinking: "Think", signature: "" },
        { type: "text", text: " now" },
        { type: "tool_use", id: "call_units", name: "units", input: { unit: "C" } },
      ])
    } else {
      const client = new OpenAI({ baseURL: route.endpoint.baseUrl, apiKey: route.key, maxRetries: 0 })
      const final = await client.responses.stream({ model: "m", input: "Hello" }).finalResponse()
      expect(final.status).toBe("completed")
      const withoutIds = (items: Wire[]) => items.map(({ id, ...item }) => item)
      expect(withoutIds(final.output)).toMatchObject(withoutIds(buffered.output))
      expect(final.output.filter(c => c.type === "function_call")).toMatchObject([
        { call_id: "call_weather", name: "weather", arguments: '{"city":"SF"}' },
        { call_id: "call_units", name: "units", arguments: '{"unit":"C"}' },
      ])
      expect(final.output.filter(c => c.type === "message").flatMap(c => c.content).map(c => c.type === "output_text" ? c.text : "").join("")).toBe("Checking now")
      expect(final.output.find(c => c.type === "reasoning")).toMatchObject({ summary: [{ type: "summary_text", text: "Think" }] })
    }
  })
}

test("gateway authenticates, reuses listener, reads rotated keys and rejects deleted bindings", async () => {
  const keys: string[] = []
  const f = await fixture(r => { keys.push(r.headers.get("authorization")!); return sse(textChunks) })
  const a = gatewayEndpoint(f.service, f.connection.id, "anthropic"), b = gatewayEndpoint(f.service, f.connection.id, "responses")
  expect(new URL(a.endpoint.baseUrl).origin).toBe(new URL(b.endpoint.baseUrl).origin)
  expect(new URL(a.endpoint.baseUrl).hostname).toBe("127.0.0.1")
  expect((await fetch(url(a, "anthropic"), { method: "POST" })).status).toBe(401)
  expect(keys).toEqual([])
  await f.service.saveConnection({ ...f.connection, apiKey: "rotated" })
  await events(await post(a, "anthropic"))
  expect(keys).toEqual(["Bearer rotated"])
  await f.service.deleteConnection(f.connection.id)
  expect((await post(a, "anthropic")).status).toBe(404)
})

for (const engine of ["claude", "codex"] as const) test(`${engine}: chat-only runtime isolates and native endpoint wins`, async () => {
  const f = await fixture()
  await f.service.setEngine(engine, { access: { mode: "connection", connectionId: f.connection.id } })
  expect(f.service.getSnapshot().engines[engine]).toMatchObject({ ready: true, translated: true })
  expect(connectionSupport(engine, f.connection)).toBe("translated")
  expect(endpointForEngine(engine, f.connection)).toBeNull()
  expect(compatibleEndpointForEngine(engine, f.connection)?.protocol).toBe("openai-chat")
  const r = await resolveEngineRuntime({ engine, service: f.service })
  expect(r.isolated).toBe(true)
  expect(JSON.stringify(r)).not.toContain("upstream-secret")
  expect(JSON.stringify(r.env)).not.toContain("ambient-key")
  const route = gatewayEndpoint(f.service, f.connection.id, engine === "claude" ? "anthropic" : "responses")
  if (engine === "claude") { expect(r.env.ANTHROPIC_BASE_URL).toBe(route.endpoint.baseUrl); expect(r.env.ANTHROPIC_AUTH_TOKEN).toBe(route.key); expect(r.env.CLAUDE_CONFIG_DIR).toStartWith(realpathSync(f.service.dataDir)) }
  else { expect(r.args).toContain(`model_providers.memosync.base_url=${JSON.stringify(route.endpoint.baseUrl)}`); expect(r.env.MEMOSYNC_MODEL_API_KEY).toBe(route.key); expect(r.env.CODEX_HOME).toStartWith(realpathSync(f.service.dataDir)) }
  const native = await f.service.saveConnection({ ...f.connection, endpoints: [...f.connection.endpoints, { protocol: engine === "claude" ? "anthropic-messages" : "openai-responses", baseUrl: "https://native.test/v1" }] })
  expect(connectionSupport(engine, native)).toBe("native")
  const runtime = await resolveEngineRuntime({ engine, service: f.service })
  expect(f.service.getSnapshot().engines[engine].translated).toBeUndefined()
  if (engine === "claude") expect(runtime.env.ANTHROPIC_BASE_URL).toBe("https://native.test/v1")
  else expect(runtime.args).toContain('model_providers.memosync.base_url="https://native.test/v1"')
})

for (const custom of [false, true]) test(`Magpie gated arguments reach the client before upstream completion (custom=${custom})`, async () => {
  const patch = '*** Begin Patch\n*** Add File: a.go\n+package a\n+// "quoted" \\ é 😀\n*** End Patch\n'
  const args = custom ? JSON.stringify({ input: patch }) : '{"cmd":"go test ./...","yield_time_ms":1000}'
  const first = custom ? args.slice(0, 24) : '{"cmd":"go test ./...",'
  const rest = args.slice(first.length)
  const name = custom ? "apply_patch" : "exec_command"
  let upstream!: ReadableStreamDefaultController<Uint8Array>
  let released = false
  const utf8 = new TextEncoder()
  const f = await fixture(() => new Response(new ReadableStream<Uint8Array>({ start(c) {
    upstream = c
    c.enqueue(utf8.encode(`data: ${chunk({ tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: first } }] })}\n\n`))
  } }), { headers: { "content-type": "text/event-stream" } }))
  const request = { ...body("responses"), tools: [{ type: custom ? "custom" : "function", name, ...(custom ? { format: { type: "text" } } : { parameters: { type: "object" } }) }] }
  const res = await post(gatewayEndpoint(f.service, f.connection.id, "responses"), "responses", request)
  const deltas: string[] = []
  let item: Wire | undefined
  for await (const data of readSSE(res.body!)) {
    const ev = JSON.parse(data)
    if (ev.type === (custom ? "response.custom_tool_call_input.delta" : "response.function_call_arguments.delta")) {
      if (!deltas.length) {
        expect(released).toBe(false)
        expect(ev.delta).toBe(custom ? patch.slice(0, 24 - '{"input":"'.length) : first)
        released = true
        upstream.enqueue(utf8.encode(`data: ${chunk({ tool_calls: [{ index: 0, function: { arguments: rest } }] }, "tool_calls")}\n\ndata: [DONE]\n\n`))
        upstream.close()
      }
      deltas.push(ev.delta)
    }
    if (ev.type === "response.output_item.done") item = ev.item
  }
  expect(released).toBe(true)
  expect(deltas.join("")).toBe(custom ? patch : args)
  expect(item).toMatchObject(custom ? { type: "custom_tool_call", input: patch } : { type: "function_call", arguments: args })
})

test("downstream cancellation aborts the upstream request", async () => {
  let markAborted!: () => void
  const aborted = new Promise<void>(resolve => { markAborted = resolve })
  const f = await fixture(req => {
    req.signal.addEventListener("abort", markAborted, { once: true })
    return new Response(new ReadableStream<Uint8Array>({ start(c) {
      c.enqueue(new TextEncoder().encode(`data: ${chunk({ content: "waiting" })}\n\n`))
    } }), { headers: { "content-type": "text/event-stream" } })
  })
  const route = gatewayEndpoint(f.service, f.connection.id, "responses")
  const abort = new AbortController()
  const res = await fetch(url(route, "responses"), { method: "POST", headers: { authorization: `Bearer ${route.key}`, "content-type": "application/json" }, body: JSON.stringify(body("responses")), signal: abort.signal })
  const reader = res.body!.getReader()
  await reader.read()
  abort.abort()
  await aborted
  await reader.cancel().catch(() => {})
})
