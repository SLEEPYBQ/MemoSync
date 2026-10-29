import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import type { AppSettingsPatch } from "../../../shared/types"
import { Switch } from "../../components/ui/switch"
import { SelectItem } from "../../components/ui/select"
import { useConditionPolicy, type ConditionPolicy } from "../../lib/conditionApi"
import { memoriesApi } from "../../lib/memoriesApi"
import type { AppState } from "../useAppState"
import { SETTINGS_ROWS } from "./registry"
import { SettingsErrorBanner, SettingsGroup, SettingsGroups, SettingsRow, SettingsSelect } from "./shared"

type MemoryState = Pick<AppState, "appSettings" | "handleWriteAppSettings">

/** Pure view also makes all policy and disabled states verifiable without network hooks. */
export function MemorySettingsGroups({
  settings,
  policy,
  mode,
  save,
  setMode,
}: {
  settings: AppState["appSettings"]
  policy: ConditionPolicy
  mode: "ask" | "auto" | undefined
  save: (patch: AppSettingsPatch) => void
  setMode: (mode: "ask" | "auto") => void
}) {
  // In study mode the server's condition policy, rather than personal switches, is authoritative.
  const enabled = policy.studyMode || settings?.memory.enabled !== false
  const learn = policy.studyMode || settings?.memory.learn !== false
  const memoryReason = " Turn on Use Memory to change this."
  const changesDisabled = !enabled || !learn || mode === undefined
  const changesReason = !enabled
    ? memoryReason
    : !learn
      ? " Turn on Learn From Chats to change this."
      : mode === undefined
        ? " Loading memory changes preference…"
        : ""

  return (
    <>
      <SettingsGroups>
        {!policy.studyMode ? (
          <SettingsGroup>
            <SettingsRow def={SETTINGS_ROWS.memoryEnabled}>
              <Switch
                aria-label="Use Memory"
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
                aria-label="Learn From Chats"
                checked={learn}
                disabled={!enabled}
                onCheckedChange={(checked) => save({ memory: { learn: checked } })}
              />
            </SettingsRow>
          </SettingsGroup>
        ) : null}
        {policy.preview ? (
          <SettingsGroup title="Before Each Turn">
            <SettingsRow
              def={SETTINGS_ROWS.memoryPreview}
              disabled={!enabled}
              description={SETTINGS_ROWS.memoryPreview.description + (!enabled ? memoryReason : "")}
            >
              <Switch
                aria-label="Memory Preview"
                checked={settings?.memoryPreview.enabled !== false}
                disabled={!enabled}
                onCheckedChange={(checked) => save({ memoryPreview: { enabled: checked } })}
              />
            </SettingsRow>
            <SettingsRow
              def={SETTINGS_ROWS.memoryAutoProceed}
              disabled={!enabled}
              description={SETTINGS_ROWS.memoryAutoProceed.description + (!enabled ? memoryReason : "")}
            >
              <Switch
                aria-label="Auto-proceed When No Memory Applies"
                checked={settings?.memoryPreview.autoProceedWhenEmpty !== false}
                disabled={!enabled}
                onCheckedChange={(checked) => save({ memoryPreview: { autoProceedWhenEmpty: checked } })}
              />
            </SettingsRow>
          </SettingsGroup>
        ) : null}
        <SettingsGroup title="Changes">
          <SettingsRow
            def={SETTINGS_ROWS.memoryChanges}
            disabled={changesDisabled}
            description={SETTINGS_ROWS.memoryChanges.description + changesReason}
            wideControl
          >
            <SettingsSelect
              aria-label="Memory Changes"
              value={mode ?? "ask"}
              disabled={changesDisabled}
              onValueChange={(value) => setMode(value as "ask" | "auto")}
            >
              <SelectItem value="ask">Ask First</SelectItem>
              <SelectItem value="auto">Apply Automatically</SelectItem>
            </SettingsSelect>
          </SettingsRow>
        </SettingsGroup>
      </SettingsGroups>
      {policy.boardVisible ? (
        <div className="px-[17px] pt-6">
          <Link
            className="inline-flex min-h-9 items-center text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:underline"
            to="/memory"
          >
            Open Memory Board
          </Link>
        </div>
      ) : null}
    </>
  )
}

export function MemorySection({ state }: { state: MemoryState }) {
  const policy = useConditionPolicy()
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
        if (!cancelled) setError(error instanceof Error ? error.message : "Unable to load memory changes preference.")
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
      setError(error instanceof Error ? error.message : "Unable to save memory settings.")
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
      setError(error instanceof Error ? error.message : "Unable to save memory changes preference.")
    }
  }

  return (
    <>
      {error ? <SettingsErrorBanner message={error} /> : null}
      <MemorySettingsGroups
        settings={state.appSettings}
        policy={policy}
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
