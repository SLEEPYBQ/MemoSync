// Pure logic for the landing page (LocalDev connected view): which project the
// composer targets, what the hero headline says, and the memory-card counts.
import type { MemoryItem } from "./memoriesApi"
import { isMemoryScope } from "./memoryCitations"

export function resolveLandingProjectPath(projectPaths: string[], pickedPath: string | null): string | null {
  if (pickedPath && projectPaths.includes(pickedPath)) return pickedPath
  return projectPaths[0] ?? null
}

export function landingHeadline(projectName: string | null): string {
  return projectName ? `What should we build in ${projectName}?` : "Add a project to get started"
}

export interface LandingMemorySummary {
  active: number
  candidates: number
  byScope: { personal: number; project: number; session: number }
}

export function summarizeMemoriesForLanding(
  items: Array<Pick<MemoryItem, "status" | "scope">>
): LandingMemorySummary {
  const summary: LandingMemorySummary = {
    active: 0,
    candidates: 0,
    byScope: { personal: 0, project: 0, session: 0 },
  }
  for (const item of items) {
    if (item.status === "candidate") {
      summary.candidates += 1
      continue
    }
    if (item.status !== "active") continue
    summary.active += 1
    summary.byScope[isMemoryScope(item.scope) ? item.scope : "session"] += 1
  }
  return summary
}
