import { translateUiText } from "../../i18n/uiText"
import { getLocale, t, useI18n } from "../../i18n"
import { useCallback, useEffect, useMemo, useState } from "react"
import { encode } from "uqr"
import type { AppSettingsPatch } from "../../../shared/types"
import { useAppDialog } from "../../components/ui/app-dialog"
import { copyTextToClipboard } from "../../lib/clipboard"
import {
  buildPairingUrl,
  buildRemoteAccessPatch,
  fetchRemoteAccessOverview,
  formatPairingCode,
  formatPairingCountdown,
  parseTimeMs,
  readRemoteAccessEnabled,
  remoteAccessApi,
  type PairedDevice,
  type PairingRequestEntry,
  type RemoteAccessStatus,
} from "../../lib/remoteAccessApi"
import type { AppState } from "../useAppState"
import { SETTINGS_ROWS } from "./registry"
import {
  SETTINGS_INLINE_ACTION_CLASS,
  SettingsActionButton,
  SettingsBadge,
  SettingsErrorBanner,
  SettingsGroup,
  SettingsGroups,
  SettingsNotice,
  SettingsRow,
} from "./shared"
import { Switch } from "../../components/ui/switch"
import { cn } from "../../lib/utils"

type SharingState = Pick<AppState, "appSettings" | "handleWriteAppSettings">

/** Renders the pairing link as a scannable QR matrix. Black on white in both themes — scanners need the contrast. */
function PairingQrCode({ value }: { value: string }) {
  const { path, size } = useMemo(() => {
    // Standard 4-module quiet zone: in dark mode the card behind the white
    // tile is dark, so the quiet zone has to live inside the QR itself.
    const result = encode(value, { ecc: "M", border: 4 })
    let modules = ""
    for (let y = 0; y < result.data.length; y += 1) {
      const row = result.data[y]
      for (let x = 0; x < row.length; x += 1) {
        if (row[x]) modules += `M${x},${y}h1v1h-1z`
      }
    }
    return { path: modules, size: result.data.length }
  }, [value])
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={t("settings:sharingPairingQrLabel")}
      className="block size-full"
    >
      <rect width={size} height={size} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  )
}

/** Inline description action; flips to "Copied" briefly after a successful write. */
function CopyUrlButton({ value }: { value: string }) {
  useI18n()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <button
      type="button"
      className={cn(SETTINGS_INLINE_ACTION_CLASS, "cursor-pointer whitespace-nowrap")}
      onClick={() => {
        void copyTextToClipboard(value).then((ok) => {
          if (ok) setCopied(true)
        })
      }}
    >
      {copied ? t("settings:sharingCopied") : t("settings:sharingCopy")}
    </button>
  )
}

function formatDeviceDate(value: string | number | null | undefined): string {
  const ms = parseTimeMs(value)
  if (ms === null) return t("settings:unknownDate")
  return new Intl.DateTimeFormat(getLocale(), { month: "short", day: "numeric", year: "numeric" }).format(new Date(ms))
}

/** Load-error lifecycle for the background overview poll: recovery clears the
 * banner; after the first load, transient failures stay silent and preserve
 * whatever initial-load state is already visible. */
export function sharingLoadErrorAfterPoll(
  current: string | null,
  outcome: { kind: "success" } | { kind: "failure"; initialLoad: boolean; message: string },
) {
  if (outcome.kind === "success") return null
  return outcome.initialLoad ? outcome.message : current
}

/**
 * Pure view: every state and callback arrives as a prop, so the policy
 * combinations (off, restart-pending, active with requests and devices) are
 * verifiable without network hooks — same split as MemorySettingsGroups.
 */
export function SharingAccessGroups({
  enabled,
  status,
  pendingRequests,
  devices,
  nowMs,
  busyIds,
  onToggleEnabled,
  onApproveRequest,
  onDenyRequest,
  onRevokeDevice,
}: {
  enabled: boolean
  /** Null while the status endpoint has not answered yet. */
  status: RemoteAccessStatus | null
  pendingRequests: PairingRequestEntry[]
  devices: PairedDevice[]
  nowMs: number
  busyIds?: ReadonlySet<string>
  onToggleEnabled: (enabled: boolean) => void
  onApproveRequest: (id: string) => void
  onDenyRequest: (id: string) => void
  onRevokeDevice: (device: PairedDevice) => void
}) {
  useI18n()
  const busy = busyIds ?? new Set<string>()
  const active = status?.active === true
  const pairing = status ? buildPairingUrl(status.lanUrls) : null
  const alternateLanUrls = status?.lanUrls.slice(1) ?? []
  // The bind cannot change on a running server, so a mismatch between the
  // persisted setting and the live bind means a restart is pending — in
  // either direction. An explicit launch bind is different: it will win again
  // after that restart, so promising a state change would be false.
  const bindMismatch = status !== null && enabled !== status.active
  const restartNotice = bindMismatch && status?.bindControlledExternally !== true
  const bindOverrideNotice = bindMismatch && status?.bindControlledExternally === true

  return (
    <SettingsGroups>
      <SettingsGroup>
        <SettingsRow def={SETTINGS_ROWS.remoteAccess}>
          <Switch
            aria-label={t("settings:remoteAccess")}
            checked={enabled}
            onCheckedChange={onToggleEnabled}
          />
        </SettingsRow>
      </SettingsGroup>
      {bindOverrideNotice ? (
        <SettingsNotice tone="warning">
          {t(enabled ? "settings:sharingBindOverrideBlocksEnable" : "settings:sharingBindOverrideKeepsActive", { host: status?.bindHost ?? "unknown" })}
        </SettingsNotice>
      ) : restartNotice ? (
        <SettingsNotice tone="warning">
          {enabled ? t("settings:sharingTakesEffectAfterRestart") : t("settings:sharingStaysOnUntilRestart")}
        </SettingsNotice>
      ) : null}
      {/* The QR only helps while the server is actually reachable, but pending
          requests render whenever they exist — loopback pairing tests can
          create them before the LAN bind is active. */}
      {active || pendingRequests.length > 0 ? (
        <SettingsGroup title={t("settings:sharingPairing")}>
          {active && pairing ? (
            <SettingsRow
              title={t("settings:sharingPairNewDevice")}
              alignStart
              wideControl
              description={(
                <div className="space-y-1.5">
                  <p>{t("settings:sharingPairInstructions")}</p>
                  <p className="flex flex-wrap items-baseline gap-x-2">
                    <span className="break-all font-mono text-[12px]">{pairing.pairingUrl}</span>
                    <CopyUrlButton value={pairing.pairingUrl} />
                  </p>
                  {alternateLanUrls.length > 0 ? (
                    <details className="pt-1 text-[12px] text-muted-foreground">
                      <summary className="w-fit cursor-pointer select-none font-medium text-foreground/80 transition-colors hover:text-foreground">
                        {t("settings:sharingOtherAddresses")}
                      </summary>
                      <div className="mt-1.5 space-y-1">
                        {alternateLanUrls.map((lanUrl) => (
                          <div key={lanUrl} className="flex max-w-xl items-center gap-2">
                            <span className="min-w-0 flex-1 select-text break-all font-mono text-[11.5px]">{lanUrl}</span>
                            <CopyUrlButton value={lanUrl} />
                          </div>
                        ))}
                      </div>
                    </details>
                  ) : null}
                </div>
              )}
            >
              <div className="size-32 overflow-hidden rounded-lg bg-white shadow-[0_1px_2px_rgba(0,0,0,0.08)]">
                <PairingQrCode value={pairing.pairingUrl} />
              </div>
            </SettingsRow>
          ) : null}
          {pendingRequests.map((request) => {
            const expiresMs = parseTimeMs(request.expiresAt)
            const requestBusy = busy.has(request.id)
            return (
              <SettingsRow
                key={request.id}
                title={request.deviceName}
                alignStart
                description={(
                  <div className="space-y-1">
                    <p className="font-mono text-xl font-semibold tracking-[0.14em] text-foreground">
                      {formatPairingCode(request.code)}
                    </p>
                    {expiresMs !== null ? (
                      <p>{t("settings:sharingExpiresIn", { time: formatPairingCountdown(expiresMs - nowMs) })}</p>
                    ) : null}
                  </div>
                )}
              >
                <div className="flex items-center gap-1.5">
                  <SettingsActionButton
                    prominent
                    disabled={requestBusy}
                    onClick={() => onApproveRequest(request.id)}
                  >
                    {t("settings:sharingApprove")}
                  </SettingsActionButton>
                  <SettingsActionButton
                    disabled={requestBusy}
                    onClick={() => onDenyRequest(request.id)}
                  >
                    {t("settings:sharingDeny")}
                  </SettingsActionButton>
                </div>
              </SettingsRow>
            )
          })}
        </SettingsGroup>
      ) : null}
      {devices.length > 0 ? (
        <SettingsGroup title={t("settings:sharingPairedDevices")}>
          {devices.map((device) => {
            const revoked = parseTimeMs(device.revokedAt) !== null
            return (
              <SettingsRow
                key={device.id}
                title={device.name}
                description={t("settings:sharingDeviceDates", {
                  created: formatDeviceDate(device.createdAt),
                  lastSeen: formatDeviceDate(device.lastSeenAt),
                })}
              >
                {revoked ? (
                  <SettingsBadge>{t("settings:sharingRevoked")}</SettingsBadge>
                ) : (
                  <SettingsActionButton
                    disabled={busy.has(device.id)}
                    onClick={() => onRevokeDevice(device)}
                  >
                    {t("settings:sharingRevoke")}
                  </SettingsActionButton>
                )}
              </SettingsRow>
            )
          })}
        </SettingsGroup>
      ) : null}
      <p className="px-1 text-[12.5px] leading-5 text-muted-foreground">{t("settings:sharingSecurityNote")}</p>
    </SettingsGroups>
  )
}

export function SharingAccessSection({ state }: { state: SharingState }) {
  useI18n()
  const dialog = useAppDialog()
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null)
  const [devices, setDevices] = useState<PairedDevice[]>([])
  const [pendingRequests, setPendingRequests] = useState<PairingRequestEntry[]>([])
  // Load and action failures have different lifetimes: a recovered poll must
  // clear the initial-load banner, while a user-triggered action error must
  // not be silently erased by the next background poll.
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set())
  const [nowMs, setNowMs] = useState(() => Date.now())
  const enabled = readRemoteAccessEnabled(state.appSettings)

  const reloadDevices = useCallback(async () => {
    const result = await remoteAccessApi.devices()
    setDevices(result.devices)
  }, [])

  const reloadPending = useCallback(async () => {
    const result = await remoteAccessApi.pendingRequests()
    setPendingRequests(result.requests)
  }, [])

  // Poll the whole remote-access overview for as long as the section is on
  // screen: restart-dependent bind state can be corrected externally, and a
  // second window can approve or revoke devices. The list is empty while
  // remote access is off, but loopback pairing tests can create requests
  // before the LAN bind is active, so the poll is not gated on bind state.
  // inFlight guards against overlapping ticks.
  useEffect(() => {
    let cancelled = false
    let inFlight = false
    let initialLoad = true
    async function poll() {
      if (inFlight) return
      inFlight = true
      const wasInitialLoad = initialLoad
      try {
        const overview = await fetchRemoteAccessOverview()
        if (cancelled) return
        setStatus(overview.status)
        setDevices(overview.devices)
        setPendingRequests(overview.pendingRequests)
        setLoadError((current) => sharingLoadErrorAfterPoll(current, { kind: "success" }))
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : t("settings:sharingUnableToLoad")
          setLoadError((current) => sharingLoadErrorAfterPoll(current, { kind: "failure", initialLoad: wasInitialLoad, message }))
        }
      } finally {
        initialLoad = false
        inFlight = false
      }
    }
    void poll()
    const timer = setInterval(() => {
      void poll()
    }, 3000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  // Countdown clock for the request expiry labels.
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  async function runBusy(id: string, action: () => Promise<unknown>) {
    setBusyIds((previous) => new Set(previous).add(id))
    try {
      await action()
    } finally {
      setBusyIds((previous) => {
        const next = new Set(previous)
        next.delete(id)
        return next
      })
    }
  }

  function actionErrorMessage(error: unknown, fallback: string) {
    return error instanceof Error ? error.message : fallback
  }

  async function save(patch: AppSettingsPatch) {
    try {
      setActionError(null)
      await state.handleWriteAppSettings(patch)
    } catch (error) {
      setActionError(actionErrorMessage(error, t("settings:unableToSaveSettings")))
    }
  }

  async function handleApprove(id: string) {
    try {
      setActionError(null)
      await runBusy(id, () => remoteAccessApi.approveRequest(id))
      // Approval both clears the request and creates the device.
      await Promise.all([reloadPending(), reloadDevices()])
    } catch (error) {
      setActionError(actionErrorMessage(error, t("settings:sharingActionFailed")))
    }
  }

  async function handleDeny(id: string) {
    try {
      setActionError(null)
      await runBusy(id, () => remoteAccessApi.denyRequest(id))
      await reloadPending()
    } catch (error) {
      setActionError(actionErrorMessage(error, t("settings:sharingActionFailed")))
    }
  }

  async function handleRevoke(device: PairedDevice) {
    const confirmed = await dialog.confirm({
      title: t("settings:sharingRevokeDeviceTitle"),
      description: t("settings:sharingRevokeDeviceDescription", { name: device.name }),
      confirmLabel: t("settings:sharingRevoke"),
      confirmVariant: "destructive",
    })
    if (!confirmed) return
    try {
      setActionError(null)
      await runBusy(device.id, () => remoteAccessApi.revokeDevice(device.id))
      await reloadDevices()
    } catch (error) {
      setActionError(actionErrorMessage(error, t("settings:sharingActionFailed")))
    }
  }

  const visibleError = actionError ?? loadError

  return (
    <>
      {visibleError ? <SettingsErrorBanner message={translateUiText(visibleError)} /> : null}
      <SharingAccessGroups
        enabled={enabled}
        status={status}
        pendingRequests={pendingRequests}
        devices={devices}
        nowMs={nowMs}
        busyIds={busyIds}
        onToggleEnabled={(next) => {
          void save(buildRemoteAccessPatch(next))
        }}
        onApproveRequest={(id) => {
          void handleApprove(id)
        }}
        onDenyRequest={(id) => {
          void handleDeny(id)
        }}
        onRevokeDevice={(device) => {
          void handleRevoke(device)
        }}
      />
    </>
  )
}
