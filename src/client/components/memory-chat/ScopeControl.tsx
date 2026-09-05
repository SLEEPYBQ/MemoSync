// Segmented scope selector for the in-chat memory review flow (SPEC §5 —
// ported/re-skinned from v1's ScopeControl). Selected segment is tinted with
// that scope's color; unselected segments look like ghost buttons.
import { Check, FolderGit2, MessagesSquare, User } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import type { MemoryScope } from "../../lib/memoriesApi"
import { MEMORY_SCOPE_SELECTED_CLASSES } from "../../lib/memoryCitations"
import { cn } from "../../lib/utils"

const SCOPE_OPTIONS: { value: MemoryScope; label: string; icon: LucideIcon }[] = [
  { value: "session", label: "Session", icon: MessagesSquare },
  { value: "project", label: "Project", icon: FolderGit2 },
  { value: "personal", label: "Personal", icon: User },
]

// What the choice DOES — where the memory injects and how long it lives.
// The picker's labels alone made first-time users guess (friction #6).
export const SCOPE_CONSEQUENCES: Record<MemoryScope, string> = {
  session: "Only this chat — gone when the session ends.",
  project: "Injected in every chat of this project.",
  personal: "Injected across all your projects.",
}

interface ScopeControlProps {
  value: MemoryScope
  onValueChange: (scope: MemoryScope) => void
  className?: string
  disabled?: boolean
  /** Show a one-line consequence for the selected scope under the segments. */
  showConsequence?: boolean
}

export function ScopeControl({ value, onValueChange, className, disabled, showConsequence }: ScopeControlProps) {
  const segments = (
    <div className={cn("inline-flex max-w-full items-center gap-0.5 rounded-lg bg-muted/50 p-[3px]", !showConsequence && className)}>
      {SCOPE_OPTIONS.map(({ value: scope, label, icon: Icon }) => {
        const selected = scope === value
        return (
          <button
            key={scope}
            type="button"
            disabled={disabled}
            onClick={() => onValueChange(scope)}
            aria-pressed={selected}
            title={SCOPE_CONSEQUENCES[scope]}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
              selected
                ? MEMORY_SCOPE_SELECTED_CLASSES[scope]
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground dark:hover:bg-card"
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
            {selected ? <Check className="h-3.5 w-3.5" /> : null}
          </button>
        )
      })}
    </div>
  )
  if (!showConsequence) return segments
  return (
    <div className={cn("flex flex-col items-start gap-1", className)}>
      {segments}
      <p className="px-1 text-[11px] text-muted-foreground">{SCOPE_CONSEQUENCES[value]}</p>
    </div>
  )
}
