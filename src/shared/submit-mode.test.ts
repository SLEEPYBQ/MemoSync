import { describe, expect, test } from "bun:test"
import { resolveComposerEnter, resolveModifiedEnter, shouldSteerSubmit } from "./submit-mode"

const base = { key: "Enter", shiftKey: false, metaKey: false, ctrlKey: false, nativeEvent: {}, disabled: false, touch: false, pendingUploads: false, running: true, mode: "queue" as const, text: "hello", attachmentCount: 0, hasQueuedMessage: false }
describe("running composer Enter", () => {
  test("Enter and modified Enter offer both actions under each preference", () => {
    for (const mode of ["queue", "steer"] as const) {
      expect(shouldSteerSubmit(mode, false)).toBe(mode === "steer")
      expect(shouldSteerSubmit(mode, true)).toBe(mode === "queue")
      expect(resolveComposerEnter({ ...base, mode })).toBe(mode)
      for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
        expect(resolveComposerEnter({ ...base, mode, ...modifier })).toBe(mode === "queue" ? "steer" : "queue")
      }
    }
  })
  test("empty modified Enter steers the oldest queued message even while idle/paused", () => {
    expect(resolveComposerEnter({ ...base, text: " \n ", metaKey: true, hasQueuedMessage: true, running: false })).toBe("send-oldest-queued")
    expect(resolveModifiedEnter({ text: "", attachmentCount: 0 }, false)).toBe("none")
    expect(resolveComposerEnter({ ...base, text: "", ctrlKey: true })).toBe("none")
  })
  test("attachments and pending uploads never send the queue instead of the draft", () => {
    expect(resolveModifiedEnter({ text: "", attachmentCount: 1 }, true)).toBe("composer")
    expect(resolveComposerEnter({ ...base, text: "", attachmentCount: 1, ctrlKey: true, hasQueuedMessage: true })).toBe("steer")
    expect(resolveComposerEnter({ ...base, text: "", attachmentCount: 1, pendingUploads: true, ctrlKey: true, hasQueuedMessage: true })).toBe("none")
  })
  test("IME, Safari commit keys, Shift, disabled, and touch retain their behavior", () => {
    for (const patch of [{ nativeEvent: { isComposing: true } }, { nativeEvent: { keyCode: 229 } }, { shiftKey: true }, { disabled: true }, { touch: true }, { key: "Escape" }]) {
      expect(resolveComposerEnter({ ...base, ...patch })).toBe("none")
      if (patch.nativeEvent) expect(resolveComposerEnter({ ...base, ...patch, ctrlKey: true, text: "", hasQueuedMessage: true })).toBe("none")
    }
    expect(resolveComposerEnter({ ...base, touch: true, ctrlKey: true })).toBe("steer")
  })
  test("idle submission uses the regular send path", () => {
    expect(resolveComposerEnter({ ...base, running: false, mode: "steer" })).toBe("queue")
  })
})
