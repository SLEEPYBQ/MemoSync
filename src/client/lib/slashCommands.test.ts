import { describe, expect, test } from "bun:test"
import { matchSlashCommands, slashPopupMaxHeightPx } from "./slashCommands"

const COMMANDS = ["compact", "review", "commit", "todo-list", "context"]

describe("matchSlashCommands", () => {
  test("bare slash lists everything (capped)", () => {
    const m = matchSlashCommands("/", COMMANDS)
    expect(m).not.toBeNull()
    expect(m!.query).toBe("")
    expect(m!.matches).toEqual(["compact", "review", "commit", "todo-list", "context"])
  })

  test("prefix narrows the list, case-insensitive", () => {
    expect(matchSlashCommands("/co", COMMANDS)!.matches).toEqual(["compact", "commit", "context"])
    expect(matchSlashCommands("/COM", COMMANDS)!.matches).toEqual(["compact", "commit"])
  })

  test("substring matches rank after prefix matches", () => {
    expect(matchSlashCommands("/list", COMMANDS)!.matches).toEqual(["todo-list"])
  })

  test("no popup once a space or newline appears (command already chosen)", () => {
    expect(matchSlashCommands("/commit -m fix", COMMANDS)).toBeNull()
    expect(matchSlashCommands("/commit\nbody", COMMANDS)).toBeNull()
  })

  test("no popup for non-slash input or mid-text slashes", () => {
    expect(matchSlashCommands("hello /co", COMMANDS)).toBeNull()
    expect(matchSlashCommands("", COMMANDS)).toBeNull()
  })

  test("no popup without any commands", () => {
    expect(matchSlashCommands("/co", [])).toBeNull()
  })

  test("returns ALL matches — the popup scrolls, it must not hide commands", () => {
    const many = Array.from({ length: 40 }, (_, i) => `cmd-${i}`)
    expect(matchSlashCommands("/", many)!.matches).toHaveLength(40)
  })
})

// The popup opens UPWARD (bottom-anchored above the composer). When the
// composer sits high in the viewport — the centered landing page — a fixed
// max height overflows the viewport top and gets clipped.
describe("slashPopupMaxHeightPx", () => {
  test("keeps the full height when the composer is low in the viewport (chat dock)", () => {
    expect(slashPopupMaxHeightPx(800)).toBe(288)
  })

  test("shrinks to the space above the composer when it would clip", () => {
    // anchor top 200 − 8px gap − 12px viewport margin = 180
    expect(slashPopupMaxHeightPx(200)).toBe(180)
  })

  test("never collapses below a usable floor near the viewport top", () => {
    expect(slashPopupMaxHeightPx(40)).toBe(96)
  })
})
