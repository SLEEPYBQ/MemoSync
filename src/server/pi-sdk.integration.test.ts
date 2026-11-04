import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { HarnessEvent } from "./harness-types"
import { PiAgentManager, type StartPiTurnArgs } from "./pi-agent"

// Drives the real Pi SDK against a local endpoint and asserts on the HTTP it
// sends: 1.x fails silently here, ignoring a hook or routing to the wrong API.
// MEMOSYNC_TEST_PI_SDK checks another release, such as an installed minimum.
const sdkEntry = process.env.MEMOSYNC_TEST_PI_SDK
const loadSdk = sdkEntry ? (() => import(sdkEntry)) as never : undefined

type Request = { path: string; authorization: string | null; body: any }
type Reply = { text: string } | { toolCall: { name: string; args: object } }

let root: string
let cwd: string
let requests: Request[]
let replies: Reply[]
let server: ReturnType<typeof Bun.serve>
const managers: PiAgentManager[] = []

function chatChunks(reply: Reply) {
  const delta = "text" in reply
    ? { role: "assistant", content: reply.text }
    : { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: reply.toolCall.name, arguments: JSON.stringify(reply.toolCall.args) } }] }
  return [
    { id: "c", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta, finish_reason: null }] },
    { id: "c", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "text" in reply ? "stop" : "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
  ]
}

function responsesChunks(text: string) {
  const item = { type: "message", id: "i1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }
  return [
    { type: "response.created", response: { id: "r1" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.content_part.added", part: { type: "output_text", text: "" } },
    { type: "response.output_text.delta", delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "r1", status: "completed", output: [item], usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } },
  ]
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "memosync-pi-sdk-")))
  cwd = join(root, "project")
  await mkdir(cwd)
  requests = []
  replies = []
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    requests.push({ path, authorization: request.headers.get("authorization"), body: await request.json() })
    const reply = replies.shift() ?? { text: "done" }
    const chunks = path.endsWith("/responses") ? responsesChunks("text" in reply ? reply.text : "done") : chatChunks(reply)
    const payload = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n"
    return new Response(payload, { headers: { "content-type": "text/event-stream" } })
  } })
})

afterEach(async () => {
  for (const manager of managers.splice(0)) manager.dispose()
  await server.stop(true)
  await rm(root, { recursive: true, force: true })
})

function connection(overrides: Partial<NonNullable<StartPiTurnArgs["connection"]>> = {}): NonNullable<StartPiTurnArgs["connection"]> {
  return { provider: "custom", baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "fixture-key", ...overrides }
}

function manager() {
  const created = new PiAgentManager({ dataDir: join(root, "data"), loadModels: async () => [], ...(loadSdk ? { loadSdk } : {}) })
  managers.push(created)
  return created
}

function turnArgs(overrides: Partial<StartPiTurnArgs> = {}): StartPiTurnArgs {
  return { chatId: "chat", cwd, content: "hello", model: "fixture-model", effort: "medium", sessionToken: null, forkSession: false, connection: connection(), ...overrides }
}

async function run(pi: PiAgentManager, args: StartPiTurnArgs) {
  const events: HarnessEvent[] = []
  for await (const event of (await pi.startTurn(args)).stream) events.push(event)
  const entries = events.flatMap(event => event.type === "transcript" && event.entry ? [event.entry as any] : [])
  return {
    entries,
    text: entries.filter(entry => entry.kind === "assistant_text").map(entry => entry.text).join(""),
    result: entries.find(entry => entry.kind === "result"),
    sessionToken: events.flatMap(event => event.type === "session_token" && event.sessionToken ? [event.sessionToken] : []).at(-1),
  }
}

const systemText = (body: any) => body.messages.filter((m: any) => m.role === "system" || m.role === "developer").map((m: any) => typeof m.content === "string" ? m.content : m.content.map((part: any) => part.text).join("")).join("\n")
const toolNames = (body: any) => (body.tools ?? []).map((tool: any) => tool.function?.name ?? tool.name).sort()

describe("Pi SDK turns", () => {
  test("a chat connection reaches its endpoint with its key and every built-in tool", async () => {
    const { text, result, sessionToken } = await run(manager(), turnArgs())
    expect(result).toMatchObject({ isError: false })
    expect(text).toBe("done")
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ path: "/v1/chat/completions", authorization: "Bearer fixture-key" })
    expect(toolNames(requests[0]!.body)).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"])
    expect(sessionToken?.startsWith(join(root, "data/sessions"))).toBe(true)
  })

  test("the connection's protocol decides the API, whatever provider it came from", async () => {
    // Pi's built-in "openai" provider would send both of these to /responses.
    await run(manager(), turnArgs({ connection: connection({ provider: "openai", protocol: "openai-chat" }) }))
    expect(requests.at(-1)?.path).toBe("/v1/chat/completions")
    const { result } = await run(manager(), turnArgs({ chatId: "responses", connection: connection({ provider: "openai", protocol: "openai-responses" }) }))
    expect(requests.at(-1)?.path).toBe("/v1/responses")
    expect(result).toMatchObject({ isError: false })
  })

  test("an OpenRouter connection still honours the chat API", async () => {
    await run(manager(), turnArgs({ connection: connection({ provider: "openrouter", protocol: "openai-chat" }) }))
    expect(requests.at(-1)).toMatchObject({ path: "/v1/chat/completions", authorization: "Bearer fixture-key" })
  })

  test("a connection without a key still runs, as local servers need", async () => {
    const { result } = await run(manager(), turnArgs({ connection: connection({ apiKey: "" }) }))
    expect(result).toMatchObject({ isError: false })
    expect(requests).toHaveLength(1)
  })

  test("a branch sends its parent's prompt exactly, and keeps its tools", async () => {
    await run(manager(), turnArgs({ systemPrompt: "FROZEN PARENT PROMPT", toolNames: ["read"] }))
    expect(systemText(requests[0]!.body)).toBe("FROZEN PARENT PROMPT")
    expect(toolNames(requests[0]!.body)).toEqual(["read"])
  })

  test("the prompt a parent records is what its branches then send", async () => {
    let recorded: string | undefined
    await run(manager(), turnArgs({ onLaunch: launch => { recorded = launch.options.systemPrompt } }))
    expect(recorded).toBe(systemText(requests[0]!.body))
  })

  test("structured output reaches the request body", async () => {
    const pi = manager()
    const modelCard = { id: "fixture-model", label: "fixture-model", supportsEffort: false, reasoningEfforts: ["default"], defaultReasoningEffort: "default", supportsStructuredOutput: true, metadataSource: "pi", reasoningKind: "none" } as never
    await run(pi, turnArgs({ modelCard, outputSchema: { type: "object", properties: {} } }))
    expect(requests[0]!.body.response_format?.type).toBe("json_schema")
  })

  test("a reused session changes model and key without restarting", async () => {
    const pi = manager()
    await run(pi, turnArgs())
    const { result } = await run(pi, turnArgs({ model: "second-model", connection: connection({ apiKey: "rotated-key" }) }))
    expect(result).toMatchObject({ isError: false })
    expect(requests[1]).toMatchObject({ authorization: "Bearer rotated-key" })
    expect(requests[1]!.body.model).toBe("second-model")
    expect(requests[1]!.body.messages.some((m: any) => JSON.stringify(m.content).includes("hello"))).toBe(true)
  })

  test("memory tools run through the turn's dispatch", async () => {
    replies = [{ toolCall: { name: "memory_lookup", args: { query: "cats" } } }, { text: "found it" }]
    const calls: unknown[] = []
    const { text, entries } = await run(manager(), turnArgs({
      toolNames: [],
      memorySpecs: [{ name: "memory_lookup", description: "Look up a memory", schema: { query: z.string() } }] as never,
      memoryDispatch: async (name, args) => { calls.push([name, args]); return { text: "cats are good" } },
    }))
    expect(calls).toEqual([["memory_lookup", { query: "cats" }]])
    expect(text).toBe("found it")
    expect(entries.find(entry => entry.kind === "tool_result")).toMatchObject({ isError: false })
    expect(JSON.stringify(requests[1]!.body.messages)).toContain("cats are good")
  })

  test("a tool gate can refuse a call before it runs", async () => {
    const marker = join(cwd, "ran")
    replies = [{ toolCall: { name: "bash", args: { command: `touch ${marker}` } } }, { text: "ok" }]
    const { entries } = await run(manager(), turnArgs({ beforeToolCall: async () => ({ block: true, reason: "read-only branch" }) }))
    expect(entries.find(entry => entry.kind === "tool_result")).toMatchObject({ isError: true })
    expect(JSON.stringify(requests[1]!.body.messages)).toContain("read-only branch")
    expect(await readdir(cwd)).toEqual([])
  })

  test("the bash tool runs without ambient credentials", async () => {
    const previous = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "ambient-secret"
    try {
      replies = [{ toolCall: { name: "bash", args: { command: 'echo "key=[$OPENAI_API_KEY]"' } } }, { text: "ok" }]
      await run(manager(), turnArgs())
      const sent = JSON.stringify(requests[1]!.body.messages)
      expect(sent).toContain("key=[]")
      expect(sent).not.toContain("ambient-secret")
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previous
    }
  })

  test("a session written by Pi 0.73 resumes with its history", async () => {
    const file = join(root, "old-session.jsonl")
    const at = "2026-05-07T00:00:00.000Z"
    // The shape 0.73.1 writes, captured from a real run of that release.
    await writeFile(file, [
      { type: "session", version: 3, id: "01a1a689-4cb9-7494-a092-dfb55151a538", timestamp: at, cwd },
      { type: "model_change", id: "8850551f", parentId: null, timestamp: at, provider: "custom", modelId: "m" },
      { type: "thinking_level_change", id: "b4b43f37", parentId: "8850551f", timestamp: at, thinkingLevel: "off" },
      { type: "message", id: "1c80727c", parentId: "b4b43f37", timestamp: at, message: { role: "user", content: [{ type: "text", text: "old question" }], timestamp: 1 } },
      { type: "message", id: "088f01ff", parentId: "1c80727c", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: "old reply" }], api: "openai-completions", provider: "custom", model: "m", usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 8, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 } },
    ].map(entry => JSON.stringify(entry)).join("\n") + "\n")
    const { result } = await run(manager(), turnArgs({ sessionToken: file }))
    expect(result).toMatchObject({ isError: false })
    const sent = JSON.stringify(requests[0]!.body.messages)
    expect(sent).toContain("old question")
    expect(sent).toContain("old reply")
  })
})
