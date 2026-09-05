import { describe, expect, test } from "bun:test"
import { isImeComposingKeyEvent } from "./imeKeys"

describe("isImeComposingKeyEvent", () => {
  test("true while a composition is in progress", () => {
    expect(isImeComposingKeyEvent({ isComposing: true, keyCode: 13 })).toBe(true)
  })

  test("true for keyCode 229 even when isComposing is already false (Safari commit-Enter)", () => {
    expect(isImeComposingKeyEvent({ isComposing: false, keyCode: 229 })).toBe(true)
  })

  test("false for a plain Enter keydown", () => {
    expect(isImeComposingKeyEvent({ isComposing: false, keyCode: 13 })).toBe(false)
  })

  test("false when the fields are absent (synthetic events in tests)", () => {
    expect(isImeComposingKeyEvent({})).toBe(false)
  })
})
