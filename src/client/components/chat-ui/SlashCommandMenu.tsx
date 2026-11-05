import { forwardRef } from "react"
import { Loader2, RefreshCw, Scissors, Sparkles, SquareSlash, type LucideIcon } from "lucide-react"
import type { ChatCommandCatalog, RuntimeCommand, RuntimeConnector } from "../../../shared/runtime-commands"
import { t } from "../../i18n"
import { translateUiText } from "../../i18n/uiText"
import { cn } from "../../lib/utils"
import { runtimeCommandToken } from "../../lib/runtimeCommands"
import { BrandMark, brandForModel } from "../brand/BrandIcon"

/** Claude exposes MCP prompts as mcp__<server>__<prompt>. */
const mcpServer = (name: string) => /^mcp__(.+?)__/.exec(name)?.[1]

/** A connector's own mark: its vendor logo when known, otherwise a letter tile. */
export function ConnectorMark({ connector, className }: { connector: Pick<RuntimeConnector, "name" | "kind">; className?: string }) {
  const brand = brandForModel(connector.name)
  if (brand) return <span className={cn("inline-flex size-5 shrink-0 items-center justify-center", className)}><BrandMark brand={brand} className="size-3.5" /></span>
  return <span aria-hidden className={cn("inline-flex size-5 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-[10px] font-semibold uppercase text-foreground", className)}>
    {connector.name.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 1) || "?"}
  </span>
}

function CommandMark({ command, catalog }: { command: RuntimeCommand; catalog: ChatCommandCatalog }) {
  const server = mcpServer(command.name)
  if (server) return <ConnectorMark connector={catalog.connectors.items.find(c => c.name === server) ?? { name: server, kind: "mcp" }} />
  const Icon = command.route === "compact" ? Scissors
    : command.namespace === "skill" || catalog.skills.items.some(skill => skill.name === command.name) ? Sparkles : SquareSlash
  return <span className="inline-flex size-5 shrink-0 items-center justify-center"><Icon aria-hidden className="size-4 text-muted-foreground" /></span>
}

const shownName = (command: RuntimeCommand, token: string) => command.namespace === "skill" ? token.replace(/^(?:skill:)+/, "") : token

interface Props {
  catalog: ChatCommandCatalog | null | undefined
  matches: string[] | null
  activeIndex: number
  maxHeight: number
  busy?: boolean
  onPick: (token: string) => void
  onRetry?: () => void
  /** Composer-owned commands such as /plan, shown alongside the engine's own. */
  hostCommands?: Record<string, { description: string; icon: LucideIcon }>
}

/** The composer's single entry to native commands, skills and connectors. */
export const SlashCommandMenu = forwardRef<HTMLDivElement, Props>(function SlashCommandMenu({ catalog, matches, activeIndex, maxHeight, busy, onPick, onRetry, hostCommands }, listRef) {
  const items = catalog?.commands.items ?? []
  const byToken = new Map(items.map(command => [runtimeCommandToken(command, items), command]))
  const failed = catalog?.preparation?.status === "error" || catalog?.commands.status === "failed"
  const connectors = (catalog?.connectors.items ?? []).filter(connector => connector.kind !== "model-provider")
  return <div style={{ maxHeight }} className="absolute bottom-full left-2 right-2 z-20 mb-2 flex flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-lg">
    {matches ? <div ref={listRef} role="listbox" aria-label={t("commands:commands")} className="min-h-0 flex-1 overflow-y-auto py-1">
      {matches.map((token, index) => {
        const command = byToken.get(token)
        const host = !command ? hostCommands?.[token] : undefined
        return <button
          key={token}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          // pointerdown (not click) so the textarea keeps focus
          onPointerDown={event => { event.preventDefault(); onPick(token) }}
          className={cn("flex w-full min-w-0 items-center gap-2.5 px-3 py-1.5 text-left text-sm", index === activeIndex ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60")}
        >
          {command && catalog ? <CommandMark command={command} catalog={catalog} /> : host ? <span className="inline-flex size-5 shrink-0 items-center justify-center"><host.icon aria-hidden className="size-4 text-muted-foreground" /></span> : <SquareSlash aria-hidden className="size-4 shrink-0" />}
          <span className="shrink-0 text-foreground">/{command ? shownName(command, token) : token}</span>
          {command?.description || host?.description ? <span className="min-w-0 truncate text-xs text-muted-foreground">{command?.description || host?.description}</span> : null}
        </button>
      })}
    </div> : failed ? <div role="alert" className="flex items-center gap-3 px-4 py-3 text-[13px]">
      <span className="min-w-0 flex-1 text-muted-foreground">{t("commands:prepareFailed")}{catalog?.preparation?.message ? <span className="block truncate text-xs">{translateUiText(catalog.preparation.message)}</span> : null}</span>
      {onRetry ? <button type="button" disabled={busy} onPointerDown={event => { event.preventDefault(); onRetry() }} className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"><RefreshCw aria-hidden className="size-3" />{t("commands:retry")}</button> : null}
    </div> : <div role="status" className="flex items-center gap-2 px-4 py-3 text-[13px] text-muted-foreground">
      <Loader2 aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />{t("commands:preparing")}
    </div>}
    {connectors.length ? <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-border px-3 py-2" aria-label={t("commands:connectors")}>
      {connectors.map(connector => {
        const ok = connector.state === "connected" || connector.state === "discovered"
        return <span key={connector.id} title={`${connector.name} · ${t(`commands:${connectorStateKey(connector.state)}`)}`} className={cn("flex items-center gap-1.5 rounded-md py-0.5 pl-0.5 pr-1.5 text-xs", ok ? "text-muted-foreground" : "text-muted-foreground/60")}>
          <ConnectorMark connector={connector} className={cn(!ok && "opacity-50")} />
          {connector.name}
          {!ok ? <span className="size-1.5 rounded-full bg-amber-500" aria-label={t(`commands:${connectorStateKey(connector.state)}`)} /> : null}
        </span>
      })}
    </div> : null}
  </div>
})

function connectorStateKey(state: RuntimeConnector["state"]) {
  switch (state) {
    case "connected": return "connected" as const
    case "discovered": return "discovered" as const
    case "needs-auth": return "needsAuth" as const
    case "disabled": return "disabled" as const
    case "failed": return "failed" as const
    case "stale-schema": return "staleSchema" as const
    case "unsupported": return "unsupported" as const
    default: return "unknown" as const
  }
}
