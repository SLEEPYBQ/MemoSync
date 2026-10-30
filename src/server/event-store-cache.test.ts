import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TranscriptEntry } from "../shared/types"
import { EventStore } from "./event-store"

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function setup(count: number) {
  const dir = await mkdtemp(join(tmpdir(), "memosync-cache-"))
  dirs.push(dir)
  const store = new EventStore(dir)
  await store.initialize()
  const project = await store.openProject("/tmp/cache-project")
  const chats = []
  for (let i = 0; i < count; i++) chats.push(await store.createChat(project.id))
  return { dir, store, chats }
}

function watchLoads(store: EventStore) {
  return spyOn(store as unknown as { loadTranscriptFromDisk(id: string): unknown }, "loadTranscriptFromDisk")
}

function row(id: string, text = id): TranscriptEntry {
  return { _id: id, kind: "assistant_text", text, createdAt: 100 }
}

describe("bounded transcript LRU", () => {
  test("retains eight recent chats, refreshes read recency, and updates a non-current chat on append", async () => {
    const { store, chats } = await setup(9)
    const loads = watchLoads(store)
    try {
      for (const chat of chats.slice(0, 8)) store.getMessages(chat.id)
      store.getMessages(chats[0]!.id)
      expect(loads).toHaveBeenCalledTimes(8)
      store.getMessages(chats[8]!.id)
      expect(loads).toHaveBeenCalledTimes(9)
      await store.appendMessage(chats[0]!.id, row("appended"))
      expect(store.getMessages(chats[0]!.id)).toEqual([row("appended")])
      expect(loads).toHaveBeenCalledTimes(9)
      store.getMessages(chats[1]!.id) // Least recently read chat was evicted.
      expect(loads).toHaveBeenCalledTimes(10)
    } finally { loads.mockRestore() }
  })

  test("pages clone only their selected rows and never call the full-transcript copy API", async () => {
    const { store, chats } = await setup(1)
    const chat = chats[0]!
    for (let i = 0; i < 10; i++) await store.appendMessage(chat.id, row(String(i)))
    const fullCopy = spyOn(store, "getMessages").mockImplementation(() => { throw new Error("full copy during pagination") })
    try {
      const recent = store.getRecentMessagesPage(chat.id, 3)
      expect(recent.messages.map(r => r._id)).toEqual(["7", "8", "9"])
      expect(recent.olderCursor).toBe("idx:7")
      recent.messages[0]!._id = "caller mutation"
      const older = store.getMessagesPageBefore(chat.id, recent.olderCursor!, 2)
      expect(older.messages.map(r => r._id)).toEqual(["5", "6"])
      expect(store.getRecentMessagesPage(chat.id, 3).messages[0]!._id).toBe("7")
      expect(fullCopy).not.toHaveBeenCalled()
    } finally { fullCopy.mockRestore() }
  })

  test("prune peeks at cold transcripts without inserting them or refreshing hot cache recency", async () => {
    const { dir, store, chats } = await setup(11)
    for (const chat of chats.slice(0, 8)) await store.appendMessage(chat.id, row(chat.id))
    for (const chat of chats.slice(0, 8)) store.getMessages(chat.id)
    await writeFile(join(dir, "transcripts", `${chats[8]!.id}.jsonl`), `${JSON.stringify(row("legacy"))}\n`)
    const loads = watchLoads(store)
    try {
      const pruned = await store.pruneStaleEmptyChats({ now: Date.now() + 60 * 60 * 1000 })
      expect(pruned).toEqual(chats.slice(9).map(c => c.id))
      expect(store.getChat(chats[8]!.id)?.hasMessages).toBe(true)
      loads.mockClear()
      for (const chat of chats.slice(0, 8)) expect(store.getMessages(chat.id)).toHaveLength(1)
      expect(loads).not.toHaveBeenCalled()
      store.getMessages(chats[8]!.id)
      expect(loads).toHaveBeenCalledTimes(1) // The maintenance read was never cached.
    } finally { loads.mockRestore() }
  })

  test("does not evict hot chats to cache a transcript above the byte budget", async () => {
    const { dir, store, chats } = await setup(2)
    store.getMessages(chats[0]!.id)
    await writeFile(join(dir, "transcripts", `${chats[1]!.id}.jsonl`), `${JSON.stringify(row("large", "x".repeat(17 * 1024 * 1024)))}\n`)
    const loads = watchLoads(store)
    try {
      expect(store.getRecentMessagesPage(chats[1]!.id, 1).messages).toHaveLength(1)
      store.getMessages(chats[0]!.id)
      expect(loads).toHaveBeenCalledTimes(1)
      store.getRecentMessagesPage(chats[1]!.id, 1)
      expect(loads).toHaveBeenCalledTimes(2) // Oversized chats are read but not retained.
    } finally { loads.mockRestore() }
  })

  test("evicts an appending chat when its cached transcript grows beyond the entry budget", async () => {
    const { dir, store, chats } = await setup(2)
    const entries = Array.from({ length: 20_000 }, (_, i) => row(String(i)))
    await writeFile(join(dir, "transcripts", `${chats[0]!.id}.jsonl`), entries.map(e => JSON.stringify(e)).join("\n") + "\n")
    store.getRecentMessagesPage(chats[0]!.id, 1)
    store.getMessages(chats[1]!.id)
    const loads = watchLoads(store)
    try {
      store.getRecentMessagesPage(chats[0]!.id, 1)
      expect(loads).not.toHaveBeenCalled()
      await store.appendMessage(chats[0]!.id, row("overflow"))
      store.getMessages(chats[1]!.id)
      expect(loads).not.toHaveBeenCalled()
      expect(store.getRecentMessagesPage(chats[0]!.id, 1).messages[0]!._id).toBe("overflow")
      expect(loads).toHaveBeenCalledTimes(1)
    } finally { loads.mockRestore() }
  })

  test("bounds aggregate bytes as well as the number of cached chats", async () => {
    const { store, chats } = await setup(6)
    for (const chat of chats) await store.appendMessage(chat.id, row(chat.id, "x".repeat(3 * 1024 * 1024)))
    for (const chat of chats.slice(0, 5)) store.getRecentMessagesPage(chat.id, 1)
    const loads = watchLoads(store)
    try {
      store.getRecentMessagesPage(chats[0]!.id, 1)
      expect(loads).not.toHaveBeenCalled()
      store.getRecentMessagesPage(chats[5]!.id, 1)
      store.getRecentMessagesPage(chats[0]!.id, 1)
      expect(loads).toHaveBeenCalledTimes(1)
      store.getRecentMessagesPage(chats[1]!.id, 1)
      expect(loads).toHaveBeenCalledTimes(2)
    } finally { loads.mockRestore() }
  })
})
