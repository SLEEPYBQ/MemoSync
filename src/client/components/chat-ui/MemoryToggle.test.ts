import { describe, expect, test } from "bun:test"
import { deriveMemoryToggleState } from "./MemoryToggle"

const on = { enabled: true, learn: true }

describe("composer memory toggle", () => {
  test("default is a quiet on icon with a chat toggle", () => {
    expect(deriveMemoryToggleState(on, false)).toEqual({
      off: false, label: null, action: "toggle",
      tooltip: "Memory on — click to turn it off for this chat",
    })
  })
  test("per-chat off explains both reading and learning", () => {
    expect(deriveMemoryToggleState(on, true)).toMatchObject({
      off: true, label: "Memory off", action: "toggle",
      tooltip: "This chat doesn't use or learn memories. Click to turn memory back on.",
    })
  })
  test("global off takes precedence over the chat switch and links to settings", () => {
    for (const disabled of [false, true]) {
      expect(deriveMemoryToggleState({ enabled: false, learn: false }, disabled)).toMatchObject({
        off: true, label: "Memory off", action: "settings", tooltip: "Memory is turned off in Settings",
      })
    }
  })
  test("learning paused stays on and adds only a tooltip hint", () => {
    const state = deriveMemoryToggleState({ enabled: true, learn: false }, false)
    expect(state.off).toBe(false)
    expect(state.label).toBeNull()
    expect(state.tooltip).toEndWith("Learning is paused in Settings")
  })
})
