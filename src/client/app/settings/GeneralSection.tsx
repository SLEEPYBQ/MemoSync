import { translateUiText } from "../../i18n/uiText"
import { t, useI18n } from "../../i18n"
import { useEffect, useState } from "react"
import { SELF_UPDATE_ENABLED } from "../../../shared/branding"
import type {
  AppSettingsPatch,
  AppThemePreference,
  AppLanguagePreference,
  ChatSoundId,
  ChatSoundPreference,
  EditorPreset,
  SubmitWhileRunning,
} from "../../../shared/types"
import { Input } from "../../components/ui/input"
import { SelectItem } from "../../components/ui/select"
import {
  getChatBrowserNotificationDescription,
  getChatBrowserNotificationPermission,
  requestChatBrowserNotificationPermission,
} from "../../lib/chatBrowserNotifications"
import { playChatNotificationSound } from "../../lib/chatSounds"
import { CHAT_SOUND_OPTIONS, useChatSoundPreferencesStore } from "../../stores/chatSoundPreferencesStore"
import {
  DEFAULT_TERMINAL_MIN_COLUMN_WIDTH,
  DEFAULT_TERMINAL_SCROLLBACK,
  MAX_TERMINAL_MIN_COLUMN_WIDTH,
  MAX_TERMINAL_SCROLLBACK,
  MIN_TERMINAL_MIN_COLUMN_WIDTH,
  MIN_TERMINAL_SCROLLBACK,
  getDefaultEditorCommandTemplate,
  getEditorPresetLabel,
  useTerminalPreferencesStore,
} from "../../stores/terminalPreferencesStore"
import type { AppState } from "../useAppState"
import { SETTINGS_ROWS } from "./registry"
import {
  SETTINGS_CONTROL_CLASS,
  SETTINGS_NUMBER_INPUT_CLASS,
  SettingsActionButton,
  SettingsErrorBanner,
  SettingsField,
  SettingsGroup,
  SettingsGroups,
  SettingsRow,
  SettingsSelect,
  handleSettingsInputKeyDown,
  resolveChatBrowserNotificationPreferenceAfterPermission,
  shouldPreviewChatSoundChange,
} from "./shared"

const notificationOptions = [
  { value: "never", get label() { return t("settings:never") } },
  { value: "unfocused", get label() { return t("settings:whenUnfocused") } },
  { value: "always", get label() { return t("settings:always") } },
]
const editorPresets: EditorPreset[] = ["cursor", "vscode", "xcode", "windsurf", "custom"]
type GeneralState = Pick<
  AppState,
  "appSettings" | "handleWriteAppSettings" | "updateSnapshot" | "handleCheckForUpdates" | "handleInstallUpdate"
>

export function GeneralSection({ state, appVersion }: { state: GeneralState; appVersion: string }) {
  useI18n()
  const terminal = useTerminalPreferencesStore()
  const sounds = useChatSoundPreferencesStore()
  const [error, setError] = useState<string | null>(null)
  const [permission, setPermission] = useState(getChatBrowserNotificationPermission)
  const [scrollbackDraft, setScrollbackDraft] = useState(String(terminal.scrollbackLines))
  const [widthDraft, setWidthDraft] = useState(String(terminal.minColumnWidth))
  const [editorDraft, setEditorDraft] = useState(terminal.editorCommandTemplate)

  useEffect(() => setScrollbackDraft(String(terminal.scrollbackLines)), [terminal.scrollbackLines])
  useEffect(() => setWidthDraft(String(terminal.minColumnWidth)), [terminal.minColumnWidth])
  useEffect(() => setEditorDraft(terminal.editorCommandTemplate), [terminal.editorCommandTemplate])
  useEffect(() => {
    const refresh = () => setPermission(getChatBrowserNotificationPermission())
    window.addEventListener("focus", refresh)
    return () => window.removeEventListener("focus", refresh)
  }, [])

  async function save(patch: AppSettingsPatch) {
    try {
      setError(null)
      await state.handleWriteAppSettings(patch)
    } catch (error) {
      setError(error instanceof Error ? error.message : t("settings:unableToSaveSettings"))
    }
  }

  function changeSound(preference: ChatSoundPreference) {
    if (!shouldPreviewChatSoundChange(sounds.chatSoundPreference, preference)) return
    sounds.setChatSoundPreference(preference)
    void save({ chatSoundPreference: preference })
    void playChatNotificationSound(sounds.chatSoundId, 1).catch(() => undefined)
  }

  function changeSoundId(id: ChatSoundId) {
    if (!shouldPreviewChatSoundChange(sounds.chatSoundId, id)) return
    sounds.setChatSoundId(id)
    void save({ chatSoundId: id })
    void playChatNotificationSound(id, 1).catch(() => undefined)
  }

  async function changeNotifications(value: ChatSoundPreference) {
    try {
      const nextPermission =
        value === "never" ? getChatBrowserNotificationPermission() : await requestChatBrowserNotificationPermission()
      setPermission(nextPermission)
      await save({
        chatBrowserNotificationPreference: resolveChatBrowserNotificationPreferenceAfterPermission(
          value,
          nextPermission,
        ),
      })
    } catch {
      setError(t("settings:unableToRequestNotificationsCheckThisSiteSNotificationPermission"))
    }
  }

  function commitScrollback() {
    if (!scrollbackDraft.trim() || !Number.isFinite(Number(scrollbackDraft))) {
      setScrollbackDraft(String(terminal.scrollbackLines))
      return
    }
    terminal.setScrollbackLines(Number(scrollbackDraft))
    void save({ terminal: { scrollbackLines: useTerminalPreferencesStore.getState().scrollbackLines } })
  }

  function commitWidth() {
    if (!widthDraft.trim() || !Number.isFinite(Number(widthDraft))) {
      setWidthDraft(String(terminal.minColumnWidth))
      return
    }
    terminal.setMinColumnWidth(Number(widthDraft))
    void save({ terminal: { minColumnWidth: useTerminalPreferencesStore.getState().minColumnWidth } })
  }

  function commitEditor() {
    terminal.setEditorCommandTemplate(editorDraft)
    void save({ editor: { commandTemplate: useTerminalPreferencesStore.getState().editorCommandTemplate } })
  }

  const update = state.updateSnapshot
  const isUpdating = update?.status === "updating" || update?.status === "restart_pending"
  const updateActionLabel = isUpdating
    ? t("settings:updating")
    : update?.status === "checking"
      ? t("settings:checking")
      : update?.updateAvailable
        ? t("common:update")
        : t("settings:checkForUpdates")

  return (
    <>
      {error ? <SettingsErrorBanner message={translateUiText(error)} /> : null}
      {state.appSettings?.warning ? (
        <div className="mb-6 px-[17px] text-sm text-muted-foreground">{translateUiText(state.appSettings.warning)}</div>
      ) : null}
      <SettingsGroups>
        {SELF_UPDATE_ENABLED ? (
          <SettingsGroup>
            <SettingsRow
              def={SETTINGS_ROWS.applicationUpdate}
              description={t("settings:versionStatus", { current: update?.currentVersion ?? appVersion, latest: update?.latestVersion ?? t("common:unknown"), status: update?.status ?? t("settings:notCheckedYet"), error: update?.error ? `. ${update.error}` : "" })}
            >
              <SettingsActionButton
                disabled={isUpdating || update?.status === "checking"}
                prominent={update?.updateAvailable}
                onClick={() => {
                  void (update?.updateAvailable
                    ? state.handleInstallUpdate()
                    : state.handleCheckForUpdates({ force: true }))
                }}
              >
                {updateActionLabel}
              </SettingsActionButton>
            </SettingsRow>
          </SettingsGroup>
        ) : null}
        {(
          <SettingsGroup title={t("settings:appearance")}>
            <SettingsRow def={SETTINGS_ROWS.language}>
              <SettingsSelect
                aria-label={t("settings:language")}
                value={state.appSettings?.language ?? "system"}
                onValueChange={(value) => { void save({ language: value as AppLanguagePreference }) }}
              >
                <SelectItem value="system">System</SelectItem>
                <SelectItem value="en">English</SelectItem>
                <SelectItem value="zh-CN">简体中文</SelectItem>
              </SettingsSelect>
            </SettingsRow>
            <SettingsRow def={SETTINGS_ROWS.theme}>
              <SettingsSelect
                aria-label={t("settings:theme")}
                value={state.appSettings?.theme ?? "system"}
                onValueChange={(value) => {
                  void save({ theme: value as AppThemePreference })
                }}
              >
                <SelectItem value="system">{t("settings:system")}</SelectItem>
                <SelectItem value="light">{t("settings:light")}</SelectItem>
                <SelectItem value="dark">{t("settings:dark")}</SelectItem>
              </SettingsSelect>
            </SettingsRow>
          </SettingsGroup>
        )}
        <SettingsGroup title={t("settings:notifications")}>
          <SettingsRow def={SETTINGS_ROWS.chatSounds}>
            <SettingsSelect
              aria-label={t("settings:chatSounds")}
              value={sounds.chatSoundPreference}
              onValueChange={(value) => changeSound(value as ChatSoundPreference)}
            >
              {notificationOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SettingsSelect>
          </SettingsRow>
          <SettingsRow def={SETTINGS_ROWS.chatSound}>
            <SettingsSelect
              aria-label={t("settings:soundEffect")}
              value={sounds.chatSoundId}
              onValueChange={(value) => changeSoundId(value as ChatSoundId)}
            >
              {CHAT_SOUND_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SettingsSelect>
          </SettingsRow>
          <SettingsRow
            def={SETTINGS_ROWS.chatBrowserNotifications}
            description={getChatBrowserNotificationDescription(permission)}
          >
            <SettingsSelect
              aria-label={t("settings:systemNotifications")}
              value={state.appSettings?.chatBrowserNotificationPreference ?? "never"}
              onValueChange={(value) => {
                void changeNotifications(value as ChatSoundPreference)
              }}
            >
              {notificationOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SettingsSelect>
          </SettingsRow>
        </SettingsGroup>
        <SettingsGroup title={t("settings:chats")}>
          <SettingsRow def={SETTINGS_ROWS.submitWhileRunning}>
            <SettingsSelect
              aria-label={t("settings:enterWhileRunning")}
              value={state.appSettings?.submitWhileRunning ?? "queue"}
              onValueChange={(value) => {
                void save({ submitWhileRunning: value as SubmitWhileRunning })
              }}
            >
              <SelectItem value="queue">{t("settings:queue")}</SelectItem>
              <SelectItem value="steer">{t("settings:steer")}</SelectItem>
            </SettingsSelect>
          </SettingsRow>
        </SettingsGroup>
        <SettingsGroup title={t("settings:editor")}>
          <SettingsRow def={SETTINGS_ROWS.defaultEditor}>
            <SettingsSelect
              aria-label={t("settings:defaultEditor")}
              value={terminal.editorPreset}
              onValueChange={(value) => {
                terminal.setEditorPreset(value as EditorPreset)
                void save({
                  editor: {
                    preset: value as EditorPreset,
                    commandTemplate:
                      value === "custom"
                        ? terminal.editorCommandTemplate
                        : getDefaultEditorCommandTemplate(value as EditorPreset),
                  },
                })
              }}
            >
              {editorPresets.map((preset) => (
                <SelectItem key={preset} value={preset}>
                  {getEditorPresetLabel(preset)}
                </SelectItem>
              ))}
            </SettingsSelect>
          </SettingsRow>
          {terminal.editorPreset === "custom" ? (
            <SettingsRow
              def={SETTINGS_ROWS.editorCommandTemplate}
              nested
              wideControl
            >
              <SettingsField
                hint={
                  <>
                    {t("settings:previewLabel")}
                    <span className="font-mono">
                      {editorDraft
                        .replaceAll("{path}", "/path/to/project")
                        .replaceAll("{line}", "1")
                        .replaceAll("{column}", "1")}
                    </span>
                  </>
                }
              >
                <Input
                  aria-label={t("settings:commandTemplate")}
                  value={editorDraft}
                  onChange={(event) => setEditorDraft(event.target.value)}
                  onBlur={commitEditor}
                  onKeyDown={(event) => handleSettingsInputKeyDown(event, commitEditor)}
                  spellCheck={false}
                  autoComplete="off"
                  className={`${SETTINGS_CONTROL_CLASS} font-mono @2xl:w-80`}
                />
              </SettingsField>
            </SettingsRow>
          ) : null}
        </SettingsGroup>
        <SettingsGroup title={t("settings:terminal")}>
          <SettingsRow def={SETTINGS_ROWS.terminalScrollback} wideControl>
            <SettingsField
              hint={t("settings:value0Value1LinesValue2", { v0: MIN_TERMINAL_SCROLLBACK, v1: MAX_TERMINAL_SCROLLBACK, v2: terminal.scrollbackLines === DEFAULT_TERMINAL_SCROLLBACK ? t("settings:defaultHint") : "" })}
            >
              <Input
                aria-label={t("settings:terminalScrollback")}
                type="number"
                min={MIN_TERMINAL_SCROLLBACK}
                max={MAX_TERMINAL_SCROLLBACK}
                step={100}
                value={scrollbackDraft}
                onChange={(event) => setScrollbackDraft(event.target.value)}
                onBlur={commitScrollback}
                onKeyDown={(event) => handleSettingsInputKeyDown(event, commitScrollback)}
                className={SETTINGS_NUMBER_INPUT_CLASS}
              />
            </SettingsField>
          </SettingsRow>
          <SettingsRow def={SETTINGS_ROWS.terminalMinColumnWidth} wideControl>
            <SettingsField
              hint={t("settings:value0Value1PxValue2", { v0: MIN_TERMINAL_MIN_COLUMN_WIDTH, v1: MAX_TERMINAL_MIN_COLUMN_WIDTH, v2: terminal.minColumnWidth === DEFAULT_TERMINAL_MIN_COLUMN_WIDTH ? t("settings:defaultHint") : "" })}
            >
              <Input
                aria-label={t("settings:terminalMinColumnWidth")}
                type="number"
                min={MIN_TERMINAL_MIN_COLUMN_WIDTH}
                max={MAX_TERMINAL_MIN_COLUMN_WIDTH}
                step={10}
                value={widthDraft}
                onChange={(event) => setWidthDraft(event.target.value)}
                onBlur={commitWidth}
                onKeyDown={(event) => handleSettingsInputKeyDown(event, commitWidth)}
                className={SETTINGS_NUMBER_INPUT_CLASS}
              />
            </SettingsField>
          </SettingsRow>
        </SettingsGroup>
      </SettingsGroups>
    </>
  )
}
