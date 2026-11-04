import { useEffect, useState } from "react"
import { Command, Loader2, RefreshCw } from "lucide-react"
import type { ChatCommandCatalog, RuntimeCommand, RuntimeConnector } from "../../../shared/runtime-commands"
import { t, useI18n } from "../../i18n"
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover"
import { Button } from "../ui/button"
import { cn } from "../../lib/utils"
import { runtimeCommandToken } from "../../lib/runtimeCommands"

interface Props {
  chatId: string
  catalog: ChatCommandCatalog | null
  busy?: boolean
  error?: string | null
  disabled?: boolean
  onRefresh: () => Promise<unknown>
  onExecute: (command: RuntimeCommand, args?: string) => Promise<unknown>
  onCancel: () => Promise<unknown>
  onInsert: (name: string) => void
}

function connectorState(value: RuntimeConnector["state"]) {
  switch (value) {
    case "connected": return t("commands:connected")
    case "discovered": return t("commands:discovered")
    case "needs-auth": return t("commands:needsAuth")
    case "disabled": return t("commands:disabled")
    case "failed": return t("commands:failed")
    case "stale-schema": return t("commands:staleSchema")
    case "unsupported": return t("commands:unsupported")
    default: return t("commands:unknown")
  }
}

export function RuntimeCommandControl({ chatId, catalog, busy, error, disabled, onRefresh, onExecute, onCancel, onInsert }: Props) {
  useI18n()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<"commands" | "skills" | "connectors">("commands")
  const [localError, setLocalError] = useState<string | null>(null)
  useEffect(() => { setOpen(false); setLocalError(null) }, [chatId])
  const operation = catalog?.operation
  const running = operation?.status === "running" || operation?.status === "busy"
  async function act(action: () => Promise<unknown>) {
    setLocalError(null)
    try { await action() } catch (err) { setLocalError(err instanceof Error ? err.message : t("commands:executeFailed")) }
  }
  const tabs = [{ id: "commands", label: t("commands:commands") }, { id: "skills", label: t("commands:skills") }, { id: "connectors", label: t("commands:connectors") }] as const
  return <Popover open={open} onOpenChange={value => { setOpen(value); if (value && !catalog) void act(onRefresh) }}>
    <PopoverTrigger asChild><button type="button" aria-label={t("commands:title")} disabled={disabled} className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[13px] text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">{busy || running ? <Loader2 aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" /> : <Command aria-hidden className="size-3.5" />}<span>{t("commands:tools")}</span></button></PopoverTrigger>
    <PopoverContent align="end" collisionPadding={12} className="w-96 max-w-[calc(100vw-24px)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto overscroll-contain p-3">
      <div className="mb-3 flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">{t("commands:title")}</h3><Button variant="ghost" size="icon" className="size-7" aria-label={t("commands:refresh")} disabled={busy || running} onClick={() => void act(onRefresh)}><RefreshCw aria-hidden className="size-3.5" /></Button></div>
      <div role="tablist" aria-label={t("commands:title")} className="mb-3 flex gap-1">{tabs.map(item => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} aria-controls={`runtime-${item.id}`} id={`runtime-tab-${item.id}`} onClick={() => setTab(item.id)} className={cn("rounded-md px-2 py-1.5 text-xs", tab === item.id ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60")}>{item.label}</button>)}</div>
      {error || localError ? <p role="alert" className="mb-2 break-words text-xs text-destructive">{error || localError}</p> : null}
      {!catalog?.runtime ? <p className="text-xs leading-5 text-muted-foreground">{t("commands:notReady")}</p> : <div role="tabpanel" id={`runtime-${tab}`} aria-labelledby={`runtime-tab-${tab}`} className="space-y-2">
        {tab === "commands" ? <>
          {catalog.commands.status !== "ready" ? <p className="text-xs leading-5 text-muted-foreground">{catalog.commands.reason || t("commands:discoveryUnavailable")}</p> : catalog.commands.items.length === 0 ? <p className="text-xs text-muted-foreground">{t("commands:noCommands")}</p> : catalog.commands.items.map(command => <button key={command.id} type="button" disabled={busy || running || catalog.commands.status !== "ready" || command.route === "compact" && catalog.compact.status !== "available"} onClick={() => { if (command.route === "compact") void act(() => onExecute(command)); else { onInsert(runtimeCommandToken(command, catalog.commands.items)); setOpen(false) } }} className="block w-full rounded-lg px-2 py-2 text-left hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"><span className="text-sm">/{command.name.replace(/^\//, "")}</span><span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{command.description}</span></button>)}
          {catalog.compact.status === "unsupported" || catalog.compact.status === "unknown" ? <p className="text-xs leading-5 text-muted-foreground">{catalog.compact.reason || t("commands:compactUnavailable")}</p> : null}
        </> : tab === "skills" ? <>
          <p className="text-xs leading-5 text-muted-foreground">{t("commands:skillEvidence")}</p>
          {catalog.skills.status !== "ready" ? <p className="text-xs text-muted-foreground">{catalog.skills.reason || t("commands:discoveryUnavailable")}</p> : catalog.skills.items.length === 0 ? <p className="text-xs text-muted-foreground">{t("commands:noSkills")}</p> : catalog.skills.items.map(skill => <div key={skill.id} className="rounded-lg px-2 py-2"><p className="text-sm">{skill.name}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{skill.description}</p><p className="mt-1 text-xs text-muted-foreground">{skill.enabled === false ? t("commands:disabled") : skill.loaded === true ? t("commands:loaded") : skill.loaded === false ? t("commands:notLoaded") : t("commands:loadUnknown")}</p></div>)}
        </> : <>
          <p className="text-xs leading-5 text-muted-foreground">{t("commands:connectorEvidence")}</p>
          {catalog.connectors.status !== "ready" ? <p className="text-xs text-muted-foreground">{catalog.connectors.reason || t("commands:discoveryUnavailable")}</p> : catalog.connectors.items.length === 0 ? <p className="text-xs text-muted-foreground">{t("commands:noConnectors")}</p> : catalog.connectors.items.map(connector => <div key={connector.id} className="rounded-lg px-2 py-2"><p className="text-sm">{connector.name}</p><p className="mt-1 text-xs text-muted-foreground">{connector.kind === "mcp" ? t("commands:mcp") : connector.kind === "model-provider" ? t("commands:modelProvider") : t("commands:hostedService")} / {connectorState(connector.state)}</p></div>)}
        </>}
      </div>}
      {operation ? <div role="status" className="mt-3 space-y-1 border-t border-border pt-3 text-xs leading-5 text-muted-foreground">
        <p>{operation.phase === "restoring" ? t("commands:restoring") : running ? t("commands:running") : operation.status === "completed" ? operation.contextRestored ? t("commands:completedRestored") : t("commands:completed") : operation.status === "cancelled" ? t("commands:cancelled") : operation.status === "failed" ? t("commands:failed") : t("commands:available")}</p>
        {operation.reason ? <p className="break-words">{operation.reason}</p> : null}
        {running ? <Button variant="outline" size="sm" disabled={busy && !operation} onClick={() => void act(onCancel)}>{t("common:cancel")}</Button> : null}
      </div> : null}
    </PopoverContent>
  </Popover>
}
