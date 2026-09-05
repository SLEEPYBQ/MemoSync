// The Board is the developer's externalized meta-level model of agent memory.
// N&N's model is DYNAMIC: the system carries the "what changed since I last
// looked" diff so the developer doesn't have to — otherwise the drift problem
// recurs one level up (the developer's model of the Board goes stale).
import type { MemoryItem } from "./memoriesApi"

const KEY = "memosync:memory-board-last-visit"

export function getLastBoardVisit(): number | null {
  try {
    const value = window.localStorage.getItem(KEY)
    const parsed = value ? Number(value) : NaN
    return Number.isFinite(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function markBoardVisit(timestampMs: number): void {
  try {
    window.localStorage.setItem(KEY, String(timestampMs))
  } catch {
    // private mode etc. — markers just stay off
  }
}

export function freshnessSince(
  item: Pick<MemoryItem, "createdAt" | "updatedAt">,
  lastVisitMs: number | null,
): "new" | "changed" | undefined {
  if (lastVisitMs === null) return undefined
  const created = Date.parse(item.createdAt)
  if (Number.isFinite(created) && created > lastVisitMs) return "new"
  const updated = Date.parse(item.updatedAt)
  if (Number.isFinite(updated) && updated > lastVisitMs) return "changed"
  return undefined
}
