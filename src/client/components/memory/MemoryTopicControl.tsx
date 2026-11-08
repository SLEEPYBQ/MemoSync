import { useEffect, useState } from "react"
import { Tag } from "lucide-react"
import { normalizeTopicName, topicNameKey } from "../../../shared/memory-topics"
import { t, useI18n } from "../../i18n"
import { type TopicAssignmentTarget } from "../../lib/memoriesApi"
import { assignMemoryTopics } from "../../lib/memoryTopics"
import { refreshMemoryTopics, useMemoryTopicStore } from "../../stores/memoryTopicStore"
import { Button } from "../ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover"

type AssignmentReceipt = Awaited<ReturnType<typeof assignMemoryTopics>>

export function MemoryTopicPicker({ label, disabled, onAssign }: {
  label: string; disabled?: boolean; onAssign: (target: TopicAssignmentTarget) => void
}) {
  useI18n()
  const topics = useMemoryTopicStore(s => s.topics)
  const error = useMemoryTopicStore(s => s.error)
  const loading = useMemoryTopicStore(s => s.loading)
  const load = useMemoryTopicStore(s => s.load)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  useEffect(() => { void load() }, [load])
  const name = normalizeTopicName(query)
  const match = topics.find(topic => topicNameKey(topic.name) === topicNameKey(name))
  const visible = topics.filter(topic => topicNameKey(topic.name).includes(topicNameKey(name)))
  function assign(target: TopicAssignmentTarget) {
    setOpen(false)
    setQuery("")
    onAssign(target)
  }
  return (
    <Popover open={open} onOpenChange={value => { setOpen(value); if (value) void load() }}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" disabled={disabled} aria-label={`${t("memory:topicLabel")}: ${label}`}>
          <Tag className="size-3.5 shrink-0" /><span className="max-w-48 truncate">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 space-y-2 p-3">
        <input aria-label={t("memory:searchTopics")} placeholder={t("memory:searchTopics")} value={query}
          onChange={event => setQuery(event.target.value)} className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm" />
        {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
        {loading ? <p role="status" className="text-xs text-muted-foreground">{t("common:loading")}</p> : null}
        <div className="max-h-56 space-y-1 overflow-y-auto">
          <Button className="w-full justify-start" variant="ghost" size="sm" onClick={() => assign({ topicId: null })}>{t("memory:unclassified")}</Button>
          {visible.map(topic => <Button key={topic.id} className="w-full justify-start" variant="ghost" size="sm"
            onClick={() => assign({ topicId: topic.id })}><span className="truncate">{topic.name}</span><span className="ml-auto text-muted-foreground">{topic.count}</span></Button>)}
        </div>
        {name ? <Button variant="secondary" size="sm" className="h-auto w-full whitespace-normal text-left"
          disabled={loading || Boolean(error)} onClick={() => assign(match ? { topicId: match.id } : { name })}>
          {match ? t("memory:assignExistingTopic", { name: match.name }) : t("memory:createAndAssignTopic", { name })}
        </Button> : null}
        <p className="text-xs text-muted-foreground">{t("memory:topicDoesNotAccept")}</p>
      </PopoverContent>
    </Popover>
  )
}

export function MemoryTopicResults({ result, busy, onRetry }: {
  result: AssignmentReceipt; busy: boolean; onRetry: () => void
}) {
  useI18n()
  const failed = result.results.filter(row => row.status === "failed")
  return <div aria-live="polite" className="space-y-1 text-xs">
    {(["success", "failed", "unprocessed"] as const).map(status => {
      const rows = result.results.filter(row => row.status === status)
      return <details key={status} open={status !== "success" && rows.length > 0}>
        <summary>{t(`memory:topicResult_${status}`, { count: rows.length })}</summary>
        <ul className="max-h-32 overflow-y-auto pl-4">
          {rows.map(row => <li key={row.id}><code>{row.id}</code>{row.error ? ` — ${row.error}` : ""}</li>)}
        </ul>
      </details>
    })}
    {failed.length > 0 && result.targetKnown ? <Button size="sm" variant="secondary" disabled={busy} onClick={onRetry}>
      {t("memory:retryFailedTopics", { count: failed.length })}
    </Button> : null}
    {failed.length > 0 && !result.targetKnown ? <p role="alert">{t("memory:topicUnknownResult")}</p> : null}
  </div>
}

export function MemoryTopicControl({ ids, topicId, topicName, disabled, onChanged, onCompleted }: {
  ids: string[]; topicId?: string; topicName?: string; disabled?: boolean
  onChanged?: () => Promise<void> | void
  onCompleted?: (result: AssignmentReceipt) => void
}) {
  useI18n()
  const topics = useMemoryTopicStore(s => s.topics)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<AssignmentReceipt | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const label = ids.length > 1 ? t("memory:assignSelectedTopics", { count: ids.length })
    : (topics.find(topic => topic.id === topicId)?.name ?? topicName ?? t("memory:unclassified"))
  // A panel can change selection without remounting this component.
  const selection = ids.join("\n")
  useEffect(() => { setResult(null); setRefreshError(null) }, [selection])
  async function assign(target: TopicAssignmentTarget, retry = false) {
    if (busy) return
    setBusy(true)
    setRefreshError(null)
    try {
      const assignmentIds = retry && result ? result.results.filter(row => row.status === "failed").map(row => row.id) : ids
      const next = await assignMemoryTopics(assignmentIds, target)
      const receipt = retry && result ? {
        ...next,
        results: result.results.map(row => next.results.find(updated => updated.id === row.id) ?? row),
      } : next
      setResult(receipt)
      await refreshMemoryTopics()
      await onChanged?.()
      onCompleted?.(receipt)
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return <div className="space-y-1" data-memory-topic-control>
    <MemoryTopicPicker label={label} disabled={disabled || busy || ids.length === 0} onAssign={target => void assign(target)} />
    {busy ? <p role="status" className="text-xs text-muted-foreground">{t("common:loading")}</p> : null}
    {refreshError ? <p role="alert" className="text-xs text-destructive">{refreshError}</p> : null}
    {result ? <MemoryTopicResults result={result} busy={busy} onRetry={() => void assign({ topicId: result.topicId }, true)} /> : null}
  </div>
}
