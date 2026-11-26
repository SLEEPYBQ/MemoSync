import { describe, expect, test } from "bun:test"
import { enqueueAndMaybeSteer } from "./enqueue-and-steer"

describe("enqueueAndMaybeSteer", () => {
  test("queues by default, reuses steer when requested", async () => {
    const calls: string[] = []
    const dependencies = {
      enqueue: async () => { calls.push("enqueue"); return { queuedMessageId: "q1" } },
      steer: async (command: { queuedMessageId: string }) => { calls.push(`steer:${command.queuedMessageId}`) },
      isQueued: () => true, isRunning: () => true, remove: async () => {},
    }
    const command = { type: "message.enqueue" as const, chatId: "c1", content: "hello" }
    await enqueueAndMaybeSteer(command, dependencies)
    expect(calls).toEqual(["enqueue"])
    calls.length = 0
    expect(await enqueueAndMaybeSteer({ ...command, steer: true }, dependencies)).toEqual({ queuedMessageId: "q1" })
    expect(calls).toEqual(["enqueue", "steer:q1"])
  })
  test("accepts auto-drain winning the race, but preserves genuine errors", async () => {
    const command = { type: "message.enqueue" as const, chatId: "c1", content: "hello", steer: true }
    const dependencies = {
      enqueue: async () => ({ queuedMessageId: "q1" }),
      steer: async () => { throw new Error("Queued message not found") },
      isQueued: () => false, isRunning: () => true, remove: async () => {},
    }
    await expect(enqueueAndMaybeSteer(command, dependencies)).resolves.toEqual({ queuedMessageId: "q1" })
    await expect(enqueueAndMaybeSteer(command, { ...dependencies, isRunning: () => false })).rejects.toThrow("Queued message not found")
    await expect(enqueueAndMaybeSteer(command, { ...dependencies, steer: async () => { throw new Error("permission denied") } })).rejects.toThrow("permission denied")
  })
  test("a steer that fails while the message stays queued succeeds as an enqueue, so a retry can't duplicate it", async () => {
    const queue = new Set<string>()
    let next = 0
    const dependencies = {
      enqueue: async () => { const id = `q${++next}`; queue.add(id); return { queuedMessageId: id } },
      // Steer re-checks after cancelling and refuses before touching the queue.
      steer: async () => { throw new Error("Chat is still running") },
      isQueued: (_chatId: string, id: string) => queue.has(id),
      isRunning: () => true,
      remove: async (_chatId: string, id: string) => { queue.delete(id) },
    }
    const command = { type: "message.enqueue" as const, chatId: "c1", content: "hello", steer: true }
    await expect(enqueueAndMaybeSteer(command, dependencies)).resolves.toEqual({ queuedMessageId: "q1" })
    expect([...queue]).toEqual(["q1"])
  })
  test("a steer refused for any other reason removes the queued copy before rejecting", async () => {
    const queue = new Set<string>()
    const dependencies = {
      enqueue: async () => { queue.add("q1"); return { queuedMessageId: "q1" } },
      // e.g. an admission check refusing the prompt before it touches the queue
      steer: async () => { throw new Error("Prompt not allowed") },
      isQueued: (_chatId: string, id: string) => queue.has(id),
      isRunning: () => false,
      remove: async (_chatId: string, id: string) => { queue.delete(id) },
    }
    const command = { type: "message.enqueue" as const, chatId: "c1", content: "hello", steer: true }
    await expect(enqueueAndMaybeSteer(command, dependencies)).rejects.toThrow("Prompt not allowed")
    expect(queue.size).toBe(0)
  })
  test("a deduplicated enqueue skips steer and returns the original queuedMessageId", async () => {
    let steerCalls = 0
    const dependencies = {
      enqueue: async () => ({ queuedMessageId: "q1", deduplicated: true as const }),
      steer: async () => { steerCalls += 1; throw new Error("must not steer again") },
      isQueued: () => false,
      isRunning: () => false,
      remove: async () => {},
    }
    const command = { type: "message.enqueue" as const, chatId: "c1", content: "hello", clientRequestId: "k1", steer: true }
    await expect(enqueueAndMaybeSteer(command, dependencies)).resolves.toEqual({ queuedMessageId: "q1" })
    expect(steerCalls).toBe(0)
  })
  test("a rolled-back steer removes the row and forgets its key so a deliberate resend succeeds", async () => {
    const queue = new Map<string, string>()
    const seenKeys = new Map<string, string>()
    let next = 0
    let failFirstSteer = true
    const dependencies = {
      enqueue: async (cmd: { clientRequestId?: string }) => {
        if (cmd.clientRequestId && seenKeys.has(cmd.clientRequestId)) {
          return { queuedMessageId: seenKeys.get(cmd.clientRequestId)!, deduplicated: true as const }
        }
        const id = `q${++next}`
        queue.set(id, cmd.clientRequestId ?? "")
        if (cmd.clientRequestId) seenKeys.set(cmd.clientRequestId, id)
        return { queuedMessageId: id }
      },
      steer: async () => {
        if (failFirstSteer) {
          failFirstSteer = false
          throw new Error("Steer refused")
        }
      },
      isQueued: (_chatId: string, id: string) => queue.has(id),
      isRunning: () => false,
      remove: async (_chatId: string, id: string) => {
        const key = queue.get(id)
        queue.delete(id)
        if (key) seenKeys.delete(key)
      },
    }
    const command = { type: "message.enqueue" as const, chatId: "c1", content: "hello", clientRequestId: "k-steer", steer: true }
    await expect(enqueueAndMaybeSteer(command, dependencies)).rejects.toThrow("Steer refused")
    expect(queue.size).toBe(0)
    await expect(enqueueAndMaybeSteer(command, dependencies)).resolves.toEqual({ queuedMessageId: "q2" })
  })
})
