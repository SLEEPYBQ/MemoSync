import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventStore } from "./event-store"
import { deriveChatSnapshot, deriveLocalProjectsSnapshot, deriveSidebarData } from "./read-models"
import { handleWorkspaceRequest } from "./workspace-routes"

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "memosync-draft-"))
  directories.push(directory)
  const store = new EventStore(join(directory, "data"))
  await store.initialize()
  return { store, directory }
}

function sidebar(store: EventStore) { return deriveSidebarData(store.state, new Map()) }
function projects(store: EventStore) { return deriveLocalProjectsSnapshot(store.state, [], "Fixture").projects }

test("ensure is idempotent across concurrent projectId and normalized localPath requests", async () => {
  const { store, directory } = await setup()
  const project = await store.openProject(directory)
  const drafts = await Promise.all(Array.from({ length: 12 }, (_, i) => store.ensureDraft(i % 2 ? { projectId: project.id } : { localPath: join(directory, ".") })))
  expect(new Set(drafts.map(draft => draft.chatId)).size).toBe(1)
  expect(drafts.every(draft => draft.projectId === project.id)).toBe(true)
  expect(store.state.chatsById.size).toBe(1)
  expect(store.requireChat(drafts[0]!.chatId)).toMatchObject({ draft: true, provider: null, hasMessages: false, executionPolicyVersion: 1 })
  await expect(store.ensureDraft({ projectId: "missing" })).rejects.toThrow("Project not found")
})

test("a draft is absent from every public list, archived rows, unread rows and Memory Board metadata", async () => {
  const { store, directory } = await setup()
  const project = await store.openProject(directory)
  const draft = await store.ensureDraft({ projectId: project.id })
  await store.setChatReadState(draft.chatId, true)
  await store.archiveChat(draft.chatId)
  expect(store.listChats()).toEqual([])
  expect(store.listChatsByProject(project.id)).toEqual([])
  expect(store.getChatCount(project.id)).toBe(0)
  expect(sidebar(store).projectGroups[0]).toMatchObject({ chats: [], previewChats: [], olderChats: [] })
  expect(sidebar(store).projectGroups[0]?.archivedChats).toBeUndefined()
  expect(projects(store)[0]).toMatchObject({ source: "saved", chatCount: 0 })
  for (const endpoint of ["/api/chats", "/api/projects"]) {
    const req = new Request(`http://localhost${endpoint}`)
    const result = await handleWorkspaceRequest(req, new URL(req.url), store)
    const data = (await result!.json()).data
    expect(data).toEqual(endpoint === "/api/chats" ? [] : [{ id: project.id, title: project.title }])
  }
  // Direct subscriptions still work before the first message.
  expect(deriveChatSnapshot(store.state, new Map(), new Set(), draft.chatId,
    () => ({ messages: [], history: { hasOlder: false, olderCursor: null, recentLimit: 100 } }))).toMatchObject({ runtime: { chatId: draft.chatId, provider: null } })
})

test("unopened paths remain hidden and discovered paths retain their discovery metadata until promotion", async () => {
  const { store, directory } = await setup()
  const [draft, again] = await Promise.all([store.ensureDraft({ localPath: directory }), store.ensureDraft({ localPath: directory })])
  expect(again).toEqual(draft)
  expect(store.listProjects()).toEqual([])
  expect(projects(store)).toEqual([])
  expect(sidebar(store).projectGroups).toEqual([])
  expect(deriveLocalProjectsSnapshot(store.state, [{ localPath: directory, title: "Discovered", modifiedAt: 5 }], "Fixture").projects)
    .toEqual([{ localPath: directory, title: "Discovered", source: "discovered", lastOpenedAt: 5, chatCount: 0 }])
  await store.promoteDraft(draft.chatId)
  expect(store.requireChat(draft.chatId).draft).toBeUndefined()
  expect(store.getProject(draft.projectId)?.draftOnly).toBeUndefined()
  expect(store.listProjects().map(project => project.id)).toEqual([draft.projectId])
  expect(sidebar(store).projectGroups[0]?.chats.map(chat => chat.chatId)).toEqual([draft.chatId])
  expect(projects(store)[0]).toMatchObject({ source: "saved", chatCount: 1 })
})

test("discard removes a disposable project but retains opened projects; repeated or promoted discard is a no-op", async () => {
  const { store, directory } = await setup()
  const draft = await store.ensureDraft({ localPath: directory })
  await store.setSessionToken(draft.chatId, "native-session")
  expect(await store.discardDraft(draft.chatId)).toBe(true)
  expect(store.getChat(draft.chatId)).toBeNull()
  expect(store.getProject(draft.projectId)).toBeNull()
  expect(store.state.projectIdsByPath.has(directory)).toBe(false)
  expect(await store.discardDraft(draft.chatId)).toBe(false)
  const project = await store.openProject(directory)
  const another = await store.ensureDraft({ projectId: project.id })
  await store.discardDraft(another.chatId)
  expect(store.getProject(project.id)).toBe(project)
  const real = await store.ensureDraft({ projectId: project.id })
  await store.promoteDraft(real.chatId)
  expect(await store.discardDraft(real.chatId)).toBe(false)
  expect(store.getChat(real.chatId)).not.toBeNull()
})

test("promotion and discard races serialize and never delete a promoted chat", async () => {
  const { store, directory } = await setup()
  const first = await store.ensureDraft({ localPath: directory })
  const [, discarded] = await Promise.all([store.promoteDraft(first.chatId), store.discardDraft(first.chatId)])
  expect(discarded).toBe(false)
  expect(store.listChats().map(chat => chat.id)).toEqual([first.chatId])
  const second = await store.ensureDraft({ projectId: first.projectId })
  const losingPromotion = Promise.allSettled([store.discardDraft(second.chatId), store.promoteDraft(second.chatId)])
  expect(await losingPromotion).toMatchObject([{ status: "fulfilled", value: true }, { status: "rejected", reason: expect.any(Error) }])
  expect(store.getChat(second.chatId)).toBeNull()
})

test.each([false, true])("startup cleans drafts from logs and snapshots without resurrection (snapshot=%s)", async compact => {
  const { store, directory } = await setup()
  const opened = await store.openProject(join(directory, "opened"))
  const real = await store.createChat(opened.id)
  const savedDraft = await store.ensureDraft({ projectId: opened.id })
  const unopenedDraft = await store.ensureDraft({ localPath: join(directory, "unopened") })
  await store.setSessionToken(savedDraft.chatId, "prepared-session")
  await store.enqueueMessage(savedDraft.chatId, { content: "never sent", attachments: [] })
  // Defensive cleanup also removes any pre-message bookkeeping transcript.
  await store.appendMessage(savedDraft.chatId, { _id: "internal", kind: "assistant_text", text: "bookkeeping", createdAt: Date.now() })
  if (compact) await store.compact()
  for (let i = 0; i < 2; i++) {
    const reloaded = new EventStore(store.dataDir)
    await reloaded.initialize()
    expect(reloaded.state.chatsById.has(savedDraft.chatId)).toBe(false)
    expect(reloaded.state.chatsById.has(unopenedDraft.chatId)).toBe(false)
    expect(reloaded.getProject(unopenedDraft.projectId)).toBeNull()
    expect(reloaded.getProject(opened.id)).not.toBeNull()
    expect(reloaded.listChats().map(chat => chat.id)).toEqual([real.id])
    expect(reloaded.getQueuedMessages(savedDraft.chatId)).toEqual([])
    expect(await Bun.file(join(store.dataDir, "transcripts", `${savedDraft.chatId}.jsonl`)).exists()).toBe(false)
  }
})

test("startup removes a draft-only project left between project and chat creation", async () => {
  const { store, directory } = await setup()
  await writeFile(join(store.dataDir, "projects.jsonl"), `${JSON.stringify({ v: 2, type: "project_opened", timestamp: 1, projectId: "orphan", title: "Orphan", localPath: directory, draftOnly: true })}\n`)
  const reloaded = new EventStore(store.dataDir)
  await reloaded.initialize()
  expect(reloaded.state.projectsById.size).toBe(0)
  expect(reloaded.state.projectIdsByPath.size).toBe(0)
})

test("same-millisecond discard/recreate/promotion replay preserves identity, policies and first-message metadata", async () => {
  const { store, directory } = await setup()
  const clock = spyOn(Date, "now").mockReturnValue(Date.now())
  let promoted!: { chatId: string; projectId: string }
  try {
    const discarded = await store.ensureDraft({ localPath: directory })
    await store.discardDraft(discarded.chatId)
    promoted = await store.ensureDraft({ localPath: directory })
    await store.setExecutionPolicy(promoted.chatId, { engine: "pi", toolGate: "read-only" }, 2)
    await store.setPlanMode(promoted.chatId, true)
    await store.setSessionToken(promoted.chatId, "prepared")
    await store.promoteDraft(promoted.chatId)
    await store.setChatProvider(promoted.chatId, "pi")
    await store.appendMessage(promoted.chatId, { _id: "first", kind: "user_prompt", content: "hello", createdAt: Date.now() })
  } finally { clock.mockRestore() }
  for (const compact of [false, true]) {
    if (compact) await store.compact()
    const reloaded = new EventStore(store.dataDir)
    await reloaded.initialize()
    expect(reloaded.listChats()).toEqual(store.listChats())
    expect(reloaded.listProjects()).toEqual(store.listProjects())
    expect(reloaded.state.projectIdsByPath.get(directory)).toBe(promoted.projectId)
    expect(reloaded.requireChat(promoted.chatId)).toMatchObject({ provider: "pi", planMode: true, sessionToken: "prepared", hasMessages: true,
      executionPolicies: { pi: { policy: { engine: "pi", toolGate: "read-only" }, revision: 2 } } })
    expect(reloaded.getMessages(promoted.chatId)).toEqual(store.getMessages(promoted.chatId))
  }
})

test("explicitly opening a draft-only project survives discard; stale-chat maintenance leaves drafts alone", async () => {
  const { store, directory } = await setup()
  const draft = await store.ensureDraft({ localPath: directory })
  const project = await store.openProject(directory)
  expect(project.id).toBe(draft.projectId)
  expect(project.draftOnly).toBeUndefined()
  expect(await store.pruneStaleEmptyChats({ now: Date.now() + 60 * 60 * 1000 })).toEqual([])
  await store.discardDraft(draft.chatId)
  expect(store.listProjects().map(project => project.id)).toEqual([project.id])
  const reloaded = new EventStore(store.dataDir)
  await reloaded.initialize()
  expect(reloaded.listProjects().map(project => project.id)).toEqual([project.id])
})

test("ordinary creation and forks stay visible and keep their hasMessages metadata on replay", async () => {
  const { store, directory } = await setup()
  const draft = await store.ensureDraft({ localPath: directory })
  const real = await store.createChat(draft.projectId)
  await store.setChatProvider(real.id, "pi")
  await store.setSessionToken(real.id, "session")
  await store.appendMessage(real.id, { _id: "first", kind: "user_prompt", content: "hello", createdAt: Date.now() })
  const fork = await store.forkChat(real.id)
  await store.discardDraft(draft.chatId)
  expect(store.getProject(draft.projectId)?.draftOnly).toBeUndefined()
  const reloaded = new EventStore(store.dataDir)
  await reloaded.initialize()
  expect(reloaded.listChats().map(chat => chat.id).sort()).toEqual([real.id, fork.id].sort())
  expect(reloaded.requireChat(fork.id).hasMessages).toBe(true)
  expect(reloaded.requireChat(fork.id).pendingForkSessionToken).toBe("session")
  const events = (await readFile(join(store.dataDir, "chats.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line))
  expect(events.find(event => event.chatId === fork.id && event.type === "chat_created").draft).toBeUndefined()
})
