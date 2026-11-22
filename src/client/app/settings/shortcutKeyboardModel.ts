import type { KeybindingAction } from "../../../shared/types"
import { keyToCode, parseBinding, parseModifiers, preferredBinding } from "../../lib/keybindings"

export type ShortcutCategory = "panels" | "terminal" | "workspace"
export type KeyboardKey = { code: string; label: string; width: number }
export type KeyUsage = { action: KeybindingAction; binding: string }

export const SHORTCUT_CATEGORY_BY_ACTION: Partial<Record<KeybindingAction, ShortcutCategory>> = {
  toggleLeftSidebar: "panels",
  toggleRightSidebar: "panels",
  toggleEmbeddedTerminal: "terminal",
  addSplitTerminal: "terminal",
  jumpToSidebarChat: "workspace",
  createChatInCurrentProject: "workspace",
  openAddProject: "workspace",
  openInFinder: "workspace",
}

const key = (code: string, label: string, width = 1): KeyboardKey => ({ code, label, width })
const letters = (text: string) => [...text].map((letter) => key(`Key${letter}`, letter))

export function getKeyboardRows(apple: boolean): KeyboardKey[][] {
  return [
    [key("Backquote", "`"), ...[..."1234567890"].map((n) => key(`Digit${n}`, n)), key("Minus", "-"), key("Equal", "="), key("Backspace", "⌫", 2)],
    [key("Tab", "Tab", 1.5), ...letters("QWERTYUIOP"), key("BracketLeft", "["), key("BracketRight", "]"), key("Backslash", "\\", 1.5)],
    [key("CapsLock", "Caps", 1.75), ...letters("ASDFGHJKL"), key("Semicolon", ";"), key("Quote", "'"), key("Enter", "↵", 2.25)],
    [key("ShiftLeft", "Shift", 2.25), ...letters("ZXCVBNM"), key("Comma", ","), key("Period", "."), key("Slash", "/"), key("ShiftRight", "Shift", 2.75)],
    [
      key("ControlLeft", apple ? "⌃" : "Ctrl", 1.25),
      ...(apple ? [key("AltLeft", "⌥", 1.25), key("MetaLeft", "⌘", 1.25)] : [key("MetaLeft", "Win", 1.25), key("AltLeft", "Alt", 1.25)]),
      key("Space", "Space", 6.25),
      apple ? key("MetaRight", "⌘", 1.25) : key("AltRight", "Alt", 1.25),
      key("Spacer", "", 0.75), key("ArrowLeft", "←"), key("ArrowStack", "↑↓"), key("ArrowRight", "→"),
    ],
  ]
}

function layoutCode(key: string): string | null {
  const special: Record<string, string> = {
    arrowleft: "ArrowLeft", arrowright: "ArrowRight", arrowup: "ArrowUp", arrowdown: "ArrowDown",
    enter: "Enter", tab: "Tab", backspace: "Backspace", capslock: "CapsLock",
  }
  return keyToCode(key) ?? special[key] ?? null
}

const layoutCodes = new Set(getKeyboardRows(true).flat().flatMap(({ code }) => (
  code === "ArrowStack" ? ["ArrowUp", "ArrowDown"] : [code]
)))

export function buildKeyUsage(bindings: Record<KeybindingAction, string[]>, actions: readonly KeybindingAction[]) {
  const usage = new Map<string, KeyUsage[]>()
  for (const action of actions) {
    for (const binding of bindings[action]) {
      const codes = action === "jumpToSidebarChat"
        ? Array.from({ length: 9 }, (_, index) => `Digit${index + 1}`)
        : [layoutCode(parseBinding(binding)?.key ?? "")]
      for (const code of codes) {
        if (!code || !layoutCodes.has(code)) continue
        usage.set(code, [...(usage.get(code) ?? []), { action, binding }])
      }
    }
  }
  return usage
}

export function bindingForKey(usage: Map<string, KeyUsage[]>, code: string, apple: boolean): KeyUsage | null {
  const entries = usage.get(code) ?? []
  const action = entries[0]?.action
  if (!action) return null
  const binding = preferredBinding(entries.filter((entry) => entry.action === action).map((entry) => entry.binding), apple)
  return binding === null ? null : { action, binding }
}

export function chordCodes(binding: string, _apple: boolean): string[] {
  const tokens = binding.split("+").map((part) => part.trim().toLowerCase())
  const codes: string[] = []
  if (tokens.some((token) => token === "cmd" || token === "meta")) codes.push("MetaLeft")
  if (tokens.some((token) => token === "ctrl" || token === "control")) codes.push("ControlLeft")
  if (tokens.some((token) => token === "alt" || token === "option")) codes.push("AltLeft")
  if (tokens.includes("shift")) codes.push("ShiftLeft")
  const parsed = parseBinding(binding)
  if (parsed) {
    const code = layoutCode(parsed.key)
    if (code && layoutCodes.has(code)) codes.push(code)
  } else if (codes.length && tokens.every((token) => ["cmd", "meta", "ctrl", "control", "alt", "option", "shift"].includes(token))) {
    codes.push(...Array.from({ length: 9 }, (_, index) => `Digit${index + 1}`))
  }
  return codes
}

export function findBindingConflict(
  bindings: Record<KeybindingAction, string[]>,
  action: KeybindingAction,
  chord: string,
): KeybindingAction | null {
  const incomingKeyed = action === "jumpToSidebarChat" ? null : parseBinding(chord)
  const incoming = action === "jumpToSidebarChat" ? parseModifiers(chord) : incomingKeyed
  if (!incoming) return null
  return (Object.keys(SHORTCUT_CATEGORY_BY_ACTION) as KeybindingAction[]).find((other) => {
    if (other === action) return false
    return bindings[other].some((binding) => {
      const existingKeyed = other === "jumpToSidebarChat" ? null : parseBinding(binding)
      const existing = other === "jumpToSidebarChat" ? parseModifiers(binding) : existingKeyed
      if (!existing || incoming.ctrl !== existing.ctrl || incoming.meta !== existing.meta
        || incoming.alt !== existing.alt || incoming.shift !== existing.shift) return false
      if (action === "jumpToSidebarChat") return /^[1-9]$/.test(existingKeyed?.key ?? "")
      if (other === "jumpToSidebarChat") return /^[1-9]$/.test(incomingKeyed?.key ?? "")
      return incomingKeyed?.key === existingKeyed?.key
    })
  }) ?? null
}
