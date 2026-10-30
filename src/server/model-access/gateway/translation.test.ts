// Adapted from Magpie (https://github.com/yetone/magpie), MIT License, Copyright (c) 2026 yetone
// internal/gateway/translate_stream_test.go: original chunks retained in fixtures.
import { expect, test } from "bun:test"
import fixtures from "./fixtures/magpie-streams.json"
import { encodeChat, parseRequest, type Target, type Wire } from "./request"
import { ChatDecoder, ClientEncoder, readSSE } from "./stream"

function translated(target: Target, chunks: string[]) {
  const decoder = new ChatDecoder(), encoder = new ClientEncoder(target, "m")
  encoder.start()
  for (const chunk of [...chunks, "[DONE]"]) for (const ev of decoder.decode(chunk)) encoder.event(ev)
  encoder.finish()
  return { events: encoder.drain(), result: encoder.result! }
}
const chunk = (delta: Wire, finish_reason: string | null = null) => JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })
const textChunks = [chunk({ content: "Hel" }), chunk({ content: "lo" }, "stop"), JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 } } })]
const schema = { type: "object", properties: { city: { type: "string" } }, required: ["city"] }

for (const target of ["anthropic", "responses"] as const) {
  test(`${target}: plain text stream has client event sequence and usage`, () => {
    const { events, result } = translated(target, textChunks)
    expect(events.map(e => e.type)).toEqual(target === "anthropic" ? ["message_start", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "message_delta", "message_stop"] : ["response.created", "response.in_progress", "response.output_item.added", "response.content_part.added", "response.output_text.delta", "response.output_text.delta", "response.output_text.done", "response.content_part.done", "response.output_item.done", "response.completed"])
    expect(target === "anthropic" ? result.content[0].text : result.output[0].content[0].text).toBe("Hello")
    expect(result.usage).toMatchObject(target === "anthropic" ? { input_tokens: 9, output_tokens: 4, cache_read_input_tokens: 3 } : { input_tokens: 12, output_tokens: 4, total_tokens: 16, output_tokens_details: { reasoning_tokens: 2 } })
    if (target === "responses") expect(events.map(e => e.sequence_number)).toEqual(events.map((_, i) => i))
  })
  for (const [name, chunks] of Object.entries(fixtures)) {
    if (name === "TestChatTranslationKeepsFirstChoice") continue
    test(`${target}: Magpie ${name}`, () => {
      const { result, events } = translated(target, chunks)
      const output = target === "anthropic" ? result.content : result.output
      if (name.includes("Choice") || name.includes("Indexes")) {
        expect(target === "anthropic" ? output[0].text : output[0].content[0].text).toBe("Hello")
      } else if (name.includes("Reasoning")) {
        expect(target === "anthropic" ? output[0].thinking : output[0].summary[0].text).toBe("The user wants")
      } else {
        const calls = output.filter((i: Wire) => i.type === (target === "anthropic" ? "tool_use" : "function_call"))
        const expected = name === "interleavedCalls" ? [["call_read", "read_file", { path: "a/b.go" }], ["call_list", "list_dir", { dir: "src/x" }]] : name.includes("Parallel") ? [["call_a", "one", { n: 1 }], ["call_b", "two", { n: 2 }]] : name.includes("NamedFirst") ? [["a", "one", { n: 1 }], ["b", "two", { n: 2 }]] : [["call_1", "get_weather", { city: "SF" }]]
        expect(calls.map((c: Wire) => [target === "anthropic" ? c.id : c.call_id, c.name, target === "anthropic" ? c.input : JSON.parse(c.arguments)])).toEqual(expected)
        for (let i = 0; i < calls.length; i++) {
          const args = events.filter(e => target === "anthropic" ? e.type === "content_block_delta" && e.index === i : e.type === "response.function_call_arguments.delta" && e.item_id === calls[i].id).map(e => target === "anthropic" ? e.delta.partial_json : e.delta).join("")
          expect(JSON.parse(args)).toEqual(expected[i][2])
        }
        if (target === "anthropic") expect(result.stop_reason).toBe("tool_use")
      }
    })
  }
  test(`${target}: tool schema, tool-call history and tool-result turn`, () => {
    const body = target === "anthropic" ? {
      model: "m", system: [{ type: "text", text: "Help" }], tools: [{ name: "weather", description: "Weather", input_schema: schema }], tool_choice: { type: "any", disable_parallel_tool_use: true }, max_tokens: 100,
      messages: [{ role: "user", content: "weather?" }, { role: "assistant", content: [{ type: "thinking", thinking: "Check" }, { type: "tool_use", id: "c1", name: "weather", input: { city: "SF" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: "Sunny" }] }] }],
    } : {
      model: "m", instructions: "Help", tools: [{ type: "function", name: "weather", description: "Weather", parameters: schema }], tool_choice: "required", parallel_tool_calls: false, max_output_tokens: 100,
      input: [{ role: "user", content: "weather?" }, { type: "reasoning", summary: [{ type: "summary_text", text: "Check" }] }, { type: "function_call", call_id: "c1", name: "weather", arguments: '{"city":"SF"}' }, { type: "function_call_output", call_id: "c1", output: "Sunny" }],
    }
    expect(encodeChat(parseRequest(target, body))).toEqual({ model: "m", stream: true, stream_options: { include_usage: true }, max_tokens: 100, tool_choice: "required", parallel_tool_calls: false,
      tools: [{ type: "function", function: { name: "weather", description: "Weather", parameters: schema } }],
      messages: [{ role: "system", content: "Help" }, { role: "user", content: "weather?" }, { role: "assistant", content: "", reasoning_content: "Check", tool_calls: [{ id: "c1", type: "function", function: { name: "weather", arguments: '{"city":"SF"}' } }] }, { role: "tool", tool_call_id: "c1", content: "Sunny" }],
    })
  })
  test(`${target}: length and content-filter stops`, () => {
    for (const reason of ["length", "content_filter"]) {
      const { result, events } = translated(target, [chunk({ content: "partial" }, reason)])
      if (target === "anthropic") expect(result.stop_reason).toBe(reason === "length" ? "max_tokens" : "refusal")
      else { expect(result.incomplete_details.reason).toBe(reason === "length" ? "max_output_tokens" : "content_filter"); expect(events.at(-1)?.type).toBe("response.incomplete") }
    }
  })
  test(`${target}: images, nested tool images and server tools are rejected`, () => {
    const base = target === "anthropic" ? { model: "m", messages: [{ role: "user", content: "hello" }] } : { model: "m", input: "hello" }
    const content = [{ type: target === "anthropic" ? "image" : "input_image", source: { type: "base64", data: "AA" }, image_url: "https://example.test/image" }]
    const image = target === "anthropic" ? { messages: [{ role: "user", content }] } : { input: [{ role: "user", content }] }
    const toolImage = target === "anthropic" ? { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "c", content }] }] } : { input: [{ type: "function_call_output", call_id: "c", output: content }] }
    for (const extra of [image, toolImage, { tools: [{ type: "web_search", name: "web" }] }]) expect(() => parseRequest(target, { ...base, ...extra })).toThrow("Cannot translate")
  })
}

test("Magpie first choice fixture locks content, reasoning and tool IDs", () => {
  const decoder = new ChatDecoder()
  const events = fixtures.TestChatTranslationKeepsFirstChoice.flatMap(c => decoder.decode(c))
  expect(events.filter(e => e.kind === "text").map(e => "text" in e ? e.text : "").join("")).toBe("Alpha done!")
  expect(events.filter(e => e.kind === "thinking").map(e => "text" in e ? e.text : "").join("")).toBe("First thought")
  expect(events.filter(e => e.kind === "tool")).toEqual([{ kind: "tool", id: "first", name: "right" }])
  expect(events.filter(e => e.kind === "args").map(e => "text" in e ? e.text : "").join("")).toBe('{"ok":true} more')
})

test("SSE accepts split UTF-8, CRLF, comments, multiline data and data without a space", async () => {
  const bytes = new TextEncoder().encode(': ping\r\nevent: chunk\r\ndata:{"text":\r\ndata: "你好"}\r\n\r\ndata:[DONE]')
  const stream = new ReadableStream<Uint8Array>({ start(c) { for (const b of bytes) c.enqueue(new Uint8Array([b])); c.close() } })
  const out = []
  for await (const data of readSSE(stream)) out.push(data)
  expect(out).toEqual(['{"text":\n"你好"}', "[DONE]"])
})

test("Responses custom and namespaced tools preserve schema, call identity and next-turn history", () => {
  const input = { model: "m", input: "edit", tools: [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "apply_patch", format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } }, { type: "function", name: "run", parameters: { type: "object" }, strict: true }] }], tool_choice: { type: "custom", namespace: "functions", name: "apply_patch" } }
  const r = parseRequest("responses", input)
  const chat = encodeChat(r)
  expect(chat.tools[0].function.parameters.required).toEqual(["input"])
  expect(chat.tools[0].function.description).toContain("start: /.+/")
  expect(chat.tools[1].function.strict).toBe(true)
  expect(chat.tool_choice.function.name).toBe("functions__apply_patch")
  const patch = '*** Begin Patch\n*** Add File: a.go\n+package a\n+// "quoted" \\ é 😀\n*** End Patch\n'
  const args = JSON.stringify({ input: patch })
  const decoder = new ChatDecoder(), encoder = new ClientEncoder("responses", "m", r.toolMappings)
  encoder.start()
  const chunks = [chunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: "functions__apply_patch", arguments: args.slice(0, 24) } }] }), chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(24) } }] }, "tool_calls")]
  for (const c of chunks) for (const e of decoder.decode(c)) encoder.event(e)
  encoder.finish()
  const events = encoder.drain()
  expect(events.filter(e => e.type === "response.custom_tool_call_input.delta").map(e => e.delta).join("")).toBe(patch)
  const call = encoder.result!.output[0]
  expect(call).toMatchObject({ type: "custom_tool_call", namespace: "functions", name: "apply_patch", input: patch, call_id: "call_1" })
  const next = encodeChat(parseRequest("responses", { ...input, input: [call, { type: "custom_tool_call_output", call_id: "call_1", output: "Applied" }] }))
  expect(next.messages[0].tool_calls[0].function).toEqual({ name: "functions__apply_patch", arguments: args })
  expect(next.messages[1]).toEqual({ role: "tool", tool_call_id: "call_1", content: "Applied" })
})

test("Claude Code turn-level system instructions keep their role and position", () => {
  const request = parseRequest("anthropic", { model: "m", system: "Global instructions", messages: [{ role: "user", content: [{ type: "text", text: "Question" }] }, { role: "system", content: "Turn instructions" }] })
  expect(encodeChat(request).messages).toEqual([{ role: "system", content: "Global instructions" }, { role: "user", content: "Question" }, { role: "system", content: "Turn instructions" }])
})
