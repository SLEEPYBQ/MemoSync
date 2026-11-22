import { useEffect, useRef, useState } from "react"
import { Download, Loader2, RefreshCw } from "lucide-react"
import type { DesktopUpdateSnapshot, DesktopUpdatesBridge } from "../../../shared/desktop-updates"
import { t, useI18n } from "../../i18n"
import { SETTINGS_ROWS } from "./registry"
import { SettingsActionButton, SettingsGroup, SettingsRow } from "./shared"

type UpdateAction = "checkForUpdates" | "downloadUpdate" | "installUpdate"

export function DesktopUpdateSection({ bridge, platform }: { bridge: DesktopUpdatesBridge; platform: string }) {
  useI18n()
  const [snapshot, setSnapshot] = useState<DesktopUpdateSnapshot | null>(null)
  const [pending, setPending] = useState<UpdateAction | null>(null)
  const [requestError, setRequestError] = useState<string | null>(null)
  const revision = useRef(0)
  const mounted = useRef(false)
  const running = useRef(false)

  useEffect(() => {
    mounted.current = true
    let active = true
    // Subscribe first: an initial IPC reply may arrive after a newer progress event.
    const unsubscribe = bridge.onChange((next) => {
      revision.current += 1
      if (active) {
        setSnapshot(next)
        setRequestError(null)
      }
    })
    const initialRevision = revision.current
    void bridge.getSnapshot().then((next) => {
      if (active && revision.current === initialRevision) setSnapshot(next)
    }).catch((error: unknown) => {
      if (active && revision.current === initialRevision) setRequestError(error instanceof Error ? error.message : String(error))
    })
    return () => {
      active = false
      mounted.current = false
      unsubscribe()
    }
  }, [bridge])

  async function run(action: UpdateAction) {
    if (running.current) return
    running.current = true
    setPending(action)
    setRequestError(null)
    const actionRevision = revision.current
    try {
      const next = await bridge[action]()
      // Progress events are authoritative when they race an action's IPC reply.
      if (mounted.current && revision.current === actionRevision) setSnapshot(next)
    } catch (error) {
      if (mounted.current) setRequestError(error instanceof Error ? error.message : String(error))
    } finally {
      running.current = false
      if (mounted.current) setPending(null)
    }
  }

  const status = snapshot?.status
  const busy = pending !== null || (!requestError && (status === "checking" || status === "downloading" || status === "installing"))
  const error = requestError || snapshot?.error
  const progress = snapshot?.progress == null ? null : Math.round(Math.max(0, Math.min(100, snapshot.progress)))
  const version = snapshot?.latestVersion ?? ""
  const action: UpdateAction = error ? "checkForUpdates" : status === "downloaded" ? "installUpdate" : status === "available" ? "downloadUpdate" : "checkForUpdates"
  const actionLabel = requestError
    ? t("settings:desktopUpdateRetry")
    : status === "checking" || pending === "checkForUpdates"
    ? t("settings:checking")
    : status === "downloading" || pending === "downloadUpdate"
      ? t("settings:desktopUpdateDownloading")
      : status === "installing" || pending === "installUpdate"
        ? t("settings:desktopUpdateInstalling")
        : status === "downloaded"
          ? snapshot?.installMode === "automatic" ? t("settings:desktopUpdateRestart") : t("settings:desktopUpdateOpenInstaller")
          : status === "available"
            ? t("settings:desktopUpdateDownload")
            : error ? t("settings:desktopUpdateRetry") : t("settings:checkForUpdates")
  const statusText = !snapshot
    ? t("settings:desktopUpdateLoading")
    : status === "up_to_date"
      ? t("settings:desktopUpdateCurrent", { version: snapshot.currentVersion })
      : status === "available"
        ? t("settings:desktopUpdateAvailable", { version })
        : status === "downloading"
          ? progress === null ? t("settings:desktopUpdateDownloading") : t("settings:desktopUpdateProgress", { percent: progress })
          : status === "downloaded"
            ? t("settings:desktopUpdateDownloaded", { version })
            : status === "installing"
              ? t("settings:desktopUpdateInstalling")
              : status === "checking"
                ? t("settings:checking")
                : status === "unsupported"
                  ? t("settings:desktopUpdateUnsupported")
                  : t("settings:desktopUpdateIdle")
  const installHint = snapshot?.installMode === "installer"
    ? platform === "darwin" ? t("settings:desktopUpdateMacHint") : t("settings:desktopUpdateInstallerHint")
    : status === "downloaded" ? t("settings:desktopUpdateRestartHint") : null

  return (
    <SettingsGroup>
      <SettingsRow
        def={SETTINGS_ROWS.applicationUpdate}
        wideControl
        description={(
          <div className="space-y-1.5">
            <p role="status" aria-live="polite">{error && status !== "unsupported" ? t("settings:desktopUpdateFailed") : statusText}</p>
            {installHint ? <p>{installHint}</p> : null}
            {status === "downloading" ? (
              <div
                role="progressbar"
                aria-label={t("settings:desktopUpdateDownloading")}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress ?? undefined}
                className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-black/[0.08] dark:bg-white/[0.1]"
              >
                <div className={`h-full rounded-full bg-primary transition-[width] ${progress === null ? "animate-pulse" : ""}`} style={{ width: `${progress ?? 25}%` }} />
              </div>
            ) : null}
            {error ? <p role={status === "unsupported" ? undefined : "alert"} className={status === "unsupported" ? "break-words" : "break-words text-destructive"}>{error}</p> : null}
          </div>
        )}
      >
        {status !== "unsupported" ? (
          <SettingsActionButton
            disabled={busy || (!snapshot && !requestError)}
            prominent={status === "available" || status === "downloaded"}
            icon={busy ? <Loader2 aria-hidden="true" className="animate-spin" /> : action === "downloadUpdate" ? <Download aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
            onClick={() => { void run(action) }}
          >
            {actionLabel}
          </SettingsActionButton>
        ) : null}
      </SettingsRow>
    </SettingsGroup>
  )
}
