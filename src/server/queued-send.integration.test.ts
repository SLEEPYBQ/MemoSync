import { afterEach, expect, test } from "bun:test"
import type { ServerWebSocket } from "bun"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HOST_ACTION_CAPABILITY, HOST_ACTION_TOOL_NAMES, type HostActionClientBinding } from "../shared/host-actions"
import type { ClientCommand, ServerEnvelope } from "../shared/protocol"
import { AgentCoordinator } from "./agent"
import { EventStore } from "./event-store"
import { HarnessPolicyService } from "./harness-policy"
import { HostActionService } from "./host-actions"
import type { StartPiTurnArgs } from "./pi-agent"
import { createWsRouter, type ClientState } from "./ws-router"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function workspace() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "memosync-queue-windows-")))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, "workspace"))
  await writeFile(join(root, "workspace", "README.md"), "# Synthetic queued request\n")
  return root
}

async function runtime(root: string) {
  const store = new EventStore(join(root, "data"))
  await store.initialize()
  const project = await store.openProject(join(root, "workspace"))
  const chat = store.listChatsByProject(project.id)[0] ?? await store.createChat(project.id)
  const chatId = chat.id
  const harnessPolicies = new HarnessPolicyService()
  const hostActions = new HostActionService({ dataDir: store.dataDir, policy: harnessPolicies })
  const receipts: unknown[] = []
  const active = Promise.withResolvers<void>()
  const agent = new AgentCoordinator({ store, harnessPolicies, hostActions,
    getMemorySettings: () => ({ enabled: false, learn: false }),
    generateTitle: async () => ({ title: null, usedFallback: true, failureMessage: null }),
    resolvePiConnection: async () => null,
    piManager: {
      async startTurn(args: StartPiTurnArgs) {
        if (args.content !== "hold") {
          const reply = await args.memoryDispatch!(HOST_ACTION_TOOL_NAMES.openFile, { path: "README.md" }, undefined, {
            engineInstanceId: "test-pi", nativeSessionId: "test-session", nativeToolCallId: crypto.randomUUID(),
          })
          receipts.push(JSON.parse(reply.text))
        }
        const stop = Promise.withResolvers<void>()
        return { provider: "pi", stream: (async function* () { await stop.promise })(),
          interrupt: async () => stop.resolve(), close: () => stop.resolve() }
      },
      closeChat() {}, dispose() {},
    } as never,
    onStateChange() { if (receipts.length && agent.activeTurns.has(chatId)) active.resolve() },
  })
  const router = createWsRouter({ store, agent, hostActions, machineDisplayName: "Fixture", updateManager: null,
    terminals: { onEvent: () => () => {} } as never, keybindings: { onChange: () => () => {} } as never,
    getDiscoveredProjects: () => [], refreshDiscovery: async () => [],
  })
  let stopped = false
  const close = async () => {
    if (stopped) return
    stopped = true
    await agent.cancel(chatId)
    await agent.shutdownRuntime()
    router.dispose()
    await hostActions.close()
  }
  cleanups.push(close)
  async function window() {
    const sent: ServerEnvelope[] = []
    const ws = { data: { subscriptions: new Map(), snapshotSignatures: new Map() },
      send(raw: string) { sent.push(JSON.parse(raw)); return raw.length } } as unknown as ServerWebSocket<ClientState>
    router.handleOpen(ws)
    await router.handleMessage(ws, JSON.stringify({ v: 1, type: "subscribe", id: "chat", topic: { type: "chat", chatId } }))
    const command = async <T = unknown>(value: ClientCommand) => {
      const id = crypto.randomUUID()
      await router.handleMessage(ws, JSON.stringify({ v: 1, type: "command", id, command: value }))
      const ack = sent.find(event => (event.type === "ack" || event.type === "error") && event.id === id)
      if (ack?.type !== "ack") throw new Error(ack?.type === "error" ? ack.message : "No ACK")
      return ack.result as T
    }
    return { sent, command,
      bind: (resumeToken?: string) => command<HostActionClientBinding>({ type: "host.actions.bind", capabilities: [HOST_ACTION_CAPABILITY], resumeToken }),
      submit: (type: "chat.send" | "message.enqueue", content: string, extra?: Record<string, unknown>) =>
        command<{ queuedMessageId: string; queued?: true }>({ type, chatId, provider: "pi", content, ...extra }),
      requests: () => sent.flatMap(event => event.type === "host.action.requested" ? [event] : []),
      snapshots: () => sent.flatMap(event => event.type === "snapshot" && event.snapshot.type === "chat" && event.snapshot.data ? [event.snapshot.data] : []),
    }
  }
  return { agent, store, chatId, window, close, receipts, active: active.promise }
}

test("after Stop, a fresh send and a Send now from another window keep each row's original desktop", async () => {
  const r = await runtime(await workspace()), a = await r.window(), b = await r.window()
  const alice = await a.bind(), bob = await b.bind()
  await b.submit("chat.send", "hold")
  const first = await a.submit("message.enqueue", "First file", { hostClientId: bob.clientId })
  await b.command({ type: "chat.cancel", chatId: r.chatId })
  const second = await b.submit("chat.send", "Second file", { hostClientId: alice.clientId })
  expect(second.queued).toBe(true)
  await r.active
  await a.command({ type: "message.steer", chatId: r.chatId, queuedMessageId: second.queuedMessageId })
  expect(a.requests().map(e => [e.turnId, e.targetClientId])).toEqual([[first.queuedMessageId, alice.clientId]])
  expect(b.requests().map(e => [e.turnId, e.targetClientId])).toEqual([[second.queuedMessageId, bob.clientId]])
  expect(r.receipts).toEqual(Array(2).fill(expect.objectContaining({ status: "accepted", delivery: "sent" })))
  expect(r.store.getQueuedMessages(r.chatId)).toEqual([])
})

for (const compact of [false, true]) test(`queue origin survives ${compact ? "snapshot" : "event log"} replay; a missing or disconnected origin stays unavailable`, async () => {
  const root = await workspace(), old = await runtime(root)
  const a = await old.window(), b = await old.window(), unbound = await old.window()
  const alice = await a.bind(), bob = await b.bind()
  await a.submit("chat.send", "hold")
  const fromA = await a.submit("chat.send", "Resume same window")
  const fromB = await b.submit("message.enqueue", "Disconnected window")
  const anonymous = await unbound.submit("chat.send", "No binding", { hostClientId: alice.clientId })
  await old.close()
  if (compact) await old.store.compact()

  const r = await runtime(root), resumed = await r.window(), replacement = await r.window()
  expect(r.chatId).toBe(old.chatId)
  expect((await resumed.bind(alice.resumeToken)).clientId).toBe(alice.clientId)
  expect((await replacement.bind()).clientId).not.toBe(bob.clientId)
  expect(r.store.getQueuedMessages(r.chatId).map(row => row.hostClientId)).toEqual([alice.clientId, bob.clientId, undefined])
  for (const row of replacement.snapshots().at(-1)!.queuedMessages) expect(row).not.toHaveProperty("hostClientId")
  await r.agent.drainOrphanedQueues()
  // The replacement can steer the rows but it cannot adopt either one.
  for (const row of [fromB, anonymous]) await replacement.command({ type: "message.steer", chatId: r.chatId, queuedMessageId: row.queuedMessageId })
  expect(resumed.requests().map(e => e.turnId)).toEqual([fromA.queuedMessageId])
  expect(replacement.requests()).toEqual([])
  const unavailable = expect.objectContaining({ status: "unavailable", reason: "No eligible originating chat client" })
  expect(r.receipts).toEqual([expect.objectContaining({ status: "accepted", delivery: "sent" }), unavailable, unavailable])
  expect(r.store.getQueuedMessages(r.chatId)).toEqual([])
})

test("queued chat.send and cross-window dequeue ACK after persistence and publish the authoritative queue to both subscribers", async () => {
  const r = await runtime(await workspace()), a = await r.window(), b = await r.window()
  await b.submit("chat.send", "hold")
  await b.submit("message.enqueue", "Earlier row")
  await b.command({ type: "chat.cancel", chatId: r.chatId })
  a.sent.length = b.sent.length = 0
  const row = await a.submit("chat.send", "Remove this")
  expect(row.queued).toBe(true)
  expect(a.sent[0]).toMatchObject({ type: "ack", result: row })
  for (const peer of [a, b]) expect(peer.snapshots().at(-1)?.queuedMessages.map(q => q.id)).toContain(row.queuedMessageId)
  const removing = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const remove = r.store.removeQueuedMessage.bind(r.store)
  r.store.removeQueuedMessage = async (chatId, id) => {
    if (id === row.queuedMessageId) { removing.resolve(); await release.promise }
    await remove(chatId, id)
  }
  a.sent.length = b.sent.length = 0
  const dequeued = b.command({ type: "message.dequeue", chatId: r.chatId, queuedMessageId: row.queuedMessageId })
  try {
    await removing.promise
    expect(b.sent.some(event => event.type === "ack")).toBe(false)
  } finally { release.resolve(); await dequeued }
  expect(b.sent[0]?.type).toBe("ack")
  for (const peer of [a, b]) {
    const snapshot = peer.snapshots().at(-1)!
    expect(snapshot.queuedMessages.map(q => q.id)).not.toContain(row.queuedMessageId)
    expect(snapshot.messages.some(m => m.kind === "user_prompt" && m.content === "Remove this")).toBe(false)
  }
  await r.active
})
