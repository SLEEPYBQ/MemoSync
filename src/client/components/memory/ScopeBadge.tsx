// Small scope-related presentational atoms shared by the Memory Board, its
// cards, and the detail panel: a scope pill, a generic tag chip, and the
// scope metadata (label/icon) + tint-class lookups. Colors reuse the same
// literal class maps the citation-chip layer defined (memoryCitations.ts) so
// the board and inline citations stay visually identical (SPEC §2).
import type { ReactNode } from "react"
import { FolderGit2, MessagesSquare, User } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import type { MemoryScope, MemoryType } from "../../lib/memoriesApi"
import { MEMORY_SCOPE_CHIP_CLASSES, memoryScopeLabel } from "../../lib/memoryCitations"
import { cn } from "../../lib/utils"

export const SCOPES: MemoryScope[] = ["personal", "project", "session"]

export const SCOPE_ICONS: Record<MemoryScope, LucideIcon> = {
  personal: User,
  project: FolderGit2,
  session: MessagesSquare,
}

// Full literal strings (not template-built) so Tailwind's scanner can see them.
const SCOPE_CARD_CLASSES: Record<MemoryScope, string> = {
  personal: "border-personal-border bg-personal-surface",
  project: "border-project-border bg-project-surface",
  session: "border-session-border bg-session-surface",
}

const SCOPE_RING_CLASSES: Record<MemoryScope, string> = {
  personal: "ring-personal",
  project: "ring-project",
  session: "ring-session",
}

// Type taxonomy accents — scope owns the card SURFACE, type owns the type
// CHIP, so the two color channels never compete. constraint = a rule that can
// be violated (rose); preference = how the user likes things (violet);
// lesson = earned the hard way (amber); fact = plain ground truth (sky).
const TYPE_CHIP_CLASSES: Record<MemoryType, string> = {
  constraint: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  preference: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  lesson: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  fact: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
}

/** Chip tint for a memory type. */
export function typeChipClasses(type: MemoryType): string {
  return TYPE_CHIP_CLASSES[type] ?? ""
}

/** Type guard for an arbitrary (server-supplied) type string. */
export function isMemoryType(value: string): value is MemoryType {
  return value === "constraint" || value === "preference" || value === "lesson" || value === "fact"
}

/** Card tint (surface + border) for a scope. */
export function scopeCardClasses(scope: MemoryScope): string {
  return SCOPE_CARD_CLASSES[scope]
}

/** Selection-ring color for a scope. */
export function scopeRingClasses(scope: MemoryScope): string {
  return SCOPE_RING_CLASSES[scope]
}

/**
 * Project id to prefill when moving/dropping an item into project scope: keep
 * its own if it has one, else reuse any existing project memory's projectId,
 * else undefined — the caller must then make the user pick a real project.
 *
 * Never fabricate "default": no such project exists, so a memory bound to it
 * would never inject into any chat (BUG MEMUI-1). Undefined forces the picker.
 */
export function ScopeBadge({ scope, className }: { scope: MemoryScope; className?: string }) {
  const Icon = SCOPE_ICONS[scope]
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        MEMORY_SCOPE_CHIP_CLASSES[scope],
        className,
      )}
    >
      <Icon className="h-3 w-3" />
      {memoryScopeLabel(scope)}
    </span>
  )
}

/** Generic small pill for id/type/topic tags on a card or in the detail panel. */
export function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  )
}
