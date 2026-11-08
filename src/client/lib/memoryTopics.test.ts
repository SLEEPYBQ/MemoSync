import { describe, expect, test } from "bun:test"
import { normalizeTopicName, topicNameKey } from "../../shared/memory-topics"
import { assignMemoryTopics, filterTopicMemories } from "./memoryTopics"
import type { MemoryItem } from "./memoriesApi"

describe("user memory topics", () => {
  test("normalizes whitespace, Unicode, and case identically for reuse", () => {
    expect(normalizeTopicName("  Cafe\u0301  ")).toBe("Café")
    expect(topicNameKey(" CAFÉ ")).toBe(topicNameKey("cafe\u0301"))
  })
  test("combines user topic, status, project lens and search without using legacy topic", () => {
    const items = [
      { id: "a", topicId: "t", topic: "legacy", status: "candidate", scope: "project", projectId: "p", content: "test" },
      { id: "b", topicId: "t", status: "active", scope: "project", projectId: "p", content: "test" },
      { id: "c", topicId: "t", status: "candidate", scope: "project", projectId: "q", content: "test" },
      { id: "d", topic: "t", status: "candidate", scope: "project", projectId: "p", content: "test" },
    ] as MemoryItem[]
    expect(filterTopicMemories(items, { topic: "t", status: "candidate", lens: { kind: "project", id: "p" }, query: "test" }).map(i => i.id)).toEqual(["a"])
    expect(filterTopicMemories(items, { topic: "unclassified", status: "all", lens: { kind: "all" }, query: "" }).map(i => i.id)).toEqual(["d"])
  })
  test("chunks large selections and reuses the returned topic ID after creation", async () => {
    const calls: unknown[] = []
    const ids = Array.from({ length: 501 }, (_, i) => `synthetic-${i}`)
    const result = await assignMemoryTopics(ids, { name: " Test " }, async body => {
      calls.push(body)
      return { topicId: "stable", results: body.ids.map(id => ({ id, status: id === "synthetic-2" ? "failed" : "success" })) }
    })
    expect(calls).toEqual([{ ids: ids.slice(0, 500), name: "Test" }, { ids: ids.slice(500), topicId: "stable" }])
    expect(result.results.filter(r => r.status === "failed").map(r => r.id)).toEqual(["synthetic-2"])
    const retry = result.results.filter(r => r.status === "failed").map(r => r.id)
    await assignMemoryTopics(retry, { topicId: result.topicId! }, async body => {
      expect(body).toEqual({ ids: ["synthetic-2"], topicId: "stable" })
      return { topicId: "stable", results: [{ id: "synthetic-2", status: "success" }] }
    })
  })
  test("retains successful chunks and marks remaining IDs unprocessed after transport failure", async () => {
    const ids = Array.from({ length: 1001 }, (_, i) => `synthetic-${i}`)
    let calls = 0
    const result = await assignMemoryTopics(ids, { topicId: "stable" }, async body => {
      if (++calls === 2) throw new Error("offline")
      return { topicId: "stable", results: body.ids.map(id => ({ id, status: "success" })) }
    })
    expect(result.results.filter(r => r.status === "success")).toHaveLength(500)
    expect(result.results.filter(r => r.status === "failed")).toHaveLength(500)
    expect(result.results.filter(r => r.status === "unprocessed").map(r => r.id)).toEqual(["synthetic-1000"])
    expect(result.topicId).toBe("stable")
  })
})
