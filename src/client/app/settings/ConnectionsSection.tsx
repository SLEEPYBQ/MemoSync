import { useState } from "react"
import { ArrowLeft, CheckCircle2, LockKeyhole, Pencil, Plus, Search, Trash2 } from "lucide-react"
import type { ApiConnection, ApiProtocol, ConnectionPreset } from "../../../shared/model-access"
import type { AppSocket } from "../socket"
import { t, useI18n } from "../../i18n"
import { Button } from "../../components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from "../../components/ui/dialog"
import { ConnectionEditor } from "./ConnectionEditor"
import {
  CONNECTION_FIELD_CLASS,
  Hint,
  MODEL_ACCESS_DIALOG_CLASS,
  MODEL_ACCESS_FOCUS_CLASS,
  protocolLabel,
} from "./modelAccessUi"
import { SettingsActionButton, SettingsBadge, SettingsGroup, SettingsNotice } from "./shared"
import { BrandTile, brandForConnection } from "../../components/brand/BrandIcon"

export function ConnectionDialog({
  connection,
  presets,
  initialProtocol,
  socket,
  onClose,
}: {
  connection?: ApiConnection
  presets: ConnectionPreset[]
  initialProtocol?: ApiProtocol
  socket: Pick<AppSocket, "command">
  onClose: () => void
}) {
  useI18n()
  const [editor, setEditor] = useState<{ preset?: ConnectionPreset } | null>(
    connection ? { preset: presets.find((p) => p.id === connection.presetId) } : null,
  )
  const [query, setQuery] = useState("")
  const [saving, setSaving] = useState(false)
  const matching = presets.filter(
    (preset) =>
      (!initialProtocol || preset.endpoints.some((e) => e.protocol === initialProtocol)) &&
      `${preset.name} ${preset.id} ${preset.models.map((m) => m.id).join(" ")}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  )
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose()
      }}
    >
      <DialogContent
        className={MODEL_ACCESS_DIALOG_CLASS}
        size="lg"
        onEscapeKeyDown={(event) => {
          if (saving) event.preventDefault()
        }}
        onPointerDownOutside={(event) => {
          if (saving) event.preventDefault()
        }}
      >
        <DialogHeader className="gap-1 pr-12">
          <div className="flex items-center gap-2">
            {editor && !connection ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("modelAccess:backToProviders")}
                disabled={saving}
                onClick={() => setEditor(null)}
              >
                <ArrowLeft className="size-4" />
              </Button>
            ) : null}
            <DialogTitle>{t(connection ? "modelAccess:editConnection" : "modelAccess:addConnection")}</DialogTitle>
          </div>
          <DialogDescription>
            {editor
              ? t("modelAccess:configureDescription")
              : initialProtocol
                ? t("modelAccess:chooseProtocolDescription", { protocol: protocolLabel(initialProtocol) })
                : t("modelAccess:chooseDescription")}
          </DialogDescription>
        </DialogHeader>
        {editor ? (
          <ConnectionEditor
            key={connection?.id ?? editor.preset?.id ?? "custom"}
            connection={connection}
            preset={editor.preset}
            initialProtocol={initialProtocol}
            socket={socket}
            onClose={onClose}
            onSavingChange={setSaving}
          />
        ) : (
          <>
            <DialogBody className="space-y-5" data-testid="preset-picker">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
                <input
                  aria-label={t("modelAccess:searchPresets")}
                  placeholder={t("modelAccess:searchPresets")}
                  className={`${CONNECTION_FIELD_CLASS} pl-9`}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              {(["vendor", "relay", "local"] as const).map((kind) => {
                const group = matching.filter((p) => p.kind === kind)
                return group.length ? (
                  <section key={kind} className="space-y-2">
                    <h4 className="text-xs font-medium text-muted-foreground">{t(`modelAccess:${kind}`)}</h4>
                    <div className="grid gap-2 @lg:grid-cols-2">
                      {group.map((preset) => (
                        <button
                          type="button"
                          className={`flex min-w-0 items-start gap-3 rounded-xl border border-border/70 bg-muted/40 p-3 text-left transition-colors hover:border-border hover:bg-black/[0.03] dark:bg-card dark:hover:bg-white/[0.04] ${MODEL_ACCESS_FOCUS_CLASS}`}
                          key={preset.id}
                          aria-label={preset.name}
                          onClick={() => setEditor({ preset })}
                        >
                          <BrandTile brand={brandForConnection(preset)} />
                          <span className="min-w-0 flex-1">
                          <span className="flex items-center justify-between gap-2">
                            <span className="truncate text-[13.5px] font-medium">{preset.name}</span>
                          </span>
                          <span className="mt-1.5 flex flex-wrap gap-1">
                            {preset.endpoints.map((endpoint) => (
                              <SettingsBadge key={endpoint.protocol}>{protocolLabel(endpoint.protocol)}</SettingsBadge>
                            ))}
                          </span>
                          {preset.noKey ? (
                            <span className="block truncate text-xs text-muted-foreground">{t("modelAccess:localPresetNote")}</span>
                          ) : null}
                          </span>
                        </button>
                      ))}
                    </div>
                  </section>
                ) : null
              })}
              {!matching.length ? <p className="text-sm text-muted-foreground">{t("modelAccess:noPresets")}</p> : null}
              <button
                type="button"
                className={`flex w-full items-center gap-3 rounded-xl border border-dashed border-border p-3 text-left transition-colors hover:bg-accent ${MODEL_ACCESS_FOCUS_CLASS}`}
                onClick={() => setEditor({})}
              >
                <Plus className="size-5 text-muted-foreground" />
                <span>
                  <span className="block text-sm font-medium">{t("modelAccess:customConnection")}</span>
                  <span className="text-xs text-muted-foreground">{t("modelAccess:customPresetNote")}</span>
                </span>
              </button>
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="ghost" size="sm" onClick={onClose}>
                {t("modelAccess:cancel")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
function endpointHost(baseUrl: string) {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}
export function ConnectionsSection({
  connections,
  presets,
  socket,
  onAddConnection,
}: {
  connections: ApiConnection[]
  presets: ConnectionPreset[]
  socket?: Pick<AppSocket, "command">
  onAddConnection: () => void
}) {
  useI18n()
  const [editing, setEditing] = useState<ApiConnection | null>(null)
  const [deleting, setDeleting] = useState<ApiConnection | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function remove(connection: ApiConnection) {
    if (!socket || pending) return
    setPending(true)
    setError(null)
    try {
      await socket.command({ type: "modelAccess.deleteConnection", connectionId: connection.id })
      setDeleting(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("modelAccess:commandFailed"))
    } finally {
      setPending(false)
    }
  }
  return (
    <>
      <SettingsGroup
        title={t("modelAccess:connections")}
        trailing={
          <SettingsActionButton disabled={!socket} onClick={onAddConnection} icon={<Plus />}>
            {t("modelAccess:addConnection")}
          </SettingsActionButton>
        }
      >
        {!connections.length ? (
          <p className="px-4 py-5 text-[13px] text-muted-foreground">{t("modelAccess:emptyConnections")}</p>
        ) : null}
        {connections.map((connection) => {
          const locked = connection.readOnly || connection.keySource === "env"
          return (
            <div key={connection.id} data-connection={connection.id} className="group/connection flex min-h-[60px] min-w-0 items-center gap-3 px-4 py-3">
              <BrandTile brand={brandForConnection(connection)} />
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <p className="break-words text-[13.5px] font-medium leading-5">{connection.name}</p>
                  {connection.endpoints.map((e) => (
                    <SettingsBadge key={e.protocol}>{protocolLabel(e.protocol)}</SettingsBadge>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span
                    className="min-w-0 truncate text-[12.5px] text-muted-foreground"
                    title={connection.endpoints.map((e) => e.baseUrl).join(" · ")}
                  >
                    {[...new Set(connection.endpoints.map((e) => endpointHost(e.baseUrl)))].join(" · ")}
                  </span>
                  <SettingsBadge
                    className={
                      connection.keySource === "stored"
                        ? "gap-1 bg-success/10 text-success-foreground dark:bg-success/15"
                        : "max-w-full"
                    }
                  >
                    {connection.keySource === "stored" ? <CheckCircle2 className="size-3" /> : null}
                    <span className="truncate">
                      {locked
                        ? t("modelAccess:fromEnv", { variable: connection.envKeyName ?? t("modelAccess:envUnknown") })
                        : t(connection.keySource === "stored" ? "modelAccess:saved" : "modelAccess:noKey")}
                    </span>
                  </SettingsBadge>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                {locked ? (
                  <Hint
                    text={t("modelAccess:envReadOnly", {
                      variable: connection.envKeyName ?? t("modelAccess:envUnknown"),
                    })}
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={t("modelAccess:lockedConnection")}
                      disabled={!socket}
                      onClick={() => setEditing(connection)}
                    >
                      <LockKeyhole className="size-4" />
                    </Button>
                  </Hint>
                ) : (
                  <>
                    <Hint text={t("modelAccess:edit")}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={t("modelAccess:edit")}
                        disabled={!socket || pending}
                        onClick={() => setEditing(connection)}
                      >
                        <Pencil className="size-4" />
                      </Button>
                    </Hint>
                    <Hint text={t("modelAccess:delete")}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="hover:text-destructive"
                        aria-label={t("modelAccess:delete")}
                        disabled={!socket || pending}
                        onClick={() => {
                          setError(null)
                          setDeleting(connection)
                        }}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </Hint>
                  </>
                )}
              </div>
            </div>
          )
        })}
      </SettingsGroup>
      {editing && socket ? (
        <ConnectionDialog connection={editing} presets={presets} socket={socket} onClose={() => setEditing(null)} />
      ) : null}
      <Dialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open && !pending) setDeleting(null)
        }}
      >
        <DialogContent className="model-access-ui w-[calc(100%-2rem)]" size="md">
          <DialogHeader className="pr-10">
            <DialogTitle>{t("modelAccess:confirmDeleteAction")}</DialogTitle>
            <DialogDescription>{t("modelAccess:confirmDelete", { name: deleting?.name ?? "" })}</DialogDescription>
          </DialogHeader>
          {error ? (
            <DialogBody>
              <SettingsNotice>{error}</SettingsNotice>
            </DialogBody>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => setDeleting(null)}>
              {t("modelAccess:cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="text-white"
              size="sm"
              disabled={pending}
              onClick={() => deleting && void remove(deleting)}
            >
              {t("modelAccess:confirmDeleteAction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
