import { useI18n } from "../../i18n"
// Small scope-related presentational atoms shared by the Memory Board, its
// cards, and the detail panel: a scope pill, a generic tag chip, and the
// scope metadata (label/icon) + neutral card lookups. Chips reuse the same
// literal class maps the citation-chip layer defined (memoryCitations.ts) so
// the board and inline citations stay visually identical (SPEC §2).
import type { ReactNode } from "react"
import { FolderGit2, MessagesSquare, User } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import type { MemoryScope, MemoryType } from "../../lib/memoriesApi"
import { MEMORY_SCOPE_CHIP_CLASSES, memoryScopeLabel } from "../../lib/memoryCitations"
import { MemoryBadge } from "./MemoryBadge"
import { cn } from "../../lib/utils"

export const SCOPES: MemoryScope[] = ["personal", "project", "session"]

export const SCOPE_ICONS: Record<MemoryScope, LucideIcon> = {
  personal: User,
  project: FolderGit2,
  session: MessagesSquare,
}

// Full literal strings (not template-built) so Tailwind's scanner can see them.
const SCOPE_CARD_CLASSES: Record<MemoryScope, string> = {
  personal: "border-border bg-card",
  project: "border-border bg-card",
  session: "border-border bg-card",
}

const SCOPE_RING_CLASSES: Record<MemoryScope, string> = {
  personal: "ring-ring",
  project: "ring-ring",
  session: "ring-ring",
}

// Type is descriptive metadata; only scope chips own the three scope hues.
const TYPE_CHIP_CLASSES: Record<MemoryType, string> = {
  constraint: "border-border bg-muted/50 text-muted-foreground",
  preference: "border-border bg-muted/50 text-muted-foreground",
  lesson: "border-border bg-muted/50 text-muted-foreground",
  fact: "border-border bg-muted/50 text-muted-foreground",
}

/** Chip tint for a memory type. */
export function typeChipClasses(type: MemoryType): string {
  return TYPE_CHIP_CLASSES[type] ?? ""
}

/** Type guard for an arbitrary (server-supplied) type string. */
export function isMemoryType(value: string): value is MemoryType {
  return value === "constraint" || value === "preference" || value === "lesson" || value === "fact"
}

/** All cards use a neutral surface; scope color belongs to the chip. */
export function scopeCardClasses(scope: MemoryScope): string {
  return SCOPE_CARD_CLASSES[scope]
}

/** Neutral selection ring, shared across scopes. */
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
  useI18n()
  const Icon = SCOPE_ICONS[scope]
  return (
    <MemoryBadge
      className={cn(
        MEMORY_SCOPE_CHIP_CLASSES[scope],
        className,
      )}
    >
      <Icon aria-hidden className="h-3 w-3 shrink-0" />
      {memoryScopeLabel(scope)}
    </MemoryBadge>
  )
}

/** Generic small pill for id/type/topic tags on a card or in the detail panel. */
export function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <MemoryBadge className={className}>
      {children}
    </MemoryBadge>
  )
}
