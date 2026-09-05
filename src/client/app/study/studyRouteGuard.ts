export interface StudyRouteProgress {
  activeTaskId: string | null
  postSessionPending: boolean
  freezeState: "open" | "freezing" | "frozen" | null
}

export type StudyRouteAccess =
  | { kind: "allow" }
  | { kind: "wait" }
  | { kind: "redirect"; to: string }

interface StudyRouteAccessInput {
  pathname: string
  checkedPathname: string | null
  progress: StudyRouteProgress | null
}

export function isStudyQuestionnairePath(pathname: string): boolean {
  return /^\/study\/[^/]+\/quiz\/?$/.test(pathname)
}

/** The Guide is the durable prerequisite before any task-progress record. */
export function isStudyPreSessionPath(pathname: string): boolean {
  return pathname === "/guide"
}

/**
 * Keep post-session measurement behind one route decision. A route is only
 * eligible to render after progress was checked for that exact pathname, so
 * browser Back cannot briefly reveal the chat while a fresh request runs.
 */
export function resolveStudyRouteAccess(input: StudyRouteAccessInput): StudyRouteAccess {
  if (isStudyPreSessionPath(input.pathname)) return { kind: "allow" }
  if (input.checkedPathname !== input.pathname || input.progress === null) {
    // A questionnaire route is already a full-screen, non-chat surface. Keep
    // it usable as the recovery path even if the progress request is slow or
    // unavailable; a later successful check can still correct a stale task id.
    return isStudyQuestionnairePath(input.pathname) ? { kind: "allow" } : { kind: "wait" }
  }

  const measurementOwnsRoute = input.progress.postSessionPending || input.progress.freezeState === "freezing"
  if (measurementOwnsRoute && input.progress.activeTaskId) {
    const questionnairePath = `/study/${encodeURIComponent(input.progress.activeTaskId)}/quiz`
    if (input.pathname !== questionnairePath) {
      return { kind: "redirect", to: questionnairePath }
    }
  }

  return { kind: "allow" }
}
