import { useEffect, useState } from "react"
import { ChevronDown, ChevronRight, GripVertical, Pencil, Plus, Trash2 } from "lucide-react"
import { normalizeTopicName } from "../../../shared/memory-topics"
import { t, useI18n } from "../../i18n"
import { memoriesApi, type MemoryTopic, type TopicInitializationPreview } from "../../lib/memoriesApi"
import { canMoveTopic, type TopicFilter } from "../../lib/memoryTopics"
import { refreshMemoryTopics, useMemoryTopicStore } from "../../stores/memoryTopicStore"
import { cn } from "../../lib/utils"
import { Button } from "../ui/button"
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from "../ui/context-menu"

export function MemoryTopicDirectory({ selected, onSelect }: {
  selected: TopicFilter; onSelect: (topic: TopicFilter) => void
}) {
  useI18n()
  const topics = useMemoryTopicStore(s => s.topics)
  const error = useMemoryTopicStore(s => s.error)
  const load = useMemoryTopicStore(s => s.load)
  const [initializationModel, setInitializationModel] = useState<{ provider: string; model: string; available: boolean } | null>(null)
  const [modelError, setModelError] = useState(false)
  const [initialization, setInitialization] = useState<TopicInitializationPreview | null>(null)
  const [initializationResult, setInitializationResult] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [parentId, setParentId] = useState("")
  const [moving, setMoving] = useState<MemoryTopic | null>(null)
  const [editing, setEditing] = useState<MemoryTopic | null>(null)
  const [deleting, setDeleting] = useState<MemoryTopic | null>(null)
  const [name, setName] = useState("")
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  useEffect(() => { void load() }, [load])
  async function loadInitializationModel() {
    try { setInitializationModel(await memoriesApi.topicInitializationModel()); setModelError(false) }
    catch { setModelError(true) }
  }
  useEffect(() => { void loadInitializationModel() }, [])
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
      const topic = await memoriesApi.createTopic(normalizeTopicName(name), parentId || null)
      await refreshMemoryTopics()
      setCreating(false)
      setName("")
      setParentId("")
      onSelect(topic.id)
    } catch (err) { setActionError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  async function previewInitialization() {
    if (busy) return
    setBusy(true); setActionError(null); setInitializationResult(null)
    await loadInitializationModel()
    try { setInitialization(await memoriesApi.previewTopicInitialization()) }
    catch (err) { setActionError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  async function applyInitialization() {
    if (!initialization || busy) return
    setBusy(true); setActionError(null)
    try {
      const result = await memoriesApi.applyTopicInitialization(initialization.id)
      setInitialization(null); setInitializationResult(t("memory:initializationResult", { topics: result.topicsCreated, memories: result.memoriesAssigned }))
      await refreshMemoryTopics()
    } catch (err) { setActionError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  function topicPath(topic: MemoryTopic): string {
    const names = [topic.name]
    const seen = new Set([topic.id])
    let parent = topic.parentId
    while (parent && !seen.has(parent)) {
      seen.add(parent)
      const found = topics.find(item => item.id === parent)
      if (!found) break
      names.unshift(found.name)
      parent = found.parentId
    }
    return names.join(" / ")
  }
  function openMove(topic: MemoryTopic) {
    setMoving(topic); setParentId(topic.parentId ?? ""); setEditing(null); setDeleting(null); setCreating(false); setActionError(null)
  }
  async function moveTopicTo(id: string, nextParentId: string | null) {
    if (busy || !canMoveTopic(topics, id, nextParentId)) return
    if ((topics.find(topic => topic.id === id)?.parentId ?? null) === nextParentId) { setMoving(null); return }
    setBusy(true); setActionError(null)
    try {
      await memoriesApi.moveTopic(id, nextParentId)
      setMoving(null)
      if (nextParentId) setCollapsed(previous => { const next = new Set(previous); next.delete(nextParentId); return next })
      await refreshMemoryTopics()
    } catch (err) { setActionError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  function dropOn(event: React.DragEvent, nextParentId: string | null) {
    event.preventDefault(); event.stopPropagation()
    const id = draggedId
    setDraggedId(null); setDropTarget(null)
    if (id) void moveTopicTo(id, nextParentId)
  }
  function allowDrop(event: React.DragEvent, nextParentId: string | null) {
    event.stopPropagation()
    if (!draggedId || busy || !canMoveTopic(topics, draggedId, nextParentId)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = "move"
    setDropTarget(nextParentId ?? "root")
  }
  function parentSelect() {
    return <select aria-label={t("memory:parentTopic")} value={parentId} onChange={event => setParentId(event.target.value)} className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm">
      <option value="">{t("memory:rootTopic")}</option>
      {topics.filter(topic => !moving || canMoveTopic(topics, moving.id, topic.id)).map(topic => <option key={topic.id} value={topic.id}>{topicPath(topic)}</option>)}
    </select>
  }
  function row(value: string, label: string, count?: number) {
    return <button type="button" aria-pressed={selected === value} onClick={() => onSelect(value)}
      className={cn("flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs", selected === value ? "bg-muted font-medium" : "hover:bg-muted/60")}>
      <span className="truncate">{label}</span>{count !== undefined ? <span className="ml-auto tabular-nums text-muted-foreground">{count}</span> : null}
    </button>
  }
  function renderChildren(parent: string | null, depth: number): React.ReactNode {
    return topics.filter(topic => (topic.parentId ?? null) === parent)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(topic => {
        const hasChildren = topics.some(child => child.parentId === topic.id)
        const expanded = !collapsed.has(topic.id)
        return <div key={topic.id}>
          <ContextMenu>
            <ContextMenuTrigger asChild><div className={cn("flex items-center rounded-md", dropTarget === topic.id && "bg-primary/15 ring-1 ring-primary")}
              style={{ paddingLeft: depth * 12 }} onDragOver={event => allowDrop(event, topic.id)}
              onDragLeave={() => setDropTarget(null)} onDrop={event => dropOn(event, topic.id)}>
              {hasChildren ? <button type="button" aria-expanded={expanded} aria-label={t(expanded ? "memory:collapseTopic" : "memory:expandTopic", { name: topic.name })}
                className="shrink-0 p-1" onClick={() => setCollapsed(previous => { const next = new Set(previous); if (expanded) next.add(topic.id); else next.delete(topic.id); return next })}>
                {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              </button> : <span className="w-5 shrink-0" />}
              <span draggable={!busy} title={t("memory:dragTopic", { name: topic.name })} aria-label={t("memory:dragTopic", { name: topic.name })}
                className="cursor-grab touch-none text-muted-foreground active:cursor-grabbing"
                onDragStart={event => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", topic.id); setDraggedId(topic.id) }}
                onDragEnd={() => { setDraggedId(null); setDropTarget(null) }}><GripVertical className="size-3.5" /></span>
              {row(topic.id, topic.name, topic.count)}
              <Button variant="ghost" size="icon-sm" aria-label={t("memory:moveTopic")} title={t("memory:moveTopic")} onClick={() => openMove(topic)}>↳</Button>
              <Button variant="ghost" size="icon-sm" disabled={busy} aria-label={t("memory:renameTopic", { name: topic.name })}
                onClick={() => { setEditing(topic); setDeleting(null); setName(topic.name); setActionError(null) }}><Pencil className="size-3" /></Button>
              <Button variant="ghost" size="icon-sm" disabled={busy} aria-label={t("memory:deleteTopic", { name: topic.name })}
                onClick={() => { setDeleting(topic); setEditing(null); setActionError(null); void load() }}><Trash2 className="size-3" /></Button>
            </div></ContextMenuTrigger>
            <ContextMenuContent><ContextMenuItem disabled={busy} onSelect={() => openMove(topic)}>{t("memory:moveTopic")}</ContextMenuItem></ContextMenuContent>
          </ContextMenu>
          {hasChildren && expanded ? renderChildren(topic.id, depth + 1) : null}
        </div>
      })
  }
  return <section className="shrink-0 border-t border-border p-2" aria-label={t("memory:topics")}>
    <div className="flex items-center justify-between px-2"><h3 className="py-1 text-xs font-medium text-muted-foreground">{t("memory:topics")}</h3>
      <Button variant="ghost" size="icon-sm" aria-label={t("memory:createTopic")} title={t("memory:createTopic")} onClick={() => { setCreating(true); setEditing(null); setDeleting(null); setName(""); setActionError(null) }}><Plus className="size-4" /></Button></div>
    <Button variant="ghost" size="sm" disabled={busy} onClick={() => void previewInitialization()}>{t("memory:initializeTopics")}</Button>
    <p className="px-2 text-xs text-muted-foreground" aria-live="polite">
      {initializationModel ? t("memory:initializationModel", { provider: initializationModel.provider, model: initializationModel.model }) : t(modelError ? "memory:initializationModelUnavailable" : "memory:initializationModelLoading")}
      {initializationModel && !initializationModel.available ? ` ${t("memory:initializationModelCheck")}` : ""}
    </p>
    {initializationResult ? <p role="status" className="text-xs">{initializationResult}</p> : null}
    {initialization ? <div className="my-2 space-y-2 rounded-md border border-border p-2 text-xs">
      <p>{t("memory:initializationReview")}</p>
      <div className="max-h-48 overflow-auto space-y-1">{initialization.topics.map(topic => <p key={topic.key}>{topic.parentKey ? `${initialization.topics.find(parent => parent.key === topic.parentKey)?.name} / ` : ""}<strong>{topic.name}</strong></p>)}</div>
      <div className="max-h-48 overflow-auto space-y-1">{initialization.assignments.map(assignment => <p key={assignment.memoryId}>{initialization.memories.find(item => item.id === assignment.memoryId)?.content} → {initialization.topics.find(topic => topic.key === assignment.topicKey)?.name}</p>)}</div>
      <p>{t("memory:initializationUnclassified", { count: initialization.memories.length - initialization.assignments.length })}</p>
      <div className="flex gap-1"><Button size="sm" disabled={busy} onClick={() => void applyInitialization()}>{t("memory:initializationApply")}</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => setInitialization(null)}>{t("common:cancel")}</Button></div>
    </div> : null}
    {creating ? <form className="mb-2 space-y-2" onSubmit={event => { event.preventDefault(); void createTopic() }}>
      {parentSelect()}
      <input autoFocus aria-label={t("memory:topicName")} value={name} onChange={event => setName(event.target.value)} className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm" />
      <div className="flex gap-1"><Button type="submit" size="sm" disabled={busy || !normalizeTopicName(name)}>{t("common:create")}</Button><Button type="button" variant="ghost" size="sm" onClick={() => setCreating(false)}>{t("common:cancel")}</Button></div>
    </form> : null}
    <div className="max-h-64 overflow-y-auto">
      <div className={cn("flex rounded-md", dropTarget === "root" && "bg-primary/15 ring-1 ring-primary")}
        onDragOver={event => allowDrop(event, null)} onDragLeave={() => setDropTarget(null)} onDrop={event => dropOn(event, null)}>
        {row("all", t("memory:allTopics"))}
      </div>
      <div className="flex">{row("unclassified", t("memory:unclassified"))}</div>
      {renderChildren(null, 0)}
    </div>
    {moving ? <form className="mt-2 space-y-2" onSubmit={event => { event.preventDefault(); if (moving) void moveTopicTo(moving.id, parentId || null) }}>
      <p className="text-xs">{t("memory:moveTopic")}: {topicPath(moving)}</p>{parentSelect()}
      <div className="flex gap-1"><Button type="submit" size="sm" disabled={busy}>{t("common:save")}</Button><Button type="button" variant="ghost" size="sm" onClick={() => setMoving(null)}>{t("common:cancel")}</Button></div>
    </form> : null}
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
