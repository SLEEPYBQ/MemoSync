import { type ReactNode, useEffect, useState } from "react"
import { Navigate, useLocation } from "react-router-dom"
import { Loader2 } from "lucide-react"
import { Button } from "../../../components/ui/button"
import { loadStudyOnboarding, type StudyOnboardingStage } from "./onboardingApi"
import { resolveOnboardingRouteAccess } from "./onboardingRouteGuard"

interface OnboardingCheck {
  checkedPathname: string | null
  errorPathname: string | null
  stage: StudyOnboardingStage | null
}

/**
 * Server-backed client route ownership for onboarding. The server remains the
 * security authority; this removes the visible SPA bypass while the durable
 * state is rechecked after every navigation.
 */
export function OnboardingRouteBoundary({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const location = useLocation()
  const [retry, setRetry] = useState(0)
  const [check, setCheck] = useState<OnboardingCheck>({ checkedPathname: null, errorPathname: null, stage: null })

  useEffect(() => {
    if (!enabled) return
    const pathname = location.pathname
    const controller = new AbortController()
    void loadStudyOnboarding((url, init) => fetch(url, { ...init, signal: controller.signal }))
      .then((state) => setCheck({ checkedPathname: pathname, errorPathname: null, stage: state.stage }))
      .catch(() => {
        if (!controller.signal.aborted) setCheck({ checkedPathname: null, errorPathname: pathname, stage: null })
      })
    return () => controller.abort()
  }, [enabled, location.pathname, retry])

  if (!enabled) return children
  const access = resolveOnboardingRouteAccess({
    pathname: location.pathname,
    checkedPathname: check.checkedPathname,
    stage: check.stage,
  })
  if (access.kind === "redirect") return <Navigate to={access.to} replace />
  if (access.kind === "allow") return children

  const failed = check.errorPathname === location.pathname
  return (
    <div className="flex h-[100dvh] min-h-[100dvh] items-center justify-center bg-background px-6">
      {failed ? (
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <p className="text-sm text-destructive">Could not verify your study onboarding. Please retry or ask the experimenter for help.</p>
          <Button variant="outline" onClick={() => setRetry((value) => value + 1)}>Try again</Button>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading study onboarding…
        </div>
      )}
    </div>
  )
}
