import type { ComponentProps, ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import { cn } from "../../lib/utils"

export const MEMORY_CARD = "memory-ui memory-card @container min-w-0 rounded-xl border border-border bg-card p-[clamp(0.75rem,3%,1rem)] text-sm leading-relaxed"
export const MEMORY_INNER = "min-w-0 rounded-lg border border-border/70 bg-background/60 dark:bg-muted/40"
export const MEMORY_FOOTER = "flex flex-wrap items-center justify-end gap-2"

/** A soft attention surface: icon, optional title, body, then optional action. */
export function MemoryCallout({ icon: Icon, title, tone = "info", children, className, ...props }: Omit<ComponentProps<"div">, "title"> & {
  icon: LucideIcon
  title?: ReactNode
  tone?: "info" | "success" | "pending" | "destructive"
}) {
  return <div {...props} className={cn("memory-ui flex min-w-0 flex-wrap items-start gap-2 rounded-lg border p-3 text-sm leading-relaxed", {
    info: "border-info/25 bg-info/8 text-info-foreground",
    success: "border-success/25 bg-success/8 text-success-foreground",
    pending: "border-cand-border bg-cand-surface text-cand-fg",
    destructive: "border-destructive/25 bg-destructive/8 text-destructive",
  }[tone], className)}>
    <Icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
    <div className="min-w-0 flex-1 basis-40">
      {title ? <p className="font-semibold">{title}</p> : null}
      <div className="text-foreground/80">{children}</div>
    </div>
  </div>
}

export function MemoryEmpty({ icon: Icon, children, className }: { icon: LucideIcon; children: ReactNode; className?: string }) {
  return <div className={cn("memory-ui flex min-w-0 flex-col items-center gap-2 rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground", className)}>
    <Icon aria-hidden className="h-5 w-5" />
    <p className="max-w-sm text-pretty">{children}</p>
  </div>
}
