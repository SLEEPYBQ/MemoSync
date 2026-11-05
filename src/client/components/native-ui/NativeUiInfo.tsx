import type { ReactNode } from "react"
import { Info, type LucideIcon } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip"
import { cn } from "../../lib/utils"

/** Supplemental details for the native-harness surfaces only. */
export function NativeUiInfo({ label, children, className, icon: Icon = Info }: { label: string; children: ReactNode; className?: string; icon?: LucideIcon }) {
  return <Tooltip delayDuration={120}>
    <TooltipTrigger asChild>
      <button type="button" aria-label={label} className={cn("inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}>
        <Icon aria-hidden className="size-3.5" />
      </button>
    </TooltipTrigger>
    <TooltipContent className="max-w-80 whitespace-pre-wrap break-words text-xs leading-5">{children}</TooltipContent>
  </Tooltip>
}
