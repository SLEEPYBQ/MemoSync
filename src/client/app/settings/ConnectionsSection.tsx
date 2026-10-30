import { useState } from "react"
import { Plus, Search, Plug } from "lucide-react"
import type { ApiConnection, ConnectionPreset } from "../../../shared/model-access"
import type { AppSocket } from "../socket"
import { t, useI18n } from "../../i18n"
import { ConnectionEditor, CONNECTION_FIELD_CLASS } from "./ConnectionEditor"
import { SettingsActionButton, SettingsGroup, SettingsNotice, SettingsRow } from "./shared"
import { SETTINGS_ROWS } from "./registry"

export function ConnectionsSection({ connections, presets, socket }: { connections: ApiConnection[]; presets: ConnectionPreset[]; socket?: Pick<AppSocket, "command"> }) {
  useI18n()
  const [editor, setEditor] = useState<{ connection?: ApiConnection; preset?: ConnectionPreset } | null>(null)
  const [picking, setPicking] = useState(false)
  const [query, setQuery] = useState("")
  const [deleting, setDeleting] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function remove(connection: ApiConnection) {
    if (!socket || pending) return
    setPending(true); setError(null)
    try { await socket.command({ type: "modelAccess.deleteConnection", connectionId: connection.id }); setDeleting(null); if (editor?.connection?.id === connection.id) setEditor(null) }
    catch (reason) { setError(reason instanceof Error ? reason.message : t("modelAccess:commandFailed")) }
    finally { setPending(false) }
  }
  const matching = presets.filter(preset => `${preset.name} ${preset.id} ${preset.models.map(m => m.id).join(" ")}`.toLowerCase().includes(query.trim().toLowerCase()))
  return <SettingsGroup title={t("modelAccess:connections")}>
    <SettingsRow def={SETTINGS_ROWS.apiConnections} wideControl><SettingsActionButton disabled={!socket} icon={<Plus />} onClick={() => { setPicking(true); setEditor(null); setQuery("") }}>{t("modelAccess:addConnection")}</SettingsActionButton></SettingsRow>
    {!connections.length ? <p className="p-4 text-sm text-muted-foreground">{t("modelAccess:emptyConnections")}</p> : null}
    {connections.map(connection => <div key={connection.id} className="p-4">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1"><p className="flex items-center gap-2 break-all text-sm font-medium"><Plug className="size-4 shrink-0" />{connection.name}</p><p className="break-words text-xs text-muted-foreground">{(connection.readOnly || connection.keySource === "env") ? t("modelAccess:envReadOnly", { variable: connection.envKeyName ?? t("modelAccess:envUnknown") }) : t(connection.keySource === "stored" ? "modelAccess:saved" : "modelAccess:noKey")}</p><p className="break-all text-xs text-muted-foreground">{connection.endpoints.map(e => e.baseUrl).join(" · ")}</p></div>
        <div className="flex gap-3"><SettingsActionButton disabled={!socket || pending} onClick={() => { setEditor({ connection, preset: presets.find(p => p.id === connection.presetId) }); setPicking(false) }}>{(connection.readOnly || connection.keySource === "env") ? t("modelAccess:test") : t("modelAccess:edit")}</SettingsActionButton>{!(connection.readOnly || connection.keySource === "env") ? <SettingsActionButton disabled={!socket || pending} onClick={() => setDeleting(connection.id)}>{t("modelAccess:delete")}</SettingsActionButton> : null}</div>
      </div>
      {deleting === connection.id ? <div className="mt-3 space-y-2 rounded-lg border border-border p-3"><p className="text-sm">{t("modelAccess:confirmDelete", { name: connection.name })}</p><div className="flex gap-4"><SettingsActionButton disabled={pending} onClick={() => void remove(connection)}>{t("modelAccess:confirmDeleteAction")}</SettingsActionButton><SettingsActionButton disabled={pending} onClick={() => setDeleting(null)}>{t("modelAccess:cancel")}</SettingsActionButton></div></div> : null}
    </div>)}
    {picking ? <div className="space-y-4 p-4" data-testid="preset-picker">
      <label className="flex items-center gap-2"><Search className="size-4 text-muted-foreground" /><input aria-label={t("modelAccess:searchPresets")} className={CONNECTION_FIELD_CLASS} value={query} onChange={e => setQuery(e.target.value)} /></label>
      {(["vendor", "relay", "local"] as const).map(kind => { const group = matching.filter(p => p.kind === kind); return group.length ? <div key={kind}><h4 className="text-xs text-muted-foreground">{t(`modelAccess:${kind}`)}</h4><div className="flex flex-wrap gap-x-5 gap-y-1">{group.map(preset => <SettingsActionButton key={preset.id} onClick={() => { setEditor({ preset }); setPicking(false) }}>{preset.name}</SettingsActionButton>)}</div></div> : null })}
      {!matching.length ? <p className="text-sm text-muted-foreground">{t("modelAccess:noPresets")}</p> : null}
      <div className="flex flex-wrap gap-4"><SettingsActionButton onClick={() => { setEditor({}); setPicking(false) }}>{t("modelAccess:customConnection")}</SettingsActionButton><SettingsActionButton onClick={() => setPicking(false)}>{t("modelAccess:cancel")}</SettingsActionButton></div>
    </div> : null}
    {editor && socket ? <ConnectionEditor key={editor.connection?.id ?? editor.preset?.id ?? "custom"} {...editor} socket={socket} onClose={() => setEditor(null)} /> : null}
    {error ? <div className="p-4"><SettingsNotice>{error}</SettingsNotice></div> : null}
  </SettingsGroup>
}
