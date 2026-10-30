import { MEMORY_CARD } from "../memory/MemorySurface"
import type { ReactNode } from "react"
import { CheckCheck, Loader2, RotateCcw } from "lucide-react"
import { Button } from "../ui/button"

interface Props {
  title: string
  outcome: ReactNode
  consequence: string
  reopening: boolean
  onReopen?: () => Promise<void> | void
}

/**
 * Shared settled-state layout for Step 1 and Step 2. The first line records
 * what happened; the second line explains the downstream cost of reopening;
 * the outlined control is the only actionable element in the row.
 */
export function MemoryReviewStepSummary({ title, outcome, consequence, reopening, onReopen }: Props) {
  return (
    <div className={MEMORY_CARD}>
      <div className="flex flex-col gap-2 @lg:flex-row @lg:items-center @lg:justify-between @lg:gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-1 gap-y-0.5 text-xs">
            <CheckCheck aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="text-sm font-semibold text-foreground">{title}</span>
            <span className="text-muted-foreground">{outcome}</span>
          </div>
          {onReopen ? (
            <p className="mt-1 text-[11px] italic leading-4 text-muted-foreground">{consequence}</p>
          ) : null}
        </div>

        {onReopen ? (
          <Button
            variant="outline"
            size="xs"
            className="shrink-0 self-start @lg:self-center"
            disabled={reopening}
            onClick={() => void onReopen()}
          >
            {reopening ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
            Review again
          </Button>
        ) : null}
      </div>
    </div>
  )
}
