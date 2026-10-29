import { useEffect, useState } from "react"
import { SELF_UPDATE_ENABLED } from "../../../shared/branding"
import type { AppSettingsPatch, ChatSoundId, ChatSoundPreference, EditorPreset, SubmitWhileRunning, AppThemePreference } from "../../../shared/types"
import { Input } from "../../components/ui/input"
import { SelectItem } from "../../components/ui/select"
import { useConditionPolicy } from "../../lib/conditionApi"
import { playChatNotificationSound } from "../../lib/chatSounds"
import { getChatBrowserNotificationPermission, requestChatBrowserNotificationPermission, getChatBrowserNotificationDescription } from "../../lib/chatBrowserNotifications"
import { CHAT_SOUND_OPTIONS, useChatSoundPreferencesStore } from "../../stores/chatSoundPreferencesStore"
import { DEFAULT_TERMINAL_SCROLLBACK, MIN_TERMINAL_SCROLLBACK, MAX_TERMINAL_SCROLLBACK, DEFAULT_TERMINAL_MIN_COLUMN_WIDTH, MIN_TERMINAL_MIN_COLUMN_WIDTH, MAX_TERMINAL_MIN_COLUMN_WIDTH, getDefaultEditorCommandTemplate, getEditorPresetLabel, useTerminalPreferencesStore } from "../../stores/terminalPreferencesStore"
import type { AppState } from "../useAppState"
import { SETTINGS_ROWS } from "./registry"
import { SettingsActionButton, SettingsErrorBanner, SettingsField, SettingsGroup, SettingsGroups, SettingsRow, SettingsSelect, SETTINGS_CONTROL_CLASS, SETTINGS_NUMBER_INPUT_CLASS, handleSettingsInputKeyDown, resolveChatBrowserNotificationPreferenceAfterPermission, shouldPreviewChatSoundChange } from "./shared"

const notificationOptions = [{ value: "never", label: "Never" }, { value: "unfocused", label: "When Unfocused" }, { value: "always", label: "Always" }]
const editorPresets: EditorPreset[] = ["cursor", "vscode", "xcode", "windsurf", "custom"]
type GeneralState = Pick<AppState, "appSettings" | "handleWriteAppSettings" | "updateSnapshot" | "handleCheckForUpdates" | "handleInstallUpdate">

export function GeneralSection({ state, appVersion }: { state: GeneralState; appVersion: string }) {
  const policy = useConditionPolicy()
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
    try { setError(null); await state.handleWriteAppSettings(patch) }
    catch (error) { setError(error instanceof Error ? error.message : "Unable to save settings.") }
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
      const nextPermission = value === "never" ? getChatBrowserNotificationPermission() : await requestChatBrowserNotificationPermission()
      setPermission(nextPermission)
      await save({ chatBrowserNotificationPreference: resolveChatBrowserNotificationPreferenceAfterPermission(value, nextPermission) })
    } catch { setError("Unable to request notifications. Check this site's notification permission in browser site settings.") }
  }
  function commitScrollback() {
    if (!scrollbackDraft.trim() || !Number.isFinite(Number(scrollbackDraft))) { setScrollbackDraft(String(terminal.scrollbackLines)); return }
    terminal.setScrollbackLines(Number(scrollbackDraft))
    void save({ terminal: { scrollbackLines: useTerminalPreferencesStore.getState().scrollbackLines } })
  }
  function commitWidth() {
    if (!widthDraft.trim() || !Number.isFinite(Number(widthDraft))) { setWidthDraft(String(terminal.minColumnWidth)); return }
    terminal.setMinColumnWidth(Number(widthDraft))
    void save({ terminal: { minColumnWidth: useTerminalPreferencesStore.getState().minColumnWidth } })
  }
  function commitEditor() {
    terminal.setEditorCommandTemplate(editorDraft)
    void save({ editor: { commandTemplate: useTerminalPreferencesStore.getState().editorCommandTemplate } })
  }
  const update = state.updateSnapshot
  const isUpdating = update?.status === "updating" || update?.status === "restart_pending"
  return <>
    {error ? <SettingsErrorBanner message={error} /> : null}
    {state.appSettings?.warning ? <div className="mb-6 px-[17px] text-sm text-muted-foreground">{state.appSettings.warning}</div> : null}
    <SettingsGroups>
      {SELF_UPDATE_ENABLED ? <SettingsGroup>
        <SettingsRow def={SETTINGS_ROWS.applicationUpdate} description={`Current: ${update?.currentVersion ?? appVersion}. Latest: ${update?.latestVersion ?? "Unknown"}. ${update?.status ?? "Not checked yet"}${update?.error ? `. ${update.error}` : ""}`}>
          <SettingsActionButton disabled={isUpdating || update?.status === "checking"} prominent={update?.updateAvailable} onClick={() => { void (update?.updateAvailable ? state.handleInstallUpdate() : state.handleCheckForUpdates({ force: true })) }}>
            {isUpdating ? "Updating…" : update?.status === "checking" ? "Checking…" : update?.updateAvailable ? "Update" : "Check for updates"}
          </SettingsActionButton>
        </SettingsRow>
      </SettingsGroup> : null}
      {!policy.studyMode ? <SettingsGroup title="Appearance">
        <SettingsRow def={SETTINGS_ROWS.theme}>
          <SettingsSelect aria-label="Theme" value={state.appSettings?.theme ?? "system"} onValueChange={(value) => { void save({ theme: value as AppThemePreference }) }}>
            <SelectItem value="system">System</SelectItem><SelectItem value="light">Light</SelectItem><SelectItem value="dark">Dark</SelectItem>
          </SettingsSelect>
        </SettingsRow>
      </SettingsGroup> : null}
      <SettingsGroup title="Notifications">
        <SettingsRow def={SETTINGS_ROWS.chatSounds}>
          <SettingsSelect aria-label="Chat Sounds" value={sounds.chatSoundPreference} onValueChange={(value) => changeSound(value as ChatSoundPreference)}>
            {notificationOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
          </SettingsSelect>
        </SettingsRow>
        <SettingsRow def={SETTINGS_ROWS.chatSound}>
          <SettingsSelect aria-label="Sound Effect" value={sounds.chatSoundId} onValueChange={(value) => changeSoundId(value as ChatSoundId)}>
            {CHAT_SOUND_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
          </SettingsSelect>
        </SettingsRow>
        <SettingsRow def={SETTINGS_ROWS.chatBrowserNotifications} description={getChatBrowserNotificationDescription(permission)}>
          <SettingsSelect aria-label="System Notifications" value={state.appSettings?.chatBrowserNotificationPreference ?? "never"} onValueChange={(value) => { void changeNotifications(value as ChatSoundPreference) }}>
            {notificationOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
          </SettingsSelect>
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="Chats">
        <SettingsRow def={SETTINGS_ROWS.submitWhileRunning}>
          <SettingsSelect aria-label="Enter While Running" value={state.appSettings?.submitWhileRunning ?? "queue"} onValueChange={(value) => { void save({ submitWhileRunning: value as SubmitWhileRunning }) }}>
            <SelectItem value="queue">Queue</SelectItem><SelectItem value="steer">Steer</SelectItem>
          </SettingsSelect>
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="Editor">
        <SettingsRow def={SETTINGS_ROWS.defaultEditor}>
          <SettingsSelect aria-label="Default Editor" value={terminal.editorPreset} onValueChange={(value) => {
            terminal.setEditorPreset(value as EditorPreset)
            void save({ editor: { preset: value as EditorPreset, commandTemplate: value === "custom" ? terminal.editorCommandTemplate : getDefaultEditorCommandTemplate(value as EditorPreset) } })
          }}>
            {editorPresets.map((preset) => <SelectItem key={preset} value={preset}>{getEditorPresetLabel(preset)}</SelectItem>)}
          </SettingsSelect>
        </SettingsRow>
        {terminal.editorPreset === "custom" ? <SettingsRow def={SETTINGS_ROWS.editorCommandTemplate} nested wideControl>
          <SettingsField hint={<>Preview: <span className="font-mono">{editorDraft.replaceAll("{path}", "/path/to/project").replaceAll("{line}", "1").replaceAll("{column}", "1")}</span></>}>
            <Input aria-label="Command Template" value={editorDraft} onChange={(event) => setEditorDraft(event.target.value)} onBlur={commitEditor} onKeyDown={(event) => handleSettingsInputKeyDown(event, commitEditor)} spellCheck={false} autoComplete="off" className={`${SETTINGS_CONTROL_CLASS} font-mono @2xl:w-80`} />
          </SettingsField>
        </SettingsRow> : null}
      </SettingsGroup>
      <SettingsGroup title="Terminal">
        <SettingsRow def={SETTINGS_ROWS.terminalScrollback} wideControl>
          <SettingsField hint={`${MIN_TERMINAL_SCROLLBACK}–${MAX_TERMINAL_SCROLLBACK} lines${terminal.scrollbackLines === DEFAULT_TERMINAL_SCROLLBACK ? " (default)" : ""}`}>
            <Input aria-label="Terminal Scrollback" type="number" min={MIN_TERMINAL_SCROLLBACK} max={MAX_TERMINAL_SCROLLBACK} step={100} value={scrollbackDraft} onChange={(event) => setScrollbackDraft(event.target.value)} onBlur={commitScrollback} onKeyDown={(event) => handleSettingsInputKeyDown(event, commitScrollback)} className={SETTINGS_NUMBER_INPUT_CLASS} />
          </SettingsField>
        </SettingsRow>
        <SettingsRow def={SETTINGS_ROWS.terminalMinColumnWidth} wideControl>
          <SettingsField hint={`${MIN_TERMINAL_MIN_COLUMN_WIDTH}–${MAX_TERMINAL_MIN_COLUMN_WIDTH} px${terminal.minColumnWidth === DEFAULT_TERMINAL_MIN_COLUMN_WIDTH ? " (default)" : ""}`}>
            <Input aria-label="Terminal Min Column Width" type="number" min={MIN_TERMINAL_MIN_COLUMN_WIDTH} max={MAX_TERMINAL_MIN_COLUMN_WIDTH} step={10} value={widthDraft} onChange={(event) => setWidthDraft(event.target.value)} onBlur={commitWidth} onKeyDown={(event) => handleSettingsInputKeyDown(event, commitWidth)} className={SETTINGS_NUMBER_INPUT_CLASS} />
          </SettingsField>
        </SettingsRow>
      </SettingsGroup>
    </SettingsGroups>
  </>
}
