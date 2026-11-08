import { normalizeTopicName } from "../../shared/memory-topics"
import { memoryMatchesLens, type MemoryLens } from "../components/memory/MemoryExplorer"
import { memoriesApi, type MemoryItem, type MemoryTopicAssignment, type TopicAssignmentTarget } from "./memoriesApi"

export type TopicFilter = "all" | "unclassified" | string
export type TopicStatusFilter = "all" | "active" | "candidate" | "archived"

export function filterTopicMemories(items: MemoryItem[], filters: {
  topic: TopicFilter; status: TopicStatusFilter; lens: MemoryLens; query: string; topics?: Array<{ id: string; parentId: string | null }>
}): MemoryItem[] {
  const query = filters.query.trim().toLowerCase()
  const included = new Set([filters.topic])
  let changed = true
  while (changed) {
    changed = false
    for (const topic of filters.topics ?? []) if (topic.parentId && included.has(topic.parentId) && !included.has(topic.id)) { included.add(topic.id); changed = true }
  }
  return items.filter(item => {
    if (item.status === "discarded") return false
    if (filters.lens.kind === "archived" ? item.status !== "archived" : !memoryMatchesLens(item, filters.lens)) return false
    if (filters.status !== "all" && item.status !== filters.status) return false
    if (filters.topic === "unclassified" ? Boolean(item.topicId) : filters.topic !== "all" && (!item.topicId || !included.has(item.topicId))) return false
    return !query || item.content.toLowerCase().includes(query) || (item.detail ?? "").toLowerCase().includes(query)
  })
}

/** A topic can be moved to the root or beneath a topic outside its own subtree. */
export function canMoveTopic(topics: Array<{ id: string; parentId?: string | null }>, id: string, parentId: string | null): boolean {
  if (!topics.some(topic => topic.id === id)) return false
  const byId = new Map(topics.map(topic => [topic.id, topic]))
  const visited = new Set<string>()
  let current = parentId
  while (current) {
    if (current === id || visited.has(current)) return false
    visited.add(current)
    const topic = byId.get(current)
    if (!topic) return false
    current = topic.parentId ?? null
  }
  return true
}

/** Keep receipts from completed chunks and stop after transport failure. A created
 * topic is addressed by ID for all later chunks and retries. */
export async function assignMemoryTopics(
  ids: string[],
  target: TopicAssignmentTarget,
  assign: typeof memoriesApi.assignTopic = memoriesApi.assignTopic,
): Promise<MemoryTopicAssignment & { targetKnown: boolean }> {
  let current: TopicAssignmentTarget = "name" in target ? { name: normalizeTopicName(target.name) } : target
  let topicId = "topicId" in current ? current.topicId : null
  let targetKnown = "topicId" in current
  const results: MemoryTopicAssignment["results"] = []
  const uniqueIds = [...new Set(ids)]
  for (let offset = 0; offset < uniqueIds.length; offset += 500) {
    const chunk = uniqueIds.slice(offset, offset + 500)
    try {
      const response = await assign({ ids: chunk, ...current })
      topicId = response.topicId
      targetKnown = true
      current = { topicId }
      const receipts = new Map(response.results.map(result => [result.id, result]))
      results.push(...chunk.map(id => receipts.get(id) ?? { id, status: "unprocessed" as const }))
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      results.push(...chunk.map(id => ({ id, status: "failed" as const, error })))
      results.push(...uniqueIds.slice(offset + 500).map(id => ({ id, status: "unprocessed" as const })))
      break
    }
  }
  return { topicId, results, targetKnown }
}
