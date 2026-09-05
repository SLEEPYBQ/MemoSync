import { expect, test } from "bun:test"
import {
  createStudyTelemetryOutbox,
  enqueueStudyTelemetry,
  initializeStudyTelemetryOutbox,
  prepareStudyTelemetryOutbox,
  startStudyTelemetryBootstrap,
  stopStudyTelemetryOutbox,
} from "./studyTelemetry"
import { StudyMemoryStore } from "../../../server/experiment/study-memory-store"
import { StudyTelemetryService } from "../../../server/study-telemetry"

class MemoryStorage implements Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  get length(): number {
    return this.values.size
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }
}

test("an offline event survives outbox recreation and retries with the same event id", async () => {
  const storage = new MemoryStorage()
  const request = {
    eventId: "monitor:stable-1",
    endpoint: "/api/memories/ui-monitor",
    body: {
      eventId: "monitor:stable-1",
      clientTimestamp: "2026-08-20T10:00:00.000Z",
      surface: "board",
      interaction: "scroll",
    },
  }
  const offline = createStudyTelemetryOutbox({
    storage,
    storageKey: "scope-a",
    fetcher: async () => { throw new TypeError("offline") },
    now: () => Date.parse("2026-08-20T10:00:00.000Z"),
  })

  await offline.enqueue(request)
  expect(storage.getItem("scope-a")).toContain("monitor:stable-1")

  const sent: Array<{ endpoint: string; body: Record<string, unknown> }> = []
  const reloaded = createStudyTelemetryOutbox({
    storage,
    storageKey: "scope-a",
    fetcher: async (input, init) => {
      sent.push({
        endpoint: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      })
      return new Response(null, { status: 204 })
    },
    now: () => Date.parse("2026-08-20T10:01:00.000Z"),
  })

  await reloaded.start()

  expect(sent).toEqual([{ endpoint: request.endpoint, body: request.body }])
  expect(storage.getItem("scope-a")).toBeNull()
})

test("two events keep enqueue order and a repeated event id is stored once", async () => {
  const storage = new MemoryStorage()
  let online = false
  const sent: string[] = []
  const outbox = createStudyTelemetryOutbox({
    storage,
    storageKey: "scope-b",
    fetcher: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { eventId: string }
      if (!online) return new Response(null, { status: 503 })
      sent.push(body.eventId)
      return Response.json({ data: { recorded: true } })
    },
    now: () => Date.parse("2026-08-20T10:00:00.000Z"),
  })
  const first = {
    eventId: "static-edit:1",
    endpoint: "/api/study/telemetry",
    body: { eventId: "static-edit:1", kind: "control", surface: "static_memory", action: "edit_entered" },
  }
  const second = {
    eventId: "monitor:2",
    endpoint: "/api/memories/ui-monitor",
    body: { eventId: "monitor:2", surface: "board", interaction: "open" },
  }

  await outbox.enqueue(first)
  await outbox.enqueue(first)
  await outbox.enqueue(second)
  expect(JSON.parse(storage.getItem("scope-b")!)).toHaveLength(2)

  online = true
  await outbox.flush()

  expect(sent).toEqual(["static-edit:1", "monitor:2"])
  expect(storage.getItem("scope-b")).toBeNull()
})

test("an online event retries the persisted queue without another interaction", async () => {
  const storage = new MemoryStorage()
  const onlineTarget = new EventTarget()
  let online = false
  let delivered = 0
  const outbox = createStudyTelemetryOutbox({
    storage,
    storageKey: "scope-online",
    onlineTarget,
    fetcher: async () => {
      if (!online) throw new TypeError("offline")
      delivered += 1
      return new Response(null, { status: 204 })
    },
  })

  await outbox.start()
  await outbox.enqueue({
    eventId: "monitor:online-1",
    endpoint: "/api/memories/ui-monitor",
    body: { eventId: "monitor:online-1", surface: "board", interaction: "hover" },
  })
  expect(storage.getItem("scope-online")).not.toBeNull()

  online = true
  onlineTarget.dispatchEvent(new Event("online"))
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(delivered).toBe(1)
  expect(storage.getItem("scope-online")).toBeNull()
  outbox.stop()
})

test("a retryable 409 keeps the same event in the durable outbox until it is accepted", async () => {
  const storage = new MemoryStorage()
  const delivered: string[] = []
  let attempts = 0
  const outbox = createStudyTelemetryOutbox({
    storage,
    storageKey: "scope-conflict",
    fetcher: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { eventId: string }
      delivered.push(body.eventId)
      attempts += 1
      return attempts === 1
        ? Response.json({ error: "session transition in progress" }, { status: 409 })
        : new Response(null, { status: 204 })
    },
  })

  await outbox.enqueue({
    eventId: "monitor:retry-409",
    endpoint: "/api/study/telemetry",
    body: {
      eventId: "monitor:retry-409",
      kind: "monitoring",
      surface: "board",
      action: "scroll",
    },
  })

  expect(storage.getItem("scope-conflict")).toContain("monitor:retry-409")
  await outbox.flush()

  expect(delivered).toEqual(["monitor:retry-409", "monitor:retry-409"])
  expect(storage.getItem("scope-conflict")).toBeNull()
})

test("a duplicate-operation 409 acknowledges a response-lost telemetry delivery and continues the queue", async () => {
  const storage = new MemoryStorage()
  const delivered: string[] = []
  let workingMemoryAttempts = 0
  const outbox = createStudyTelemetryOutbox({
    storage,
    storageKey: "scope-duplicate-operation",
    fetcher: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { eventId: string }
      delivered.push(body.eventId)
      if (body.eventId === "working-memory:response-lost") {
        workingMemoryAttempts += 1
        if (workingMemoryAttempts === 1) throw new TypeError("response lost after commit")
        return Response.json({
          error: { code: "OPERATION_ALREADY_RECORDED" },
        }, { status: 409 })
      }
      return new Response(null, { status: 204 })
    },
  })

  await outbox.enqueue({
    eventId: "working-memory:response-lost",
    endpoint: "/api/memories/working-memory-selection",
    body: { eventId: "working-memory:response-lost", operationId: "toggle-1" },
  })
  await outbox.enqueue({
    eventId: "monitor:after-duplicate",
    endpoint: "/api/memories/ui-monitor",
    body: { eventId: "monitor:after-duplicate", surface: "board", interaction: "scroll" },
  })

  expect(delivered).toEqual([
    "working-memory:response-lost",
    "working-memory:response-lost",
    "monitor:after-duplicate",
  ])
  expect(storage.getItem("scope-duplicate-operation")).toBeNull()
})

test("the outbox bounds retained events and removes expired entries before retry", async () => {
  const storage = new MemoryStorage()
  let now = 0
  let online = false
  let delivered = 0
  const outbox = createStudyTelemetryOutbox({
    storage,
    storageKey: "scope-bounded",
    maxItems: 2,
    ttlMs: 1_000,
    now: () => now,
    fetcher: async () => {
      if (!online) throw new TypeError("offline")
      delivered += 1
      return new Response(null, { status: 204 })
    },
  })
  const enqueue = (eventId: string) => outbox.enqueue({
    eventId,
    endpoint: "/api/memories/ui-monitor",
    body: { eventId, surface: "board", interaction: "scroll" },
  })

  await enqueue("monitor:oldest")
  now = 1
  await enqueue("monitor:middle")
  now = 2
  await enqueue("monitor:newest")
  expect((JSON.parse(storage.getItem("scope-bounded")!) as Array<{ eventId: string }>)
    .map((entry) => entry.eventId)).toEqual(["monitor:middle", "monitor:newest"])

  now = 2_000
  online = true
  await outbox.flush()

  expect(delivered).toBe(0)
  expect(storage.getItem("scope-bounded")).toBeNull()
})

test("a new participant resets old origin queues while conditions keep separate local scopes", async () => {
  const storage = new MemoryStorage()
  storage.setItem("memosync:study-telemetry-scope:v1:auto", "old-auto")
  storage.setItem("memosync:study-telemetry-outbox:v1:auto:old-auto", JSON.stringify([{
    eventId: "monitor:old-participant",
    endpoint: "/api/memories/ui-monitor",
    body: { eventId: "monitor:old-participant" },
    enqueuedAt: Date.now(),
  }]))
  prepareStudyTelemetryOutbox(storage)
  enqueueStudyTelemetry({
    eventId: "surface-exposure:old-pending:0",
    endpoint: "/api/study/telemetry",
    body: { eventId: "surface-exposure:old-pending:0" },
  })
  const delivered: string[] = []

  await initializeStudyTelemetryOutbox({
    condition: "memosync",
    resetForNewParticipant: true,
    storage,
    onlineTarget: null,
    randomId: () => "participant-scope",
    fetcher: async (_input, init) => {
      delivered.push((JSON.parse(String(init?.body)) as { eventId: string }).eventId)
      return new Response(null, { status: 204 })
    },
  })
  expect(storage.getItem("memosync:study-telemetry-scope:v1:auto")).toBeNull()
  expect(storage.getItem("memosync:study-telemetry-outbox:v1:auto:old-auto")).toBeNull()
  expect(storage.getItem("memosync:study-telemetry-pending:v1")).toBeNull()
  expect(storage.getItem("memosync:study-telemetry-scope:v1:memosync")).toBe("participant-scope")
  expect(delivered).toEqual([])

  await initializeStudyTelemetryOutbox({
    condition: "auto",
    resetForNewParticipant: false,
    storage,
    onlineTarget: null,
    randomId: () => "auto-scope",
    fetcher: async () => new Response(null, { status: 204 }),
  })
  expect(storage.getItem("memosync:study-telemetry-scope:v1:memosync")).toBe("participant-scope")
  expect(storage.getItem("memosync:study-telemetry-scope:v1:auto")).toBe("auto-scope")
  stopStudyTelemetryOutbox()
})

test("a bootstrap failure durably buffers UI evidence and online retry records its original event once", async () => {
  stopStudyTelemetryOutbox()
  const storage = new MemoryStorage()
  const onlineTarget = new EventTarget()
  const store = new StudyMemoryStore(":memory:")
  const telemetry = new StudyTelemetryService({
    store,
    participantId: "P-bootstrap-retry",
    condition: "auto",
    activeTask: () => ({ taskId: "038-S1", state: "open" }),
  })
  telemetry.recordServerStageEntered("session_exposure", "038-S1")
  telemetry.recordParticipantPrompt({
    taskId: "038-S1",
    turnId: "turn-1",
    chatId: "chat-bootstrap",
    content: "Implement the task.",
    attachments: [],
  })
  let loads = 0
  let signalFirstFailure!: () => void
  const firstFailure = new Promise<void>((resolve) => { signalFirstFailure = resolve })
  const bootstrap = startStudyTelemetryBootstrap({
    condition: "auto",
    storage,
    onlineTarget,
    retryDelayMs: () => 60_000,
    loadOnboarding: async () => {
      loads += 1
      if (loads === 1) {
        signalFirstFailure()
        throw new TypeError("temporary onboarding failure")
      }
      return { stage: "briefing" }
    },
    fetcher: async (_input, init) => {
      telemetry.recordClient(JSON.parse(String(init?.body)))
      return new Response(null, { status: 204 })
    },
    randomId: () => "bootstrap-scope",
  })

  await firstFailure
  enqueueStudyTelemetry({
    eventId: "surface-exposure:bootstrap-buffered:0",
    endpoint: "/api/study/telemetry",
    body: {
      eventId: "surface-exposure:bootstrap-buffered:0",
      clientTimestamp: "2026-08-20T10:00:00.000Z",
      kind: "surface_exposure",
      surface: "auto_summary_sidebar",
      action: "opened",
      chatId: "chat-bootstrap",
      payload: { exposureId: "bootstrap-buffered", sequence: 0, initiator: "system" },
    },
  })
  expect(storage.getItem("memosync:study-telemetry-pending:v1"))
    .toContain("surface-exposure:bootstrap-buffered:0")

  onlineTarget.dispatchEvent(new Event("online"))
  expect(await bootstrap.ready).toBe("ready")
  expect(loads).toBe(2)
  expect(store.listStudyTelemetryEvents().filter((event) => event.eventId === "surface-exposure:bootstrap-buffered:0"))
    .toHaveLength(1)
  expect(storage.getItem("memosync:study-telemetry-pending:v1")).toBeNull()
  bootstrap.stop()
  store.close()
})

test("a pre-scope event survives module stop and migrates after reload without changing its id", async () => {
  stopStudyTelemetryOutbox()
  const storage = new MemoryStorage()
  prepareStudyTelemetryOutbox(storage)
  enqueueStudyTelemetry({
    eventId: "monitor:pre-scope-reload",
    endpoint: "/api/memories/ui-monitor",
    body: { eventId: "monitor:pre-scope-reload", surface: "summary_panel", interaction: "click" },
  })
  stopStudyTelemetryOutbox()
  expect(storage.getItem("memosync:study-telemetry-pending:v1")).toContain("monitor:pre-scope-reload")

  const delivered: string[] = []
  await initializeStudyTelemetryOutbox({
    condition: "auto",
    resetForNewParticipant: false,
    storage,
    onlineTarget: null,
    randomId: () => "reloaded-scope",
    fetcher: async (_input, init) => {
      delivered.push((JSON.parse(String(init?.body)) as { eventId: string }).eventId)
      return new Response(null, { status: 204 })
    },
  })

  expect(delivered).toEqual(["monitor:pre-scope-reload"])
  expect(storage.getItem("memosync:study-telemetry-pending:v1")).toBeNull()
  stopStudyTelemetryOutbox()
})
