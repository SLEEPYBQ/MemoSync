import { describe, expect, test } from "bun:test"
import { parseBoardFocus } from "./boardFocus"

describe("parseBoardFocus", () => {
  test("recognizes the candidates deep-link from the landing card", () => {
    expect(parseBoardFocus("?focus=candidates")).toBe("candidates")
  })

  test("ignores unknown focus values and unrelated params", () => {
    expect(parseBoardFocus("?focus=everything")).toBeNull()
    expect(parseBoardFocus("?tab=archive")).toBeNull()
    expect(parseBoardFocus("")).toBeNull()
  })

  test("finds focus among other params", () => {
    expect(parseBoardFocus("?q=indent&focus=candidates")).toBe("candidates")
  })
})
