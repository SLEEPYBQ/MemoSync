// The memory graph: a projection of the store, never a second source of truth.
// You → scope hubs (Personal, each project) → memories; a session hangs off its
// project when known. Relations between memories become their own edges.
import type { MemoryItem, MemoryScope } from "./memoriesApi"

export type MemoryGraphNodeKind = "root" | "hub" | "memory"
export type MemoryGraphEdgeKind = "structure" | "relation"

export interface MemoryGraphNode {
  id: string
  kind: MemoryGraphNodeKind
  /** Which hue the node wears; the root has none. */
  scope: MemoryScope | null
  label: string
  radius: number
  /** Present on memory nodes only. */
  item?: MemoryItem
  candidate?: boolean
}

export interface MemoryGraphEdge {
  source: string
  target: string
  kind: MemoryGraphEdgeKind
}

export interface MemoryGraphLabels {
  root: string
  personal: string
  projects: Record<string, string>
  chats: Record<string, string>
  chatProjects: Record<string, string>
}

export const MEMORY_GRAPH_ROOT_ID = "root"

/** Used memories grow, on a log scale so one hot memory can't dwarf the rest. */
export function memoryNodeRadius(usageCount: number): number {
  return 3.5 + Math.min(5.5, Math.log2(1 + Math.max(0, usageCount)) * 1.3)
}

export function buildMemoryGraph(items: MemoryItem[], labels: MemoryGraphLabels) {
  const nodes = new Map<string, MemoryGraphNode>()
  const edges: MemoryGraphEdge[] = []
  const edgeKeys = new Set<string>()

  const addEdge = (source: string, target: string, kind: MemoryGraphEdgeKind) => {
    const key = [source, target].sort().join("|")
    if (edgeKeys.has(key)) return
    edgeKeys.add(key)
    edges.push({ source, target, kind })
  }
  const projectHub = (projectId: string) => {
    const id = `project:${projectId}`
    if (!nodes.has(id)) {
      nodes.set(id, { id, kind: "hub", scope: "project", label: labels.projects[projectId] ?? projectId, radius: 7 })
      addEdge(MEMORY_GRAPH_ROOT_ID, id, "structure")
    }
    return id
  }
  const sessionHub = (sessionId: string) => {
    const id = `session:${sessionId}`
    if (!nodes.has(id)) {
      nodes.set(id, { id, kind: "hub", scope: "session", label: labels.chats[sessionId] ?? sessionId, radius: 5.5 })
      const projectId = labels.chatProjects[sessionId]
      addEdge(projectId ? projectHub(projectId) : MEMORY_GRAPH_ROOT_ID, id, "structure")
    }
    return id
  }

  nodes.set(MEMORY_GRAPH_ROOT_ID, { id: MEMORY_GRAPH_ROOT_ID, kind: "root", scope: null, label: labels.root, radius: 9 })
  nodes.set("personal", { id: "personal", kind: "hub", scope: "personal", label: labels.personal, radius: 7 })
  addEdge(MEMORY_GRAPH_ROOT_ID, "personal", "structure")

  // Only what the agent can use (or is being asked to): archived memories are not on the map.
  const live = items.filter((item) => item.status === "active" || item.status === "candidate")
  for (const item of live) {
    const parent = item.scope === "project" && item.projectId
      ? projectHub(item.projectId)
      : item.scope === "session" && item.sessionId
        ? sessionHub(item.sessionId)
        : item.scope === "personal"
          ? "personal"
          : MEMORY_GRAPH_ROOT_ID
    nodes.set(item.id, {
      id: item.id,
      kind: "memory",
      scope: item.scope,
      label: item.content,
      radius: memoryNodeRadius(item.usageCount),
      item,
      candidate: item.status === "candidate",
    })
    addEdge(parent, item.id, "structure")
  }

  const liveIds = new Set(live.map((item) => item.id))
  for (const item of live) {
    for (const relation of item.relations ?? []) {
      if (liveIds.has(relation.targetId) && relation.targetId !== item.id) addEdge(item.id, relation.targetId, "relation")
    }
  }

  return { nodes: [...nodes.values()], edges }
}

/** Stops the layout restarting on polls that changed nothing structural. */
export function memoryGraphStructureKey(graph: { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] }): string {
  return `${graph.nodes.map((node) => node.id).join(",")}#${graph.edges.map((edge) => `${edge.source}>${edge.target}`).join(",")}`
}
