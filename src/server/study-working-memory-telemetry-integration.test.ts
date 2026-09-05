import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TranscriptEntry } from "../shared/types"
import { ExperimentLogger } from "./experiment/logger"
import { StudyMemoryStore } from "./experiment/study-memory-store"
import { resolveConditionPolicy } from "./experiment/condition"
import { MemoryService } from "./memory"
import { handleMemoryRequest } from "./memory/routes"
import { StudyRegistry } from "./study-registry"
import { handleStudyRequest } from "./study-routes"
import { StudyTelemetryService } from "./study-telemetry"
import { createStudyWorkingMemoryEvidenceAdmission } from "./study-working-memory-evidence"

test("a delayed Working Memory toggle reaches real SQLite after freeze and restart with its original task", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memosync-late-toggle-telemetry-"))
  const studyDbPath = join(dir, "study.sqlite")
  let studyStore = new StudyMemoryStore(studyDbPath)
  try {
    let now = "2026-08-20T10:00:00.000Z"
    const initialTelemetry = new StudyTelemetryService({
      store: studyStore,
      participantId: "P-late-toggle",
      condition: "memosync",
      activeTask: () => ({ taskId: "038-S1", state: "open" }),
      now: () => now,
    })
    initialTelemetry.recordServerStageEntered("session_exposure", "038-S1")
    initialTelemetry.recordParticipantPrompt({
      taskId: "038-S1",
      turnId: "turn-1",
      chatId: "chat-038-s1",
      content: "Update the cart.",
      attachments: [],
      acceptedAt: "2026-08-20T10:00:00.000Z",
    })
    studyStore.createFreezeSnapshot({
      snapshotId: "freeze-038-s1",
      taskId: "038-S1",
      frozenAt: "2026-08-20T10:00:03.000Z",
    })
    studyStore.close()

    // Process restart: every sink/registry/logger object is reconstructed over
    // the same SQLite file while the next serial task is already open.
    studyStore = new StudyMemoryStore(studyDbPath)
    now = "2026-08-20T10:20:00.000Z"
    const telemetry = new StudyTelemetryService({
      store: studyStore,
      participantId: "P-late-toggle",
      condition: "memosync",
      activeTask: () => ({ taskId: "038-S2", state: "open" }),
      now: () => now,
    })
    telemetry.recordServerStageEntered("session_exposure", "038-S2")
    const logger = new ExperimentLogger({
      condition: "memosync",
      participant: "P-late-toggle",
      allocationMode: "study",
      stdout: false,
      durableSink: (input) => telemetry.recordServerEvent(input),
    })
    const memory = new MemoryService({
      dbPath: ":memory:",
      dataDir: join(dir, "memory"),
      logger,
    })
    try {
      const item = memory.store.create(
        { content: "Use pnpm", scope: "project", projectId: "project-apartment", type: "preference" },
        { actor: "user" },
      )
      const messages: TranscriptEntry[] = [
        {
          _id: "preview-entry",
          kind: "memory_preview",
          previewId: "preview-1",
          taskId: "038-S1",
          createdAt: Date.parse("2026-08-20T10:00:00.000Z"),
          memories: [{ id: item.id, content: item.content, scope: item.scope }],
        },
        {
          _id: "preview-decision",
          kind: "memory_preview_decision",
          previewId: "preview-1",
          createdAt: Date.parse("2026-08-20T10:00:02.000Z"),
          decision: "go_on",
        },
      ]
      const registry = new StudyRegistry(undefined, ["038-S1", "038-S2"], studyStore)
      const evidenceAdmission = createStudyWorkingMemoryEvidenceAdmission({
        policy: resolveConditionPolicy("memosync"),
        registry,
        store: {
          getChat: (chatId) => chatId === "chat-038-s1"
            ? {
                provider: "claude",
                projectId: "project-apartment",
                createdAt: Date.parse("2026-08-20T09:55:00.000Z"),
              }
            : null,
          getMessages: (chatId) => chatId === "chat-038-s1" ? messages : [],
        },
        assignedProjects: new Map([["apartment", { projectId: "project-apartment" }]]),
        getPendingPreview: () => null,
        now: () => Date.parse(now),
      })!
      const body = {
        operationId: "control:working-memory-selection:add:M-01:late-real-sink",
        chatId: "chat-038-s1",
        previewId: "preview-1",
        memoryId: item.id,
        action: "add",
        clientTimestamp: "2026-08-20T10:00:01.000Z",
      }
      const request = new Request("http://localhost/api/memories/working-memory-selection", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      const response = await handleMemoryRequest(
        request,
        new URL(request.url),
        memory,
        resolveConditionPolicy("memosync"),
        {
          studySessionAttribution: () => ({ taskId: "038-S2", sessionId: "038-S2" }),
          workingMemoryEvidenceAdmission: evidenceAdmission,
        },
      )

      expect(response!.status).toBe(200)
      expect(studyStore.listStudyTelemetryEvents().filter((event) => (
        event.payload.operationId === body.operationId
      ))).toEqual([
        expect.objectContaining({
          taskId: "038-S1",
          sessionId: "038-S1",
          chatId: body.chatId,
          clientTimestamp: body.clientTimestamp,
          surface: "working_memory",
          action: "add",
          payload: expect.objectContaining({ outcome: "attempted" }),
        }),
        expect.objectContaining({
          taskId: "038-S1",
          sessionId: "038-S1",
          chatId: body.chatId,
          clientTimestamp: body.clientTimestamp,
          surface: "working_memory",
          action: "add",
          payload: expect.objectContaining({ outcome: "completed" }),
        }),
      ])
    } finally {
      memory.close()
    }
  } finally {
    studyStore.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a delayed Static edit entry survives freeze, restart, and response-loss replay without duplicating completion", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memosync-late-static-entry-"))
  const studyDbPath = join(dir, "study.sqlite")
  let studyStore = new StudyMemoryStore(studyDbPath)
  try {
    let now = "2026-08-20T10:00:00.000Z"
    let active = { taskId: "038-S1", state: "open" as const }
    const initialTelemetry = new StudyTelemetryService({
      store: studyStore,
      participantId: "P-late-static",
      condition: "static",
      activeTask: () => active,
      now: () => now,
    })
    initialTelemetry.recordServerStageEntered("session_exposure", "038-S1")
    initialTelemetry.recordParticipantPrompt({
      taskId: "038-S1",
      turnId: "turn-1",
      chatId: "chat-static-038",
      content: "Update the saved memory.",
      attachments: [],
      acceptedAt: "2026-08-20T10:00:00.000Z",
    })
    const operation = {
      type: "study.control_operation" as const,
      operationId: "control:static-edit:late-real-route",
      taskId: "038-S1",
      sessionId: "038-S1",
      chatId: "chat-static-038",
      surface: "static_memory" as const,
      action: "edit",
      controlType: "static_edit" as const,
      payload: { projectId: "project-038", path: "MEMORY.md", durationMs: 30_000 },
    }
    for (const [recordedAt, phase] of [
      ["2026-08-20T10:02:00.000Z", "attempted"],
      ["2026-08-20T10:03:00.000Z", "completed"],
    ] as const) {
      initialTelemetry.recordServerEvent({
        recordedAt,
        condition: "static",
        participant: "P-late-static",
        allocationMode: "study",
        event: { ...operation, phase },
      })
    }
    studyStore.createFreezeSnapshot({
      snapshotId: "freeze-static-038",
      taskId: "038-S1",
      frozenAt: "2026-08-20T10:10:00.000Z",
    })
    studyStore.close()

    studyStore = new StudyMemoryStore(studyDbPath)
    active = { taskId: "038-S2", state: "open" }
    now = "2026-08-20T10:20:00.000Z"
    const telemetry = new StudyTelemetryService({
      store: studyStore,
      participantId: "P-late-static",
      condition: "static",
      activeTask: () => active,
      now: () => now,
    })
    telemetry.recordServerStageEntered("session_exposure", "038-S2")
    const registry = new StudyRegistry(undefined, ["038-S1", "038-S2"], studyStore)
    const body = {
      operationId: operation.operationId,
      chatId: "chat-static-038",
      clientTimestamp: "2026-08-20T10:01:00.000Z",
      path: "MEMORY.md",
    }
    const call = (input: Record<string, unknown>) => {
      const request = new Request("http://localhost/api/study/static-edit-entered", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      })
      return handleStudyRequest(request, new URL(request.url), {
        registry,
        questionnaire: null,
        survey: null,
        onboarding: null,
        telemetry,
      })
    }

    expect((await call(body))!.status).toBe(200)
    // A lost HTTP response replays the exact outbox row; the server ACKs the
    // existing entry without creating a second edit completion.
    expect((await call(body))!.status).toBe(200)
    expect((await call({
      ...body,
      operationId: "control:static-edit:post-window",
      clientTimestamp: "2026-08-20T10:15:00.000Z",
    }))!.status).toBe(422)
    expect((await call({
      ...body,
      operationId: "control:static-edit:other-chat",
      chatId: "chat-unbound",
    }))!.status).toBe(200)
    expect((await call({
      ...body,
      operationId: "control:static-edit:ordinary-file",
      path: "src/app.ts",
    }))!.status).toBe(422)

    const telemetryRows = studyStore.listStudyTelemetryEvents()
    expect(telemetryRows.filter((event) => event.eventId === `${body.operationId}:entered`)).toHaveLength(1)
    expect(telemetryRows.filter((event) => (
      event.payload.operationId === body.operationId && event.payload.outcome === "completed"
    ))).toHaveLength(1)
    expect(telemetryRows.find((event) => event.eventId === `${body.operationId}:entered`)).toMatchObject({
      taskId: "038-S1",
      sessionId: "038-S1",
      chatId: body.chatId,
      clientTimestamp: body.clientTimestamp,
    })
    expect(telemetryRows.find((event) => event.eventId === "control:static-edit:other-chat:entered")).toMatchObject({
      taskId: "038-S2",
      sessionId: "038-S2",
      chatId: "chat-unbound",
    })
  } finally {
    studyStore.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a Static entry-first route receipt constrains the later durable operation identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memosync-static-entry-first-"))
  const studyDbPath = join(dir, "study.sqlite")
  const studyStore = new StudyMemoryStore(studyDbPath)
  try {
    const telemetry = new StudyTelemetryService({
      store: studyStore,
      participantId: "P-static-entry-first",
      condition: "static",
      activeTask: () => ({ taskId: "038-S1", state: "open" }),
      now: () => "2026-08-20T10:00:00.000Z",
    })
    const registry = new StudyRegistry(undefined, ["038-S1"], studyStore)
    const operationId = "control:static-edit:entry-first-real-route"
    const request = new Request("http://localhost/api/study/static-edit-entered", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operationId,
        chatId: "chat-static-entry-first",
        clientTimestamp: "2026-08-20T09:45:00.000Z",
        path: "MEMORY.md",
      }),
    })
    const response = await handleStudyRequest(request, new URL(request.url), {
      registry,
      questionnaire: null,
      survey: null,
      onboarding: null,
      telemetry,
    })
    expect(response!.status).toBe(200)

    const envelope = {
      recordedAt: "2026-08-20T10:00:01.000Z",
      condition: "static" as const,
      participant: "P-static-entry-first",
      allocationMode: "study" as const,
    }
    const operation = {
      type: "study.control_operation" as const,
      operationId,
      phase: "attempted" as const,
      taskId: "038-S1",
      sessionId: "038-S1",
      chatId: "chat-static-entry-first",
      surface: "static_memory" as const,
      action: "edit",
      controlType: "static_edit" as const,
      payload: { projectId: "project-038", path: "MEMORY.md", durationMs: 5_000 },
    }
    expect(telemetry.recordServerEvent({ ...envelope, event: operation })).toMatchObject({
      created: true,
      event: { taskId: "038-S1", chatId: "chat-static-entry-first" },
    })

    const changedOperationId = "control:static-edit:entry-first-changed-path"
    const changedRequest = new Request("http://localhost/api/study/static-edit-entered", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operationId: changedOperationId,
        chatId: "chat-static-entry-first",
        clientTimestamp: "2026-08-20T09:45:00.000Z",
        path: "MEMORY.md",
      }),
    })
    expect((await handleStudyRequest(changedRequest, new URL(changedRequest.url), {
      registry,
      questionnaire: null,
      survey: null,
      onboarding: null,
      telemetry,
    }))!.status).toBe(200)
    expect(() => telemetry.recordServerEvent({
      ...envelope,
      event: {
        ...operation,
        operationId: changedOperationId,
        payload: { ...operation.payload, path: "memory/other.md" },
      },
    })).toThrow("conflicts with its durable entry evidence")
    expect(studyStore.getStudyTelemetryEvent(`control-operation:${changedOperationId}:attempted`)).toBeNull()
  } finally {
    studyStore.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
