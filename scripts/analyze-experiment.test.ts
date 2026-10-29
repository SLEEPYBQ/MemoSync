import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function runAnalyzer(args: string[]) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "run", resolve(import.meta.dir, "analyze-experiment.ts"), ...args],
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

describe("local usage analyzer CLI", () => {
  test("reports product usage and writes CSV", () => {
    const dir = mkdtempSync(join(tmpdir(), "analyze-usage-"))
    tempDirs.push(dir)
    const eventsPath = join(dir, "events.jsonl")
    const csvPath = join(dir, "usage.csv")
    writeFileSync(eventsPath, JSON.stringify({ type: "memory.inject", sessionId: "chat-1", memories: [{ id: "M-01" }] }) + "\nnot json\n")
    const result = runAnalyzer([eventsPath, "--csv", csvPath])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("sessions: 1")
    expect(result.stdout).toContain("skipped lines: 1")
    const csv = readFileSync(csvPath, "utf8")
    expect(csv).toContain("sessionId,legacyMetadata,engine")
    expect(csv).toContain("chat-1,")
    expect(csv.trim().split("\n")).toHaveLength(2)
  })
})
