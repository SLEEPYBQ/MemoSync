export type LocalUiPreferenceKey =
  | "memosync:sidebar-width"
  | "memosync:memory-view"
  | "memosync:dismissed-release"
  | "memosync:last-open-external"

export interface DesktopUiPreferences {
  get(key: LocalUiPreferenceKey): string | null
  set(key: LocalUiPreferenceKey, value: string): void
}

export function readLocalUiPreference(key: LocalUiPreferenceKey): string | null {
  if (typeof window === "undefined") return null
  try {
    const desktop = window.memosyncDesktop?.uiPreferences
    return desktop ? desktop.get(key) : window.localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeLocalUiPreference(key: LocalUiPreferenceKey, value: string): void {
  if (typeof window === "undefined") return
  try {
    const desktop = window.memosyncDesktop?.uiPreferences
    if (desktop) desktop.set(key, value)
    else window.localStorage.setItem(key, value)
  } catch {
    // Preferences are optional when browser storage or the bridge is unavailable.
  }
}
