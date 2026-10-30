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
