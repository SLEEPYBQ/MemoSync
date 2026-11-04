import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ServerWebSocket } from "bun"
import type { ClientCommand, ServerEnvelope } from "../shared/protocol"
import { HOST_ACTION_CAPABILITY, HOST_ACTION_TOOL_NAMES } from "../shared/host-actions"
import { AgentCoordinator } from "./agent"
import { EventStore } from "./event-store"
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
  const service = new HostActionService({ dataDir: store.dataDir })
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
    store, hostActions: service, onStateChange: () => {}, piManager: piManager as never,
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
