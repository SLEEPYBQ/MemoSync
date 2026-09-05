// The study's ALWAYS-VISIBLE strip inside the main app shell (study arms
// only). Participants never have to find anything: when a session becomes
// active, its instructions OPEN THEMSELVES once (and stay one click away in
// every state afterwards); the one button that matters next is pinned beside
// them. Only the quiz takes over the screen — that page must not allow
// looking back.
import { useCallback, useEffect, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { BookOpen, Check, ClipboardList, Loader2 } from "lucide-react"
import { Button } from "../../components/ui/button"
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogTitle } from "../../components/ui/dialog"
import { useConditionPolicy } from "../../lib/conditionApi"
import { getStudyTask, type StudyTaskStatus } from "../../../shared/studyTasks"
import { ProtectedStudyInstructions } from "./ProtectedStudyInstructions"
import { STUDY_COMPLETION_MESSAGE } from "./studyCompletionCopy"

interface ProgressResponse {
  tasks: Array<{ id: string; title: string; status: StudyTaskStatus }>
  activeTaskId: string | null
  questionnairePending: boolean
  postSessionPending: boolean
  susPending: boolean
  studyComplete: boolean
}

interface ActiveTaskBrief {
  brief: string[]
  projectSlug: string
  projectTitle: string
  starterReady: boolean
  briefAcknowledged: boolean
}

export function studyBriefDialogAction(briefAcknowledged: boolean | undefined) {
  return briefAcknowledged
    ? { label: "Return to session", navigateToSetup: false }
    : { label: "Review assignment and open project", navigateToSetup: true }
}

export function StudyDockLoadingStatus({
  error,
  onRetry,
}: {
  error: string | null
  onRetry: () => void
}) {
  return (
    <div className="border-b border-border bg-muted/40">
      <div className="flex min-h-10 items-center gap-3 px-4 py-1.5">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
          <ClipboardList className="h-3.5 w-3.5" /> Study
        </span>
        {error ? (
          <>
            <span className="text-sm text-destructive">Could not load the study controls ({error}).</span>
            <Button className="ml-auto" variant="outline" size="sm" onClick={onRetry}>
              Retry
            </Button>
          </>
        ) : (
          <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading study controls…
          </span>
        )}
      </div>
    </div>
  )
}

export function StudyDock({
  demo = false,
  onDemoFinish,
}: {
  demo?: boolean
  /** Guide-only local handoff; production always navigates to StudyQuizPage. */
  onDemoFinish?: () => void
} = {}) {
  const policy = useConditionPolicy()
  const navigate = useNavigate()
  const location = useLocation()
  const [progress, setProgress] = useState<ProgressResponse | null>(null)
  const [progressError, setProgressError] = useState<string | null>(null)
  const [briefOpen, setBriefOpen] = useState(false)
  const [brief, setBrief] = useState<ActiveTaskBrief | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/study/progress", { cache: "no-store" })
      if (!res.ok) throw new Error(`request failed (${res.status})`)
      setProgress(((await res.json()) as { data: ProgressResponse }).data)
      setProgressError(null)
    } catch (error) {
      setProgressError(error instanceof Error ? error.message : "failed to load")
    }
  }, [])

  const studyMode = policy?.studyMode === true || demo
  useEffect(() => {
    if (!studyMode) return
    void refresh()
    const refreshOnFocus = () => { void refresh() }
    const timer = window.setInterval(refreshOnFocus, 30_000)
    window.addEventListener("focus", refreshOnFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener("focus", refreshOnFocus)
    }
    // Re-check when navigating back from the quiz (its submit changes state).
  }, [refresh, studyMode, location.pathname])

  const active = progress?.tasks.find((task) => task.id === progress.activeTaskId) ?? null
  const activeId = active?.id ?? null

  // The brief belongs to ONE task: switching tasks resets the dialog cache.
  useEffect(() => {
    setBrief(null)
    setBriefOpen(false)
  }, [activeId])

  // Hand-holding: a newly active session opens its own instructions, once.
  // Never over the guide or the study pages — those own the screen.
  const onFullscreenSurface = location.pathname === "/guide" || location.pathname.startsWith("/study")
  useEffect(() => {
    if (!activeId || !brief || brief.briefAcknowledged || progress?.postSessionPending || onFullscreenSurface) return
    setBriefOpen(true)
  }, [activeId, brief, onFullscreenSurface, progress?.postSessionPending])

  useEffect(() => {
    if (!activeId || brief !== null) return
    fetch(`/api/study/task/${encodeURIComponent(activeId)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error()
        setBrief(((await res.json()) as { data: ActiveTaskBrief }).data)
      })
      .catch(() => setBrief({
        brief: ["Could not load the instructions. Please tell the experimenter."],
        projectSlug: "unavailable",
        projectTitle: "Assigned project unavailable",
        starterReady: false,
        briefAcknowledged: false,
      }))
  }, [activeId, brief])

  const acknowledgeBrief = useCallback(() => {
    if (activeId && brief && !brief.briefAcknowledged) {
      setBrief({ ...brief, briefAcknowledged: true })
      void fetch(`/api/study/task/${encodeURIComponent(activeId)}/acknowledge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }).catch(() => {
        // Server receipt is authoritative. A failed acknowledgement will make
        // the brief reappear after refresh instead of silently skipping it.
      })
    }
    setBriefOpen(false)
  }, [activeId, brief])

  if (!studyMode) return null
  if (progress === null) {
    return <StudyDockLoadingStatus error={progressError} onRetry={() => void refresh()} />
  }

  const finalTaskId = progress.tasks[progress.tasks.length - 1]?.id ?? null
  const assignedTask = activeId ? getStudyTask(activeId) : undefined
  const briefDialogAction = studyBriefDialogAction(brief?.briefAcknowledged)

  const instructionsButton = (
    <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setBriefOpen(true)}>
      <BookOpen className="h-3.5 w-3.5" />
      Instructions
    </Button>
  )

  return (
    <div className="border-b border-border bg-muted/40">
      <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-1.5">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
          <ClipboardList className="h-3.5 w-3.5" /> Study
        </span>

        {progress.susPending ? (
          <>
            <span className="text-sm font-medium text-amber-700 dark:text-amber-300">
              All sessions are complete. Please answer the final usability questions.
            </span>
            <div className="ml-auto">
              <Button
                size="sm"
                disabled={!finalTaskId}
                onClick={() => {
                  if (finalTaskId) navigate(`/study/${finalTaskId}/quiz`)
                }}
              >
                Open final questions
              </Button>
            </div>
          </>
        ) : progress.studyComplete ? (
          <span className="inline-flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-300">
            <Check className="h-4 w-4" /> {STUDY_COMPLETION_MESSAGE}
          </span>
        ) : progress.activeTaskId === null ? (
          <span className="text-sm text-muted-foreground">Loading the final study step...</span>
        ) : progress.postSessionPending ? (
          <>
            <span className="text-sm font-medium text-amber-700 dark:text-amber-300">
              {active?.title}: the session has ended. Please finish the questions to continue.
            </span>
            <div className="ml-auto flex items-center gap-2">
              {instructionsButton}
              <Button size="sm" onClick={() => navigate(`/study/${progress.activeTaskId}/quiz`)}>
                Open the questions
              </Button>
            </div>
          </>
        ) : (
          <>
            <span className="text-sm font-medium text-foreground">
              {active?.title}
              {assignedTask ? <span className="ml-2 font-mono text-xs text-muted-foreground">{assignedTask.projectSlug}</span> : null}
            </span>
            <div className="ml-auto flex items-center gap-2">
              {instructionsButton}
              {/* Bright and unmistakable (mentor 2026-08-15 H1): submitting
                  through this button is the only way the session counts. */}
              <Button
                size="sm"
                className="shadow-md"
                data-study-finish-button="true"
                title="Your session only counts once submitted here — finishing without it means no score."
                onClick={() => {
                  if (demo && onDemoFinish) onDemoFinish()
                  else navigate(`/study/${progress.activeTaskId}/quiz`)
                }}
              >
                Finish this session
              </Button>
            </div>
          </>
        )}
      </div>

      <Dialog open={briefOpen} onOpenChange={(open) => {
        // The first delivery is mandatory. Close controls remain inert until
        // the explicit assignment CTA records the receipt.
        if (open || brief?.briefAcknowledged) setBriefOpen(open)
      }}>
        <DialogContent size="sm">
          <DialogBody className="space-y-4">
            <DialogTitle>{active?.title ?? "Your task"}</DialogTitle>
            {brief === null ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : (
              <>
                <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-foreground">
                  <span className="font-medium">Assigned project:</span> {brief.projectTitle}{" "}
                  <span className="font-mono text-xs text-muted-foreground">({brief.projectSlug})</span>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {brief.starterReady
                      ? "The official starter code is ready. Do not create or switch to another project."
                      : "The starter is not ready. Stop and tell the experimenter."}
                  </p>
                </div>
                <ProtectedStudyInstructions surface="task_dialog">
                  <div className="space-y-3 text-[15px] leading-relaxed text-foreground/90">
                    {brief.brief.map((paragraph, index) => (
                      <p key={index}>{paragraph}</p>
                    ))}
                  </div>
                </ProtectedStudyInstructions>
                <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs leading-relaxed text-foreground/80">
                  Copying or closely reproducing these instructions for the agent makes your participation
                  ineligible for compensation. Grading and compensation determination happen
                  after the study.
                </p>
              </>
            )}
            <p className="text-xs text-muted-foreground">
              You can reopen this any time with the "Instructions" button at the top.
            </p>
          </DialogBody>
          <DialogFooter>
            <Button
              size="sm"
              disabled={brief?.starterReady === false}
              onClick={() => {
                acknowledgeBrief()
                if (briefDialogAction.navigateToSetup && activeId) navigate(`/study/${activeId}`)
              }}
            >
              {briefDialogAction.label}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
