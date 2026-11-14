import { traceVerdictLabel } from "../../i18n/labels"
import { getLocale, t, useI18n } from "../../i18n"
// A single memory as an operable board card (SPEC §4.9): candidates get an
// amber accent + sensitive badge, scoped (active) cards get a scope tint and
// are natively draggable for drag-to-rescope. Clicking the card (outside its
// footer actions) opens the detail panel.
import type { DragEvent, MouseEvent, ReactNode } from "react"
import { Clock3, FileWarning, ShieldAlert } from "lucide-react"
import type { MemoryItem } from "../../lib/memoriesApi"
import { formatSidebarAgeLabel } from "../../lib/formatters"
import { expiryDaysLeft, localDateValue } from "../../lib/memoryExpiry"
import { driftedFileRefs, fileDriftLabel } from "../../lib/memoryFileDrift"
import { cn } from "../../lib/utils"
import { Chip, ScopeBadge, TeamBadge, scopeCardClasses, scopeRingClasses } from "./ScopeBadge"
// Trace-dot and freshness color maps live in memoryVocab so this card and the
// MemoryLegend render the exact same swatches (they can no longer drift).
import { FRESHNESS_CLASSES, TRACE_DOT_CLASSES } from "./memoryVocab"

interface MemoryCardProps {
  item: MemoryItem
  variant: "candidate" | "scoped"
  selected?: boolean
  draggable?: boolean
  onDragStart?: (e: DragEvent<HTMLDivElement>) => void
  onDragEnd?: (e: DragEvent<HTMLDivElement>) => void
  onClick?: () => void
  footer?: ReactNode
  /** Where the memory binds: the project title (project scope) or the source chat title (session scope). */
  originLabel?: string
  /** Which chat captured it (provenance) — distinct from where it binds. */
  capturedIn?: string
  /** Touched since the user's last board visit — the meta-model diff marker. */
  freshness?: "new" | "changed"
}

export function MemoryCard({ item, variant, selected, draggable, onDragStart, onDragEnd, onClick, footer, originLabel, capturedIn, freshness }: MemoryCardProps) {
  useI18n()
  const age = formatSidebarAgeLabel(Date.parse(item.createdAt) || undefined, Date.now())
  const now = Date.now()
  const days = expiryDaysLeft(item.expiresAt, now)
  const expiresToday = Boolean(item.expiresAt && localDateValue(new Date(item.expiresAt)) === localDateValue(new Date(now)))
  const driftLabel = fileDriftLabel(item)
  function handleFooterClick(e: MouseEvent<HTMLDivElement>) {
    // Footer buttons handle their own actions; don't also open the panel.
    e.stopPropagation()
  }

  return (
    <div
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {
              // Keyboard events from footer actions bubble through the card.
              // Only activate the card when the card itself has focus.
              if (e.target !== e.currentTarget) return
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault()
                onClick()
              }
            }
          : undefined
      }
      className={cn(
        "memory-ui group/card @container relative min-w-0 rounded-xl border p-3 transition-colors",
        variant === "candidate" ? "border-cand-border bg-cand-surface" : scopeCardClasses(item.scope),
        onClick && "cursor-pointer",
        draggable && "active:cursor-grabbing",
        selected && variant === "candidate" && "ring-2 ring-cand-dot",
        selected && variant === "scoped" && cn("ring-2", scopeRingClasses(item.scope)),
      )}
    >
      <p className="whitespace-pre-wrap text-sm text-foreground">{item.content}</p>
      {item.sensitive ? (
        <p className="mt-1.5 flex items-center gap-1 text-xs font-medium text-cand-fg">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
          {t("memory:sensitiveNeedsYourConfirmation")}</p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {freshness ? <Chip className={FRESHNESS_CLASSES[freshness]}>{freshness}</Chip> : null}
        <Chip className="font-mono">{item.id}</Chip>
        {item.team ? <TeamBadge /> : null}
        {/* In a column the scope is already said by where the card sits. */}
        {variant === "candidate" ? <ScopeBadge scope={item.scope} /> : null}
        {originLabel ? <Chip className="max-w-[160px] truncate">{originLabel}</Chip> : null}
        {item.usageCount > 0 ? <span className="text-[11px] text-muted-foreground">{t("memory:usedTimes", { count: item.usageCount })}</span> : null}
        {days !== null ? <span title={new Date(item.expiresAt!).toLocaleString(getLocale())} className={cn("inline-flex items-center gap-1 rounded px-1 text-[11px]", days <= 3 ? "bg-cand-surface text-cand-fg" : "text-muted-foreground")}>
          <Clock3 className="h-3 w-3" />{expiresToday ? t("memory:expiresToday") : t("memory:daysLeft", { count: days })}
        </span> : null}
        {driftLabel ? <span title={[...new Set(driftedFileRefs(item).map(ref => ref.path))].join("\n")} className="inline-flex items-center gap-1 rounded px-1 text-[11px] bg-cand-surface text-cand-fg"><FileWarning className="h-3 w-3" />{driftLabel}</span> : null}
        {item.lastTraceLabel ? (
          <span
            title={t(item.lastTraceCorrected ? "memory:lastTraceCorrected" : "memory:lastTrace", { v0: traceVerdictLabel(item.lastTraceLabel) })}
            className={cn("ml-auto h-2 w-2 shrink-0 rounded-full", TRACE_DOT_CLASSES[item.lastTraceLabel], item.lastTraceCorrected && "outline outline-1 outline-offset-1 outline-foreground/40")}
          />
        ) : null}
      </div>
      {age || capturedIn ? (
        <p className="mt-1.5 truncate text-[11px] text-muted-foreground/80">
          {age ?? ""}
          {capturedIn ? t("memory:capturedFrom", { v0: age ? " · " : "", v1: capturedIn }) : ""}
        </p>
      ) : null}
      {footer ? (
        <div
          className={variant === "scoped"
            ? "absolute right-1.5 top-1.5 flex items-center gap-1 rounded-lg bg-card opacity-0 transition-opacity focus-within:opacity-100 group-hover/card:opacity-100"
            : "mt-2 flex flex-wrap items-center justify-end gap-1.5"}
          onClick={handleFooterClick}
        >
          {footer}
        </div>
      ) : null}
    </div>
  )
}
