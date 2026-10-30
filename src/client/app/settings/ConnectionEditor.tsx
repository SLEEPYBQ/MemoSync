import { useRef, useState, type ReactNode } from "react"
import { CheckCircle2, CircleAlert, ExternalLink, Eye, EyeOff, Loader2, Plus, Trash2 } from "lucide-react"
import type {
  ApiConnection,
  ApiConnectionInput,
  ApiProtocol,
  ConnectionPreset,
  ConnectionTestResult,
} from "../../../shared/model-access"
import type { AppSocket } from "../socket"
import { t, useI18n } from "../../i18n"
import { connectionTestMessage, validateConnection, validationMessage } from "../../model-access/modelAccess"
import { Button } from "../../components/ui/button"
import { DialogBody, DialogFooter } from "../../components/ui/dialog"
import { SelectItem } from "../../components/ui/select"
import { SettingsBadge, SettingsNotice, SettingsSelect } from "./shared"
import { CONNECTION_FIELD_CLASS, Hint, MODEL_ACCESS_FOCUS_CLASS, protocolLabel } from "./modelAccessUi"

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-xs text-muted-foreground">
      {label}
      {children}
    </label>
  )
}
const protocols: ApiProtocol[] = ["anthropic-messages", "openai-responses", "openai-chat"]
type Validation = ReturnType<typeof validateConnection>

export function ConnectionEditor({
  connection,
  preset,
  initialProtocol,
  socket,
  onClose,
  onSavingChange,
}: {
  connection?: ApiConnection
  preset?: ConnectionPreset
  initialProtocol?: ApiProtocol
  socket: Pick<AppSocket, "command">
  onClose: () => void
  onSavingChange: (saving: boolean) => void
}) {
  useI18n()
  const readOnly = Boolean(connection?.readOnly || connection?.keySource === "env")
  const [input, setInput] = useState<ApiConnectionInput>(() => ({
    id: connection?.id,
    name: connection?.name ?? preset?.name ?? "",
    presetId: connection?.presetId ?? preset?.id,
    endpoints: (
      connection?.endpoints ??
      preset?.endpoints ?? [{ protocol: initialProtocol ?? "openai-chat", baseUrl: "" }]
    ).map((e) => ({ ...e })),
    models: (connection?.models ?? preset?.models ?? [{ id: "" }]).map((m) => ({ ...m })),
  }))
  const [keyEditing, setKeyEditing] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [pending, setPending] = useState<"save" | "test" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [validation, setValidation] = useState<Validation>(null)
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null)
  const revision = useRef(0)
  const busy = useRef(false)
  function patch(value: Partial<ApiConnectionInput>) {
    revision.current += 1
    setInput((current) => ({ ...current, ...value }))
    setTestResult(null)
    setError(null)
    setValidation(null)
  }
  function normalized(): ApiConnectionInput {
    return {
      ...input,
      name: input.name.trim(),
      endpoints: input.endpoints.map((e) => ({ ...e, baseUrl: e.baseUrl.trim().replace(/\/+$/, "") })),
      models: input.models.map((m) => ({ ...m, id: m.id.trim() })),
    }
  }
  async function run(action: "save" | "test") {
    if (busy.current) return
    const value = normalized()
    const invalid = validateConnection(value)
    if (invalid && !readOnly) {
      setValidation(invalid)
      return
    }
    busy.current = true
    setPending(action)
    onSavingChange(action === "save")
    setError(null)
    setValidation(null)
    setTestResult(null)
    const startedAt = revision.current
    try {
      if (action === "save") {
        await socket.command({ type: "modelAccess.saveConnection", connection: value })
        setInput((current) => ({ ...current, apiKey: undefined }))
        onClose()
      } else {
        const result = await socket.command<ConnectionTestResult>({
          type: "modelAccess.testConnection",
          connection: readOnly && connection ? { connectionId: connection.id } : value,
        })
        if (revision.current === startedAt) setTestResult(result)
      }
    } catch (reason) {
      if (revision.current === startedAt)
        setError(reason instanceof Error ? reason.message : t("modelAccess:commandFailed"))
    } finally {
      busy.current = false
      setPending(null)
      onSavingChange(false)
    }
  }
  const hasSavedKey = connection?.keySource === "stored" && input.apiKey === undefined
  const keysUrl = preset?.keysUrl
  const safeKeysUrl = keysUrl && /^https?:\/\//i.test(keysUrl) ? keysUrl : undefined
  function invalidField(codes: NonNullable<Validation>[]) {
    return validation && codes.includes(validation) ? (
      <p data-testid="field-error" className="text-xs text-destructive">
        {validationMessage(validation)}
      </p>
    ) : null
  }
  const patchEndpoint = (index: number, value: Partial<ApiConnectionInput["endpoints"][number]>) =>
    patch({ endpoints: input.endpoints.map((endpoint, i) => (i === index ? { ...endpoint, ...value } : endpoint)) })
  return (
    <form
      aria-label={t("modelAccess:connection")}
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault()
        if (!readOnly) void run("save")
      }}
    >
      <DialogBody className="space-y-5">
        {readOnly ? (
          <SettingsNotice tone="info">
            {t("modelAccess:envReadOnly", { variable: connection?.envKeyName ?? t("modelAccess:envUnknown") })}
          </SettingsNotice>
        ) : null}
        <fieldset disabled={readOnly || pending === "save"} className="min-w-0 space-y-5">
          <div className="space-y-1.5">
            <Field label={t("modelAccess:name")}>
              <input
                className={CONNECTION_FIELD_CLASS}
                value={input.name}
                aria-invalid={validation === "name"}
                onChange={(e) => patch({ name: e.target.value })}
              />
            </Field>
            {invalidField(["name"])}
          </div>
          <section className="space-y-2">
            <h4 className="text-sm font-medium">{t("modelAccess:endpoints")}</h4>
            <div className="space-y-2">
              {input.endpoints.map((endpoint, index) => (
                <div
                  key={index}
                  className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 rounded-lg border border-border px-2 py-1.5 @lg:grid-cols-[115px_minmax(0,1fr)_auto]"
                >
                  <div className="min-w-0 px-1">
                    <SettingsSelect
                      className={`rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${MODEL_ACCESS_FOCUS_CLASS}`}
                      aria-label={`${t("modelAccess:protocol")} ${index + 1}`}
                      value={endpoint.protocol}
                      onValueChange={(protocol) => patchEndpoint(index, { protocol: protocol as ApiProtocol })}
                    >
                      {protocols.map((protocol) => (
                        <SelectItem key={protocol} value={protocol}>
                          {protocolLabel(protocol)}
                        </SelectItem>
                      ))}
                    </SettingsSelect>
                  </div>
                  <input
                    aria-label={t("modelAccess:baseUrl")}
                    type="text"
                    inputMode="url"
                    placeholder="https://api.example.com/v1"
                    className={`${CONNECTION_FIELD_CLASS} col-[1] row-[2] @lg:col-[2] @lg:row-[1]`}
                    value={endpoint.baseUrl}
                    aria-invalid={validation === "url"}
                    onChange={(e) => patchEndpoint(index, { baseUrl: e.target.value })}
                  />
                  <Hint text={t("modelAccess:removeEndpoint", { index: index + 1 })}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="col-[2] row-[1/3] hover:text-destructive @lg:col-[3] @lg:row-[1]"
                      aria-label={t("modelAccess:removeEndpoint", { index: index + 1 })}
                      onClick={() => patch({ endpoints: input.endpoints.filter((_, i) => i !== index) })}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </Hint>
                </div>
              ))}
            </div>
            {invalidField(["endpoints", "url", "duplicateProtocol"])}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() =>
                patch({
                  endpoints: [
                    ...input.endpoints,
                    {
                      protocol: protocols.find((p) => !input.endpoints.some((e) => e.protocol === p)) ?? "openai-chat",
                      baseUrl: "",
                    },
                  ],
                })
              }
            >
              <Plus className="size-3.5" />
              {t("modelAccess:addEndpoint")}
            </Button>
            {input.endpoints.some((endpoint) => endpoint.protocol === "anthropic-messages") ? (
              <details className="rounded-lg bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                <summary className={`cursor-pointer rounded-sm ${MODEL_ACCESS_FOCUS_CLASS}`}>
                  {t("modelAccess:advanced")}
                </summary>
                <div className="mt-2 space-y-2">
                  {input.endpoints.map((endpoint, index) =>
                    endpoint.protocol === "anthropic-messages" ? (
                      <div className="flex flex-wrap items-center justify-between gap-2" key={index}>
                        <span>{t("modelAccess:authHeader")}</span>
                        <SettingsSelect
                          className={`rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${MODEL_ACCESS_FOCUS_CLASS}`}
                          aria-label={t("modelAccess:authHeader")}
                          value={endpoint.authHeader ?? "bearer"}
                          onValueChange={(authHeader) =>
                            patchEndpoint(index, { authHeader: authHeader as "bearer" | "x-api-key" })
                          }
                        >
                          <SelectItem value="bearer">Authorization: Bearer</SelectItem>
                          <SelectItem value="x-api-key">x-api-key</SelectItem>
                        </SettingsSelect>
                      </div>
                    ) : null,
                  )}
                </div>
              </details>
            ) : null}
          </section>
          <section className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-sm font-medium">{t("modelAccess:apiKey")}</h4>
              {safeKeysUrl ? (
                <a
                  href={safeKeysUrl}
                  target="_blank"
                  rel="noreferrer"
                  className={`inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground ${MODEL_ACCESS_FOCUS_CLASS}`}
                >
                  {t("modelAccess:keysPage")}
                  <ExternalLink className="size-3" />
                </a>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {hasSavedKey ? (
                <>
                  <SettingsBadge>{t("modelAccess:saved")}</SettingsBadge>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => {
                      setKeyEditing(true)
                      setShowKey(false)
                    }}
                  >
                    {t("modelAccess:replace")}
                  </Button>
                </>
              ) : input.apiKey === null ? (
                <>
                  <span className="text-xs text-muted-foreground">{t("modelAccess:keyRemoved")}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => {
                      patch({ apiKey: undefined })
                      setKeyEditing(true)
                      setShowKey(false)
                    }}
                  >
                    {t("modelAccess:replace")}
                  </Button>
                </>
              ) : null}
              {(hasSavedKey || keyEditing || typeof input.apiKey === "string") && !readOnly ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="text-destructive hover:text-destructive"
                  onClick={() => {
                    patch({ apiKey: null })
                    setKeyEditing(false)
                    setShowKey(false)
                  }}
                >
                  {t("modelAccess:removeKey")}
                </Button>
              ) : null}
            </div>
            {!readOnly && (keyEditing || !hasSavedKey) && input.apiKey !== null ? (
              <div className="relative">
                <input
                  aria-label={t("modelAccess:apiKey")}
                  type={showKey ? "text" : "password"}
                  autoComplete="new-password"
                  spellCheck={false}
                  className={`${CONNECTION_FIELD_CLASS} pr-11`}
                  value={input.apiKey ?? ""}
                  onChange={(e) => patch({ apiKey: e.target.value || undefined })}
                />
                <Hint text={t(showKey ? "modelAccess:hideKey" : "modelAccess:showKey")}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-0 top-0"
                    aria-label={t(showKey ? "modelAccess:hideKey" : "modelAccess:showKey")}
                    onClick={() => setShowKey(!showKey)}
                  >
                    {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </Button>
                </Hint>
              </div>
            ) : null}
            <p className="text-xs leading-5 text-muted-foreground">
              {t("modelAccess:keyWriteOnly")} {preset?.noKey ? t("modelAccess:optionalKey") : null}
            </p>
          </section>
          <section className="space-y-2">
            <h4 className="text-sm font-medium">{t("modelAccess:models")}</h4>
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full table-fixed text-left text-xs">
                <thead className="bg-muted/40 text-muted-foreground">
                  <tr>
                    <th className="w-[55%] px-2 py-2 font-normal">{t("modelAccess:modelId")}</th>
                    <th className="px-2 py-2 font-normal">{t("modelAccess:contextWindowShort")}</th>
                    <th className="w-10">
                      <span className="sr-only">{t("modelAccess:delete")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {input.models.map((model, index) => (
                    <tr key={index}>
                      <td className="p-1.5">
                        <input
                          aria-label={t("modelAccess:modelId")}
                          className={CONNECTION_FIELD_CLASS}
                          value={model.id}
                          aria-invalid={validation === "models" || validation === "duplicateModel"}
                          onChange={(e) =>
                            patch({
                              models: input.models.map((v, i) => (i === index ? { ...v, id: e.target.value } : v)),
                            })
                          }
                        />
                      </td>
                      <td className="py-1.5">
                        <input
                          aria-label={t("modelAccess:contextWindow")}
                          type="number"
                          min="1"
                          step="1"
                          placeholder="—"
                          className={CONNECTION_FIELD_CLASS}
                          value={model.contextWindow === undefined ? "" : String(model.contextWindow)}
                          aria-invalid={validation === "context"}
                          onChange={(e) =>
                            patch({
                              models: input.models.map((v, i) =>
                                i === index
                                  ? { ...v, contextWindow: e.target.value ? Number(e.target.value) : undefined }
                                  : v,
                              ),
                            })
                          }
                        />
                      </td>
                      <td>
                        <Hint text={t("modelAccess:removeModel", { index: index + 1 })}>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="hover:text-destructive"
                            aria-label={t("modelAccess:removeModel", { index: index + 1 })}
                            onClick={() => patch({ models: input.models.filter((_, i) => i !== index) })}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </Hint>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {invalidField(["models", "duplicateModel", "context"])}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => patch({ models: [...input.models, { id: "" }] })}
            >
              <Plus className="size-3.5" />
              {t("modelAccess:addModel")}
            </Button>
          </section>
        </fieldset>
      </DialogBody>
      <div className={error || testResult ? "max-h-40 shrink-0 overflow-y-auto px-4 pb-3" : "hidden"}>
        {error ? <SettingsNotice>{error}</SettingsNotice> : null}
        {testResult ? (
          <div role="status" data-testid="connection-test-result">
            <SettingsNotice tone={testResult.ok ? "success" : "error"}>
              <div className="flex items-center gap-2">
                {testResult.ok ? (
                  <CheckCircle2 className="size-4 shrink-0" />
                ) : (
                  <CircleAlert className="size-4 shrink-0" />
                )}
                <p>
                  {!testResult.ok ? `${protocolLabel(testResult.protocol)}: ` : ""}
                  {connectionTestMessage(testResult)}
                </p>
              </div>
              {!testResult.ok && testResult.message ? (
                <details className="mt-2 text-xs">
                  <summary className={`cursor-pointer rounded-sm ${MODEL_ACCESS_FOCUS_CLASS}`}>
                    {t("modelAccess:rawDetail")}
                  </summary>
                  <p className="mt-2 whitespace-pre-wrap break-all text-muted-foreground">{testResult.message}</p>
                </details>
              ) : null}
            </SettingsNotice>
          </div>
        ) : null}
      </div>
      <DialogFooter className="items-center px-4 py-3">
        <div className="mr-auto">
          <Button type="button" variant="outline" size="sm" disabled={!!pending} onClick={() => void run("test")}>
            {pending === "test" ? <Loader2 className="size-4 animate-spin" /> : null}
            {t(pending === "test" ? "modelAccess:testing" : "modelAccess:test")}
          </Button>
        </div>
        <Button type="button" variant="ghost" size="sm" disabled={pending === "save"} onClick={onClose}>
          {t("modelAccess:cancel")}
        </Button>
        {!readOnly ? (
          <Button type="submit" size="sm" disabled={!!pending}>
            {pending === "save" ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("modelAccess:save")}
          </Button>
        ) : null}
      </DialogFooter>
      <p className="px-4 pb-3 text-[11px] text-muted-foreground">{t("modelAccess:testHint")}</p>
    </form>
  )
}
