import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyMemoryStore } from "./experiment/study-memory-store";
import { StudyTelemetryError, StudyTelemetryService } from "./study-telemetry";

test("durably records one idempotent participant monitoring interaction with server-owned study identity", () => {
  const store = new StudyMemoryStore(":memory:")
  const telemetry = new StudyTelemetryService({
    store,
    participantId: "P-telemetry",
    condition: "memosync",
    activeTask: () => ({ taskId: "038-S1", state: "open" }),
    now: () => "2026-08-20T10:00:00.000Z",
  })

  const input = {
    eventId: "monitor-1",
    clientTimestamp: "2026-08-20T09:59:59.000Z",
    kind: "monitoring" as const,
    surface: "board",
    action: "scroll",
    chatId: "chat-1",
    payload: { memoryIds: ["M-01"] },
  }
  expect(telemetry.recordClient(input)).toMatchObject({ created: true, event: { eventId: "monitor-1" } })
  expect(telemetry.recordClient(input)).toMatchObject({ created: false, event: { eventId: "monitor-1" } })
  expect(store.listStudyTelemetryEvents()).toEqual([
    {
      eventId: "monitor-1",
      recordedAt: "2026-08-20T10:00:00.000Z",
      clientTimestamp: "2026-08-20T09:59:59.000Z",
      participantId: "P-telemetry",
      taskId: "038-S1",
      sessionId: "038-S1",
      chatId: "chat-1",
      condition: "memosync",
      kind: "monitoring",
      surface: "board",
      action: "scroll",
      payload: { memoryIds: ["M-01"] },
    },
  ])
  store.close()
})

test("rejects client-authored Control, cross-condition Monitoring, and server event-id namespaces", () => {
  const store = new StudyMemoryStore(":memory:")
  const telemetry = new StudyTelemetryService({
    store,
    participantId: "P-client-boundary",
    condition: "memosync",
    activeTask: () => ({ taskId: "038-S1", state: "open" }),
  })
  expect(() => telemetry.recordClient({
    eventId: "forged-control",
    kind: "control",
    surface: "static_memory",
    action: "edit_submitted",
  })).toThrow("cannot author Control")
  expect(() => telemetry.recordClient({
    eventId: "wrong-condition-monitor",
    kind: "monitoring",
    surface: "summary_panel",
    action: "open",
  })).toThrow("not available in this condition")
  expect(() => telemetry.recordClient({
    eventId: "control-operation:forged:attempted",
    kind: "monitoring",
    surface: "timeline",
    action: "scroll",
  })).toThrow("server-owned namespace")
  expect(() => telemetry.recordClient({
    eventId: "stage:first:P-client-boundary:038-S1:session_exposure",
    kind: "stage_enter",
    surface: "study",
    action: "session_exposure",
    taskId: "038-S1",
  })).toThrow("server-owned namespace")
  expect(store.listStudyTelemetryEvents()).toEqual([])
  store.close()
})

test("reserves client Monitoring namespaces and rejects stage-event preemption", () => {
  const store = new StudyMemoryStore(":memory:")
  const telemetry = new StudyTelemetryService({
    store,
    participantId: "P-reserved",
    condition: "memosync",
    activeTask: () => ({ taskId: "038-S1", state: "open" }),
  })
  const envelope = {
    recordedAt: "2026-08-20T10:00:00.000Z",
    condition: "memosync" as const,
    participant: "P-reserved",
    allocationMode: "study" as const,
  }
  expect(() => telemetry.recordServerEvent({
    ...envelope,
    event: { type: "ui.monitor", eventId: "stage:first:P-reserved:038-S1:session_exposure", sessionId: "chat-1", surface: "timeline", interaction: "scroll" },
  })).toThrow("requires a monitor:")
  store.recordStudyTelemetryEvent({
    eventId: "stage:first:P-reserved:038-S1:session_exposure",
    recordedAt: "2026-08-20T09:59:00.000Z",
    clientTimestamp: null,
    participantId: "P-reserved",
    taskId: "038-S1",
    sessionId: "038-S1",
    chatId: "chat-1",
    condition: "memosync",
    kind: "monitoring",
    surface: "timeline",
    action: "scroll",
    payload: {},
  })
  expect(() => telemetry.recordServerStageEntered("session_exposure", "038-S1")).toThrow("already bound to different durable evidence")
  store.close()
})

test("records the first stage entry once and never invents a replacement timestamp on reload", () => {
  const store = new StudyMemoryStore(":memory:")
  const timestamps = ["2026-08-20T10:00:00.000Z", "2026-08-20T10:05:00.000Z"]
  const telemetry = new StudyTelemetryService({
    store,
    participantId: "P-stage",
    condition: "memosync",
    activeTask: () => ({ taskId: "038-S1", state: "open" }),
    now: () => timestamps.shift()!,
  })

  expect(telemetry.recordServerStageEntered("information")).toMatchObject({
    created: true,
    event: { eventId: "stage:first:P-stage:study:information", recordedAt: "2026-08-20T10:00:00.000Z", taskId: null },
  })
  expect(telemetry.recordServerStageEntered("information")).toMatchObject({
    created: false,
    event: { recordedAt: "2026-08-20T10:00:00.000Z" },
  })
  expect(store.listStudyTelemetryEvents()).toHaveLength(1)
  store.close()
})

test("maps a participant MemoSync Board operation into durable attempted and completed Control evidence", () => {
  const store = new StudyMemoryStore(":memory:")
  const telemetry = new StudyTelemetryService({
    store,
    participantId: "P-control",
    condition: "memosync",
    activeTask: () => ({ taskId: "038-S1", state: "open" }),
  })

  for (const phase of ["attempted", "completed"] as const) {
    expect(telemetry.recordServerEvent({
      recordedAt: phase === "attempted" ? "2026-08-20T10:00:00.000Z" : "2026-08-20T10:00:01.000Z",
      condition: "memosync",
      participant: "P-control",
      allocationMode: "study",
      event: {
        type: "study.control_operation",
        operationId: "control:board:accept:M-04",
        phase,
        taskId: "038-S1",
        sessionId: "038-S1",
        surface: "board",
        action: "accept",
        controlType: "crud",
        payload: { memoryId: "M-04" },
      },
    })).toMatchObject({ created: true })
  }

  expect(telemetry.recordServerEvent({
    recordedAt: "2026-08-20T10:00:02.000Z",
    condition: "memosync",
    participant: "P-control",
    allocationMode: "study",
    event: {
      type: "study.control_operation",
      operationId: "control:board:accept:M-04",
      phase: "attempted",
      taskId: "038-S1",
      sessionId: "038-S1",
      surface: "board",
      action: "accept",
      controlType: "crud",
      payload: { memoryId: "M-04" },
    },
  })).toMatchObject({ created: false })

  expect(store.listStudyTelemetryEvents()).toEqual([
    expect.objectContaining({
      participantId: "P-control",
      taskId: "038-S1",
      kind: "control",
      surface: "board",
      action: "accept",
      payload: expect.objectContaining({ operationId: "control:board:accept:M-04", outcome: "attempted", memoryId: "M-04" }),
    }),
    expect.objectContaining({
      participantId: "P-control",
      taskId: "038-S1",
      kind: "control",
      surface: "board",
      action: "accept",
      payload: expect.objectContaining({ operationId: "control:board:accept:M-04", outcome: "completed", memoryId: "M-04" }),
    }),
  ])
  store.close()
})

test("fails closed for a new participant control after freeze and rejects event-id evidence collisions", () => {
  const store = new StudyMemoryStore(":memory:")
  let state: "open" | "frozen" = "open"
  const telemetry = new StudyTelemetryService({
    store,
    participantId: "P-control-boundary",
    condition: "memosync",
    activeTask: () => ({ taskId: "038-S1", state }),
  })
  const base = {
    recordedAt: "2026-08-20T10:00:00.000Z",
    condition: "memosync" as const,
    participant: "P-control-boundary",
    allocationMode: "study" as const,
    event: {
      type: "memory.interrupt" as const,
      eventId: "control:interrupt:1",
      interruptId: "interrupt-1",
      taskId: "038-S1",
      sessionId: "038-S1",
      chatId: "chat-1",
      id: "M-04",
    },
  }
  telemetry.recordServerEvent(base)
  try {
    telemetry.recordServerEvent({
      ...base,
      event: { ...base.event, id: "M-99" },
    })
    throw new Error("expected a telemetry evidence collision")
  } catch (error) {
    expect(error).toBeInstanceOf(StudyTelemetryError)
    expect(error).toMatchObject({ status: 422, message: expect.stringContaining("reused with different evidence") })
  }

  state = "frozen"
  expect(() => telemetry.recordServerEvent({
    ...base,
    event: { ...base.event, eventId: "control:interrupt:2", interruptId: "interrupt-2", id: "M-05" },
  })).toThrow("not open")
  expect(store.listStudyTelemetryEvents()).toHaveLength(1)
  store.close()
})

test("records condition-sidebar click and scroll monitoring from the shared logger", () => {
  const store = new StudyMemoryStore(":memory:")
  const telemetry = new StudyTelemetryService({
    store,
    participantId: "P-static-monitor",
    condition: "memosync",
    activeTask: () => ({ taskId: "038-S1", state: "open" }),
  })

  for (const interaction of ["click", "scroll"] as const) {
    telemetry.recordServerEvent({
      recordedAt: "2026-08-20T10:00:00.000Z",
      condition: "memosync",
      participant: "P-static-monitor",
      allocationMode: "study",
      event: {
        type: "ui.monitor",
        eventId: `monitor:static-${interaction}`,
        taskId: "038-S1",
        sessionId: "038-S1",
        chatId: "chat-1",
        surface: "timeline",
        interaction,
      },
    })
  }

  expect(store.listStudyTelemetryEvents().map((event) => ({
    kind: event.kind,
    surface: event.surface,
    action: event.action,
  }))).toEqual([
    { kind: "monitoring", surface: "timeline", action: "click" },
    { kind: "monitoring", surface: "timeline", action: "scroll" },
  ])
  store.close()
})

test("keeps MemoSync interrupt, resume and enforce as separate durable Control events", () => {
  const store = new StudyMemoryStore(":memory:")
  const telemetry = new StudyTelemetryService({
    store,
    participantId: "P-recovery",
    condition: "memosync",
    activeTask: () => ({ taskId: "038-S1", state: "open" }),
  })
  const events = [
    { type: "memory.interrupt", taskId: "038-S1", sessionId: "038-S1", chatId: "chat-1", id: "M-02", turn: 2 },
    { type: "memory.resume", taskId: "038-S1", sessionId: "038-S1", chatId: "chat-1", id: "M-02", interruptId: "interrupt-1", enforced: false },
    { type: "memory.audit_action", taskId: "038-S1", sessionId: "038-S1", chatId: "chat-1", id: "M-02", action: "enforce" },
  ] as const
  for (const event of events) {
    telemetry.recordServerEvent({
      recordedAt: "2026-08-20T10:00:00.000Z",
      condition: "memosync",
      participant: "P-recovery",
      allocationMode: "study",
      event: event as never,
    })
  }
  expect(store.listStudyTelemetryEvents().map(({ surface, action }) => ({ surface, action }))).toEqual([
    { surface: "inline_citation", action: "interrupt" },
    { surface: "interrupt_recovery", action: "resume" },
    { surface: "audit", action: "enforce" },
  ])
  store.close()
})

test("keeps phased MemoSync operations canonical while retaining compatibility events without double counting", () => {
  const store = new StudyMemoryStore(":memory:")
  const telemetry = new StudyTelemetryService({
    store,
    participantId: "P-phased-control",
    condition: "memosync",
    activeTask: () => ({ taskId: "038-S1", state: "open" }),
  })
  const operations = [
    { operationId: "control:audit:enforce:1", surface: "audit", action: "enforce", controlType: "audit" },
    { operationId: "control:working-memory:ask:1", surface: "working_memory", action: "ask_agent", controlType: "working_memory" },
    { operationId: "control:working-memory:start:1", surface: "working_memory", action: "go_on", controlType: "working_memory" },
  ] as const
  for (const operation of operations) {
    for (const phase of ["attempted", "completed"] as const) {
      telemetry.recordServerEvent({
        recordedAt: phase === "attempted" ? "2026-08-20T10:00:00.000Z" : "2026-08-20T10:00:01.000Z",
        condition: "memosync",
        participant: "P-phased-control",
        allocationMode: "study",
        event: {
          type: "study.control_operation",
          ...operation,
          phase,
          taskId: "038-S1",
          sessionId: "038-S1",
        },
      })
    }
  }

  const compatibility = [
    { type: "memory.audit_action", operationId: operations[0].operationId, taskId: "038-S1", sessionId: "038-S1", chatId: "chat-1", id: "M-01", action: "enforce" },
    { type: "memory.revise_injection", operationId: operations[1].operationId, sessionId: "chat-1", instruction: "keep it", beforeIds: ["M-01"], afterIds: ["M-01"], changed: false },
    { type: "memory.preview", operationId: operations[2].operationId, sessionId: "chat-1", engine: "claude", turn: 1, memoryIds: ["M-01"], decision: "go_on", selectedIds: ["M-01"] },
  ] as const
  for (const event of compatibility) {
    expect(telemetry.recordServerEvent({
      recordedAt: "2026-08-20T10:00:02.000Z",
      condition: "memosync",
      participant: "P-phased-control",
      allocationMode: "study",
      event: event as never,
    })).toBeUndefined()
  }

  expect(store.listStudyTelemetryEvents()).toHaveLength(6)
  store.close()
})

test("binds every accepted MemoSync prompt to its transcript turn without baseline prompt matching", () => {
  const store = new StudyMemoryStore(":memory:")
  const times = ["2026-08-20T10:00:00.000Z", "2026-08-20T10:01:00.000Z", "2026-08-20T10:02:00.000Z"]
  const telemetry = new StudyTelemetryService({
    store,
    participantId: "P-auto-prompt",
    condition: "memosync",
    activeTask: () => ({ taskId: "038-S1", state: "open" }),
    now: () => times.shift()!,
  })

  const explicit = telemetry.recordParticipantPrompt({
    taskId: "038-S1",
    turnId: "turn-1",
    chatId: "chat-1",
    content: "Please update your memory: always use pnpm for this project.",
    attachments: [],
  })
  expect(explicit).toMatchObject({
    created: true,
    event: {
      eventId: "prompt:P-auto-prompt:038-S1:chat-1:turn-1",
      kind: "participant_prompt",
      action: "submit",
      payload: { memoryUpdateCandidate: { matched: false, authority: "candidate_only" } },
    },
  })
  expect(telemetry.recordParticipantPrompt({
    taskId: "038-S1",
    turnId: "turn-1",
    chatId: "chat-1",
    content: "Please update your memory: always use pnpm for this project.",
    attachments: [],
  })).toMatchObject({ created: false, event: { recordedAt: "2026-08-20T10:00:00.000Z" } })
  expect(telemetry.recordParticipantPrompt({
    taskId: "038-S1",
    turnId: "turn-2",
    chatId: "chat-1",
    content: "Now implement the checkout page.",
    attachments: [],
  })).toMatchObject({ created: true, event: { kind: "participant_prompt", action: "submit" } })
  store.close()
})

test("records an attachment-only participant prompt instead of leaving an unrecoverable transcript gap", () => {
  const store = new StudyMemoryStore(":memory:")
  const telemetry = new StudyTelemetryService({
    store,
    participantId: "P-attachment-prompt",
    condition: "memosync",
    activeTask: () => ({ taskId: "038-S1", state: "open" }),
    now: () => "2026-08-20T10:00:00.000Z",
  })

  expect(telemetry.recordParticipantPrompt({
    taskId: "038-S1",
    turnId: "turn-attachment-only",
    chatId: "chat-1",
    content: "",
    attachments: [{ id: "attachment-1", name: "task-note.txt" }],
  })).toMatchObject({
    created: true,
    event: {
      kind: "participant_prompt",
      payload: {
        content: "",
        contentSource: "participant",
        attachments: [{ id: "attachment-1", name: "task-note.txt" }],
      },
    },
  })
  store.close()
})

test("maps MemoSync transfer, checkup and Working Memory decisions while excluding agent-only shown rows", () => {
  const store = new StudyMemoryStore(":memory:")
  const telemetry = new StudyTelemetryService({
    store,
    participantId: "P-board-controls",
    condition: "memosync",
    activeTask: () => ({ taskId: "038-S1", state: "open" }),
  })
  const events = [
    { type: "study.control_operation", operationId: "transfer-1", phase: "completed", taskId: "038-S1", sessionId: "038-S1", surface: "board", action: "transfer", controlType: "transfer", payload: { memoryId: "M-01" } },
    { type: "study.control_operation", operationId: "decline-1", phase: "completed", taskId: "038-S1", sessionId: "038-S1", surface: "chat_gate", action: "transfer_decline", controlType: "transfer", payload: { memoryId: "M-02" } },
    { type: "study.control_operation", operationId: "checkup-1", phase: "completed", taskId: "038-S1", sessionId: "038-S1", surface: "board", action: "keep", controlType: "checkup", payload: { memoryId: "M-03" } },
    { type: "memory.attention", taskId: "038-S1", sessionId: "038-S1", kind: "stale", id: "M-04", action: "shown", surface: "board" },
    { type: "memory.preview", sessionId: "chat-1", engine: "claude", turn: 2, memoryIds: ["M-01"], decision: "go_on", selectedIds: ["M-01"] },
    { type: "memory.preview", sessionId: "chat-1", engine: "claude", turn: 3, memoryIds: [], decision: "auto_go_on" },
  ]
  for (const event of events) {
    if (event.type === "study.control_operation") {
      telemetry.recordServerEvent({
        recordedAt: "2026-08-20T09:59:59.000Z",
        condition: "memosync",
        participant: "P-board-controls",
        allocationMode: "study",
        event: { ...event, phase: "attempted" } as never,
      })
    }
    telemetry.recordServerEvent({
      recordedAt: "2026-08-20T10:00:00.000Z",
      condition: "memosync",
      participant: "P-board-controls",
      allocationMode: "study",
      event: event as never,
    })
  }
  expect(store.listStudyTelemetryEvents()
    .filter((event) => event.payload.outcome !== "attempted")
    .map(({ surface, action }) => ({ surface, action }))).toEqual([
    { surface: "board", action: "transfer" },
    { surface: "chat_gate", action: "transfer_decline" },
    { surface: "board", action: "keep" },
    { surface: "working_memory", action: "go_on" },
  ])
  store.close()
})

test("a client event retry after a real SQLite reopen returns the original server timestamp", () => {
  const dir = mkdtempSync(join(tmpdir(), "memosync-telemetry-restart-"))
  const dbPath = join(dir, "study.sqlite")
  const input = {
    eventId: "monitor-restart-1",
    clientTimestamp: "2026-08-20T09:59:59.000Z",
    kind: "monitoring" as const,
    surface: "timeline",
    action: "click",
    chatId: "chat-1",
    payload: { memoryIds: ["M-01"] },
  }
  const firstStore = new StudyMemoryStore(dbPath)
  new StudyTelemetryService({
    store: firstStore,
    participantId: "P-restart",
    condition: "memosync",
    activeTask: () => ({ taskId: "038-S1", state: "open" }),
    now: () => "2026-08-20T10:00:00.000Z",
  }).recordClient(input)
  firstStore.close()

  const reopened = new StudyMemoryStore(dbPath)
  const retried = new StudyTelemetryService({
    store: reopened,
    participantId: "P-restart",
    condition: "memosync",
    activeTask: () => ({ taskId: "038-S1", state: "open" }),
    now: () => "2026-08-20T10:10:00.000Z",
  }).recordClient(input)
  expect(retried).toMatchObject({ created: false, event: { recordedAt: "2026-08-20T10:00:00.000Z" } })
  expect(reopened.listStudyTelemetryEvents()).toHaveLength(1)
  reopened.close()
  rmSync(dir, { recursive: true, force: true })
})

test("a delayed Monitoring event remains bound to its original chat task after freeze and the next task opens", () => {
  const store = new StudyMemoryStore(":memory:")
  let active = { taskId: "038-S1", state: "open" as const }
  let now = "2026-08-20T10:00:00.000Z"
  const telemetry = new StudyTelemetryService({
    store,
    participantId: "P-late-monitoring",
    condition: "memosync",
    activeTask: () => active,
    now: () => now,
  })
  telemetry.recordServerStageEntered("session_exposure", "038-S1")
  telemetry.recordParticipantPrompt({
    taskId: "038-S1",
    turnId: "turn-1",
    chatId: "chat-038",
    content: "Implement the first task.",
    attachments: [],
  })
  store.createFreezeSnapshot({
    snapshotId: "freeze-038",
    taskId: "038-S1",
    frozenAt: "2026-08-20T10:10:00.000Z",
  })

  active = { taskId: "098-S1", state: "open" }
  now = "2026-08-20T10:20:00.000Z"
  telemetry.recordServerStageEntered("session_exposure", "098-S1")
  const late = telemetry.recordClient({
    eventId: "monitor:late-038",
    clientTimestamp: "2026-08-20T10:05:00.000Z",
    kind: "monitoring",
    surface: "timeline",
    action: "scroll",
    chatId: "chat-038",
  })

  expect(late).toMatchObject({
    created: true,
    event: {
      recordedAt: "2026-08-20T10:20:00.000Z",
      clientTimestamp: "2026-08-20T10:05:00.000Z",
      taskId: "038-S1",
      sessionId: "038-S1",
      chatId: "chat-038",
    },
  })
  store.close()
})

test("records one ordered surface exposure and keeps later transitions bound to the opening chat task", () => {
  const store = new StudyMemoryStore(":memory:")
  let active = { taskId: "038-S1", state: "open" as const }
  let now = "2026-08-20T10:00:00.000Z"
  const telemetry = new StudyTelemetryService({
    store,
    participantId: "P-surface-exposure",
    condition: "memosync",
    activeTask: () => active,
    now: () => now,
  })
  telemetry.recordServerStageEntered("session_exposure", "038-S1")
  telemetry.recordParticipantPrompt({
    taskId: "038-S1",
    turnId: "turn-1",
    chatId: "chat-038",
    content: "Implement the first task.",
    attachments: [],
  })

  const record = (sequence: number, action: "opened" | "hidden" | "visible" | "closed", clientTimestamp: string) =>
    telemetry.recordClient({
      eventId: `surface-exposure:exposure-auto-1:${sequence}`,
      clientTimestamp,
      kind: "surface_exposure",
      surface: "memory_record",
      action,
      chatId: "chat-038",
      payload: {
        exposureId: "exposure-auto-1",
        sequence,
        initiator: "participant",
        ...(action === "closed" ? { closeReason: "unmount" } : {}),
      },
    })

  expect(record(0, "opened", "2026-08-20T10:00:01.000Z")).toMatchObject({
    created: true,
    event: { taskId: "038-S1", kind: "surface_exposure", action: "opened" },
  })
  expect(record(1, "hidden", "2026-08-20T10:00:03.000Z")).toMatchObject({ created: true })

  active = { taskId: "098-S1", state: "open" }
  now = "2026-08-20T10:20:00.000Z"
  telemetry.recordServerStageEntered("session_exposure", "098-S1")
  expect(record(2, "visible", "2026-08-20T10:00:06.000Z")).toMatchObject({
    created: true,
    event: { taskId: "038-S1", sessionId: "038-S1" },
  })
  expect(record(3, "closed", "2026-08-20T10:00:10.000Z")).toMatchObject({
    created: true,
    event: { taskId: "038-S1", sessionId: "038-S1" },
  })
  expect(store.listStudyTelemetryEvents().filter((event) => event.kind === "surface_exposure"))
    .toHaveLength(4)
  store.close()
})

test("rejects one malformed surface transition without blocking a later canonical exposure", () => {
  const store = new StudyMemoryStore(":memory:")
  const telemetry = new StudyTelemetryService({
    store,
    participantId: "P-surface-validation",
    condition: "memosync",
    activeTask: () => ({ taskId: "038-S1", state: "open" }),
  })
  const event = (exposureId: string, sequence: number, action: string, surface = "memory_record") => ({
    eventId: `surface-exposure:${exposureId}:${sequence}`,
    clientTimestamp: `2026-08-20T10:00:0${sequence}.000Z`,
    kind: "surface_exposure",
    surface,
    action,
    chatId: "chat-038",
    payload: { exposureId, sequence, initiator: "participant" },
  })

  expect(() => telemetry.recordClient(event("broken", 1, "closed")))
    .toThrow("closeReason is required")
  expect(() => telemetry.recordClient(event("wrong-arm", 0, "opened", "auto_summary_sidebar")))
    .toThrow("not available in this condition")
  expect(telemetry.recordClient(event("canonical", 0, "opened"))).toMatchObject({ created: true })
  expect(store.listStudyTelemetryEvents().filter((row) => row.kind === "surface_exposure"))
    .toHaveLength(1)
  store.close()
})

test("accepts the equal-time initial-hidden pair across a real SQLite reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "memosync-surface-hidden-restart-"))
  const dbPath = join(dir, "study.sqlite")
  const input = (sequence: number, action: "opened" | "hidden" | "visible" | "closed", timestamp: string) => ({
    eventId: `surface-exposure:hidden-restart:${sequence}`,
    clientTimestamp: timestamp,
    kind: "surface_exposure" as const,
    surface: "memory_record",
    action,
    chatId: "chat-hidden",
    payload: {
      exposureId: "hidden-restart",
      sequence,
      initiator: "participant",
      ...(action === "closed" ? { closeReason: "unmount" } : {}),
    },
  })
  const firstStore = new StudyMemoryStore(dbPath)
  const first = new StudyTelemetryService({
    store: firstStore,
    participantId: "P-hidden-restart",
    condition: "memosync",
    activeTask: () => ({ taskId: "038-S1", state: "open" }),
    now: () => "2026-08-20T10:10:00.000Z",
  })
  first.recordClient(input(0, "opened", "2026-08-20T10:00:00.000Z"))
  first.recordClient(input(1, "hidden", "2026-08-20T10:00:00.000Z"))
  firstStore.close()

  const reopened = new StudyMemoryStore(dbPath)
  const afterRestart = new StudyTelemetryService({
    store: reopened,
    participantId: "P-hidden-restart",
    condition: "memosync",
    activeTask: () => ({ taskId: "098-S1", state: "open" }),
    now: () => "2026-08-20T10:20:00.000Z",
  })
  expect(afterRestart.recordClient(input(0, "opened", "2026-08-20T10:00:00.000Z")))
    .toMatchObject({ created: false, event: { recordedAt: "2026-08-20T10:10:00.000Z" } })
  expect(afterRestart.recordClient(input(2, "visible", "2026-08-20T10:00:01.000Z")))
    .toMatchObject({ created: true, event: { taskId: "038-S1" } })
  expect(afterRestart.recordClient(input(3, "closed", "2026-08-20T10:00:02.000Z")))
    .toMatchObject({ created: true, event: { taskId: "038-S1" } })
  expect(reopened.listStudySurfaceExposureEvents("hidden-restart").map((event) => event.clientTimestamp))
    .toEqual([
      "2026-08-20T10:00:00.000Z",
      "2026-08-20T10:00:00.000Z",
      "2026-08-20T10:00:01.000Z",
      "2026-08-20T10:00:02.000Z",
    ])
  reopened.close()
  rmSync(dir, { recursive: true, force: true })
})

test("an unbound stale Monitoring event is rejected instead of being assigned to the newly open task", () => {
  const store = new StudyMemoryStore(":memory:")
  const telemetry = new StudyTelemetryService({
    store,
    participantId: "P-unbound-monitoring",
    condition: "memosync",
    activeTask: () => ({ taskId: "098-S1", state: "open" }),
    now: () => "2026-08-20T10:20:00.000Z",
  })
  telemetry.recordServerStageEntered("session_exposure", "098-S1")

  expect(() => telemetry.recordClient({
    eventId: "monitor:unbound-old",
    clientTimestamp: "2026-08-20T10:05:00.000Z",
    kind: "monitoring",
    surface: "board",
    action: "scroll",
    chatId: "chat-with-no-durable-task",
  })).toThrow("outside the active server-observed task window")
  expect(store.listStudyTelemetryEvents().map((event) => event.eventId)).toEqual([
    "stage:first:P-unbound-monitoring:098-S1:session_exposure",
  ])
  store.close()
})

test("a delayed ui.monitor logger event uses the durable chat binding rather than receive-time active task", () => {
  const store = new StudyMemoryStore(":memory:")
  let active = { taskId: "038-S1", state: "open" as const }
  let now = "2026-08-20T10:00:00.000Z"
  const telemetry = new StudyTelemetryService({
    store,
    participantId: "P-late-logger",
    condition: "memosync",
    activeTask: () => active,
    now: () => now,
  })
  telemetry.recordServerStageEntered("session_exposure", "038-S1")
  telemetry.recordParticipantPrompt({
    taskId: "038-S1",
    turnId: "turn-1",
    chatId: "chat-038",
    content: "Implement the first task.",
    attachments: [],
  })
  store.createFreezeSnapshot({
    snapshotId: "freeze-logger-038",
    taskId: "038-S1",
    frozenAt: "2026-08-20T10:10:00.000Z",
  })
  active = { taskId: "098-S1", state: "open" }
  now = "2026-08-20T10:20:00.000Z"
  telemetry.recordServerStageEntered("session_exposure", "098-S1")

  const result = telemetry.recordServerEvent({
    recordedAt: "2026-08-20T10:20:00.000Z",
    condition: "memosync",
    participant: "P-late-logger",
    allocationMode: "study",
    event: {
      type: "ui.monitor",
      eventId: "monitor:late-logger-038",
      clientTimestamp: "2026-08-20T10:05:00.000Z",
      sessionId: "chat-038",
      chatId: "chat-038",
      surface: "timeline",
      interaction: "scroll",
    },
  })

  expect(result).toMatchObject({
    created: true,
    event: { taskId: "038-S1", sessionId: "038-S1", chatId: "chat-038" },
  })
  store.close()
})

test("late Working Memory toggle phases use one durable historical chat window and reject forged variants", () => {
  const store = new StudyMemoryStore(":memory:")
  let active = { taskId: "038-S1", state: "open" as const }
  let now = "2026-08-20T10:00:00.000Z"
  const telemetry = new StudyTelemetryService({
    store,
    participantId: "P-late-working-memory",
    condition: "memosync",
    activeTask: () => active,
    now: () => now,
  })
  telemetry.recordServerStageEntered("session_exposure", "038-S1")
  telemetry.recordParticipantPrompt({
    taskId: "038-S1",
    turnId: "turn-1",
    chatId: "chat-038",
    content: "Implement the first task.",
    attachments: [],
    acceptedAt: "2026-08-20T10:00:00.000Z",
  })
  store.createFreezeSnapshot({
    snapshotId: "freeze-working-memory-038",
    taskId: "038-S1",
    frozenAt: "2026-08-20T10:10:00.000Z",
  })
  active = { taskId: "098-S1", state: "open" }
  now = "2026-08-20T10:20:00.000Z"
  telemetry.recordServerStageEntered("session_exposure", "098-S1")

  const envelope = {
    recordedAt: "2026-08-20T10:20:00.000Z",
    condition: "memosync" as const,
    participant: "P-late-working-memory",
    allocationMode: "study" as const,
  }
  const event = {
    type: "study.control_operation" as const,
    operationId: "control:working-memory-selection:add:M-01:late",
    taskId: "038-S1",
    sessionId: "038-S1",
    chatId: "chat-038",
    clientTimestamp: "2026-08-20T10:05:00.000Z",
    surface: "working_memory" as const,
    action: "add",
    controlType: "working_memory" as const,
    payload: {
      chatId: "chat-038",
      previewId: "preview-1",
      memoryId: "M-01",
      clientTimestamp: "2026-08-20T10:05:00.000Z",
      outcome: "observed",
    },
  }

  expect(telemetry.recordServerEvent({
    ...envelope,
    event: { ...event, phase: "attempted" },
  })).toMatchObject({
    created: true,
    event: { taskId: "038-S1", sessionId: "038-S1", chatId: "chat-038", clientTimestamp: event.clientTimestamp },
  })
  expect(telemetry.recordServerEvent({
    ...envelope,
    event: { ...event, phase: "completed" },
  })).toMatchObject({
    created: true,
    event: { taskId: "038-S1", sessionId: "038-S1", chatId: "chat-038", clientTimestamp: event.clientTimestamp },
  })

  const expectRejectedAttempt = (operationId: string, patch: Record<string, unknown>, message: string) => {
    expect(() => telemetry.recordServerEvent({
      ...envelope,
      event: {
        ...event,
        operationId,
        phase: "attempted",
        ...patch,
      } as never,
    })).toThrow(message)
  }
  expectRejectedAttempt("control:audit:add:late", {
    surface: "audit",
    controlType: "audit",
  }, "active study window")
  expectRejectedAttempt("control:working-memory-selection:start:M-01:late", {
    action: "go_on",
  }, "active study window")
  expectRejectedAttempt("control:working-memory-selection:add:M-01:forged-task", {
    taskId: "098-S1",
    sessionId: "098-S1",
  }, "does not match")
  expectRejectedAttempt("control:working-memory-selection:add:M-01:post-window", {
    clientTimestamp: "2026-08-20T10:15:00.000Z",
    payload: { ...event.payload, clientTimestamp: "2026-08-20T10:15:00.000Z" },
  }, "outside")
  expectRejectedAttempt("control:working-memory-selection:add:M-01:unbound-chat", {
    chatId: "chat-unbound",
    payload: { ...event.payload, chatId: "chat-unbound" },
  }, "durable")

  const otherOperation = { ...event, operationId: "control:working-memory-selection:remove:M-01:phase-binding", action: "remove" }
  telemetry.recordServerEvent({ ...envelope, event: { ...otherOperation, phase: "attempted" } })
  expect(() => telemetry.recordServerEvent({
    ...envelope,
    event: {
      ...otherOperation,
      phase: "completed",
      clientTimestamp: "2026-08-20T10:05:01.000Z",
      payload: { ...otherOperation.payload, clientTimestamp: "2026-08-20T10:05:01.000Z" },
    },
  })).toThrow("phase evidence")
  store.close()
})

test("admits each post-session stage only after the preceding durable submission", () => {
  const store = new StudyMemoryStore(":memory:")
  const snapshot = store.createFreezeSnapshot({
    snapshotId: "freeze-stages",
    taskId: "038-S1",
    frozenAt: "2026-08-20T10:00:00.000Z",
  })
  const telemetry = new StudyTelemetryService({
    store,
    participantId: "P-post-stages",
    condition: "memosync",
    activeTask: () => ({ taskId: "038-S1", state: "frozen" }),
    now: () => "2026-08-20T10:01:00.000Z",
  })
  expect(telemetry.recordClient({
    eventId: "stage-entry:questionnaire",
    kind: "stage_enter",
    surface: "study",
    action: "memory_questionnaire",
    taskId: "038-S1",
  })).toMatchObject({ created: true, event: { taskId: "038-S1" } })
  expect(() => telemetry.recordClient({
    eventId: "stage-entry:monitoring-too-early",
    kind: "stage_enter",
    surface: "study",
    action: "monitoring_tlx",
    taskId: "038-S1",
  })).toThrow("not open")
  store.recordQuestionnaireSubmission({
    submissionId: "questionnaire-stages",
    snapshotId: snapshot.snapshotId,
    submittedAt: "2026-08-20T10:02:00.000Z",
    questionnaireVersion: 2,
    answers: [],
  })
  expect(telemetry.recordClient({
    eventId: "stage-entry:monitoring",
    kind: "stage_enter",
    surface: "study",
    action: "monitoring_tlx",
    taskId: "038-S1",
  })).toMatchObject({ created: true })
  store.close()
})
