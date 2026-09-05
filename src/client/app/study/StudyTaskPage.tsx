// Experiment shell · participant-facing task briefs behind the serial gate.
// `/study` lists the sessions with their gate status (only the active one is
// clickable); `/study/:taskId` fetches the brief from the server, which
// withholds it while the task is locked — brief text never ships in the
// client bundle, so there is no peeking ahead.
import { useEffect, useState } from "react"
import { useNavigate, useOutletContext, useParams } from "react-router-dom"
import { ArrowLeft, ArrowRight, Check, ClipboardList, FolderOpen, Loader2, Lock } from "lucide-react"
import { Button } from "../../components/ui/button"
import { cn } from "../../lib/utils"
import type { StudyTaskStatus } from "../../../shared/studyTasks"
import type { AppState, ChatStartResult } from "../useAppState"
import { findAssignedStudyProject } from "./studyProjectSelection"
import { ProtectedStudyInstructions } from "./ProtectedStudyInstructions"
import { StudySessionStartSurface } from "./StudySessionStartSurface"

interface ProgressEntry {
  id: string
  title: string
  status: StudyTaskStatus
}

interface TaskBrief {
  id: string
  title: string
  status: StudyTaskStatus
  brief: string[]
  projectSlug: string
  projectTitle: string
  projectId: string | null
  starterReady: boolean
  briefAcknowledged: boolean
}

export function getAssignedChatStartError(result: ChatStartResult): string | null {
  if (result.ok) return null
  const detail = result.error.trim().replace(/[.!?]+$/, "")
  const reason = detail ? `: ${detail}` : ""
  return `Could not open the assigned project chat${reason}. Try again. If it still fails, stop here and ask the experimenter for help.`
}

export function StudyIndexPage({ embedded = false }: { embedded?: boolean } = {}) {
  const navigate = useNavigate()
  const [progress, setProgress] = useState<ProgressEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch("/api/study/progress")
      .then(async (res) => {
        if (!res.ok) throw new Error(`request failed (${res.status})`)
        setProgress(((await res.json()) as { data: { tasks: ProgressEntry[] } }).data.tasks)
      })
      .catch((e) => setError(e instanceof Error ? e.message : "failed to load"))
  }, [])

  return (
    <div className={embedded ? "relative h-full overflow-y-auto bg-background" : "fixed inset-0 z-50 overflow-y-auto bg-background"}>
      <div className="mx-auto flex min-h-full w-full max-w-[640px] flex-col justify-center px-6 py-12">
        {embedded ? null : (
          <Button
            variant="ghost"
            size="sm"
            className="mb-3 w-fit gap-1.5 px-2"
            onClick={() => navigate("/")}
          >
            <ArrowLeft className="h-4 w-4" /> Back to the app
          </Button>
        )}
        <h1 className="text-2xl font-semibold text-foreground">Study sessions</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Sessions unlock one at a time: completing all post-session questions opens the next one.
        </p>
        {progress === null && !error ? (
          <div className="mt-8 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : null}
        <div data-guide-study-sessions="true" className="mt-6 flex flex-col gap-3">
          {(progress ?? []).map((task) => (
            <div
              key={task.id}
              className={cn(
                "flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3",
                task.status === "locked" && "opacity-55"
              )}
            >
              <span className="font-mono text-xs text-muted-foreground">{task.id}</span>
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">{task.title}</span>
              {task.status === "completed" ? (
                <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
                  <Check className="h-3.5 w-3.5" /> Completed
                </span>
              ) : task.status === "locked" ? (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <Lock className="h-3.5 w-3.5" /> Locked
                </span>
              ) : (
                <>
                  <Button variant="outline" size="sm" onClick={() => navigate(`/study/${task.id}`)}>
                    Brief
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => navigate(`/study/${task.id}/quiz`)}>
                    Quiz
                  </Button>
                </>
              )}
            </div>
          ))}
        </div>
        {error ? <p className="mt-4 text-sm text-destructive">{error}</p> : null}
      </div>
    </div>
  )
}

export function StudyTaskPage() {
  const { taskId } = useParams<{ taskId: string }>()
  const navigate = useNavigate()
  const app = useOutletContext<AppState>()
  const [task, setTask] = useState<TaskBrief | null>(null)
  const [locked, setLocked] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [acknowledging, setAcknowledging] = useState(false)
  const [acknowledgementError, setAcknowledgementError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)

  useEffect(() => {
    if (!taskId) return
    fetch(`/api/study/task/${encodeURIComponent(taskId)}`)
      .then(async (res) => {
        if (res.status === 403) {
          setLocked(true)
          return
        }
        if (!res.ok) throw new Error(`request failed (${res.status})`)
        setTask(((await res.json()) as { data: TaskBrief }).data)
      })
      .catch((e) => setError(e instanceof Error ? e.message : "failed to load"))
  }, [taskId])

  if (locked) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
        <div className="flex max-w-[420px] flex-col items-center gap-3 px-6 text-center">
          <Lock className="h-6 w-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            This session is not available yet. Finish the current session and all of its
            post-session questions first.
          </p>
          <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => navigate("/")}>
            <ArrowLeft className="h-4 w-4" /> Back to the app
          </Button>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-background">
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => navigate("/")}>
          <ArrowLeft className="h-4 w-4" /> Back to the app
        </Button>
      </div>
    )
  }

  if (task === null) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const assignedProject = task.projectId
    ? findAssignedStudyProject(app.sidebarData.projectGroups, task.projectId)
    : null
  const assignedProjectMissing = app.sidebarReady && assignedProject === null

  const acknowledgeBrief = async () => {
    if (task.briefAcknowledged || acknowledging) return
    setAcknowledging(true)
    setAcknowledgementError(null)
    try {
      const acknowledgement = await fetch(`/api/study/task/${encodeURIComponent(task.id)}/acknowledge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
      if (!acknowledgement.ok) {
        throw new Error("Could not record that you reviewed this assignment.")
      }
      setTask((current) => current ? { ...current, briefAcknowledged: true } : current)
    } catch (cause) {
      setAcknowledgementError(cause instanceof Error ? cause.message : "Could not continue to session setup.")
    } finally {
      setAcknowledging(false)
    }
  }

  const startSessionChat = async () => {
    if (!assignedProject || starting) return
    setStarting(true)
    setStartError(null)
    try {
      // Every session receives a fresh chat, while S2 deliberately keeps the
      // same project directory and therefore all code produced in S1.
      const result = await app.handleCreateChat(assignedProject.groupKey)
      const chatStartError = getAssignedChatStartError(result)
      if (chatStartError) {
        setStartError(chatStartError)
      }
    } catch (cause) {
      setStartError(cause instanceof Error ? cause.message : "Could not start the assigned project.")
    } finally {
      setStarting(false)
    }
  }

  if (task.briefAcknowledged) {
    return (
      <div className="fixed inset-0 z-50 overflow-y-auto bg-background">
        <div className="mx-auto flex min-h-full w-full max-w-[640px] flex-col justify-center px-6 py-12">
          <StudySessionStartSurface
            sessionTitle={task.title}
            projectTitle={task.projectTitle}
            projectSlug={task.projectSlug}
            continuesExistingWork={task.id.endsWith("-S2")}
            onStart={startSessionChat}
            starting={starting}
            disabled={!assignedProject}
            error={startError}
          />
          {assignedProjectMissing ? (
            <p className="mt-2 text-sm text-destructive">
              The assigned project is not ready. Please stop here and ask the experimenter for help.
            </p>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-background">
      <div className="mx-auto flex min-h-full w-full max-w-[640px] flex-col justify-center px-6 py-12">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {task.title}
        </div>
        <h1 className="mt-2 text-2xl font-semibold leading-snug text-foreground">Your task</h1>
        <div className="mt-5 rounded-xl border border-border bg-muted/40 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <FolderOpen className="h-4 w-4 text-muted-foreground" />
            Assigned project: {task.projectTitle}
          </div>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
            The official benchmark starter code is already initialized in <span className="font-mono">{task.projectSlug}</span>.
            Work only in this assigned project and do not create another project for this session.
            {task.id.endsWith("-S2")
              ? " This session continues the code produced in Session 1; it has not been reset."
              : " Session 2 will continue from the code you produce here."}
          </p>
        </div>
        <div className="mt-6 rounded-2xl border border-border bg-card p-6 shadow-sm">
          <ProtectedStudyInstructions surface="task_page">
            <div className="space-y-4 text-[15px] leading-relaxed text-foreground/90">
              {task.brief.map((paragraph, index) => (
                <p key={index}>{paragraph}</p>
              ))}
            </div>
          </ProtectedStudyInstructions>
        </div>
        <div className="mt-4 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-[13px] leading-relaxed text-foreground/80">
          <p className="font-medium text-foreground">Instruction and compensation rule</p>
          <p className="mt-1">
            Do not use copy/paste, browser developer tools, screenshots, files, or another tool to transfer
            all or a substantially verbatim part of these instructions to the agent. Describe the goal in your
            own words. A violation makes your participation ineligible for compensation.
          </p>
          <p className="mt-1">
            Grading runs after the study. The study team will notify you after grading and
            determine compensation at that time; no benchmark score is shown during a session.
          </p>
        </div>
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-border bg-muted/40 px-4 py-3 text-[13px] text-muted-foreground">
          <ClipboardList className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            When you continue, the app will first open a session setup page. After you create the
            session chat, you can reopen these instructions from the study bar at the top.
          </p>
        </div>
        <div className="mt-6">
          <Button
            onClick={() => void acknowledgeBrief()}
            disabled={acknowledging}
            className="gap-1.5"
          >
            {acknowledging ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Continue to session setup
            {!acknowledging ? <ArrowRight className="h-4 w-4" /> : null}
          </Button>
          {acknowledgementError ? <p className="mt-2 text-sm text-destructive">{acknowledgementError}</p> : null}
        </div>
      </div>
    </div>
  )
}
