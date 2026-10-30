import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentCoordinator } from "./agent"
import { EventStore } from "./event-store"
import { MemoryService } from "./memory"
import type { HarnessEvent } from "./harness-types"

const TIMEOUT = 30 * 60_000
class Queue implements AsyncIterable<HarnessEvent> {
  private values: HarnessEvent[] = []
  private waiting: ((item: IteratorResult<HarnessEvent>) => void) | undefined
  private closed = false
  push(value: HarnessEvent) {
    if (this.waiting) { const resolve = this.waiting; this.waiting = undefined; resolve({ value, done: false }) }
    else this.values.push(value)
  }
  close() { this.closed = true; this.waiting?.({ value: undefined, done: true }); this.waiting = undefined }
  [Symbol.asyncIterator](): AsyncIterator<HarnessEvent> {
    return { next: async () => this.values.length ? { value: this.values.shift()!, done: false }
      : this.closed ? { value: undefined, done: true } : await new Promise(resolve => { this.waiting = resolve }) }
  }
}
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function until(condition: () => boolean) {
  for (let n = 0; n < 200; n++) { if (condition()) return; await Bun.sleep(5) }
  throw new Error("Idle lifecycle did not reach expected state")
}

// Advance only the idle timers. Storage and stream continuations still run
// normally, so this exercises real coordinator scheduling without 30m sleeps.
const nativeTimeout = globalThis.setTimeout
const nativeClear = globalThis.clearTimeout
let now = 0
const timers = new Map<ReturnType<typeof setTimeout>, { at: number; run: () => void }>()
let timeoutSpy: ReturnType<typeof spyOn>
let clearSpy: ReturnType<typeof spyOn>
const cleanups: Array<() => Promise<void>> = []
beforeEach(() => {
  now = 0
  timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, delay: number, ...args: unknown[]) => {
    const timer = nativeTimeout(fn, delay, ...args) as ReturnType<typeof setTimeout>
    if (delay === TIMEOUT) timers.set(timer, { at: now + delay, run: fn })
    return timer
  }) as typeof setTimeout)
  clearSpy = spyOn(globalThis, "clearTimeout").mockImplementation(((timer: ReturnType<typeof setTimeout>) => {
    timers.delete(timer)
    nativeClear(timer)
  }) as typeof clearTimeout)
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  for (const timer of timers.keys()) nativeClear(timer)
  timers.clear()
  timeoutSpy.mockRestore()
  clearSpy.mockRestore()
})
async function advance(ms: number) {
  now += ms
  for (const [timer, task] of [...timers]) {
    if (task.at > now) continue
    timers.delete(timer)
    nativeClear(timer)
    task.run()
  }
  await Bun.sleep(10)
}
async function harness(provider: "claude" | "codex" = "claude", slowClose = false, overrides: Partial<ConstructorParameters<typeof AgentCoordinator>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "memosync-idle-"))
  const store = new EventStore(join(dir, "events"))
  await store.initialize()
  const project = await store.openProject(dir)
  const chat = await store.createChat(project.id)
  const sessions: Queue[] = []
  const prompts: string[] = []
  const tokens: Array<string | null> = []
  let closes = 0
  let codexLive = false
  let codexPending = false
  let branchWork = deferred()
  const coordinator = new AgentCoordinator({
    store, onStateChange() {}, claudeSessionFileExists: () => true,
    generateTitle: async () => ({ title: "idle test", usedFallback: true, failureMessage: null }),
    startClaudeSession: async args => {
      tokens.push(args.sessionToken)
      const queue = new Queue()
      sessions.push(queue)
      let closed = false
      return {
        provider: "claude", echoesPromptIds: true, stream: queue,
        close() { if (!closed) { closed = true; closes++; if (!slowClose) queue.close() } },
        interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {},
        sendPrompt: async (_content, context) => { prompts.push(context!.promptId!) },
      }
    },
    codexManager: {
      hasSession: () => codexLive,
      hasPendingWork: () => codexPending,
      startSession: async (args: any) => { tokens.push(args.sessionToken); codexLive = true; return "saved-token" },
      startTurn: async () => {
        const queue = new Queue(); sessions.push(queue); codexPending = true
        queue.push({ type: "session_token", sessionToken: "saved-token" })
        return { provider: "codex", stream: queue, interrupt: async () => {}, close: () => { codexPending = false; queue.close() } }
      },
      stopSession: () => { if (codexLive) { codexLive = false; closes++ } },
      stopAll() { codexLive = false },
    } as never,
    createMemoryBranch: () => ({ id: "branch", mode: "fork", sessionToken: "branch-token", dispose() {}, async ask() { await branchWork.promise; return {} } }),
    ...overrides,
  })
  cleanups.push(async () => { sessions.forEach(q => q.close()); await coordinator.shutdownRuntime(); rmSync(dir, { recursive: true, force: true }) })
  const send = () => coordinator.send({ type: "chat.send", chatId: chat.id, provider, content: "test", model: provider === "claude" ? "deepseek-v4-pro" : "gpt-5.4" })
  const finish = async () => {
    const queue = sessions.at(-1)!
    queue.push({ type: "session_token", sessionToken: "saved-token" })
    queue.push({ type: "transcript", promptIds: provider === "claude" ? [prompts.at(-1)!] : undefined,
      entry: { _id: crypto.randomUUID(), createdAt: Date.now(), kind: "result", subtype: "success", isError: false, durationMs: 1, result: "done" } })
    if (provider === "codex") { codexPending = false; queue.close() }
    await until(() => !coordinator.activeTurns.has(chat.id))
    await Bun.sleep(10)
  }
  return { coordinator, store, chat, sessions, tokens, send, finish, branchWork, closes: () => closes,
    setCodexPending: (value: boolean) => { codexPending = value } }
}

describe("idle provider sessions", () => {
  for (const provider of ["claude", "codex"] as const) {
    test(`${provider} closes at 30 idle minutes and the next send resumes the saved token`, async () => {
      const h = await harness(provider)
      await h.send()
      await advance(TIMEOUT * 2)
      expect(h.closes()).toBe(0)
      await h.finish()
      await advance(TIMEOUT - 1)
      expect(h.closes()).toBe(0)
      await advance(1)
      expect(h.closes()).toBe(1)
      expect(h.store.requireChat(h.chat.id).sessionToken).toBe("saved-token")
      await h.send()
      expect(h.tokens).toEqual([null, "saved-token"])
    })
  }

  test("a send during Claude idle close waits for the old pump before resuming", async () => {
    const h = await harness("claude", true)
    await h.send(); await h.finish(); await advance(TIMEOUT)
    expect(h.closes()).toBe(1)
    const sending = h.send()
    await Bun.sleep(10)
    expect(h.tokens).toHaveLength(1)
    h.sessions[0]!.close()
    await sending
    expect(h.tokens).toEqual([null, "saved-token"])
    expect(h.coordinator.activeTurns.has(h.chat.id)).toBe(true)
  })

  test("queued messages pin the session until removed and restart the full idle wait", async () => {
    const h = await harness()
    await h.send(); await h.finish()
    const queued = await h.coordinator.enqueue({ type: "message.enqueue", chatId: h.chat.id, content: "queued" })
    await advance(TIMEOUT * 2)
    expect(h.closes()).toBe(0)
    await h.coordinator.dequeue({ type: "message.dequeue", chatId: h.chat.id, queuedMessageId: queued.queuedMessageId })
    await advance(TIMEOUT - 1); expect(h.closes()).toBe(0)
    await advance(1); expect(h.closes()).toBe(1)
  })

  for (const blocker of ["pendingPreviews", "pendingProposalGates", "pendingTransferGates", "pendingCheckupGates", "activePreparations", "inFlightCheckups", "claimedPreviewResponses", "startingChats", "startupReservations", "drainingStreams"] as const) {
    test(`${blocker} blocks idle close even if work appeared after the timer started`, async () => {
      const h = await harness()
      await h.send(); await h.finish()
      const map = (h.coordinator as any)[blocker] as Map<string, unknown>
      map.set(h.chat.id, {})
      await advance(TIMEOUT * 2)
      expect(h.closes()).toBe(0)
      map.delete(h.chat.id)
      ;(h.coordinator as any).emitStateChange(h.chat.id)
      await advance(TIMEOUT)
      expect(h.closes()).toBe(1)
    })
  }

  test("overlapping post-turn memory passes pin until both finish, including rejected work", async () => {
    const h = await harness()
    const first = deferred(), second = deferred()
    let calls = 0
    ;(h.coordinator as any).runPostTurnMemoryPasses = async () => {
      if (++calls === 1) await first.promise
      else { await second.promise; throw new Error("simulated trace failure") }
    }
    await h.send(); await h.finish()
    expect(calls).toBe(1)
    ;(h.coordinator as any).launchPostTurnMemoryPasses({ chatId: h.chat.id })
    await advance(TIMEOUT * 2); expect(h.closes()).toBe(0)
    first.resolve(); await Bun.sleep(10)
    await advance(TIMEOUT * 2); expect(h.closes()).toBe(0)
    second.resolve(); await Bun.sleep(10)
    await advance(TIMEOUT - 1); expect(h.closes()).toBe(0)
    await advance(1); expect(h.closes()).toBe(1)
  })

  test("a disposed memory branch still pins its chat until its running ask settles", async () => {
    const h = await harness()
    await h.send(); await h.finish()
    const branch = (h.coordinator as any).newMemoryBranch({ chatId: h.chat.id, provider: "claude", model: "deepseek-v4-pro" }, "working-memory")
    const work = branch.ask("review")
    branch.dispose()
    await advance(TIMEOUT * 2); expect(h.closes()).toBe(0)
    h.branchWork.resolve(); await work
    await advance(TIMEOUT); expect(h.closes()).toBe(1)
  })

  test("capture and trace, then checkup and transfer preparation all finish before idle starts", async () => {
    const memoryDir = mkdtempSync(join(tmpdir(), "memosync-idle-memory-"))
    const memory = new MemoryService({ dbPath: ":memory:", dataDir: memoryDir })
    memory.store.create({ content: "Use Bun", scope: "personal", type: "fact" }, { actor: "user" })
    const capture = deferred(), trace = deferred(), checkup = deferred(), transfer = deferred()
    const entered: string[] = []
    const h = await harness("claude", false, {
      memory, memoryBranches: false,
      forkCapture: async () => null, forkTrace: async () => null, forkQuery: async () => null,
      capture: { async capture() { entered.push("capture"); await capture.promise; return { created: [], proposed: 0, surfaced: 0, dropped: 0, conflicts: 0, reinforced: 0, reinforcedIds: [], revisions: 0, pending: [] } } } as never,
      memoryTrace: { async trace() { entered.push("trace"); await trace.promise; return { labels: [] } } } as never,
      memoryCheckup: { needsRecompute: () => true, async run() { entered.push("checkup"); await checkup.promise } } as never,
      memoryTransferDetect: { async prepareSources() { entered.push("transfer"); await transfer.promise } } as never,
    })
    cleanups.push(async () => { memory.close(); rmSync(memoryDir, { recursive: true, force: true }) })
    await h.send(); await h.finish()
    await until(() => entered.includes("capture") && entered.includes("trace"))
    await advance(TIMEOUT); expect(h.closes()).toBe(0)
    capture.resolve(); await Bun.sleep(10)
    await advance(TIMEOUT); expect(h.closes()).toBe(0)
    trace.resolve()
    await until(() => entered.includes("checkup") && entered.includes("transfer"))
    await advance(TIMEOUT); expect(h.closes()).toBe(0)
    checkup.resolve(); await Bun.sleep(10)
    await advance(TIMEOUT); expect(h.closes()).toBe(0)
    transfer.resolve(); await Bun.sleep(10)
    await advance(TIMEOUT - 1); expect(h.closes()).toBe(0)
    await advance(1); expect(h.closes()).toBe(1)
  })

  test("Stop on a preview does not unpin its detached relevance computation", async () => {
    const memoryDir = mkdtempSync(join(tmpdir(), "memosync-idle-preview-"))
    const memory = new MemoryService({ dbPath: ":memory:", dataDir: memoryDir })
    memory.store.create({ content: "Use Bun", scope: "personal", type: "fact" }, { actor: "user" })
    const relevance = deferred()
    let previewEnabled = false, entered = false
    const h = await harness("claude", false, {
      memory, memoryBranches: false, memoryPreview: true,
      getMemoryPreviewSettings: () => ({ enabled: previewEnabled, autoProceedWhenEmpty: false }),
      memoryRelevance: { async assess() { entered = true; await relevance.promise; return [] } } as never,
    })
    cleanups.push(async () => { memory.close(); rmSync(memoryDir, { recursive: true, force: true }) })
    await h.send(); await h.finish()
    previewEnabled = true
    await h.send()
    await until(() => entered)
    await h.coordinator.cancel(h.chat.id)
    await advance(TIMEOUT * 2); expect(h.closes()).toBe(0)
    relevance.resolve(); await Bun.sleep(10)
    await advance(TIMEOUT); expect(h.closes()).toBe(1)
  })

  test("Codex pending provider work pins the session after the coordinator turn settled", async () => {
    const h = await harness("codex")
    await h.send(); await h.finish()
    h.setCodexPending(true)
    await advance(TIMEOUT); expect(h.closes()).toBe(0)
    h.setCodexPending(false)
    ;(h.coordinator as any).emitStateChange(h.chat.id)
    await advance(TIMEOUT); expect(h.closes()).toBe(1)
  })
})
