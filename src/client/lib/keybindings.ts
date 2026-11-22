import { t } from "../i18n"
import { DEFAULT_KEYBINDINGS, type KeybindingAction, type KeybindingsSnapshot } from "../../shared/types"
import { MODIFIER_TOKENS, parseBinding } from "../../shared/keybinding-chords"

export { parseBinding, parseModifiers } from "../../shared/keybinding-chords"
export const KEYBINDING_ACTION_LABELS: Record<KeybindingAction, string> = {
  get toggleEmbeddedTerminal() { return t("settings:toggleEmbeddedTerminal") },
  get toggleLeftSidebar() { return t("settings:toggleLeftSidebar") },
  get toggleRightSidebar() { return t("settings:toggleRightSidebar") },
  get openInFinder() { return t("settings:openInFinder") },
  get openInEditor() { return t("settings:openInEditor") },
  get addSplitTerminal() { return t("settings:addSplitTerminal") },
  get jumpToSidebarChat() { return t("settings:jumpToSidebarChat") },
  get createChatInCurrentProject() { return t("settings:newChatInCurrentProject") },
  get openAddProject() { return t("settings:openAddProject") },
}

export function formatKeybindingInput(bindings: string[] | undefined) {
  return (bindings ?? []).join(", ")
}

export function parseKeybindingInput(value: string) {
  return value
    .split(",")
    .map((binding) => binding.trim())
    .map((binding) => binding.toLowerCase())
    .filter(Boolean)
}

type ModifierEvent = Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">
export type KeybindingEvent = ModifierEvent & Pick<KeyboardEvent, "code"> & Partial<Pick<KeyboardEvent, "key" | "getModifierState">>

export function legacySymbolChord(event: KeybindingEvent): string | null {
  if (event.getModifierState?.("AltGraph") || !event.key) return null
  const literal = event.key.toLowerCase()
  if (!/^[^\p{C}\s+]$/u.test(literal) || keyToCode(literal) !== null) return null
  const physical = codeToKey(event.code ?? "")
  if (!physical || physical === literal) return null
  return [modifierChordFromEvent(event), literal].filter(Boolean).join("+")
}

export function findLegacySymbolBinding(
  bindings: Record<KeybindingAction, string[]>,
  event: KeybindingEvent,
): { action: KeybindingAction; binding: string } | null {
  const chord = legacySymbolChord(event)
  if (!chord) return null
  const literal = parseBinding(chord)
  if (!literal) return null
  for (const action of Object.keys(bindings) as KeybindingAction[]) {
    if (action === "openInEditor" || action === "jumpToSidebarChat") continue
    for (const binding of bindings[action]) {
      const parsed = parseBinding(binding)
      if (parsed && parsed.key === literal.key && parsed.ctrl === literal.ctrl && parsed.meta === literal.meta
        && parsed.alt === literal.alt && parsed.shift === literal.shift) return { action, binding }
    }
  }
  return null
}

export function bindingMatchesEvent(binding: string, event: KeybindingEvent) {
  if (event.getModifierState?.("AltGraph")) return false
  const parsed = parseBinding(binding)
  if (!parsed) return false

  return (
    (eventMatchesParsedKey(event, parsed.key) || (legacySymbolChord(event) !== null && event.key?.toLowerCase() === parsed.key)) &&
    event.ctrlKey === parsed.ctrl &&
    event.metaKey === parsed.meta &&
    event.altKey === parsed.alt &&
    event.shiftKey === parsed.shift
  )
}

export function actionMatchesEvent(
  snapshot: KeybindingsSnapshot | null,
  action: KeybindingAction,
  event: KeybindingEvent
) {
  return findMatchingActionBinding(snapshot, action, event) !== null
}

export function findMatchingActionBinding(
  snapshot: KeybindingsSnapshot | null,
  action: KeybindingAction,
  event: KeybindingEvent
) {
  const owner = findLegacySymbolBinding(snapshot?.bindings ?? DEFAULT_KEYBINDINGS, event)
  if (owner) return owner.action === action ? owner.binding : null
  return getBindingsForAction(snapshot, action).find((binding) => bindingMatchesEvent(binding, event)) ?? null
}

export function getBindingsForAction(
  snapshot: KeybindingsSnapshot | null,
  action: KeybindingAction
) {
  return snapshot?.bindings[action] ?? DEFAULT_KEYBINDINGS[action]
}

export function getResolvedKeybindings(snapshot: KeybindingsSnapshot | null): KeybindingsSnapshot {
  return {
    bindings: {
      toggleEmbeddedTerminal: snapshot?.bindings.toggleEmbeddedTerminal ?? DEFAULT_KEYBINDINGS.toggleEmbeddedTerminal,
      toggleLeftSidebar: snapshot?.bindings.toggleLeftSidebar ?? DEFAULT_KEYBINDINGS.toggleLeftSidebar,
      toggleRightSidebar: snapshot?.bindings.toggleRightSidebar ?? DEFAULT_KEYBINDINGS.toggleRightSidebar,
      openInFinder: snapshot?.bindings.openInFinder ?? DEFAULT_KEYBINDINGS.openInFinder,
      openInEditor: snapshot?.bindings.openInEditor ?? DEFAULT_KEYBINDINGS.openInEditor,
      addSplitTerminal: snapshot?.bindings.addSplitTerminal ?? DEFAULT_KEYBINDINGS.addSplitTerminal,
      jumpToSidebarChat: snapshot?.bindings.jumpToSidebarChat ?? DEFAULT_KEYBINDINGS.jumpToSidebarChat,
      createChatInCurrentProject: snapshot?.bindings.createChatInCurrentProject ?? DEFAULT_KEYBINDINGS.createChatInCurrentProject,
      openAddProject: snapshot?.bindings.openAddProject ?? DEFAULT_KEYBINDINGS.openAddProject,
    },
    warning: snapshot?.warning ?? null,
    filePathDisplay: snapshot?.filePathDisplay ?? "",
  }
}

function eventMatchesParsedKey(event: KeybindingEvent, key: string) {
  return (codeToKey(event.code ?? "") ?? event.key?.toLowerCase()) === key
}

export function keyToCode(key: string): string | null {
  if (key.length === 1 && key >= "a" && key <= "z") {
    return `Key${key.toUpperCase()}`
  }
  if (key.length === 1 && key >= "0" && key <= "9") {
    return `Digit${key}`
  }

  switch (key) {
    case "/":
      return "Slash"
    case "`":
      return "Backquote"
    case "-": return "Minus"
    case "=": return "Equal"
    case "[": return "BracketLeft"
    case "]": return "BracketRight"
    case "\\": return "Backslash"
    case ";": return "Semicolon"
    case "'": return "Quote"
    case ",": return "Comma"
    case ".": return "Period"
    case "space": return "Space"
    default:
      return null
  }
}

export function codeToKey(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  const codes: Record<string, string> = {
    Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
    Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".",
    Backquote: "`", Slash: "/", Space: "space",
  }
  return codes[code] ?? null
}

export function modifierChordFromEvent(event: ModifierEvent): string | null {
  const parts = [
    event.metaKey && "cmd",
    event.ctrlKey && "ctrl",
    event.altKey && "alt",
    event.shiftKey && "shift",
  ].filter(Boolean)
  return parts.length ? parts.join("+") : null
}

export function chordFromKeyboardEvent(
  event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
): string | null {
  if (["Meta", "Control", "Alt", "AltGraph", "Shift", "CapsLock", "Dead", "Process", "Unidentified"].includes(event.key)) return null
  const key = codeToKey(event.code) ?? event.key.toLowerCase()
  if (!key.trim() || key === "+") return null
  return [modifierChordFromEvent(event), key].filter(Boolean).join("+")
}

export function isRecordableChord(chord: string): boolean {
  const parsed = parseBinding(chord)
  return Boolean(parsed && (parsed.meta || parsed.ctrl || parsed.alt || /^f(?:[1-9]|1[0-2])$/.test(parsed.key)))
}

export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform
  return /mac|iphone|ipad/i.test(platform)
}

export function formatBindingParts(binding: string, apple: boolean): string[] {
  const tokens = binding.split("+").map((part) => part.trim()).filter(Boolean)
  const parsed = parseBinding(binding)
  if (!parsed && (!tokens.length || tokens.some((token) => !MODIFIER_TOKENS.has(token.toLowerCase())))) return [binding]

  return tokens.map((token) => {
    const value = token.toLowerCase()
    const modifier = MODIFIER_TOKENS.get(value)
    if (modifier === "meta") return apple ? "⌘" : "Win"
    if (modifier === "ctrl") return apple ? "⌃" : "Ctrl"
    if (modifier === "alt") return apple ? "⌥" : "Alt"
    if (modifier === "shift") return apple ? "⇧" : "Shift"
    if (/^[a-z]$/.test(value)) return value.toUpperCase()
    if (/^f\d+$/.test(value)) return value.toUpperCase()
    const labels: Record<string, string> = {
      space: "Space", arrowleft: "←", arrowright: "→", arrowup: "↑", arrowdown: "↓",
      enter: "↵", escape: "Esc", backspace: "⌫", tab: "Tab",
    }
    return labels[value] ?? token
  })
}

export function preferredBinding(bindings: string[], apple: boolean): string | null {
  return bindings.find((binding) => binding.split("+").some((part) => /^(cmd|meta)$/i.test(part.trim())) === apple)
    ?? bindings[0]
    ?? null
}
