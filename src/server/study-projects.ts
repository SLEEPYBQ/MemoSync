// Study-project registrar (STUDY_PLAN §2.1 cross-project / T4): a participant's
// container hosts MULTIPLE project workspaces (warm-up C, project A, project B).
// The orchestrator provisions each workspace subdir and passes a STUDY_PROJECTS
// manifest; at boot the server registers each as a project (idempotently, via
// the same openProject path as a manual "add project") so they appear
// deterministically — no participant has to hand-add a project, which would
// introduce between-participant variance in a between-subjects study.
import { basename } from "node:path"
import { STUDY_TASKS, type StudyTask } from "../shared/studyTasks"
import { resolveLocalPath } from "./paths"

export interface StudyProjectSpec {
  localPath: string
  title: string
}

/** Minimal store surface this module needs (real EventStore satisfies it). */
export interface StudyProjectStore {
  openProject(localPath: string, title?: string): Promise<{ id: string; localPath: string; title: string }>
}

export interface RegisteredStudyProject {
  projectId: string
  localPath: string
  title: string
  starterReady: boolean
}

/**
 * Parse the STUDY_PROJECTS env value: a JSON array of {localPath, title?}.
 * Empty/absent → []. Malformed JSON or a non-array throws (a study misconfig
 * should fail loudly at boot, not silently drop the cross-project projects).
 */
export function parseStudyProjects(raw: string | undefined): StudyProjectSpec[] {
  if (!raw || !raw.trim()) return []
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed)) {
    throw new Error("STUDY_PROJECTS must be a JSON array of {localPath, title?}")
  }
  const specs: StudyProjectSpec[] = []
  const seenPaths = new Set<string>()
  for (const entry of parsed) {
    const localPath = typeof entry?.localPath === "string" ? entry.localPath.trim() : ""
    if (!localPath) continue
    if (seenPaths.has(localPath)) {
      // Two study projects on one localPath would register as ONE project
      // (openProject dedups by path) and silently invalidate cross-project.
      throw new Error(`Duplicate study-project localPath: ${JSON.stringify(localPath)}`)
    }
    seenPaths.add(localPath)
    const title = typeof entry?.title === "string" && entry.title.trim() ? entry.title.trim() : basename(localPath)
    specs.push({ localPath, title })
  }
  return specs
}

/** Register each study project (idempotent), preserving order. */
export async function registerStudyProjects(store: StudyProjectStore, specs: StudyProjectSpec[]) {
  const projects = []
  for (const spec of specs) {
    projects.push(await store.openProject(spec.localPath, spec.title))
  }
  return projects
}

/**
 * Bind the trusted STUDY_PROJECTS manifest to EventStore registrations once at
 * boot. Later prompt/snapshot admission consumes this exact id+path mapping;
 * it never rediscovers a project by basename from participant-visible state.
 */
export function resolveRegisteredStudyProjects(
  specs: readonly StudyProjectSpec[],
  registered: ReadonlyArray<{ id: string; localPath: string; title: string }>,
  isStarterReady: (slug: StudyTask["projectSlug"], localPath: string) => boolean,
): ReadonlyMap<StudyTask["projectSlug"], RegisteredStudyProject> {
  if (specs.length !== registered.length) {
    throw new Error(`Expected ${specs.length} registered study projects; received ${registered.length}`)
  }
  const slugs = [...new Set(STUDY_TASKS.map((task) => task.projectSlug))]
  const result = new Map<StudyTask["projectSlug"], RegisteredStudyProject>()

  for (const slug of slugs) {
    const indexes = specs
      .map((spec, index) => ({ spec, index }))
      .filter(({ spec }) => basename(resolveLocalPath(spec.localPath)) === slug)
    if (indexes.length !== 1) {
      throw new Error(`Expected exactly one registered study project for ${slug}; found ${indexes.length}`)
    }
    const { spec, index } = indexes[0]!
    const project = registered[index]!
    const expectedPath = resolveLocalPath(spec.localPath)
    if (project.localPath !== expectedPath) {
      throw new Error(`Study project ${slug} registered path mismatch: expected ${expectedPath}, received ${project.localPath}`)
    }
    result.set(slug, {
      projectId: project.id,
      localPath: expectedPath,
      title: project.title,
      starterReady: isStarterReady(slug, expectedPath),
    })
  }
  return result
}
