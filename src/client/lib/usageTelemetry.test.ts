import { expect, test } from "bun:test";
import { createUsageTelemetryOutbox, initializeUsageTelemetryOutbox, stopUsageTelemetryOutbox } from "./usageTelemetry"

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
  const offline = createUsageTelemetryOutbox({
    storage,
    storageKey: "scope-a",
    fetcher: async () => { throw new TypeError("offline") },
    now: () => Date.parse("2026-08-20T10:00:00.000Z"),
  })

  await offline.enqueue(request)
  expect(storage.getItem("scope-a")).toContain("monitor:stable-1")

  const sent: Array<{ endpoint: string; body: Record<string, unknown> }> = []
  const reloaded = createUsageTelemetryOutbox({
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
  const outbox = createUsageTelemetryOutbox({
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
    eventId: "monitor:1",
    endpoint: "/api/memories/ui-monitor",
    body: { eventId: "monitor:1", surface: "board", interaction: "click" },
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

  expect(sent).toEqual(["monitor:1", "monitor:2"])
  expect(storage.getItem("scope-b")).toBeNull()
})

test("an online event retries the persisted queue without another interaction", async () => {
  const storage = new MemoryStorage()
  const onlineTarget = new EventTarget()
  let online = false
  let delivered = 0
  const outbox = createUsageTelemetryOutbox({
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
  const outbox = createUsageTelemetryOutbox({
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
    endpoint: "/api/memories/ui-monitor",
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
  const outbox = createUsageTelemetryOutbox({
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
  const outbox = createUsageTelemetryOutbox({
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

test("product initialization ignores outboxes written by older versions and preserves their data", async () => {
  const storage = new MemoryStorage()
  // Preserve the stored key, event ID and endpoint written by older versions.
  const legacyKey = "memosync:study-telemetry-outbox:v1:memosync:legacy"
  const legacy = JSON.stringify([{ eventId: "old-study", endpoint: "/api/study/telemetry", body: { taskId: "old-task" }, enqueuedAt: Date.now() }])
  storage.setItem(legacyKey, legacy)
  storage.setItem("memosync:usage-outbox:v1", JSON.stringify([{ eventId: "product", endpoint: "/api/memories/ui-monitor", body: { eventId: "product", surface: "board" }, enqueuedAt: Date.now() }]))
  const sent: string[] = []
  await initializeUsageTelemetryOutbox({ storage, onlineTarget: null, fetcher: async (endpoint) => {
    sent.push(endpoint)
    return new Response(null, { status: 204 })
  } })
  stopUsageTelemetryOutbox()
  expect(sent).toEqual(["/api/memories/ui-monitor"])
  expect(storage.getItem(legacyKey)).toBe(legacy)
  expect(storage.getItem("memosync:usage-outbox:v1")).toBeNull()
})
