import { useRef, useState, type ReactNode } from "react"
import { ExternalLink, Loader2, Plus, Trash2 } from "lucide-react"
import type { ApiConnection, ApiConnectionInput, ApiProtocol, ConnectionPreset, ConnectionTestResult } from "../../../shared/model-access"
import type { AppSocket } from "../socket"
import { t, useI18n } from "../../i18n"
import { connectionTestMessage, validateConnection, validationMessage } from "../../model-access/modelAccess"
import { SettingsActionButton, SettingsNotice } from "./shared"

export const CONNECTION_FIELD_CLASS = "min-w-0 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="flex min-w-0 flex-col gap-1.5 text-xs text-muted-foreground">{label}{children}</label>
}
const protocols: ApiProtocol[] = ["anthropic-messages", "openai-responses", "openai-chat"]

export function ConnectionEditor({ connection, preset, socket, onClose }: {
  connection?: ApiConnection
  preset?: ConnectionPreset
  socket: Pick<AppSocket, "command">
  onClose: () => void
}) {
  useI18n()
  const readOnly = Boolean(connection?.readOnly || connection?.keySource === "env")
  const [input, setInput] = useState<ApiConnectionInput>(() => ({
    id: connection?.id, name: connection?.name ?? preset?.name ?? "", presetId: connection?.presetId ?? preset?.id,
    endpoints: (connection?.endpoints ?? preset?.endpoints ?? [{ protocol: "openai-chat", baseUrl: "" }]).map(e => ({ ...e })),
    models: (connection?.models ?? preset?.models ?? [{ id: "" }]).map(m => ({ ...m })),
  }))
  const [keyEditing, setKeyEditing] = useState(false)
  const [pending, setPending] = useState<"save" | "test" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null)
  const revision = useRef(0)
  const busy = useRef(false)
  function patch(value: Partial<ApiConnectionInput>) {
    revision.current += 1
    setInput(current => ({ ...current, ...value }))
    setTestResult(null)
    setError(null)
  }
  function normalized(): ApiConnectionInput {
    return { ...input, name: input.name.trim(), endpoints: input.endpoints.map(e => ({ ...e, baseUrl: e.baseUrl.trim().replace(/\/+$/, "") })), models: input.models.map(m => ({ ...m, id: m.id.trim() })) }
  }
  async function run(action: "save" | "test") {
    if (busy.current) return
    const value = normalized()
    const invalid = validateConnection(value)
    if (invalid && !readOnly) { setError(validationMessage(invalid)); return }
    busy.current = true
    setPending(action)
    setError(null)
    setTestResult(null)
    const startedAt = revision.current
    try {
      if (action === "save") {
        await socket.command({ type: "modelAccess.saveConnection", connection: value })
        setInput(current => ({ ...current, apiKey: undefined }))
        onClose()
      } else {
        const result = await socket.command<ConnectionTestResult>({ type: "modelAccess.testConnection", connection: readOnly && connection ? { connectionId: connection.id } : value })
        if (revision.current === startedAt) setTestResult(result)
      }
    } catch (reason) {
      if (revision.current === startedAt) setError(reason instanceof Error ? reason.message : t("modelAccess:commandFailed"))
    } finally { busy.current = false; setPending(null) }
  }
  const hasSavedKey = connection?.keySource === "stored" && input.apiKey === undefined
  const keysUrl = preset?.keysUrl
  const safeKeysUrl = keysUrl && /^https?:\/\//i.test(keysUrl) ? keysUrl : undefined
  return <form aria-label={t("modelAccess:connection")} className="space-y-5 p-4" onSubmit={event => { event.preventDefault(); if (!readOnly) void run("save") }}>
    {readOnly ? <p className="break-words text-sm text-muted-foreground">{t("modelAccess:envReadOnly", { variable: connection?.envKeyName ?? t("modelAccess:envUnknown") })}</p> : null}
    <fieldset disabled={readOnly || pending === "save"} className="min-w-0 space-y-5">
      <Field label={t("modelAccess:name")}><input className={CONNECTION_FIELD_CLASS} value={input.name} onChange={e => patch({ name: e.target.value })} /></Field>
      <div className="space-y-3">
        <h4 className="text-sm font-medium">{t("modelAccess:endpoints")}</h4>
        {input.endpoints.map((endpoint, index) => <div key={index} className="grid min-w-0 gap-3 rounded-lg border border-border p-3">
          <div className="flex min-w-0 items-end gap-2">
            <div className="min-w-0 flex-1"><Field label={t("modelAccess:protocol")}><select className={CONNECTION_FIELD_CLASS} value={endpoint.protocol} onChange={e => patch({ endpoints: input.endpoints.map((v, i) => i === index ? { ...v, protocol: e.target.value as ApiProtocol } : v) })}>
              {protocols.map(protocol => <option key={protocol} value={protocol}>{t(`modelAccess:${protocol}`)}</option>)}
            </select></Field></div>
            <SettingsActionButton aria-label={t("modelAccess:removeEndpoint", { index: index + 1 })} onClick={() => patch({ endpoints: input.endpoints.filter((_, i) => i !== index) })} icon={<Trash2 />} />
          </div>
          <Field label={t("modelAccess:baseUrl")}><input type="text" inputMode="url" className={CONNECTION_FIELD_CLASS} value={endpoint.baseUrl} onChange={e => patch({ endpoints: input.endpoints.map((v, i) => i === index ? { ...v, baseUrl: e.target.value } : v) })} /></Field>
          {endpoint.protocol === "anthropic-messages" ? <Field label={t("modelAccess:authHeader")}><select className={CONNECTION_FIELD_CLASS} value={endpoint.authHeader ?? "bearer"} onChange={e => patch({ endpoints: input.endpoints.map((v, i) => i === index ? { ...v, authHeader: e.target.value as "bearer" | "x-api-key" } : v) })}>
            <option value="bearer">Authorization: Bearer</option><option value="x-api-key">x-api-key</option>
          </select></Field> : null}
        </div>)}
        <SettingsActionButton icon={<Plus />} onClick={() => patch({ endpoints: [...input.endpoints, { protocol: protocols.find(p => !input.endpoints.some(e => e.protocol === p)) ?? "openai-chat", baseUrl: "" }] })}>{t("modelAccess:addEndpoint")}</SettingsActionButton>
      </div>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3"><h4 className="text-sm font-medium">{t("modelAccess:apiKey")}</h4>
          {hasSavedKey ? <><span className="text-xs text-muted-foreground">{t("modelAccess:saved")}</span><SettingsActionButton onClick={() => setKeyEditing(true)}>{t("modelAccess:replace")}</SettingsActionButton></> : <><span className="text-xs text-muted-foreground">{t(input.apiKey === null ? "modelAccess:keyRemoved" : "modelAccess:noKey")}</span>{input.apiKey === null ? <SettingsActionButton onClick={() => { patch({ apiKey: undefined }); setKeyEditing(true) }}>{t("modelAccess:replace")}</SettingsActionButton> : null}</>}
          {(hasSavedKey || keyEditing || typeof input.apiKey === "string") && !readOnly ? <SettingsActionButton onClick={() => { patch({ apiKey: null }); setKeyEditing(false) }}>{t("modelAccess:removeKey")}</SettingsActionButton> : null}
        </div>
        {!readOnly && (keyEditing || !hasSavedKey) && input.apiKey !== null ? <Field label={t("modelAccess:apiKey")}><input type="password" autoComplete="new-password" spellCheck={false} className={CONNECTION_FIELD_CLASS} value={input.apiKey ?? ""} onChange={e => patch({ apiKey: e.target.value || undefined })} /></Field> : null}
        <p className="text-xs text-muted-foreground">{t("modelAccess:keyWriteOnly")} {preset?.noKey ? t("modelAccess:optionalKey") : null}</p>
        {safeKeysUrl ? <a href={safeKeysUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs underline underline-offset-4">{t("modelAccess:keysPage")}<ExternalLink className="size-3" /></a> : null}
      </div>
      <div className="space-y-3">
        <h4 className="text-sm font-medium">{t("modelAccess:models")}</h4>
        {input.models.map((model, index) => <div key={index} className="flex min-w-0 items-end gap-2">
          <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2">
            <Field label={t("modelAccess:modelId")}><input className={CONNECTION_FIELD_CLASS} value={model.id} onChange={e => patch({ models: input.models.map((v, i) => i === index ? { ...v, id: e.target.value } : v) })} /></Field>
            <Field label={t("modelAccess:contextWindow")}><input type="number" min="1" step="1" className={CONNECTION_FIELD_CLASS} value={model.contextWindow === undefined ? "" : String(model.contextWindow)} onChange={e => patch({ models: input.models.map((v, i) => i === index ? { ...v, contextWindow: e.target.value ? Number(e.target.value) : undefined } : v) })} /></Field>
          </div>
          <SettingsActionButton aria-label={t("modelAccess:removeModel", { index: index + 1 })} icon={<Trash2 />} onClick={() => patch({ models: input.models.filter((_, i) => i !== index) })} />
        </div>)}
        <SettingsActionButton icon={<Plus />} onClick={() => patch({ models: [...input.models, { id: "" }] })}>{t("modelAccess:addModel")}</SettingsActionButton>
      </div>
    </fieldset>
    {error ? <SettingsNotice>{error}</SettingsNotice> : null}
    {testResult ? <div role="status" data-testid="connection-test-result" className="space-y-1 break-words text-sm"><p>{connectionTestMessage(testResult)}</p>{testResult.message ? <p className="text-xs text-muted-foreground">{testResult.message}</p> : null}</div> : null}
    <div className="flex flex-wrap items-center gap-4">
      {!readOnly ? <SettingsActionButton type="submit" disabled={!!pending} prominent icon={pending === "save" ? <Loader2 className="animate-spin" /> : undefined}>{t("modelAccess:save")}</SettingsActionButton> : null}
      <SettingsActionButton disabled={!!pending} icon={pending === "test" ? <Loader2 className="animate-spin" /> : undefined} onClick={() => void run("test")}>{t(pending === "test" ? "modelAccess:testing" : "modelAccess:test")}</SettingsActionButton>
      <SettingsActionButton disabled={pending === "save"} onClick={onClose}>{t("modelAccess:cancel")}</SettingsActionButton>
    </div>
    <p className="text-xs text-muted-foreground">{t("modelAccess:testHint")}</p>
  </form>
}
