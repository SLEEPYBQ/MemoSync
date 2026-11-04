import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import type { HostNativeToolContext } from "../shared/host-actions"
import { HOST_ACTION_TOOL_NAMES } from "../shared/host-actions"
import { CodexAppServerManager } from "./codex-app-server"
import { PiAgentManager } from "./pi-agent"
import { hostActionToolSpecs, dispatchHostAction } from "./host-actions"
import { createOpencodeMemoryMcp } from "./memory/opencode-adapter"

class NativeProcess extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  constructor() {
    super()
    let buffer = ""
    this.stdin.on("data", chunk => {
      buffer += chunk.toString()
      const lines = buffer.split("\n"); buffer = lines.pop() ?? ""
      for (const line of lines) {
        const message = JSON.parse(line)
        if (!message.method) this.emit("rpc-response", message)
        if (message.method === "initialize") this.emitMessage({ id: message.id, result: {} })
        if (message.method === "thread/start") this.emitMessage({ id: message.id, result: { thread: { id: "native-thread" } } })
        if (message.method === "turn/start") this.emitMessage({ id: message.id, result: { turn: { id: "native-turn", status: "inProgress" } } })
      }
    })
  }
  emitMessage(value: unknown) { this.stdout.write(`${JSON.stringify(value)}\n`) }
  kill() { this.emit("close", 0); return true }
}

test("Codex native callback captures process/thread/turn/call; wrong turn or thread has no authority", async () => {
  const child = new NativeProcess()
  const manager = new CodexAppServerManager({ spawnProcess: () => child as never })
  const observations: (HostNativeToolContext | undefined)[] = []
  try {
    await manager.startSession({
      chatId: "chat", cwd: os.tmpdir(), model: "unused-test-model", sessionToken: null, subprocessEnv: {},
      runtime: { engine: "codex", executable: { state: "ready" }, env: {}, args: [], model: "unused-test-model", isolated: true },
    })
    const turn = await manager.startTurn({
      chatId: "chat", model: "unused-test-model", content: "test", planMode: false, onToolRequest: async () => ({}),
      onDynamicToolCall: async (_name, _args, native) => { observations.push(native); return { text: "ok" } },
    })
    for (const [index, params] of [
      { threadId: "native-thread", turnId: "native-turn", callId: "real-call" },
      { threadId: "native-thread", turnId: "stale-turn", callId: "stale-call" },
      { threadId: "other-thread", turnId: "native-turn", callId: "other-call" },
    ].entries()) {
      const replied = new Promise<{ error?: { message: string } }>(resolve => { child.once("rpc-response", resolve) })
      child.emitMessage({ id: `rpc-${index}`, method: "item/tool/call", params: { ...params, tool: HOST_ACTION_TOOL_NAMES.openFile, arguments: { path: "README.md", nativeSessionId: "model-chosen" } } })
      const reply = await replied
      if (index > 0) expect(reply.error?.message).toBe("Stale native request")
    }
    expect(observations[0]).toMatchObject({ nativeSessionId: "native-thread", nativeTurnId: "native-turn", nativeToolCallId: "real-call" })
    expect(observations[0]?.engineInstanceId).toBeString()
    expect(Object.isFrozen(observations[0])).toBe(true)
    expect(observations).toHaveLength(1)
    turn.close()
  } finally { await manager.stopAll() }
})

test("Pi custom tool execute forwards actual native session and call id, independent of tool arguments", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "memosync-host-pi-")))
  let tools: ToolDefinition[] = []
  const observed: (HostNativeToolContext | undefined)[] = []
  const session = {
    sessionId: "pi-native-session", sessionFile: path.join(root, "session.jsonl"), systemPrompt: "test",
    isStreaming: false, subscribe: () => () => {}, abort: async () => {}, dispose() {},
    async prompt() {
      const tool = tools.find(tool => tool.name === HOST_ACTION_TOOL_NAMES.openFile)!
      await tool.execute("pi-native-call", { path: "README.md", nativeToolCallId: "model-chosen" }, undefined, async () => {}, {} as never)
    },
  }
  const sdk = {
    ModelRuntime: { create: async () => ({ setRuntimeApiKey: async () => {}, registerProvider() {}, getModel: () => undefined }) },
    SettingsManager: { inMemory: () => ({}) },
    DefaultResourceLoader: class { async reload() {} },
    SessionManager: { create: () => ({}) },
    createAgentSession: async (args: { customTools: ToolDefinition[] }) => { tools = args.customTools; return { session } },
  }
  const manager = new PiAgentManager({ dataDir: root, loadModels: async () => [], loadSdk: async () => sdk as never })
  try {
    const turn = await manager.startTurn({
      chatId: "pi-chat", cwd: root, content: "test", model: "unused", effort: "medium", sessionToken: null, forkSession: false,
      toolNames: [], connection: { provider: "custom", baseUrl: "https://unused.invalid", apiKey: "unused" },
      memorySpecs: hostActionToolSpecs(), memoryDispatch: async (_name, _args, _signal, native) => { observed.push(native); return { text: "ok" } },
    })
    for await (const _event of turn.stream) { /* Drain the mocked native prompt. */ }
    expect(observed).toHaveLength(1)
    expect(observed[0]).toMatchObject({ nativeSessionId: "pi-native-session", nativeToolCallId: "pi-native-call" })
    expect(observed[0]?.engineInstanceId).toBeString()
    expect(Object.isFrozen(observed[0])).toBe(true)
  } finally { manager.dispose(); await rm(root, { recursive: true, force: true }) }
})

test("OpenCode authenticated real MCP bridge dispatches host tools unavailable without native provenance", async () => {
  const bridge = createOpencodeMemoryMcp(hostActionToolSpecs(), (name, args) => dispatchHostAction(undefined, undefined, name, args))
  try {
    const unauthorized = await fetch(bridge.config.url, { method: "POST", body: JSON.stringify({ id: 1, method: "tools/list" }) })
    expect(unauthorized.status).toBe(401)
    for (const id of [1, "1"]) {
      const response = await fetch(bridge.config.url, { method: "POST", headers: { ...bridge.config.headers, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: HOST_ACTION_TOOL_NAMES.openFile, arguments: { path: "README.md" } } }) })
      const body = await response.json() as { id: string | number; result: { content: { text: string }[]; isError: boolean } }
      expect(body.id).toBe(id)
      expect(body.result.isError).toBe(true)
      expect(JSON.parse(body.result.content[0]!.text).status).toBe("unavailable")
    }
  } finally { bridge.close() }
})


test("Pi abort completes before rebinding native dispatch and policy hooks", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "memosync-host-pi-rebind-")))
  let tools: ToolDefinition[] = []
  let releaseAbort!: () => void, enteredAbort!: () => void, finishFirst!: () => void
  const aborting = new Promise<void>(resolve => { enteredAbort = resolve })
  const abortDone = new Promise<void>(resolve => { releaseAbort = resolve })
  const firstPrompt = new Promise<void>(resolve => { finishFirst = resolve })
  let prompts = 0, secondCalls = 0
  const oldGate = async () => undefined
  const session = {
    sessionId: "pi-rebind-session", sessionFile: undefined, systemPrompt: "stable", isStreaming: false,
    agent: {} as Record<string, unknown>, subscribe: () => () => {}, dispose() {},
    async abort() { enteredAbort(); await abortDone; session.isStreaming = false; finishFirst() },
    async prompt() {
      if (++prompts === 1) { session.isStreaming = true; await firstPrompt; return }
      const tool = tools.find(tool => tool.name === HOST_ACTION_TOOL_NAMES.openFile)!
      await tool.execute("second-call", { path: "README.md" }, undefined, async () => {}, {} as never)
    },
  }
  const sdk = {
    ModelRuntime: { create: async () => ({ setRuntimeApiKey: async () => {}, registerProvider() {}, getModel: () => undefined }) },
    SettingsManager: { inMemory: () => ({}) }, DefaultResourceLoader: class { async reload() {} },
    SessionManager: { create: () => ({}) },
    createAgentSession: async (args: { customTools: ToolDefinition[] }) => { tools = args.customTools; return { session } },
  }
  const manager = new PiAgentManager({ dataDir: root, loadModels: async () => [], loadSdk: async () => sdk as never })
  const args = { chatId: "rebind", cwd: root, content: "test", model: "unused", effort: "medium" as const,
    sessionToken: null, forkSession: false, toolNames: [], memorySpecs: hostActionToolSpecs(),
    connection: { provider: "custom" as const, baseUrl: "https://unused.invalid", apiKey: "unused" } }
  try {
    const first = await manager.startTurn({ ...args, beforeToolCall: oldGate, memoryDispatch: async () => ({ text: "old turn" }) })
    const nativeHook = session.agent.beforeToolCall
    const pending = manager.startTurn({ ...args, beforeToolCall: async () => ({ block: true, reason: "new gate" }),
      memoryDispatch: async (_name, _input, _signal, native) => { secondCalls++; expect(native?.nativeToolCallId).toBe("second-call"); return { text: "new turn" } } })
    await aborting
    const execute = tools.find(tool => tool.name === HOST_ACTION_TOOL_NAMES.openFile)!.execute
    await expect(execute("stale-call", { path: "README.md" }, undefined, async () => {}, {} as never)).rejects.toThrow("not available")
    expect(secondCalls).toBe(0)
    expect(session.agent.beforeToolCall).toBe(nativeHook)
    releaseAbort()
    const second = await pending
    for await (const _event of second.stream) { /* Drain the replacement prompt. */ }
    expect(secondCalls).toBe(1)
    await expect(execute("late-call", { path: "README.md" }, undefined, async () => {}, {} as never)).rejects.toThrow("not available")
    first.close()
    second.close()
  } finally { releaseAbort(); finishFirst(); manager.dispose(); await rm(root, { recursive: true, force: true }) }
})
