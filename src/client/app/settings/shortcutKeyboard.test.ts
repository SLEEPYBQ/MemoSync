import { describe, expect, test } from "bun:test"
import { DEFAULT_KEYBINDINGS, type KeybindingAction } from "../../../shared/types"
import { buildKeyUsage, chordCodes, findBindingConflict, getKeyboardRows, SHORTCUT_CATEGORY_BY_ACTION } from "./shortcutKeyboardModel"

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

  test("reports another action using the chord, including the hidden editor action", () => {
    expect(findBindingConflict(DEFAULT_KEYBINDINGS, "toggleRightSidebar", "cmd+b")).toBe("toggleLeftSidebar")
    expect(findBindingConflict(DEFAULT_KEYBINDINGS, "toggleLeftSidebar", "cmd+b")).toBeNull()
    expect(findBindingConflict(DEFAULT_KEYBINDINGS, "toggleRightSidebar", "ctrl+shift+k")).toBeNull()
    expect(findBindingConflict(DEFAULT_KEYBINDINGS, "toggleRightSidebar", "cmd+shift+o")).toBe("openInEditor")
  })
})
