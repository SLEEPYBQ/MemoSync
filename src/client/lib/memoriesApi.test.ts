import { expect, test } from "bun:test"
import { initializeStudyTelemetryOutbox, stopStudyTelemetryOutbox } from "../app/study/studyTelemetry"
import {
  memoriesApi,
  recordStaticMemoryEditEntered,
  recordUiMonitor,
  recordWorkingMemorySelection,
  setUiMonitorSuppressed,
} from "./memoriesApi"

class MemoryStorage {
  private readonly values = new Map<string, string>()
  get length(): number { return this.values.size }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
}

test("Candidate Undo sends its control surface and chat provenance to the server", async () => {
  const originalFetch = globalThis.fetch
  let body: unknown
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body))
    return Response.json({
      data: {
        reverted: { id: "M-07", status: "candidate" },
        restored: null,
      },
    })
  }) as typeof fetch

  try {
    await memoriesApi.revertAutoAccept("M-07", {
      sessionId: "chat-038-s1",
      surface: "board",
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  expect(body).toEqual({
    sessionId: "chat-038-s1",
    surface: "board",
    operationId: expect.stringMatching(/^control:crud-revert-auto:M-07:/),
  })
})

test("Audit Enforce sends one stable operation id with the participant action", async () => {
  const originalFetch = globalThis.fetch
  let body: Record<string, unknown> | null = null
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>
    return Response.json({ data: { queued: "M-02" } })
  }) as typeof fetch

  try {
    await memoriesApi.enforce("M-02", "chat-038-s1", "The memory was ignored.")
  } finally {
    globalThis.fetch = originalFetch
  }

  expect(body).toEqual({
    id: "M-02",
    sessionId: "chat-038-s1",
    quote: "The memory was ignored.",
    operationId: expect.stringMatching(/^control:audit-enforce:M-02:/),
  })
})

test("Audit Draft a fix sends one stable operation id with the participant action", async () => {
  const originalFetch = globalThis.fetch
  let body: Record<string, unknown> | null = null
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>
    return Response.json({ data: { id: "M-09", status: "candidate" } })
  }) as typeof fetch

  try {
    await memoriesApi.draftRevision("M-02", "chat-038-s1")
  } finally {
    globalThis.fetch = originalFetch
  }

  expect(body).toEqual({
    sessionId: "chat-038-s1",
    operationId: expect.stringMatching(/^control:audit-draft-fix:M-02:/),
  })
})

test("Working Memory Ask sends one stable operation id with the participant instruction", async () => {
  const originalFetch = globalThis.fetch
  let body: Record<string, unknown> | null = null
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>
    return Response.json({ data: { selectedIds: ["M-02"], reply: "Kept it." } })
  }) as typeof fetch

  try {
    await memoriesApi.reviseInjection(
      "Keep this one",
      ["M-02"],
      ["M-02", "M-03"],
      "chat-038-s1",
      "preview-1",
    )
  } finally {
    globalThis.fetch = originalFetch
  }

  expect(body).toEqual({
    instruction: "Keep this one",
    selectedIds: ["M-02"],
    poolIds: ["M-02", "M-03"],
    sessionId: "chat-038-s1",
    previewId: "preview-1",
    operationId: expect.stringMatching(/^control:working-memory-ask:/),
  })
})

test("Working Memory use planning binds the request to its chat and preview", async () => {
  const originalFetch = globalThis.fetch
  let body: Record<string, unknown> | null = null
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>
    return Response.json({
      data: [{ id: "M-02", expectedUse: "Apply the saved preference." }],
    })
  }) as typeof fetch

  try {
    await memoriesApi.planInjectionUses(
      "Update dependencies",
      ["M-02"],
      { sessionId: "chat-038-s1", previewId: "preview-1" },
    )
  } finally {
    globalThis.fetch = originalFetch
  }

  expect(body).toEqual({
    task: "Update dependencies",
    selectedIds: ["M-02"],
    sessionId: "chat-038-s1",
    previewId: "preview-1",
  })
})

test("Monitoring and Static edit entry use the scoped durable telemetry outbox", async () => {
  const delivered: Array<{ endpoint: string; body: Record<string, unknown> }> = []
  await initializeStudyTelemetryOutbox({
    condition: "static",
    resetForNewParticipant: true,
    storage: new MemoryStorage(),
    onlineTarget: null,
    randomId: () => "participant-scope",
    fetcher: async (input, init) => {
      delivered.push({
        endpoint: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      })
      return new Response(null, { status: 204 })
    },
  })

  recordUiMonitor("static_memory_panel", { sessionId: "chat-1", interaction: "scroll" })
  recordStaticMemoryEditEntered("control:static-edit:1", "chat-1", "MEMORY.md")
  recordStaticMemoryEditEntered("control:ordinary-file:1", "chat-1", "src/app.ts")
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(delivered).toEqual([
    {
      endpoint: "/api/memories/ui-monitor",
      body: {
        eventId: expect.stringMatching(/^monitor:/),
        clientTimestamp: expect.any(String),
        surface: "static_memory_panel",
        sessionId: "chat-1",
        interaction: "scroll",
      },
    },
    {
      endpoint: "/api/study/static-edit-entered",
      body: {
        operationId: "control:static-edit:1",
        clientTimestamp: expect.any(String),
        chatId: "chat-1",
        path: "MEMORY.md",
      },
    },
  ])
  stopStudyTelemetryOutbox()
})

test("Working Memory Add and Remove enqueue distinct semantic operation ids", async () => {
  const delivered: Array<{ endpoint: string; body: Record<string, unknown> }> = []
  await initializeStudyTelemetryOutbox({
    condition: "memosync",
    resetForNewParticipant: true,
    storage: new MemoryStorage(),
    onlineTarget: null,
    randomId: () => "participant-scope",
    fetcher: async (input, init) => {
      delivered.push({
        endpoint: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      })
      return Response.json({ data: { observed: true } })
    },
  })

  recordWorkingMemorySelection({ chatId: "chat-1", previewId: "preview-1", memoryId: "M-02", action: "add" })
  recordWorkingMemorySelection({ chatId: "chat-1", previewId: "preview-1", memoryId: "M-02", action: "remove" })
  setUiMonitorSuppressed(true)
  recordWorkingMemorySelection({ chatId: "guide-chat", previewId: "guide-preview", memoryId: "M-02", action: "add" })
  setUiMonitorSuppressed(false)
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(delivered).toHaveLength(2)
  expect(delivered.map(({ endpoint, body }) => ({ endpoint, ...body }))).toEqual([
    {
      endpoint: "/api/memories/working-memory-selection",
      operationId: expect.stringMatching(/^control:working-memory-selection:add:M-02:/),
      clientTimestamp: expect.any(String),
      chatId: "chat-1",
      previewId: "preview-1",
      memoryId: "M-02",
      action: "add",
    },
    {
      endpoint: "/api/memories/working-memory-selection",
      operationId: expect.stringMatching(/^control:working-memory-selection:remove:M-02:/),
      clientTimestamp: expect.any(String),
      chatId: "chat-1",
      previewId: "preview-1",
      memoryId: "M-02",
      action: "remove",
    },
  ])
  expect(delivered[0]!.body.operationId).not.toBe(delivered[1]!.body.operationId)
  stopStudyTelemetryOutbox()
})
