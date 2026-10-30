import { useState, type ReactNode } from "react"
import { CheckCircle2, CircleAlert, RefreshCw, Terminal } from "lucide-react"
import { ENGINES_WITH_ACCOUNT_MODE, endpointForEngine, type ApiConnection, type EngineId, type EngineSetup, type EngineStatus } from "../../../shared/model-access"
import type { AppSocket } from "../socket"
import { t, useI18n } from "../../i18n"
import { engineProblemMessage, incompatibleConnectionMessage } from "../../model-access/modelAccess"
import { SegmentedControl } from "../../components/ui/segmented-control"
import { SettingsActionButton, SettingsGroup, SettingsNotice } from "./shared"
import { CONNECTION_FIELD_CLASS } from "./ConnectionEditor"

const ENGINE_NAMES = { claude: "Claude Code", codex: "Codex", pi: "Pi" }
export function EngineCard({ engine, status, connections, socket, children }: {
  engine: EngineId; status?: EngineStatus; connections: ApiConnection[]; socket?: Pick<AppSocket, "command">; children: ReactNode
}) {
  useI18n()
  const [path, setPath] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const setup = status?.setup
  const access = setup?.access
  const executable = status?.executable
  const selectedConnection = access?.mode === "connection" ? connections.find(c => c.id === access.connectionId) : undefined
  async function command(action: () => Promise<unknown>) {
    if (pending) return
    setPending(true); setError(null)
    try { await action() } catch (reason) { setError(reason instanceof Error ? reason.message : t("modelAccess:commandFailed")) } finally { setPending(false) }
  }
  function setSetup(next: EngineSetup) {
    if (socket) void command(() => socket.command({ type: "modelAccess.setEngine", engine, setup: next }))
  }
  function chooseConnection(connectionId: string) {
    const connection = connections.find(c => c.id === connectionId)
    if (setup) setSetup({ ...setup, access: { mode: "connection", connectionId, defaultModel: connection?.models[0]?.id } })
  }
  const sourceKeys = { configured: "sourceConfigured", path: "sourcePath", "known-dir": "sourceKnown", bundled: "sourceBundled" } as const
  return <div data-engine={engine} data-access-mode={access?.mode} data-executable-state={executable?.state}><SettingsGroup title={<span className="flex items-center gap-2"><Terminal className="size-4" aria-hidden="true" />{ENGINE_NAMES[engine]}</span>}>
    <div className="space-y-4 p-4">
      <div role="status" className="flex items-start gap-2 text-sm">
        {status?.ready ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> : <CircleAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
        <span className="break-words">{status ? engineProblemMessage(status) : t("modelAccess:loading")}</span>
      </div>
      <div className="space-y-1 break-all text-xs text-muted-foreground">
        <p>{executable?.state === "not-needed" ? t("modelAccess:piBundled") : executable?.state === "ready" ? t("modelAccess:found", { path: executable.path ?? "", version: executable.version ?? t("modelAccess:versionUnknown") }) : executable ? t(executable.state === "missing" ? "modelAccess:executableMissing" : executable.state === "incompatible" ? "modelAccess:executableIncompatible" : "modelAccess:executableBroken") : t("modelAccess:loading")}</p>
        {executable?.state !== "ready" && executable?.path ? <p>{executable.path}</p> : null}
        {executable?.source ? <p>{t(`modelAccess:${sourceKeys[executable.source]}`)}</p> : null}
        {executable?.minimumVersion ? <p>{t("modelAccess:minimumVersion", { version: executable.minimumVersion })}</p> : null}
        {executable && !["ready", "not-needed"].includes(executable.state) && engine !== "pi" ? <p className="break-normal">{t(engine === "claude" ? "modelAccess:installClaude" : "modelAccess:installCodex")}</p> : null}
      </div>
      <fieldset disabled={!status || !socket || pending} className="min-w-0 space-y-4">
        {engine !== "pi" ? <div className="space-y-1">
          <label className="block space-y-1.5 text-xs text-muted-foreground"><span>{t("modelAccess:executablePath")}</span><input className={CONNECTION_FIELD_CLASS} placeholder={t("modelAccess:autoDiscover")} value={path ?? setup?.executablePath ?? ""} onChange={e => setPath(e.target.value)} /></label>
          <div className="flex flex-wrap gap-4"><SettingsActionButton onClick={() => setup && setSetup({ ...setup, executablePath: (path ?? setup.executablePath ?? "").trim() || null })}>{t("modelAccess:applyPath")}</SettingsActionButton><SettingsActionButton icon={<RefreshCw />} onClick={() => socket && void command(() => socket.command({ type: "modelAccess.refreshExecutables" }))}>{t("modelAccess:refresh")}</SettingsActionButton></div>
        </div> : null}
        <div className="space-y-2"><p className="text-xs text-muted-foreground">{t("modelAccess:access")}</p>
          {ENGINES_WITH_ACCOUNT_MODE.includes(engine) ? <SegmentedControl size="sm" value={access?.mode ?? "account"} options={[{ value: "account", label: t("modelAccess:account") }, { value: "connection", label: t("modelAccess:connection") }]} onValueChange={mode => {
            if (!setup) return
            if (mode === "account") setSetup({ ...setup, access: { mode: "account" } })
            else chooseConnection(connections.find(c => endpointForEngine(engine, c))?.id ?? "")
          }} /> : <p className="text-sm">{t("modelAccess:connection")}</p>}
        </div>
        {(access?.mode === "connection" || engine === "pi") ? <>
          <label className="block space-y-1.5 text-xs text-muted-foreground"><span>{t("modelAccess:connection")}</span><select aria-label={t("modelAccess:connection")} className={CONNECTION_FIELD_CLASS} value={access?.mode === "connection" ? access.connectionId : ""} onChange={e => chooseConnection(e.target.value)}>
            <option value="" disabled>{t("modelAccess:chooseConnection")}</option>
            {access?.mode === "connection" && access.connectionId && !selectedConnection ? <option value={access.connectionId} disabled>{t("modelAccess:connectionMissing")}</option> : null}
            {connections.map(connection => { const compatible = Boolean(endpointForEngine(engine, connection)); return <option key={connection.id} value={connection.id} disabled={!compatible}>{connection.name}{compatible ? "" : ` — ${incompatibleConnectionMessage(engine)}`}</option> })}
          </select></label>
          <label className="block space-y-1.5 text-xs text-muted-foreground"><span>{t("modelAccess:defaultModel")}</span><select aria-label={t("modelAccess:defaultModel")} className={CONNECTION_FIELD_CLASS} disabled={!selectedConnection || !endpointForEngine(engine, selectedConnection)} value={access?.mode === "connection" ? access.defaultModel ?? "" : ""} onChange={e => setup && access?.mode === "connection" && setSetup({ ...setup, access: { ...access, defaultModel: e.target.value } })}>
            <option value="" disabled>{t("modelAccess:chooseModel")}</option>{selectedConnection?.models.map(model => <option key={model.id} value={model.id}>{model.label ?? model.id}</option>)}
          </select></label>
        </> : null}
      </fieldset>
      {error ? <SettingsNotice>{error}</SettingsNotice> : null}
    </div>
    {children}
  </SettingsGroup></div>
}
