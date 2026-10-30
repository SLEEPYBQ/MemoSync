import { translateUiText } from "../../i18n/uiText"
import { Trans } from "react-i18next"
import { t, useI18n } from "../../i18n"
import { useEffect, useMemo, useState } from "react"
import { DEFAULT_KEYBINDINGS, type KeybindingAction } from "../../../shared/types"
import { Input } from "../../components/ui/input"
import {
  KEYBINDING_ACTION_LABELS,
  formatKeybindingInput,
  getResolvedKeybindings,
  parseKeybindingInput,
} from "../../lib/keybindings"
import type { AppState } from "../useAppState"
import { KEYBINDING_ROWS } from "./registry"
import { cn } from "../../lib/utils"
import {
  handleSettingsInputKeyDown,
  SETTINGS_CONTROL_CLASS,
  SETTINGS_INLINE_ACTION_CLASS,
  SettingsErrorBanner,
  SettingsGroup,
  SettingsNotice,
  SettingsRow,
} from "./shared"

const KEYBINDING_ACTIONS = (Object.keys(KEYBINDING_ACTION_LABELS) as KeybindingAction[]).filter(
  (action) => action !== "openInEditor",
)

function buildKeybindingPayload(source: Record<string, string>): Record<KeybindingAction, string[]> {
  return {
    toggleEmbeddedTerminal: parseKeybindingInput(source.toggleEmbeddedTerminal ?? ""),
    toggleLeftSidebar: parseKeybindingInput(source.toggleLeftSidebar ?? ""),
    toggleRightSidebar: parseKeybindingInput(source.toggleRightSidebar ?? ""),
    openInFinder: parseKeybindingInput(source.openInFinder ?? ""),
    openInEditor: parseKeybindingInput(source.openInEditor ?? ""),
    addSplitTerminal: parseKeybindingInput(source.addSplitTerminal ?? ""),
    jumpToSidebarChat: parseKeybindingInput(source.jumpToSidebarChat ?? ""),
    createChatInCurrentProject: parseKeybindingInput(source.createChatInCurrentProject ?? ""),
    openAddProject: parseKeybindingInput(source.openAddProject ?? ""),
  }
}

export function KeybindingsSection({ state }: { state: Pick<AppState, "keybindings" | "socket"> }) {
  useI18n()
  const resolvedKeybindings = useMemo(() => getResolvedKeybindings(state.keybindings), [state.keybindings])
  const [keybindingDrafts, setKeybindingDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      KEYBINDING_ACTIONS.map((action) => [action, formatKeybindingInput(resolvedKeybindings.bindings[action])]),
    ),
  )
  const [keybindingsError, setKeybindingsError] = useState<string | null>(null)

  useEffect(() => {
    setKeybindingDrafts(
      Object.fromEntries(
        KEYBINDING_ACTIONS.map((action) => [action, formatKeybindingInput(resolvedKeybindings.bindings[action])]),
      ),
    )
  }, [resolvedKeybindings])

  async function commitKeybindings() {
    try {
      setKeybindingsError(null)
      await state.socket.command({
        type: "settings.writeKeybindings",
        bindings: buildKeybindingPayload(keybindingDrafts),
      })
    } catch (error) {
      setKeybindingsError(error instanceof Error ? error.message : t("settings:unableToSaveKeybindings"))
    }
  }

  async function restoreDefaultKeybinding(action: keyof typeof KEYBINDING_ACTION_LABELS) {
    const nextDrafts = {
      ...keybindingDrafts,
      [action]: formatKeybindingInput(DEFAULT_KEYBINDINGS[action]),
    }
    setKeybindingDrafts(nextDrafts)

    try {
      setKeybindingsError(null)
      await state.socket.command({
        type: "settings.writeKeybindings",
        bindings: buildKeybindingPayload(nextDrafts),
      })
    } catch (error) {
      setKeybindingsError(error instanceof Error ? error.message : t("settings:unableToSaveKeybindings"))
    }
  }

  return (
    <>
      {keybindingsError ? <SettingsErrorBanner message={translateUiText(keybindingsError)} /> : null}
      {resolvedKeybindings.warning ? (
        <SettingsNotice tone="warning" className="mb-6">
          {translateUiText(resolvedKeybindings.warning)}
        </SettingsNotice>
      ) : null}
      <SettingsGroup title={t("settings:commaSeparatedShortcuts")}>
        {KEYBINDING_ACTIONS.map((action) => {
          const defaultValue = formatKeybindingInput(DEFAULT_KEYBINDINGS[action])
          const currentValue = keybindingDrafts[action] ?? ""
          const showRestore = currentValue !== defaultValue

          return (
            <SettingsRow
              key={action}
              wideControl
              def={KEYBINDING_ROWS[action]}
              description={
                showRestore ? (
                  <button
                    type="button"
                    onClick={() => {
                      void restoreDefaultKeybinding(action)
                    }}
                    className={SETTINGS_INLINE_ACTION_CLASS}
                  >
                    <Trans ns="settings" i18nKey="resetShortcut" values={{ shortcut: defaultValue }} components={{ code: <code className="font-mono" /> }} />
                  </button>
                ) : null
              }
            >
              <Input
                type="text"
                value={currentValue}
                onChange={(event) => {
                  const nextValue = event.target.value
                  setKeybindingDrafts((current) => ({ ...current, [action]: nextValue }))
                }}
                onBlur={() => {
                  void commitKeybindings()
                }}
                onKeyDown={(event) =>
                  handleSettingsInputKeyDown(event, () => {
                    void commitKeybindings()
                  })
                }
                spellCheck={false}
                autoComplete="off"
                className={cn(SETTINGS_CONTROL_CLASS, "font-mono")}
              />
            </SettingsRow>
          )
        })}
      </SettingsGroup>
    </>
  )
}
