import { useCallback, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Loader2 } from "lucide-react"
import { useConditionPolicyResolved } from "../../lib/conditionApi"
import { canSkipGuide, completeStudyGuide, markGuideSeen } from "../../lib/guideState"
import { GuideTour } from "./GuideTour"
import { buildMemoSyncSteps } from "./guideJourneySteps"

/** MemoSync walkthrough, reachable from the sidebar and study onboarding. */
export function GuidePage() {
  const navigate = useNavigate()
  const policy = useConditionPolicyResolved()
  const [saveError, setSaveError] = useState<string | null>(null)

  const dismissDevelopmentGuide = useCallback(() => {
    markGuideSeen()
    navigate("/")
  }, [navigate])

  const finish = useCallback(() => {
    if (!policy?.studyMode) {
      dismissDevelopmentGuide()
      return
    }
    setSaveError(null)
    void completeStudyGuide()
      .then(() => navigate("/study"))
      .catch(() => setSaveError("Could not save your guide completion. Please retry or tell the experimenter."))
  }, [dismissDevelopmentGuide, navigate, policy])

  const tour = useMemo(() => {
    if (policy === null) return null
    return { brandName: "MemoSync", steps: buildMemoSyncSteps() }
  }, [policy])

  if (tour === null) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <>
      {saveError ? (
        <div className="fixed left-1/2 top-4 z-[100] -translate-x-1/2 rounded-lg border border-destructive/40 bg-background px-4 py-2 text-sm text-destructive shadow-lg">
          {saveError}
        </div>
      ) : null}
      <GuideTour
        brandName={tour.brandName}
        steps={tour.steps}
        onFinish={finish}
        onSkip={policy !== null && canSkipGuide(policy) ? dismissDevelopmentGuide : undefined}
      />
    </>
  )
}
