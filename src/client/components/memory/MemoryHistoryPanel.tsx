// Per-item version + usage timeline with rollback (SPEC §4.11, option 乙).
// Fetches memoriesApi.history(id) and renders one row per event, oldest
// first (newest last): version events (create/edit/rescope/promote/status/
// revert) show a before→after diff and a two-step "roll back" action; `use`
// events are quiet citation rows, grouped and folded by default.
import { useCallback, useEffect, useState } from "react"
import { Activity, ChevronDown, ChevronRight, Eye, Flag, Pencil, Plus, RotateCcw, Sparkles, TrendingUp, ArrowLeftRight, CalendarPlus } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { memoriesApi, type MemoryControlSurface, type MemoryEvent, type MemoryItem } from "../../lib/memoriesApi"
import { Button } from "../ui/button"
import { cn } from "../../lib/utils"

type EventActor = MemoryEvent["actor"]
type EventKind = MemoryEvent["kind"]

const ACTOR_META: Record<EventActor, { label: string; className: string }> = {
  user: { label: "user", className: "bg-blue-500/10 text-blue-700 dark:text-blue-300" },
  agent: { label: "agent", className: "bg-violet-500/10 text-violet-700 dark:text-violet-300" },
  system: { label: "system", className: "bg-muted text-muted-foreground" },
}

const KIND_META: Record<EventKind, { icon: LucideIcon; label: string }> = {
  create: { icon: Sparkles, label: "Created" },
  edit: { icon: Pencil, label: "Edited" },
  rescope: { icon: ArrowLeftRight, label: "Rescoped" },
  promote: { icon: TrendingUp, label: "Promoted" },
  status: { icon: Flag, label: "Status changed" },
  revert: { icon: RotateCcw, label: "Rolled back" },
  use: { icon: Eye, label: "Used" },
  trace: { icon: Activity, label: "Trace verdict" },
  reinforce: { icon: Plus, label: "Reinforced" },
  renew: { icon: CalendarPlus, label: "Renewed (延期)" },
}

const TRACE_LABEL_CLASSES: Record<string, string> = {
  operational: "text-emerald-600 dark:text-emerald-400",
  violated: "text-red-600 dark:text-red-400",
  injected_without_effect: "text-muted-foreground",
  not_applicable: "text-slate-500 dark:text-slate-400",
}

const FIELD_LABELS: Record<string, string> = {
  content: "content",
  detail: "detail",
  scope: "scope",
  type: "type",
  status: "status",
  topic: "topic",
  abstractionLevel: "abstraction",
  projectId: "project",
  sessionId: "session",
}

function fieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? key
}

function truncateValue(value: unknown, max = 60): string {
  if (value === null || value === undefined || value === "") return "—"
  const s = String(value)
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function formatEventTime(ts: string): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
}

function formatSessionTurn(sessionId?: string, turn?: number): string | null {
  if (!sessionId && turn === undefined) return null
  const parts: string[] = []
  if (sessionId) parts.push(`s:${sessionId.slice(0, 8)}`)
  if (turn !== undefined) parts.push(`t${turn}`)
  return parts.join(" · ")
}

function ActorChip({ actor }: { actor: EventActor }) {
  const meta = ACTOR_META[actor]
  return (
    <span className={cn("inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium", meta.className)}>
      {meta.label}
    </span>
  )
}

type TimelineRow = { type: "event"; event: MemoryEvent } | { type: "uses"; key: string; events: MemoryEvent[] }

/**
 * Group consecutive `use`/`trace` events between version events into one
 * foldable row — both are high-volume per-turn activity, not versions.
 */
function buildTimeline(events: MemoryEvent[]): TimelineRow[] {
  const rows: TimelineRow[] = []
  let buffer: MemoryEvent[] = []
  const flush = () => {
    if (buffer.length > 0) {
      rows.push({ type: "uses", key: `uses-${buffer[0].seq}`, events: buffer })
      buffer = []
    }
  }
  for (const event of events) {
    if (event.kind === "use" || event.kind === "trace") {
      buffer.push(event)
    } else {
      flush()
      rows.push({ type: "event", event })
    }
  }
  flush()
  return rows
}

function UseGroupRow({ events }: { events: MemoryEvent[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="py-1 pl-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {(() => {
          const uses = events.filter((e) => e.kind === "use").length
          const traces = events.length - uses
          const parts: string[] = []
          if (uses) parts.push(`${uses} use${uses === 1 ? "" : "s"}`)
          if (traces) parts.push(`${traces} trace verdict${traces === 1 ? "" : "s"}`)
          return parts.join(" · ")
        })()}
      </button>
      {open ? (
        <ul className="mt-1 space-y-1 border-l border-dashed border-border pl-3">
          {events.map((event) => {
            const traceLabel = event.kind === "trace" && typeof event.meta?.label === "string" ? event.meta.label : null
            const label = traceLabel
              ? traceLabel.replace(/_/g, " ")
              : event.meta?.detailLoaded
                ? "detail loaded"
                : typeof event.meta?.via === "string"
                  ? event.meta.via
                  : "used"
            const sessionTurn = formatSessionTurn(event.sessionId, event.turn)
            return (
              <li
                key={event.seq}
                className={cn(
                  "flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground",
                  traceLabel && TRACE_LABEL_CLASSES[traceLabel],
                )}
              >
                {traceLabel ? <Activity className="h-3 w-3 shrink-0" /> : <Eye className="h-3 w-3 shrink-0" />}
                <span>{label}</span>
                <ActorChip actor={event.actor} />
                <span>{formatEventTime(event.ts)}</span>
                {sessionTurn ? <span>{sessionTurn}</span> : null}
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}

function VersionEventRow({
  event,
  isLatest,
  busy,
  onRollback,
}: {
  event: MemoryEvent
  isLatest: boolean
  busy: boolean
  onRollback: (seq: number) => void
}) {
  const meta = KIND_META[event.kind]
  const Icon = meta.icon
  const [armed, setArmed] = useState(false)
  const sessionTurn = formatSessionTurn(event.sessionId, event.turn)
  const changeEntries = event.changes ? Object.entries(event.changes) : []

  return (
    <div className="relative pb-4 pl-6">
      <span className="absolute left-0 top-0.5 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-card">
        <Icon className="h-3 w-3 text-muted-foreground" />
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-foreground">{meta.label}</span>
        <ActorChip actor={event.actor} />
        <span className="text-xs text-muted-foreground">{formatEventTime(event.ts)}</span>
        {sessionTurn ? <span className="text-xs text-muted-foreground">{sessionTurn}</span> : null}
      </div>
      {changeEntries.length > 0 ? (
        <div className="mt-1 space-y-0.5">
          {changeEntries.map(([key, diff]) => (
            <div key={key} className="text-xs">
              <span className="text-muted-foreground">{fieldLabel(key)}: </span>
              <span className="text-muted-foreground line-through">{truncateValue(diff.before)}</span>
              <span className="mx-1 text-muted-foreground">→</span>
              <span className="text-foreground">{truncateValue(diff.after)}</span>
            </div>
          ))}
        </div>
      ) : null}
      {event.snapshot && !isLatest ? (
        armed ? (
          <div className="mt-1.5 flex items-center gap-1.5">
            <Button
              variant="destructive"
              size="sm"
              className="h-6 rounded-md px-2 text-[11px]"
              disabled={busy}
              onClick={() => onRollback(event.seq)}
            >
              Confirm rollback
            </Button>
            <Button variant="ghost" size="sm" className="h-6 rounded-md px-2 text-[11px]" disabled={busy} onClick={() => setArmed(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="mt-1.5 h-6 rounded-md px-2 text-[11px]"
            onClick={() => setArmed(true)}
          >
            <RotateCcw className="h-3 w-3" /> Roll back to this version
          </Button>
        )
      ) : null}
    </div>
  )
}

interface MemoryHistoryPanelProps {
  itemId: string
  /** Called with the memory returned by a successful rollback, so the caller can refresh the item + store. */
  onReverted: (item: MemoryItem) => void
  surface?: MemoryControlSurface
}

export function MemoryHistoryPanel({ itemId, onReverted, surface }: MemoryHistoryPanelProps) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading")
  const [events, setEvents] = useState<MemoryEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busySeq, setBusySeq] = useState<number | null>(null)

  const load = useCallback(async () => {
    setStatus("loading")
    setError(null)
    try {
      const history = await memoriesApi.history(itemId)
      setEvents(history.events)
      setStatus("ready")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load history")
      setStatus("error")
    }
  }, [itemId])

  useEffect(() => {
    void load()
  }, [load])

  async function handleRollback(seq: number) {
    setBusySeq(seq)
    try {
      const reverted = await memoriesApi.revert(itemId, seq, surface)
      onReverted(reverted)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rollback failed")
    } finally {
      setBusySeq(null)
    }
  }

  if (status === "loading") {
    return <p className="py-4 text-xs text-muted-foreground">Loading history…</p>
  }
  if (status === "error") {
    return <p className="py-4 text-xs text-destructive">Failed to load history: {error}</p>
  }
  if (events.length === 0) {
    return <p className="py-4 text-xs text-muted-foreground">No history yet.</p>
  }

  const versionSeqs = events.filter((e) => e.snapshot).map((e) => e.seq)
  const latestVersionSeq = versionSeqs.length > 0 ? Math.max(...versionSeqs) : -1
  const rows = buildTimeline(events)

  return (
    <div className="mt-2">
      {error ? <p className="mb-2 text-xs text-destructive">{error}</p> : null}
      {rows.map((row) =>
        row.type === "uses" ? (
          <UseGroupRow key={row.key} events={row.events} />
        ) : (
          <VersionEventRow
            key={row.event.seq}
            event={row.event}
            isLatest={row.event.seq === latestVersionSeq}
            busy={busySeq === row.event.seq}
            onRollback={handleRollback}
          />
        ),
      )}
    </div>
  )
}
