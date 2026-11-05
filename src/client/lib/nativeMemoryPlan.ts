import type { NativeImportItem, NativeImportOperation, NativeInventoryResult, NativeMemoryEngine, NativeMemoryUnit, NativeModelSelection, NativeRefineJob } from "../../shared/native-memory"
import type { ProviderCatalogEntry } from "../../shared/types"

export interface MemoryTreeGroup {
  key: string
  label: string
  units: NativeMemoryUnit[]
  added: number
  changed: number
}
export interface MemoryTreeSection {
  key: string
  engine: NativeMemoryEngine
  namespace: string | null
  active: boolean | null
  groups: MemoryTreeGroup[]
  units: number
}

export const isPending = (unit: NativeMemoryUnit) => unit.change === "new" || unit.change === "changed"
const isMemory = (unit: NativeMemoryUnit) => unit.kind === "native-memory"
/** Native sources label projects by full path, which truncates to the same prefix in a narrow list. */
export function projectName(label: string) {
  return label.split(" · ").map(part => part.split(/[\\/]/).filter(Boolean).at(-1) ?? part).join(" · ")
}

/** A vanished source has nothing left to read; it is shown, never selected. */
export const isSelectable = (unit: NativeMemoryUnit) => isMemory(unit) && unit.change !== "removed"

/** Claude keeps one directory per project, so its namespaces are projects. Codex's are real versions. */
const sectionNamespace = (unit: NativeMemoryUnit) => unit.engine === "claude" ? null : unit.namespace

export function buildMemoryTree(inventory: NativeInventoryResult): MemoryTreeSection[] {
  const sections = new Map<string, MemoryTreeSection & { byLabel: Map<string, MemoryTreeGroup> }>()
  for (const unit of inventory.units) {
    if (!isMemory(unit)) continue
    const namespace = sectionNamespace(unit)
    const key = `${unit.engine}:${namespace ?? ""}`
    let section = sections.get(key)
    if (!section) {
      const native = inventory.namespaces.find(entry => entry.engine === unit.engine && entry.namespace === unit.namespace)
      section = { key, engine: unit.engine, namespace, active: namespace ? native?.active ?? null : null, groups: [], units: 0, byLabel: new Map() }
      sections.set(key, section)
    }
    // A Codex group can apply to several paths; the first is the project it came from.
    const label = unit.scopes[0]?.label ?? unit.projectLabel
    let group = section.byLabel.get(label)
    if (!group) {
      group = { key: `${key}:${label}`, label, units: [], added: 0, changed: 0 }
      section.byLabel.set(label, group)
      section.groups.push(group)
    }
    group.units.push(unit)
    section.units++
    if (unit.change === "new") group.added++
    if (unit.change === "changed") group.changed++
  }
  const rank = (section: MemoryTreeSection) => (section.active === false ? 1 : 0)
  return [...sections.values()].map(({ byLabel: _byLabel, ...section }) => ({
    ...section,
    groups: section.groups.sort((a, b) => b.added + b.changed - a.added - a.changed || b.units.length - a.units.length || a.label.localeCompare(b.label)),
  })).sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key))
}

/** What has not been imported yet, within the current project when there is one. */
export function defaultUnitSelection(inventory: NativeInventoryResult, projectId?: string): Set<string> {
  const pending = inventory.units.filter(unit => isSelectable(unit) && unit.selectedByDefault && isPending(unit))
  const inProject = projectId ? pending.filter(unit => unit.owner.projectId === projectId) : []
  return new Set((inProject.length ? inProject : pending).map(unit => unit.unitId))
}

export function matchesUnitSearch(unit: NativeMemoryUnit, query: string) {
  const needle = query.trim().toLowerCase()
  return !needle || `${unit.title} ${unit.topic} ${unit.projectLabel}`.toLowerCase().includes(needle)
}

export function summarizeSelection(units: readonly NativeMemoryUnit[], selected: ReadonlySet<string>) {
  const chosen = units.filter(unit => selected.has(unit.unitId))
  return {
    total: chosen.length,
    added: chosen.filter(unit => unit.change === "new").length,
    changed: chosen.filter(unit => unit.change === "changed").length,
    tokens: chosen.reduce((sum, unit) => sum + unit.estimatedTokens, 0),
  }
}

/** Tokens per call before any memory text: the engine's own prompt plus the structure brief. */
const CALL_OVERHEAD_TOKENS = 12_000
/** Matches the server's batch size of 40 000 characters at four per token. */
const BATCH_TOKENS = 10_000
/** Matches the server's cap of ten units per call. */
const BATCH_UNITS = 10

/** Bills the fixed prefix per batch. Text alone understated a real run more than tenfold. */
export function estimateRefineTokens(units: readonly NativeMemoryUnit[], selected: ReadonlySet<string>) {
  const projects = new Map<string, { tokens: number; units: number }>()
  for (const unit of units) {
    if (!selected.has(unit.unitId)) continue
    const key = JSON.stringify([unit.engine, unit.namespace, unit.projectLabel])
    const group = projects.get(key) ?? { tokens: 0, units: 0 }
    projects.set(key, { tokens: group.tokens + unit.estimatedTokens, units: group.units + 1 })
  }
  return [...projects.values()].reduce((sum, { tokens, units }) => sum + tokens + Math.max(Math.ceil(tokens / BATCH_TOKENS), Math.ceil(units / BATCH_UNITS)) * CALL_OVERHEAD_TOKENS, 0)
}

export function selectionBreakdown(sections: readonly MemoryTreeSection[], selected: ReadonlySet<string>) {
  return sections.flatMap(section => section.groups.map(group => ({
    key: group.key, engine: section.engine, group, count: group.units.filter(unit => selected.has(unit.unitId)).length,
  }))).filter(row => row.count > 0).sort((a, b) => b.count - a.count)
}

/** The account model built for bulk work: extraction is expensive and caches poorly. */
export function defaultRefineModel(providers: readonly ProviderCatalogEntry[]): NativeModelSelection | null {
  const account = (id: ProviderCatalogEntry["id"]) => providers.find(provider => provider.id === id)?.models.filter(model => !model.connectionId) ?? []
  const luna = account("codex").find(model => /luna/i.test(model.id))
  if (luna) return { provider: "codex", model: luna.id }
  const haiku = account("claude").find(model => /haiku/i.test(model.id))
  if (haiku) return { provider: "claude", model: haiku.id }
  const first = providers.find(provider => provider.models.length || provider.defaultModel)
  return first ? { provider: first.id, model: first.defaultModel || first.models[0]!.id } : null
}

export const isJobActive = (job: NativeRefineJob) => job.state === "queued" || job.state === "running"

export function jobProgress(job: NativeRefineJob) {
  const finished = job.batches.filter(batch => batch.state === "completed").length
  const failed = job.batches.filter(batch => batch.state === "failed").length
  // Batches are transport. Long units span several, so count a unit once all of them finish.
  const open = new Set(job.batches.filter(batch => batch.state !== "completed").flatMap(batch => batch.unitIds))
  const all = new Set(job.batches.flatMap(batch => batch.unitIds))
  const tokens = job.batches.reduce((sum, batch) => sum + (batch.usage?.totalTokens ?? (batch.usage?.inputTokens ?? 0) + (batch.usage?.outputTokens ?? 0)), 0)
  return { finished, failed, total: job.batches.length, unitsDone: all.size - open.size, units: all.size, tokens, droppedQuotes: job.batches.reduce((sum, batch) => sum + batch.droppedQuotes, 0) }
}

export const canApproveItem = (item: NativeImportItem) => item.disposition === "new" || item.disposition === "changed" || item.disposition === "exact-match" || item.disposition === "unchanged"

export type ProposalScope = "personal" | "project"

export interface ReviewEntry { item: NativeImportItem; unit?: NativeMemoryUnit; saved: boolean }
export interface ReviewSource { key: string; title: string; summary: string; entries: ReviewEntry[] }
export interface ReviewProject { key: string; label: string; unattributed: boolean; sources: ReviewSource[]; count: number }
export interface ReviewModel { attention: ReviewEntry[]; personal: ReviewSource[]; personalCount: number; projects: ReviewProject[] }

/** The one line a source gives about itself: Claude's description, Codex's keywords. */
export function unitSummary(unit?: NativeMemoryUnit) {
  const meta = unit?.metadata ?? {}
  const raw = typeof meta.description === "string" ? meta.description
    : Array.isArray(meta.keywords) ? meta.keywords.join(" · ")
    : typeof meta.keywords === "string" ? meta.keywords.split(/\n/).map(line => line.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean).join(" · ")
    : ""
  return raw.replace(/\s+/g, " ").trim()
}

export function proposalScope(item: NativeImportItem, overrides: Readonly<Record<string, ProposalScope>>): ProposalScope {
  // Personal items keep their project path so they can be moved back; the owner decides.
  return overrides[item.itemKey] ?? (item.owner.scope === "project" ? "project" : "personal")
}

/** What can change existing memory, or carries personal information, is read one by one. */
const needsLook = (item: NativeImportItem) =>
  item.disposition === "changed" || item.disposition === "conflict" || item.disposition === "suppressed" || Boolean(item.flags?.includes("personal-info"))

/**
 * Review is arranged by consequence: what needs a look, what reaches every project,
 * then project memory stacked by the source file it came from. Removed items are left out.
 */
export function reviewModel(operations: readonly NativeImportOperation[], overrides: Readonly<Record<string, ProposalScope>> = {}, removed: ReadonlySet<string> = new Set()): ReviewModel {
  const model: ReviewModel = { attention: [], personal: [], personalCount: 0, projects: [] }
  const projects = new Map<string, ReviewProject>()
  for (const operation of operations) {
    const saved = Boolean(operation.receipt)
    const hidden = new Set([...removed, ...(operation.receipt?.rejected ?? [])])
    for (const item of operation.plan.items) {
      if (hidden.has(item.itemKey)) continue
      const unit = operation.plan.units.find(entry => entry.unitId === item.unitId)
      const entry = { item, unit, saved }
      if (needsLook(item)) { model.attention.push(entry); continue }
      const unattributed = Boolean(unit?.unresolvedProject) && !item.projectPath
      const sourceKey = `${operation.plan.operationId}:${item.unitId}`
      const addTo = (sources: ReviewSource[]) => {
        let source = sources.find(candidate => candidate.key === sourceKey)
        if (!source) { source = { key: sourceKey, title: unit?.title ?? "", summary: unitSummary(unit), entries: [] }; sources.push(source) }
        source.entries.push(entry)
      }
      if (proposalScope(item, overrides) === "personal" && !unattributed) { addTo(model.personal); model.personalCount++; continue }
      const label = item.projectLabel ?? unit?.scopes[0]?.label ?? unit?.projectLabel ?? ""
      const key = unattributed ? "unattributed" : `project:${label}`
      let project = projects.get(key)
      if (!project) { project = { key, label, unattributed, sources: [], count: 0 }; projects.set(key, project) }
      addTo(project.sources)
      project.count++
    }
  }
  model.projects = [...projects.values()].sort((a, b) => Number(a.unattributed) - Number(b.unattributed) || b.count - a.count || a.label.localeCompare(b.label))
  return model
}

/** 72 000 reads as 7.2万 or 72K; memory is budgeted in round numbers. */
export function formatTokens(tokens: number, locale: string) {
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(tokens)
}

export interface MemoryLine { kind: "heading" | "item" | "text"; text: string }

/**
 * Splits imported text into readable lines. Leading lines that only repeat the
 * source (shown beside the row already) are dropped; Markdown markers go.
 */
export function memoryLines(content: string, repeats: Array<string | undefined> = []): MemoryLine[] {
  const known = new Set(repeats.flatMap(value => value?.split("\n") ?? []).map(line => line.trim()).filter(Boolean))
  const lines = content.split("\n").map(line => line.trim()).filter(Boolean)
  while (lines.length > 1 && known.has(lines[0]!)) lines.shift()
  return lines.map(line => {
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading) return { kind: "heading" as const, text: heading[1]! }
    const item = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line)
    return item ? { kind: "item" as const, text: item[1]! } : { kind: "text" as const, text: line }
  })
}
