import { describe, expect, test } from "bun:test"
import { previewGateKeyAction } from "./previewGateKeys"

const enter = { key: "Enter" }
const escape = { key: "Escape" }
const emptyComposer = { tagName: "TEXTAREA", value: "" }

describe("previewGateKeyAction", () => {
  test("Enter on an empty composer decides go_on", () => {
    expect(previewGateKeyAction(enter, emptyComposer)).toBe("go_on")
  })

  test("Escape decides dismiss", () => {
    expect(previewGateKeyAction(escape, emptyComposer)).toBe("dismiss")
  })

  test("Enter during pinyin composition must NOT decide the gate", () => {
    expect(previewGateKeyAction({ key: "Enter", isComposing: true }, emptyComposer)).toBe(null)
  })

  test("Escape during pinyin composition (candidate cancel) must NOT dismiss the turn", () => {
    expect(previewGateKeyAction({ key: "Escape", isComposing: true }, emptyComposer)).toBe(null)
  })

  test("keyCode 229 alone (Safari commit) is treated as composing", () => {
    expect(previewGateKeyAction({ key: "Enter", keyCode: 229 }, emptyComposer)).toBe(null)
  })

  test("a non-empty composer draft keeps the typing protection", () => {
    expect(previewGateKeyAction(enter, { tagName: "TEXTAREA", value: "draft 草稿" })).toBe(null)
    expect(previewGateKeyAction(escape, { tagName: "TEXTAREA", value: "draft 草稿" })).toBe(null)
  })

  test("typing in an input or contentEditable never decides the gate", () => {
    expect(previewGateKeyAction(enter, { tagName: "INPUT" })).toBe(null)
    expect(previewGateKeyAction(enter, { tagName: "DIV", isContentEditable: true })).toBe(null)
  })

  test("modified Enter (shift/meta/ctrl) does not decide", () => {
    expect(previewGateKeyAction({ key: "Enter", shiftKey: true }, emptyComposer)).toBe(null)
    expect(previewGateKeyAction({ key: "Enter", metaKey: true }, emptyComposer)).toBe(null)
    expect(previewGateKeyAction({ key: "Enter", ctrlKey: true }, emptyComposer)).toBe(null)
  })

  test("no target (focus on body) still lets Enter/Esc decide", () => {
    expect(previewGateKeyAction(enter, null)).toBe("go_on")
    expect(previewGateKeyAction(escape, null)).toBe("dismiss")
  })

  test("other keys do nothing", () => {
    expect(previewGateKeyAction({ key: "a" }, emptyComposer)).toBe(null)
  })

  // BUG MSG-4: a keyboard user Tab'd to "Proceed without memory" / "Dismiss
  // turn" and pressed Enter — the window handler must NOT hijack that Enter as
  // go_on (which, via preventDefault, also suppressed the button they chose).
  // Let the focused control handle its own Enter.
  test("Enter while a gate button/link/select is focused does NOT decide go_on", () => {
    expect(previewGateKeyAction(enter, { tagName: "BUTTON" })).toBe(null)
    expect(previewGateKeyAction(enter, { tagName: "A" })).toBe(null)
    expect(previewGateKeyAction(enter, { tagName: "SELECT" })).toBe(null)
  })

  test("Escape while a gate button is focused still dismisses (buttons don't claim Esc)", () => {
    expect(previewGateKeyAction(escape, { tagName: "BUTTON" })).toBe("dismiss")
  })

  // The composer consumes Enter-to-send with preventDefault() and React clears
  // the controlled textarea before the native event bubbles to window — so by
  // the time the gate's listener reads it, the "typing protection" value guard
  // sees an EMPTY composer and the same keystroke would also decide the gate.
  // A global fallback shortcut must never act on a key someone already claimed.
  test("a defaultPrevented Enter (consumed by the composer send) must NOT decide", () => {
    expect(previewGateKeyAction({ key: "Enter", defaultPrevented: true }, emptyComposer)).toBe(null)
  })

  test("a defaultPrevented Escape (consumed by a dialog or cancel) must NOT dismiss", () => {
    expect(previewGateKeyAction({ key: "Escape", defaultPrevented: true }, emptyComposer)).toBe(null)
    expect(previewGateKeyAction({ key: "Escape", defaultPrevented: true }, null)).toBe(null)
  })
})
