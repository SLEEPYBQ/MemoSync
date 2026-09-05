/**
 * The single study authority for project-scoped mutations. A null response
 * admits the operation; participant-facing text refuses it. Read-only
 * project inspection does not consult this interface.
 */
export interface StudyProjectAccess {
  projectRefusal(projectId: string): string | null
}

