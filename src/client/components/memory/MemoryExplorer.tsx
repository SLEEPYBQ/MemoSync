// The left rail of the memory screen: search, then every place a memory can live.
import { Archive, BellOff, ChevronRight, Clock3, FileText, FileWarning, FolderGit2, Inbox, Layers, MessagesSquare, Search, User } from "lucide-react"
import { useState, type ComponentType, type ReactNode } from "react"
import { t, useI18n } from "../../i18n"
import type { MemoryItem, MemoryScope } from "../../lib/memoriesApi"
import { cn } from "../../lib/utils"
import { isExpiringSoon } from "../../lib/memoryExpiry"
import { driftedFileRefs } from "../../lib/memoryFileDrift"

export type MemoryLens =
  | { kind: "all" }
  | { kind: "expiring" }
  | { kind: "drift" }
  | { kind: "scope"; scope: MemoryScope }
  | { kind: "project"; id: string }
  | { kind: "session"; id: string }
  | { kind: "archived" }
  | { kind: "muted" }
  | { kind: "files" }

export function memoryLensKey(lens: MemoryLens): string {
  if (lens.kind === "scope") return `scope:${lens.scope}`
  if (lens.kind === "project" || lens.kind === "session") return `${lens.kind}:${lens.id}`
  return lens.kind
}

/** Does this memory belong to the lens? Lenses without memories match nothing. */
export function memoryMatchesLens(item: MemoryItem, lens: MemoryLens): boolean {
  switch (lens.kind) {
    case "all":
      return true
    case "expiring":
      return isExpiringSoon(item)
    case "drift":
      return driftedFileRefs(item).length > 0
    case "scope":
      return item.scope === lens.scope
    case "project":
      return item.scope === "project" && item.projectId === lens.id
    case "session":
      return item.scope === "session" && item.sessionId === lens.id
    default:
      return false
  }
}

function Row({
  icon: Icon,
  label,
  count,
  countClassName,
  active,
  depth = 0,
  dot,
  expanded,
  onToggle,
  onClick,
}: {
  icon?: ComponentType<{ className?: string }>
  label: ReactNode
  count?: ReactNode
  countClassName?: string
  active?: boolean
  depth?: number
  dot?: string
  expanded?: boolean
  onToggle?: () => void
  onClick: () => void
}) {
  return (
    <div
      className={cn(
        "group/row flex h-7 items-center rounded-md text-[13px] transition-colors",
        active ? "bg-black/[0.07] text-foreground dark:bg-white/[0.09]" : "text-foreground/75 hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/[0.05]",
      )}
      style={{ paddingLeft: depth ? 8 + depth * 14 : 0 }}
    >
      {onToggle ? (
        <button type="button" aria-expanded={expanded} className="flex size-6 shrink-0 items-center justify-center text-muted-foreground" onClick={onToggle}>
          <ChevronRight className={cn("size-3.5 transition-transform duration-150", expanded && "rotate-90")} />
        </button>
      ) : depth === 0 ? <span className="w-1.5 shrink-0" /> : null}
      <button type="button" className="flex h-full min-w-0 flex-1 items-center gap-2 pr-2 text-left" onClick={onClick}>
        {dot ? <span aria-hidden className={cn("size-2 shrink-0 rounded-full", dot)} /> : null}
        {Icon ? <Icon className="size-3.5 shrink-0 text-muted-foreground" /> : null}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {count !== undefined && count !== 0 ? <span className={cn("shrink-0 text-[11px] tabular-nums text-muted-foreground", countClassName)}>{count}</span> : null}
      </button>
    </div>
  )
}

export function MemoryExplorer({
  items,
  lens,
  onLensChange,
  query,
  onQueryChange,
  projectTitles,
  chatTitles,
  pendingCount,
  archivedCount,
  mutedCount,
  onOpenReview,
}: {
  items: MemoryItem[]
  lens: MemoryLens
  onLensChange: (lens: MemoryLens) => void
  query: string
  onQueryChange: (query: string) => void
  projectTitles: Record<string, string>
  chatTitles: Record<string, string>
  pendingCount: number
  archivedCount: number
  mutedCount: number | null
  onOpenReview: () => void
}) {
  useI18n()
  const [projectsOpen, setProjectsOpen] = useState(true)
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const live = items.filter((item) => item.status === "active")
  const count = (match: (item: MemoryItem) => boolean) => live.filter(match).length
  const projects = [...new Set(live.filter((item) => item.scope === "project" && item.projectId).map((item) => item.projectId as string))]
  const sessions = [...new Set(live.filter((item) => item.scope === "session" && item.sessionId).map((item) => item.sessionId as string))]
  const activeKey = memoryLensKey(lens)
  const is = (next: MemoryLens) => memoryLensKey(next) === activeKey
  const driftCount = items.filter(item => (item.status === "active" || item.status === "candidate") && driftedFileRefs(item).length > 0).length

  return (
    <nav aria-label={t("common:memory")} className="flex min-h-0 flex-1 flex-col bg-muted/50">
      <div className="p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t("board:searchMemories")}
            className="h-8 w-full rounded-lg border-0 bg-card pl-8 pr-2.5 !text-[13px] text-foreground shadow-[0_0_0_1px_hsl(var(--border))] outline-none transition-shadow placeholder:text-muted-foreground/80 focus:shadow-[0_0_0_1px_hsl(var(--foreground)/0.3)]"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-px overflow-y-auto px-2 pb-2">
        <Row icon={Layers} label={t("board:allMemories")} count={live.length} active={is({ kind: "all" })} onClick={() => onLensChange({ kind: "all" })} />
        {driftCount > 0 || lens.kind === "drift" ? <Row icon={FileWarning} label={t("memory:needsFileCheck")} count={driftCount} countClassName="text-cand-fg" active={is({ kind: "drift" })} onClick={() => onLensChange({ kind: "drift" })} /> : null}
        <Row icon={Clock3} label={t("memory:expiringSoon")} count={count(item => isExpiringSoon(item))} active={is({ kind: "expiring" })} onClick={() => onLensChange({ kind: "expiring" })} />
        <Row
          icon={User}
          label={t("common:personal")}
          count={count((item) => item.scope === "personal")}
          active={is({ kind: "scope", scope: "personal" })}
          onClick={() => onLensChange({ kind: "scope", scope: "personal" })}
        />
        <Row
          icon={FolderGit2}
          label={t("board:projectsLabel")}
          count={count((item) => item.scope === "project")}
          active={is({ kind: "scope", scope: "project" })}
          expanded={projectsOpen}
          onToggle={projects.length > 0 ? () => setProjectsOpen((open) => !open) : undefined}
          onClick={() => onLensChange({ kind: "scope", scope: "project" })}
        />
        {projectsOpen ? projects.map((id) => (
          <Row
            key={id}
            depth={1}
            label={projectTitles[id] ?? id}
            count={count((item) => item.scope === "project" && item.projectId === id)}
            active={is({ kind: "project", id })}
            onClick={() => onLensChange({ kind: "project", id })}
          />
        )) : null}
        <Row
          icon={MessagesSquare}
          label={t("board:sessionsLabel")}
          count={count((item) => item.scope === "session")}
          active={is({ kind: "scope", scope: "session" })}
          expanded={sessionsOpen}
          onToggle={sessions.length > 0 ? () => setSessionsOpen((open) => !open) : undefined}
          onClick={() => onLensChange({ kind: "scope", scope: "session" })}
        />
        {sessionsOpen ? sessions.map((id) => (
          <Row
            key={id}
            depth={1}
            label={chatTitles[id] ?? id}
            count={count((item) => item.scope === "session" && item.sessionId === id)}
            active={is({ kind: "session", id })}
            onClick={() => onLensChange({ kind: "session", id })}
          />
        )) : null}

        <div className="!my-2 mx-1.5 h-px bg-border" />

        <Row icon={Inbox} label={t("board:toReview")} count={pendingCount} onClick={onOpenReview} />
        <Row icon={Archive} label={t("board:archived")} count={archivedCount} active={is({ kind: "archived" })} onClick={() => onLensChange({ kind: "archived" })} />
        <Row icon={BellOff} label={t("board:mutedProposals")} count={mutedCount ?? undefined} active={is({ kind: "muted" })} onClick={() => onLensChange({ kind: "muted" })} />
        <Row icon={FileText} label={t("memory:memoryFiles")} active={is({ kind: "files" })} onClick={() => onLensChange({ kind: "files" })} />
      </div>
    </nav>
  )
}
