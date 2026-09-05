import type { StudyTask } from "../../shared/studyTasks"
import type { ConditionPolicy } from "./condition"
import type { MemoryService } from "../memory"
import { createAutoProjectCopyAdapter } from "../memory/auto-project-copy-adapter"
import type { SummaryService } from "../memory/summary"
import type { RegisteredStudyProject } from "../study-projects"
import { BaselineProjectCopyCoordinator, type NextSessionPreparer } from "./baseline-project-copy"
import { createStaticProjectCopyAdapter } from "./static-project-copy-adapter"
import type { StudyMemoryStore } from "./study-memory-store"

export interface StudyBaselineProjectCopyPreparerOptions {
  policy: ConditionPolicy
  store: StudyMemoryStore
  dataDir: string
  memory: MemoryService
  summaries: Pick<SummaryService, "get"> | null
  assignedProjects: ReadonlyMap<StudyTask["projectSlug"], RegisteredStudyProject>
}

export function createStudyBaselineProjectCopyPreparer(
  options: StudyBaselineProjectCopyPreparerOptions,
): NextSessionPreparer | null {
  if (!options.policy.studyMode || options.policy.condition === "memosync") return null
  if (options.policy.condition === "auto") {
    const summaries = options.summaries
    if (!summaries) {
      throw new Error("Study Auto requires its summary service before Project Copy can be enabled")
    }
    return new BaselineProjectCopyCoordinator({
      store: options.store,
      adapter: createAutoProjectCopyAdapter({
        memory: options.memory,
        summaries,
        resolveProject: (slug) => {
          if (slug !== "apartment" && slug !== "car") return undefined
          const project = options.assignedProjects.get(slug)
          return project
            ? { projectId: project.projectId, starterReady: project.starterReady }
            : undefined
        },
      }),
    })
  }
  return new BaselineProjectCopyCoordinator({
    store: options.store,
    adapter: createStaticProjectCopyAdapter({
      dataDir: options.dataDir,
      assignedProjects: options.assignedProjects,
    }),
  })
}
