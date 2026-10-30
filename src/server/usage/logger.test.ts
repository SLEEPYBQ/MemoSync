import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { UsageLogger, NoopUsageLogger } from "./logger"

test("local usage events append in order with install identity and no legacy metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-log-"))
  try {
    const filePath = join(dir, "experiments", "events.jsonl")
    const logger = new UsageLogger({ filePath, installId: "install-1", stdout: false })
    logger.event({ type: "memory.cite", sessionId: "chat-1", citedIds: ["M-01"], countedIds: ["M-01"] })
    logger.event({ type: "memory.decision", action: "accept", id: "M-01", via: "board" })
    const records = readFileSync(filePath, "utf8").trim().split("\n").map(line => JSON.parse(line))
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({ type: "memory.cite", sessionId: "chat-1", installId: "install-1", citedIds: ["M-01"] })
    expect(Number.isFinite(Date.parse(records[0].ts))).toBe(true)
    expect(records[1].action).toBe("accept")
    // These stored metadata keys from older versions must not appear in new events.
    for (const key of ["participant", "allocationMode", "condition", "taskId"]) expect(records[0]).not.toHaveProperty(key)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("both product opt-out and legacy opt-out disable local output", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-disabled-"))
  const before = { product: process.env.MEMOSYNC_USAGE_LOG, legacy: process.env.EXPERIMENT_LOG }
  try {
    for (const key of ["MEMOSYNC_USAGE_LOG", "EXPERIMENT_LOG"]) {
      delete process.env.MEMOSYNC_USAGE_LOG
      delete process.env.EXPERIMENT_LOG
      process.env[key] = "0"
      const filePath = join(dir, key)
      new UsageLogger({ filePath, stdout: false }).event({ type: "memory.cite", citedIds: [], countedIds: [] })
      expect(existsSync(filePath)).toBe(false)
    }
  } finally {
    if (before.product === undefined) delete process.env.MEMOSYNC_USAGE_LOG
    else process.env.MEMOSYNC_USAGE_LOG = before.product
    if (before.legacy === undefined) delete process.env.EXPERIMENT_LOG
    else process.env.EXPERIMENT_LOG = before.legacy
    rmSync(dir, { recursive: true, force: true })
  }
})

test("unwritable output and noop logging cannot break memory actions", () => {
  const logger = new UsageLogger({ filePath: "/dev/null/events.jsonl", stdout: false })
  expect(() => logger.event({ type: "memory.cite", citedIds: [], countedIds: [] })).not.toThrow()
  expect(() => NoopUsageLogger.event({ type: "memory.cite", citedIds: [], countedIds: [] })).not.toThrow()
})
