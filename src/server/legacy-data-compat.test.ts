import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { processTranscriptMessages } from "../client/lib/parseTranscript"
import { readAppSettingsSnapshot } from "./app-settings"
import { EventStore } from "./event-store"
import { MemoryService } from "./memory"
import { startMemoSyncServer } from "./server"

test("starts with data written by older versions without replaying pending prompts or opening its database", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "memosync-legacy-"))
  let server: Awaited<ReturnType<typeof startMemoSyncServer>> | undefined
  try {
    const workspace = join(dataDir, "workspace")
    await mkdir(workspace)
    const seed = new EventStore(dataDir)
    await seed.initialize()
    const project = await seed.openProject(workspace)
    const chat = await seed.createChat(project.id)
    await seed.appendMessage(chat.id, { _id: "old-prompt", createdAt: 1, kind: "user_prompt", content: "Existing conversation" })
    await seed.compact()
    // Keep the stored event types, settings keys and entry IDs written by older versions.
    await writeFile(join(dataDir, "chats.jsonl"), JSON.stringify({ v: 2, type: "study.task_frozen", timestamp: 2, chatId: chat.id }) + "\n")
    await writeFile(join(dataDir, "settings.json"), JSON.stringify({ theme: "dark", memory: { enabled: false, learn: false }, memoryPreview: { enabled: true, autoProceedWhenEmpty: false }, studyMode: true, participantId: "legacy" }))
    const transcriptPath = join(dataDir, "transcripts", `${chat.id}.jsonl`)
    const oldEntries = [
      { _id: "old-prompt", createdAt: 1, kind: "user_prompt", content: "Existing conversation" },
      { _id: "old-study", createdAt: 2, kind: "study_questionnaire", payload: { status: "pending" } },
      { _id: "old-gate", createdAt: 3, kind: "memory_proposals", proposalsId: "legacy-gate", openingReviewId: "old-opening", pending: false, candidates: [] },
      { _id: "old-gate-result", createdAt: 4, kind: "memory_proposals_decision", proposalsId: "legacy-gate", decision: "reviewed" },
    ]
    await writeFile(transcriptPath, oldEntries.map((entry) => JSON.stringify(entry)).join("\n") + "\n")
    const memory = new MemoryService({ dbPath: join(dataDir, "memory.sqlite"), dataDir: join(dataDir, "memories") })
    const item = memory.store.create({ content: "Keep existing memory", scope: "personal", type: "preference" }, { actor: "user" })
    const legacyKeys = ["opening_prompt_review:v1:old", "board_reviewed:old", "board_backlog_resolution:v1:old", "prompt_capture_result:v1:old"]
    for (const key of legacyKeys) memory.store.setKv(key, { status: "waiting", content: "Never auto-send this legacy prompt" })
    memory.store.setKv("evolution_policy", { mode: "auto" })
    memory.close()
    await mkdir(join(dataDir, "experiments"))
    // Preserve the database filename and log event type written by older versions.
    const legacyDatabase = "Legacy database must remain untouched, even when invalid SQLite"
    await writeFile(join(dataDir, "experiments", "study.sqlite"), legacyDatabase)
    await writeFile(join(dataDir, "experiments", "events.jsonl"), '{"type":"study.unknown","taskId":"old"}\n')
    server = await startMemoSyncServer({ port: 0, dataDir, openBrowser: false, discoverProjects: () => [] })
    expect(server.store.getProject(project.id)?.localPath).toBe(workspace)
    const loaded = server.store.getMessages(chat.id)
    expect(loaded.filter((entry) => entry.kind === "user_prompt")).toHaveLength(1)
    expect(JSON.stringify(loaded)).not.toContain("Never auto-send")
    const rendered = processTranscriptMessages(loaded)
    expect(rendered.find((message) => message.id === "old-study")).toMatchObject({ kind: "unknown", json: JSON.stringify(oldEntries[1], null, 2) })
    expect(rendered.find((message) => message.id === "old-gate")).toMatchObject({ kind: "memory_proposals", openingReviewId: "old-opening", decision: "reviewed", pending: false })
    expect(await readAppSettingsSnapshot(join(dataDir, "settings.json"))).toMatchObject({ theme: "dark", memory: { enabled: false, learn: false }, memoryPreview: { enabled: true, autoProceedWhenEmpty: false } })
    const response = await fetch(`http://127.0.0.1:${server.port}/api/memories`)
    expect((await response.json()).data.some((value: { id: string }) => value.id === item.id)).toBe(true)
    await server.stop(); server = undefined
    expect(await readFile(join(dataDir, "experiments", "study.sqlite"), "utf8")).toBe(legacyDatabase)
    expect(await readFile(join(dataDir, "experiments", "events.jsonl"), "utf8")).toBe('{"type":"study.unknown","taskId":"old"}\n')
    const reopened = new MemoryService({ dbPath: join(dataDir, "memory.sqlite"), dataDir: join(dataDir, "memories") })
    try {
      for (const key of legacyKeys) expect(reopened.store.getKv<{ status: string; content: string }>(key)).toEqual({ status: "waiting", content: "Never auto-send this legacy prompt" })
      expect(reopened.store.getKv<{ mode: string }>("evolution_policy")).toEqual({ mode: "auto" })
      expect(reopened.store.getById(item.id)?.content).toBe("Keep existing memory")
    } finally { reopened.close() }
  } finally {
    await server?.stop()
    await rm(dataDir, { recursive: true, force: true })
  }
})
