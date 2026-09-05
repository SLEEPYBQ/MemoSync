import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TranscriptEntry } from "../shared/types"
import { resolveConditionPolicy } from "./experiment/condition"
import { MemoryService } from "./memory"
import { handleMemoryRequest } from "./memory/routes"
import { StudyRegistry } from "./study-registry"
import { createStudyWorkingMemoryEvidenceAdmission } from "./study-working-memory-evidence"

test("a delayed Working Memory toggle survives freeze and restart with its original task attribution", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memosync-working-memory-evidence-"))
  const attempted = new Set<string>()
  const events: Array<Record<string, unknown>> = []
  const memory = new MemoryService({
    dbPath: ":memory:",
    dataDir: dir,
    logger: {
      event: (event) => {
        events.push(event as unknown as Record<string, unknown>)
        if (event.type === "study.control_operation" && event.phase === "attempted") {
          const durableCreated = !attempted.has(event.operationId)
          attempted.add(event.operationId)
          return { durableCreated }
        }
        return { durableCreated: true }
      },
    },
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
    const lifecycle = {
      getTaskFreezeSnapshot: (taskId: string) => taskId === "038-S1"
        ? { snapshotId: "snapshot-1", frozenAt: "2026-08-20T10:00:03.000Z" }
        : null,
      getQuestionnaireSubmission: () => null,
      getSessionCompletion: (taskId: string) => taskId === "038-S1"
        ? { completedAt: "2026-08-20T10:10:00.000Z" }
        : null,
      getSusSubmission: () => null,
    }
    // Fresh registry + authority objects model a process restart after the
    // original task froze and the next serial task became active.
    const registry = new StudyRegistry(undefined, ["038-S1", "038-S2"], lifecycle)
    const chats = new Map([
      ["chat-038-s1", {
        provider: "claude" as const,
        projectId: "project-apartment",
        createdAt: Date.parse("2026-08-20T09:55:00.000Z"),
      }],
      ["chat-other", {
        provider: "claude" as const,
        projectId: "project-car",
        createdAt: Date.parse("2026-08-20T09:55:00.000Z"),
      }],
    ])
    const authority = createStudyWorkingMemoryEvidenceAdmission({
      policy: resolveConditionPolicy("memosync"),
      registry,
      store: {
        getChat: (chatId) => chats.get(chatId) ?? null,
        getMessages: (chatId) => chatId === "chat-038-s1" ? messages : [],
      },
      assignedProjects: new Map([
        ["apartment", { projectId: "project-apartment" }],
        ["car", { projectId: "project-car" }],
      ]),
      getPendingPreview: () => null,
      now: () => Date.parse("2026-08-20T10:11:00.000Z"),
    })!
    const body = {
      operationId: "control:working-memory:add:late",
      chatId: "chat-038-s1",
      previewId: "preview-1",
      memoryId: item.id,
      action: "add",
      clientTimestamp: "2026-08-20T10:00:01.000Z",
    }
    const request = (input: Record<string, unknown>) => {
      const req = new Request("http://localhost/api/memories/working-memory-selection", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      })
      return handleMemoryRequest(req, new URL(req.url), memory, resolveConditionPolicy("memosync"), {
        beginStudyMemoryMutation: () => null,
        studySessionAttribution: () => null,
        workingMemoryEvidenceAdmission: authority,
      } as never)
    }

    expect((await request(body))!.status).toBe(200)
    expect((await request(body))!.status).toBe(409)
    expect(events.filter((event) => event.type === "study.control_operation")).toEqual([
      expect.objectContaining({ taskId: "038-S1", sessionId: "038-S1", phase: "attempted" }),
      expect.objectContaining({ taskId: "038-S1", sessionId: "038-S1", phase: "completed" }),
      expect.objectContaining({ taskId: "038-S1", sessionId: "038-S1", phase: "attempted" }),
    ])
    expect(authority({
      chatId: "chat-038-s1",
      previewId: "preview-1",
      memoryId: item.id,
      clientTimestamp: "2026-08-20T10:00:04.000Z",
    })).toEqual(expect.objectContaining({ refusal: expect.any(String) }))
    const spoofedTaskAuthority = createStudyWorkingMemoryEvidenceAdmission({
      policy: resolveConditionPolicy("memosync"),
      registry,
      store: {
        getChat: (chatId) => chats.get(chatId) ?? null,
        getMessages: () => [{ ...messages[0]!, taskId: "038-S2" }, messages[1]] as never,
      },
      assignedProjects: new Map([["apartment", { projectId: "project-apartment" }]]),
      getPendingPreview: () => null,
      now: () => Date.parse("2026-08-20T10:11:00.000Z"),
    })!
    expect(spoofedTaskAuthority({
      chatId: "chat-038-s1",
      previewId: "preview-1",
      memoryId: item.id,
      clientTimestamp: "2026-08-20T10:00:01.000Z",
    })).toEqual(expect.objectContaining({ refusal: expect.any(String) }))
    expect(authority({
      chatId: "chat-other",
      previewId: "preview-1",
      memoryId: item.id,
      clientTimestamp: "2026-08-20T10:00:01.000Z",
    })).toEqual(expect.objectContaining({ refusal: expect.any(String) }))
  } finally {
    memory.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
