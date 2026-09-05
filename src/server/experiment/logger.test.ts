import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ExperimentLogger, NoopExperimentLogger } from "./logger"

describe("ExperimentLogger", () => {
  test("appends one JSON line per event with ts + condition", () => {
    const dir = mkdtempSync(join(tmpdir(), "exp-log-"))
    const filePath = join(dir, "experiments", "events.jsonl")
    const logger = new ExperimentLogger({ filePath, condition: "memosync", stdout: false })

    logger.event({ type: "memory.cite", sessionId: "s1", citedIds: ["M-01"], countedIds: ["M-01"] })
    logger.event({ type: "memory.decision", action: "accept", id: "M-01", via: "ui" })

    const lines = readFileSync(filePath, "utf8").trim().split("\n")
    expect(lines.length).toBe(2)
    const first = JSON.parse(lines[0]!)
    expect(first.type).toBe("memory.cite")
    expect(first.condition).toBe("memosync")
    expect(typeof first.ts).toBe("string")
    const second = JSON.parse(lines[1]!)
    expect(second.action).toBe("accept")
  })

  test("noop logger swallows events", () => {
    expect(() => NoopExperimentLogger.event({ type: "memory.cite", citedIds: [], countedIds: [] })).not.toThrow()
  })

  test("stamps participant on every event when configured (orchestrated instances)", () => {
    const dir = mkdtempSync(join(tmpdir(), "exp-log-"))
    const filePath = join(dir, "events.jsonl")
    const logger = new ExperimentLogger({ filePath, condition: "auto", participant: "P07", stdout: false })
    logger.event({ type: "memory.cite", sessionId: "s1", citedIds: [], countedIds: [] })
    const record = JSON.parse(readFileSync(filePath, "utf8").trim())
    expect(record.participant).toBe("P07")
  })

  test("stamps internal QA allocation mode on every exported event", () => {
    const dir = mkdtempSync(join(tmpdir(), "exp-log-"))
    const filePath = join(dir, "events.jsonl")
    const logger = new ExperimentLogger({
      filePath,
      condition: "auto",
      participant: "QA-preview",
      allocationMode: "internal_qa",
      stdout: false,
    })

    logger.event({ type: "memory.cite", sessionId: "s1", citedIds: [], countedIds: [] })
    logger.event({ type: "memory.decision", action: "accept", id: "M-01" })

    const records = readFileSync(filePath, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    expect(records.map((record) => record.allocationMode)).toEqual(["internal_qa", "internal_qa"])
  })

  test("omits participant entirely when not configured (solo/dev instances)", () => {
    const dir = mkdtempSync(join(tmpdir(), "exp-log-"))
    const filePath = join(dir, "events.jsonl")
    const logger = new ExperimentLogger({ filePath, stdout: false })
    logger.event({ type: "memory.cite", sessionId: "s1", citedIds: [], countedIds: [] })
    const record = JSON.parse(readFileSync(filePath, "utf8").trim())
    expect("participant" in record).toBe(false)
  })

  test("fails closed before the best-effort JSONL projection when the durable sink rejects", () => {
    const dir = mkdtempSync(join(tmpdir(), "exp-log-"))
    const filePath = join(dir, "events.jsonl")
    const logger = new ExperimentLogger({
      filePath,
      stdout: false,
      durableSink: () => { throw new Error("sqlite unavailable") },
    })

    expect(() => logger.event({
      type: "ui.monitor",
      surface: "board",
      interaction: "scroll",
    })).toThrow("sqlite unavailable")
    expect(existsSync(filePath) ? readFileSync(filePath, "utf8") : "").toBe("")
  })

  test("returns whether the authoritative sink created the durable event", () => {
    const logger = new ExperimentLogger({
      stdout: false,
      durableSink: () => ({ created: false }),
    })

    expect(logger.event({
      type: "study.control_operation",
      operationId: "control:already-attempted",
      phase: "attempted",
      taskId: "038-S1",
      sessionId: "038-S1",
      surface: "board",
      action: "create",
      controlType: "crud",
    })).toEqual({ durableCreated: false })
  })
})
