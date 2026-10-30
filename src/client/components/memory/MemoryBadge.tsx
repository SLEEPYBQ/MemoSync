import type { ComponentProps, ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import { cn } from "../../lib/utils"

export const MEMORY_BADGE_BASE = "inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-4"

const TONES = {
  neutral: "border-border bg-muted/50 text-muted-foreground",
  pending: "border-cand-border bg-cand-surface text-cand-fg",
  success: "border-success/25 bg-success/8 text-success-foreground",
  info: "border-info/25 bg-info/8 text-info-foreground",
  destructive: "border-destructive/25 bg-destructive/8 text-destructive",
} as const

/** Status has one vocabulary; scope chips supply their own canonical token map. */
export function MemoryBadge({ tone = "neutral", icon: Icon, className, children, ...props }: ComponentProps<"span"> & {
  tone?: keyof typeof TONES
  icon?: LucideIcon
  children: ReactNode
}) {
  return <span {...props} className={cn(MEMORY_BADGE_BASE, TONES[tone], className)}>
    {Icon ? <Icon aria-hidden className="h-3 w-3 shrink-0" /> : null}
    {children}
  </span>
}
