import { useMemo, useState } from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { FileInput, Folder, RotateCcw, Search, UserRound } from "lucide-react"
import type { NativeRemovedItem } from "../../../shared/native-memory"
import { getLocale, t } from "../../i18n"
import { projectName } from "../../lib/nativeMemoryPlan"
import { cn } from "../../lib/utils"
import { Button } from "../ui/button"
import { sourceTitle } from "./NativeImportReview"
import { NativeMemoryText } from "./NativeMemoryText"

interface Props {
  items: NativeRemovedItem[]
  busy: boolean
  onRestore: (removalIds: string[], mode: "import" | "suggest") => void
}

const SURFACE = "rounded-xl bg-card shadow-[0_0_0_1px_hsl(var(--border)),0_1px_2px_hsl(var(--foreground)/0.04)]"

/** Everything removed during review, so a removal can always be taken back. */
export function NativeRemovedList({ items, busy, onRestore }: Props) {
  const [query, setQuery] = useState("")
  const reduced = useReducedMotion()
  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const map = new Map<string, { key: string; label: string; personal: boolean; items: NativeRemovedItem[] }>()
    for (const item of items) {
      if (needle && !`${item.content} ${item.unitTitle} ${item.projectLabel ?? ""}`.toLowerCase().includes(needle)) continue
      const personal = item.owner.scope === "personal"
      const key = personal ? "personal" : `project:${item.projectLabel ?? item.projectPath ?? ""}`
      const group = map.get(key) ?? { key, label: personal ? t("nativeMemory:personalPreferences") : projectName(item.projectLabel ?? item.projectPath ?? ""), personal, items: [] }
      group.items.push(item)
      map.set(key, group)
    }
    return [...map.values()].sort((a, b) => Number(b.personal) - Number(a.personal) || b.items.length - a.items.length)
  }, [items, query])
  const date = new Intl.DateTimeFormat(getLocale(), { month: "short", day: "numeric" })

  return <div className="space-y-6">
    <label className="flex h-9 items-center gap-2 rounded-lg bg-background px-3 shadow-[inset_0_0_0_1px_hsl(var(--border))] focus-within:shadow-[inset_0_0_0_1px_hsl(var(--foreground)/0.3)]">
      <Search aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <input value={query} onChange={event => setQuery(event.target.value)} aria-label={t("nativeMemory:searchRemoved")} placeholder={t("nativeMemory:searchRemoved")} className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground" />
    </label>
    {groups.map(group => <section key={group.key} aria-label={group.label}>
      <div className="mb-3 flex items-center gap-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">{group.personal ? <UserRound aria-hidden className="size-3.5" /> : <Folder aria-hidden className="size-3.5" />}</span>
        <span className="min-w-0 truncate text-[15px] font-medium">{group.label}</span>
        <span className="text-xs tabular-nums text-muted-foreground">{t("nativeMemory:unitCount", { count: group.items.length })}</span>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => onRestore(group.items.map(item => item.removalId), "import")} className="ml-auto h-7 gap-1.5 px-2 text-[13px] font-normal text-muted-foreground">
          <FileInput aria-hidden className="size-3.5" />{t("nativeMemory:importAll")}
        </Button>
      </div>
      <ul className={cn(SURFACE, "overflow-hidden")}>
        <AnimatePresence initial={false}>{group.items.map((item, index) => <motion.li key={item.removalId} layout="position"
          exit={{ opacity: 0, height: 0, transition: reduced ? { duration: 0 } : { duration: 0.18 } }} className={cn(index > 0 && "border-t border-border/70")}>
          <div className="group/row flex items-start gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <NativeMemoryText content={item.content} repeats={[item.context, item.unitTitle]} />
              <p className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <span className="truncate">{sourceTitle(item.unitTitle)}</span>
                <span aria-hidden className="text-border">/</span>
                <time dateTime={item.removedAt} className="shrink-0 tabular-nums">{date.format(new Date(item.removedAt))}</time>
                {!item.sourceExists ? <><span aria-hidden className="text-border">/</span><span className="shrink-0">{t("nativeMemory:sourceGone")}</span></> : null}
              </p>
            </div>
            <div className="-mr-1.5 flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 [@media(hover:none)]:opacity-100">
              {item.undone ? null : <Button type="button" size="sm" variant="ghost" disabled={busy || !item.sourceExists} title={t("nativeMemory:suggestAgainHint")} onClick={() => onRestore([item.removalId], "suggest")} className="h-7 gap-1.5 px-2 text-[13px] font-normal text-muted-foreground">
                <RotateCcw aria-hidden className="size-3.5" />{t("nativeMemory:suggestAgain")}
              </Button>}
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onRestore([item.removalId], "import")} className="h-7 gap-1.5 px-2.5 text-[13px]">
                <FileInput aria-hidden className="size-3.5" />{t("nativeMemory:importOne")}
              </Button>
            </div>
          </div>
        </motion.li>)}</AnimatePresence>
      </ul>
    </section>)}
    {!groups.length ? <p className="py-16 text-center text-sm text-muted-foreground">{t(query ? "nativeMemory:noMatches" : "nativeMemory:nothingRemoved")}</p> : null}
  </div>
}
