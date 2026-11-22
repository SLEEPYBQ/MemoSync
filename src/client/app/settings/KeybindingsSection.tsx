import { Trans } from "react-i18next"
import { useEffect, useMemo, useRef, useState } from "react"
import { useReducedMotion } from "motion/react"
import { DEFAULT_KEYBINDINGS, type KeybindingAction, type KeybindingsSnapshot } from "../../../shared/types"
import { t, useI18n } from "../../i18n"
import { translateUiText } from "../../i18n/uiText"
import { formatBindingParts, getResolvedKeybindings, isApplePlatform, KEYBINDING_ACTION_LABELS, preferredBinding } from "../../lib/keybindings"
import type { AppState } from "../useAppState"
import { KEYBINDING_ROWS } from "./registry"
import { ShortcutKeyboard, ShortcutCategoryDot } from "./ShortcutKeyboard"
import { ShortcutRecorder } from "./ShortcutRecorder"
import { buildKeyUsage, chordCodes, findBindingConflict } from "./shortcutKeyboardModel"
import { SETTINGS_INLINE_ACTION_CLASS, SettingsErrorBanner, SettingsGroup, SettingsNotice, SettingsRow } from "./shared"

const KEYBINDING_ACTIONS = Object.keys(KEYBINDING_ROWS) as Array<Exclude<KeybindingAction, "openInEditor">>

export function KeybindingsSection({ state, appleOverride }: { state: Pick<AppState, "keybindings" | "socket">; appleOverride?: boolean }) {
  useI18n()
  const detectedApple = useMemo(isApplePlatform, [])
  const apple = appleOverride ?? detectedApple
  const reduced = useReducedMotion()
  const resolved = useMemo(() => getResolvedKeybindings(state.keybindings), [state.keybindings])
  const [drafts, setDrafts] = useState<Record<KeybindingAction, string[]>>(resolved.bindings)
  const [error, setError] = useState<string | null>(null)
  const [recording, setRecording] = useState<{ action: KeybindingAction; index: number | "new" } | null>(null)
  const [hoveredCode, setHoveredCode] = useState<string | null>(null)
  const [hoveredAction, setHoveredAction] = useState<KeybindingAction | null>(null)
  const [rowFocus, setRowFocus] = useState<KeybindingAction | null>(null)
  const [pressedCodes, setPressedCodes] = useState<Set<string>>(new Set())
  const [recordedCodes, setRecordedCodes] = useState<Set<string>>(new Set())
  const latestSnapshot = useRef(resolved.bindings)
  const draftsRef = useRef(drafts)
  const pendingWrites = useRef(0)
  const writeQueue = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    latestSnapshot.current = resolved.bindings
    if (pendingWrites.current === 0) {
      draftsRef.current = resolved.bindings
      setDrafts(resolved.bindings)
    }
  }, [resolved])

  useEffect(() => {
    if (recording) {
      setPressedCodes(new Set())
      return
    }
    const down = (event: KeyboardEvent) => setPressedCodes((current) => new Set([...current, event.code]))
    const up = (event: KeyboardEvent) => setPressedCodes((current) => {
      // macOS sends no keyup for keys released while ⌘ is held.
      if (event.key === "Meta") return new Set()
      const next = new Set(current)
      next.delete(event.code)
      return next
    })
    const clear = () => setPressedCodes(new Set())
    window.addEventListener("keydown", down)
    window.addEventListener("keyup", up)
    window.addEventListener("blur", clear)
    return () => {
      window.removeEventListener("keydown", down)
      window.removeEventListener("keyup", up)
      window.removeEventListener("blur", clear)
    }
  }, [recording])

  const usage = useMemo(() => buildKeyUsage(drafts, KEYBINDING_ACTIONS), [drafts])
  const focusedAction = hoveredAction ?? rowFocus
  const previewAction = hoveredCode ? usage.get(hoveredCode)?.[0]?.action : focusedAction
  const previewBindings = hoveredCode && previewAction
    ? (usage.get(hoveredCode) ?? []).filter((entry) => entry.action === previewAction).map((entry) => entry.binding)
    : previewAction ? drafts[previewAction] : []
  const previewBinding = preferredBinding(previewBindings, apple)
  const activeCodes = recording ? [...recordedCodes] : previewBinding ? chordCodes(previewBinding, apple) : []

  function save(action: KeybindingAction, bindings: string[]) {
    const next = { ...draftsRef.current, [action]: bindings }
    draftsRef.current = next
    setDrafts(next)
    setError(null)
    pendingWrites.current += 1
    writeQueue.current = writeQueue.current.then(async () => {
      try {
        const snapshot = await state.socket.command<KeybindingsSnapshot>({ type: "settings.writeKeybindings", bindings: next })
        latestSnapshot.current = snapshot.bindings
        if (pendingWrites.current === 1) {
          draftsRef.current = snapshot.bindings
          setDrafts(snapshot.bindings)
        }
      } catch (saveError) {
        if (pendingWrites.current === 1) {
          draftsRef.current = latestSnapshot.current
          setDrafts(latestSnapshot.current)
          setError(saveError instanceof Error ? saveError.message : t("settings:unableToSaveKeybindings"))
        }
      } finally {
        pendingWrites.current -= 1
      }
    })
    return writeQueue.current
  }

  function pickAction(action: KeybindingAction) {
    document.getElementById(`keybinding-${action}`)?.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" })
    const binding = preferredBinding(drafts[action], apple)
    setRecording({ action, index: binding === null ? "new" : drafts[action].indexOf(binding) })
    setRecordedCodes(new Set())
  }

  return (
    <div className="shortcut-settings-ui">
      {error ? <SettingsErrorBanner message={translateUiText(error)} /> : null}
      {resolved.warning ? <SettingsNotice tone="warning" className="mb-6">{translateUiText(resolved.warning)}</SettingsNotice> : null}
      <ShortcutKeyboard bindings={drafts} actions={KEYBINDING_ACTIONS} apple={apple} activeCodes={activeCodes}
        pressedCodes={pressedCodes} onHoverKey={setHoveredCode} onPickAction={pickAction} focusedAction={focusedAction} />
      <SettingsGroup title={<span>{t("settings:customizeShortcuts")}<span className="mt-1 block text-xs font-normal leading-5 text-muted-foreground/80">{t("settings:shortcutRecordHint")}</span></span>}>
        {KEYBINDING_ACTIONS.map((action) => {
          const defaults = DEFAULT_KEYBINDINGS[action]
          const current = drafts[action]
          const showRestore = current.length !== defaults.length || current.some((binding, index) => binding !== defaults[index])
          const defaultLabel = defaults.map((binding) => formatBindingParts(binding, apple).join(" ")).join(", ")
          return (
            <div key={action}
              onMouseEnter={() => setHoveredAction(action)}
              onMouseLeave={() => setHoveredAction(null)}
              onFocus={() => setRowFocus(action)}
              onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setRowFocus(null) }}>
              <SettingsRow def={KEYBINDING_ROWS[action]} wideControl icon={<ShortcutCategoryDot action={action} />}
                description={showRestore ? (
                  <button type="button" onClick={() => void save(action, [...defaults])} className={SETTINGS_INLINE_ACTION_CLASS}>
                    <Trans ns="settings" i18nKey="resetShortcut" values={{ shortcut: defaultLabel }} components={{ code: <code className="font-mono" /> }} />
                  </button>
                ) : null}>
                <ShortcutRecorder action={action} label={KEYBINDING_ACTION_LABELS[action]} bindings={current} apple={apple}
                  recording={recording?.action === action ? recording.index : null}
                  onStartRecording={(index) => { setRecordedCodes(new Set()); setRecording({ action, index }) }}
                  onStopRecording={() => { setRecordedCodes(new Set()); setRecording(null) }}
                  onCommit={(next) => void save(action, next)}
                  conflictLabel={(chord) => {
                    const conflict = findBindingConflict(drafts, action, chord)
                    return conflict ? KEYBINDING_ACTION_LABELS[conflict] : null
                  }}
                  modifierOnly={action === "jumpToSidebarChat"}
                  onRecordingCodesChange={setRecordedCodes} />
              </SettingsRow>
            </div>
          )
        })}
      </SettingsGroup>
    </div>
  )
}
