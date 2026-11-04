// The memories that shaped a step, right on the step. Hovering one shows the
// memory and what the audit saw; a violated one is marked without any hover.
import { useMemo } from "react"
import { translateServerUiText } from "../../i18n/uiText"
import type { ToolMemoryUse } from "../../lib/toolMemoryUses"
import { MessageViolatedCitationsProvider } from "./render-context"
import { MemoryCitationChip } from "./shared"

const VISIBLE_CHIPS = 3

export function ToolMemoryChips({ uses }: { uses: readonly ToolMemoryUse[] }) {
  const violated = useMemo(() => new Set(uses.filter((use) => use.violated).map((use) => use.id)), [uses])
  if (uses.length === 0) return null
  // Violations are the ones worth seeing when there isn't room for all of them.
  const ordered = [...uses].sort((a, b) => Number(b.violated) - Number(a.violated))
  const hidden = ordered.length - VISIBLE_CHIPS
  return (
    <MessageViolatedCitationsProvider value={violated}>
      <span className="memory-ui inline-flex shrink-0 items-center gap-1" data-tool-memory-uses={uses.map((use) => use.id).join(" ")}>
        {ordered.slice(0, VISIBLE_CHIPS).map((use) => (
          <MemoryCitationChip key={use.id} id={use.id} note={use.note ? translateServerUiText(use.noteUiText, use.note) : undefined}>
            {use.id}
          </MemoryCitationChip>
        ))}
        {hidden > 0 ? <span className="text-[11px] tabular-nums text-muted-foreground">+{hidden}</span> : null}
      </span>
    </MessageViolatedCitationsProvider>
  )
}
