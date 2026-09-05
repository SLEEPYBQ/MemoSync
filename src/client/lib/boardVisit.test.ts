import { describe, expect, test } from "bun:test"
import { freshnessSince } from "./boardVisit"

const T0 = Date.parse("2026-07-01T00:00:00Z")

describe("freshnessSince", () => {
  test("created after the last visit → new", () => {
    expect(freshnessSince({ createdAt: "2026-07-02T00:00:00Z", updatedAt: "2026-07-02T00:00:00Z" }, T0)).toBe("new")
  })

  test("only updated after the last visit → changed", () => {
    expect(freshnessSince({ createdAt: "2026-06-01T00:00:00Z", updatedAt: "2026-07-02T00:00:00Z" }, T0)).toBe("changed")
  })

  test("untouched since the visit → undefined", () => {
    expect(freshnessSince({ createdAt: "2026-06-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z" }, T0)).toBeUndefined()
  })

  test("first-ever visit shows no markers", () => {
    expect(freshnessSince({ createdAt: "2026-07-02T00:00:00Z", updatedAt: "2026-07-02T00:00:00Z" }, null)).toBeUndefined()
  })
})
