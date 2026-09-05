import { resolve } from "node:path"
import { parseStudyProjects } from "./study-projects"

/**
 * Build the environment inherited by project-owned shells. Matching is bound
 * to the trusted STUDY_PROJECTS manifest, not a basename lookalike. With the
 * study orchestrator retired the per-participant Postgres wiring is gone;
 * assigned study projects keep only the benchmark-starter runtime tweaks.
 */
export function studyProjectSubprocessEnv(
  baseEnv: Readonly<Record<string, string | undefined>>,
  projectPath: string,
  rawStudyProjects: string | undefined,
): Record<string, string | undefined> {
  const assigned = parseStudyProjects(rawStudyProjects)
    .some((project) => resolve(project.localPath) === resolve(projectPath))
  if (!assigned) return { ...baseEnv }

  const env: Record<string, string | undefined> = {
    ...baseEnv,
    // MemoSync itself listens on PORT=3210 and NODE_ENV=production. Neither
    // setting belongs to the benchmark app: the starter expects frontend 3000,
    // backend .env PORT=3001, dev dependencies, and TypeORM synchronization.
    NODE_ENV: "development",
    npm_config_include: "dev",
    // The canonical Next 15 starter pins turbopack.root to the frontend while
    // the immutable image seed lives under /opt. Widening only the container's
    // output-tracing root lets Turbopack resolve that runtime-only dependency
    // path without changing scoreable next.config.ts or copying node_modules.
    NEXT_PRIVATE_OUTPUT_TRACE_ROOT: "/",
  }
  delete env.PORT
  return env
}
