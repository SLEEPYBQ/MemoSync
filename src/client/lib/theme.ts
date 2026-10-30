export type ThemePreference = "light" | "dark" | "system"
export type ResolvedTheme = "light" | "dark"
export const RESOLVED_THEME_STORAGE_KEY = "memosync:resolved-theme"
export function resolveTheme(preference: ThemePreference, systemTheme: ResolvedTheme): ResolvedTheme {
  return preference === "system" ? systemTheme : preference
}
