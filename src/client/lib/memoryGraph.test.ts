import { describe, expect, test } from "bun:test"
import { buildMemoryGraph, memoryGraphStructureKey, memoryNodeRadius } from "./memoryGraph"
import type { MemoryItem } from "./memoriesApi"

const memory = (overrides: Partial<MemoryItem>): MemoryItem => ({
  id: "M-1",
  content: "A fact",
  scope: "personal",
  status: "active",
  usageCount: 0,
  ...overrides,
} as MemoryItem)

const labels = {
  root: "You",
  personal: "Personal",
  projects: { p1: "Rentals" },
  chats: { c1: "Fix login" },
  chatProjects: { c1: "p1" },
}

describe("buildMemoryGraph", () => {
  test("hangs each memory off its scope, and a session off its project", () => {
    const { nodes, edges } = buildMemoryGraph([
      memory({ id: "M-1" }),
      memory({ id: "M-2", scope: "project", projectId: "p1" }),
      memory({ id: "M-3", scope: "session", sessionId: "c1" }),
    ], labels)

    expect(nodes.find((node) => node.id === "project:p1")?.label).toBe("Rentals")
    expect(edges).toContainEqual({ source: "personal", target: "M-1", kind: "structure" })
    expect(edges).toContainEqual({ source: "project:p1", target: "M-2", kind: "structure" })
    expect(edges).toContainEqual({ source: "project:p1", target: "session:c1", kind: "structure" })
    expect(edges).toContainEqual({ source: "session:c1", target: "M-3", kind: "structure" })
  })

  test("shows candidates, leaves archived memories off the map", () => {
    const { nodes } = buildMemoryGraph([
      memory({ id: "M-1", status: "candidate" }),
      memory({ id: "M-2", status: "archived" }),
    ], labels)

    expect(nodes.find((node) => node.id === "M-1")?.candidate).toBe(true)
    expect(nodes.some((node) => node.id === "M-2")).toBe(false)
  })

  test("draws relations only between memories that are on the map", () => {
    const { edges } = buildMemoryGraph([
      memory({ id: "M-1", relations: [{ type: "conflicts_with", targetId: "M-2" }, { type: "conflicts_with", targetId: "M-9" }] }),
      memory({ id: "M-2" }),
      memory({ id: "M-9", status: "archived" }),
    ] as MemoryItem[], labels)

    const relations = edges.filter((edge) => edge.kind === "relation")
    expect(relations).toEqual([{ source: "M-1", target: "M-2", kind: "relation" }])
  })

  test("keeps the structure key stable when only usage changes", () => {
    const before = buildMemoryGraph([memory({ usageCount: 1 })], labels)
    const after = buildMemoryGraph([memory({ usageCount: 8 })], labels)
    expect(memoryGraphStructureKey(after)).toBe(memoryGraphStructureKey(before))
  })

  test("grows with use but stays bounded", () => {
    expect(memoryNodeRadius(8)).toBeGreaterThan(memoryNodeRadius(0))
    expect(memoryNodeRadius(100000)).toBeLessThanOrEqual(9)
  })
})

test('focused topic graph preserves its immediate parent and omits higher ancestors', async () => {
  const { buildTopicGraph } = await import('./memoryGraph')
  const topics = [
    { id: 'a', name: 'A', parentId: null },
    { id: 'b', name: 'B', parentId: 'a' },
    { id: 'c', name: 'C', parentId: 'b' },
    { id: 'd', name: 'D', parentId: 'c' },
  ]
  const graph = buildTopicGraph([memory({ id: 'M-1', topicId: 'c' })], topics, { root: 'You', unclassified: 'Unclassified' }, 'c')
  expect(graph.nodes.map(node => node.id)).toEqual(['topic:b', 'topic:c', 'M-1', 'topic:d'])
  expect(graph.edges).toContainEqual({ source: 'topic:b', target: 'topic:c', kind: 'structure' })
  expect(graph.edges).toContainEqual({ source: 'topic:c', target: 'topic:d', kind: 'structure' })
  expect(graph.nodes.some(node => node.id === 'root')).toBe(false)
})
