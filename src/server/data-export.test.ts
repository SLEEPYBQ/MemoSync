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
      "experiments/study.sqlite": "PRIVATE_PARTICIPANT_PROMPT",
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
