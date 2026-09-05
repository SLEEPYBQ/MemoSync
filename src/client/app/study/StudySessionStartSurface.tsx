import { ArrowRight, Check, FolderOpen, Loader2, MessageSquarePlus, PencilLine } from "lucide-react"
import { Button } from "../../components/ui/button"

export interface StudySessionStartSurfaceProps {
  sessionTitle: string
  projectTitle: string
  projectSlug: string
  continuesExistingWork: boolean
  onStart: () => void | Promise<void>
  starting?: boolean
  disabled?: boolean
  error?: string | null
}

export function StudySessionStartSurface({
  sessionTitle,
  projectTitle,
  projectSlug,
  continuesExistingWork,
  onStart,
  starting = false,
  disabled = false,
  error = null,
}: StudySessionStartSurfaceProps) {
  return (
    <section className="w-full" aria-labelledby="study-session-setup-title">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {sessionTitle} · Session setup
      </div>
      <h1 id="study-session-setup-title" className="mt-2 text-2xl font-semibold leading-snug text-foreground">
        Start a new session chat
      </h1>
      <p className="mt-2 max-w-[560px] text-sm leading-relaxed text-muted-foreground">
        Your task brief is saved. Set up the assigned workspace now, then decide how you want to
        describe the task to the coding agent.
      </p>

      <div className="mt-6 overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <div className="flex items-start gap-3 border-b border-border bg-muted/35 px-5 py-4">
          <div className="mt-0.5 rounded-lg border border-border bg-background p-2 text-muted-foreground">
            <FolderOpen className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">{projectTitle}</div>
            <div className="mt-0.5 font-mono text-xs text-muted-foreground">{projectSlug}</div>
            <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
              {continuesExistingWork
                ? "This session continues the code from Session 1 in the same assigned project."
                : "This session opens the official starter code in the assigned project."}
            </p>
          </div>
        </div>

        <div className="grid gap-0 sm:grid-cols-2">
          <div className="flex gap-3 border-b border-border px-5 py-5 sm:border-b-0 sm:border-r">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-foreground text-xs font-semibold text-background">
              1
            </span>
            <div>
              <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                <MessageSquarePlus className="h-4 w-4 text-muted-foreground" /> Create the chat
              </div>
              <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
                A fresh, empty conversation opens for this study session.
              </p>
            </div>
          </div>
          <div className="flex gap-3 px-5 py-5">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-background text-xs font-semibold text-foreground">
              2
            </span>
            <div>
              <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                <PencilLine className="h-4 w-4 text-muted-foreground" /> Write your prompt
              </div>
              <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
                Take a moment, then write your first prompt in your own words when you are ready.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-4 flex items-start gap-2 rounded-xl border border-border bg-muted/35 px-4 py-3 text-[13px] leading-relaxed text-muted-foreground">
        <Check className="mt-0.5 h-4 w-4 shrink-0" />
        <p>No message is sent when you create the chat. You control when to send the first prompt.</p>
      </div>

      <div className="mt-6">
        <Button
          type="button"
          data-study-new-session-chat="true"
          disabled={disabled || starting}
          onClick={() => void onStart()}
          className="gap-1.5"
        >
          {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquarePlus className="h-4 w-4" />}
          {starting ? "Opening chat…" : "New session chat"}
          {!starting ? <ArrowRight className="h-4 w-4" /> : null}
        </Button>
        {error ? <p className="mt-2 text-sm text-destructive" role="alert">{error}</p> : null}
      </div>
    </section>
  )
}
