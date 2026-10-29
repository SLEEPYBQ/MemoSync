import { describe, expect, test } from "bun:test"
import { enqueueAndMaybeSteer } from "./enqueue-and-steer"

describe("enqueueAndMaybeSteer", () => {
  test("queues by default, reuses steer when requested", async () => {
    const calls: string[] = []
    const dependencies = {
      enqueue: async () => { calls.push("enqueue"); return { queuedMessageId: "q1" } },
      steer: async (command: { queuedMessageId: string }) => { calls.push(`steer:${command.queuedMessageId}`) },
      isQueued: () => true, isRunning: () => true,
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
      isQueued: () => false, isRunning: () => true,
    }
    await expect(enqueueAndMaybeSteer(command, dependencies)).resolves.toEqual({ queuedMessageId: "q1" })
    await expect(enqueueAndMaybeSteer(command, { ...dependencies, isRunning: () => false })).rejects.toThrow("Queued message not found")
    await expect(enqueueAndMaybeSteer(command, { ...dependencies, isQueued: () => true })).rejects.toThrow("Queued message not found")
    await expect(enqueueAndMaybeSteer(command, { ...dependencies, steer: async () => { throw new Error("permission denied") } })).rejects.toThrow("permission denied")
  })
})
