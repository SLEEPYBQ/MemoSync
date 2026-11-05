import { t } from "../../i18n"
import { memoryLines } from "../../lib/nativeMemoryPlan"
import { cn } from "../../lib/utils"

const SHOWN = 6

/** A refined claim reads as one sentence; a verbatim import keeps its lines and lists. */
export function NativeMemoryText({ content, repeats, className }: { content: string; repeats?: Array<string | undefined>; className?: string }) {
  const lines = memoryLines(content, repeats)
  if (lines.length === 1) return <p className={cn("break-words text-[14px] leading-6 text-foreground", className)}>{lines[0]!.text}</p>
  const hidden = lines.length - SHOWN
  return <div className={cn("space-y-0.5 break-words text-[14px] leading-6 text-foreground", className)}>
    {lines.slice(0, hidden > 1 ? SHOWN : lines.length).map((line, index) => line.kind === "heading"
      ? <p key={index} className={cn("font-medium", index > 0 && "pt-1")}>{line.text}</p>
      : line.kind === "item"
        ? <p key={index} className="flex gap-2"><span aria-hidden className="mt-[0.7em] size-1 shrink-0 rounded-full bg-muted-foreground/60" /><span className="min-w-0">{line.text}</span></p>
        : <p key={index}>{line.text}</p>)}
    {hidden > 1 ? <p className="text-[13px] text-muted-foreground">{t("nativeMemory:moreLines", { count: hidden })}</p> : null}
  </div>
}
