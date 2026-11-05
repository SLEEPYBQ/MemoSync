import { useState } from "react"
import { ChevronRight, CircleDashed, Search, ShieldAlert } from "lucide-react"
import type { NativeMemoryEngine, NativeMemoryUnit } from "../../../shared/native-memory"
import { t } from "../../i18n"
import { isSelectable, matchesUnitSearch, projectName, type MemoryTreeGroup, type MemoryTreeSection } from "../../lib/nativeMemoryPlan"
import { cn } from "../../lib/utils"
import { BrandTile, ENGINE_BRANDS } from "../brand/BrandIcon"
import { NativeCheckbox } from "./NativeCheckbox"
import { NativeUiInfo } from "./NativeUiInfo"

export const groupName = (group: MemoryTreeGroup) => group.units[0]?.unresolvedProject ? t("nativeMemory:unresolvedProject") : projectName(group.label)

const ENGINE_NAMES: Record<NativeMemoryEngine, string> = { claude: "Claude Code", codex: "Codex", pi: "Pi", opencode: "OpenCode" }

function checkState(units: readonly NativeMemoryUnit[], selected: ReadonlySet<string>) {
  const selectable = units.filter(isSelectable)
  const chosen = selectable.filter(unit => selected.has(unit.unitId)).length
  return { disabled: !selectable.length, checked: chosen > 0 && chosen === selectable.length, indeterminate: chosen > 0 && chosen < selectable.length, ids: selectable.map(unit => unit.unitId) }
}

function ChangeMark({ added, changed }: { added: number; changed: number }) {
  if (!added && !changed) return null
  return <span className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums">
    {added ? <span className="text-success" aria-label={t("nativeMemory:newCount", { count: added })}>+{added}</span> : null}
    {changed ? <span className="text-amber-600 dark:text-amber-400" aria-label={t("nativeMemory:changedCount", { count: changed })}>~{changed}</span> : null}
  </span>
}

interface RowProps {
  group: MemoryTreeGroup
  query: string
  selected: ReadonlySet<string>
  activeUnitId?: string
  onToggle: (unitIds: string[], checked: boolean) => void
  onOpen: (unit: NativeMemoryUnit) => void
}

function GroupRow({ group, query, selected, activeUnitId, onToggle, onOpen }: RowProps) {
  const [expanded, setExpanded] = useState(false)
  const units = group.units.filter(unit => matchesUnitSearch(unit, query))
  if (!units.length) return null
  const state = checkState(group.units, selected)
  const open = expanded || Boolean(query.trim())
  const name = groupName(group)
  return <li>
    <div className="group/row flex min-w-0 items-center gap-1.5 rounded-lg py-1 pl-1 pr-2 hover:bg-muted/70">
      <button type="button" aria-expanded={open} aria-label={name} onClick={() => setExpanded(!expanded)} className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight aria-hidden className={cn("size-3.5 transition-transform motion-reduce:transition-none", open && "rotate-90")} />
      </button>
      <NativeCheckbox aria-label={t("nativeMemory:selectGroup", { name })} disabled={state.disabled} checked={state.checked} indeterminate={state.indeterminate} onChange={value => onToggle(state.ids, value)} />
      <button type="button" onClick={() => setExpanded(!expanded)} title={group.label} className="min-w-0 flex-1 truncate py-0.5 pl-1 text-left text-[13px]">{name}</button>
      <ChangeMark added={group.added} changed={group.changed} />
      <span className="w-6 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{group.units.length}</span>
    </div>
    {open ? <ul className="mb-1 ml-[1.15rem] border-l border-border/70 pl-1.5">
      {units.map(unit => {
        const selectable = isSelectable(unit)
        return <li key={unit.unitId} className={cn("flex min-w-0 items-center gap-2 rounded-md px-1.5 hover:bg-muted/70", activeUnitId === unit.unitId && "bg-muted")}>
          <NativeCheckbox aria-label={unit.title} disabled={!selectable} checked={selected.has(unit.unitId)} onChange={value => onToggle([unit.unitId], value)} />
          <button type="button" onClick={() => onOpen(unit)} title={unit.title} className={cn("min-w-0 flex-1 truncate py-1 text-left text-[13px]", selectable ? "text-muted-foreground hover:text-foreground" : "text-muted-foreground/60 line-through")}>{unit.title}</button>
          {unit.quarantinedBlocks ? <ShieldAlert aria-label={t("nativeMemory:quarantined", { count: unit.quarantinedBlocks })} className="size-3 shrink-0 text-amber-500" /> : null}
          {unit.change === "new" ? <span aria-label={t("nativeMemory:changeNew")} className="size-1.5 shrink-0 rounded-full bg-success" /> : unit.change === "changed" ? <span aria-label={t("nativeMemory:changeChanged")} className="size-1.5 shrink-0 rounded-full bg-amber-500" /> : null}
        </li>
      })}
    </ul> : null}
  </li>
}

interface Props {
  sections: MemoryTreeSection[]
  selected: ReadonlySet<string>
  activeUnitId?: string
  onToggle: (unitIds: string[], checked: boolean) => void
  onOpen: (unit: NativeMemoryUnit) => void
}

export function NativeMemorySourceTree({ sections, selected, activeUnitId, onToggle, onOpen }: Props) {
  const [query, setQuery] = useState("")
  const visible = sections.some(section => section.groups.some(group => group.units.some(unit => matchesUnitSearch(unit, query))))
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="shrink-0 px-3 pb-2 pt-3">
      <label className="flex h-8 items-center gap-2 rounded-lg bg-background px-2.5 shadow-[inset_0_0_0_1px_hsl(var(--border))] focus-within:shadow-[inset_0_0_0_1px_hsl(var(--foreground)/0.3)]">
        <Search aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <input value={query} onChange={event => setQuery(event.target.value)} aria-label={t("nativeMemory:search")} placeholder={t("nativeMemory:search")} className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground" />
      </label>
    </div>
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-2 pb-3">
      {sections.map(section => {
        const state = checkState(section.groups.flatMap(group => group.units), selected)
        const label = section.namespace ? `${ENGINE_NAMES[section.engine]} ${section.namespace}` : ENGINE_NAMES[section.engine]
        return <section key={section.key} aria-label={label}>
          <div className="flex items-center gap-2 px-1.5 py-1">
            <NativeCheckbox aria-label={t("nativeMemory:selectGroup", { name: label })} disabled={state.disabled} checked={state.checked} indeterminate={state.indeterminate} onChange={value => onToggle(state.ids, value)} />
            <BrandTile brand={ENGINE_BRANDS[section.engine]} size="sm" />
            <h3 className="min-w-0 truncate text-[13px] font-medium">{label}</h3>
            {section.active === false ? <NativeUiInfo label={t("nativeMemory:inactiveNamespace")}>{t("nativeMemory:inactiveNamespace")}</NativeUiInfo> : null}
            <span className="ml-auto text-xs tabular-nums text-muted-foreground">{section.units}</span>
          </div>
          <ul className="mt-0.5">{section.groups.map(group => <GroupRow key={group.key} group={group} query={query} selected={selected} activeUnitId={activeUnitId} onToggle={onToggle} onOpen={onOpen} />)}</ul>
        </section>
      })}
      {!visible ? <p className="flex items-center gap-2 px-2 py-6 text-[13px] text-muted-foreground"><CircleDashed aria-hidden className="size-3.5" />{query ? t("nativeMemory:noMatches") : t("nativeMemory:noMemory")}</p> : null}
    </div>
  </div>
}
