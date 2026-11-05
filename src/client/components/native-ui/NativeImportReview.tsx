import { useState, type ReactNode } from "react"
import { AnimatePresence, motion, useReducedMotion, type Transition } from "motion/react"
import { ChevronDown, Contact, Folder, Link2, ShieldAlert, UserRound, X, type LucideIcon } from "lucide-react"
import type { NativeImportItem, NativeImportOperation } from "../../../shared/native-memory"
import { t } from "../../i18n"
import { canApproveItem, projectName, proposalScope, reviewModel, type ProposalScope, type ReviewEntry, type ReviewSource } from "../../lib/nativeMemoryPlan"
import { cn } from "../../lib/utils"
import { NativeMemoryText } from "./NativeMemoryText"
import { NativeUiInfo } from "./NativeUiInfo"

const SPRING: Transition = { type: "spring", stiffness: 380, damping: 34, mass: 0.75 }
const STILL: Transition = { duration: 0 }
const SURFACE = "rounded-xl bg-card shadow-[0_0_0_1px_hsl(var(--border)),0_1px_2px_hsl(var(--foreground)/0.04)]"

const dispositionLabel = (item: NativeImportItem) => ({
  new: "", changed: t("nativeMemory:updatesExisting"), "exact-match": t("nativeMemory:existingItem"), unchanged: t("nativeMemory:existingItem"),
  conflict: t("nativeMemory:needsReview"), suppressed: t("nativeMemory:suppressed"),
})[item.disposition]
/** File slugs such as codex-dispatch-preferences read as code; show them as words. */
const WORD_CASE: Record<string, string> = {
  ai: "AI", api: "API", cli: "CLI", css: "CSS", id: "ID", llm: "LLM", mcp: "MCP", pr: "PR", prs: "PRs", ui: "UI", url: "URL", ux: "UX", readme: "README",
  claude: "Claude", codex: "Codex", github: "GitHub", memosync: "MemoSync", holaos: "holaOS", openai: "OpenAI", macos: "macOS",
}
export function sourceTitle(title: string) {
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)+(?:\.md)?$/i.test(title)) return title
  const words = title.replace(/\.md$/i, "").split(/[-_]/).map(word => WORD_CASE[word.toLowerCase()] ?? word.toLowerCase())
  // A word with its own casing (holaOS, macOS) keeps it even at the start.
  if (!WORD_CASE[title.split(/[-_]/)[0]!.toLowerCase()]) words[0] = words[0]![0]!.toUpperCase() + words[0]!.slice(1)
  return words.join(" ")
}

interface Props {
  operations: NativeImportOperation[]
  removed: ReadonlySet<string>
  overrides: Readonly<Record<string, ProposalScope>>
  busy: boolean
  onRemove: (keys: string[]) => void
  onMove: (key: string, scope: ProposalScope) => void
}

function IconButton({ label, onClick, children, danger }: { label: string; onClick: () => void; children: ReactNode; danger?: boolean }) {
  return <button type="button" aria-label={label} title={label} onClick={event => { event.stopPropagation(); onClick() }}
    className={cn("flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", danger ? "hover:text-destructive" : "hover:text-foreground")}>{children}</button>
}
const reveal = "opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 [@media(hover:none)]:opacity-100"

/** One memory as a row of a surface. Controls appear where the pointer or focus is. */
function MemoryRow({ entry, showSource, props }: { entry: ReviewEntry; showSource?: boolean; props: Props }) {
  const { item, saved } = entry
  const personal = Boolean(item.flags?.includes("personal-info"))
  const disposition = dispositionLabel(item)
  const allowed = canApproveItem(item)
  const scope = proposalScope(item, props.overrides)
  const canMove = Boolean(item.projectPath ?? item.owner.projectId)
  const quote = t("nativeMemory:sourceQuote", { start: item.provenance.startLine, end: item.provenance.endLine })
  const NoteIcon = disposition ? (allowed ? Link2 : ShieldAlert) : Contact
  const note = disposition || (personal ? t("nativeMemory:personalInfo") : "")
  const source = showSource && entry.unit ? sourceTitle(entry.unit.title) : ""
  return <div className="group/row flex items-start gap-3 px-4 py-3">
    <div className="min-w-0 flex-1">
      <NativeMemoryText content={item.content} repeats={[item.context]} />
      {note || source ? <p className="mt-1 flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground">
        {note ? <span className={cn("flex shrink-0 items-center gap-1", (personal && !disposition) || !allowed ? "text-amber-600 dark:text-amber-400" : "")}><NoteIcon aria-hidden className="size-3" />{note}</span> : null}
        {note && source ? <span aria-hidden className="text-border">/</span> : null}
        {source ? <span className="truncate">{source}</span> : null}
      </p> : null}
    </div>
    <div className={cn("-mr-1.5 -mt-0.5 flex shrink-0 items-center", reveal)}>
      {item.reason ? <NativeUiInfo label={note || t("nativeMemory:needsReview")} icon={ShieldAlert}>{item.reason}</NativeUiInfo> : null}
      <NativeUiInfo label={quote}>{item.provenance.quote}</NativeUiInfo>
      {!saved && canMove ? <IconButton label={t(scope === "personal" ? "nativeMemory:moveToProject" : "nativeMemory:moveToPersonal")} onClick={() => props.onMove(item.itemKey, scope === "personal" ? "project" : "personal")}>
        {scope === "personal" ? <Folder aria-hidden className="size-3.5" /> : <UserRound aria-hidden className="size-3.5" />}
      </IconButton> : null}
      {!saved && allowed ? <IconButton danger label={t("nativeMemory:removeItem")} onClick={() => props.onRemove([item.itemKey])}><X aria-hidden className="size-3.5" /></IconButton> : null}
    </div>
  </div>
}

function RowList({ entries, showSource, props }: { entries: ReviewEntry[]; showSource?: boolean; props: Props }) {
  const reduced = useReducedMotion()
  return <ul className={cn(SURFACE, "overflow-hidden")}>
    <AnimatePresence initial={false}>{entries.map((entry, index) => <motion.li key={entry.item.itemKey} layout="position" transition={reduced ? STILL : SPRING}
      exit={{ opacity: 0, height: 0, transition: reduced ? STILL : { duration: 0.18 } }} className={cn(index > 0 && "border-t border-border/70")}>
      <MemoryRow entry={entry} showSource={showSource} props={props} />
    </motion.li>)}</AnimatePresence>
  </ul>
}

/** A source is a stack: one click unfolds its memories out of the same surface, another folds them back. */
function SourceStack({ source, props }: { source: ReviewSource; props: Props }) {
  const [open, setOpen] = useState(false)
  const reduced = useReducedMotion()
  const spring = reduced ? STILL : SPRING
  const count = source.entries.length
  const layers = Math.min(count - 1, 2)
  const removable = source.entries.filter(entry => !entry.saved && canApproveItem(entry.item)).map(entry => entry.item.itemKey)
  return <motion.div layout="position" transition={spring} className="relative isolate" style={{ marginBottom: open ? 0 : layers * 6 }}>
    {/* Sheets underneath, narrower and lower, so the number of memories is felt before it is read. */}
    <AnimatePresence initial={false}>{!open ? Array.from({ length: layers }, (_, index) => <motion.div key={index} aria-hidden
      initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={spring}
      style={{ zIndex: -index - 1, left: 10 * (index + 1), right: 10 * (index + 1), bottom: -6 * (index + 1) }}
      className={cn("absolute top-0 rounded-xl shadow-[0_0_0_1px_hsl(var(--border))]", index === 0 ? "bg-card" : "bg-muted/70")} />) : null}</AnimatePresence>
    <div className={cn(SURFACE, "relative overflow-hidden transition-shadow", !open && "hover:shadow-[0_0_0_1px_hsl(var(--foreground)/0.16),0_8px_20px_-14px_hsl(var(--foreground)/0.35)]")}>
      <div role="button" tabIndex={0} aria-expanded={open} onClick={() => setOpen(!open)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpen(!open) } }}
        className="group/row flex cursor-pointer items-start gap-3 px-4 py-3.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <div className="min-w-0 flex-1">
          <h5 className="truncate text-[14px] font-medium leading-5" title={source.title}>{sourceTitle(source.title)}</h5>
          {source.summary ? <p className="mt-1 line-clamp-2 text-[13px] leading-5 text-muted-foreground" title={source.summary}>{source.summary}</p> : null}
        </div>
        <div className="-mr-1.5 flex shrink-0 items-center gap-0.5">
          {removable.length ? <span className={reveal}><IconButton danger label={t("nativeMemory:removeSource", { count: removable.length })} onClick={() => props.onRemove(removable)}><X aria-hidden className="size-3.5" /></IconButton></span> : null}
          <span className="w-12 text-right text-xs tabular-nums text-muted-foreground">{t("nativeMemory:unitCount", { count })}</span>
          <ChevronDown aria-hidden className={cn("ml-1 size-4 text-muted-foreground transition-transform duration-300 motion-reduce:transition-none", open && "rotate-180")} />
        </div>
      </div>
      <AnimatePresence initial={false}>{open ? <motion.ul key="rows" initial={{ height: 0 }} animate={{ height: "auto" }} exit={{ height: 0 }} transition={spring} className="overflow-hidden border-t border-border/70 bg-muted/20">
        <AnimatePresence initial={false}>{source.entries.map((entry, index) => <motion.li key={entry.item.itemKey} layout="position"
          // Each memory slides out from under the one above it; folding plays it back up.
          initial={{ opacity: 0, y: -14 }} animate={{ opacity: 1, y: 0, transition: { ...spring, delay: reduced ? 0 : Math.min(index, 8) * 0.03 } }}
          exit={{ opacity: 0, height: 0, transition: reduced ? STILL : { duration: 0.16 } }} className={cn(index > 0 && "border-t border-border/60")}>
          <MemoryRow entry={entry} props={props} />
        </motion.li>)}</AnimatePresence>
      </motion.ul> : null}</AnimatePresence>
    </div>
  </motion.div>
}

function SectionHeader({ icon: Icon, tone = "neutral", title, meta, hint, onRemoveAll, open, onToggle }: { icon: LucideIcon; tone?: "neutral" | "attention"; title: string; meta: string; hint?: string; onRemoveAll?: () => void; open?: boolean; onToggle?: () => void }) {
  const body = <>
    <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg", tone === "attention" ? "bg-amber-500/12 text-amber-600 dark:text-amber-400" : "bg-muted text-muted-foreground")}><Icon aria-hidden className="size-3.5" /></span>
    <span className="min-w-0 flex-1 text-left">
      <span className="flex items-baseline gap-2"><span className="truncate text-[15px] font-medium" title={title}>{title}</span><span className="shrink-0 text-xs tabular-nums text-muted-foreground">{meta}</span></span>
    </span>
  </>
  return <div className="group/row mb-3 flex items-center gap-3">
    {onToggle ? <button type="button" aria-expanded={open} onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-3 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{body}</button> : <div className="flex min-w-0 flex-1 items-center gap-3">{body}</div>}
    {hint ? <NativeUiInfo label={hint} className={onToggle ? "-ml-1" : "-ml-2"}>{hint}</NativeUiInfo> : null}
    <div className="-mr-1.5 flex shrink-0 items-center">
      {onRemoveAll ? <span className={reveal}><IconButton danger label={t("nativeMemory:removeGroup", { name: title })} onClick={onRemoveAll}><X aria-hidden className="size-3.5" /></IconButton></span> : null}
      {onToggle ? <button type="button" tabIndex={-1} aria-hidden onClick={onToggle} className="flex size-7 items-center justify-center text-muted-foreground"><ChevronDown className={cn("size-4 transition-transform duration-300 motion-reduce:transition-none", !open && "-rotate-90")} /></button> : null}
    </div>
  </div>
}

function ProjectSection({ icon, title, meta, hint, sources, defaultOpen, onRemoveAll, props }: { icon: LucideIcon; title: string; meta: string; hint?: string; sources: ReviewSource[]; defaultOpen: boolean; onRemoveAll?: () => void; props: Props }) {
  const [open, setOpen] = useState(defaultOpen)
  const reduced = useReducedMotion()
  return <section aria-label={title}>
    <SectionHeader icon={icon} title={title} meta={meta} hint={hint} open={open} onToggle={() => setOpen(!open)} onRemoveAll={onRemoveAll} />
    <AnimatePresence initial={false}>{open ? <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={reduced ? STILL : SPRING} className="-mx-1 overflow-hidden px-1">
      <div className="space-y-3 pb-4 pt-0.5">{sources.map(source => <SourceStack key={source.key} source={source} props={props} />)}</div>
    </motion.div> : null}</AnimatePresence>
  </section>
}

const removableKeys = (entries: ReviewEntry[]) => entries.filter(entry => !entry.saved && canApproveItem(entry.item)).map(entry => entry.item.itemKey)

/** Arranged by consequence: what needs a look, what reaches every project, then project memory by source. */
export function NativeImportReview(props: Props) {
  const model = reviewModel(props.operations, props.overrides, props.removed)
  return <div className="space-y-8">
    {model.attention.length ? <section aria-label={t("nativeMemory:needsLook")}>
      <SectionHeader icon={ShieldAlert} tone="attention" title={t("nativeMemory:needsLook")} meta={t("nativeMemory:unitCount", { count: model.attention.length })} hint={t("nativeMemory:needsLookHint")} />
      <RowList entries={model.attention} showSource props={props} />
    </section> : null}
    {model.personal.length ? (() => {
      const keys = removableKeys(model.personal.flatMap(source => source.entries))
      return <ProjectSection icon={UserRound} title={t("nativeMemory:personalPreferences")} hint={t("nativeMemory:personalHint")}
        meta={t("nativeMemory:projectMeta", { sources: model.personal.length, count: model.personalCount })} sources={model.personal}
        defaultOpen onRemoveAll={keys.length ? () => props.onRemove(keys) : undefined} props={props} />
    })() : null}
    {model.projects.map(project => {
      const keys = removableKeys(project.sources.flatMap(source => source.entries))
      return <ProjectSection key={project.key} title={project.unattributed ? t("nativeMemory:unresolvedProject") : projectName(project.label)}
        meta={t("nativeMemory:projectMeta", { sources: project.sources.length, count: project.count })} icon={project.unattributed ? ShieldAlert : Folder} sources={project.sources}
        defaultOpen={model.projects.length <= 2} onRemoveAll={keys.length ? () => props.onRemove(keys) : undefined} props={props} />
    })}
  </div>
}
