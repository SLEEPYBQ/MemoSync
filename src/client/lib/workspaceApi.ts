// Read-only workspace metadata (id → title maps) for surfaces that live
// outside a chat's ws state — e.g. Memory Board origin labels.
import { notifyIfUnauthorized } from "./authGuard"
async function fetchLabelMap(path: string): Promise<Record<string, string>> {
  const res = await fetch(path)
  notifyIfUnauthorized(res)
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`)
  const { data } = (await res.json()) as { data: Array<{ id: string; title: string }> }
  const map: Record<string, string> = {}
  for (const entry of data) map[entry.id] = entry.title
  return map
}

export const workspaceApi = {
  projectTitles: () => fetchLabelMap("/api/projects"),
  chatTitles: () => fetchLabelMap("/api/chats"),
  chatProjectIds,
}

let chatProjectsCache: { at: number; map: Record<string, string> } | null = null

/** chatId → projectId map (cached ~60s) — for components outside the ws state. */
async function chatProjectIds(): Promise<Record<string, string>> {
  if (chatProjectsCache && Date.now() - chatProjectsCache.at < 60_000) return chatProjectsCache.map
  const res = await fetch("/api/chats")
  notifyIfUnauthorized(res)
  if (!res.ok) throw new Error(`GET /api/chats failed: ${res.status}`)
  const { data } = (await res.json()) as { data: Array<{ id: string; projectId: string }> }
  const map: Record<string, string> = {}
  for (const chat of data) map[chat.id] = chat.projectId
  chatProjectsCache = { at: Date.now(), map }
  return map
}
