import { type ReactNode, useEffect, useState } from "react"
import { Navigate, useLocation } from "react-router-dom"
import { Loader2 } from "lucide-react"
import { Button } from "../../components/ui/button"
import {
  isStudyPreSessionPath,
  resolveStudyRouteAccess,
  type StudyRouteProgress,
} from "./studyRouteGuard"

interface RouteCheck {
  checkedPathname: string | null
  errorPathname: string | null
  progress: StudyRouteProgress | null
}

function parseProgress(value: unknown): StudyRouteProgress | null {
  if (!value || typeof value !== "object") return null
  const progress = value as Partial<StudyRouteProgress>
  const validTaskId = progress.activeTaskId === null || typeof progress.activeTaskId === "string"
  const validFreezeState = progress.freezeState === null
    || progress.freezeState === "open"
    || progress.freezeState === "freezing"
    || progress.freezeState === "frozen"
  if (!validTaskId || typeof progress.postSessionPending !== "boolean" || !validFreezeState) return null
  return progress as StudyRouteProgress
}

/**
 * Fail-closed route owner for the study's irreversible post-session phase.
 * It sits above AppLayout so neither chat nor memory UI mounts while a Back
 * or SPA navigation is being checked against durable study progress.
 */
export function StudyRouteBoundary({
  enabled,
  children,
}: {
  enabled: boolean
  children: ReactNode
}) {
  const location = useLocation()
  const [retry, setRetry] = useState(0)
  const [check, setCheck] = useState<RouteCheck>({
    checkedPathname: null,
    errorPathname: null,
    progress: null,
  })

  useEffect(() => {
    if (!enabled) return
    const pathname = location.pathname
    // The Guide is a pre-session prerequisite. The server intentionally keeps
    // /api/study/progress closed until its receipt has been recorded, so this
    // boundary must not request progress while the Guide is the active route.
    if (isStudyPreSessionPath(pathname)) return
    const controller = new AbortController()

    void fetch("/api/study/progress", {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(`study progress request failed (${response.status})`)
      const body = await response.json() as { data?: unknown }
      const progress = parseProgress(body.data)
      if (!progress) throw new Error("study progress response was invalid")
      setCheck({ checkedPathname: pathname, errorPathname: null, progress })
    }).catch(() => {
      if (controller.signal.aborted) return
      setCheck({ checkedPathname: null, errorPathname: pathname, progress: null })
    })

    return () => controller.abort()
  }, [enabled, location.pathname, retry])

  if (!enabled) return children

  const access = resolveStudyRouteAccess({
    pathname: location.pathname,
    checkedPathname: check.checkedPathname,
    progress: check.progress,
  })

  if (access.kind === "redirect") {
    return <Navigate to={access.to} replace />
  }
  if (access.kind === "allow") return children

  const failed = check.errorPathname === location.pathname
  return (
    <div className="flex h-[100dvh] min-h-[100dvh] items-center justify-center bg-background px-6">
      {failed ? (
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <p className="text-sm text-destructive">Could not verify the current study step.</p>
          <Button variant="outline" onClick={() => setRetry((current) => current + 1)}>
            Try again
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Checking the current study step…
        </div>
      )}
    </div>
  )
}
