import { describe, expect, test } from "bun:test"
import { hasPendingMemoryPreview } from "./derived"

const msg = (kind: string, extra: Record<string, unknown> = {}) => ({ kind, ...extra })

describe("hasPendingMemoryPreview", () => {
  test("true when the newest turn entry is an undecided preview (turn parked)", () => {
    expect(
      hasPendingMemoryPreview([msg("user_prompt"), msg("memory_preview")]),
    ).toBe(true)
  })

  test("false once the preview is decided", () => {
    expect(
      hasPendingMemoryPreview([msg("user_prompt"), msg("memory_preview", { decision: "go_on" })]),
    ).toBe(false)
  })

  test("false when the turn moved past the preview (stale, e.g. server restart)", () => {
    expect(
      hasPendingMemoryPreview([
        msg("user_prompt"),
        msg("memory_preview"),
        msg("user_prompt"),
        msg("result"),
      ]),
    ).toBe(false)
  })

  test("non-turn entries after the preview (trace/candidates) do not unpend it", () => {
    expect(
      hasPendingMemoryPreview([msg("user_prompt"), msg("memory_preview"), msg("memory_trace", { labels: [] })]),
    ).toBe(true)
  })

  test("false with no preview at all", () => {
    expect(hasPendingMemoryPreview([msg("user_prompt"), msg("assistant_text")])).toBe(false)
    expect(hasPendingMemoryPreview([])).toBe(false)
  })
})
