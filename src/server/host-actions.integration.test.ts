import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ServerWebSocket } from "bun"
import type { ClientCommand, ServerEnvelope } from "../shared/protocol"
import { HOST_ACTION_CAPABILITY, HOST_ACTION_TOOL_NAMES } from "../shared/host-actions"
import { AgentCoordinator } from "./agent"
import { EventStore } from "./event-store"
import { HarnessPolicyService } from "./harness-policy"
import { HostActionService } from "./host-actions"
import type { HarnessTurn } from "./harness-types"
import type { StartPiTurnArgs } from "./pi-agent"
import { createWsRouter, type ClientState } from "./ws-router"

class Socket {
  data: ClientState = { subscriptions: new Map(), snapshotSignatures: new Map() }
  sent: ServerEnvelope[] = []
  send(raw: string) { this.sent.push(JSON.parse(raw)); return raw.length }
  get ws() { return this as unknown as ServerWebSocket<ClientState> }
  ack(id: string) { return this.sent.find(event => event.type === "ack" && event.id === id) as Extract<ServerEnvelope, { type: "ack" }> | undefined }
}

test("production coordinator -> native tool dispatch -> existing WS pipeline -> scoped snapshot -> rendered ACK", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "memosync-host-pipeline-")))
  const workspace = path.join(root, "workspace")
  await mkdir(workspace)
  await writeFile(path.join(workspace, "README.md"), "# Pipeline\n")
  const store = new EventStore(path.join(root, "data"))
  await store.initialize()
  const project = await store.openProject(workspace)
  const chat = await store.createChat(project.id)
  await store.renameChat(chat.id, "Host pipeline")
  const harnessPolicies = new HarnessPolicyService()
  const service = new HostActionService({ dataDir: store.dataDir, policy: harnessPolicies })
  const toolReceipts: Record<string, unknown>[] = []
  const launches: StartPiTurnArgs[] = []
  let release!: () => void
  const done = new Promise<void>(resolve => { release = resolve })
  const piManager = {
    async startTurn(args: StartPiTurnArgs): Promise<HarnessTurn> {
      launches.push(args)
      expect(args.memorySpecs?.map(spec => spec.name)).toEqual(Object.values(HOST_ACTION_TOOL_NAMES))
      const native = { engineInstanceId: "actual-pi-instance", nativeSessionId: "actual-pi-session", nativeToolCallId: `call-${launches.length}` }
      const receipt = await args.memoryDispatch!(HOST_ACTION_TOOL_NAMES.openFile, { path: "README.md", view: "preview" }, undefined, native)
      toolReceipts.push(JSON.parse(receipt.text))
      return { provider: "pi", stream: (async function* () { await done })(), interrupt: async () => release(), close: () => release() }
    },
    closeChat() { release() }, dispose() { release() },
  }
  const agent = new AgentCoordinator({
    store, harnessPolicies, hostActions: service, onStateChange: () => {}, piManager: piManager as never,
    memory: null, capture: null, memoryTrace: null, memoryPreview: false,
    resolvePiConnection: async () => ({ provider: "custom", baseUrl: "https://unused.invalid", apiKey: "unused-test-value" }),
  })
  const router = createWsRouter({
    store, agent, hostActions: service,
    terminals: { onEvent: () => () => {} } as never,
    keybindings: { onChange: () => () => {} } as never,
    getDiscoveredProjects: () => [], refreshDiscovery: async () => [], machineDisplayName: "Test", updateManager: null,
  })
  const origin = new Socket(), other = new Socket()
  let sequence = 0
  const command = async (socket: Socket, value: ClientCommand) => {
    const id = `cmd-${++sequence}`
    await router.handleMessage(socket.ws, JSON.stringify({ v: 1, type: "command", id, command: value }))
    return { id, result: socket.ack(id)?.result }
  }
  try {
    router.handleOpen(origin.ws); router.handleOpen(other.ws)
    const bound = await command(origin, { type: "host.actions.bind", capabilities: [HOST_ACTION_CAPABILITY] })
    expect(bound.result).toHaveProperty("resumeToken")
    await router.handleMessage(origin.ws, JSON.stringify({ v: 1, type: "subscribe", id: "chat-sub", topic: { type: "chat", chatId: chat.id } }))
    await command(other, { type: "host.actions.bind", capabilities: [HOST_ACTION_CAPABILITY] })
    await router.handleMessage(other.ws, JSON.stringify({ v: 1, type: "subscribe", id: "other-chat-sub", topic: { type: "chat", chatId: chat.id } }))
    await command(origin, { type: "chat.send", chatId: chat.id, provider: "pi", model: "test-model", content: "Show README" })
    expect(toolReceipts[0]).toMatchObject({ status: "accepted", delivery: "sent" })
    const requested = origin.sent.find(event => event.type === "host.action.requested")
    if (requested?.type !== "host.action.requested") throw new Error("Missing actual WS host request")
    expect(requested.targetClientId).toBe((bound.result as { clientId: string }).clientId)
    expect(other.sent.some(event => event.type === "host.action.requested")).toBe(false)
    const denied = await command(other, { type: "host.action.readSnapshot", operationId: requested.operationId })
    expect(other.sent.some(event => event.type === "error" && event.id === denied.id)).toBe(true)
    const snapshot = await command(origin, { type: "host.action.readSnapshot", operationId: requested.operationId })
    expect(snapshot.result).toMatchObject({ content: "# Pipeline\n", version: requested.snapshot.version, digest: requested.snapshot.digest })
    const presented = await command(origin, { type: "host.action.presented", operationId: requested.operationId, viewInstanceId: "snapshot-tab", fileVersion: requested.snapshot.version, digest: requested.snapshot.digest })
    expect(presented.result).toMatchObject({ status: "presented", observedContent: requested.snapshot })
    const status = await launches[0]!.memoryDispatch!(HOST_ACTION_TOOL_NAMES.actionStatus, { operationId: requested.operationId }, undefined,
      { engineInstanceId: "actual-pi-instance", nativeSessionId: "actual-pi-session", nativeToolCallId: "status-call" })
    expect(JSON.parse(status.text).status).toBe("presented")
    expect(origin.sent.filter(event => event.type === "host.action.requested")).toHaveLength(1)
    expect(origin.sent.some(event => event.type === "snapshot")).toBe(true)
    router.handleClose(origin.ws)
    const reconnect = new Socket()
    router.handleOpen(reconnect.ws)
    await command(reconnect, { type: "host.actions.bind", capabilities: [HOST_ACTION_CAPABILITY], resumeToken: (bound.result as { resumeToken: string }).resumeToken })
    await router.handleMessage(reconnect.ws, JSON.stringify({ v: 1, type: "subscribe", id: "again", topic: { type: "chat", chatId: chat.id } }))
    expect(reconnect.sent.some(event => event.type === "host.action.requested")).toBe(false)
  } finally {
    release()
    await agent.cancel(chat.id)
    await agent.shutdownRuntime()
    router.dispose()
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})


test("actual WS new-chat send retains its originating window across subscription retry and safe resume", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "memosync-host-new-chat-")))
  const workspace = path.join(root, "workspace")
  await mkdir(workspace)
  await writeFile(path.join(workspace, "README.md"), "# First turn\n")
  const store = new EventStore(path.join(root, "data"))
  await store.initialize()
  const project = await store.openProject(workspace)
  const harnessPolicies = new HarnessPolicyService()
  const service = new HostActionService({ dataDir: store.dataDir, policy: harnessPolicies })
  let launch!: StartPiTurnArgs
  let firstReceipt: unknown
  let release!: () => void
  const done = new Promise<void>(resolve => { release = resolve })
  const native = { engineInstanceId: "new-chat-pi", nativeSessionId: "new-chat-native", nativeToolCallId: "show-readme" }
  const toolInput = { path: "README.md", idempotencyKey: "first-turn-file" }
  const agent = new AgentCoordinator({
    store, harnessPolicies, hostActions: service, onStateChange: () => {},
    memory: null, capture: null, memoryTrace: null, memoryPreview: false,
    getMemorySettings: () => ({ enabled: false, learn: false, control: "review" }),
    generateTitle: async () => ({ title: "New chat snapshot", usedFallback: true, failureMessage: null }),
    resolvePiConnection: async () => ({ provider: "custom", baseUrl: "https://unused.invalid", apiKey: "unused-test-value" }),
    piManager: {
      async startTurn(args: StartPiTurnArgs): Promise<HarnessTurn> {
        launch = args
        firstReceipt = JSON.parse((await args.memoryDispatch!(HOST_ACTION_TOOL_NAMES.openFile, toolInput, undefined, native)).text)
        return { provider: "pi", stream: (async function* () { await done })(), interrupt: async () => release(), close: () => release() }
      },
      closeChat() { release() }, dispose() { release() },
    } as never,
  })
  const router = createWsRouter({ store, agent, hostActions: service,
    terminals: { onEvent: () => () => {} } as never, keybindings: { onChange: () => () => {} } as never,
    getDiscoveredProjects: () => [], refreshDiscovery: async () => [], machineDisplayName: "Test", updateManager: null,
  })
  const sessionPath = `/test-session/${crypto.randomUUID()}`
  let disconnected!: () => void
  const disconnectObserved = new Promise<void>(resolve => { disconnected = resolve })
  const server = Bun.serve<ClientState>({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      // Test-owned authenticated upgrade; the router receives only admitted sockets.
      if (new URL(request.url).pathname !== sessionPath) return new Response("Unauthorized", { status: 401 })
      if (server.upgrade(request, { data: { subscriptions: new Map(), snapshotSignatures: new Map() } })) return
      return new Response("Upgrade required", { status: 426 })
    },
    websocket: {
      open: ws => router.handleOpen(ws),
      message: (ws, raw) => { void router.handleMessage(ws, raw.toString()) },
      close: ws => { router.handleClose(ws); disconnected() },
    },
  })
  const peers: WebSocket[] = []
  let sequence = 0
  async function connect() {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}${sessionPath}`)
    peers.push(ws)
    const messages: ServerEnvelope[] = []
    const waiters = new Set<() => void>()
    ws.addEventListener("message", event => { messages.push(JSON.parse(String(event.data))); for (const wake of waiters) wake() })
    await new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve(), { once: true }); ws.addEventListener("error", reject, { once: true }) })
    function waitFor(predicate: (event: ServerEnvelope) => boolean) {
      return new Promise<ServerEnvelope>((resolve, reject) => {
        const timer = setTimeout(() => { waiters.delete(check); reject(new Error("Expected WebSocket response did not arrive")) }, 3000)
        const check = () => { const found = messages.find(predicate); if (found) { clearTimeout(timer); waiters.delete(check); resolve(found) } }
        waiters.add(check)
        check()
      })
    }
    async function command(command: ClientCommand) {
      const id = `wire-${++sequence}`
      const response = waitFor(event => (event.type === "ack" || event.type === "error") && event.id === id)
      ws.send(JSON.stringify({ v: 1, type: "command", id, command }))
      return response
    }
    async function subscribe(chatId: string) {
      const id = `subscription-${++sequence}`
      const response = waitFor(event => event.type === "snapshot" && event.id === id)
      ws.send(JSON.stringify({ v: 1, type: "subscribe", id, topic: { type: "chat", chatId } }))
      await response
    }
    return { ws, messages, waitFor, command, subscribe }
  }
  let chatId: string | undefined
  try {
    const origin = await connect(), other = await connect()
    const binding = await origin.command({ type: "host.actions.bind", capabilities: [HOST_ACTION_CAPABILITY] })
    const otherBinding = await other.command({ type: "host.actions.bind", capabilities: [HOST_ACTION_CAPABILITY] })
    if (binding.type !== "ack" || otherBinding.type !== "ack") throw new Error("Expected bound test windows")
    const identity = binding.result as { clientId: string; resumeToken: string }
    // A command payload cannot override the authenticated actual sender.
    const sent = await origin.command({ type: "chat.send", projectId: project.id, provider: "pi", model: "test-model", content: "Show README", memoryDisabled: true,
      hostClientId: (otherBinding.result as { clientId: string }).clientId } as ClientCommand)
    if (sent.type !== "ack") throw new Error("New chat send failed")
    chatId = (sent.result as { chatId: string }).chatId
    expect(store.getChat(chatId)).toBeTruthy()
    expect(firstReceipt).toMatchObject({ status: "unavailable", reason: "No eligible originating chat client" })
    expect(origin.messages.some(event => event.type === "host.action.requested")).toBe(false)
    await origin.subscribe(chatId)
    await other.subscribe(chatId)
    expect(await launch.beforeToolCall!(HOST_ACTION_TOOL_NAMES.openFile, toolInput)).toBeUndefined()
    const receipt = JSON.parse((await launch.memoryDispatch!(HOST_ACTION_TOOL_NAMES.openFile, toolInput, undefined, native)).text)
    expect(receipt).toMatchObject({ status: "accepted", delivery: "sent" })
    const request = await origin.waitFor(event => event.type === "host.action.requested")
    if (request.type !== "host.action.requested") throw new Error("Expected host request")
    expect(request.chatId).toBe(chatId)
    expect(request.targetClientId).toBe(identity.clientId)
    const stolen = await other.command({ type: "host.actions.bind", capabilities: [HOST_ACTION_CAPABILITY], resumeToken: identity.resumeToken })
    expect(stolen.type).toBe("error")
    expect((await other.command({ type: "host.action.readSnapshot", operationId: receipt.operationId })).type).toBe("error")
    expect((await origin.command({ type: "host.action.readSnapshot", operationId: receipt.operationId })).type).toBe("ack")
    expect(other.messages.some(event => event.type === "host.action.requested")).toBe(false)
    origin.ws.close()
    await disconnectObserved
    const resumed = await connect()
    const rebound = await resumed.command({ type: "host.actions.bind", capabilities: [HOST_ACTION_CAPABILITY], resumeToken: identity.resumeToken })
    expect(rebound).toMatchObject({ type: "ack", result: { clientId: identity.clientId, resumeToken: identity.resumeToken } })
    expect(resumed.messages.some(event => event.type === "host.action.requested")).toBe(false)
    expect((await resumed.command({ type: "host.action.readSnapshot", operationId: receipt.operationId })).type).toBe("error")
    await resumed.subscribe(chatId)
    const replay = await resumed.waitFor(event => event.type === "host.action.requested")
    expect(replay).toMatchObject({ operationId: receipt.operationId, targetClientId: identity.clientId })
    const snapshot = await resumed.command({ type: "host.action.readSnapshot", operationId: receipt.operationId })
    expect(snapshot).toMatchObject({ type: "ack", result: { content: "# First turn\n" } })
    const ack = await resumed.command({ type: "host.action.presented", operationId: receipt.operationId, viewInstanceId: "first-turn-readonly", fileVersion: request.snapshot.version, digest: request.snapshot.digest })
    expect(ack).toMatchObject({ type: "ack", result: { status: "presented" } })
    const changed = await resumed.command({ type: "chat.setExecutionPolicy", chatId, policy: { engine: "pi", toolGate: "read-only" }, expectedRevision: 1 })
    expect(changed.type).toBe("ack")
    expect(JSON.parse((await launch.memoryDispatch!(HOST_ACTION_TOOL_NAMES.openFile, toolInput, undefined, native)).text).status).toBe("unavailable")
  } finally {
    for (const ws of peers) ws.close()
    await server.stop(true)
    release()
    if (chatId) await agent.cancel(chatId)
    await agent.shutdownRuntime()
    router.dispose()
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)
