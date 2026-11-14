import { expect, test } from "bun:test"
import { auditRecord } from "./auditRecord"
import type { MemoryEvent } from "./memoriesApi"

test("audit record folds and withdraws per-turn corrections, counting the visible tail", () => {
  const event = (seq: number, kind: MemoryEvent["kind"], turn: number, meta: Record<string, unknown>): MemoryEvent =>
    ({ seq, kind, turn, meta, memoryId: "M-01", sessionId: "s", actor: "user", ts: "" })
  const events = [
    event(1, "trace", 1, { label: "violated" }),
    event(2, "trace_correction", 1, { label: "operational", auditLabel: "violated", note: "done" }),
    event(3, "trace", 2, { label: "operational" }),
    event(4, "trace_correction", 2, { label: "violated", auditLabel: "operational" }),
    event(5, "trace_correction", 2, { withdrawn: true }),
  ]
  expect(auditRecord(events)).toMatchObject({ total: 2, corrected: 1, verdicts: [{ effectiveLabel: "operational", corrected: true, note: "done" }, { effectiveLabel: "operational", corrected: false }] })
  expect(auditRecord(events, 1)).toMatchObject({ total: 1, corrected: 0 })
  expect(auditRecord(events, 0).total).toBe(0)
})
