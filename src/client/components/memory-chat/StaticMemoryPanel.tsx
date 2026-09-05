// Static-arm memory panel (baseline B2): the workspace MEMORY.md rendered as
// a live shared document. The agent maintains it mid-conversation with its
// file tools (its injection block tells it to narrate every write); the user
// edits it here directly. mtime is a light CAS token — two writers never
// silently clobber each other — and a gentle poll keeps the view current, so
// agent edits appear moments after they land.
import { useCallback, useEffect, useRef, useState } from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Check, NotebookPen, PencilLine, RefreshCw, X } from "lucide-react"
import { Button } from "../ui/button"
import { PulseOnce } from "../ui/motion-primitives"
import { memoriesApi, recordStaticMemoryEditEntered, recordUiMonitor } from "../../lib/memoriesApi"
import { useSurfaceExposure, type StudySurfaceExposureInitiator } from "../../app/study/surfaceExposure"
import { memorySidebarOpenMonitoring } from "../../app/study/memorySidebarMonitoring"

interface Props {
  chatId: string
  projectId?: string
  exposureInitiator: StudySurfaceExposureInitiator
  onClose?: () => void
}

function relativeTime(ms: number): string {
  if (!ms) return ""
  const delta = Date.now() - ms
  if (delta < 60_000) return "just now"
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`
  return `${Math.floor(delta / 86_400_000)}d ago`
}

const fileMarkdownComponents = {
  h1: (props: React.ComponentProps<"h1">) => (
    <h1 className="mt-4 mb-1.5 border-b border-border/60 pb-1 text-sm font-semibold text-foreground first:mt-0" {...props} />
  ),
  h2: (props: React.ComponentProps<"h2">) => (
    <h2 className="mt-4 mb-1 text-[13px] font-semibold text-foreground first:mt-0" {...props} />
  ),
  h3: (props: React.ComponentProps<"h3">) => (
    <h3 className="mt-3 mb-1 text-xs font-semibold text-foreground first:mt-0" {...props} />
  ),
  p: (props: React.ComponentProps<"p">) => (
    <p className="mb-2 text-sm leading-relaxed text-foreground/90 last:mb-0" {...props} />
  ),
  ul: (props: React.ComponentProps<"ul">) => <ul className="mb-2 list-disc pl-4 text-sm leading-relaxed" {...props} />,
  ol: (props: React.ComponentProps<"ol">) => <ol className="mb-2 list-decimal pl-4 text-sm leading-relaxed" {...props} />,
  li: (props: React.ComponentProps<"li">) => <li className="mb-0.5 text-foreground/90" {...props} />,
  code: (props: React.ComponentProps<"code">) => (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]" {...props} />
  ),
  strong: (props: React.ComponentProps<"strong">) => <strong className="font-medium text-foreground" {...props} />,
}

export function StaticMemoryPanel({ chatId, projectId, exposureInitiator, onClose }: Props) {
  useSurfaceExposure({
    active: true,
    surface: "static_memory_sidebar",
    chatId,
    initiator: exposureInitiator,
  })
  const [content, setContent] = useState<string | null>(null)
  const [mtimeMs, setMtimeMs] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState(false)
  /** Bumped when a POLL sees new content — drives the "agent updated" flash. */
  const [externalBump, setExternalBump] = useState(0)
  const [lastAgentEditMs, setLastAgentEditMs] = useState(0)
  const editingRef = useRef(editing)
  const editStartedAtRef = useRef<number | null>(null)
  const editEventIdRef = useRef<string | null>(null)
  editingRef.current = editing

  const load = useCallback(async () => {
    if (!projectId) return
    try {
      const f = await memoriesApi.getMemoryFile(projectId)
      setError(null)
      setContent((current) => {
        // A change that arrived while we merely viewed = the agent (or another
        // window) wrote the file — flash it so the write is FELT, not silent.
        if (current !== null && f.content !== current && !editingRef.current) {
          setExternalBump((n) => n + 1)
          setLastAgentEditMs(Date.now())
        }
        return editingRef.current ? current : f.content
      })
      setMtimeMs(f.mtimeMs)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't read the memory file")
    }
  }, [projectId])

  useEffect(() => {
    const monitoring = memorySidebarOpenMonitoring(exposureInitiator, "static_memory_panel_open", chatId)
    if (monitoring) recordUiMonitor(monitoring.surface, monitoring)
    void load()
  }, [chatId, exposureInitiator, load])

  useEffect(() => {
    const t = setInterval(() => void load(), 4000)
    return () => clearInterval(t)
  }, [load])

  function startEditing() {
    setDraft(content ?? "")
    setConflict(false)
    editStartedAtRef.current = Date.now()
    editEventIdRef.current = `control:static-edit:${crypto.randomUUID()}`
    recordStaticMemoryEditEntered(editEventIdRef.current, chatId, "MEMORY.md")
    setEditing(true)
  }

  function cancelEditing() {
    editStartedAtRef.current = null
    editEventIdRef.current = null
    setEditing(false)
  }

  async function save() {
    if (!projectId || saving) return
    setSaving(true)
    setConflict(false)
    try {
      const editDurationMs = editStartedAtRef.current === null
        ? undefined
        : Math.max(0, Date.now() - editStartedAtRef.current)
      const r = await memoriesApi.saveMemoryFile(projectId, draft, {
        baseMtimeMs: mtimeMs || undefined,
        sessionId: chatId,
        editDurationMs,
        eventId: draft === (content ?? "") ? undefined : editEventIdRef.current ?? undefined,
      })
      setContent(draft)
      setMtimeMs(r.mtimeMs)
      editStartedAtRef.current = null
      editEventIdRef.current = null
      setEditing(false)
      setError(null)
    } catch (err) {
      const message = err instanceof Error ? err.message : "save failed"
      if (/changed since/i.test(message)) setConflict(true)
      else setError(message)
    } finally {
      setSaving(false)
    }
  }

  async function reloadAfterConflict() {
    editStartedAtRef.current = null
    editEventIdRef.current = null
    setEditing(false)
    setConflict(false)
    setContent(null)
    await load()
  }

  const empty = !content?.trim()

  function recordViewInteraction(interaction: "click" | "scroll") {
    if (editingRef.current) return
    recordUiMonitor("static_memory_panel", { sessionId: chatId, interaction })
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-border px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <NotebookPen className="size-4 shrink-0 text-muted-foreground" />
            <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs font-medium text-foreground">
              MEMORY.md
            </span>
            {lastAgentEditMs ? (
              <span className="truncate text-xs text-muted-foreground">
                updated by the agent {relativeTime(lastAgentEditMs)}
              </span>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {editing ? (
              <>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={saving} onClick={cancelEditing}>
                  Cancel
                </Button>
                <Button variant="juicy" size="sm" className="h-7 gap-1 px-2 text-xs" disabled={saving} onClick={() => void save()}>
                  <Check className="size-3.5" /> Save
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs"
                disabled={content === null}
                onClick={startEditing}
              >
                <PencilLine className="size-3.5" /> Edit
              </Button>
            )}
            {onClose ? (
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} title="Close">
                <X className="size-4" />
              </Button>
            ) : null}
          </div>
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          A plain file you and the agent both keep. The agent updates it live as you work; edit it here any time.
        </p>
      </div>

      {conflict ? (
        <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <RefreshCw className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">The file changed while you were editing — likely the agent.</span>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => void reloadAfterConflict()}>
            Reload
          </Button>
        </div>
      ) : null}

      <div
        className="min-h-0 flex-1 overflow-y-auto"
        onClick={() => recordViewInteraction("click")}
        onScroll={() => recordViewInteraction("scroll")}
      >
        {error ? (
          <p className="px-4 py-3 text-xs text-destructive">{error}</p>
        ) : editing ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="h-full w-full resize-none bg-transparent px-4 py-3 font-mono text-[13px] leading-relaxed text-foreground outline-none"
            placeholder="# Memory&#10;&#10;## Preferences&#10;- …"
          />
        ) : empty ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center opacity-70">
            <NotebookPen className="size-8 text-muted-foreground/50" strokeWidth={1.5} />
            <p className="max-w-[230px] text-sm text-muted-foreground">
              The file is empty. Start it yourself, or let the agent fill it in as you work.
            </p>
          </div>
        ) : (
          <PulseOnce key={externalBump} freshAt={externalBump ? Date.now() : undefined} color="rgb(59 130 246 / 0.35)">
            <div className="px-4 py-3">
              {/* skipHtml: scaffold guidance lives in an HTML comment — visible when editing, hidden when rendered (GitHub semantics). */}
              <Markdown remarkPlugins={[remarkGfm]} components={fileMarkdownComponents} skipHtml>
                {content ?? ""}
              </Markdown>
            </div>
          </PulseOnce>
        )}
      </div>
    </div>
  )
}
