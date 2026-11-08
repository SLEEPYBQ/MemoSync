import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const tempDirs: string[] = []
const script = path.resolve(import.meta.dir, "../../scripts/export-data.ts")

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("data export privacy", () => {
  test.each([false, true])("exports raw historical data only with explicit --full (full=%s)", async (full) => {
    const root = await mkdtemp(path.join(tmpdir(), "memosync-export-privacy-"))
    tempDirs.push(root)
    const dataDir = path.join(root, "data")
    const outDir = path.join(root, "out")
    const entries: Record<string, string> = {
      "install-id": "synthetic-install",
      "memory.sqlite": "MEMORY_LIBRARY",
      "experiments/events.jsonl": '{"event":"memory.opened"}\n',
      // Preserve the database path written by older versions.
      "experiments/study.sqlite": "PRIVATE_USER_PROMPT",
      "experiments/workspace-snapshots/source/private.ts": "PRIVATE_WORKSPACE_CODE",
      "experiments/unrecognized-future-file.json": "PRIVATE_FUTURE_DATA",
      "transcripts/chat.jsonl": "PRIVATE_TRANSCRIPT",
    }
    for (const [name, contents] of Object.entries(entries)) {
      const target = path.join(dataDir, name)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, contents)
    }
    const result = Bun.spawnSync([process.execPath, script, "--out", outDir, ...(full ? ["--full"] : [])], {
      env: { PATH: process.env.PATH, HOME: root, DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(result.exitCode).toBe(0)
    const archives = await readdir(outDir)
    expect(archives).toHaveLength(1)
    const archivePath = path.join(outDir, archives[0]!)
    const listing = Bun.spawnSync(["tar", "-tzf", archivePath], { stdout: "pipe", stderr: "pipe" })
    expect(listing.exitCode).toBe(0)
    const names = listing.stdout.toString().trim().split("\n")
    expect(names).toContain("memory.sqlite")
    expect(names).toContain("experiments/events.jsonl")
    for (const name of Object.keys(entries).filter((name) => entries[name]!.startsWith("PRIVATE_"))) {
      expect(names.includes(name)).toBe(full)
    }
    const contents = Bun.spawnSync(["tar", "-xzOf", archivePath], { stdout: "pipe", stderr: "pipe" })
    expect(contents.exitCode).toBe(0)
    expect(contents.stdout.toString()).toContain("MEMORY_LIBRARY")
    expect(contents.stdout.toString().includes("PRIVATE_")).toBe(full)
  })
})

test("exports reusable topics, classifications and their history in the memory database", async () => {
  const { openMemoryDb } = await import('./memory/db')
  const { MemoryStore } = await import('./memory/MemoryStore')
  const root = await mkdtemp(path.join(tmpdir(), 'memosync-topic-export-'))
  tempDirs.push(root)
  const dataDir = path.join(root, 'data')
  const outDir = path.join(root, 'out')
  const db = openMemoryDb(path.join(dataDir, 'memory.sqlite'))
  const store = new MemoryStore(db)
  const actor = { actor: 'user' as const }
  const item = store.create({ content: 'Synthetic export rule', scope: 'personal', type: 'fact' }, actor)
  const topic = store.createTopic('Synthetic topic')
  store.createTopic('Synthetic empty topic')
  store.assignTopic(item.id, topic.id, actor)
  const expectedTopics = store.listTopics()
  const expectedItem = store.getById(item.id)
  const expectedHistory = store.getEvents(item.id)
  db.close()
  const result = Bun.spawnSync([process.execPath, script, '--out', outDir], {
    env: { PATH: process.env.PATH, HOME: root, DATA_DIR: dataDir }, stdout: 'pipe', stderr: 'pipe',
  })
  expect(result.exitCode).toBe(0)
  const [archive] = await readdir(outDir)
  const restoredDir = path.join(root, 'restored')
  await mkdir(restoredDir)
  const extraction = Bun.spawnSync(['tar', '-xzf', path.join(outDir, archive!), '-C', restoredDir], { stdout: 'pipe', stderr: 'pipe' })
  expect(extraction.exitCode).toBe(0)
  const restoredDb = openMemoryDb(path.join(restoredDir, 'memory.sqlite'))
  try {
    const restored = new MemoryStore(restoredDb)
    expect(restored.listTopics()).toEqual(expectedTopics)
    expect(restored.getById(item.id)).toEqual(expectedItem)
    expect(restored.getEvents(item.id)).toEqual(expectedHistory)
  } finally { restoredDb.close() }
})
