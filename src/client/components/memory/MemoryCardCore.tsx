// The canonical READ-ONLY face of a memory item (redesign 2026-08-07 §4:
// shared operable representation). Body = short content + usage count + scope
// + expandable Detail, identical everywhere. Hosts (candidate container,
// checkup suggestions, injected-set card, audit rows, board, hover popovers)
// embed this body and keep their action buttons OUTSIDE it — the
// representation itself never carries actions.
import { useState } from "react"
import { ChevronRight } from "lucide-react"
import type { MemoryItem } from "../../lib/memoriesApi"
import { cn } from "../../lib/utils"
import { MEMORY_SCOPE_TEXT_CLASSES, isMemoryScope, memoryScopeLabel } from "../../lib/memoryCitations"

export type MemoryCardCoreItem = Pick<MemoryItem, "id" | "content" | "scope" | "usageCount"> &
  Partial<Pick<MemoryItem, "detail" | "version" | "provenanceSessionId" | "provenanceTurn">>

export function MemoryCardCore({ item, className }: { item: MemoryCardCoreItem; className?: string }) {
  const [detailOpen, setDetailOpen] = useState(false)
  const scope = isMemoryScope(item.scope) ? item.scope : "session"
  const provenanceParts: string[] = []
  if (item.provenanceSessionId) provenanceParts.push(`from session ${item.provenanceSessionId.slice(0, 8)}`)
  if (item.provenanceTurn !== undefined) provenanceParts.push(`t${item.provenanceTurn}`)

  return (
    <div className={cn("space-y-1.5 text-xs", className)}>
      <div className="flex flex-wrap items-center gap-1.5 font-mono text-muted-foreground">
        <span>
          {item.id}
          {item.version !== undefined ? ` v${item.version}` : ""}
        </span>
        <span>·</span>
        <span className={cn("font-sans font-medium", MEMORY_SCOPE_TEXT_CLASSES[scope])}>{memoryScopeLabel(scope)}</span>
        <span className="ml-auto font-sans">used {item.usageCount ?? 0}×</span>
      </div>
      <p className="whitespace-pre-wrap text-sm text-foreground">{item.content}</p>
      {item.detail ? (
        <>
          <button
            type="button"
            onClick={() => setDetailOpen(!detailOpen)}
            className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground hover:text-foreground"
          >
            <ChevronRight className={cn("h-3 w-3 transition-transform", detailOpen && "rotate-90")} />
            Detail
          </button>
          {detailOpen ? (
            <p className="whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-2 text-xs text-muted-foreground">
              {item.detail}
            </p>
          ) : null}
        </>
      ) : null}
      {provenanceParts.length > 0 ? <p className="text-muted-foreground/80">{provenanceParts.join(" · ")}</p> : null}
    </div>
  )
}
