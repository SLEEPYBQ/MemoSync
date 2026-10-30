import { useState, type ReactNode } from "react"
import { Check, Copy, MoreHorizontal, RefreshCw, Terminal } from "lucide-react"
import {
  ENGINE_PROTOCOLS,
  ENGINES_WITH_ACCOUNT_MODE,
  compatibleEndpointForEngine,
  type ApiConnection,
  type ApiProtocol,
  type EngineId,
  type EngineSetup,
  type EngineStatus,
} from "../../../shared/model-access"
import type { AppSocket } from "../socket"
import { t, useI18n } from "../../i18n"
import { engineProblemMessage, incompatibleConnectionMessage } from "../../model-access/modelAccess"
import { SegmentedControl } from "../../components/ui/segmented-control"
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
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover"
import { SelectItem } from "../../components/ui/select"
import {
  SettingsActionButton,
  SettingsBadge,
  SettingsGroup,
  SettingsNotice,
  SettingsRow,
  SettingsSelect,
} from "./shared"
import { CONNECTION_FIELD_CLASS, Hint, MODEL_ACCESS_FOCUS_CLASS } from "./modelAccessUi"

const ENGINE_NAMES = { claude: "Claude Code", codex: "Codex", pi: "Pi" }
export function EngineCard({
  engine,
  status,
  connections,
  socket,
  onAddConnection,
  children,
}: {
  engine: EngineId
  status?: EngineStatus
  connections: ApiConnection[]
  socket?: Pick<AppSocket, "command">
  onAddConnection: (protocol: ApiProtocol) => void
  children: ReactNode
}) {
  useI18n()
  const [path, setPath] = useState("")
  const [pathOpen, setPathOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const setup = status?.setup
  const access = setup?.access
  const executable = status?.executable
  const selectedConnection =
    access?.mode === "connection" ? connections.find((c) => c.id === access.connectionId) : undefined
  async function command(action: () => Promise<unknown>, onSuccess?: () => void) {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      await action()
      onSuccess?.()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("modelAccess:commandFailed"))
    } finally {
      setPending(false)
    }
  }
  function setSetup(next: EngineSetup) {
    if (socket) void command(() => socket.command({ type: "modelAccess.setEngine", engine, setup: next }))
  }
  function chooseConnection(connectionId: string) {
    if (connectionId === "__add__") {
      onAddConnection(ENGINE_PROTOCOLS[engine][0])
      return
    }
    const connection = connections.find((c) => c.id === connectionId)
    if (setup)
      setSetup({ ...setup, access: { mode: "connection", connectionId, defaultModel: connection?.models[0]?.id } })
  }
  const sourceKeys = {
    configured: "sourceConfigured",
    path: "sourcePath",
    "known-dir": "sourceKnown",
    bundled: "sourceBundled",
  } as const
  const badgeKey = !status
    ? "loadingShort"
    : status.ready
      ? "ready"
      : executable?.state === "missing"
        ? "notFoundStatus"
        : executable?.state === "incompatible"
          ? "oldVersionStatus"
          : executable?.state === "broken"
            ? "brokenStatus"
            : "notReadyStatus"
  const installCommand =
    engine === "claude" ? "npm install -g @anthropic-ai/claude-code" : "npm install -g @openai/codex"
  const needsInstall = engine !== "pi" && executable && !["ready", "not-needed"].includes(executable.state)
  return (
    <div data-engine={engine} data-access-mode={access?.mode} data-executable-state={executable?.state}>
      <SettingsGroup>
        <SettingsRow
          title={ENGINE_NAMES[engine]}
          icon={<Terminal className="size-4 shrink-0 text-muted-foreground" />}
          description={
            engine === "pi" ? (
              t("modelAccess:piBundled")
            ) : executable?.path ? (
              <Hint
                text={[executable.path, executable.source ? t(`modelAccess:${sourceKeys[executable.source]}`) : ""]
                  .filter(Boolean)
                  .join(" · ")}
              >
                <span
                  tabIndex={0}
                  className={`flex min-w-0 max-w-full rounded-sm font-mono text-xs ${MODEL_ACCESS_FOCUS_CLASS}`}
                >
                  <span className="shrink-0 whitespace-pre">
                    {executable.version ?? t("modelAccess:versionUnknown")} ·{" "}
                  </span>
                  <span data-path-start className="min-w-0 truncate">
                    {executable.path.slice(0, -23)}
                  </span>
                  <span data-path-end className="shrink-0">
                    {executable.path.slice(-23)}
                  </span>
                </span>
              </Hint>
            ) : (
              t("modelAccess:autoDiscover")
            )
          }
        >
          <div className="flex items-center gap-2">
            <SettingsBadge
              className={
                status?.ready
                  ? "border-success/20 bg-success/10 text-success-foreground"
                  : "border-cand-border bg-cand-surface text-cand-fg"
              }
            >
              <span role="status">{t(`modelAccess:${badgeKey}`)}</span>
            </SettingsBadge>
            {engine !== "pi" ? (
              <Popover open={menuOpen} onOpenChange={setMenuOpen}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t("modelAccess:engineActions", { engine: ENGINE_NAMES[engine] })}
                    disabled={!socket || !status || pending}
                  >
                    <MoreHorizontal className="size-4" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="model-access-ui w-48 p-1">
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-full justify-start rounded-lg"
                    size="sm"
                    onClick={() => {
                      setPath(setup?.executablePath ?? "")
                      setError(null)
                      setMenuOpen(false)
                      setPathOpen(true)
                    }}
                  >
                    {t("modelAccess:changePath")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-full justify-start rounded-lg"
                    size="sm"
                    onClick={() => {
                      setMenuOpen(false)
                      if (socket) void command(() => socket.command({ type: "modelAccess.refreshExecutables" }))
                    }}
                  >
                    <RefreshCw className="size-4" />
                    {t("modelAccess:refresh")}
                  </Button>
                </PopoverContent>
              </Popover>
            ) : null}
          </div>
        </SettingsRow>
        {status && !status.ready ? (
          <div className="p-3">
            <SettingsNotice tone="warning">
              <p>
                {engineProblemMessage(status)}{" "}
                {needsInstall
                  ? t(engine === "claude" ? "modelAccess:installClaude" : "modelAccess:installCodex")
                  : null}
              </p>
              {status.problem === "connection-key-missing" ? <p>{t("modelAccess:keyMissingFix")}</p> : null}
              {status.problem === "connection-protocol-unsupported" ? <p>{t("modelAccess:protocolFix")}</p> : null}
              {executable?.state === "incompatible" && executable.minimumVersion ? (
                <p>{t("modelAccess:minimumVersion", { version: executable.minimumVersion })}</p>
              ) : null}
              {needsInstall ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <code className="min-w-0 flex-1 break-all text-xs">{installCommand}</code>
                  <Hint text={t("modelAccess:copyCommand")}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={t("modelAccess:copyCommand")}
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(installCommand)
                          .then(() => setCopied(true))
                          .catch(() => setError(t("modelAccess:copyFailed")))
                      }}
                    >
                      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                    </Button>
                  </Hint>
                  <SettingsActionButton
                    className={`text-xs ${MODEL_ACCESS_FOCUS_CLASS}`}
                    disabled={!socket || pending}
                    onClick={() => {
                      setPath(setup?.executablePath ?? "")
                      setPathOpen(true)
                    }}
                  >
                    {t("modelAccess:choosePath")}
                  </SettingsActionButton>
                </div>
              ) : null}
            </SettingsNotice>
          </div>
        ) : null}
        <fieldset disabled={!status || !socket || pending} className="min-w-0 divide-y divide-border">
          <SettingsRow
            title={t("modelAccess:access")}
            description={t(
              engine === "pi"
                ? "modelAccess:piAccessDescription"
                : access?.mode === "connection"
                  ? "modelAccess:connectionAccessDescription"
                  : "modelAccess:accountAccessDescription",
            )}
            wideControl={engine !== "pi"}
          >
            {ENGINES_WITH_ACCOUNT_MODE.includes(engine) ? (
              <SegmentedControl
                size="sm"
                optionClassName={MODEL_ACCESS_FOCUS_CLASS}
                value={access?.mode ?? "account"}
                options={[
                  { value: "account", label: t("modelAccess:account") },
                  { value: "connection", label: t("modelAccess:connection") },
                ]}
                onValueChange={(mode) => {
                  if (!setup) return
                  if (mode === "account") setSetup({ ...setup, access: { mode: "account" } })
                  else chooseConnection(connections.find((c) => compatibleEndpointForEngine(engine, c))?.id ?? "")
                }}
              />
            ) : null}
          </SettingsRow>
          {access?.mode === "connection" || engine === "pi" ? (
            <SettingsRow title={t("modelAccess:connectionRow")} description={status?.translated ? t("modelAccess:viaTranslation") : undefined}>
              <SettingsSelect
                className={`rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${MODEL_ACCESS_FOCUS_CLASS}`}
                aria-label={t("modelAccess:connection")}
                value={access?.mode === "connection" ? access.connectionId || "__empty__" : "__empty__"}
                onValueChange={chooseConnection}
              >
                <SelectItem value="__empty__" disabled>
                  {t("modelAccess:chooseConnection")}
                </SelectItem>
                {access?.mode === "connection" && access.connectionId && !selectedConnection ? (
                  <SelectItem value={access.connectionId} disabled>
                    {t("modelAccess:connectionMissing")}
                  </SelectItem>
                ) : null}
                {connections.map((connection) => {
                  const compatible = Boolean(compatibleEndpointForEngine(engine, connection))
                  return (
                    <SelectItem key={connection.id} value={connection.id} disabled={!compatible}>
                      {connection.name}
                      {compatible ? "" : ` (${incompatibleConnectionMessage(engine)})`}
                    </SelectItem>
                  )
                })}
                <SelectItem value="__add__">{t("modelAccess:addConnectionOption")}</SelectItem>
              </SettingsSelect>
            </SettingsRow>
          ) : null}
        </fieldset>
        {error && !pathOpen ? (
          <div className="p-3">
            <SettingsNotice>{error}</SettingsNotice>
          </div>
        ) : null}
        {children}
      </SettingsGroup>
      <Dialog
        open={pathOpen}
        onOpenChange={(open) => {
          if (!pending) setPathOpen(open)
        }}
      >
        <DialogContent className="model-access-ui w-[calc(100%-2rem)]" size="md">
          <DialogHeader>
            <DialogTitle>{t("modelAccess:changePath")}</DialogTitle>
            <DialogDescription>{ENGINE_NAMES[engine]}</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (setup && socket)
                void command(
                  () =>
                    socket.command({
                      type: "modelAccess.setEngine",
                      engine,
                      setup: { ...setup, executablePath: path.trim() || null },
                    }),
                  () => setPathOpen(false),
                )
            }}
          >
            <DialogBody className="space-y-3">
              <label className="block space-y-2 text-xs text-muted-foreground">
                <span>{t("modelAccess:executablePath")}</span>
                <input
                  className={CONNECTION_FIELD_CLASS}
                  placeholder={t("modelAccess:autoDiscover")}
                  value={path}
                  onChange={(event) => setPath(event.target.value)}
                  disabled={pending}
                />
              </label>
              <Button type="button" variant="ghost" size="sm" onClick={() => setPath("")} disabled={pending}>
                {t("modelAccess:resetPath")}
              </Button>
              {error ? <SettingsNotice>{error}</SettingsNotice> : null}
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="ghost" size="sm" onClick={() => setPathOpen(false)} disabled={pending}>
                {t("modelAccess:cancel")}
              </Button>
              <Button type="submit" size="sm" disabled={pending}>
                {t("modelAccess:save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
