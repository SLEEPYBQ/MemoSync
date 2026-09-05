import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StudyMemoryStore } from "./experiment/study-memory-store"
import { isExplicitMemoryUpdateRequest, StudyTelemetryError, StudyTelemetryService } from "./study-telemetry"

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
    condition: "static",
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
    action: "scroll",
  })).toThrow("not available in this condition")
  expect(() => telemetry.recordClient({
    eventId: "control-operation:forged:attempted",
    kind: "monitoring",
    surface: "static_memory_panel",
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

test("reserves client Monitoring and Auto summary prompt namespaces and rejects stage-event preemption", () => {
  const store = new StudyMemoryStore(":memory:")
  const telemetry = new StudyTelemetryService({
    store,
    participantId: "P-reserved",
    condition: "auto",
    activeTask: () => ({ taskId: "038-S1", state: "open" }),
  })
  const envelope = {
    recordedAt: "2026-08-20T10:00:00.000Z",
    condition: "auto" as const,
    participant: "P-reserved",
    allocationMode: "study" as const,
  }
  expect(() => telemetry.recordServerEvent({
    ...envelope,
    event: { type: "ui.monitor", eventId: "stage:first:P-reserved:038-S1:session_exposure", sessionId: "chat-1", surface: "summary_panel", interaction: "scroll" },
  })).toThrow("requires a monitor:")
  expect(() => telemetry.recordServerEvent({
    ...envelope,
    event: { type: "study.participant_prompt", eventId: "monitor:wrong", sessionId: "chat-1", surface: "auto_summary_chat", action: "submit", projectId: "project-038", content: "Inspect memory." },
  })).toThrow("require a prompt:auto-summary:")
  store.recordStudyTelemetryEvent({
    eventId: "stage:first:P-reserved:038-S1:session_exposure",
    recordedAt: "2026-08-20T09:59:00.000Z",
    clientTimestamp: null,
    participantId: "P-reserved",
    taskId: "038-S1",
    sessionId: "038-S1",
    chatId: "chat-1",
    condition: "auto",
    kind: "monitoring",
    surface: "summary_panel",
    action: "scroll",
    payload: {},
  })
  expect(() => telemetry.recordServerStageEntered("session_exposure", "038-S1")).toThrow("already bound to different durable evidence")
  store.close()
})

test("records Static edit entry only through its server-owned semantic ingress", () => {
  const store = new StudyMemoryStore(":memory:")
  const telemetry = new StudyTelemetryService({
    store,
    participantId: "P-static-entered",
    condition: "static",
    activeTask: () => ({ taskId: "038-S1", state: "open" }),
    now: () => "2026-08-20T10:00:00.000Z",
  })
  telemetry.recordServerStageEntered("session_exposure", "038-S1")
  expect(telemetry.recordStaticEditEntered({
    operationId: "control:static-edit:1",
    path: "MEMORY.md",
    chatId: "chat-1",
    clientTimestamp: "2026-08-20T10:00:00.000Z",
  })).toMatchObject({ created: true, event: { kind: "stage_enter", action: "edit_entered" } })
  expect(telemetry.recordStaticEditEntered({
    operationId: "control:static-edit:1",
    path: "MEMORY.md",
    chatId: "chat-1",
    clientTimestamp: "2026-08-20T10:00:00.000Z",
  })).toMatchObject({ created: false })
  expect(store.listStudyTelemetryEvents().filter((event) => event.action === "edit_entered")).toHaveLength(1)
  store.close()
})

test("rejects a Static edit-entry claim for an ordinary project file", () => {
  const store = new StudyMemoryStore(":memory:")
  const telemetry = new StudyTelemetryService({
    store,
    participantId: "P-static-non-memory",
    condition: "static",
    activeTask: () => ({ taskId: "038-S1", state: "open" }),
  })

  expect(() => telemetry.recordStaticEditEntered({
    operationId: "control:static-edit:ordinary-file-1",
    path: "src/app.ts",
    chatId: "chat-1",
    clientTimestamp: "2026-08-20T10:00:00.000Z",
  })).toThrow("not a Static memory Markdown path")
  expect(store.listStudyTelemetryEvents()).toEqual([])
  store.close()
})

test("a delayed Static edit entry binds to its completed historical operation after freeze", () => {
  const store = new StudyMemoryStore(":memory:")
  let active = { taskId: "038-S1", state: "open" as const }
  let now = "2026-08-20T10:00:00.000Z"
  const telemetry = new StudyTelemetryService({
    store,
    participantId: "P-static-late",
    condition: "static",
    activeTask: () => active,
    now: () => now,
  })
  telemetry.recordServerStageEntered("session_exposure", "038-S1")
  telemetry.recordParticipantPrompt({
    taskId: "038-S1",
    turnId: "turn-1",
    chatId: "chat-static-038",
    content: "Update the saved memory.",
    attachments: [],
  })
  const envelope = {
    condition: "static" as const,
    participant: "P-static-late",
    allocationMode: "study" as const,
  }
  const operation = {
    type: "study.control_operation" as const,
    operationId: "control:static-edit:late",
    taskId: "038-S1",
    sessionId: "038-S1",
    chatId: "chat-static-038",
    surface: "static_memory" as const,
    action: "edit",
    controlType: "static_edit" as const,
    payload: { projectId: "project-038", path: "MEMORY.md", durationMs: 30_000 },
  }
  telemetry.recordServerEvent({
    ...envelope,
    recordedAt: "2026-08-20T10:02:00.000Z",
    event: { ...operation, phase: "attempted" },
  })
  telemetry.recordServerEvent({
    ...envelope,
    recordedAt: "2026-08-20T10:03:00.000Z",
    event: { ...operation, phase: "completed" },
  })
  store.createFreezeSnapshot({
    snapshotId: "freeze-static-038",
    taskId: "038-S1",
    frozenAt: "2026-08-20T10:10:00.000Z",
  })
  active = { taskId: "098-S1", state: "open" }
  now = "2026-08-20T10:20:00.000Z"
  telemetry.recordServerStageEntered("session_exposure", "098-S1")

  const input = {
    operationId: operation.operationId,
    path: "MEMORY.md",
    chatId: "chat-static-038",
    clientTimestamp: "2026-08-20T10:01:00.000Z",
  }
  expect(telemetry.recordStaticEditEntered(input)).toMatchObject({
    created: true,
    event: {
      taskId: "038-S1",
      sessionId: "038-S1",
      chatId: input.chatId,
      clientTimestamp: input.clientTimestamp,
    },
  })
  expect(telemetry.recordStaticEditEntered(input)).toMatchObject({ created: false })
  expect(() => telemetry.recordStaticEditEntered({
    ...input,
    operationId: "control:static-edit:post-window",
    clientTimestamp: "2026-08-20T10:15:00.000Z",
  })).toThrow("no durable attempted operation")
  expect(telemetry.recordStaticEditEntered({
    ...input,
    operationId: "control:static-edit:other-chat",
    chatId: "chat-unbound",
  })).toMatchObject({ event: { taskId: "098-S1", sessionId: "098-S1", chatId: "chat-unbound" } })
  expect(store.listStudyTelemetryEvents().filter((event) => (
    event.payload.operationId === operation.operationId && event.payload.outcome === "completed"
  ))).toHaveLength(1)
  store.close()
})

test("records the first stage entry once and never invents a replacement timestamp on reload", () => {
  const store = new StudyMemoryStore(":memory:")
  const timestamps = ["2026-08-20T10:00:00.000Z", "2026-08-20T10:05:00.000Z"]
  const telemetry = new StudyTelemetryService({
    store,
    participantId: "P-stage",
    condition: "auto",
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
    condition: "static",
    activeTask: () => ({ taskId: "038-S1", state: "open" }),
  })

  for (const interaction of ["click", "scroll"] as const) {
    telemetry.recordServerEvent({
      recordedAt: "2026-08-20T10:00:00.000Z",
      condition: "static",
      participant: "P-static-monitor",
      allocationMode: "study",
      event: {
        type: "ui.monitor",
        eventId: `monitor:static-${interaction}`,
        taskId: "038-S1",
        sessionId: "038-S1",
        chatId: "chat-1",
        surface: "static_memory_panel",
        interaction,
      },
    })
  }

  expect(store.listStudyTelemetryEvents().map((event) => ({
    kind: event.kind,
    surface: event.surface,
    action: event.action,
  }))).toEqual([
    { kind: "monitoring", surface: "static_memory_panel", action: "click" },
    { kind: "monitoring", surface: "static_memory_panel", action: "scroll" },
  ])
  store.close()
})

test("records only participant-originated baseline memory controls with Static edit duration", () => {
  const cases = [
    {
      participantId: "P-auto",
      condition: "auto" as const,
      event: {
        type: "memory.control_request" as const,
        sessionId: "chat-auto",
        via: "auto_summary_chat" as const,
        requestedAction: "update_memory" as const,
        applied: 1,
      },
      expected: { surface: "auto_summary_chat", action: "update_memory" },
    },
    {
      participantId: "P-static",
      condition: "static" as const,
      event: {
        type: "memory.static_edit" as const,
        sessionId: "chat-static",
        projectId: "project-static",
        path: "MEMORY.md",
        durationMs: 12_340,
      },
      expected: { surface: "static_memory", action: "edit_submitted", durationMs: 12_340 },
    },
  ]

  for (const entry of cases) {
    const store = new StudyMemoryStore(":memory:")
    const telemetry = new StudyTelemetryService({
      store,
      participantId: entry.participantId,
      condition: entry.condition,
      activeTask: () => ({ taskId: "038-S1", state: "open" }),
    })
    telemetry.recordServerEvent({
      recordedAt: "2026-08-20T10:00:00.000Z",
      condition: entry.condition,
      participant: entry.participantId,
      allocationMode: "study",
      event: entry.event,
    })
    const [event] = store.listStudyTelemetryEvents()
    expect(event).toMatchObject({
      kind: "control",
      surface: entry.expected.surface,
      action: entry.expected.action,
      ...(entry.expected.durationMs ? { payload: expect.objectContaining({ durationMs: entry.expected.durationMs }) } : {}),
    })
    store.close()
  }
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

test("binds every accepted baseline prompt to its transcript turn and keeps memory-update matching non-authoritative", () => {
  const store = new StudyMemoryStore(":memory:")
  const times = ["2026-08-20T10:00:00.000Z", "2026-08-20T10:01:00.000Z", "2026-08-20T10:02:00.000Z"]
  const telemetry = new StudyTelemetryService({
    store,
    participantId: "P-auto-prompt",
    condition: "auto",
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
      payload: { memoryUpdateCandidate: { matched: true, authority: "candidate_only" } },
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
    condition: "static",
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

test("durably keeps an Auto summary-panel prompt raw until a separately identified update control is observed", () => {
  const store = new StudyMemoryStore(":memory:")
  const telemetry = new StudyTelemetryService({
    store,
    participantId: "P-auto-summary",
    condition: "auto",
    activeTask: () => ({ taskId: "038-S1", state: "open" }),
    now: () => "2026-08-20T10:00:00.000Z",
  })
  const prompt = {
    type: "study.participant_prompt" as const,
    eventId: "prompt:auto-summary:request-1",
    sessionId: "chat-1",
    surface: "auto_summary_chat" as const,
    action: "submit" as const,
    projectId: "project-038",
    content: "Please update the memory to use pnpm.",
  }
  const envelope = {
    recordedAt: "2026-08-20T10:00:00.000Z",
    condition: "auto" as const,
    participant: "P-auto-summary",
    allocationMode: "study" as const,
    event: prompt,
  }

  expect(telemetry.recordServerEvent(envelope)).toMatchObject({
    created: true,
    event: {
      eventId: prompt.eventId,
      kind: "participant_prompt",
      surface: "auto_summary_chat",
      action: "submit",
      payload: expect.objectContaining({ content: prompt.content, clientEventId: prompt.eventId }),
    },
  })
  expect(telemetry.recordServerEvent(envelope)).toMatchObject({ created: false })
  expect(() => telemetry.recordServerEvent({
    ...envelope,
    event: { ...prompt, content: "Different content." },
  })).toThrow("reused with different evidence")

  const update = {
    type: "memory.control_request" as const,
    eventId: `control:auto-summary:${prompt.eventId}`,
    sessionId: "chat-1",
    via: "auto_summary_chat" as const,
    requestedAction: "update_memory" as const,
    causalRequestId: prompt.eventId,
    applied: 2,
  }
  expect(telemetry.recordServerEvent({ ...envelope, event: update })).toMatchObject({
    created: true,
    event: {
      eventId: update.eventId,
      kind: "control",
      payload: expect.objectContaining({ causalRequestId: prompt.eventId, applied: 2 }),
    },
  })
  expect(store.listStudyTelemetryEvents().map((event) => [event.eventId, event.kind])).toEqual([
    [prompt.eventId, "participant_prompt"],
    [update.eventId, "control"],
  ])
  store.close()
})

test("memory-update candidate matching handles direct wording and explicit negation", () => {
  expect(isExplicitMemoryUpdateRequest("Please remember that this project uses pnpm.")).toBe(true)
  expect(isExplicitMemoryUpdateRequest("请记住这个项目使用 pnpm。 ")).toBe(true)
  expect(isExplicitMemoryUpdateRequest("Do not remember this temporary workaround.")).toBe(false)
  expect(isExplicitMemoryUpdateRequest("不要记住这个临时 workaround。 ")).toBe(false)
  expect(isExplicitMemoryUpdateRequest("What do you remember about this project?")).toBe(false)
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
    surface: "summary_panel",
    action: "click",
    chatId: "chat-1",
    payload: { memoryIds: ["M-01"] },
  }
  const firstStore = new StudyMemoryStore(dbPath)
  new StudyTelemetryService({
    store: firstStore,
    participantId: "P-restart",
    condition: "auto",
    activeTask: () => ({ taskId: "038-S1", state: "open" }),
    now: () => "2026-08-20T10:00:00.000Z",
  }).recordClient(input)
  firstStore.close()

  const reopened = new StudyMemoryStore(dbPath)
  const retried = new StudyTelemetryService({
    store: reopened,
    participantId: "P-restart",
    condition: "auto",
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
    condition: "auto",
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
    surface: "summary_panel",
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
    condition: "auto",
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
      surface: "auto_summary_sidebar",
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
    surface: "auto_summary_sidebar",
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
    condition: "auto",
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
    condition: "auto",
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
    condition: "auto",
    activeTask: () => ({ taskId: "098-S1", state: "open" }),
    now: () => "2026-08-20T10:20:00.000Z",
  })
  telemetry.recordServerStageEntered("session_exposure", "098-S1")

  expect(() => telemetry.recordClient({
    eventId: "monitor:unbound-old",
    clientTimestamp: "2026-08-20T10:05:00.000Z",
    kind: "monitoring",
    surface: "summary_panel",
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
    condition: "auto",
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
    condition: "auto",
    participant: "P-late-logger",
    allocationMode: "study",
    event: {
      type: "ui.monitor",
      eventId: "monitor:late-logger-038",
      clientTimestamp: "2026-08-20T10:05:00.000Z",
      sessionId: "chat-038",
      chatId: "chat-038",
      surface: "summary_panel",
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
    condition: "static",
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
