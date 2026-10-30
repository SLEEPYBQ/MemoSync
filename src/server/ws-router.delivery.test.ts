import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { EventStore } from "./event-store"
import { createWsRouter } from "./ws-router"
import { applySidebarPatch } from "../shared/sidebar-patch"
import { deriveSidebarData } from "./read-models"
import type { ChatActivityStatus, SidebarData, TranscriptEntry } from "../shared/types"

test("streaming retains sidebar derivation while memory waiting and recency invalidate it; dropped patches recover", async () => {
  const dir = await mkdtemp("/tmp/memosync-delivery-")
  const store = new EventStore(dir)
  await store.initialize()
  const project = await store.openProject(dir)
  const chat = await store.createChat(project.id)
  await store.appendMessage(chat.id, { _id: "prompt", kind: "user_prompt", content: "hello", createdAt: Date.now() } as TranscriptEntry)
  let status: ChatActivityStatus = "running"
  let stream = "a"
  let orderReads = 0
  const getOrder = store.getSidebarProjectOrder.bind(store)
  store.getSidebarProjectOrder = () => { orderReads++; return getOrder() }
  const agent = { getActiveStatuses: () => new Map([[chat.id, status]]), getDrainingChatIds: () => new Set<string>(), getStreamingAssistantTexts: () => new Map([[chat.id, stream]]) }
  const router = createWsRouter({ store, agent: agent as never, terminals: { onEvent: () => () => {} } as never, keybindings: { onChange: () => () => {} } as never, refreshDiscovery: async () => [], getDiscoveredProjects: () => [], machineDisplayName: "test", updateManager: null })
  let sidebar: SidebarData | null = null
  let drop = false
  const received: any[] = []
  const ws = { data: { subscriptions: new Map(), snapshotSignatures: new Map() }, send(raw: string) { if (drop) return 0; const message = JSON.parse(raw); received.push(message); if (message.snapshot?.type === "sidebar-patch") sidebar = applySidebarPatch(sidebar, message.snapshot.data); return raw.length } }
  router.handleOpen(ws as never)
  try {
    await router.handleMessage(ws as never, JSON.stringify({ v: 1, type: "subscribe", id: "sidebar", topic: { type: "sidebar", patches: true } }))
    const baseline = orderReads
    const version = store.getSidebarVersion()
    for (let i = 0; i < 3; i++) {
      stream += " delta"
      await store.appendMessage(chat.id, { _id: `assistant-${i}`, kind: "assistant_text", text: stream, createdAt: Date.now() } as TranscriptEntry)
      await router.broadcastChatStateImmediately(chat.id)
    }
    expect(store.getSidebarVersion()).toBe(version)
    expect(orderReads).toBe(baseline)
    status = "waiting_for_user"
    await router.broadcastChatStateImmediately(chat.id)
    expect(sidebar as SidebarData | null).toEqual(deriveSidebarData(store.state, agent.getActiveStatuses()))
    expect(sidebar!.projectGroups[0]!.chats[0]!.status).toBe("waiting_for_user")
    expect(received.at(-1).snapshot.data.from).not.toBeNull()
    drop = true
    await store.setMemoryDisabled(chat.id, true)
    await router.broadcastChatStateImmediately(chat.id)
    await store.renameChat(chat.id, "changed during backpressure")
    drop = false
    await router.broadcastChatStateImmediately(chat.id)
    expect(sidebar as SidebarData | null).toEqual(deriveSidebarData(store.state, agent.getActiveStatuses()))
    expect(sidebar!.projectGroups[0]!.chats[0]!.memoryDisabled).toBe(true)
    expect(received.at(-1).snapshot.data.from).toBeNull()
  } finally { router.dispose(); await rm(dir, { recursive: true, force: true }) }
})

test("one chat derivation and serialization per recentLimit preserves complete memory records for three subscribers", async () => {
  const dir = await mkdtemp("/tmp/memosync-shared-")
  const store = new EventStore(dir)
  await store.initialize()
  const project = await store.openProject(dir)
  const chat = await store.createChat(project.id)
  const memoryEntries: TranscriptEntry[] = [
    { _id: "preview", kind: "memory_preview", createdAt: 1, previewId: "preview", relevancePending: true, memories: [] },
    { _id: "candidates", kind: "memory_candidates", createdAt: 1, candidates: [{ id: "M-01" }] },
    { _id: "transfer", kind: "memory_transfer", createdAt: 1, transferId: "transfer", pending: true, suggestions: [] },
    { _id: "checkup", kind: "memory_checkup", createdAt: 1, checkupId: "checkup", pending: true },
  ]
  for (const entry of memoryEntries) await store.appendMessage(chat.id, entry)
  for (let i = 0; i < 4; i++) await store.appendMessage(chat.id, { _id: `text-${i}`, kind: "assistant_text", text: "content", createdAt: i + 2 })
  let stream = "a", reads = 0, serializations = 0, terminalReads = 0, diffVersion = 0
  const getRecent = store.getRecentChatHistory.bind(store)
  store.getRecentChatHistory = (id, limit) => { reads++; return getRecent(id, limit) }
  const router = createWsRouter({ store, agent: { getActiveStatuses: () => new Map(), getDrainingChatIds: () => new Set(), getStreamingAssistantTexts: () => new Map([[chat.id, stream]]) } as never, terminals: { onEvent: () => () => {}, getSnapshot: () => { terminalReads++; return { version: terminalReads } } } as never, keybindings: { onChange: () => () => {} } as never, refreshDiscovery: async () => [], getDiscoveredProjects: () => [], machineDisplayName: "test", updateManager: null, diffStore: { getProjectSnapshot: () => ({ version: diffVersion }), refreshSnapshot: async () => { diffVersion++; return true } } as never })
  const sockets = [1, 1, 2].map(limit => ({ limit, sent: [] as any[], data: { subscriptions: new Map(), snapshotSignatures: new Map() }, send(raw: string) { this.sent.push(JSON.parse(raw)); return raw.length } }))
  const stringify = JSON.stringify
  try {
    for (const [i, ws] of sockets.entries()) {
      router.handleOpen(ws as never)
      for (const [id, topic] of Object.entries({ chat: { type: "chat", chatId: chat.id, recentLimit: ws.limit }, git: { type: "project-git", projectId: project.id }, terminal: { type: "terminal", terminalId: "terminal" } })) {
        await router.handleMessage(ws as never, JSON.stringify({ v: 1, type: "subscribe", id: `${id}-${i}`, topic }))
      }
    }
    reads = 0
    JSON.stringify = ((value: any, ...args: any[]) => { if (value?.type === "chat" && "data" in value) serializations++; return (stringify as any)(value, ...args) }) as typeof JSON.stringify
    stream = "changed"
    await router.broadcastChatStateImmediately(chat.id)
    expect(reads).toBe(2)
    expect(serializations).toBe(2)
    for (const [i, ws] of sockets.entries()) {
      const data = ws.sent.filter(message => message.id === `chat-${i}`).at(-1)!.snapshot.data
      expect(data.messages.length).toBe(ws.limit)
      expect(data.history.recentLimit).toBe(ws.limit)
      expect(data.history.hasOlder).toBe(true)
      expect(data.memoryRecordMessages).toEqual(memoryEntries)
    }
    // A Git refresh must not inspect/rebroadcast unrelated chat or terminal state.
    const terminalBaseline = terminalReads, readsBaseline = reads
    await router.handleMessage(sockets[0] as never, JSON.stringify({ v: 1, type: "command", id: "git-command", command: { type: "chat.refreshDiffs", chatId: chat.id } }))
    expect(terminalReads).toBe(terminalBaseline)
    expect(reads).toBe(readsBaseline)
    const pending = router.broadcastSnapshots()
    router.dispose()
    await pending
    expect(reads).toBe(readsBaseline)
    expect(sockets[0]!.data.subscriptions.size).toBe(0)
  } finally { JSON.stringify = stringify; router.dispose(); await rm(dir, { recursive: true, force: true }) }
})
