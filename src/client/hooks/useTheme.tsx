import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useAppSettingsStore } from "../stores/appSettingsStore"
import { useConditionPolicyResolved } from "../lib/conditionApi"
import { RESOLVED_THEME_STORAGE_KEY, resolveTheme, type ResolvedTheme, type ThemePreference } from "../lib/theme"
import type { AppSettingsPatch } from "../../shared/types"

export type { ThemePreference } from "../lib/theme"

interface ThemeContextValue {
  theme: ThemePreference
  resolvedTheme: ResolvedTheme
  setTheme: (theme: ThemePreference) => void
}

type SettingsWriter = (patch: AppSettingsPatch) => Promise<void>
const ThemeContext = createContext<ThemeContextValue | undefined>(undefined)
const ThemeWriterContext = createContext<((writer: SettingsWriter | null) => void) | undefined>(undefined)

/** Connect the provider to the same persistence/error flow used by Settings. */
export function useThemeSettingsWriter(writer: SettingsWriter) {
  const register = useContext(ThemeWriterContext)
  useEffect(() => {
    register?.(writer)
    return () => register?.(null)
  }, [register, writer])
}

function getSystemTheme(): ResolvedTheme {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

function getCachedTheme(): ResolvedTheme {
  try {
    const cached = localStorage.getItem(RESOLVED_THEME_STORAGE_KEY)
    if (cached === "dark" || cached === "light") return cached
  } catch { /* Storage may be disabled. */ }
  return getSystemTheme()
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const settingsTheme = useAppSettingsStore((store) => store.settings?.theme)
  const policy = useConditionPolicyResolved()
  const [systemTheme, setSystemTheme] = useState(getSystemTheme)
  const [cachedTheme] = useState(getCachedTheme)
  const writerRef = useRef<SettingsWriter | null>(null)
  const registerWriter = useMemo(() => (writer: SettingsWriter | null) => { writerRef.current = writer }, [])
  const theme = settingsTheme ?? "system"
  // Settings hydrate independently of the condition. Retain the bootstrap until
  // both are available, except that a study policy always forces light at once.
  const resolvedTheme = resolveTheme(theme, systemTheme, policy?.studyMode ?? null, cachedTheme)
  const hydratedTheme = policy && !policy.studyMode && !settingsTheme ? cachedTheme : resolvedTheme

  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)")
    const update = () => setSystemTheme(query.matches ? "dark" : "light")
    update()
    query.addEventListener("change", update)
    return () => query.removeEventListener("change", update)
  }, [])

  useLayoutEffect(() => {
    const root = document.documentElement
    root.classList.toggle("dark", hydratedTheme === "dark")
    root.style.colorScheme = hydratedTheme
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", getComputedStyle(document.body).backgroundColor)
    document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.setAttribute("content", hydratedTheme === "dark" ? "black-translucent" : "default")
    // Unknown policies retain the previous cache; a study session only caches light.
    if (policy) {
      try { localStorage.setItem(RESOLVED_THEME_STORAGE_KEY, hydratedTheme) } catch { /* Storage may be disabled. */ }
    }
  }, [hydratedTheme, policy])

  const value = useMemo<ThemeContextValue>(() => ({
    theme,
    resolvedTheme: hydratedTheme,
    setTheme: (nextTheme) => {
      if (writerRef.current) void writerRef.current({ theme: nextTheme })
    },
  }), [theme, hydratedTheme])

  return <ThemeWriterContext.Provider value={registerWriter}><ThemeContext.Provider value={value}>{children}</ThemeContext.Provider></ThemeWriterContext.Provider>
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) throw new Error("useTheme must be used within ThemeProvider")
  return context
}
