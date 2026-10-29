export type ThemePreference = "light" | "dark" | "system"
export type ResolvedTheme = "light" | "dark"

export const RESOLVED_THEME_STORAGE_KEY = "memosync:resolved-theme"

/** Keep the bootstrap choice until the server's condition is known. */
export function resolveTheme(
  preference: ThemePreference,
  systemTheme: ResolvedTheme,
  studyMode: boolean | null,
  cachedTheme: ResolvedTheme = systemTheme,
): ResolvedTheme {
  if (studyMode === null) return cachedTheme
  if (studyMode) return "light"
  return preference === "system" ? systemTheme : preference
}
