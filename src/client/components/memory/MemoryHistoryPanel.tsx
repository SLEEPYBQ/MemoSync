import { translateUiText } from "../../i18n/uiText"
import { traceVerdictLabel } from "../../i18n/labels"
import { t, useI18n, getLocale } from "../../i18n"
import { MemoryBadge } from "./MemoryBadge"
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
  user: { get label() { return t("memory:user") }, className: "bg-muted/50 text-muted-foreground" },
  agent: { get label() { return t("memory:agent") }, className: "bg-muted/50 text-muted-foreground" },
  system: { get label() { return t("memory:system") }, className: "bg-muted text-muted-foreground" },
}

const KIND_META: Record<EventKind, { icon: LucideIcon; label: string }> = {
  create: { icon: Sparkles, get label() { return t("memory:created") } },
  edit: { icon: Pencil, get label() { return t("memory:edited") } },
  rescope: { icon: ArrowLeftRight, get label() { return t("memory:rescoped") } },
  promote: { icon: TrendingUp, get label() { return t("memory:promoted") } },
  status: { icon: Flag, get label() { return t("memory:statusChanged") } },
  revert: { icon: RotateCcw, get label() { return t("memory:rolledBack") } },
  use: { icon: Eye, get label() { return t("memory:used2") } },
  trace: { icon: Activity, get label() { return t("memory:traceVerdict") } },
  reinforce: { icon: Plus, get label() { return t("memory:reinforced") } },
  renew: { icon: CalendarPlus, get label() { return t("memory:renewed") } },
}

const TRACE_LABEL_CLASSES: Record<string, string> = {
  operational: "text-success-foreground dark:text-success-foreground",
  violated: "text-destructive dark:text-destructive",
  injected_without_effect: "text-muted-foreground",
  not_applicable: "text-muted-foreground",
}

const FIELD_LABELS: Record<string, string> = {
  get content() { return t("memory:content") },
  get detail() { return t("memory:detail2") },
  scope: t("memory:fieldScope"),
  type: t("memory:fieldType"),
  status: t("memory:fieldStatus"),
  topic: t("memory:fieldTopic"),
  abstractionLevel: t("memory:fieldAbstraction"),
  projectId: t("memory:fieldProject"),
  sessionId: t("memory:fieldSession"),
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
  return d.toLocaleString(getLocale(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
}

function formatSessionTurn(sessionId?: string, turn?: number): string | null {
  if (!sessionId && turn === undefined) return null
  const parts: string[] = []
  if (sessionId) parts.push(`s:${sessionId.slice(0, 8)}`)
  if (turn !== undefined) parts.push(`t${turn}`)
  return parts.join(" · ")
}

function ActorChip({ actor }: { actor: EventActor }) {
  useI18n()
  const meta = ACTOR_META[actor]
  return (
    <MemoryBadge className={cn("inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium", meta.className)}>
      {meta.label}
    </MemoryBadge>
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
  useI18n()
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
          if (uses) parts.push(t("memory:useCount", { count: uses }))
          if (traces) parts.push(t("memory:traceCount", { count: traces }))
          return parts.join(" · ")
        })()}
      </button>
      {open ? (
        <ul className="mt-1 space-y-1 border-l border-dashed border-border pl-3">
          {events.map((event) => {
            const traceLabel = event.kind === "trace" && typeof event.meta?.label === "string" ? event.meta.label : null
            const label = traceLabel
              ? traceVerdictLabel(traceLabel)
              : event.meta?.detailLoaded
                ? t("memory:detailLoaded")
                : typeof event.meta?.via === "string"
                  ? event.meta.via
                  : t("memory:used")
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
  useI18n()
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
              variant="ghost"
              size="sm"
              className="h-6 rounded-md px-2 text-[11px] text-destructive hover:text-destructive"
              disabled={busy}
              onClick={() => onRollback(event.seq)}
            >
              {t("memory:confirmRollback")}</Button>
            <Button variant="ghost" size="sm" className="h-6 rounded-md px-2 text-[11px]" disabled={busy} onClick={() => setArmed(false)}>
              {t("common:cancel")}</Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="mt-1.5 h-6 rounded-md px-2 text-[11px]"
            onClick={() => setArmed(true)}
          >
            <RotateCcw className="h-3 w-3" /> {t("memory:rollBackToThisVersion")}</Button>
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
  useI18n()
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
      setError(err instanceof Error ? err.message : t("memory:failedToLoadHistory"))
      setStatus("error")
    }
  }, [itemId, getLocale()])

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
      setError(err instanceof Error ? err.message : t("memory:rollbackFailed"))
    } finally {
      setBusySeq(null)
    }
  }

  if (status === "loading") {
    return <p className="py-4 text-xs text-muted-foreground">{t("memory:loadingHistory")}</p>
  }
  if (status === "error") {
    return <p className="py-4 text-xs text-destructive">{t("memory:failedToLoadHistory2")}{translateUiText(error)}</p>
  }
  if (events.length === 0) {
    return <p className="py-4 text-xs text-muted-foreground">{t("memory:noHistoryYet")}</p>
  }

  const versionSeqs = events.filter((e) => e.snapshot).map((e) => e.seq)
  const latestVersionSeq = versionSeqs.length > 0 ? Math.max(...versionSeqs) : -1
  const rows = buildTimeline(events)

  return (
    <div className="mt-2">
      {error ? <p className="mb-2 text-xs text-destructive">{translateUiText(error)}</p> : null}
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
