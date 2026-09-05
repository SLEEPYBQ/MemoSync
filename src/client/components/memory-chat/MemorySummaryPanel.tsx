// Auto-arm memory panel (baseline B1, ChatGPT-style): a living PROSE summary
// of what the assistant remembers, refreshed as the silent capture hook
// accumulates items. The chat box at the bottom is the arm's ONLY control
// path — there is no board, no per-item cards, no direct editing, and the
// main-chat agent has no memory tools here. Ask to inspect; tell it to
// remember/change/forget and the panel assistant applies it.
import { useCallback, useEffect, useRef, useState } from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { ArrowUp, Sparkles, X } from "lucide-react"
import { Button } from "../ui/button"
import { AnimatedShinyText } from "../ui/animated-shiny-text"
import { RiseIn } from "../ui/motion-primitives"
import { memoriesApi, recordUiMonitor } from "../../lib/memoriesApi"
import { cn } from "../../lib/utils"
import { useSurfaceExposure, type StudySurfaceExposureInitiator } from "../../app/study/surfaceExposure"
import { memorySidebarOpenMonitoring } from "../../app/study/memorySidebarMonitoring"

interface Props {
  chatId: string
  projectId?: string
  exposureInitiator: StudySurfaceExposureInitiator
  onClose?: () => void
}

interface SummarySnapshot {
  text: string
  updatedAt: string
  stale: boolean
}

function relativeTime(iso: string): string {
  if (!iso) return ""
  const ms = Date.now() - Date.parse(iso)
  if (ms < 60_000) return "just now"
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

/** Prose-tuned markdown styling: section headings as quiet eyebrows, body as calm text. */
const summaryMarkdownComponents = {
  h1: (props: React.ComponentProps<"h2">) => (
    <h2 className="mt-4 mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground first:mt-0" {...props} />
  ),
  h2: (props: React.ComponentProps<"h2">) => (
    <h2 className="mt-4 mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground first:mt-0" {...props} />
  ),
  h3: (props: React.ComponentProps<"h3">) => (
    <h3 className="mt-3 mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground first:mt-0" {...props} />
  ),
  p: (props: React.ComponentProps<"p">) => (
    <p className="mb-2 text-sm leading-relaxed text-foreground/90 last:mb-0" {...props} />
  ),
  ul: (props: React.ComponentProps<"ul">) => <ul className="mb-2 list-disc pl-4 text-sm leading-relaxed" {...props} />,
  li: (props: React.ComponentProps<"li">) => <li className="mb-0.5" {...props} />,
  strong: (props: React.ComponentProps<"strong">) => <strong className="font-medium text-foreground" {...props} />,
}

export function MemorySummaryPanel({ chatId, projectId, exposureInitiator, onClose }: Props) {
  useSurfaceExposure({
    active: true,
    surface: "auto_summary_sidebar",
    chatId,
    initiator: exposureInitiator,
  })
  const [summary, setSummary] = useState<SummarySnapshot | null>(null)
  const [updating, setUpdating] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [input, setInput] = useState("")
  const [chatBusy, setChatBusy] = useState(false)
  const [reply, setReply] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const refresh = useCallback(async () => {
    setUpdating(true)
    try {
      setSummary(await memoriesApi.refreshSummary(projectId))
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Couldn't update the summary")
    } finally {
      setUpdating(false)
    }
  }, [projectId])

  // Load the cached summary immediately; regenerate when the item set moved
  // (the silent capture hook keeps adding while the user works).
  useEffect(() => {
    let cancelled = false
    const monitoring = memorySidebarOpenMonitoring(exposureInitiator, "summary_panel_open", chatId)
    if (monitoring) recordUiMonitor(monitoring.surface, monitoring)
    void memoriesApi
      .getSummary(projectId)
      .then((s) => {
        if (cancelled) return
        setSummary(s)
        if (s.stale) void refresh()
      })
      .catch((err) => !cancelled && setLoadError(err instanceof Error ? err.message : "Couldn't load the summary"))
    return () => {
      cancelled = true
    }
  }, [chatId, exposureInitiator, projectId, refresh])

  // Keep the panel current while open: cheap staleness poll, LLM only on change.
  useEffect(() => {
    const t = setInterval(() => {
      void memoriesApi
        .getSummary(projectId)
        .then((s) => {
          setSummary((current) => (updating || chatBusy ? current : s))
          if (s.stale && !updating && !chatBusy) void refresh()
        })
        .catch(() => {})
    }, 6000)
    return () => clearInterval(t)
  }, [projectId, refresh, updating, chatBusy])

  async function send() {
    const message = input.trim()
    if (!message || chatBusy) return
    setChatBusy(true)
    setReply(null)
    setInput("")
    try {
      const r = await memoriesApi.summaryChat(message, projectId, chatId)
      setReply(r.reply || (r.applied > 0 ? "Done." : "Nothing to change."))
      setSummary(r.summary)
      setLoadError(null)
    } catch (err) {
      setReply(err instanceof Error ? `Something went wrong: ${err.message}` : "Something went wrong — try again.")
    } finally {
      setChatBusy(false)
      inputRef.current?.focus()
    }
  }

  const busy = updating || chatBusy
  const empty = !summary?.text

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-border px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Sparkles className={cn("size-4 shrink-0", busy ? "text-primary" : "text-muted-foreground")} />
            <span className="text-sm font-medium text-foreground">Memory</span>
            {busy ? (
              <AnimatedShinyText className="text-xs">Updating…</AnimatedShinyText>
            ) : summary?.updatedAt ? (
              <span className="text-xs text-muted-foreground">Updated {relativeTime(summary.updatedAt)}</span>
            ) : null}
          </div>
          {onClose ? (
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onClose} title="Close">
              <X className="size-4" />
            </Button>
          ) : null}
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          What the assistant remembers, in its own words. It updates itself as you work — ask below to change it.
        </p>
      </div>

      <div
        className="relative min-h-0 flex-1 overflow-y-auto px-4 py-3"
        onClick={() => recordUiMonitor("summary_panel", { sessionId: chatId, interaction: "click" })}
        onScroll={() => recordUiMonitor("summary_panel", { sessionId: chatId, interaction: "scroll" })}
      >
        {loadError ? (
          <p className="text-xs text-destructive">{loadError}</p>
        ) : empty && !busy ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center opacity-70">
            <Sparkles className="size-8 text-muted-foreground/50" strokeWidth={1.5} />
            <p className="max-w-[220px] text-sm text-muted-foreground">
              Nothing remembered yet. Memory builds up on its own as you work.
            </p>
          </div>
        ) : (
          <div className={cn("transition-opacity duration-500", busy && "animate-pulse opacity-60")}>
            <Markdown remarkPlugins={[remarkGfm]} components={summaryMarkdownComponents}>
              {summary?.text ?? ""}
            </Markdown>
          </div>
        )}
      </div>

      <div className="border-t border-border p-3">
        {reply ? (
          <RiseIn freshAt={Date.now()}>
            <div className="mb-2 flex items-start gap-2 rounded-xl border border-border bg-popover px-3 py-2 shadow-sm">
              <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{reply}</p>
              <button
                type="button"
                onClick={() => setReply(null)}
                className="mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label="Dismiss reply"
              >
                <X className="size-3.5" />
              </button>
            </div>
          </RiseIn>
        ) : null}
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void send()
          }}
          className="flex items-center gap-1.5 rounded-full border border-border bg-muted/40 py-1 pl-4 pr-1 transition-colors focus-within:border-ring/50"
        >
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={chatBusy}
            placeholder="Ask or update your memory"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/70 disabled:opacity-60"
          />
          {/* Same neutral palette as the main composer's send button — no accent color. */}
          <Button
            type="submit"
            size="icon"
            disabled={chatBusy || !input.trim()}
            className="h-7 w-7 shrink-0 rounded-full bg-slate-600 text-white hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-white/90"
            aria-label="Send"
          >
            <ArrowUp className="size-4" />
          </Button>
        </form>
      </div>
    </div>
  )
}
