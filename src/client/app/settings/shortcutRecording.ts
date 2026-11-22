import { chordFromKeyboardEvent, isRecordableChord, modifierChordFromEvent, parseModifiers } from "../../lib/keybindings"

interface ShortcutRecordingCallbacks {
  isModifierOnly: () => boolean
  commit: (chord: string) => void
  stop: () => void
  remove: () => void
  setModifiers: (modifiers: string | null) => void
  setCodes: (codes: Set<string>) => void
  clearError: () => void
  needsModifier: () => void
}

export function createShortcutRecordingHandlers(callbacks: ShortcutRecordingCallbacks) {
  let largest: string | null = null
  let held = new Set<string>()
  const modifierKeys = new Set(["Meta", "Control", "Alt", "Shift"])

  function keydown(event: KeyboardEvent) {
    event.preventDefault()
    event.stopPropagation()
    if (event.repeat || event.isComposing || event.keyCode === 229) return
    // Windows reports AltGr as Ctrl+Alt and sends Ctrl before AltGr.
    if (event.key === "AltGraph" || event.getModifierState?.("AltGraph")) {
      largest = null
      held = new Set()
      callbacks.setModifiers(null)
      callbacks.setCodes(new Set())
      return
    }
    callbacks.clearError()
    held.add(event.code)
    callbacks.setCodes(new Set(held))
    const currentModifiers = modifierChordFromEvent(event)
    callbacks.setModifiers(currentModifiers)
    if (currentModifiers && (!largest || currentModifiers.split("+").length > largest.split("+").length)) largest = currentModifiers
    if (!currentModifiers && event.key === "Escape") return callbacks.stop()
    if (!currentModifiers && (event.key === "Backspace" || event.key === "Delete")) {
      callbacks.remove()
      return callbacks.stop()
    }
    if (callbacks.isModifierOnly()) return
    const chord = chordFromKeyboardEvent(event)
    if (!chord) return
    if (!isRecordableChord(chord)) return callbacks.needsModifier()
    callbacks.commit(chord)
  }

  function keyup(event: KeyboardEvent) {
    if (event.key === "AltGraph" || event.getModifierState?.("AltGraph")) return
    held.delete(event.code)
    callbacks.setCodes(new Set(held))
    callbacks.setModifiers(modifierChordFromEvent(event))
    if (callbacks.isModifierOnly() && modifierKeys.has(event.key) && largest) {
      const chord = largest
      largest = null
      const modifiers = parseModifiers(chord)
      if (!modifiers.ctrl && !modifiers.meta && !modifiers.alt) return callbacks.needsModifier()
      callbacks.commit(chord)
    }
  }

  return { keydown, keyup }
}
