import { useEffect, useMemo, useRef, useState } from "react"
import { ArrowLeft, Check, ChevronRight, FileInput, History, Loader2, RotateCw, ShieldAlert, Sparkles, Square, Trash2, Undo2 } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import type { NativeImportHistory, NativeImportOperation, NativeRemovedItem, NativeInventoryResult, NativeMemoryUnit, NativeModelSelection, NativeOverviewResult, NativeRefineJob, NativeUnitSource } from "../../../shared/native-memory"
import { getLocale, t, useI18n } from "../../i18n"
import { useModelAccessStore } from "../../model-access/modelAccess"
import { nativeMemoryApi } from "../../lib/nativeMemoryApi"
import { buildMemoryTree, canApproveItem, defaultRefineModel, defaultUnitSelection, estimateRefineTokens, formatTokens, isJobActive, isSelectable, jobProgress, selectionBreakdown, summarizeSelection, type ProposalScope } from "../../lib/nativeMemoryPlan"
import { cn, generateUUID } from "../../lib/utils"
import { NativeCheckbox } from "../native-ui/NativeCheckbox"
import { NativeImportReview } from "../native-ui/NativeImportReview"
import { BrandTile, ENGINE_BRANDS } from "../brand/BrandIcon"
import { BrandIcon } from "../BrandMark"
import { groupName, NativeMemorySourceTree } from "../native-ui/NativeMemorySourceTree"
import { NativeRefineComposer, type NativeImportMode } from "../native-ui/NativeRefineComposer"
import { NativeUiInfo } from "../native-ui/NativeUiInfo"
import { NativeRemovedList } from "../native-ui/NativeRemovedList"
import { Button } from "../ui/button"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId?: string
  onChanged: () => Promise<void> | void
}

type Stage = "plan" | "job" | "review" | "history" | "removed"
const MODEL_KEY = "memosync.nativeRefine.model"
const JOB_KEY = "memosync.nativeRefine.job"
const POLL_MS = 1200

const storedModel = (): NativeModelSelection | null => {
  try { return JSON.parse(localStorage.getItem(MODEL_KEY) ?? "null") } catch { return null }
}

export function NativeMemoryImportDialog({ open, onOpenChange, projectId, onChanged }: Props) {
  useI18n()
  const providers = useModelAccessStore(store => store.snapshot?.providers) ?? []
  const [inventory, setInventory] = useState<NativeInventoryResult | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [stage, setStage] = useState<Stage>("plan")
  const [mode, setMode] = useState<NativeImportMode>("refine")
  const [chosenModel, setChosenModel] = useState<NativeModelSelection | null>(storedModel)
  const [instruction, setInstruction] = useState("")
  const [overview, setOverview] = useState<NativeOverviewResult | null>(null)
  const [source, setSource] = useState<NativeUnitSource | null>(null)
  const [job, setJob] = useState<NativeRefineJob | null>(null)
  const [operations, setOperations] = useState<NativeImportOperation[]>([])
  const [approved, setApproved] = useState<Set<string>>(new Set())
  const [rejected, setRejected] = useState<Set<string>>(new Set())
  const [overrides, setOverrides] = useState<Record<string, ProposalScope>>({})
  const [removals, setRemovals] = useState<string[][]>([])
  const [history, setHistory] = useState<NativeImportHistory | null>(null)
  const [removedItems, setRemovedItems] = useState<NativeRemovedItem[]>([])
  const [restored, setRestored] = useState<{ count: number; operationId?: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const lease = useRef(0)
  const dialogRef = useRef<HTMLDivElement>(null)

  const available = chosenModel && providers.some(provider => provider.id === chosenModel.provider) ? chosenModel : null
  const model = available ?? defaultRefineModel(providers)
  const sections = useMemo(() => inventory ? buildMemoryTree(inventory) : [], [inventory])
  const summary = useMemo(() => summarizeSelection(inventory?.units ?? [], selected), [inventory, selected])
  const breakdown = useMemo(() => selectionBreakdown(sections, selected), [sections, selected])

  async function run(kind: string, action: (current: number) => Promise<void>) {
    const current = lease.current
    setBusy(kind)
    setError(null)
    try { await action(current) }
    catch (err) { if (lease.current === current) setError(err instanceof Error ? err.message : t("nativeMemory:actionFailed")) }
    finally { if (lease.current === current) setBusy(null) }
  }

  async function reloadInventory(current: number, signal?: AbortSignal) {
    const next = await nativeMemoryApi.inventory(signal)
    if (lease.current !== current) return
    setInventory(next)
    setSelected(defaultUnitSelection(next, projectId))
    const removed = await nativeMemoryApi.removed(signal).catch(() => null)
    if (removed && lease.current === current) setRemovedItems(removed.items)
  }

  function showOperations(values: NativeImportOperation[]) {
    setOperations(values)
    setApproved(new Set(values.filter(value => !value.receipt).flatMap(value => value.plan.items.filter(canApproveItem).map(item => item.itemKey))))
    setRejected(new Set(values.flatMap(value => value.receipt?.rejected ?? [])))
    setOverrides({})
    setRemovals([])
    setStage("review")
  }

  async function openJobResults(finished: NativeRefineJob, current: number) {
    // Batches of one job share an operation.
    const ids = [...new Set(finished.batches.flatMap(batch => batch.operationId ? [batch.operationId] : []))]
    const values = await Promise.all(ids.map(id => nativeMemoryApi.operation(id)))
    if (lease.current === current) showOperations(values)
  }

  useEffect(() => {
    if (!open) return
    const current = ++lease.current
    const controller = new AbortController()
    setStage("plan"); setSource(null); setOverview(null); setJob(null); setOperations([]); setError(null); setInstruction("")
    autoReviewed.current = null
    void run("loading", async () => {
      await reloadInventory(current, controller.signal)
      const jobId = localStorage.getItem(JOB_KEY)
      if (!jobId) return
      const saved = await nativeMemoryApi.job(jobId, controller.signal).catch(() => null)
      if (lease.current !== current) return
      if (!saved) { localStorage.removeItem(JOB_KEY); return }
      setJob(saved)
      setStage("job")
    })
    return () => { controller.abort(); lease.current++ }
  }, [open, projectId])

  const jobId = job?.jobId
  const active = job ? isJobActive(job) : false
  useEffect(() => {
    if (!open || !jobId || !active) return
    const current = lease.current
    const timer = setInterval(() => {
      void nativeMemoryApi.job(jobId).then(next => { if (lease.current === current) setJob(next) }).catch(() => undefined)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [open, jobId, active])

  // A finished job with nothing failed goes straight to its proposals.
  const autoReviewed = useRef<string | null>(null)
  useEffect(() => {
    if (!job || job.state !== "completed" || stage !== "job" || autoReviewed.current === job.jobId) return
    // The job stays remembered until its proposals are imported or left, so closing review loses nothing.
    autoReviewed.current = job.jobId
    void run("review", current => openJobResults(job, current))
  }, [job, stage])

  function toggleUnits(ids: string[], checked: boolean) {
    setSelected(previous => { const next = new Set(previous); for (const id of ids) { if (checked) next.add(id); else next.delete(id) } return next })
  }

  function chooseModel(next: NativeModelSelection) {
    setChosenModel(next)
    localStorage.setItem(MODEL_KEY, JSON.stringify(next))
  }

  function openUnit(unit: NativeMemoryUnit) {
    void run("source", async current => {
      const value = await nativeMemoryApi.unitSource(unit.unitId)
      if (lease.current === current) setSource(value)
    })
  }

  function startRefine(unitIds: string[], sample?: number) {
    if (!model) return
    void run("start", async current => {
      const created = await nativeMemoryApi.refine({ unitIds, model, ...(instruction.trim() ? { instruction: instruction.trim() } : {}), ...(sample ? { sample } : {}) })
      if (lease.current !== current) return
      localStorage.setItem(JOB_KEY, created.jobId)
      autoReviewed.current = null
      setJob(created)
      setStage("job")
    })
  }

  function start(sample?: number) {
    const unitIds = [...selected]
    if (mode === "refine") return startRefine(unitIds, sample)
    void run("start", async current => {
      const value = await nativeMemoryApi.plan({ operationId: generateUUID(), unitIds })
      if (lease.current === current) showOperations([value])
    })
  }

  function makeOverview() {
    if (!model) return
    void run("overview", async current => {
      const value = await nativeMemoryApi.overview({ model, ...(selected.size ? { unitIds: [...selected] } : {}), ...(instruction.trim() ? { instruction: instruction.trim() } : {}) })
      if (lease.current === current) setOverview(value)
    })
  }

  function commit() {
    const pending = operations.filter(value => !value.receipt)
    void run("commit", async current => {
      const done: NativeImportOperation[] = []
      for (const value of pending) {
        const keys = new Set(value.plan.items.map(item => item.itemKey))
        const moved = Object.entries(overrides).filter(([key]) => keys.has(key))
        const decisions = { approved: true as const, approvedItemKeys: [...approved].filter(key => keys.has(key)), rejectedItemKeys: [...rejected].filter(key => keys.has(key)), ...(moved.length ? { scopeOverrides: Object.fromEntries(moved) } : {}) }
        if (!decisions.approvedItemKeys.length && !decisions.rejectedItemKeys.length) continue
        let receipt
        try { receipt = await nativeMemoryApi.commit(value.plan.operationId, decisions) }
        catch (err) {
          const persisted = await nativeMemoryApi.operation(value.plan.operationId).catch(() => null)
          if (!persisted?.receipt) throw err
          receipt = persisted.receipt
        }
        done.push({ ...value, receipt })
        localStorage.removeItem(JOB_KEY)
      }
      if (lease.current !== current) return
      setOperations(previous => previous.map(value => done.find(item => item.plan.operationId === value.plan.operationId) ?? value))
      await onChanged()
      await reloadInventory(current)
    })
  }

  function undo() {
    const saved = operations.filter(value => value.receipt && !value.rollback)
    void run("rollback", async current => {
      const done = await Promise.all(saved.map(async value => ({ ...value, rollback: await nativeMemoryApi.rollback(value.plan.operationId) })))
      if (lease.current !== current) return
      setOperations(previous => previous.map(value => done.find(item => item.plan.operationId === value.plan.operationId) ?? value))
      await onChanged()
      await reloadInventory(current)
    })
  }

  function restore(removalIds: string[], mode: "import" | "suggest") {
    void run("restore", async current => {
      const result = await nativeMemoryApi.restore({ removalIds, mode })
      if (lease.current !== current) return
      setRemovedItems(previous => previous.filter(item => !removalIds.includes(item.removalId)))
      setRestored({ count: removalIds.length, ...(result.mode === "import" ? { operationId: result.receipt.operationId } : {}) })
      if (result.mode === "import") await onChanged()
      await reloadInventory(current)
    })
  }

  function undoRestore() {
    const operationId = restored?.operationId
    if (!operationId) return
    void run("rollback", async current => {
      await nativeMemoryApi.rollback(operationId)
      if (lease.current !== current) return
      setRestored(null)
      await onChanged()
      await reloadInventory(current)
    })
  }

  function openHistory() {
    void run("history", async current => {
      const value = await nativeMemoryApi.history()
      if (lease.current !== current) return
      setHistory(value)
      setStage("history")
    })
  }

  const back = () => { setSource(null); setRestored(null); setStage("plan") }
  const progress = job ? jobProgress(job) : null
  const remaining = job?.input.sample ? job.input.unitIds.slice(job.input.sample).filter(id => inventory?.units.some(unit => unit.unitId === id && isSelectable(unit))) : []
  const saved = operations.length > 0 && operations.every(value => value.receipt)
  const undone = operations.some(value => value.rollback)
  const proposals = operations.reduce((sum, value) => sum + value.plan.items.length, 0)
  const dropped = operations.reduce((sum, value) => sum + value.plan.droppedQuotes, 0)
  const accepted = operations.flatMap(value => value.receipt?.accepted ?? [])
  // Removing is the decision: everything else proposed is imported. Each removal can be undone in turn.
  function remove(keys: string[]) {
    if (!keys.length) return
    setRemovals(previous => [...previous, keys])
    setRejected(previous => new Set([...previous, ...keys]))
    setApproved(previous => { const next = new Set(previous); for (const key of keys) next.delete(key); return next })
  }
  function undoRemove() {
    const keys = removals.at(-1)
    if (!keys) return
    setRemovals(previous => previous.slice(0, -1))
    setRejected(previous => { const next = new Set(previous); for (const key of keys) next.delete(key); return next })
    setApproved(previous => new Set([...previous, ...keys]))
  }


  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent ref={dialogRef} onOpenAutoFocus={event => { event.preventDefault(); dialogRef.current?.focus() }} size="lg" className="max-w-[1080px] overflow-hidden">
      <DialogHeader className="flex-row items-center gap-3 space-y-0 border-b border-border px-5 py-3.5 pr-12">
        <span className="flex size-8 items-center justify-center rounded-lg bg-muted"><FileInput aria-hidden className="size-4" /></span>
        <DialogTitle className="text-[15px]">{t("nativeMemory:title")}</DialogTitle>
        <NativeUiInfo label={t("nativeMemory:title")}>{t("nativeMemory:policy")}{inventory?.anomalies.length ? `\n\n${t("nativeMemory:anomalies", { count: inventory.anomalies.length })}` : ""}</NativeUiInfo>
        <DialogDescription className="sr-only">{t("nativeMemory:description")}</DialogDescription>
        {removedItems.length ? <Button type="button" variant="ghost" size="sm" disabled={Boolean(busy)} onClick={() => { setSource(null); setRestored(null); setStage("removed") }} className="ml-auto h-8 gap-1.5 px-2 text-[13px] font-normal text-muted-foreground"><Trash2 aria-hidden className="size-3.5" />{t("nativeMemory:removedTab")}<span className="tabular-nums opacity-70">{removedItems.length}</span></Button> : null}
        <Button type="button" variant="ghost" size="sm" disabled={Boolean(busy)} onClick={openHistory} className={cn(!removedItems.length && "ml-auto", "h-8 gap-1.5 px-2 text-[13px] font-normal text-muted-foreground")}><History aria-hidden className="size-3.5" />{t("nativeMemory:history")}</Button>
      </DialogHeader>
      <DialogBody className="flex flex-col p-0 sm:h-[640px] sm:flex-row">
        <nav aria-label={t("nativeMemory:sources")} className="flex max-h-72 min-w-0 shrink-0 flex-col border-b border-border bg-muted/25 sm:max-h-none sm:w-[304px] sm:border-b-0 sm:border-r">
          {inventory ? <NativeMemorySourceTree sections={sections} selected={selected} activeUnitId={source?.unit.unitId} onToggle={toggleUnits} onOpen={openUnit} />
            : <p role="status" className="flex items-center gap-2 p-5 text-[13px] text-muted-foreground"><Loader2 aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />{t("nativeMemory:scanning")}</p>}
        </nav>
        <section aria-label={t("nativeMemory:plan")} className="flex min-h-0 min-w-0 flex-1 flex-col">
          {error ? <p role="alert" className="mx-6 mt-4 flex items-start gap-2 rounded-lg bg-destructive/8 px-3 py-2 text-[13px] leading-5 text-destructive"><ShieldAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />{error}</p> : null}

          {source ? <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-2 px-4 pb-2 pt-3">
              <Button type="button" variant="ghost" size="icon" aria-label={t("nativeMemory:back")} onClick={() => setSource(null)} className="size-8"><ArrowLeft aria-hidden className="size-4" /></Button>
              <div className="min-w-0"><h3 className="truncate text-sm font-medium">{source.unit.title}</h3><p className="truncate text-xs text-muted-foreground">{source.unit.projectLabel}</p></div>
            </div>
            <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-7 pb-6 pt-2 font-sans text-[13px] leading-6">{source.text}</pre>
          </div> : stage === "plan" ? <>
            <div className="min-h-0 flex-1 overflow-y-auto px-7 pb-4 pt-6">
              <div className="flex items-baseline gap-2.5">
                <span className="text-[34px] font-medium leading-none tabular-nums tracking-tight">{summary.total}</span>
                <span className="text-sm text-muted-foreground">{t("nativeMemory:selectedUnits")}</span>
                {summary.added ? <span className="ml-2 text-[13px] tabular-nums text-success">{t("nativeMemory:newCount", { count: summary.added })}</span> : null}
                {summary.changed ? <span className="text-[13px] tabular-nums text-amber-600 dark:text-amber-400">{t("nativeMemory:changedCount", { count: summary.changed })}</span> : null}
              </div>
              {inventory && !inventory.counts.new && !inventory.counts.changed ? <p className="mt-3 flex items-center gap-2 text-[13px] text-muted-foreground"><Check aria-hidden className="size-3.5" />{t("nativeMemory:upToDate")}</p> : null}

              {mode === "refine" ? <div className="mt-7">
                {overview ? <>
                  <h3 className="mb-1 text-[13px] font-medium">{t("nativeMemory:whatIsInside")}</h3>
                  <ul className="divide-y divide-border/70">{overview.topics.map(topic => {
                    const ids = topic.unitIds
                    const chosen = ids.filter(id => selected.has(id)).length
                    return <li key={topic.id}>
                      <details className="group/topic [&[open]_summary_svg]:rotate-90">
                        <summary className="flex cursor-pointer list-none items-center gap-2.5 py-2.5 [&::-webkit-details-marker]:hidden">
                          <span onClick={event => event.stopPropagation()} className="flex"><NativeCheckbox aria-label={topic.title} checked={chosen === ids.length && ids.length > 0} indeterminate={chosen > 0 && chosen < ids.length} onChange={value => toggleUnits(ids, value)} /></span>
                          <span className="min-w-0 flex-1"><span className="block truncate text-sm">{topic.title}</span><span className="block truncate text-xs text-muted-foreground">{topic.summary}</span></span>
                          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{ids.length}</span>
                          <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none" />
                        </summary>
                        {topic.samples.length ? <ul className="mb-3 ml-6 space-y-1 border-l border-border pl-3 text-[13px] leading-5 text-muted-foreground">{topic.samples.map(sample => <li key={sample}>{sample}</li>)}</ul> : null}
                      </details>
                    </li>
                  })}</ul>
                </> : <button type="button" disabled={Boolean(busy) || !model || !inventory} onClick={makeOverview} title={t("nativeMemory:overviewHint")} className="flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-left shadow-[inset_0_0_0_1px_hsl(var(--border))] transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60">
                  {busy === "overview" ? <Loader2 aria-hidden className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" /> : <Sparkles aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
                  <span className="min-w-0 flex-1 text-sm">{busy === "overview" ? t("nativeMemory:readingIndex") : t("nativeMemory:browseTopics")}</span>
                  <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                </button>}
              </div> : null}

              {breakdown.length ? <div className="mt-7">
                <h3 className="mb-1 text-[13px] font-medium">{t("nativeMemory:included")}</h3>
                <ul>{breakdown.map(row => <li key={row.key} className="flex min-w-0 items-center gap-2.5 py-1.5 text-sm">
                  <BrandTile brand={ENGINE_BRANDS[row.engine]} size="sm" />
                  <span className="min-w-0 flex-1 truncate" title={row.group.label}>{groupName(row.group)}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{row.count}</span>
                </li>)}</ul>
              </div> : null}
            </div>
            <div className="shrink-0 px-5 pb-5 pt-1">
              <NativeRefineComposer providers={providers} mode={mode} onModeChange={setMode} model={model} onModelChange={chooseModel} instruction={instruction} onInstructionChange={setInstruction} count={summary.total} tokens={estimateRefineTokens(inventory?.units ?? [], selected)} busy={Boolean(busy)} onStart={start} />
            </div>
          </> : stage === "job" && job && progress ? <div className="flex flex-1 flex-col items-center justify-center gap-5 px-10">
            {active ? <BrandIcon animated="loop" className="size-14" /> : null}
            <div className="text-center">
              <h3 className="text-base font-medium">{t(active ? "nativeMemory:refining" : job.state === "cancelled" ? "nativeMemory:cancelled" : job.state === "failed" ? "nativeMemory:refineFailed" : "nativeMemory:refined")}</h3>
              <p className="mt-1 text-[13px] tabular-nums text-muted-foreground">{t("nativeMemory:unitProgress", { finished: progress.unitsDone, total: progress.units })}{progress.tokens ? ` · ${t("nativeMemory:tokensUsed", { value: formatTokens(progress.tokens, getLocale()) })}` : ""}</p>
            </div>
            <div role="progressbar" aria-valuemin={0} aria-valuemax={progress.total || 1} aria-valuenow={progress.finished} aria-label={t("nativeMemory:refining")} className="flex w-full max-w-md gap-1">
              {job.batches.map(batch => <span key={batch.batchId} title={batch.error} className={cn("h-1.5 flex-1 rounded-full transition-colors", batch.state === "completed" ? "bg-foreground" : batch.state === "running" ? "animate-pulse bg-foreground/40 motion-reduce:animate-none" : batch.state === "failed" ? "bg-destructive" : "bg-muted")} />)}
            </div>
            <div className="flex items-center gap-2">
              {active ? <Button type="button" size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => void run("cancel", async current => { const next = await nativeMemoryApi.cancelJob(job.jobId); if (lease.current === current) setJob(next) })} className="gap-1.5"><Square aria-hidden className="size-3" />{t("nativeMemory:stop")}</Button> : <>
                <Button type="button" size="sm" variant="ghost" onClick={() => { localStorage.removeItem(JOB_KEY); setJob(null); back() }}>{t("nativeMemory:back")}</Button>
                {progress.finished ? <Button type="button" size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void run("review", current => openJobResults(job, current))}>{t("nativeMemory:reviewFinished")}</Button> : null}
                {job.state !== "completed" ? <Button type="button" size="sm" disabled={Boolean(busy)} onClick={() => void run("resume", async current => { const next = await nativeMemoryApi.resumeJob(job.jobId); if (lease.current === current) setJob(next) })} className="gap-1.5"><RotateCw aria-hidden className="size-3.5" />{t("nativeMemory:resume")}</Button> : null}
              </>}
            </div>
          </div> : stage === "review" ? <>
            <div className="flex shrink-0 items-center gap-2 px-4 pb-2 pt-3">
              <Button type="button" variant="ghost" size="icon" aria-label={t("nativeMemory:back")} onClick={() => { localStorage.removeItem(JOB_KEY); back() }} className="size-8"><ArrowLeft aria-hidden className="size-4" /></Button>
              <h3 className="text-sm font-medium">{undone ? t("nativeMemory:undoneTitle") : saved ? t("nativeMemory:savedTitle", { count: accepted.length }) : t("nativeMemory:proposals", { count: proposals })}</h3>
              {dropped ? <NativeUiInfo label={t("nativeMemory:droppedQuotes", { count: dropped })}>{t("nativeMemory:droppedQuotes", { count: dropped })}</NativeUiInfo> : null}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-7 pb-4 pt-2">
              {proposals ? <NativeImportReview operations={operations} removed={rejected} overrides={overrides} busy={Boolean(busy)} onRemove={remove}
                onMove={(key, scope) => setOverrides(previous => ({ ...previous, [key]: scope }))} /> : <p className="py-16 text-center text-sm text-muted-foreground">{t("nativeMemory:noProposals")}</p>}
            </div>
            <div className="flex shrink-0 items-center gap-2 border-t border-border px-5 py-3">
              {remaining.length && !saved ? <Button type="button" size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => startRefine(remaining)}>{t("nativeMemory:continueRest", { count: remaining.length })}</Button> : null}
              <AnimatePresence initial={false}>{!saved && rejected.size ? <motion.div key="removed" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }} className="flex min-w-0 items-center gap-1 text-[13px] text-muted-foreground">
                <span className="truncate tabular-nums" title={t("nativeMemory:rejectNotice")}>{t("nativeMemory:removedCount", { count: rejected.size })}</span>
                {removals.length ? <Button type="button" size="sm" variant="ghost" disabled={Boolean(busy)} onClick={undoRemove} className="h-7 gap-1 px-2 text-[13px] font-normal"><Undo2 aria-hidden className="size-3.5" />{t("nativeMemory:undoRemove")}</Button> : null}
              </motion.div> : null}</AnimatePresence>
              <span className="ml-auto" />
              {saved && !undone ? <Button type="button" size="sm" variant="outline" disabled={Boolean(busy)} onClick={undo} className="gap-1.5"><Undo2 aria-hidden className="size-3.5" />{t("nativeMemory:undoImport")}</Button> : null}
              {!saved ? <Button type="button" size="sm" disabled={Boolean(busy) || (!approved.size && !rejected.size)} onClick={commit} className="gap-1.5">{busy === "commit" ? <Loader2 aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" /> : <FileInput aria-hidden className="size-3.5" />}{approved.size ? t("nativeMemory:importSelected", { count: approved.size }) : t("nativeMemory:saveRejections")}</Button> : <Button type="button" size="sm" onClick={back}>{t("nativeMemory:done")}</Button>}
            </div>
          </> : stage === "removed" ? <>
            <div className="flex shrink-0 items-center gap-2 px-4 pb-2 pt-3">
              <Button type="button" variant="ghost" size="icon" aria-label={t("nativeMemory:back")} onClick={back} className="size-8"><ArrowLeft aria-hidden className="size-4" /></Button>
              <h3 className="text-sm font-medium">{t("nativeMemory:removedTab")}</h3>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-7 pb-4 pt-2"><NativeRemovedList items={removedItems} busy={Boolean(busy)} onRestore={restore} /></div>
            <AnimatePresence initial={false}>{restored ? <motion.div key="restored" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} className="flex shrink-0 items-center gap-2 border-t border-border px-5 py-3 text-[13px] text-muted-foreground">
              <Check aria-hidden className="size-3.5" />{t(restored.operationId ? "nativeMemory:restoredImported" : "nativeMemory:restoredSuggested", { count: restored.count })}
              {restored.operationId ? <Button type="button" size="sm" variant="ghost" disabled={Boolean(busy)} onClick={undoRestore} className="h-7 gap-1 px-2 text-[13px] font-normal"><Undo2 aria-hidden className="size-3.5" />{t("nativeMemory:undoRemove")}</Button> : null}
            </motion.div> : null}</AnimatePresence>
          </> : stage === "history" ? <>
            <div className="flex shrink-0 items-center gap-2 px-4 pb-2 pt-3">
              <Button type="button" variant="ghost" size="icon" aria-label={t("nativeMemory:back")} onClick={back} className="size-8"><ArrowLeft aria-hidden className="size-4" /></Button>
              <h3 className="text-sm font-medium">{t("nativeMemory:history")}</h3>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
              {history?.operations.length ? <ul>{history.operations.map(entry => <li key={entry.operationId}><button type="button" disabled={Boolean(busy)} onClick={() => void run("review", async current => { const value = await nativeMemoryApi.operation(entry.operationId); if (lease.current === current) showOperations([value]) })} className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="min-w-0 flex-1 text-sm">{new Date(entry.createdAt).toLocaleString(getLocale())}</span>
                <span className="text-xs tabular-nums text-muted-foreground">{t("nativeMemory:unitCount", { count: entry.unitIds.length })}</span>
                {entry.state === "rolled-back" ? <Undo2 aria-label={t("nativeMemory:undone")} className="size-3.5 text-muted-foreground" /> : entry.state === "committed" ? <Check aria-label={t("nativeMemory:imported")} className="size-3.5 text-muted-foreground" /> : <span className="size-3.5" />}
              </button></li>)}</ul> : <p className="py-16 text-center text-sm text-muted-foreground">{t("nativeMemory:noHistory")}</p>}
            </div>
          </> : null}
        </section>
      </DialogBody>
    </DialogContent>
  </Dialog>
}
