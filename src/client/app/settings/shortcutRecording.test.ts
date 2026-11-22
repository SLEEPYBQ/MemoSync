import { describe, expect, mock, test } from "bun:test"
import { createShortcutRecordingHandlers } from "./shortcutRecording"

function keyboardEvent(key: string, code: string, overrides: Partial<KeyboardEvent> & { altGraph?: boolean } = {}) {
  const { altGraph = false, ...rest } = overrides
  return {
    key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false,
    repeat: false, isComposing: false, keyCode: 0,
    preventDefault: mock(() => {}),
    stopPropagation: mock(() => {}),
    getModifierState: (name: string) => name === "AltGraph" && altGraph,
    ...rest,
  } as KeyboardEvent
}

function recording(modifierOnly: boolean) {
  const commit = mock((_chord: string) => {})
  const stop = mock(() => {})
  const remove = mock(() => {})
  const setModifiers = mock((_modifiers: string | null) => {})
  const setCodes = mock((_codes: Set<string>) => {})
  const clearError = mock(() => {})
  const needsModifier = mock(() => {})
  const handlers = createShortcutRecordingHandlers({
    isModifierOnly: () => modifierOnly,
    commit, stop, remove, setModifiers, setCodes, clearError, needsModifier,
  })
  return { ...handlers, commit, stop, remove, setModifiers, setCodes, clearError, needsModifier }
}

describe("shortcut recording handlers", () => {
  test("discards an AltGr sequence and records genuine Ctrl+Alt in the same session", () => {
    const session = recording(true)
    const ctrlDown = keyboardEvent("Control", "ControlLeft", { ctrlKey: true })
    session.keydown(ctrlDown)
    session.keydown(keyboardEvent("AltGraph", "AltRight", { ctrlKey: true, altKey: true, altGraph: true }))
    session.keydown(keyboardEvent("@", "Digit2", { ctrlKey: true, altKey: true, altGraph: true }))
    session.keyup(keyboardEvent("@", "Digit2", { ctrlKey: true, altKey: true, altGraph: true }))
    session.keyup(keyboardEvent("AltGraph", "AltRight", { ctrlKey: true }))
    session.keyup(keyboardEvent("Control", "ControlLeft"))

    expect(ctrlDown.preventDefault).toHaveBeenCalledTimes(1)
    expect(ctrlDown.stopPropagation).toHaveBeenCalledTimes(1)
    expect(session.commit).not.toHaveBeenCalled()
    expect(session.stop).not.toHaveBeenCalled()
    expect(session.setModifiers.mock.lastCall?.[0]).toBeNull()
    expect(session.setCodes.mock.lastCall?.[0]).toEqual(new Set())

    session.keydown(keyboardEvent("Control", "ControlLeft", { ctrlKey: true }))
    session.keydown(keyboardEvent("Alt", "AltLeft", { ctrlKey: true, altKey: true }))
    session.keyup(keyboardEvent("Alt", "AltLeft", { ctrlKey: true }))
    session.keyup(keyboardEvent("Control", "ControlLeft"))
    expect(session.commit.mock.calls).toEqual([["ctrl+alt"]])
  })

  test("rejects Shift alone and records a valid modifier chord afterwards", () => {
    const session = recording(true)
    session.keydown(keyboardEvent("Shift", "ShiftLeft", { shiftKey: true }))
    session.keyup(keyboardEvent("Shift", "ShiftLeft"))
    expect(session.needsModifier).toHaveBeenCalledTimes(1)
    expect(session.commit).not.toHaveBeenCalled()
    session.keydown(keyboardEvent("Control", "ControlLeft", { ctrlKey: true }))
    session.keydown(keyboardEvent("Shift", "ShiftLeft", { ctrlKey: true, shiftKey: true }))
    session.keyup(keyboardEvent("Shift", "ShiftLeft", { ctrlKey: true }))
    expect(session.commit.mock.calls).toEqual([["ctrl+shift"]])
  })

  test("handles normal recording, invalid keys, cancellation and removal", () => {
    const session = recording(false)
    session.keydown(keyboardEvent("a", "KeyA"))
    expect(session.needsModifier).toHaveBeenCalledTimes(1)
    session.keydown(keyboardEvent("a", "KeyQ", { ctrlKey: true }))
    expect(session.commit.mock.calls).toEqual([["ctrl+q"]])
    session.keydown(keyboardEvent("Escape", "Escape"))
    session.keydown(keyboardEvent("Backspace", "Backspace"))
    expect(session.stop).toHaveBeenCalledTimes(2)
    expect(session.remove).toHaveBeenCalledTimes(1)
  })
})
