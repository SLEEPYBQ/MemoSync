import { describe, expect, test } from "bun:test"
import { DEFAULT_KEYBINDINGS, type KeybindingAction } from "../../../shared/types"
import { bindingForKey, buildKeyUsage, chordCodes, findBindingConflict, getKeyboardRows, SHORTCUT_CATEGORY_BY_ACTION } from "./shortcutKeyboardModel"

const actions = Object.keys(SHORTCUT_CATEGORY_BY_ACTION) as KeybindingAction[]

describe("shortcut keyboard model", () => {
  test("each ANSI row has fifteen key units on both platforms", () => {
    for (const apple of [true, false]) {
      expect(getKeyboardRows(apple).map((row) => row.reduce((sum, key) => sum + key.width, 0))).toEqual([15, 15, 15, 15, 15])
    }
  })

  test("indexes default shortcuts by physical key, including the sidebar numbers", () => {
    const usage = buildKeyUsage(DEFAULT_KEYBINDINGS, actions)
    expect(new Set(usage.get("KeyB")?.map((item) => item.action))).toEqual(new Set(["toggleLeftSidebar", "toggleRightSidebar"]))
    expect(usage.get("KeyJ")?.[0]?.action).toBe("toggleEmbeddedTerminal")
    expect(usage.get("Backquote")?.[0]?.action).toBe("toggleEmbeddedTerminal")
    expect(usage.get("Slash")?.[0]?.action).toBe("addSplitTerminal")
    for (let digit = 1; digit <= 9; digit++) expect(usage.get(`Digit${digit}`)?.[0]?.action).toBe("jumpToSidebarChat")
    expect(usage.has("Digit0")).toBe(false)
    expect(usage.get("KeyN")?.[0]?.action).toBe("createChatInCurrentProject")
    expect(usage.get("KeyO")?.[0]?.action).toBe("openAddProject")
    expect(usage.get("KeyF")?.[0]?.action).toBe("openInFinder")
  })

  test("lights chords in modifier order and expands a modifier-only jump", () => {
    expect(chordCodes("cmd+alt+b", true)).toEqual(["MetaLeft", "AltLeft", "KeyB"])
    expect(chordCodes("cmd+alt", true)).toEqual(["MetaLeft", "AltLeft", ...Array.from({ length: 9 }, (_, index) => `Digit${index + 1}`)])
  })

  test("selects the preferred binding actually represented by the clicked key", () => {
    const usage = buildKeyUsage(DEFAULT_KEYBINDINGS, actions)
    for (const apple of [true, false]) {
      expect(bindingForKey(usage, "Backquote", apple)).toEqual({ action: "toggleEmbeddedTerminal", binding: "ctrl+`" })
      expect(bindingForKey(usage, "KeyJ", apple)).toEqual({ action: "toggleEmbeddedTerminal", binding: "cmd+j" })
      expect(bindingForKey(usage, "Digit0", apple)).toBeNull()
    }
  })

  test("compares effective chords but ignores the hidden editor action", () => {
    expect(findBindingConflict(DEFAULT_KEYBINDINGS, "toggleRightSidebar", "cmd+b")).toBe("toggleLeftSidebar")
    expect(findBindingConflict(DEFAULT_KEYBINDINGS, "toggleLeftSidebar", "cmd+b")).toBeNull()
    expect(findBindingConflict(DEFAULT_KEYBINDINGS, "toggleRightSidebar", "ctrl+shift+k")).toBeNull()
    expect(findBindingConflict(DEFAULT_KEYBINDINGS, "toggleRightSidebar", "cmd+shift+o")).toBeNull()
    const aliases = { ...DEFAULT_KEYBINDINGS, toggleLeftSidebar: ["shift+control+b", "meta+option+x"] }
    expect(findBindingConflict(aliases, "toggleRightSidebar", "ctrl+shift+b")).toBe("toggleLeftSidebar")
    expect(findBindingConflict(aliases, "toggleRightSidebar", "cmd+alt+x")).toBe("toggleLeftSidebar")
    expect(findBindingConflict(aliases, "toggleLeftSidebar", "ctrl+shift+b")).toBeNull()
  })

  test("conflicts with sidebar jump digits in either direction, but not zero", () => {
    expect(findBindingConflict(DEFAULT_KEYBINDINGS, "toggleRightSidebar", "option+meta+1")).toBe("jumpToSidebarChat")
    expect(findBindingConflict(DEFAULT_KEYBINDINGS, "toggleRightSidebar", "cmd+alt+9")).toBe("jumpToSidebarChat")
    expect(findBindingConflict(DEFAULT_KEYBINDINGS, "toggleRightSidebar", "cmd+alt+0")).toBeNull()
    const bindings = { ...DEFAULT_KEYBINDINGS, openAddProject: ["option+meta+2"] }
    expect(findBindingConflict(bindings, "jumpToSidebarChat", "cmd+alt")).toBe("openAddProject")
    expect(findBindingConflict({ ...bindings, openAddProject: ["cmd+alt+0"] }, "jumpToSidebarChat", "cmd+alt")).toBeNull()
  })
})
