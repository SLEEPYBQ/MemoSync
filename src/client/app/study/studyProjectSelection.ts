interface ProjectRow {
  groupKey: string
}

/** Match only the exact server-issued EventStore project identity. */
export function findAssignedStudyProject<T extends ProjectRow>(projects: readonly T[], projectId: string): T | null {
  return projects.find((project) => project.groupKey === projectId) ?? null
}
