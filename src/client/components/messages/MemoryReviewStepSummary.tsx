import type { ReactNode } from "react"
import { Loader2, RotateCcw } from "lucide-react"
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
    <div className="rounded-xl border border-border bg-card px-4 py-3 shadow-sm">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-1 gap-y-0.5 text-xs">
            <span className="font-medium text-foreground">{title}</span>
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
            className="shrink-0 self-start sm:self-center"
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
