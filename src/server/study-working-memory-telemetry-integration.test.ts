import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptEntry } from "../shared/types";
import { ExperimentLogger } from "./experiment/logger";
import { StudyMemoryStore } from "./experiment/study-memory-store";
import { resolveConditionPolicy } from "./experiment/condition";
import { MemoryService } from "./memory";
import { handleMemoryRequest } from "./memory/routes";
import { StudyRegistry } from "./study-registry";

import { StudyTelemetryService } from "./study-telemetry";
import { createStudyWorkingMemoryEvidenceAdmission } from "./study-working-memory-evidence";

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
