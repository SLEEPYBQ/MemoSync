import { describe, expect, test } from "bun:test"
import { resolveTheme, type ResolvedTheme, type ThemePreference } from "./theme"

describe("theme resolution", () => {
  for (const preference of ["light", "dark", "system"] as ThemePreference[]) {
    for (const system of ["light", "dark"] as ResolvedTheme[]) {
      test(`${preference} / system ${system}`, () => {
        expect(resolveTheme(preference, system, false)).toBe(preference === "system" ? system : preference)
        expect(resolveTheme(preference, system, true)).toBe("light")
        expect(resolveTheme(preference, system, null, "dark")).toBe("dark")
        expect(resolveTheme(preference, system, null, "light")).toBe("light")
      })
    }
  }
})
