import { describe, expect, test } from "bun:test"
import {
  bindingMatchesEvent, chordFromKeyboardEvent, codeToKey, findMatchingActionBinding, formatBindingParts, getBindingsForAction, getResolvedKeybindings,
  isRecordableChord, keyToCode, modifierChordFromEvent, parseKeybindingInput, preferredBinding,
} from "./keybindings"
import { DEFAULT_KEYBINDINGS, type KeybindingsSnapshot } from "../../shared/types"

describe("parseKeybindingInput", () => {
  test("splits comma-separated values, trims whitespace, and lowercases", () => {
    expect(parseKeybindingInput(" Cmd+J, Ctrl+` ,  ")).toEqual(["cmd+j", "ctrl+`"])
  })
})

describe("bindingMatchesEvent", () => {
  test("matches modifier bindings case-insensitively", () => {
    const event = { key: "j", code: "KeyJ", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false } as KeyboardEvent
    expect(bindingMatchesEvent("Cmd+J", event)).toBe(true)
  })

  test("does not match when modifiers differ", () => {
    const event = { key: "b", code: "KeyB", metaKey: false, ctrlKey: true, altKey: false, shiftKey: true } as KeyboardEvent
    expect(bindingMatchesEvent("Ctrl+B", event)).toBe(false)
  })

  test("matches option-modified letters by physical key code", () => {
    const event = { key: "ø", code: "KeyO", metaKey: true, ctrlKey: false, altKey: true, shiftKey: false } as KeyboardEvent
    expect(bindingMatchesEvent("Cmd+Alt+O", event)).toBe(true)
  })

  test("ignores AltGraph but allows genuine Ctrl+Alt", () => {
    const event = { key: "n", code: "KeyN", metaKey: false, ctrlKey: true, altKey: true, shiftKey: false } as KeyboardEvent
    expect(bindingMatchesEvent("ctrl+alt+n", { ...event, getModifierState: (key: string) => key === "AltGraph" } as KeyboardEvent)).toBe(false)
    expect(bindingMatchesEvent("ctrl+alt+n", { ...event, getModifierState: () => false } as KeyboardEvent)).toBe(true)
    expect(bindingMatchesEvent("ctrl+alt+n", event)).toBe(true)
  })
})

describe("findMatchingActionBinding", () => {
  test("returns the matching binding for multi-binding actions", () => {
    const snapshot: KeybindingsSnapshot = {
      bindings: {
        toggleEmbeddedTerminal: ["cmd+j"],
        toggleLeftSidebar: ["cmd+b"],
        toggleRightSidebar: ["cmd+b"],
        openInFinder: ["cmd+alt+f"],
        openInEditor: ["cmd+shift+o"],
        addSplitTerminal: ["cmd+/"],
        jumpToSidebarChat: ["cmd+alt"],
        createChatInCurrentProject: ["cmd+alt+n"],
        openAddProject: ["cmd+alt+o"],
      },
      warning: null,
      filePathDisplay: "~/.kanna/keybindings.json",
    }
    const event = { key: "˜", code: "KeyN", metaKey: true, ctrlKey: false, altKey: true, shiftKey: false } as KeyboardEvent

    expect(findMatchingActionBinding(snapshot, "createChatInCurrentProject", event)).toBe("cmd+alt+n")
  })

  test("keeps an explicitly unassigned action unassigned", () => {
    const snapshot = { bindings: { ...DEFAULT_KEYBINDINGS, toggleEmbeddedTerminal: [] }, warning: null, filePathDisplay: "" }
    expect(getBindingsForAction(snapshot, "toggleEmbeddedTerminal")).toEqual([])
    expect(getResolvedKeybindings(snapshot).bindings.toggleEmbeddedTerminal).toEqual([])
    const event = { key: "j", code: "KeyJ", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false } as KeyboardEvent
    expect(findMatchingActionBinding(snapshot, "toggleEmbeddedTerminal", event)).toBeNull()
  })
})

describe("shortcut recording and display", () => {
  const event = (overrides: Partial<KeyboardEvent> = {}) => ({
    key: "", code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...overrides,
  }) as KeyboardEvent

  test("records physical keys and canonical modifier order", () => {
    expect(chordFromKeyboardEvent(event({ key: "∫", code: "KeyB", altKey: true }))).toBe("alt+b")
    expect(chordFromKeyboardEvent(event({ key: "O", code: "KeyO", metaKey: true, shiftKey: true }))).toBe("cmd+shift+o")
    expect(chordFromKeyboardEvent(event({ key: "Control", code: "ControlLeft", ctrlKey: true }))).toBeNull()
    expect(chordFromKeyboardEvent(event({ key: "+", code: "NumpadAdd", ctrlKey: true }))).toBeNull()
    expect(chordFromKeyboardEvent(event({ key: " ", code: "Space", ctrlKey: true }))).toBe("ctrl+space")
    expect(chordFromKeyboardEvent(event({ key: " ", code: "", ctrlKey: true }))).toBeNull()
    expect(chordFromKeyboardEvent(event({ key: "AltGraph", code: "AltRight", ctrlKey: true, altKey: true }))).toBeNull()
    for (const key of ["CapsLock", "Dead", "Process", "Unidentified"]) expect(chordFromKeyboardEvent(event({ key }))).toBeNull()
  })

  test("collects modifiers and checks which chords can be recorded", () => {
    expect(modifierChordFromEvent(event())).toBeNull()
    expect(modifierChordFromEvent(event({ metaKey: true, ctrlKey: true, altKey: true, shiftKey: true }))).toBe("cmd+ctrl+alt+shift")
    expect(isRecordableChord("j")).toBe(false)
    expect(isRecordableChord("shift+j")).toBe(false)
    expect(isRecordableChord("f5")).toBe(true)
    expect(isRecordableChord("f13")).toBe(false)
    expect(isRecordableChord("cmd+j")).toBe(true)
  })

  test("formats platform-specific keycaps and modifier-only shortcuts", () => {
    expect(formatBindingParts("cmd+ctrl+alt+shift+o", true)).toEqual(["⌘", "⌃", "⌥", "⇧", "O"])
    expect(formatBindingParts("meta+control+option+shift+space", false)).toEqual(["Win", "Ctrl", "Alt", "Shift", "Space"])
    expect(formatBindingParts("cmd+alt", true)).toEqual(["⌘", "⌥"])
    expect(formatBindingParts("ctrl+arrowleft", false)).toEqual(["Ctrl", "←"])
    expect(formatBindingParts("ctrl+f5", false)).toEqual(["Ctrl", "F5"])
    expect(formatBindingParts("invalid+two+keys", true)).toEqual(["invalid+two+keys"])
  })

  test("prefers bindings for the active platform", () => {
    expect(preferredBinding(["ctrl+b", "cmd+b"], true)).toBe("cmd+b")
    expect(preferredBinding(["cmd+b", "ctrl+b"], false)).toBe("ctrl+b")
    expect(preferredBinding(["cmd+b"], false)).toBe("cmd+b")
    expect(preferredBinding([], true)).toBeNull()
  })

  test("translates physical punctuation and space in both directions", () => {
    const pairs = { "-": "Minus", "=": "Equal", "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash", ";": "Semicolon", "'": "Quote", ",": "Comma", ".": "Period", "/": "Slash", "`": "Backquote", space: "Space", a: "KeyA", "1": "Digit1" }
    for (const [key, code] of Object.entries(pairs)) {
      expect(keyToCode(key)).toBe(code)
      expect(codeToKey(code)).toBe(key)
    }
    expect(codeToKey("Unknown")).toBeNull()
    expect(bindingMatchesEvent("ctrl+space", event({ key: "Unusual", code: "Space", ctrlKey: true }))).toBe(true)
    expect(bindingMatchesEvent("cmd+,", event({ key: "≤", code: "Comma", metaKey: true }))).toBe(true)
  })
})
