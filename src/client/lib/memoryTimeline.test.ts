import { describe, it, expect } from "bun:test"
import { buildMemoryRecord, memoryRecordMonitorIds, turnPulse } from "./memoryTimeline"
import type { HydratedTranscriptMessage } from "../../shared/types"

const base = { timestamp: "2026-08-10T00:00:00.000Z" }

function preview(
  turn: number,
  memories: Array<{ id: string; content: string; scope: string }>,
  decision?: "go_on" | "dismiss" | "without_memory" | "expired",
  decisionSelectedIds?: string[],
): HydratedTranscriptMessage {
  return {
    ...base,
    id: `p-${turn}`,
    kind: "memory_preview",
    previewId: `pv-${turn}`,
    memories,
    turn,
    decision,
    decisionSelectedIds,
  } as HydratedTranscriptMessage
}

function proposals(
  turn: number,
  contents: string[],
  decision?: "reviewed" | "skipped" | "cancelled" | "expired" | "empty",
  pending?: boolean,
): HydratedTranscriptMessage {
  return {
    ...base,
    id: `pr-${turn}`,
    kind: "memory_proposals",
    proposalsId: `props-${turn}`,
    candidates: contents.map((content, i) => ({ id: `C-${turn}-${i}`, content })),
    turn,
    decision,
    pending,
  } as HydratedTranscriptMessage
}

function transfer(
  turn: number,
  items: Array<{ sourceId: string; sourceLabel: string; content?: string; sourceContent: string }>,
  decision?: "handled" | "skipped" | "cancelled" | "expired" | "empty",
): HydratedTranscriptMessage {
  return {
    ...base,
    id: `tr-${turn}`,
    kind: "memory_transfer",
    transferId: `xfer-${turn}`,
    suggestions: items,
    turn,
    decision,
  } as HydratedTranscriptMessage
}

function checkup(
  turn: number,
  suggestions: Array<{ kind: string; memoryId: string; otherMemoryId?: string; reason: string }>,
  decision?: "handled" | "skipped" | "cancelled" | "expired" | "empty" | "failed",
  failedKinds?: Array<"conflict" | "redundancy" | "staleness">,
): HydratedTranscriptMessage {
  return {
    ...base,
    id: `ck-${turn}`,
    kind: "memory_checkup",
    checkupId: `check-${turn}`,
    suggestions,
    turn,
    decision,
    failedKinds,
  } as HydratedTranscriptMessage
}

function text(id: string, body: string): HydratedTranscriptMessage {
  return { ...base, id, kind: "assistant_text", text: body } as HydratedTranscriptMessage
}

function trace(
  turn: number,
  labels: Array<{ id: string; label: string; note?: string; quote?: string }>,
  summary?: string,
): HydratedTranscriptMessage {
  return { ...base, id: `t-${turn}`, kind: "memory_trace", labels, summary, turn } as HydratedTranscriptMessage
}

describe("buildMemoryRecord", () => {
  it("mirrors each transcript station into its stage, in turn order", () => {
    const record = buildMemoryRecord([
      proposals(1, ["Always deploy previews"], "reviewed"),
      transfer(1, [{ sourceId: "M-9", sourceLabel: "flip-demo", sourceContent: "src", content: "localized" }], "handled"),
      checkup(1, [{ kind: "redundancy", memoryId: "M-43", otherMemoryId: "M-49", reason: "same rule" }], "skipped"),
      preview(1, [
        { id: "M-26", content: "concise replies", scope: "personal" },
        { id: "M-42", content: "no emoji", scope: "personal" },
      ], "go_on"),
      text("a-1", "Done, kept it short per [M-26]. [M-26] again."),
      trace(1, [
        { id: "M-26", label: "operational", quote: "kept it short" },
        { id: "M-42", label: "violated", note: "emoji used", quote: "feat: 🎉" },
      ], "Shipped the script; the commit message went against [M-42]."),
    ])

    expect(record.turns.map((t) => t.turn)).toEqual([1])
    const t1 = record.turns[0]!
    expect(t1.summary).toContain("went against")
    expect(t1.candidates).toMatchObject({ decision: "reviewed" })
    expect(t1.candidates!.items).toEqual([{ id: "C-1-0", content: "Always deploy previews", scope: undefined }])
    expect(t1.transfers!.items).toEqual([{ sourceId: "M-9", sourceLabel: "flip-demo", content: "localized" }])
    expect(t1.checkup!.items[0]).toMatchObject({ kind: "redundancy", memoryId: "M-43", otherMemoryId: "M-49" })
    expect(t1.injected!.items.map((m) => m.id)).toEqual(["M-26", "M-42"])
    expect([...t1.reported!.counts.entries()]).toEqual([["M-26", 2]])
    expect(t1.audit!.labels.map((l) => l.label)).toEqual(["operational", "violated"])
    expect(memoryRecordMonitorIds(record)).toEqual(["M-26", "M-42"])
    expect(turnPulse(t1)).toBe("violated")
  })

  it("an edited gate narrows the injected set; dismissed and expired gates leave no injected stage", () => {
    const record = buildMemoryRecord([
      preview(3, [
        { id: "M-01", content: "a", scope: "personal" },
        { id: "M-02", content: "b", scope: "personal" },
      ], "go_on", ["M-02"]),
      preview(4, [{ id: "M-03", content: "c", scope: "personal" }], "dismiss"),
      preview(5, [{ id: "M-07", content: "x", scope: "personal" }], "expired"),
    ])

    const t3 = record.turns.find((t) => t.turn === 3)!
    expect(t3.injected!.items.map((m) => m.id)).toEqual(["M-02"])
    const t4 = record.turns.find((t) => t.turn === 4)!
    expect(t4.decision).toBe("dismiss")
    expect(t4.injected).toBeUndefined()
    const t5 = record.turns.find((t) => t.turn === 5)!
    expect(t5.decision).toBe("expired")
    expect(t5.injected).toBeUndefined()
  })

  it("attributes assistant citations to the latest turn seen and falls back to shaped/quiet pulses", () => {
    const record = buildMemoryRecord([
      preview(1, [{ id: "M-01", content: "a", scope: "personal" }], "go_on"),
      text("a-1", "Following [M-01]."),
      trace(1, [{ id: "M-01", label: "operational" }]),
      preview(2, [{ id: "M-01", content: "a", scope: "personal" }], "go_on"),
      text("a-2", "No citations here."),
      trace(2, [{ id: "M-01", label: "injected_without_effect" }]),
    ])

    expect([...record.turns[0]!.reported!.counts.keys()]).toEqual(["M-01"])
    expect(record.turns[1]!.reported).toBeUndefined()
    expect(turnPulse(record.turns[0]!)).toBe("shaped")
    expect(turnPulse(record.turns[1]!)).toBe("quiet")
  })

  it("adds in-flight citations to the current turn in first-seen order without changing settled history", () => {
    const messages = [
      preview(1, [
        { id: "M-01", content: "a", scope: "project" },
        { id: "M-02", content: "b", scope: "project" },
      ], "go_on"),
    ]

    const running = buildMemoryRecord(messages, "Using [M-02], then [M-01], then [M-02] again.")
    expect([...running.turns[0]!.reported!.counts.entries()]).toEqual([
      ["M-02", 2],
      ["M-01", 1],
    ])

    const settled = buildMemoryRecord([
      ...messages,
      text("a-1", "Using [M-02], then [M-01], then [M-02] again."),
    ], null)
    expect([...settled.turns[0]!.reported!.counts.entries()]).toEqual([
      ["M-02", 2],
      ["M-01", 1],
    ])
  })

  it("empty stations keep their stage row data (zero items) so the rail can mirror the transcript's empty lines", () => {
    const record = buildMemoryRecord([
      proposals(2, [], "empty"),
      transfer(2, [], "empty"),
      checkup(2, []),
    ])
    const t2 = record.turns[0]!
    expect(t2.candidates!.items).toEqual([])
    expect(t2.transfers!.items).toEqual([])
    expect(t2.checkup!.items).toEqual([])
  })

  it("keeps failed Checkup lanes so the record rail cannot call an incomplete audit clear", () => {
    const record = buildMemoryRecord([
      checkup(3, [], "failed", ["conflict", "redundancy"]),
    ])

    expect(record.turns[0]!.checkup).toMatchObject({
      decision: "failed",
      items: [],
      failedKinds: ["conflict", "redundancy"],
    })
  })

  it("skips hidden messages and entries without turns; empty transcript → empty record", () => {
    const hiddenTrace = { ...trace(9, [{ id: "M-09", label: "operational" }]), hidden: true } as HydratedTranscriptMessage
    const noTurn = { ...trace(0, [{ id: "M-08", label: "operational" }]), turn: undefined } as HydratedTranscriptMessage
    const orphanText = text("a-9", "Citations [M-11] before any turn exists.")
    const record = buildMemoryRecord([orphanText, hiddenTrace, noTurn])
    expect(record.turns).toEqual([])
  })
})
