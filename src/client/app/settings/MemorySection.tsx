import { translateUiText } from "../../i18n/uiText"
import { t, useI18n } from "../../i18n"
import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import type { AppSettingsPatch } from "../../../shared/types"
import { SelectItem } from "../../components/ui/select"
import { Switch } from "../../components/ui/switch"
import { memoriesApi } from "../../lib/memoriesApi"
import type { AppState } from "../useAppState"
import { SETTINGS_ROWS } from "./registry"
import { SettingsErrorBanner, SettingsGroup, SettingsGroups, SettingsRow, SettingsSelect } from "./shared"

type MemoryState = Pick<AppState, "appSettings" | "handleWriteAppSettings">

/** Pure view also makes all policy and disabled states verifiable without network hooks. */
export function MemorySettingsGroups({
  settings,
  mode,
  save,
  setMode,
}: {
  settings: AppState["appSettings"]
  mode: "ask" | "auto" | undefined
  save: (patch: AppSettingsPatch) => void
  setMode: (mode: "ask" | "auto") => void
}) {
  useI18n()
  const enabled = settings?.memory.enabled !== false
  const learn = settings?.memory.learn !== false
  const automatic = settings?.memory.control === "auto"
  const memoryReason = t("settings:turnOnUseMemoryToChangeThis")
  const controlReason = ` ${t("settings:setControlToReviewToChangeThis")}`
  const previewDisabled = !enabled || automatic
  const previewReason = !enabled ? memoryReason : automatic ? controlReason : ""
  const changesDisabled = !enabled || automatic || !learn || mode === undefined
  const changesReason = !enabled
    ? memoryReason
    : automatic
      ? controlReason
      : !learn
        ? t("settings:turnOnLearnFromChatsToChangeThis")
        : mode === undefined
          ? t("settings:loadingMemoryChangesPreference")
          : ""

  return (
    <>
      <SettingsGroups>
        {(
          <SettingsGroup>
            <SettingsRow
              def={SETTINGS_ROWS.memoryControl}
              disabled={!enabled}
              description={SETTINGS_ROWS.memoryControl.description + (!enabled ? memoryReason : "")}
              wideControl
            >
              <SettingsSelect
                aria-label={t("settings:memoryControl")}
                value={settings?.memory.control ?? "review"}
                disabled={!enabled}
                onValueChange={(value) => save({ memory: { control: value as "review" | "auto" } })}
              >
                <SelectItem value="review">{t("settings:reviewEachTurn")}</SelectItem>
                <SelectItem value="auto">{t("settings:automatic")}</SelectItem>
              </SettingsSelect>
            </SettingsRow>
            <SettingsRow def={SETTINGS_ROWS.memoryEnabled}>
              <Switch
                aria-label={t("settings:useMemory")}
                checked={enabled}
                onCheckedChange={(checked) => save({ memory: { enabled: checked } })}
              />
            </SettingsRow>
            <SettingsRow
              def={SETTINGS_ROWS.memoryLearn}
              disabled={!enabled}
              description={SETTINGS_ROWS.memoryLearn.description + (!enabled ? memoryReason : "")}
            >
              <Switch
                aria-label={t("settings:learnFromChats")}
                checked={learn}
                disabled={!enabled}
                onCheckedChange={(checked) => save({ memory: { learn: checked } })}
              />
            </SettingsRow>
          </SettingsGroup>
        )}
        {(
          <SettingsGroup title={t("settings:beforeEachTurn")}>
            <SettingsRow
              def={SETTINGS_ROWS.memoryPreview}
              disabled={previewDisabled}
              description={SETTINGS_ROWS.memoryPreview.description + previewReason}
            >
              <Switch
                aria-label={t("settings:memoryPreview")}
                checked={settings?.memoryPreview.enabled !== false}
                disabled={previewDisabled}
                onCheckedChange={(checked) => save({ memoryPreview: { enabled: checked } })}
              />
            </SettingsRow>
            <SettingsRow
              def={SETTINGS_ROWS.memoryAutoProceed}
              disabled={previewDisabled}
              description={SETTINGS_ROWS.memoryAutoProceed.description + previewReason}
            >
              <Switch
                aria-label={t("settings:autoProceedWhenNoMemoryApplies")}
                checked={settings?.memoryPreview.autoProceedWhenEmpty !== false}
                disabled={previewDisabled}
                onCheckedChange={(checked) => save({ memoryPreview: { autoProceedWhenEmpty: checked } })}
              />
            </SettingsRow>
          </SettingsGroup>
        )}
        <SettingsGroup title={t("settings:changes")}>
          <SettingsRow
            def={SETTINGS_ROWS.memoryChanges}
            disabled={changesDisabled}
            description={SETTINGS_ROWS.memoryChanges.description + changesReason}
            wideControl
          >
            <SettingsSelect
              aria-label={t("settings:memoryChanges")}
              value={mode ?? "ask"}
              disabled={changesDisabled}
              onValueChange={(value) => setMode(value as "ask" | "auto")}
            >
              <SelectItem value="ask">{t("settings:askFirst")}</SelectItem>
              <SelectItem value="auto">{t("settings:applyAutomatically")}</SelectItem>
            </SettingsSelect>
          </SettingsRow>
        </SettingsGroup>
      </SettingsGroups>
      {(
        <div className="px-1 pt-6">
          <Link
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-black/[0.045] px-3 text-[13px] font-medium text-foreground transition-colors hover:bg-black/[0.07] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/40 dark:bg-white/[0.07] dark:hover:bg-white/[0.10]"
            to="/memory"
          >
            {t("settings:openMemoryBoard")}</Link>
        </div>
      )}
    </>
  )
}

export function MemorySection({ state }: { state: MemoryState }) {
  useI18n()
  const [mode, setMode] = useState<"ask" | "auto" | undefined>()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void memoriesApi
      .getEvolutionPolicy()
      .then((result) => {
        if (!cancelled) setMode(result.mode)
      })
      .catch((error) => {
        if (!cancelled) setError(error instanceof Error ? error.message : t("settings:unableToLoadMemoryChangesPreference"))
      })

    return () => {
      cancelled = true
    }
  }, [])

  async function save(patch: AppSettingsPatch) {
    try {
      setError(null)
      await state.handleWriteAppSettings(patch)
    } catch (error) {
      setError(error instanceof Error ? error.message : t("settings:unableToSaveMemorySettings"))
    }
  }

  async function changeMode(next: "ask" | "auto") {
    if (mode === undefined || mode === next) return
    const previous = mode
    setMode(next)
    try {
      setError(null)
      await memoriesApi.setEvolutionPolicy(next)
    } catch (error) {
      setMode(previous)
      setError(error instanceof Error ? error.message : t("settings:unableToSaveMemoryChangesPreference"))
    }
  }

  return (
    <>
      {error ? <SettingsErrorBanner message={translateUiText(error)} /> : null}
      <MemorySettingsGroups
        settings={state.appSettings}

        mode={mode}
        save={(patch) => {
          void save(patch)
        }}
        setMode={(mode) => {
          void changeMode(mode)
        }}
      />
    </>
  )
}
