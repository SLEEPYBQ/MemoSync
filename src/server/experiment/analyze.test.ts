import { describe, expect, test } from "bun:test"
import { analyzeEvents } from "./analyze"

const FIXTURE = [
  // session s1: inject → preview(go_on) → cite → capture(2/1/1) → trace
  { ts: "t", condition: "memosync", participant: "P03", type: "memory.inject", sessionId: "s1", engine: "claude", memories: [{ id: "M-01", scope: "personal" }, { id: "M-02", scope: "project" }], tokenEstimate: 300 },
  { ts: "t", condition: "memosync", type: "memory.preview", sessionId: "s1", engine: "claude", turn: 1, memoryIds: ["M-02"], decision: "go_on" },
  { ts: "t", condition: "memosync", type: "memory.cite", sessionId: "s1", citedIds: ["M-02"], countedIds: ["M-02"] },
  { ts: "t", condition: "memosync", type: "memory.detail_load", sessionId: "s1", ids: ["M-02"] },
  { ts: "t", condition: "memosync", type: "memory.propose", sessionId: "s1", id: "M-03", memType: "fact", scope: "session" },
  { ts: "t", condition: "memosync", type: "memory.capture", sessionId: "s1", turn: 1, proposed: 2, surfaced: 1, dropped: 1, sensitive: 0 },
  { ts: "t", condition: "memosync", type: "memory.conflict", sessionId: "s1", turn: 1, newId: "M-09", staleId: "M-02" },
  { ts: "t", condition: "memosync", type: "memory.trace", sessionId: "s1", turn: 1, labels: [{ id: "M-01", label: "injected_without_effect" }, { id: "M-02", label: "operational" }] },
  // session s2: preview dismissed + one auto-proceed (empty plan, setting on)
  { ts: "t", condition: "memosync", type: "memory.preview", sessionId: "s2", engine: "claude", turn: 1, memoryIds: [], decision: "dismiss" },
  { ts: "t", condition: "memosync", type: "memory.preview", sessionId: "s2", engine: "claude", turn: 2, memoryIds: [], decision: "auto_go_on" },
  { ts: "t", condition: "memosync", type: "memory.bringin", sessionId: "s2", ids: ["M-01"] },
  // global UI decisions (no sessionId)
  { ts: "t", condition: "memosync", type: "memory.decision", action: "accept", id: "M-03", via: "ui" },
  { ts: "t", condition: "memosync", type: "memory.decision", action: "dismiss", id: "M-04", via: "ui" },
  // junk line should be skipped
]

const lines = [...FIXTURE.map((e) => JSON.stringify(e)), "not json", ""]

describe("analyzeEvents", () => {
  test("per-session metrics", () => {
    const report = analyzeEvents(lines)
    const s1 = report.sessions["s1"]
    expect(s1.condition).toBe("memosync")
    expect(s1.participant).toBe("P03")
    expect(s1.injections).toBe(1)
    expect(s1.avgInjectedSetSize).toBe(2)
    expect(s1.citations).toBe(1)
    expect(s1.uniqueCitedIds).toEqual(["M-02"])
    expect(s1.detailLoads).toBe(1)
    expect(s1.captureProposed).toBe(2)
    expect(s1.conflicts).toBe(1)
    expect(s1.captureSurfaced).toBe(1)
    expect(s1.captureDropped).toBe(1)
    expect(s1.previews).toBe(1)
    expect(s1.previewDecisions).toEqual({ go_on: 1, dismiss: 0, without_memory: 0, auto_go_on: 0 })
    expect(s1.traceLabels).toEqual({ operational: 1, injected_without_effect: 1, violated: 0, not_applicable: 0 })

    const s2 = report.sessions["s2"]
    expect(s2.previewDecisions.dismiss).toBe(1)
    expect(s2.participant).toBeUndefined()
    // auto_go_on is its own category (STUDY_PLAN §2.4: distinguish from manual go_on)
    expect(s2.previewDecisions.auto_go_on).toBe(1)
    expect(s2.bringIns).toBe(1)
  })

  test("totals + global decisions + malformed lines skipped", () => {
    const report = analyzeEvents(lines)
    expect(report.totals.sessions).toBe(2)
    expect(report.totals.events).toBe(FIXTURE.length)
    expect(report.totals.skippedLines).toBe(1) // "not json" (empty lines ignored)
    expect(report.totals.decisions).toEqual({ create: 0, accept: 1, edit: 0, dismiss: 1, rescope: 0, archive: 0, revert: 0 })
    expect(report.totals.acceptRate).toBeCloseTo(0.5)
    expect(report.totals.traceLabels.operational).toBe(1)
  })

  test("CSV round-trips the session rows", () => {
    const report = analyzeEvents(lines)
    const csv = report.toCsv()
    const rows = csv.trim().split("\n")
    expect(rows[0]).toContain("sessionId")
    expect(rows).toHaveLength(3) // header + 2 sessions
    expect(rows.some((r) => r.startsWith("s1,"))).toBe(true)
  })

  test("excludes internal QA by default and includes it only by explicit opt-in", () => {
    const mixed = [
      { ts: "t", allocationMode: "study", condition: "auto", participant: "P01", type: "memory.inject", sessionId: "formal", memories: [] },
      { ts: "t", allocationMode: "internal_qa", condition: "auto", participant: "QA-01", type: "memory.inject", sessionId: "qa", memories: [] },
      { ts: "t", allocationMode: "internal_qa", condition: "auto", participant: "QA-01", type: "memory.decision", action: "accept", id: "M-QA" },
    ].map((event) => JSON.stringify(event))

    const formal = analyzeEvents(mixed)
    expect(formal.sessions.formal?.participant).toBe("P01")
    expect(formal.sessions.qa).toBeUndefined()
    expect(formal.totals.events).toBe(1)
    expect(formal.totals.excludedInternalQaEvents).toBe(2)
    expect(formal.totals.decisions.accept).toBe(0)

    const withQa = analyzeEvents(mixed, { includeInternalQa: true })
    expect(withQa.sessions.qa?.participant).toBe("QA-01")
    expect(withQa.sessions.qa?.allocationMode).toBe("internal_qa")
    expect(withQa.totals.events).toBe(3)
    expect(withQa.totals.excludedInternalQaEvents).toBe(0)
    expect(withQa.totals.decisions.accept).toBe(1)
  })
})

test("step-one gates, checkups, and reopens land in the report (2026-08-08)", () => {
  const lines = [
    { ts: "t", condition: "memosync", type: "memory.proposals", sessionId: "s9", turn: 1, count: 2, decision: "reviewed" },
    { ts: "t", condition: "memosync", type: "memory.proposals", sessionId: "s9", turn: 2, count: 0, decision: "empty" },
    { ts: "t", condition: "memosync", type: "memory.checkup", sessionId: "s9", turn: 1, suggestions: 3, cached: false, decision: "handled", failedKinds: ["redundancy"] },
    { ts: "t", condition: "memosync", type: "memory.checkup", sessionId: "s9", turn: 2, suggestions: 0, cached: true, decision: "clear" },
    { ts: "t", condition: "memosync", type: "memory.checkup", sessionId: "s9", turn: 3, suggestions: 0, cached: false, decision: "failed", failedKinds: ["conflict"] },
    { ts: "t", condition: "memosync", type: "memory.preparation_reopen", sessionId: "s9", turn: 2, from: "proposals", revision: 1 },
  ].map((e) => JSON.stringify(e))

  const report = analyzeEvents(lines)
  const s = report.sessions["s9"]!
  expect(s.proposalsGates).toBe(2)
  expect(s.proposalsCandidates).toBe(2)
  expect(s.proposalsDecisions.reviewed).toBe(1)
  expect(s.proposalsDecisions.empty).toBe(1)
  expect(s.checkups).toBe(3)
  expect(s.checkupSuggestions).toBe(3)
  expect(s.checkupCacheHits).toBe(1)
  expect(s.checkupDecisions.handled).toBe(1)
  expect(s.checkupDecisions.clear).toBe(1)
  expect(s.checkupDecisions.failed).toBe(1)
  expect(s.checkupIncomplete).toBe(2)
  expect(report.totals.checkupIncomplete).toBe(2)
  expect(s.preparationReopens).toBe(1)
  expect(report.totals.preparationReopens).toBe(1)
  expect(report.toCsv()).toContain("proposalsGates")
  expect(report.toCsv()).toContain("checkupIncomplete")
})

test("Board and chat-gate Control stay separate from Monitoring in analysis", () => {
  const lines = [
    { ts: "t", condition: "memosync", type: "memory.decision", action: "accept", id: "M-01", via: "board" },
    { ts: "t", condition: "memosync", type: "memory.decision", action: "edit", id: "M-02", via: "chat_gate" },
    { ts: "t", condition: "memosync", type: "memory.decision", action: "edit", id: "M-03", via: "ui" },
    { ts: "t", condition: "memosync", type: "memory.attention", sessionId: "s-control", kind: "stale", id: "M-04", action: "renew", surface: "board" },
    { ts: "t", condition: "memosync", type: "memory.attention", sessionId: "s-control", kind: "redundant", id: "M-05", action: "keep", surface: "chat_gate" },
    { ts: "t", condition: "memosync", type: "memory.transfer", sessionId: "s-control", sourceId: "M-06", targetScope: "project", surface: "board" },
    { ts: "t", condition: "memosync", type: "memory.transfer_decline", sessionId: "s-control", id: "M-07", contextKey: "P1", surface: "chat_gate" },
    { ts: "t", condition: "memosync", type: "ui.monitor", sessionId: "s-control", surface: "board", interaction: "open" },
    { ts: "t", condition: "memosync", type: "ui.monitor", sessionId: "s-control", surface: "board", interaction: "scroll" },
    { ts: "t", condition: "memosync", type: "ui.monitor", sessionId: "s-control", surface: "board", interaction: "hover", ids: ["M-01"] },
    { ts: "t", condition: "memosync", type: "ui.monitor", sessionId: "s-control", surface: "chat_gate", interaction: "hover", ids: ["M-02"] },
    { ts: "t", condition: "memosync", type: "ui.monitor", sessionId: "s-control", surface: "summary_panel", interaction: "click" },
  ].map((event) => JSON.stringify(event))

  const report = analyzeEvents(lines)
  expect(report.totals.controlInteractions).toEqual({ board: 3, chat_gate: 3, other: 1 })
  expect(report.totals.monitoringInteractions).toEqual({ board: 3, chat_gate: 1, other: 1 })
  expect(report.sessions["s-control"]!.controlInteractions).toEqual({ board: 2, chat_gate: 2, other: 0 })
  expect(report.sessions["s-control"]!.monitoringInteractions).toEqual({ board: 3, chat_gate: 1, other: 1 })
  expect(report.toCsv()).toContain("controlBoard")
  expect(report.toCsv()).toContain("monitorBoard")
})

test("Static phased edit duration counts only the completed outcome", () => {
  const base = {
    condition: "static",
    type: "study.control_operation",
    operationId: "static-edit-1",
    taskId: "038-S1",
    sessionId: "038-S1",
    surface: "static_memory",
    action: "edit",
    controlType: "static_edit",
    payload: { durationMs: 12_340 },
  }
  const report = analyzeEvents([
    JSON.stringify({ ...base, ts: "2026-08-22T10:00:00.000Z", phase: "attempted" }),
    JSON.stringify({ ...base, ts: "2026-08-22T10:00:01.000Z", phase: "completed" }),
  ])

  expect(report.sessions["038-S1"]?.staticEditDurationMs).toBe(12_340)
  expect(report.totals.staticEditDurationMs).toBe(12_340)
  expect(report.toCsv()).toContain("staticEditDurationMs")
})

test("production MemoSync interrupt, resume, and Enforce stay in one task-window Control row", () => {
  const lines = [
    {
      ts: "t",
      condition: "memosync",
      type: "memory.inject",
      schemaVersion: 2,
      semantics: "turn_focus",
      taskId: "038-S1",
      sessionId: "chat-a",
      chatId: "chat-a",
      turnId: "turn-1",
      turn: 1,
      engine: "claude",
      deliveryStage: "queued_to_claude",
      outcome: "delivered",
      memories: [{ id: "M-01" }],
    },
    {
      ts: "t",
      condition: "memosync",
      type: "memory.decision",
      taskId: "038-S1",
      sessionId: "038-S1",
      action: "accept",
      id: "M-02",
      via: "board",
    },
    {
      // Legacy chat-scoped events emitted beside a v2 focus delivery still
      // belong to the delivery's authoritative task window.
      ts: "t",
      condition: "memosync",
      type: "memory.cite",
      sessionId: "chat-a",
      citedIds: ["M-01"],
      countedIds: ["M-01"],
    },
    {
      ts: "t",
      condition: "memosync",
      type: "ui.monitor",
      taskId: "038-S1",
      sessionId: "038-S1",
      surface: "board",
      interaction: "scroll",
    },
    {
      ts: "t",
      condition: "memosync",
      type: "memory.interrupt",
      taskId: "038-S1",
      sessionId: "038-S1",
      chatId: "chat-a",
      id: "M-01",
      turn: 1,
      quote: "The rule was misapplied.",
    },
    {
      ts: "t",
      condition: "memosync",
      type: "memory.inject",
      schemaVersion: 2,
      semantics: "turn_focus",
      taskId: "038-S1",
      sessionId: "chat-b",
      chatId: "chat-b",
      turnId: "turn-2",
      turn: 2,
      engine: "claude",
      deliveryStage: "queued_to_claude",
      outcome: "delivered",
      resumeOfInterruptId: "interrupt-1",
      memories: [{ id: "M-01" }],
    },
    {
      ts: "t",
      condition: "memosync",
      type: "memory.audit_action",
      taskId: "038-S1",
      sessionId: "038-S1",
      chatId: "chat-b",
      id: "M-01",
      action: "enforce",
    },
    {
      ts: "t",
      condition: "memosync",
      type: "study.raw_tlx.submit",
      taskId: "038-S1",
      activity: "control",
      score: 42,
    },
  ].map((event) => JSON.stringify(event))

  const report = analyzeEvents(lines)
  expect(Object.keys(report.sessions)).toEqual(["038-S1"])
  expect(report.sessions["chat-a"]).toBeUndefined()
  expect(report.sessions["chat-b"]).toBeUndefined()
  expect(report.sessions["038-S1"]).toMatchObject({
    memoryInterrupts: 1,
    resumeLinkedDeliveries: 1,
    memoryEnforces: 1,
    citations: 1,
    controlInteractions: { board: 1, chat_gate: 0, other: 3 },
    monitoringInteractions: { board: 1, chat_gate: 0, other: 0 },
  })
  expect(report.totals).toMatchObject({
    memoryInterrupts: 1,
    resumeLinkedDeliveries: 1,
    memoryEnforces: 1,
    controlInteractions: { board: 1, chat_gate: 0, other: 3 },
    monitoringInteractions: { board: 1, chat_gate: 0, other: 0 },
  })
  const csv = report.toCsv()
  expect(csv).toContain("memoryInterrupts,resumeLinkedDeliveries,memoryEnforces")
  expect(csv.trim().split("\n")).toHaveLength(2)
})
