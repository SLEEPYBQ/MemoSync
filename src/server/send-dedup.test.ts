import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PROTOCOL_VERSION, type MemoryPreviewSettings, type TranscriptEntry } from "../shared/types"
import type { RuntimeCommand } from "../shared/runtime-commands"
import type { HarnessEvent, HarnessTurn } from "./harness-types"
import { AgentCoordinator } from "./agent"
import { discovery, type NativeCommandRuntime } from "./command-registry"
import { EventStore } from "./event-store"
import { MemoryService } from "./memory"
import type { CheckupService } from "./memory/checkup"
import type { TransferDetectService } from "./memory/transfer-detect"
import { deriveChatSnapshot } from "./read-models"
import { createWsRouter } from "./ws-router"

function makeControllableTurn() {
  let finishStream!: () => void
  const done = new Promise<void>((resolve) => {
    finishStream = resolve
  })
  async function* events(): AsyncGenerator<HarnessEvent> {
    await done
    yield {
      type: "transcript",
      entry: {
        _id: crypto.randomUUID(),
        createdAt: Date.now(),
        kind: "result",
        subtype: "success",
        isError: false,
        durationMs: 1,
        result: "ok",
      },
    }
  }
  const turn: HarnessTurn = {
    provider: "pi",
    stream: events(),
    interrupt: async () => {
      finishStream()
    },
    close: () => {
      finishStream()
    },
  }
  return { turn, finish: finishStream }
}

async function createDedupHarness(options?: {
  clientRequestTtlMs?: number
  maxClientRequestsPerChat?: number
  maxClientRequestScopes?: number
  now?: () => number
  beforeBoot?: () => Promise<void>
  onStartTurn?: (args: { content: string }) => Promise<void> | void
  nativeCommandRuntime?: NativeCommandRuntime
  memory?: MemoryService
  memoryPreview?: boolean
  memoryCheckup?: CheckupService
  memoryTransferDetect?: TransferDetectService
  getMemoryPreviewSettings?: () => MemoryPreviewSettings
}) {
  const dir = mkdtempSync(join(tmpdir(), "memosync-send-dedup-"))
  const storePath = join(dir, "events")
  const store = new EventStore(storePath)
  await store.initialize()
  const project = await store.openProject(dir, "dedup-fixture")
  const chat = await store.createChat(project.id)

  const startedPrompts: string[] = []
  const finishes: Array<() => void> = []

  const coordinator = new AgentCoordinator({
    store,
    onStateChange() {},
    clientRequestTtlMs: options?.clientRequestTtlMs,
    maxClientRequestsPerChat: options?.maxClientRequestsPerChat,
    maxClientRequestScopes: options?.maxClientRequestScopes,
    now: options?.now,
    memory: options?.memory,
    memoryPreview: options?.memoryPreview,
    memoryCheckup: options?.memoryCheckup,
    memoryTransferDetect: options?.memoryTransferDetect,
    getMemoryPreviewSettings: options?.getMemoryPreviewSettings,
    resolvePiConnection: async () => {
      if (options?.beforeBoot) await options.beforeBoot()
      return {
        provider: "openai",
        model: "gpt-4o-mini",
        apiKey: "test-key",
        baseUrl: "http://127.0.0.1:1234/v1",
      } as never
    },
    piManager: {
      startTurn: async (args: { content: string }) => {
        if (options?.onStartTurn) await options.onStartTurn(args)
        startedPrompts.push(args.content)
        const { turn, finish } = makeControllableTurn()
        finishes.push(finish)
        return turn
      },
      prepareSession: async () => null,
      getCommandRuntime: () => options?.nativeCommandRuntime,
      stopAll: async () => {},
      closeChat: () => {},
      dispose: () => {},
    } as never,
  })

  return {
    dir,
    storePath,
    store,
    project,
    chat,
    coordinator,
    startedPrompts,
    finishAllTurns: () => {
      for (const finish of finishes) finish()
    },
    cleanup: async () => {
      for (const finish of finishes) finish()
      await coordinator.shutdownRuntime()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

class FakeWs {
  readonly sent: unknown[] = []
  readonly data = {
    subscriptions: new Map(),
    snapshotSignatures: new Map(),
    protectedDraftChatIds: new Set<string>(),
  }
  send(payload: string) {
    this.sent.push(JSON.parse(payload))
    return payload.length
  }
}

describe("send & enqueue deduplication (clientRequestId)", () => {
  test("duplicate chat.send key within window produces a single prompt row and both calls succeed", async () => {
    let clock = 1_000_000
    const h = await createDedupHarness({ clientRequestTtlMs: 15 * 60 * 1000, now: () => clock })
    try {
      const first = await h.coordinator.send({
        type: "chat.send",
        chatId: h.chat.id,
        provider: "pi",
        content: "Regenerate the report",
        clientRequestId: "req-dup-1",
      })
      const second = await h.coordinator.send({
        type: "chat.send",
        chatId: h.chat.id,
        provider: "pi",
        content: "Regenerate the report",
        clientRequestId: "req-dup-1",
      })

      expect(first).toEqual({ chatId: h.chat.id })
      expect(second).toEqual({ chatId: h.chat.id })
      expect(h.startedPrompts).toEqual(["Regenerate the report"])
      expect(h.store.getMessages(h.chat.id).filter((m) => m.kind === "user_prompt")).toHaveLength(1)
      expect(h.store.getQueuedMessages(h.chat.id)).toHaveLength(0)
    } finally {
      await h.cleanup()
    }
  })

  test("concurrent retry arriving while the first send is still resolving provider does not duplicate", async () => {
    let releaseBoot!: () => void
    const bootGate = new Promise<void>((resolve) => {
      releaseBoot = resolve
    })
    let bootCalls = 0
    const h = await createDedupHarness({
      beforeBoot: async () => {
        bootCalls += 1
        if (bootCalls === 1) await bootGate
      },
    })
    try {
      const firstPromise = h.coordinator.send({
        type: "chat.send",
        chatId: h.chat.id,
        provider: "pi",
        content: "Slow startup task",
        clientRequestId: "req-inflight-1",
      })
      // Retry via chat.send AND via message.enqueue (as mobile would if status flipped to starting).
      const retrySendPromise = h.coordinator.send({
        type: "chat.send",
        chatId: h.chat.id,
        provider: "pi",
        content: "Slow startup task",
        clientRequestId: "req-inflight-1",
      })
      const retryEnqueuePromise = h.coordinator.enqueue({
        type: "message.enqueue",
        chatId: h.chat.id,
        provider: "pi",
        content: "Slow startup task",
        clientRequestId: "req-inflight-1",
        steer: true,
      })

      releaseBoot()
      const [first, retrySend, retryEnqueue] = await Promise.all([
        firstPromise,
        retrySendPromise,
        retryEnqueuePromise,
      ])

      expect(first).toEqual({ chatId: h.chat.id })
      expect(retrySend).toEqual({ chatId: h.chat.id })
      expect(retryEnqueue).toEqual({ queuedMessageId: "", deduplicated: true })
      expect(bootCalls).toBe(1)
      expect(h.startedPrompts).toEqual(["Slow startup task"])
      expect(h.store.getMessages(h.chat.id).filter((m) => m.kind === "user_prompt")).toHaveLength(1)
      expect(h.store.getQueuedMessages(h.chat.id)).toHaveLength(0)
    } finally {
      await h.cleanup()
    }
  })

  test("key after TTL expiry processes normally as a new prompt", async () => {
    let clock = 1_000_000
    const h = await createDedupHarness({ clientRequestTtlMs: 60_000, now: () => clock })
    try {
      await h.coordinator.send({
        type: "chat.send",
        chatId: h.chat.id,
        provider: "pi",
        content: "First run",
        clientRequestId: "req-expire-1",
      })
      h.finishAllTurns()
      // Let the first turn finish and release activeTurns.
      await new Promise((resolve) => setTimeout(resolve, 25))

      clock += 60_001
      const afterExpiry = await h.coordinator.send({
        type: "chat.send",
        chatId: h.chat.id,
        provider: "pi",
        content: "Second run after expiry",
        clientRequestId: "req-expire-1",
      })

      expect(afterExpiry).toEqual({ chatId: h.chat.id })
      expect(h.startedPrompts).toEqual(["First run", "Second run after expiry"])
      expect(h.store.getMessages(h.chat.id).filter((m) => m.kind === "user_prompt")).toHaveLength(2)
    } finally {
      await h.cleanup()
    }
  })

  test("per-chat registry stays bounded and evicts oldest keys past the cap", async () => {
    const h = await createDedupHarness({ maxClientRequestsPerChat: 2 })
    try {
      await h.coordinator.send({
        type: "chat.send",
        chatId: h.chat.id,
        provider: "pi",
        content: "m1",
        clientRequestId: "k1",
      })
      await h.coordinator.enqueue({
        type: "message.enqueue",
        chatId: h.chat.id,
        provider: "pi",
        content: "m2",
        clientRequestId: "k2",
      })
      await h.coordinator.enqueue({
        type: "message.enqueue",
        chatId: h.chat.id,
        provider: "pi",
        content: "m3",
        clientRequestId: "k3",
      })
      // k1 was evicted by cap=2, so reusing k1 enqueues normally; k3 is still deduplicated.
      const dupK3 = await h.coordinator.enqueue({
        type: "message.enqueue",
        chatId: h.chat.id,
        provider: "pi",
        content: "m3",
        clientRequestId: "k3",
      })
      expect(dupK3.deduplicated).toBe(true)

      const reusedK1 = await h.coordinator.enqueue({
        type: "message.enqueue",
        chatId: h.chat.id,
        provider: "pi",
        content: "m1 again",
        clientRequestId: "k1",
      })
      expect(reusedK1.deduplicated).toBeUndefined()
      expect(h.store.getQueuedMessages(h.chat.id)).toHaveLength(3)
    } finally {
      await h.cleanup()
    }
  })

  test("queue-then-wake deduplicates retries via both message.enqueue and chat.send", async () => {
    const h = await createDedupHarness()
    try {
      // Idle chat: enqueueMessage inserts row and wakes the queue into a turn.
      const first = await h.coordinator.enqueue({
        type: "message.enqueue",
        chatId: h.chat.id,
        provider: "pi",
        content: "Queued wake task",
        clientRequestId: "req-queue-wake-1",
      })
      // Wait for wakeQueue to consume the row and append the prompt.
      await new Promise((resolve) => setTimeout(resolve, 30))

      const retryEnqueue = await h.coordinator.enqueue({
        type: "message.enqueue",
        chatId: h.chat.id,
        provider: "pi",
        content: "Queued wake task",
        clientRequestId: "req-queue-wake-1",
      })
      const retrySend = await h.coordinator.send({
        type: "chat.send",
        chatId: h.chat.id,
        provider: "pi",
        content: "Queued wake task",
        clientRequestId: "req-queue-wake-1",
      })

      expect(retryEnqueue).toEqual({ queuedMessageId: first.queuedMessageId, deduplicated: true })
      expect(retrySend).toEqual({ chatId: h.chat.id, queuedMessageId: first.queuedMessageId, queued: true })
      expect(h.startedPrompts).toEqual(["Queued wake task"])
      expect(h.store.getMessages(h.chat.id).filter((m) => m.kind === "user_prompt")).toHaveLength(1)
      expect(h.store.getQueuedMessages(h.chat.id)).toHaveLength(0)
    } finally {
      await h.cleanup()
    }
  })

  test("persisted queue row retains clientRequestId across EventStore reload", async () => {
    const h = await createDedupHarness()
    try {
      // Start an active turn so the next enqueue stays parked in the persisted queue.
      await h.coordinator.send({
        type: "chat.send",
        chatId: h.chat.id,
        provider: "pi",
        content: "active turn",
      })
      const queued = await h.coordinator.enqueue({
        type: "message.enqueue",
        chatId: h.chat.id,
        provider: "pi",
        content: "follow up",
        clientRequestId: "req-persisted-queue-1",
      })

      // Reload EventStore into a brand-new coordinator (empty in-memory dedup map).
      const reloadedStore = new EventStore(h.storePath)
      await reloadedStore.initialize()
      const freshCoordinator = new AgentCoordinator({
        store: reloadedStore,
        onStateChange() {},
        resolvePiConnection: async () => ({
          provider: "openai",
          model: "gpt-4o-mini",
          apiKey: "test-key",
          baseUrl: "http://127.0.0.1:1234/v1",
        } as never),
        piManager: {
          startTurn: async () => makeControllableTurn().turn,
          stopAll: async () => {},
          dispose: () => {},
        } as never,
      })
      try {
        const retry = await freshCoordinator.enqueue({
          type: "message.enqueue",
          chatId: h.chat.id,
          provider: "pi",
          content: "follow up",
          clientRequestId: "req-persisted-queue-1",
        })
        expect(retry).toEqual({ queuedMessageId: queued.queuedMessageId, deduplicated: true })
        expect(reloadedStore.getQueuedMessages(h.chat.id)).toHaveLength(1)
      } finally {
        await freshCoordinator.shutdownRuntime()
      }
    } finally {
      await h.cleanup()
    }
  })

  test("failed admission releases clientRequestId so a retry can proceed, and omitted keys keep legacy behavior", async () => {
    const h = await createDedupHarness()
    try {
      // Slash command with attachment is refused before admission.
      await expect(
        h.coordinator.send({
          type: "chat.send",
          chatId: h.chat.id,
          provider: "pi",
          content: "/not-a-command",
          clientRequestId: "req-retry-after-fail",
          attachments: [
            {
              id: "a1",
              kind: "file",
              displayName: "notes.txt",
              absolutePath: "/tmp/notes.txt",
              relativePath: "notes.txt",
              contentUrl: "/uploads/notes.txt",
              mimeType: "text/plain",
              size: 5,
            },
          ],
        }),
      ).rejects.toThrow()

      // Same key now succeeds when content is valid.
      const admitted = await h.coordinator.send({
        type: "chat.send",
        chatId: h.chat.id,
        provider: "pi",
        content: "Valid retry",
        clientRequestId: "req-retry-after-fail",
      })
      expect(admitted).toEqual({ chatId: h.chat.id })

      // Backwards compatibility: two enqueues without clientRequestId still create two rows.
      await h.coordinator.enqueue({
        type: "message.enqueue",
        chatId: h.chat.id,
        provider: "pi",
        content: "No key",
      })
      await h.coordinator.enqueue({
        type: "message.enqueue",
        chatId: h.chat.id,
        provider: "pi",
        content: "No key",
      })
      expect(h.store.getQueuedMessages(h.chat.id)).toHaveLength(2)
    } finally {
      await h.cleanup()
    }
  })

  test("ws-router validates optional clientRequestId and acks deduplicated sends and steered enqueues cleanly", async () => {
    const h = await createDedupHarness()
    const router = createWsRouter({
      store: h.store,
      agent: h.coordinator,
      terminals: {
        onEvent: () => () => {},
        getSnapshot: () => null,
        getTail: () => null,
      } as never,
      keybindings: {
        onChange: () => () => {},
        getSnapshot: () => ({ bindings: {}, warning: null, filePathDisplay: "" }),
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "test-host",
      updateManager: null,
    })
    const ws = new FakeWs()
    router.handleOpen(ws as never)
    try {
      // Invalid clientRequestId rejected at router boundary.
      await router.handleMessage(
        ws as never,
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: "command",
          id: "cmd-bad-1",
          command: { type: "chat.send", chatId: h.chat.id, provider: "pi", content: "hi", clientRequestId: "   " },
        }),
      )
      await router.handleMessage(
        ws as never,
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: "command",
          id: "cmd-bad-2",
          command: { type: "message.enqueue", chatId: h.chat.id, provider: "pi", content: "hi", clientRequestId: 42 },
        }),
      )
      expect(ws.sent).toContainEqual(expect.objectContaining({ type: "error", id: "cmd-bad-1" }))
      expect(ws.sent).toContainEqual(expect.objectContaining({ type: "error", id: "cmd-bad-2" }))
      expect(h.startedPrompts).toHaveLength(0)

      // Valid duplicate chat.send + steered message.enqueue both ack as success with a single prompt.
      await router.handleMessage(
        ws as never,
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: "command",
          id: "cmd-send-1",
          command: { type: "chat.send", chatId: h.chat.id, provider: "pi", content: "Hello via ws", clientRequestId: "ws-key-1" },
        }),
      )
      await router.handleMessage(
        ws as never,
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: "command",
          id: "cmd-send-2",
          command: { type: "chat.send", chatId: h.chat.id, provider: "pi", content: "Hello via ws", clientRequestId: "ws-key-1" },
        }),
      )
      await router.handleMessage(
        ws as never,
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: "command",
          id: "cmd-enq-1",
          command: { type: "message.enqueue", chatId: h.chat.id, provider: "pi", content: "Hello via ws", clientRequestId: "ws-key-1", steer: true },
        }),
      )

      expect(ws.sent).toContainEqual(expect.objectContaining({ type: "ack", id: "cmd-send-1", result: { chatId: h.chat.id } }))
      expect(ws.sent).toContainEqual(expect.objectContaining({ type: "ack", id: "cmd-send-2", result: { chatId: h.chat.id } }))
      expect(ws.sent).toContainEqual(expect.objectContaining({ type: "ack", id: "cmd-enq-1", result: { queuedMessageId: "" } }))
      expect(h.startedPrompts).toEqual(["Hello via ws"])
      expect(h.store.getMessages(h.chat.id).filter((m) => m.kind === "user_prompt")).toHaveLength(1)
      expect(h.store.getQueuedMessages(h.chat.id)).toHaveLength(0)
    } finally {
      router.dispose()
      await h.cleanup()
    }
  })

  test("F-1.1: deliberate resend after message.dequeue re-admits instead of deduping against removed queue row", async () => {
    const h = await createDedupHarness()
    try {
      // Start an active turn so enqueued follow-up stays in the queue.
      await h.coordinator.send({
        type: "chat.send",
        chatId: h.chat.id,
        provider: "pi",
        content: "active turn",
      })
      const firstQueue = await h.coordinator.enqueue({
        type: "message.enqueue",
        chatId: h.chat.id,
        provider: "pi",
        content: "Summarize failing tests",
        clientRequestId: "K1",
      })
      expect(h.store.getQueuedMessages(h.chat.id)).toHaveLength(1)

      // User explicitly removes the queued item.
      await h.coordinator.dequeue({
        type: "message.dequeue",
        chatId: h.chat.id,
        queuedMessageId: firstQueue.queuedMessageId,
      })
      expect(h.store.getQueuedMessages(h.chat.id)).toHaveLength(0)

      // Deliberate re-send with the SAME clientRequestId must be re-admitted!
      const secondQueue = await h.coordinator.enqueue({
        type: "message.enqueue",
        chatId: h.chat.id,
        provider: "pi",
        content: "Summarize failing tests",
        clientRequestId: "K1",
      })
      expect(secondQueue.deduplicated).toBeUndefined()
      expect(secondQueue.queuedMessageId).not.toBe(firstQueue.queuedMessageId)
      expect(h.store.getQueuedMessages(h.chat.id)).toHaveLength(1)

      // Defensive cached-outcome check: even if the queue row disappears directly
      // from EventStore without hitting agent.dequeue, chat.send / enqueue evicts
      // the stale queued-only outcome and admits the deliberate re-send once idle.
      await h.store.removeQueuedMessage(h.chat.id, secondQueue.queuedMessageId)
      h.finishAllTurns()
      await new Promise((resolve) => setTimeout(resolve, 25))

      const resent = await h.coordinator.send({
        type: "chat.send",
        chatId: h.chat.id,
        provider: "pi",
        content: "Summarize failing tests",
        clientRequestId: "K1",
      })
      expect(resent).toEqual({ chatId: h.chat.id })
      expect(h.startedPrompts).toEqual(["active turn", "Summarize failing tests"])
      expect(h.store.getMessages(h.chat.id).filter((m) => m.kind === "user_prompt")).toHaveLength(2)
    } finally {
      await h.cleanup()
    }
  })

  test("F-1.2: drainOrphanedQueues() after EventStore reload preserves clientRequestId across host restart", async () => {
    const h = await createDedupHarness()
    try {
      await h.coordinator.send({
        type: "chat.send",
        chatId: h.chat.id,
        provider: "pi",
        content: "active turn",
      })
      const queued = await h.coordinator.enqueue({
        type: "message.enqueue",
        chatId: h.chat.id,
        provider: "pi",
        content: "follow up across restart",
        clientRequestId: "req-orphan-drain-1",
      })

      // Simulate host restart: reload EventStore and immediately call drainOrphanedQueues()
      // (matching src/server/server.ts startup).
      const reloadedStore = new EventStore(h.storePath)
      await reloadedStore.initialize()
      const restartedPrompts: string[] = []
      const restartedFinishes: Array<() => void> = []
      const freshCoordinator = new AgentCoordinator({
        store: reloadedStore,
        onStateChange() {},
        resolvePiConnection: async () => ({
          provider: "openai",
          model: "gpt-4o-mini",
          apiKey: "test-key",
          baseUrl: "http://127.0.0.1:1234/v1",
        } as never),
        piManager: {
          startTurn: async (args: { content: string }) => {
            restartedPrompts.push(args.content)
            const { turn, finish } = makeControllableTurn()
            restartedFinishes.push(finish)
            return turn
          },
          stopAll: async () => {},
          dispose: () => {},
        } as never,
      })
      try {
        await freshCoordinator.drainOrphanedQueues()
        expect(reloadedStore.getQueuedMessages(h.chat.id)).toHaveLength(0)
        expect(restartedPrompts).toEqual(["follow up across restart"])

        // Mobile reconnects and retries with the same clientRequestId via both enqueue and send.
        const retryEnqueue = await freshCoordinator.enqueue({
          type: "message.enqueue",
          chatId: h.chat.id,
          provider: "pi",
          content: "follow up across restart",
          clientRequestId: "req-orphan-drain-1",
        })
        const retrySend = await freshCoordinator.send({
          type: "chat.send",
          chatId: h.chat.id,
          provider: "pi",
          content: "follow up across restart",
          clientRequestId: "req-orphan-drain-1",
        })
        expect(retryEnqueue).toEqual({ queuedMessageId: queued.queuedMessageId, deduplicated: true })
        expect(retrySend).toEqual({ chatId: h.chat.id, queuedMessageId: queued.queuedMessageId, queued: true })
        expect(restartedPrompts).toEqual(["follow up across restart"])
        expect(reloadedStore.getQueuedMessages(h.chat.id)).toHaveLength(0)

        // Even across a SECOND host restart (empty in-memory map, queue row already removed),
        // persisted clientRequestId on user_prompt still deduplicates retries.
        for (const finish of restartedFinishes) finish()
        await new Promise((resolve) => setTimeout(resolve, 20))
      } finally {
        for (const finish of restartedFinishes) finish()
        await freshCoordinator.shutdownRuntime()
      }

      const secondReloadStore = new EventStore(h.storePath)
      await secondReloadStore.initialize()
      const secondRestartPrompts: string[] = []
      const secondCoordinator = new AgentCoordinator({
        store: secondReloadStore,
        onStateChange() {},
        resolvePiConnection: async () => ({
          provider: "openai",
          model: "gpt-4o-mini",
          apiKey: "test-key",
          baseUrl: "http://127.0.0.1:1234/v1",
        } as never),
        piManager: {
          startTurn: async (args: { content: string }) => {
            secondRestartPrompts.push(args.content)
            return makeControllableTurn().turn
          },
          stopAll: async () => {},
          dispose: () => {},
        } as never,
      })
      try {
        const retryAfterSecondRestart = await secondCoordinator.send({
          type: "chat.send",
          chatId: h.chat.id,
          provider: "pi",
          content: "follow up across restart",
          clientRequestId: "req-orphan-drain-1",
        })
        expect(retryAfterSecondRestart).toEqual({ chatId: h.chat.id })
        expect(secondRestartPrompts).toHaveLength(0)
      } finally {
        await secondCoordinator.shutdownRuntime()
      }
    } finally {
      await h.cleanup()
    }
  })

  test("F-1.2: long queue wait past TTL re-seeds clientRequestId on wakeQueue(), and real slash-command mid-boot failure retains key after prompt append", async () => {
    let clock = 5_000_000
    let failNativeBoot = false
    const source = { api: "pi:native", version: "1.0.0", evidence: "native-response" as const }
    const reviewCommand: RuntimeCommand = {
      id: "native:review",
      name: "review",
      description: "Run review",
      namespace: "native",
      owner: "native-engine",
      arguments: { type: "string" },
      requiresIdle: true,
      sideEffect: "model-turn",
      route: "native-prompt",
      source,
      requiredRuntimeVersion: "1.0.0",
    }
    const nativeCommandRuntime: NativeCommandRuntime = {
      instance: "pi-inst-1",
      session: "pi-sess-1",
      version: "1.0.0",
      alive: () => true,
      discover: async () => ({
        commands: discovery("ready", [reviewCommand], source),
        skills: discovery("ready", [], source),
        connectors: discovery("ready", [], source),
      }),
    }
    const h = await createDedupHarness({
      clientRequestTtlMs: 60_000,
      now: () => clock,
      nativeCommandRuntime,
      onStartTurn: (args) => {
        if (failNativeBoot && args.content === "/review") {
          throw new Error("provider boot crashed after prompt append")
        }
      },
    })
    try {
      await h.coordinator.send({
        type: "chat.send",
        chatId: h.chat.id,
        provider: "pi",
        content: "long running turn",
      })
      const queued = await h.coordinator.enqueue({
        type: "message.enqueue",
        chatId: h.chat.id,
        provider: "pi",
        content: "queued past ttl",
        clientRequestId: "req-long-wait-1",
      })

      // Advance clock past TTL while turn is still running, then finish turn so wakeQueue drains.
      clock += 120_000
      h.finishAllTurns()
      await new Promise((resolve) => setTimeout(resolve, 40))

      expect(h.store.getQueuedMessages(h.chat.id)).toHaveLength(0)
      expect(h.startedPrompts).toEqual(["long running turn", "queued past ttl"])

      // Retry after wake must still deduplicate instead of launching a duplicate turn.
      const retryAfterWake = await h.coordinator.enqueue({
        type: "message.enqueue",
        chatId: h.chat.id,
        provider: "pi",
        content: "queued past ttl",
        clientRequestId: "req-long-wait-1",
      })
      expect(retryAfterWake).toEqual({ queuedMessageId: queued.queuedMessageId, deduplicated: true })
      expect(h.store.getQueuedMessages(h.chat.id)).toHaveLength(0)

      // Finish the woken turn, then verify real slash-command path (WITHOUT nativeCommandValidated bypass).
      h.finishAllTurns()
      await new Promise((resolve) => setTimeout(resolve, 40))

      failNativeBoot = true
      const failedNative = await h.coordinator.send({
        type: "chat.send",
        chatId: h.chat.id,
        provider: "pi",
        content: "/review",
        clientRequestId: "req-native-boot-fail-1",
      })
      expect(failedNative).toEqual({ chatId: h.chat.id })

      const promptsAfterFail = h.store.getMessages(h.chat.id).filter((m) => m.kind === "user_prompt")
      expect(promptsAfterFail).toHaveLength(3)
      expect(promptsAfterFail.at(-1)).toMatchObject({
        content: "/review",
        clientRequestId: "req-native-boot-fail-1",
      })

      const failureResults = h.store.getMessages(h.chat.id).filter((m) => m.kind === "result" && m.isError)
      expect(failureResults.at(-1)).toMatchObject({ result: "provider boot crashed after prompt append" })

      // Retry with the same key must deduplicate rather than appending a second /review prompt.
      // The first attempt is terminally failed and visible in the transcript; idempotent retry
      // must not silently execute the same logical command a second time.
      failNativeBoot = false
      const startedBeforeRetry = h.startedPrompts.length
      const retryNative = await h.coordinator.send({
        type: "chat.send",
        chatId: h.chat.id,
        provider: "pi",
        content: "/review",
        clientRequestId: "req-native-boot-fail-1",
      })
      expect(retryNative).toEqual({ chatId: h.chat.id })
      expect(h.startedPrompts).toHaveLength(startedBeforeRetry)
      expect(h.store.getMessages(h.chat.id).filter((m) => m.kind === "user_prompt")).toHaveLength(3)
    } finally {
      await h.cleanup()
    }
  })

  test("F-1.3: recentClientRequests bounds global scopes and cleans up on hideProject and chat pruning", async () => {
    let clock = 10_000_000
    const h = await createDedupHarness({
      clientRequestTtlMs: 60_000,
      maxClientRequestScopes: 2,
      now: () => clock,
    })
    try {
      const chat2 = await h.store.createChat(h.project.id)
      const chat3 = await h.store.createChat(h.project.id)

      await h.coordinator.send({
        type: "chat.send",
        chatId: h.chat.id,
        provider: "pi",
        content: "chat1-msg",
        clientRequestId: "scope-k1",
      })
      await h.coordinator.send({
        type: "chat.send",
        chatId: chat2.id,
        provider: "pi",
        content: "chat2-msg",
        clientRequestId: "scope-k2",
      })
      await h.coordinator.send({
        type: "chat.send",
        chatId: chat3.id,
        provider: "pi",
        content: "chat3-msg",
        clientRequestId: "scope-k3",
      })

      // Global scope cap=2 evicted the oldest scope (h.chat.id).
      const scopesMap = (h.coordinator as unknown as { recentClientRequests: Map<string, Map<string, unknown>> }).recentClientRequests
      expect(scopesMap.size).toBeLessThanOrEqual(2)
      expect(scopesMap.has(h.chat.id)).toBe(false)

      // Explicit forgetChatClientRequests removes a pruned chat immediately.
      h.coordinator.forgetChatClientRequests(chat2.id)
      expect(scopesMap.has(chat2.id)).toBe(false)

      // Advancing past TTL and calling pruneExpiredClientRequests sweeps inactive scopes.
      clock += 60_001
      h.coordinator.pruneExpiredClientRequests()
      expect(scopesMap.size).toBe(0)

      // hideProject cleans both project:<id> and chat scopes.
      h.finishAllTurns()
      await new Promise((resolve) => setTimeout(resolve, 25))
      const created = await h.coordinator.send({
        type: "chat.send",
        projectId: h.project.id,
        provider: "pi",
        content: "new chat in project",
        clientRequestId: "proj-key-1",
      })
      expect(scopesMap.has(`project:${h.project.id}`)).toBe(true)
      expect(scopesMap.has(created.chatId)).toBe(true)

      await h.coordinator.hideProject(h.project.id)
      expect(scopesMap.has(`project:${h.project.id}`)).toBe(false)
      expect(scopesMap.has(created.chatId)).toBe(false)
    } finally {
      await h.cleanup()
    }
  })

  test("F-6.1: projectId-only chat.send deduplicates concurrent and post-settle retries, and ws-router failed steer releases clientRequestId", async () => {
    let releaseBoot!: () => void
    const bootGate = new Promise<void>((resolve) => {
      releaseBoot = resolve
    })
    let bootCount = 0
    const h = await createDedupHarness({
      beforeBoot: async () => {
        bootCount += 1
        if (bootCount === 1) await bootGate
      },
    })
    const router = createWsRouter({
      store: h.store,
      agent: h.coordinator,
      terminals: {
        onEvent: () => () => {},
        getSnapshot: () => null,
        getTail: () => null,
      } as never,
      keybindings: {
        onChange: () => () => {},
        getSnapshot: () => ({ bindings: {}, warning: null, filePathDisplay: "" }),
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "test-host",
      updateManager: null,
    })
    const ws = new FakeWs()
    router.handleOpen(ws as never)
    try {
      // Concurrent chat.send without chatId (projectId only) creates exactly ONE chat.
      const p1 = h.coordinator.send({
        type: "chat.send",
        projectId: h.project.id,
        provider: "pi",
        content: "Create once",
        clientRequestId: "proj-dedup-1",
      })
      const p2 = h.coordinator.send({
        type: "chat.send",
        projectId: h.project.id,
        provider: "pi",
        content: "Create once",
        clientRequestId: "proj-dedup-1",
      })
      releaseBoot()
      const [r1, r2] = await Promise.all([p1, p2])
      expect(r1.chatId).toBe(r2.chatId)

      // Post-settle retry via projectId OR via the created chatId both deduplicate.
      const r3 = await h.coordinator.send({
        type: "chat.send",
        projectId: h.project.id,
        provider: "pi",
        content: "Create once",
        clientRequestId: "proj-dedup-1",
      })
      const r4 = await h.coordinator.send({
        type: "chat.send",
        chatId: r1.chatId,
        provider: "pi",
        content: "Create once",
        clientRequestId: "proj-dedup-1",
      })
      expect(r3.chatId).toBe(r1.chatId)
      expect(r4.chatId).toBe(r1.chatId)
      expect(h.startedPrompts).toEqual(["Create once"])

      // ws-router + real AgentCoordinator: failed steer rolls back queue row AND releases clientRequestId.
      const originalSteer = h.coordinator.steer.bind(h.coordinator)
      let failSteerOnce = true
      h.coordinator.steer = async (cmd) => {
        if (failSteerOnce) {
          failSteerOnce = false
          throw new Error("Steer admission rejected")
        }
        return originalSteer(cmd)
      }

      await router.handleMessage(
        ws as never,
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: "command",
          id: "cmd-steer-fail",
          command: {
            type: "message.enqueue",
            chatId: r1.chatId,
            provider: "pi",
            content: "Steer me",
            steer: true,
            clientRequestId: "steer-rollback-1",
          },
        }),
      )
      expect(ws.sent).toContainEqual(
        expect.objectContaining({ type: "error", id: "cmd-steer-fail", message: "Steer admission rejected" }),
      )
      expect(h.store.getQueuedMessages(r1.chatId)).toHaveLength(0)

      // Retrying with the SAME clientRequestId succeeds now that steer rollback released the key.
      await router.handleMessage(
        ws as never,
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: "command",
          id: "cmd-steer-retry",
          command: {
            type: "message.enqueue",
            chatId: r1.chatId,
            provider: "pi",
            content: "Steer me",
            steer: true,
            clientRequestId: "steer-rollback-1",
          },
        }),
      )
      expect(ws.sent).toContainEqual(expect.objectContaining({ type: "ack", id: "cmd-steer-retry" }))
      expect(h.startedPrompts.some((p) => p.includes("Steer me"))).toBe(true)
    } finally {
      router.dispose()
      await h.cleanup()
    }
  })

  test("F-5.1 / F-5.2: ChatRuntime exposes authoritative pendingMemoryPreviewId even when lastTurnOutcome === 'failed' and clears it on closeChat/restart", async () => {
    const h = await createDedupHarness()
    try {
      // Simulate previous turn failure (sets chat.lastTurnOutcome = "failed").
      await h.store.recordTurnFailed(h.chat.id, "Previous turn failed")
      // Park a live preview in pendingPreviews (as runPreviewGateThenBoot does after settling startup reservation).
      h.coordinator.pendingPreviews.set(h.chat.id, {
        chatId: h.chat.id,
        previewId: "prev-live-1",
        revision: 0,
        published: true,
        memoryIds: [],
        task: "Next turn",
        memories: [],
        expectedUseById: new Map(),
        confirmationMode: "every_turn",
        respond: async () => {},
      })

      expect(h.coordinator.getPendingMemoryPreviewId(h.chat.id)).toBe("prev-live-1")
      const parkedSnapshot = deriveChatSnapshot(
        h.store.state,
        h.coordinator.getActiveStatuses(),
        h.coordinator.getDrainingChatIds(),
        h.chat.id,
        () => ({
          messages: h.store.getMessages(h.chat.id),
          history: { hasOlder: false, olderCursor: null, recentLimit: 200 },
        }),
        h.coordinator.getStreamingAssistantTexts(),
        undefined,
        undefined,
        h.coordinator.getPendingMemoryPreviewId(h.chat.id),
      )
      expect(parkedSnapshot?.runtime.status).toBe("failed")
      expect(parkedSnapshot?.runtime.pendingMemoryPreviewId).toBe("prev-live-1")

      // Closing the chat (or restarting host) drops pendingPreviews -> pendingMemoryPreviewId becomes null.
      await h.coordinator.closeChat(h.chat.id)
      expect(h.coordinator.getPendingMemoryPreviewId(h.chat.id)).toBeNull()
      const closedSnapshot = deriveChatSnapshot(
        h.store.state,
        h.coordinator.getActiveStatuses(),
        h.coordinator.getDrainingChatIds(),
        h.chat.id,
        () => ({
          messages: h.store.getMessages(h.chat.id),
          history: { hasOlder: false, olderCursor: null, recentLimit: 200 },
        }),
        h.coordinator.getStreamingAssistantTexts(),
        undefined,
        undefined,
        h.coordinator.getPendingMemoryPreviewId(h.chat.id),
      )
      expect(closedSnapshot?.runtime.pendingMemoryPreviewId).toBeNull()
    } finally {
      await h.cleanup()
    }
  })

  test("V-1: concurrent steered message.enqueue retry during an in-flight failing steer shares rollback rejection instead of acking a deleted row", async () => {
    const h = await createDedupHarness()
    const router = createWsRouter({
      store: h.store,
      agent: h.coordinator,
      terminals: {
        onEvent: () => () => {},
        getSnapshot: () => null,
        getTail: () => null,
      } as never,
      keybindings: {
        onChange: () => () => {},
        getSnapshot: () => ({ bindings: {}, warning: null, filePathDisplay: "" }),
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "test-host",
      updateManager: null,
    })
    const ws1 = new FakeWs()
    const ws2 = new FakeWs()
    router.handleOpen(ws1 as never)
    router.handleOpen(ws2 as never)
    try {
      // Start an active turn so steering is meaningful.
      await h.coordinator.send({
        type: "chat.send",
        chatId: h.chat.id,
        provider: "pi",
        content: "Active background turn",
      })

      const originalSteer = h.coordinator.steer.bind(h.coordinator)
      let enteredSteer!: () => void
      const steerEntered = new Promise<void>((resolve) => {
        enteredSteer = resolve
      })
      let releaseSteer!: () => void
      const steerGate = new Promise<void>((resolve) => {
        releaseSteer = resolve
      })
      let steerAttempt = 0
      h.coordinator.steer = async (cmd) => {
        steerAttempt += 1
        if (steerAttempt === 1) {
          enteredSteer()
          await steerGate
          throw new Error("account-signed-out")
        }
        return originalSteer(cmd)
      }

      // Attempt 1 enqueues q1 and blocks inside steer().
      const attempt1 = router.handleMessage(
        ws1 as never,
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: "command",
          id: "cmd-steer-1",
          command: {
            type: "message.enqueue",
            chatId: h.chat.id,
            provider: "pi",
            content: "Stop and fix auth",
            steer: true,
            clientRequestId: "K-steer-race-1",
          },
        }),
      )
      await steerEntered
      expect(h.store.getQueuedMessages(h.chat.id)).toHaveLength(1)

      // Attempt 2 retries with the SAME clientRequestId while Attempt 1 is STILL inside steer().
      const attempt2 = router.handleMessage(
        ws2 as never,
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: "command",
          id: "cmd-steer-2",
          command: {
            type: "message.enqueue",
            chatId: h.chat.id,
            provider: "pi",
            content: "Stop and fix auth",
            steer: true,
            clientRequestId: "K-steer-race-1",
          },
        }),
      )
      // Give Attempt 2 a tick to hit the inFlight barrier — it must NOT ack while steer is unresolved!
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(ws2.sent.filter((frame) => (frame as { id?: string }).id === "cmd-steer-2")).toHaveLength(0)

      // Now let Attempt 1's steer reject and roll back q1.
      releaseSteer()
      await Promise.all([attempt1, attempt2])

      expect(ws1.sent).toContainEqual(
        expect.objectContaining({ type: "error", id: "cmd-steer-1", message: "account-signed-out" }),
      )
      // Attempt 2 MUST receive the rollback error, NEVER an ack for the deleted row!
      expect(ws2.sent).toContainEqual(
        expect.objectContaining({ type: "error", id: "cmd-steer-2", message: "account-signed-out" }),
      )
      expect(ws2.sent.some((frame) => (frame as { type?: string }).type === "ack")).toBe(false)
      expect(h.store.getQueuedMessages(h.chat.id)).toHaveLength(0)
      expect(steerAttempt).toBe(1)

      // Deliberate Attempt 3 with the SAME clientRequestId succeeds once steering is healthy.
      await router.handleMessage(
        ws2 as never,
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: "command",
          id: "cmd-steer-3",
          command: {
            type: "message.enqueue",
            chatId: h.chat.id,
            provider: "pi",
            content: "Stop and fix auth",
            steer: true,
            clientRequestId: "K-steer-race-1",
          },
        }),
      )
      expect(ws2.sent).toContainEqual(expect.objectContaining({ type: "ack", id: "cmd-steer-3" }))
      expect(h.startedPrompts.some((p) => p.includes("Stop and fix auth"))).toBe(true)

      // Concurrent retry when steer SUCCEEDS shares the single settled queuedMessageId and runs once.
      let enteredSuccessSteer!: () => void
      const successSteerEntered = new Promise<void>((resolve) => {
        enteredSuccessSteer = resolve
      })
      let releaseSuccessSteer!: () => void
      const successSteerGate = new Promise<void>((resolve) => {
        releaseSuccessSteer = resolve
      })
      let successSteerCalls = 0
      h.coordinator.steer = async (cmd) => {
        successSteerCalls += 1
        enteredSuccessSteer()
        await successSteerGate
        return originalSteer(cmd)
      }
      const ws3 = new FakeWs()
      const ws4 = new FakeWs()
      router.handleOpen(ws3 as never)
      router.handleOpen(ws4 as never)
      const s1 = router.handleMessage(
        ws3 as never,
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: "command",
          id: "cmd-steer-ok-1",
          command: {
            type: "message.enqueue",
            chatId: h.chat.id,
            provider: "pi",
            content: "Follow-up steer",
            steer: true,
            clientRequestId: "K-steer-ok-1",
          },
        }),
      )
      await successSteerEntered
      const s2 = router.handleMessage(
        ws4 as never,
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: "command",
          id: "cmd-steer-ok-2",
          command: {
            type: "message.enqueue",
            chatId: h.chat.id,
            provider: "pi",
            content: "Follow-up steer",
            steer: true,
            clientRequestId: "K-steer-ok-1",
          },
        }),
      )
      releaseSuccessSteer()
      await Promise.all([s1, s2])
      const ack3 = ws3.sent.find((f) => (f as { id?: string }).id === "cmd-steer-ok-1") as { type: string; result?: { queuedMessageId?: string } }
      const ack4 = ws4.sent.find((f) => (f as { id?: string }).id === "cmd-steer-ok-2") as { type: string; result?: { queuedMessageId?: string } }
      expect(ack3?.type).toBe("ack")
      expect(ack4?.type).toBe("ack")
      expect(ack3?.result?.queuedMessageId).toBeTruthy()
      expect(ack4?.result?.queuedMessageId).toBe(ack3?.result?.queuedMessageId)
      expect(successSteerCalls).toBe(1)
      expect(h.startedPrompts.filter((p) => p.includes("Follow-up steer"))).toHaveLength(1)
    } finally {
      router.dispose()
      await h.cleanup()
    }
  })

  test("V-2: ws-router slash-command chat.send threads clientRequestId end-to-end (no busy-race key poisoning, skill rewrite & restart dedup)", async () => {
    const source = { api: "pi:native", version: "1.0.0", evidence: "native-response" as const }
    const reviewCommand: RuntimeCommand = {
      id: "native:review",
      name: "review",
      description: "Run review",
      namespace: "native",
      owner: "native-engine",
      arguments: { type: "string" },
      requiresIdle: true,
      sideEffect: "model-turn",
      route: "native-prompt",
      source,
      requiredRuntimeVersion: "1.0.0",
    }
    const auditSkill: RuntimeCommand = {
      id: "skill:audit",
      name: "audit",
      description: "Run audit skill",
      namespace: "skill",
      owner: "native-engine",
      arguments: { type: "string" },
      requiresIdle: true,
      sideEffect: "model-turn",
      route: "native-skill",
      source,
      requiredRuntimeVersion: "1.0.0",
      nativeSkill: { name: "audit", path: "/skills/audit" },
    }
    const nativeCommandRuntime: NativeCommandRuntime = {
      instance: "pi-inst-v2",
      session: "pi-sess-v2",
      version: "1.0.0",
      alive: () => true,
      discover: async () => ({
        commands: discovery("ready", [reviewCommand, auditSkill], source),
        skills: discovery("ready", [], source),
        connectors: discovery("ready", [], source),
      }),
    }
    const h = await createDedupHarness({ nativeCommandRuntime })
    const router = createWsRouter({
      store: h.store,
      agent: h.coordinator,
      terminals: {
        onEvent: () => () => {},
        getSnapshot: () => null,
        getTail: () => null,
      } as never,
      keybindings: {
        onChange: () => () => {},
        getSnapshot: () => ({ bindings: {}, warning: null, filePathDisplay: "" }),
      } as never,
      refreshDiscovery: async () => [],
      getDiscoveredProjects: () => [],
      machineDisplayName: "test-host",
      updateManager: null,
    })
    const ws = new FakeWs()
    router.handleOpen(ws as never)
    try {
      // Prime provider on the chat and simulate a concurrent desktop send starting right
      // before executeCommand runs, so user_prompt count increments while /review is rejected as busy.
      const slashChat = await h.store.createChat(h.project.id)
      await h.store.setChatProvider(slashChat.id, "pi")
      await h.coordinator.readCommandCatalog(slashChat.id, true, { provider: "pi" })

      const originalReadCatalog = h.coordinator.readCommandCatalog.bind(h.coordinator)
      let injectConcurrentTurn = true
      h.coordinator.readCommandCatalog = async (chatId, refresh, selection) => {
        const res = await originalReadCatalog(chatId, refresh, selection)
        if (injectConcurrentTurn && chatId === slashChat.id && !selection) {
          injectConcurrentTurn = false
          await h.coordinator.send({
            type: "chat.send",
            chatId: slashChat.id,
            provider: "pi",
            content: "Concurrent desktop prompt",
          })
        }
        return res
      }

      // Attempt 1 via ws-router (nativeCommandValidated = false): rejected because chat became busy.
      await router.handleMessage(
        ws as never,
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: "command",
          id: "cmd-slash-busy",
          command: {
            type: "chat.send",
            chatId: slashChat.id,
            provider: "pi",
            content: "/review",
            clientRequestId: "K-slash-busy-1",
          },
        }),
      )
      expect(ws.sent).toContainEqual(
        expect.objectContaining({
          type: "error",
          id: "cmd-slash-busy",
          message: expect.stringContaining("Chat is busy"),
        }),
      )
      expect(h.startedPrompts).toEqual(["Concurrent desktop prompt"])

      // Finish the concurrent turn so chat is idle, then retry with the SAME clientRequestId.
      // Because beforePromptCount is gone, K-slash-busy-1 must NOT be poisoned!
      h.finishAllTurns()
      await new Promise((resolve) => setTimeout(resolve, 40))

      await router.handleMessage(
        ws as never,
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: "command",
          id: "cmd-slash-retry",
          command: {
            type: "chat.send",
            chatId: slashChat.id,
            provider: "pi",
            content: "/review",
            clientRequestId: "K-slash-busy-1",
          },
        }),
      )
      expect(ws.sent).toContainEqual(
        expect.objectContaining({ type: "ack", id: "cmd-slash-retry", result: { chatId: slashChat.id } }),
      )
      expect(h.startedPrompts).toEqual(["Concurrent desktop prompt", "/review"])
      expect(
        h.store.getMessages(slashChat.id).filter((m) => m.kind === "user_prompt").at(-1),
      ).toMatchObject({ content: "/review", clientRequestId: "K-slash-busy-1" })

      // Finish /review and submit a native skill (/audit src/) via ws-router -> rewrites to "$audit src/"
      // while preserving clientRequestId on the persisted user_prompt.
      h.finishAllTurns()
      await new Promise((resolve) => setTimeout(resolve, 40))

      await router.handleMessage(
        ws as never,
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: "command",
          id: "cmd-skill-1",
          command: {
            type: "chat.send",
            chatId: slashChat.id,
            provider: "pi",
            content: "/audit src/",
            clientRequestId: "K-skill-restart-1",
          },
        }),
      )
      expect(ws.sent).toContainEqual(
        expect.objectContaining({ type: "ack", id: "cmd-skill-1", result: { chatId: slashChat.id } }),
      )
      expect(h.startedPrompts.at(-1)).toBe("$audit src/")
      expect(
        h.store.getMessages(slashChat.id).filter((m) => m.kind === "user_prompt").at(-1),
      ).toMatchObject({ content: "$audit src/", clientRequestId: "K-skill-restart-1" })

      // Simulate full host restart by reloading EventStore from disk with a fresh coordinator + ws-router.
      h.finishAllTurns()
      await new Promise((resolve) => setTimeout(resolve, 40))
      const reloadedStore = new EventStore(h.storePath)
      await reloadedStore.initialize()
      const restartedPrompts: string[] = []
      const reloadedCoordinator = new AgentCoordinator({
        store: reloadedStore,
        onStateChange() {},
        resolvePiConnection: async () => ({
          provider: "openai",
          model: "gpt-4o-mini",
          apiKey: "test-key",
          baseUrl: "http://127.0.0.1:1234/v1",
        }) as never,
        piManager: {
          startTurn: async (args: { content: string }) => {
            restartedPrompts.push(args.content)
            return makeControllableTurn().turn
          },
          prepareSession: async () => null,
          getCommandRuntime: () => nativeCommandRuntime,
          stopAll: async () => {},
          closeChat: () => {},
          dispose: () => {},
        } as never,
      })
      const reloadedRouter = createWsRouter({
        store: reloadedStore,
        agent: reloadedCoordinator,
        terminals: { onEvent: () => () => {}, getSnapshot: () => null, getTail: () => null } as never,
        keybindings: { onChange: () => () => {}, getSnapshot: () => ({ bindings: {}, warning: null, filePathDisplay: "" }) } as never,
        refreshDiscovery: async () => [],
        getDiscoveredProjects: () => [],
        machineDisplayName: "test-host",
        updateManager: null,
      })
      const wsRestart = new FakeWs()
      reloadedRouter.handleOpen(wsRestart as never)
      try {
        await reloadedRouter.handleMessage(
          wsRestart as never,
          JSON.stringify({
            v: PROTOCOL_VERSION,
            type: "command",
            id: "cmd-skill-restart-retry",
            command: {
              type: "chat.send",
              chatId: slashChat.id,
              provider: "pi",
              content: "/audit src/",
              clientRequestId: "K-skill-restart-1",
            },
          }),
        )
        expect(wsRestart.sent).toContainEqual(
          expect.objectContaining({ type: "ack", id: "cmd-skill-restart-retry", result: { chatId: slashChat.id } }),
        )
        expect(restartedPrompts).toHaveLength(0)
      } finally {
        reloadedRouter.dispose()
        await reloadedCoordinator.shutdownRuntime()
      }
    } finally {
      router.dispose()
      await h.cleanup()
    }
  })

  test("V-4: EventStore.forkChat strips user_prompt.clientRequestId so key reuse in the fork is not dropped as a duplicate", async () => {
    const h = await createDedupHarness()
    try {
      await h.coordinator.send({
        type: "chat.send",
        chatId: h.chat.id,
        provider: "pi",
        content: "Original prompt",
        clientRequestId: "K-fork-shared-1",
      })
      h.finishAllTurns()
      await new Promise((resolve) => setTimeout(resolve, 40))
      await h.store.setSessionToken(h.chat.id, "sess-fork-1")

      const forked = await h.store.forkChat(h.chat.id)
      const originalPrompts = h.store.getMessages(h.chat.id).filter((m) => m.kind === "user_prompt")
      const forkedPromptsInMemory = h.store.getMessages(forked.id).filter((m) => m.kind === "user_prompt")
      expect(originalPrompts[0]?.clientRequestId).toBe("K-fork-shared-1")
      expect(forkedPromptsInMemory[0]?.clientRequestId).toBeUndefined()

      // Verify on-disk transcript for the forked chat also omitted clientRequestId.
      const reloadedStore = new EventStore(h.storePath)
      await reloadedStore.initialize()
      const forkedPromptsOnDisk = reloadedStore.getMessages(forked.id).filter((m) => m.kind === "user_prompt")
      expect(forkedPromptsOnDisk[0]?.clientRequestId).toBeUndefined()

      // Submitting a prompt in the forked chat with the same clientRequestId within TTL executes normally.
      await h.coordinator.send({
        type: "chat.send",
        chatId: forked.id,
        provider: "pi",
        content: "Forked branch prompt",
        clientRequestId: "K-fork-shared-1",
      })
      expect(h.startedPrompts).toEqual(["Original prompt", "Forked branch prompt"])
      expect(
        h.store.getMessages(forked.id).filter((m) => m.kind === "user_prompt").at(-1),
      ).toMatchObject({ content: "Forked branch prompt", clientRequestId: "K-fork-shared-1" })
    } finally {
      await h.cleanup()
    }
  })

  test("V-5: invalidateMemoryGate on a parked memory_checkup emits memory_preparation_reset before recomputation finishes", async () => {
    const memDir = mkdtempSync(join(tmpdir(), "memosync-v5-checkup-"))
    const memory = new MemoryService({ dbPath: ":memory:", dataDir: memDir })
    memory.store.create({ content: "Always verify migrations", scope: "personal", type: "fact" }, { actor: "user" })

    let runCalls = 0
    let releaseSecondRun!: () => void
    const secondRunGate = new Promise<void>((resolve) => {
      releaseSecondRun = resolve
    })
    let secondRunEntered!: () => void
    const secondRunStarted = new Promise<void>((resolve) => {
      secondRunEntered = resolve
    })
    const memoryCheckup: CheckupService = {
      needsRecompute: () => true,
      run: async () => {
        runCalls += 1
        if (runCalls === 1) {
          return {
            suggestions: [{ kind: "staleness", memoryId: "M-01", reason: "Old suggestion" }],
            cached: false,
          }
        }
        secondRunEntered()
        await secondRunGate
        return {
          suggestions: [{ kind: "conflict", memoryId: "M-02", reason: "Refreshed suggestion" }],
          cached: false,
        }
      },
    }

    const h = await createDedupHarness({
      memory,
      memoryPreview: true,
      memoryCheckup,
      getMemoryPreviewSettings: () => ({ enabled: true, autoProceedWhenEmpty: true, confirmationMode: "every_turn" }),
    })
    try {
      await h.coordinator.send({
        type: "chat.send",
        chatId: h.chat.id,
        provider: "pi",
        content: "Check migrations",
      })
      const deadline = Date.now() + 2000
      while (!h.coordinator.pendingCheckupGates.has(h.chat.id) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(h.coordinator.pendingCheckupGates.has(h.chat.id)).toBe(true)
      const checkupParent = h.store.getMessages(h.chat.id).find((m) => m.kind === "memory_checkup") as Extract<
        TranscriptEntry,
        { kind: "memory_checkup" }
      >
      expect(checkupParent?.checkupId).toBeTruthy()

      // Invalidate the parked checkup gate -> host unparks pendingCheckupGates and MUST emit
      // memory_preparation_reset(from: "checkup", checkupId) before the second run settles.
      h.coordinator.invalidateMemoryGate({
        kind: "checkup",
        chatId: h.chat.id,
        gateId: checkupParent.checkupId,
      })
      await secondRunStarted
      expect(h.coordinator.pendingCheckupGates.has(h.chat.id)).toBe(false)
      const resets = h.store.getMessages(h.chat.id).filter((m) => m.kind === "memory_preparation_reset")
      expect(resets).toContainEqual(
        expect.objectContaining({
          kind: "memory_preparation_reset",
          from: "checkup",
          checkupId: checkupParent.checkupId,
          revision: 1,
        }),
      )

      // Release recomputation -> fresh memory_checkup_result lands and gate re-parks.
      releaseSecondRun()
      const reparkDeadline = Date.now() + 2000
      while (!h.coordinator.pendingCheckupGates.has(h.chat.id) && Date.now() < reparkDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(h.coordinator.pendingCheckupGates.has(h.chat.id)).toBe(true)
      const results = h.store.getMessages(h.chat.id).filter((m) => m.kind === "memory_checkup_result")
      expect(results.at(-1)).toMatchObject({
        checkupId: checkupParent.checkupId,
        suggestions: [{ kind: "conflict", memoryId: "M-02", reason: "Refreshed suggestion" }],
      })

      await h.coordinator.cancel(h.chat.id)
    } finally {
      releaseSecondRun()
      await h.cleanup()
      memory.close()
      rmSync(memDir, { recursive: true, force: true })
    }
  })

  test("F-1: pre-prompt startupCancelled() on direct chat.send and tombstoned queue cancellation do not poison clientRequestId", async () => {
    const h = await createDedupHarness()
    try {
      // 1. Direct chat.send cancelled BEFORE user_prompt append (while awaiting store.setPlanMode).
      const originalSetPlanMode = h.store.setPlanMode.bind(h.store)
      let enteredSetPlanMode!: () => void
      const setPlanModeEntered = new Promise<void>((resolve) => {
        enteredSetPlanMode = resolve
      })
      let releaseSetPlanMode!: () => void
      const setPlanModeGate = new Promise<void>((resolve) => {
        releaseSetPlanMode = resolve
      })
      let pauseOnce = true
      h.store.setPlanMode = async (chatId, planMode) => {
        if (pauseOnce && chatId === h.chat.id) {
          pauseOnce = false
          enteredSetPlanMode()
          await setPlanModeGate
        }
        return originalSetPlanMode(chatId, planMode)
      }

      const firstSend = h.coordinator.send({
        type: "chat.send",
        chatId: h.chat.id,
        provider: "pi",
        content: "Direct prompt cancelled before append",
        clientRequestId: "K-f1-direct",
      })
      await setPlanModeEntered
      // Concurrent retry arrives while Attempt 1 is still in startup before prompt append.
      const concurrentRetry = h.coordinator.send({
        type: "chat.send",
        chatId: h.chat.id,
        provider: "pi",
        content: "Direct prompt cancelled before append",
        clientRequestId: "K-f1-direct",
      })
      // A second simultaneous waiter exercises the multi-waiter fallthrough race:
      // both retry continuations wake from the same uncommitted inFlight promise.
      const concurrentRetry2 = h.coordinator.send({
        type: "chat.send",
        chatId: h.chat.id,
        provider: "pi",
        content: "Direct prompt cancelled before append",
        clientRequestId: "K-f1-direct",
      })
      const cancelDirect = h.coordinator.cancel(h.chat.id)
      releaseSetPlanMode()
      await Promise.all([firstSend, cancelDirect])
      await Promise.all([concurrentRetry, concurrentRetry2])
      // Wait for settleStartupReservation -> wakeQueue if concurrentRetry queued while cancel was settling.
      const wakeDeadline = Date.now() + 2000
      while (h.startedPrompts.length === 0 && Date.now() < wakeDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      // Attempt 1 returned without appending user_prompt; concurrentRetry fell through and ran it once!
      expect(h.startedPrompts).toEqual(["Direct prompt cancelled before append"])
      expect(
        h.store.getMessages(h.chat.id).filter((m) => m.kind === "user_prompt" && m.clientRequestId === "K-f1-direct"),
      ).toHaveLength(1)

      // Also test the sequential case: direct send cancelled pre-prompt, then user retries after reconnect.
      h.finishAllTurns()
      await new Promise((resolve) => setTimeout(resolve, 40))

      let enteredSeq!: () => void
      const seqEntered = new Promise<void>((resolve) => {
        enteredSeq = resolve
      })
      let releaseSeq!: () => void
      const seqGate = new Promise<void>((resolve) => {
        releaseSeq = resolve
      })
      let pauseSeq = true
      h.store.setPlanMode = async (chatId, planMode) => {
        if (pauseSeq && chatId === h.chat.id) {
          pauseSeq = false
          enteredSeq()
          await seqGate
        }
        return originalSetPlanMode(chatId, planMode)
      }

      const cancelledDirect = h.coordinator.send({
        type: "chat.send",
        chatId: h.chat.id,
        provider: "pi",
        content: "Retry after pre-prompt cancel",
        clientRequestId: "K-f1-direct-seq",
      })
      await seqEntered
      const cancelSeq = h.coordinator.cancel(h.chat.id)
      releaseSeq()
      await Promise.all([cancelledDirect, cancelSeq])
      expect(
        h.store.getMessages(h.chat.id).filter((m) => m.kind === "user_prompt" && m.clientRequestId === "K-f1-direct-seq"),
      ).toHaveLength(0)

      // Sequential retry with the SAME key must execute instead of acking as a no-op!
      await h.coordinator.send({
        type: "chat.send",
        chatId: h.chat.id,
        provider: "pi",
        content: "Retry after pre-prompt cancel",
        clientRequestId: "K-f1-direct-seq",
      })
      expect(h.startedPrompts).toContain("Retry after pre-prompt cancel")
      expect(
        h.store.getMessages(h.chat.id).filter((m) => m.kind === "user_prompt" && m.clientRequestId === "K-f1-direct-seq"),
      ).toHaveLength(1)

      // 2. Queued wake path: enqueue q1 while active, wake q1, cancel q1 BEFORE user_prompt append
      // so interrupted.cancelledQueuedMessageId tombstones q1; retrying K-f1-tombstone must execute!
      const queued = await h.coordinator.enqueue({
        type: "message.enqueue",
        chatId: h.chat.id,
        provider: "pi",
        content: "Queued prompt cancelled during wake",
        clientRequestId: "K-f1-tombstone",
      })
      let enteredWake!: () => void
      const wakeEntered = new Promise<void>((resolve) => {
        enteredWake = resolve
      })
      let releaseWake!: () => void
      const wakeGate = new Promise<void>((resolve) => {
        releaseWake = resolve
      })
      let pauseWake = true
      h.store.setPlanMode = async (chatId, planMode) => {
        if (pauseWake && chatId === h.chat.id) {
          pauseWake = false
          enteredWake()
          await wakeGate
        }
        return originalSetPlanMode(chatId, planMode)
      }

      // Finish active turn so wakeQueue starts q1 and hits the setPlanMode pause before user_prompt append.
      h.finishAllTurns()
      await wakeEntered
      const cancelWake = h.coordinator.cancel(h.chat.id)
      releaseWake()
      await cancelWake
      await new Promise((resolve) => setTimeout(resolve, 40))

      const tombstones = h.store
        .getMessages(h.chat.id)
        .filter((m) => m.kind === "interrupted" && m.cancelledQueuedMessageId === queued.queuedMessageId)
      expect(tombstones).toHaveLength(1)
      expect(
        h.store.getMessages(h.chat.id).filter((m) => m.kind === "user_prompt" && m.clientRequestId === "K-f1-tombstone"),
      ).toHaveLength(0)
      expect(h.store.getQueuedMessages(h.chat.id)).toHaveLength(0)

      // Retry with the SAME clientRequestId must NOT treat the tombstone as consumed!
      await h.coordinator.send({
        type: "chat.send",
        chatId: h.chat.id,
        provider: "pi",
        content: "Queued prompt cancelled during wake",
        clientRequestId: "K-f1-tombstone",
      })
      expect(h.startedPrompts).toContain("Queued prompt cancelled during wake")
      expect(
        h.store.getMessages(h.chat.id).filter((m) => m.kind === "user_prompt" && m.clientRequestId === "K-f1-tombstone"),
      ).toHaveLength(1)
    } finally {
      await h.cleanup()
    }
  })

  test("F-2: /compact via chat.send deduplicates while running/completed and clears clientRequestId if async compaction fails", async () => {
    const source = { api: "pi:native", version: "1.0.0", evidence: "native-response" as const }
    let compactCalls = 0
    let failFirstCompact = true
    let releaseSecondCompact!: () => void
    const secondCompactGate = new Promise<void>((resolve) => {
      releaseSecondCompact = resolve
    })
    const nativeCommandRuntime: NativeCommandRuntime = {
      instance: "pi-inst-compact",
      session: "pi-sess-compact",
      version: "1.0.0",
      alive: () => true,
      discover: async () => ({
        commands: discovery("ready", [], source),
        skills: discovery("ready", [], source),
        connectors: discovery("ready", [], source),
      }),
      compact: async () => {
        compactCalls += 1
        if (compactCalls === 1 && failFirstCompact) {
          throw new Error("Transient compact backend error")
        }
        await secondCompactGate
      },
      restore: async () => ({ delivery: "native-accepted" }),
    }
    const h = await createDedupHarness({ nativeCommandRuntime })
    try {
      await h.store.setChatProvider(h.chat.id, "pi")
      await h.coordinator.readCommandCatalog(h.chat.id, true, { provider: "pi" })

      // Attempt 1 starts compaction and fails asynchronously -> key must be cleared once failed!
      const attempt1 = (await h.coordinator.send({
        type: "chat.send",
        chatId: h.chat.id,
        provider: "pi",
        content: "/compact",
        clientRequestId: "K-compact-1",
      })) as { chatId: string; operationId?: string }
      expect(attempt1.operationId).toBeTruthy()
      const failDeadline = Date.now() + 2000
      while (h.coordinator.getCommandCatalog(h.chat.id).operation?.status === "running" && Date.now() < failDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(h.coordinator.getCommandCatalog(h.chat.id).operation?.status).toBe("failed")

      // Retry with the SAME clientRequestId after async failure MUST re-run compaction with a fresh operationId.
      failFirstCompact = false
      const attempt2 = (await h.coordinator.send({
        type: "chat.send",
        chatId: h.chat.id,
        provider: "pi",
        content: "/compact",
        clientRequestId: "K-compact-1",
      })) as { chatId: string; operationId?: string }
      expect(attempt2.operationId).toBeTruthy()
      expect(attempt2.operationId).not.toBe(attempt1.operationId)
      expect(compactCalls).toBe(2)

      // Retrying while Attempt 2 is still running deduplicates cleanly.
      const retryWhileRunning = (await h.coordinator.send({
        type: "chat.send",
        chatId: h.chat.id,
        provider: "pi",
        content: "/compact",
        clientRequestId: "K-compact-1",
      })) as { chatId: string; operationId?: string }
      expect(retryWhileRunning.operationId).toBe(attempt2.operationId)
      expect(compactCalls).toBe(2)

      // Finish Attempt 2 cleanly -> retrying after completion still deduplicates (never compacts a 3rd time).
      releaseSecondCompact()
      const completeDeadline = Date.now() + 2000
      while (h.coordinator.getCommandCatalog(h.chat.id).operation?.status === "running" && Date.now() < completeDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(h.coordinator.getCommandCatalog(h.chat.id).operation?.status).toBe("completed")

      const retryAfterComplete = (await h.coordinator.send({
        type: "chat.send",
        chatId: h.chat.id,
        provider: "pi",
        content: "/compact",
        clientRequestId: "K-compact-1",
      })) as { chatId: string; operationId?: string }
      expect(retryAfterComplete.operationId).toBe(attempt2.operationId)
      expect(compactCalls).toBe(2)
    } finally {
      releaseSecondCompact()
      await h.cleanup()
    }
  })

  test("F-3: payload mismatch on clientRequestId rejects with error, and projectId-only chat.send deduplicates across host restart", async () => {
    const h = await createDedupHarness()
    try {
      const created = await h.coordinator.send({
        type: "chat.send",
        projectId: h.project.id,
        provider: "pi",
        content: "Original project prompt",
        clientRequestId: "K-f3-proj-1",
      })

      // Reusing the same key with a DIFFERENT payload rejects rather than silently dropping!
      await expect(
        h.coordinator.send({
          type: "chat.send",
          chatId: created.chatId,
          provider: "pi",
          content: "Completely different prompt",
          clientRequestId: "K-f3-proj-1",
        }),
      ).rejects.toThrow("different message payload")

      // Simulate full host restart (cold in-memory dedup cache).
      h.finishAllTurns()
      await new Promise((resolve) => setTimeout(resolve, 30))
      const reloadedStore = new EventStore(h.storePath)
      await reloadedStore.initialize()
      const restartedPrompts: string[] = []
      const reloadedCoordinator = new AgentCoordinator({
        store: reloadedStore,
        onStateChange() {},
        resolvePiConnection: async () => ({
          provider: "openai",
          model: "gpt-4o-mini",
          apiKey: "test-key",
          baseUrl: "http://127.0.0.1:1234/v1",
        } as never),
        piManager: {
          startTurn: async (args: { content: string }) => {
            restartedPrompts.push(args.content)
            return makeControllableTurn().turn
          },
          stopAll: async () => {},
          dispose: () => {},
        } as never,
      })
      try {
        // Cold-cache projectId-only retry with matching content deduplicates to the created chat.
        const dedupedAfterRestart = await reloadedCoordinator.send({
          type: "chat.send",
          projectId: h.project.id,
          provider: "pi",
          content: "Original project prompt",
          clientRequestId: "K-f3-proj-1",
        })
        expect(dedupedAfterRestart).toEqual({ chatId: created.chatId })
        expect(restartedPrompts).toHaveLength(0)

        // Cold-cache projectId-only retry with mismatched payload rejects!
        await expect(
          reloadedCoordinator.send({
            type: "chat.send",
            projectId: h.project.id,
            provider: "pi",
            content: "Mismatched prompt after restart",
            clientRequestId: "K-f3-proj-1",
          }),
        ).rejects.toThrow("different message payload")
      } finally {
        await reloadedCoordinator.shutdownRuntime()
      }
    } finally {
      await h.cleanup()
    }
  })

  test("F-4: deriveChatSnapshot preserves clientRequestId on queuedMessages while stripping private hostClientId", async () => {
    const h = await createDedupHarness()
    try {
      await h.coordinator.send({
        type: "chat.send",
        chatId: h.chat.id,
        provider: "pi",
        content: "Active turn",
      })
      const queued = await h.coordinator.enqueue(
        {
          type: "message.enqueue",
          chatId: h.chat.id,
          provider: "pi",
          content: "Also update README",
          clientRequestId: "K-f4-queue-1",
        },
        "private-host-client-42",
      )
      const snapshot = deriveChatSnapshot(
        h.store.state,
        h.coordinator.getActiveStatuses(),
        h.coordinator.getDrainingChatIds(),
        h.chat.id,
        () => ({
          messages: h.store.getMessages(h.chat.id),
          history: { hasOlder: false, olderCursor: null, recentLimit: 200 },
        }),
      )
      expect(snapshot?.queuedMessages).toHaveLength(1)
      expect(snapshot?.queuedMessages[0]).toMatchObject({
        id: queued.queuedMessageId,
        content: "Also update README",
        clientRequestId: "K-f4-queue-1",
      })
      expect("hostClientId" in (snapshot?.queuedMessages[0] ?? {})).toBe(false)
    } finally {
      await h.cleanup()
    }
  })

  test("F-6: send -> steer retry reusing clientRequestId steers the existing queued row without duplicating it", async () => {
    const h = await createDedupHarness()
    try {
      // Desktop starts an active turn.
      await h.coordinator.send({
        type: "chat.send",
        chatId: h.chat.id,
        provider: "pi",
        content: "Long desktop turn",
      })
      // Mobile's chat.send lands in the queue without steering because the chat just became busy.
      const sentQueued = (await h.coordinator.send({
        type: "chat.send",
        chatId: h.chat.id,
        provider: "pi",
        content: "Urgent correction",
        clientRequestId: "K-f6-send-steer",
      })) as { chatId: string; queuedMessageId?: string; queued?: true }
      expect(sentQueued.queued).toBe(true)
      expect(sentQueued.queuedMessageId).toBeTruthy()
      expect(h.store.getQueuedMessages(h.chat.id)).toHaveLength(1)

      // Mobile reconnects, switches to Steer, and retries with the SAME clientRequestId.
      const steered = await h.coordinator.enqueueWithSteer({
        type: "message.enqueue",
        chatId: h.chat.id,
        provider: "pi",
        content: "Urgent correction",
        clientRequestId: "K-f6-send-steer",
        steer: true,
      })
      expect(steered.queuedMessageId).toBe(sentQueued.queuedMessageId!)
      expect(h.store.getQueuedMessages(h.chat.id)).toHaveLength(0)
      expect(h.startedPrompts).toHaveLength(2)
      expect(h.startedPrompts[1]).toContain("Urgent correction")
      const prompts = h.store.getMessages(h.chat.id).filter((m) => m.kind === "user_prompt")
      expect(prompts.filter((p) => p.clientRequestId === "K-f6-send-steer")).toHaveLength(1)

      // If a concurrent steer is still settling, the upgrade retry must preserve
      // the committed queued row and report success rather than failing the ack.
      const secondQueued = (await h.coordinator.send({
        type: "chat.send",
        chatId: h.chat.id,
        provider: "pi",
        content: "Second urgent correction",
        clientRequestId: "K-f6-still-running",
      })) as { queuedMessageId?: string }
      expect(secondQueued.queuedMessageId).toBeTruthy()
      const originalSteer = h.coordinator.steer.bind(h.coordinator)
      h.coordinator.steer = async () => {
        throw new Error("Chat is still running")
      }
      try {
        const stillQueuedRetry = await h.coordinator.enqueueWithSteer({
          type: "message.enqueue",
          chatId: h.chat.id,
          provider: "pi",
          content: "Second urgent correction",
          clientRequestId: "K-f6-still-running",
          steer: true,
        })
        expect(stillQueuedRetry.queuedMessageId).toBe(secondQueued.queuedMessageId!)
        expect(h.store.getQueuedMessage(h.chat.id, secondQueued.queuedMessageId!)).toBeTruthy()
      } finally {
        h.coordinator.steer = originalSteer
      }
    } finally {
      await h.cleanup()
    }
  })

  test("F-9: invalidateMemoryGate on a parked memory_transfer emits memory_transfer_result(done: false) before recomputation finishes", async () => {
    const memDir = mkdtempSync(join(tmpdir(), "memosync-f9-transfer-"))
    const memory = new MemoryService({ dbPath: ":memory:", dataDir: memDir })
    const sourceMemory = memory.store.create(
      { content: "Always check token expiry skew", scope: "personal", type: "fact" },
      { actor: "user" },
    )

    let runCalls = 0
    let releaseSecondRun!: () => void
    const secondRunGate = new Promise<void>((resolve) => {
      releaseSecondRun = resolve
    })
    let secondRunEntered!: () => void
    const secondRunStarted = new Promise<void>((resolve) => {
      secondRunEntered = resolve
    })

    const makeCard = (decoded: string) => ({
      sourceId: sourceMemory.id,
      sourceContent: sourceMemory.content,
      sourceScope: sourceMemory.scope,
      sourceVersion: sourceMemory.version,
      sourceLabel: "Personal",
      encoding: { rule: "Check token expiry skew", portable: true, note: "Portable auth rule" },
      decoding: {
        content: decoded,
        abstractionLevel: "concrete" as const,
        suggestedScope: "project" as const,
        landing: { route: "new" as const },
        note: "Localized auth transfer",
      },
    })

    const memoryTransferDetect: TransferDetectService = {
      hasSourceCandidates: () => true,
      prepareSources: async () => {},
      buildTaskForkPrompt: () => null,
      materializeTaskFromFork: async () => null,
      runTask: async () => {
        runCalls += 1
        if (runCalls === 1) {
          return { cards: [makeCard("Old transfer suggestion")], targetKey: "tk-1" }
        }
        secondRunEntered()
        await secondRunGate
        return { cards: [makeCard("Refreshed transfer suggestion")], targetKey: "tk-2" }
      },
      landingsStillCurrent: () => true,
      refreshLandingsIfTargetChanged: async (_ctx, current) => current,
    }

    const h = await createDedupHarness({
      memory,
      memoryPreview: true,
      memoryTransferDetect,
      getMemoryPreviewSettings: () => ({ enabled: true, autoProceedWhenEmpty: true, confirmationMode: "every_turn" }),
    })
    try {
      await h.coordinator.send({
        type: "chat.send",
        chatId: h.chat.id,
        provider: "pi",
        content: "Review auth token refresh",
      })
      const parkDeadline = Date.now() + 2000
      while (!h.coordinator.pendingTransferGates.has(h.chat.id) && Date.now() < parkDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(h.coordinator.pendingTransferGates.has(h.chat.id)).toBe(true)
      const transferParent = h.store.getMessages(h.chat.id).find((m) => m.kind === "memory_transfer") as Extract<
        TranscriptEntry,
        { kind: "memory_transfer" }
      >
      expect(transferParent?.transferId).toBeTruthy()

      // Invalidate the parked transfer gate -> host unparks pendingTransferGates and MUST emit
      // memory_transfer_result(done: false) before recomputation settles.
      h.coordinator.invalidateMemoryGate({
        kind: "transfer",
        chatId: h.chat.id,
        gateId: transferParent.transferId,
      })
      await secondRunStarted
      expect(h.coordinator.pendingTransferGates.has(h.chat.id)).toBe(false)
      const inProgressResults = h.store
        .getMessages(h.chat.id)
        .filter((m) => m.kind === "memory_transfer_result" && m.transferId === transferParent.transferId)
      expect(inProgressResults.at(-1)).toMatchObject({
        kind: "memory_transfer_result",
        transferId: transferParent.transferId,
        suggestions: [],
        done: false,
      })

      // Release recomputation -> done: true result lands and gate re-parks.
      releaseSecondRun()
      const reparkDeadline = Date.now() + 2000
      while (!h.coordinator.pendingTransferGates.has(h.chat.id) && Date.now() < reparkDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(h.coordinator.pendingTransferGates.has(h.chat.id)).toBe(true)
      const finalResults = h.store
        .getMessages(h.chat.id)
        .filter((m) => m.kind === "memory_transfer_result" && m.transferId === transferParent.transferId)
      expect(finalResults.at(-1)).toMatchObject({
        transferId: transferParent.transferId,
        done: true,
        suggestions: [expect.objectContaining({ content: "Refreshed transfer suggestion" })],
      })

      await h.coordinator.cancel(h.chat.id)
    } finally {
      releaseSecondRun()
      await h.cleanup()
      memory.close()
      rmSync(memDir, { recursive: true, force: true })
    }
  })
})
