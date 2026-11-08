import { useEffect, useState } from "react"
import { Pencil, Plus, Trash2 } from "lucide-react"
import { normalizeTopicName } from "../../../shared/memory-topics"
import { t, useI18n } from "../../i18n"
import { memoriesApi, type MemoryTopic } from "../../lib/memoriesApi"
import type { TopicFilter } from "../../lib/memoryTopics"
import { refreshMemoryTopics, useMemoryTopicStore } from "../../stores/memoryTopicStore"
import { cn } from "../../lib/utils"
import { Button } from "../ui/button"

export function MemoryTopicDirectory({ selected, onSelect }: {
  selected: TopicFilter; onSelect: (topic: TopicFilter) => void
}) {
  useI18n()
  const topics = useMemoryTopicStore(s => s.topics)
  const error = useMemoryTopicStore(s => s.error)
  const load = useMemoryTopicStore(s => s.load)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<MemoryTopic | null>(null)
  const [deleting, setDeleting] = useState<MemoryTopic | null>(null)
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  useEffect(() => { void load() }, [load])
  async function mutate(kind: "rename" | "delete") {
    const topic = kind === "rename" ? editing : deleting
    if (!topic || busy) return
    setBusy(true)
    setActionError(null)
    try {
      if (kind === "rename") await memoriesApi.renameTopic(topic.id, normalizeTopicName(name))
      else {
        await memoriesApi.deleteTopic(topic.id)
        if (selected === topic.id) onSelect("unclassified")
      }
      setEditing(null)
      setDeleting(null)
      await refreshMemoryTopics()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(false) }
  }
  async function createTopic() {
    if (busy || !normalizeTopicName(name)) return
    setBusy(true)
    setActionError(null)
    try {
      const topic = await memoriesApi.createTopic(normalizeTopicName(name))
      await refreshMemoryTopics()
      setCreating(false)
      setName("")
      onSelect(topic.id)
    } catch (err) { setActionError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  function row(value: string, label: string, count?: number) {
    return <button type="button" aria-pressed={selected === value} onClick={() => onSelect(value)}
      className={cn("flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs", selected === value ? "bg-muted font-medium" : "hover:bg-muted/60")}>
      <span className="truncate">{label}</span>{count !== undefined ? <span className="ml-auto tabular-nums text-muted-foreground">{count}</span> : null}
    </button>
  }
  return <section className="shrink-0 border-t border-border p-2" aria-label={t("memory:topics")}>
    <div className="flex items-center justify-between px-2"><h3 className="py-1 text-xs font-medium text-muted-foreground">{t("memory:topics")}</h3>
      <Button variant="ghost" size="icon-sm" aria-label={t("memory:createTopic")} title={t("memory:createTopic")} onClick={() => { setCreating(true); setEditing(null); setDeleting(null); setName(""); setActionError(null) }}><Plus className="size-4" /></Button></div>
    {creating ? <form className="mb-2 space-y-2" onSubmit={event => { event.preventDefault(); void createTopic() }}>
      <input autoFocus aria-label={t("memory:topicName")} value={name} onChange={event => setName(event.target.value)} className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm" />
      <div className="flex gap-1"><Button type="submit" size="sm" disabled={busy || !normalizeTopicName(name)}>{t("common:create")}</Button><Button type="button" variant="ghost" size="sm" onClick={() => setCreating(false)}>{t("common:cancel")}</Button></div>
    </form> : null}
    <div className="max-h-64 overflow-y-auto">
      <div className="flex">{row("all", t("memory:allTopics"))}</div>
      <div className="flex">{row("unclassified", t("memory:unclassified"))}</div>
      {topics.map(topic => <div key={topic.id} className="flex items-center">
        {row(topic.id, topic.name, topic.count)}
        <Button variant="ghost" size="icon-sm" disabled={busy} aria-label={t("memory:renameTopic", { name: topic.name })}
          onClick={() => { setEditing(topic); setDeleting(null); setName(topic.name); setActionError(null) }}><Pencil className="size-3" /></Button>
        <Button variant="ghost" size="icon-sm" disabled={busy} aria-label={t("memory:deleteTopic", { name: topic.name })}
          onClick={() => { setDeleting(topic); setEditing(null); setActionError(null); void load() }}><Trash2 className="size-3" /></Button>
      </div>)}
    </div>
    {editing ? <form className="mt-2 space-y-2" onSubmit={event => { event.preventDefault(); void mutate("rename") }}>
      <label className="text-xs">{t("memory:renameTopic", { name: editing.name })}
        <input value={name} onChange={event => setName(event.target.value)} className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2" />
      </label>
      <div className="flex gap-1"><Button type="submit" size="sm" disabled={busy || !normalizeTopicName(name)}>{t("common:save")}</Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(null)}>{t("common:cancel")}</Button></div>
    </form> : null}
    {deleting ? <div role="alert" className="mt-2 space-y-2 rounded-md border border-border p-2 text-xs">
      <p>{t("memory:deleteTopicConfirmation", { name: deleting.name, count: topics.find(topic => topic.id === deleting.id)?.count ?? deleting.count })}</p>
      <div className="flex gap-1"><Button variant="destructive" size="sm" disabled={busy} onClick={() => void mutate("delete")}>{t("common:delete")}</Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDeleting(null)}>{t("common:cancel")}</Button></div>
    </div> : null}
    {error || actionError ? <p role="alert" className="mt-2 text-xs text-destructive">{actionError ?? error}</p> : null}
  </section>
}
