import { useEffect, useRef, useState } from "react"
import { FileInput, Loader2, RefreshCw, Undo2 } from "lucide-react"
import type { NativeDiscoveryResult, NativeImportItem, NativeImportOperation, NativeImportSummary, NativeMemoryRoot, NativeMemorySource } from "../../../shared/native-memory"
import { t, useI18n, getLocale } from "../../i18n"
import { nativeMemoryApi } from "../../lib/nativeMemoryApi"
import { cn, generateUUID } from "../../lib/utils"
import { Button } from "../ui/button"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId?: string
  onChanged: () => Promise<void> | void
}

export function canApproveNativeItem(item: NativeImportItem) {
  return item.disposition === "new" || item.disposition === "exact-match" || item.disposition === "unchanged"
}

export function NativeMemoryImportDialog({ open, onOpenChange, projectId, onChanged }: Props) {
  useI18n()
  const [roots, setRoots] = useState<NativeMemoryRoot[]>([])
  const [rootIds, setRootIds] = useState<Set<string>>(new Set())
  const [discovery, setDiscovery] = useState<NativeDiscoveryResult | null>(null)
  const [history, setHistory] = useState<NativeImportSummary[]>([])
  const [historyTruncated, setHistoryTruncated] = useState(false)
  const [operation, setOperation] = useState<NativeImportOperation | null>(null)
  const [approved, setApproved] = useState<Set<string>>(new Set())
  const [rejected, setRejected] = useState<Set<string>>(new Set())
  const [semantic, setSemantic] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const owner = useRef(0)
  const busyRef = useRef(false)
  const previewAttempts = useRef(new Map<string, string>())

  async function loadLists(lease: number, signal?: AbortSignal) {
    const [locations, recent] = await Promise.all([nativeMemoryApi.roots(signal), nativeMemoryApi.history(signal)])
    if (owner.current !== lease) return
    setRoots(locations.roots)
    setRootIds(new Set(locations.roots.filter(root => root.id === "personal" || root.id === `project:${projectId}`).map(root => root.id)))
    setHistory(recent.operations)
    setHistoryTruncated(recent.hasMore)
  }

  async function refreshHistory(lease: number) {
    const data = await nativeMemoryApi.history()
    if (owner.current !== lease) return
    setHistory(data.operations)
    setHistoryTruncated(data.hasMore)
  }

  useEffect(() => {
    const lease = ++owner.current
    if (!open) return
    const controller = new AbortController()
    busyRef.current = true
    setBusy("loading")
    setError(null)
    setOperation(null)
    setDiscovery(null)
    setSemantic(false)
    setRoots([])
    setRootIds(new Set())
    setHistory([])
    previewAttempts.current.clear()
    void loadLists(lease, controller.signal).catch(err => {
      if (owner.current === lease && !controller.signal.aborted) setError(err instanceof Error ? err.message : t("nativeMemory:loadFailed"))
    }).finally(() => {
      if (owner.current === lease) { busyRef.current = false; setBusy(null) }
    })
    return () => { controller.abort(); if (owner.current === lease) owner.current++ }
  }, [open, projectId])

  async function run(kind: string, action: (lease: number) => Promise<void>) {
    if (busyRef.current) return
    const lease = owner.current
    busyRef.current = true
    setBusy(kind)
    setError(null)
    try { await action(lease) }
    catch (err) { if (owner.current === lease) setError(err instanceof Error ? err.message : t("nativeMemory:actionFailed")) }
    finally { if (owner.current === lease) { busyRef.current = false; setBusy(null) } }
  }

  function showOperation(value: NativeImportOperation) {
    setOperation(value)
    setApproved(new Set(value.plan.items.filter(canApproveNativeItem).map(item => item.itemKey)))
    setRejected(new Set(value.receipt?.rejected ?? []))
  }

  function preview(source: NativeMemorySource) {
    void run("preview", async lease => {
      const key = JSON.stringify([source.sourceId, source.sourceHash, semantic])
      let operationId = previewAttempts.current.get(key)
      if (!operationId) {
        operationId = generateUUID()
        previewAttempts.current.set(key, operationId)
      }
      const value = await nativeMemoryApi.preview({
        operationId, sourceId: source.sourceId, sourceHash: source.sourceHash,
        extraction: semantic ? "semantic" : "local", ...(semantic ? { allowSemanticExtraction: true } : {}),
      })
      if (owner.current === lease) showOperation(value)
    })
  }

  function save() {
    if (!operation) return
    const current = operation
    const decisions = { approved: true as const, approvedItemKeys: [...approved], rejectedItemKeys: [...rejected] }
    void run("commit", async lease => {
      let receipt
      try { receipt = await nativeMemoryApi.commit(current.plan.operationId, decisions) }
      catch (err) {
        // A lost response does not establish that the mutation failed.
        const persisted = await nativeMemoryApi.operation(current.plan.operationId).catch(() => null)
        if (!persisted?.receipt) throw err
        receipt = persisted.receipt
      }
      if (owner.current === lease) setOperation({ ...current, receipt })
      await onChanged()
      if (owner.current === lease) await refreshHistory(lease)
    })
  }

  function undo() {
    if (!operation?.receipt || operation.rollback) return
    const current = operation
    void run("rollback", async lease => {
      const rollback = await nativeMemoryApi.rollback(current.plan.operationId)
      if (owner.current === lease) setOperation({ ...current, rollback })
      await onChanged()
      if (owner.current === lease) await refreshHistory(lease)
    })
  }

  function toggleApproved(key: string, checked: boolean) {
    setApproved(previous => { const next = new Set(previous); if (checked) next.add(key); else next.delete(key); return next })
    if (checked) setRejected(previous => { const next = new Set(previous); next.delete(key); return next })
  }

  const plan = operation?.plan
  const saved = Boolean(operation?.receipt)
  const sourceLabel = (source: NativeMemorySource) => source.kind === "native-memory" ? t("nativeMemory:nativeMemory") : source.kind === "project-rule" ? t("nativeMemory:projectRules") : t("nativeMemory:skill")
  const itemLabel = (item: NativeImportItem) => item.disposition === "new" ? t("nativeMemory:newItem") : item.disposition === "exact-match" || item.disposition === "unchanged" ? t("nativeMemory:existingItem") : item.disposition === "conflict" ? t("nativeMemory:needsReview") : t("nativeMemory:suppressed")

  return (
    <Dialog open={open} onOpenChange={value => { if (!value) owner.current++; onOpenChange(value) }}>
      <DialogContent size="lg" className="max-w-4xl">
        <DialogHeader className="pr-12">
          <DialogTitle>{t("nativeMemory:title")}</DialogTitle>
          <DialogDescription>{t("nativeMemory:description")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">{t("nativeMemory:locations")}</p>
            <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
              {roots.map(root => <label key={root.id} className="flex max-w-full items-start gap-2 text-sm">
                <input type="checkbox" checked={rootIds.has(root.id)} disabled={Boolean(busy)} onChange={event => setRootIds(previous => { const next = new Set(previous); if (event.target.checked) next.add(root.id); else next.delete(root.id); return next })} className="mt-1 accent-foreground" />
                <span className="min-w-0"><span className="block">{root.owner.scope === "personal" ? t("nativeMemory:personal") : root.label}</span><span className="block max-w-80 truncate text-xs text-muted-foreground" title={root.path}>{root.path}</span></span>
              </label>)}
            </div>
            <Button size="sm" variant="outline" disabled={Boolean(busy) || !rootIds.size} onClick={() => void run("discover", async lease => { const result = await nativeMemoryApi.discover([...rootIds]); if (owner.current === lease) { setDiscovery(result); setOperation(null) } })}>
              {busy === "discover" ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <FileInput aria-hidden className="size-3.5" />}{t("nativeMemory:findSources")}
            </Button>
          </div>
          <label className="flex items-start gap-2 rounded-lg bg-muted/40 p-3 text-sm">
            <input type="checkbox" checked={semantic} disabled={Boolean(busy)} onChange={event => setSemantic(event.target.checked)} className="mt-1 accent-foreground" />
            <span><span className="block font-medium">{t("nativeMemory:modelExtraction")}</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{t("nativeMemory:modelConsent")}</span></span>
          </label>
          <p className="text-xs leading-5 text-muted-foreground">{t("nativeMemory:policy")}</p>
          {error ? <div role="alert" className="space-y-2 rounded-lg border border-destructive/30 p-3 text-sm text-destructive"><p>{error}</p><Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void run("loading", loadLists)}>{t("nativeMemory:retry")}</Button></div> : null}
          {busy ? <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 aria-hidden className="size-3.5 animate-spin" />{busy === "loading" ? t("common:loading") : busy === "preview" ? t("nativeMemory:preparingPreview") : busy === "commit" ? t("nativeMemory:importing") : busy === "rollback" ? t("nativeMemory:undoing") : t("nativeMemory:working")}</p> : null}
          <div className="grid gap-4 md:grid-cols-[15rem_minmax(0,1fr)]">
            <nav className="space-y-4" aria-label={t("nativeMemory:sourcesAndHistory")}>
              {discovery ? <section className="space-y-2">
                <h3 className="text-sm font-medium">{t("nativeMemory:foundSources")}</h3>
                {discovery.sources.length === 0 ? <p className="text-xs leading-5 text-muted-foreground">{t("nativeMemory:noSources")}</p> : null}
                {discovery.sources.map(source => <button key={source.sourceId} type="button" disabled={Boolean(busy) || !source.importable} onClick={() => preview(source)} title={source.locator} className={cn("w-full rounded-lg px-2 py-2 text-left hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50", plan?.source.sourceId === source.sourceId && "bg-muted")}>
                  <span className="block break-all text-xs">{source.locator}</span>
                  <span className="mt-1 block text-[11px] text-muted-foreground">{source.engine} / {sourceLabel(source)}{source.screening === "blocked-sensitive" ? ` / ${t("nativeMemory:sensitiveBlocked")}` : ""}</span>
                </button>)}
                {discovery.truncated ? <p className="text-xs text-muted-foreground">{t("nativeMemory:discoveryTruncated")}</p> : null}
              </section> : null}
              <section className="space-y-2">
                <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-medium">{t("nativeMemory:recentImports")}</h3><Button size="icon" variant="ghost" className="size-6" disabled={Boolean(busy)} aria-label={t("nativeMemory:refreshHistory")} onClick={() => void run("history", refreshHistory)}><RefreshCw aria-hidden className="size-3" /></Button></div>
                {history.length === 0 ? <p className="text-xs leading-5 text-muted-foreground">{t("nativeMemory:noHistory")}</p> : null}
                {history.map(entry => <button key={entry.operationId} type="button" disabled={Boolean(busy)} onClick={() => void run("history", async lease => { const result = await nativeMemoryApi.operation(entry.operationId); if (owner.current === lease) showOperation(result) })} className={cn("w-full rounded-lg px-2 py-2 text-left hover:bg-muted disabled:opacity-50", plan?.operationId === entry.operationId && "bg-muted")}>
                  <span className="block truncate text-xs" title={entry.source.locator}>{entry.source.locator}</span>
                  <span className="mt-1 block text-[11px] text-muted-foreground">{new Date(entry.createdAt).toLocaleString(getLocale())} / {entry.state === "committed" ? t("nativeMemory:imported") : entry.state === "rolled-back" ? t("nativeMemory:undone") : t("nativeMemory:preview")}</span>
                </button>)}
                {historyTruncated ? <p className="text-xs text-muted-foreground">{t("nativeMemory:historyTruncated")}</p> : null}
              </section>
            </nav>
            <section className="min-w-0 space-y-3 border-t border-border pt-3 md:border-l md:border-t-0 md:pl-4 md:pt-0" aria-label={t("nativeMemory:preview")}>
              {!plan ? <p className="py-6 text-sm leading-6 text-muted-foreground">{t("nativeMemory:chooseSource")}</p> : <>
                <div><h3 className="break-all text-sm font-medium">{plan.source.locator}</h3><p className="mt-1 text-xs text-muted-foreground">{plan.extraction === "semantic" ? t("nativeMemory:modelPreview") : t("nativeMemory:localPreview")}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{t("nativeMemory:originalsKept")}</p></div>
                {rejected.size > 0 ? <p className="text-xs leading-5 text-muted-foreground">{t("nativeMemory:rejectNotice")}</p> : null}
                {plan.blockedReason ? <p className="text-sm text-muted-foreground">{t("nativeMemory:sourceBlocked")}</p> : null}
                {operation?.receipt ? <div role="status" className="space-y-1 rounded-lg bg-muted/40 p-3 text-sm">
                  <p>{t("nativeMemory:savedReceipt", { created: operation.receipt.accepted.filter(item => item.created).length, linked: operation.receipt.accepted.filter(item => !item.created).length, rejected: operation.receipt.rejected.length })}</p>
                  {operation.receipt.accepted.length ? <p className="break-words text-xs text-muted-foreground">{operation.receipt.accepted.map(item => item.memoryId).join(", ")}</p> : null}
                </div> : null}
                {operation?.rollback ? <div role="status" className="rounded-lg bg-muted/40 p-3 text-sm"><p>{t("nativeMemory:rollbackReceipt", { count: operation.rollback.archived.length })}</p>{operation.rollback.conflicts.length ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("nativeMemory:rollbackConflicts", { count: operation.rollback.conflicts.length })} {operation.rollback.conflicts.map(item => item.memoryId).join(", ")}</p> : null}</div> : null}
                {!plan.items.length && !plan.blockedReason ? <p className="text-sm text-muted-foreground">{t("nativeMemory:noItems")}</p> : null}
                <div className="divide-y divide-border">
                  {plan.items.map(item => <article key={item.itemKey} className="space-y-2 py-3">
                    <label className="flex items-start gap-2 text-sm leading-6">
                      {!saved ? <input type="checkbox" className="mt-1.5 accent-foreground" checked={approved.has(item.itemKey)} disabled={Boolean(busy) || !canApproveNativeItem(item)} onChange={event => toggleApproved(item.itemKey, event.target.checked)} /> : null}
                      <span className="min-w-0 break-words">{item.content}</span>
                    </label>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>{itemLabel(item)}</span><span>{item.owner.scope === "personal" ? t("nativeMemory:personal") : t("nativeMemory:project")}</span>{item.target ? <span>{item.target.memoryId}</span> : null}</div>
                    {item.reason ? <p className="text-xs leading-5 text-muted-foreground">{item.reason}</p> : null}
                    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{t("nativeMemory:sourceQuote", { start: item.provenance.startLine, end: item.provenance.endLine })}</summary><blockquote className="mt-2 whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 leading-5">{item.provenance.quote}</blockquote></details>
                    {!saved && canApproveNativeItem(item) ? <button type="button" disabled={Boolean(busy)} onClick={() => { setRejected(previous => { const next = new Set(previous); if (next.has(item.itemKey)) next.delete(item.itemKey); else next.add(item.itemKey); return next }); setApproved(previous => { const next = new Set(previous); next.delete(item.itemKey); return next }) }} className="text-xs text-muted-foreground underline-offset-4 hover:underline disabled:opacity-50">{rejected.has(item.itemKey) ? t("nativeMemory:rejectionSelected") : t("nativeMemory:rejectItem")}</button> : null}
                  </article>)}
                </div>
              </>}
            </section>
          </div>
        </DialogBody>
        <DialogFooter>
          {operation?.receipt && !operation.rollback ? <Button variant="outline" disabled={Boolean(busy)} onClick={undo}><Undo2 aria-hidden className="size-3.5" />{t("nativeMemory:undoImport")}</Button> : null}
          <Button variant="ghost" onClick={() => { owner.current++; onOpenChange(false) }}>{t("common:close")}</Button>
          {plan && !saved ? <Button disabled={Boolean(busy) || Boolean(plan.blockedReason) || !approved.size && !rejected.size} onClick={save}>{approved.size ? t("nativeMemory:importSelected", { count: approved.size }) : t("nativeMemory:saveRejections")}</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
