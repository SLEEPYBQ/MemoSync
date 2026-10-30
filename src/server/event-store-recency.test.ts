import { afterEach, describe, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TranscriptEntry } from "../shared/types"
import { EventStore } from "./event-store"

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})
async function setup() {
  const dir = await fs.mkdtemp(join(tmpdir(), "memosync-recency-"))
  dirs.push(dir)
  const store = new EventStore(dir)
  await store.initialize()
  const project = await store.openProject("/tmp/recency-project")
  const chat = await store.createChat(project.id)
  return { dir, store, project, chat }
}
function prompt(at: number): TranscriptEntry {
  return { _id: `prompt-${at}`, createdAt: at, kind: "user_prompt", content: "hello" }
}
function output(at: number, size = 4): TranscriptEntry {
  return { _id: `output-${at}`, createdAt: at, kind: "assistant_text", text: "x".repeat(size) }
}
async function stamps(dir: string) {
  return (await fs.readFile(join(dir, "chats.jsonl"), "utf8")).split("\n")
    .filter(Boolean).map(line => JSON.parse(line)).filter(event => event.type === "chat_last_message_at_set")
}
async function reload(dir: string) {
  const store = new EventStore(dir)
  await store.initialize()
  return store
}

describe("durable chat recency", () => {
  test("logs one stamp per advancing prompt, including zero, rather than per transcript entry", async () => {
    const { dir, store, chat } = await setup()
    await store.appendMessage(chat.id, prompt(0))
    await Promise.all([store.appendMessage(chat.id, prompt(1000)), store.appendMessage(chat.id, prompt(1000))])
    await store.appendMessage(chat.id, output(2000))
    await store.appendMessage(chat.id, prompt(500))
    expect((await stamps(dir)).map(e => e.at)).toEqual([0, 1000])
    expect(store.getChat(chat.id)?.lastMessageAt).toBe(1000)
    expect((await reload(dir)).getChat(chat.id)?.lastMessageAt).toBe(1000)
  })

  test("recovers the exact persisted prompt time behind an oversized transcript tail", async () => {
    const { dir, store, chat } = await setup()
    await store.appendMessage(chat.id, prompt(1000))
    await store.appendMessage(chat.id, output(2000, 300 * 1024))
    await store.appendMessage(chat.id, output(3000))
    const recovered = await reload(dir)
    expect(recovered.getChat(chat.id)?.lastMessageAt).toBe(1000)
    expect(recovered.getChat(chat.id)?.hasMessages).toBe(true)
    expect(recovered.getMessages(chat.id)).toHaveLength(3)
  })

  test("recovers an exact buried prompt from old transcripts without stamps", async () => {
    const { dir, chat } = await setup()
    await fs.writeFile(join(dir, "transcripts", `${chat.id}.jsonl`),
      [prompt(1000), output(2000, 300 * 1024), output(3000)].map(e => JSON.stringify(e)).join("\n") + "\n")
    const recovered = await reload(dir)
    expect(recovered.getChat(chat.id)?.lastMessageAt).toBe(1000)
    expect(recovered.getChat(chat.id)?.hasMessages).toBe(true)
    expect(await stamps(dir)).toEqual([]) // Loading never writes fabricated stamp events.
  })

  test("refreshes stale legacy snapshot recency when a newer unstamped prompt is buried", async () => {
    const { dir, store, chat } = await setup()
    await store.appendMessage(chat.id, prompt(1000))
    await store.compact()
    // Simulate an old build appending after the last snapshot, without stamp events.
    await fs.writeFile(join(dir, "transcripts", `${chat.id}.jsonl`),
      [prompt(1000), prompt(4000), output(5000, 300 * 1024), output(6000)].map(e => JSON.stringify(e)).join("\n") + "\n")
    expect((await reload(dir)).getChat(chat.id)?.lastMessageAt).toBe(4000)
  })

  test("uses a visible tail prompt ahead of newer output and dates output-only legacy chats", async () => {
    const { dir, store, project, chat } = await setup()
    const outputOnly = await store.createChat(project.id)
    const empty = await store.createChat(project.id)
    await fs.writeFile(join(dir, "transcripts", `${chat.id}.jsonl`), [prompt(1000), output(2000)].map(e => JSON.stringify(e)).join("\n") + "\n")
    await fs.writeFile(join(dir, "transcripts", `${outputOnly.id}.jsonl`), JSON.stringify(output(3000, 300 * 1024)) + "\n")
    const recovered = await reload(dir)
    expect(recovered.getChat(chat.id)?.lastMessageAt).toBe(1000)
    expect(recovered.getChat(outputOnly.id)?.lastMessageAt).toBe(3000)
    expect(recovered.getChat(empty.id)?.lastMessageAt).toBeUndefined()
    expect(recovered.getChat(empty.id)?.hasMessages).toBe(false)
  })

  test("restores metadata from legacy snapshot messages before transcript migration", async () => {
    const { dir, store, chat } = await setup()
    await store.compact()
    const snapshotPath = join(dir, "snapshot.json")
    const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8"))
    snapshot.messages = [{ chatId: chat.id, entries: [prompt(500), output(700)] }]
    await fs.writeFile(snapshotPath, JSON.stringify(snapshot))
    const recovered = await reload(dir)
    expect(recovered.getChat(chat.id)?.lastMessageAt).toBe(500)
    await recovered.migrateLegacyTranscripts()
    expect((await reload(dir)).getChat(chat.id)?.lastMessageAt).toBe(500)
  })

  test("never moves snapshot recency backwards on an older append or transcript hydration", async () => {
    const { dir, store, chat } = await setup()
    await store.appendMessage(chat.id, prompt(4000))
    await store.compact()
    await store.appendMessage(chat.id, prompt(500))
    expect(store.getChat(chat.id)?.lastMessageAt).toBe(4000)
    expect((await reload(dir)).getChat(chat.id)?.lastMessageAt).toBe(4000)
  })

  test("forks inherit prompt recency and sidebar order across restart and compaction", async () => {
    const { dir, store, project, chat } = await setup()
    await store.setChatProvider(chat.id, "claude")
    await store.setSessionToken(chat.id, "session-1")
    await store.setMemoryDisabled(chat.id, true)
    await store.appendMessage(chat.id, prompt(1000))
    await store.appendMessage(chat.id, output(2000))
    const other = await store.createChat(project.id)
    await store.appendMessage(other.id, prompt(1500))
    const fork = await store.forkChat(chat.id)
    expect(fork.lastMessageAt).toBe(1000)
    expect(store.listChatsByProject(project.id)[0]?.id).toBe(other.id)
    const recovered = await reload(dir)
    expect(recovered.getChat(fork.id)?.lastMessageAt).toBe(1000)
    expect(recovered.listChatsByProject(project.id)[0]?.id).toBe(other.id)
    expect(recovered.getChat(fork.id)?.memoryDisabled).toBe(true)
    await recovered.compact()
    expect((await reload(dir)).getChat(fork.id)?.lastMessageAt).toBe(1000)
  })

  test.each([
    { name: "zero prompt time", entries: [prompt(0), output(1000)], at: 0 },
    { name: "out-of-order prompts", entries: [prompt(2000), prompt(1000), output(3000)], at: 2000 },
    { name: "output-only legacy chat", entries: [output(2000), output(1000)], at: 2000 },
    { name: "empty chat", entries: [], at: undefined },
  ])("fork recency handles $name consistently with startup recovery", async ({ entries, at }) => {
    const { dir, store, chat } = await setup()
    await store.setChatProvider(chat.id, "claude")
    await store.setSessionToken(chat.id, "session-1")
    for (const entry of entries) await store.appendMessage(chat.id, entry)
    const fork = await store.forkChat(chat.id)
    expect(fork.lastMessageAt).toBe(at)
    expect((await reload(dir)).getChat(fork.id)?.lastMessageAt).toBe(at)
  })

  test("conditional append stamps only accepted prompts using the serialized caller payload", async () => {
    const { dir, store, chat } = await setup()
    let accepted = true
    const rejected = store.appendMessage(chat.id, prompt(9999), { shouldAppend: () => accepted })
    accepted = false
    expect(await rejected).toBe(false)
    expect(await stamps(dir)).toEqual([])
    expect(store.getChat(chat.id)?.hasMessages).toBe(false)
    const message = prompt(1000)
    const admitted = store.appendMessage(chat.id, message)
    message.createdAt = 8888
    expect(await admitted).toBe(true)
    expect((await stamps(dir)).map(e => e.at)).toEqual([1000])
    expect(store.getChat(chat.id)?.lastMessageAt).toBe(1000)
  })

  test("failed transcript writes create no ghost stamps and do not block a later prompt", async () => {
    const { dir, store, chat } = await setup()
    const append = fs.appendFile
    const failure = spyOn(fs, "appendFile").mockImplementation(async (...args) => {
      if (String(args[0]).includes("/transcripts/")) throw new Error("transcript unavailable")
      return append(...args)
    })
    try { await expect(store.appendMessage(chat.id, prompt(9000))).rejects.toThrow("transcript unavailable") }
    finally { failure.mockRestore() }
    expect(await stamps(dir)).toEqual([])
    expect(store.getChat(chat.id)?.lastMessageAt).toBeUndefined()
    await store.appendMessage(chat.id, prompt(1000))
    expect((await stamps(dir)).map(e => e.at)).toEqual([1000])
  })

  test("a failed stamp preserves the already durable transcript in cache and restart recovery", async () => {
    const { dir, store, chat } = await setup()
    store.getMessages(chat.id)
    const append = fs.appendFile
    const failure = spyOn(fs, "appendFile").mockImplementation(async (...args) => {
      if (String(args[0]).endsWith("/chats.jsonl")) throw new Error("stamp unavailable")
      return append(...args)
    })
    // The transcript row is durable, so the append itself succeeds.
    try { await store.appendMessage(chat.id, prompt(1000)) }
    finally { failure.mockRestore() }
    expect(store.getMessages(chat.id)).toEqual([prompt(1000)])
    expect((await reload(dir)).getChat(chat.id)?.lastMessageAt).toBe(1000)
    await store.appendMessage(chat.id, prompt(2000))
    expect((await stamps(dir)).map(e => e.at)).toEqual([2000])
  })

  test.each([
    { name: "output-only tail", olderTailPrompt: false },
    { name: "older prompt in the tail", olderTailPrompt: true },
  ])("recovers a buried prompt after a failed stamp despite an older durable stamp: $name", async ({ olderTailPrompt }) => {
    const { dir, store, project, chat } = await setup()
    const other = await store.createChat(project.id)
    await store.appendMessage(other.id, prompt(1500))
    await store.appendMessage(chat.id, prompt(1000))
    const append = fs.appendFile
    const failure = spyOn(fs, "appendFile").mockImplementation(async (...args) => {
      if (String(args[0]).endsWith("/chats.jsonl")) throw new Error("stamp unavailable")
      return append(...args)
    })
    // The prompt row is durable, so the append succeeds and the stamp is retried.
    try { await store.appendMessage(chat.id, prompt(2000)) }
    finally { failure.mockRestore() }
    expect((await stamps(dir)).filter(e => e.chatId === chat.id).map(e => e.at)).toEqual([1000])
    await store.appendMessage(chat.id, output(3000, 300 * 1024))
    await store.appendMessage(chat.id, output(4000))
    if (olderTailPrompt) await store.appendMessage(chat.id, prompt(500))
    // The next write retried the stamp before the prompt could be buried.
    expect((await stamps(dir)).filter(e => e.chatId === chat.id).map(e => e.at)).toEqual([1000, 2000])
    const recovered = await reload(dir)
    expect(recovered.getChat(chat.id)?.lastMessageAt).toBe(2000)
    expect(recovered.listChatsByProject(project.id)[0]?.id).toBe(chat.id)
    await recovered.compact()
    expect((await reload(dir)).getChat(chat.id)?.lastMessageAt).toBe(2000)
  })

  test("reads during an in-flight stamp never duplicate the durable transcript row", async () => {
    const { dir, store, chat } = await setup()
    const append = fs.appendFile
    let release!: () => void
    let started!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const stamping = new Promise<void>(resolve => { started = resolve })
    const delayed = spyOn(fs, "appendFile").mockImplementation(async (...args) => {
      if (String(args[0]).endsWith("/chats.jsonl")) {
        started()
        await barrier
      }
      return append(...args)
    })
    const pending = store.appendMessage(chat.id, prompt(1000))
    try {
      expect(await Promise.race([stamping.then(() => "stamping"), pending.then(() => "finished")])).toBe("stamping")
      expect(store.getMessages(chat.id)).toEqual([prompt(1000)])
      release()
      await pending
      expect(store.getMessages(chat.id)).toEqual([prompt(1000)])
      expect((await stamps(dir)).map(e => e.at)).toEqual([1000])
    } finally {
      release()
      await pending
      delayed.mockRestore()
    }
  })

  test("validates and replays recency stamps without regressing on tied or older stamps", async () => {
    const { dir, chat } = await setup()
    const stamp = { v: 2, type: "chat_last_message_at_set", chatId: chat.id, timestamp: chat.createdAt, at: 2000 }
    await fs.appendFile(join(dir, "chats.jsonl"), [stamp, { ...stamp, at: 500 }, { ...stamp, at: "invalid" }].map(e => JSON.stringify(e)).join("\n") + "\n")
    const recovered = await reload(dir)
    expect(recovered.getChat(chat.id)?.lastMessageAt).toBe(2000)
    expect(recovered.getChat(chat.id)?.hasMessages).toBe(true)
  })
})
