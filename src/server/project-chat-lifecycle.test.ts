import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ClientCommand, ServerEnvelope } from "../shared/protocol"
import { AgentCoordinator } from "./agent"
import { EventStore } from "./event-store"
import type { StartPiTurnArgs } from "./pi-agent"
import { createWsRouter } from "./ws-router"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function fixture(beforeConnection?: () => Promise<void>, beforeInterrupt?: () => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "memosync-project-chat-lifecycle-"))
  const store = new EventStore(join(root, "data"))
  await store.initialize()
  const project = await store.openProject(join(root, "workspace"))
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

test("a startup suspended before hide cannot dispatch when it resolves after a fresh reopened send", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let first = true
  const f = await fixture(async () => {
    if (first) { first = false; entered.resolve(); await release.promise }
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
