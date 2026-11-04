import { describe, expect, test } from "bun:test"
import { deriveMemoryMode, memorySettingsForMode } from "./MemoryToggle"

const review = { enabled: true, learn: true, control: "review" as const }
const auto = { enabled: true, learn: true, control: "auto" as const }

describe("composer memory mode", () => {
  test("follows the control setting while memory is on", () => {
    expect(deriveMemoryMode(review, false)).toBe("review")
    expect(deriveMemoryMode(auto, false)).toBe("auto")
  })
  test("a chat turned off reads as off whatever the control setting says", () => {
    expect(deriveMemoryMode(review, true)).toBe("off")
    expect(deriveMemoryMode(auto, true)).toBe("off")
  })
  test("memory off in Settings takes precedence over the chat", () => {
    for (const disabled of [false, true]) {
      expect(deriveMemoryMode({ ...auto, enabled: false }, disabled)).toBe("off")
    }
  })
  test("choosing a working mode turns memory back on", () => {
    expect(memorySettingsForMode("auto")).toEqual({ enabled: true, control: "auto" })
    expect(memorySettingsForMode("review")).toEqual({ enabled: true, control: "review" })
  })
})
