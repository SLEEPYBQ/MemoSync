import { describe, expect, test } from "bun:test"
import { deriveMemoryToggleState } from "./MemoryToggle"

const policy = { condition: "memosync" as const, studyMode: false }
const on = { enabled: true, learn: true }

describe("composer memory toggle", () => {
  test("default is a quiet on icon with a chat toggle", () => {
    expect(deriveMemoryToggleState(policy, on, false)).toEqual({
      hidden: false, off: false, label: null, action: "toggle",
      tooltip: "Memory on — click to turn it off for this chat",
    })
  })
  test("per-chat off explains both reading and learning", () => {
    expect(deriveMemoryToggleState(policy, on, true)).toMatchObject({
      off: true, label: "Memory off", action: "toggle",
      tooltip: "This chat doesn't use or learn memories. Click to turn memory back on.",
    })
  })
  test("global off takes precedence over the chat switch and links to settings", () => {
    for (const disabled of [false, true]) {
      expect(deriveMemoryToggleState(policy, { enabled: false, learn: false }, disabled)).toMatchObject({
        off: true, label: "Memory off", action: "settings", tooltip: "Memory is turned off in Settings",
      })
    }
  })
  test("learning paused stays on and adds only a tooltip hint", () => {
    const state = deriveMemoryToggleState(policy, { enabled: true, learn: false }, false)
    expect(state.off).toBe(false)
    expect(state.label).toBeNull()
    expect(state.tooltip).toEndWith("Learning is paused in Settings")
  })
  test("all study arms and other conditions hide the control", () => {
    expect(deriveMemoryToggleState({ ...policy, studyMode: true }, on, true).hidden).toBe(true)
    for (const condition of ["auto", "static"] as const) {
      for (const studyMode of [true, false]) {
        expect(deriveMemoryToggleState({ condition, studyMode }, on, false).hidden).toBe(true)
      }
    }
  })
})
