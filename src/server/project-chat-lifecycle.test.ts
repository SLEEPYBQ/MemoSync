import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ClientCommand, ServerEnvelope } from "../shared/protocol"
import { AgentCoordinator } from "./agent"
import { EventStore } from "./event-store"
import { MemoryService } from "./memory"
import { getModelAccessService, ModelAccessService, setModelAccessService } from "./model-access/service"
import { testKeyring } from "./model-access/test-fixtures"
import { OpencodeAgentManager } from "./opencode-agent"
import { startOpencodeServer } from "./opencode-server"
import type { StartPiTurnArgs } from "./pi-agent"
import { createWsRouter } from "./ws-router"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

type AgentOptions = Partial<ConstructorParameters<typeof AgentCoordinator>[0]>
async function fixture(beforeConnection?: () => Promise<void>, beforeInterrupt?: () => Promise<void>,
  options?: (root: string) => AgentOptions | Promise<AgentOptions>) {
  const root = await mkdtemp(join(tmpdir(), "memosync-project-chat-lifecycle-"))
  const store = new EventStore(join(root, "data"))
  await store.initialize()
  const project = await store.openProject(join(root, "workspace"))
  await mkdir(project.localPath)
  const chat = await store.createChat(project.id)
  const prompts: string[] = [], interrupted: string[] = [], closed: string[] = []
  const agent = new AgentCoordinator({
    store, onStateChange() {}, getMemorySettings: () => ({ enabled: false, learn: false }),
    generateTitle: async () => ({ title: null, usedFallback: true, failureMessage: null }),
    resolvePiConnection: async () => { await beforeConnection?.(); return null },
    piManager: {
      async startTurn({ chatId, content }: StartPiTurnArgs) {
        prompts.push(content)
        const stop = Promise.withResolvers<void>()
        return { provider: "pi", stream: { async *[Symbol.asyncIterator]() { await stop.promise } },
          interrupt: async () => { interrupted.push(chatId); await beforeInterrupt?.(); stop.resolve() }, close: () => stop.resolve() }
      },
      closeChat(chatId: string) { closed.push(chatId) }, dispose() {},
    } as never,
    ...await options?.(root),
  })
  const router = createWsRouter({
    store, agent, terminals: { onEvent: () => () => {} } as never,
    keybindings: { onChange: () => () => {} } as never, machineDisplayName: "fixture",
    refreshDiscovery: async () => [], getDiscoveredProjects: () => [], updateManager: null,
  })
  const replies: ServerEnvelope[] = []
  const ws = { data: { subscriptions: new Map(), snapshotSignatures: new Map() },
    send(raw: string) { replies.push(JSON.parse(raw)); return raw.length } }
  router.handleOpen(ws as never)
  const command = async (value: ClientCommand) => {
    const id = crypto.randomUUID()
    await router.handleMessage(ws as never, JSON.stringify({ v: 1, type: "command", id, command: value }))
    const reply = replies.find(entry => "id" in entry && entry.id === id)
    if (reply?.type !== "ack") throw new Error(reply?.type === "error" ? reply.message : "Missing acknowledgement")
    return reply.result
  }
  cleanups.push(async () => {
    router.dispose()
    for (const id of agent.activeTurns.keys()) await agent.cancel(id)
    await agent.shutdownRuntime()
    await rm(root, { recursive: true, force: true })
  })
  return { store, agent, chat, project, prompts, interrupted, closed, command,
    send: (chatId: string, content: string) => command({ type: "chat.send", chatId, provider: "pi", content }),
    hide: () => command({ type: "project.remove", projectId: project.id }),
    open: () => command({ type: "project.open", localPath: project.localPath }),
  }
}

test("a fresh send in a reopened project reaches the provider on the original chat", async () => {
  const f = await fixture()
  const deleted = await f.store.createChat(f.project.id)
  await f.command({ type: "chat.delete", chatId: deleted.id })
  const draft = await f.store.ensureDraft({ projectId: f.project.id })
  await f.send(f.chat.id, "before hide")
  expect(f.prompts).toEqual(["before hide"])
  await f.store.setSessionToken(f.chat.id, "fixture-session")

  await f.hide()
  expect(f.store.getProject(f.project.id)).toBeNull()
  const history = f.store.getMessages(f.chat.id)
  expect(history.map(entry => entry.kind)).toEqual(["user_prompt", "interrupted"])
  await expect(f.send(f.chat.id, "while hidden")).rejects.toThrow("Project not found")
  expect(await f.open()).toEqual({ projectId: f.project.id })
  expect(await f.send(f.chat.id, "after reopen")).toEqual({ chatId: f.chat.id })
  // A successful socket ACK (and even a durable prompt) is not a provider turn.
  expect(f.prompts).toEqual(["before hide", "after reopen"])
  const reloaded = new EventStore(f.store.dataDir)
  await reloaded.initialize()
  expect(reloaded.requireChat(f.chat.id).sessionToken).toBe("fixture-session")
  expect(reloaded.getMessages(f.chat.id)).toEqual([...history, expect.objectContaining({ kind: "user_prompt", content: "after reopen" })])
  for (const id of [deleted.id, draft.chatId]) await expect(f.send(id, "not restored")).rejects.toThrow("Chat not found")
})

test.each([false, true])("Hide durably dismisses the published memory preview (response planning: %s)", async planning => {
  const published = Promise.withResolvers<string>(), startedPlanning = Promise.withResolvers<void>(), finishPlanning = Promise.withResolvers<void>()
  const f = await fixture(undefined, undefined, root => {
    const memory = new MemoryService({ dbPath: ":memory:", dataDir: join(root, "memory") })
    cleanups.push(async () => memory.close())
    memory.store.create({ content: "Use fixture formatting", type: "fact", scope: "personal" }, { actor: "user" })
    return {
      memory, memoryPreview: true, getMemorySettings: () => ({ enabled: true, learn: false }),
      getMemoryPreviewSettings: () => ({ enabled: true, autoProceedWhenEmpty: false, confirmationMode: "every_turn" }),
      memoryUsePlan: { async plan() { startedPlanning.resolve(); await finishPlanning.promise; return [] } },
      onStateChange(chatId) {
        const preview = chatId && f.agent.pendingPreviews.get(chatId)
        if (preview && preview.published) published.resolve(preview.previewId)
      },
    }
  })
  await f.send(f.chat.id, "Review synthetic formatting")
  const previewId = await published.promise
  await f.send(f.chat.id, "Stay in the queue")
  const response = planning ? f.command({ type: "chat.respondMemoryPreview", chatId: f.chat.id, previewId, decision: "go_on" })
    .then(() => null, (error: Error) => error.message) : undefined
  if (planning) await startedPlanning.promise

  const writing = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const cancel = f.store.recordTurnCancelled.bind(f.store)
  f.store.recordTurnCancelled = async id => { writing.resolve(); await release.promise; await cancel(id) }
  let acked = false
  const hiding = f.hide().then(() => { acked = true })
  try {
    await Promise.race([writing.promise, hiding])
    expect(acked).toBe(false)
    await expect(f.send(f.chat.id, "During Hide")).rejects.toThrow("Project not found")
    expect(f.prompts).toEqual([])
    release.resolve()
    await hiding
    await f.open()
    finishPlanning.resolve()
    if (response) expect(await response).toContain("cancelled")
    const reloaded = new EventStore(f.store.dataDir)
    await reloaded.initialize()
    expect(reloaded.requireChat(f.chat.id).lastTurnOutcome).toBe("cancelled")
    expect(reloaded.getMessages(f.chat.id).filter(entry => entry.kind === "memory_preview_decision"))
      .toEqual([expect.objectContaining({ previewId, decision: "dismiss" })])
    expect(reloaded.getQueuedMessages(f.chat.id).map(row => row.content)).toEqual(["Stay in the queue"])
    expect(f.agent.pendingPreviews.has(f.chat.id)).toBe(false)
    expect(f.prompts).toEqual([])
  } finally {
    release.resolve(); finishPlanning.resolve()
    await Promise.allSettled([hiding, response])
  }
})

test("Hide waits for the exact OpenCode launch to retire before a reopened send reaches native prompt_async", async () => {
  const started = Promise.withResolvers<void>(), stopping = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const received = Promise.withResolvers<unknown>()
  const observer = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const event = await request.json() as { path?: string; body?: unknown }
    if (event.path?.endsWith("/prompt_async")) received.resolve(event.body)
    return Response.json(true)
  } })
  const prior = getModelAccessService()
  let retired = false, first = true
  const f = await fixture(undefined, undefined, async root => {
    const executable = join(import.meta.dir, "fixtures/opencode-agent-lifecycle-fixture.ts")
    const access = await new ModelAccessService({ keyring: testKeyring, dataDir: join(root, "access"),
      env: { HOME: root, PATH: process.env.PATH }, readLegacyPi: async () => null,
      resolveExecutable: async () => ({ state: "ready", path: executable, version: "1.19.5" }),
    }).initialize()
    const connection = await access.saveConnection({ name: "Fixture", endpoints: [{ protocol: "openai-chat", baseUrl: "http://127.0.0.1:1" }], models: [{ id: "fixture-model" }] })
    await access.setEngine("opencode", { access: { mode: "connection", connectionId: connection.id } })
    setModelAccessService(access)
    return { opencodeManager: new OpencodeAgentManager(async args => {
      const server = await startOpencodeServer({ ...args, env: { ...args.env, FAKE_OC_OBSERVER: observer.url.origin } })
      if (!first) return server
      first = false
      started.resolve()
      // This native launch owns a process but hasn't handed it to the manager.
      // Hold the abort cleanup independently of OS-specific termination timing.
      await new Promise<void>(resolve => args.signal!.addEventListener("abort", () => resolve(), { once: true }))
      stopping.resolve()
      await release.promise
      await server.close()
      retired = true
      throw new Error("Synthetic launch cancelled")
    }) }
  })
  const send = (content: string) => f.command({ type: "chat.send", chatId: f.chat.id, content, provider: "opencode", model: "fixture-model" })
  const starting = send("Cancelled before dispatch")
  try {
    await Promise.race([started.promise, starting.then(() => { throw new Error("Native launch was not reached") })])
    const hiding = f.hide().then(() => expect(retired).toBe(true))
    try {
      await stopping.promise
      const neighbor = await f.store.openProject(join(f.project.localPath, "neighbor"))
      const other = await f.store.createChat(neighbor.id)
      await f.send(other.id, "Neighbor remains available")
      expect(f.prompts).toEqual(["Neighbor remains available"])
    } finally { release.resolve(); await hiding }
    await f.open()
    await send("Fresh after reopening")
    expect(await received.promise).toMatchObject({ parts: [{ text: "Fresh after reopening" }] })
    expect(f.store.getMessages(f.chat.id).some(entry => entry.kind === "result" && entry.isError)).toBe(false)
  } finally {
    release.resolve(); await starting
    setModelAccessService(prior); observer.stop(true)
  }
}, 10_000)

test("hiding interrupts and closes an archived turn, not a neighboring project's turn", async () => {
  const f = await fixture()
  const neighbor = await f.store.openProject(join(f.project.localPath, "neighbor"))
  const other = await f.store.createChat(neighbor.id)
  await f.send(other.id, "neighbor")
  await f.send(f.chat.id, "archive while running")
  await f.command({ type: "chat.archive", chatId: f.chat.id })
  expect(f.agent.activeTurns.has(f.chat.id)).toBe(true)

  await f.hide()
  expect(f.interrupted).toEqual([f.chat.id])
  expect(f.closed).toEqual([f.chat.id])
  expect([...f.agent.activeTurns.keys()]).toEqual([other.id])
  await f.open()
  expect(f.store.getChat(f.chat.id)?.archivedAt).toBeNumber()
  await f.command({ type: "chat.unarchive", chatId: f.chat.id })
  await f.send(f.chat.id, "after unarchive")
  expect(f.prompts).toEqual(["neighbor", "archive while running", "after unarchive"])
})

test.each([false, true])("a startup suspended before hide cannot disturb a fresh reopened send (late failure: %s)", async fail => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let first = true
  const f = await fixture(async () => {
    if (first) {
      first = false; entered.resolve(); await release.promise
      if (fail) throw new Error("Cancelled synthetic connection failed late")
    }
  })
  const starting = f.send(f.chat.id, "stale send")
  try {
    await entered.promise
    await f.hide()
    // Creating a project at the same path also reopens the original project.
    expect(await f.command({ type: "project.create", localPath: f.project.localPath, title: "Restored" }))
      .toEqual({ projectId: f.project.id })
    await f.send(f.chat.id, "fresh send")
  } finally {
    release.resolve()
    await starting
  }
  expect(f.prompts).toEqual(["fresh send"])
  expect(f.agent.activeTurns.get(f.chat.id)?.userText).toBe("fresh send")
  expect(f.store.requireChat(f.chat.id).executionPolicyStates?.pi?.status).not.toBe("rejected")
})

test("a slow interrupt in one chat cannot leave another admitted prompt without an outcome", async () => {
  const connecting = Promise.withResolvers<void>(), releaseConnection = Promise.withResolvers<void>()
  const stopping = Promise.withResolvers<void>(), releaseStop = Promise.withResolvers<void>()
  let pauseConnection = false
  const f = await fixture(async () => {
    if (pauseConnection) { connecting.resolve(); await releaseConnection.promise }
  }, async () => { stopping.resolve(); await releaseStop.promise })
  await f.send(f.chat.id, "running")
  const second = await f.store.createChat(f.project.id)
  pauseConnection = true
  const starting = f.send(second.id, "starting")
  await connecting.promise
  const hiding = f.hide()
  try {
    await stopping.promise
    await expect(f.send(f.chat.id, "during hide")).rejects.toThrow("Project not found")
    releaseConnection.resolve()
    await starting
  } finally {
    releaseConnection.resolve()
    releaseStop.resolve()
    await hiding
  }
  expect(f.prompts).toEqual(["running"])
  expect(f.store.getMessages(second.id).map(entry => entry.kind)).toEqual(["user_prompt", "interrupted"])
})

test.each([false, true])("an old steer cannot enter or block the reopened project (fresh send: %s)", async fresh => {
  const stopping = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const f = await fixture(undefined, async () => { stopping.resolve(); await release.promise })
  await f.send(f.chat.id, "original")
  await f.send(f.chat.id, "queued")
  const [row] = f.store.getQueuedMessages(f.chat.id)
  const steering = f.command({ type: "message.steer", chatId: f.chat.id, queuedMessageId: row!.id })
  try {
    await stopping.promise
    await f.hide()
    await f.open()
    if (fresh) {
      await f.command({ type: "message.dequeue", chatId: f.chat.id, queuedMessageId: row!.id })
      await f.send(f.chat.id, "replacement")
      expect(f.prompts).toEqual(["original", "replacement"])
    }
  } finally { release.resolve(); await steering }
  expect(f.prompts).toEqual(fresh ? ["original", "replacement"] : ["original"])
  expect(f.store.getQueuedMessages(f.chat.id)).toEqual(fresh ? [] : [row])
})

test.each([false, true])("an old queue scan cannot enter or block the reopened project (fresh send: %s)", async fresh => {
  const f = await fixture()
  await f.store.enqueueMessage(f.chat.id, { content: "/compact", attachments: [] })
  const row = await f.store.enqueueMessage(f.chat.id, { content: "later", provider: "pi", attachments: [] })
  const scanned = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const reject = f.store.rejectQueuedNativeCommand.bind(f.store)
  f.store.rejectQueuedNativeCommand = async (...args) => { await reject(...args); scanned.resolve(); await release.promise }
  const scan = f.agent.drainOrphanedQueues()
  try {
    await scanned.promise
    await f.hide()
    await f.open()
    if (fresh) {
      await f.command({ type: "message.dequeue", chatId: f.chat.id, queuedMessageId: row.id })
      await f.send(f.chat.id, "replacement")
      expect(f.prompts).toEqual(["replacement"])
    }
  } finally { release.resolve(); await scan }
  expect(f.prompts).toEqual(fresh ? ["replacement"] : [])
  expect(f.store.getQueuedMessage(f.chat.id, row.id)).toEqual(fresh ? null : row)
})
