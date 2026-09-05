import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
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

describe("analyze-experiment CLI", () => {
  test("requires an explicit flag before internal QA events enter a report", () => {
    const dir = mkdtempSync(join(tmpdir(), "analyze-qa-"))
    tempDirs.push(dir)
    const eventsPath = join(dir, "events.jsonl")
    writeFileSync(eventsPath, `${JSON.stringify({
      ts: "2026-08-18T00:00:00.000Z",
      allocationMode: "internal_qa",
      condition: "auto",
      participant: "QA-01",
      type: "memory.inject",
      sessionId: "qa-session",
      memories: [],
    })}\n`)

    const formal = runAnalyzer([eventsPath])
    expect(formal.exitCode).toBe(0)
    expect(formal.stdout).toContain("sessions: 0")
    expect(formal.stdout).toContain("excluded internal QA events: 1")

    const optedIn = runAnalyzer([eventsPath, "--include-internal-qa"])
    expect(optedIn.exitCode).toBe(0)
    expect(optedIn.stdout).toContain("sessions: 1")
    expect(optedIn.stdout).toContain("excluded internal QA events: 0")
    expect(optedIn.stdout).toContain("internal_qa")
  })
})
