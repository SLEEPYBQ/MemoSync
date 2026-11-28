import { useColorScheme } from "react-native"

/**
 * MemoSync mobile design tokens — a faithful extraction of the web desktop
 * app's tokens (src/index.css, `:root` + `.dark`, lines 7-137). The web tokens
 * are HSL/oklch channel triplets; they are baked to hex here because React
 * Native colors must be static strings.
 *
 * Design language: warm paper canvas, white cards lifting off it, quiet macOS
 * chrome, 8px base radius, system font (RN default == the web system-font stack).
 */

export interface ColorTokens {
  /** Warm paper canvas the whole app sits on. */
  background: string
  foreground: string
  /** Cards / bubbles lift off the canvas. */
  card: string
  cardForeground: string
  primary: string
  primaryForeground: string
  secondary: string
  secondaryForeground: string
  muted: string
  mutedForeground: string
  accent: string
  accentForeground: string
  destructive: string
  destructiveForeground: string
  border: string
  input: string
  /** Keyboard-focus blue (Codex/macOS), reused for links and live indicators. */
  focus: string
  /** One step back from the canvas — grouped-list section chrome. */
  sidebar: string
  mutedIcon: string
  success: string
  successForeground: string
  info: string
  infoForeground: string
  sectionTitle: string
  /** Terracotta of the stacked-cards mark. */
  logo: string
  /** Memory-scope accents (canonical v1 values, RGB triplets in the web CSS). */
  scopePersonal: string
  scopeProject: string
  scopeSession: string
}

export const lightColors: ColorTokens = {
  background: "#fbfbfa", // hsl(48 14% 98.3%)
  foreground: "#1e1c1a", // hsl(30 8% 11%)
  card: "#ffffff",
  cardForeground: "#1e1c1a",
  primary: "#24211e", // hsl(30 8% 13%)
  primaryForeground: "#fbfbf9", // hsl(48 20% 98%)
  secondary: "#f0efed", // hsl(42 10% 93.5%)
  secondaryForeground: "#24211e",
  muted: "#f4f3f1", // hsl(42 11% 95%)
  mutedForeground: "#6e6963", // hsl(32 5% 41%) — AA on the canvas
  accent: "#f0efed",
  accentForeground: "#24211e",
  destructive: "#c9302d", // oklch(55% 0.19 27)
  destructiveForeground: "#fafafa",
  border: "#e7e5e2", // hsl(40 9% 89.5%)
  input: "#e7e5e2",
  focus: "#1481f5", // hsl(211 92% 52%)
  sidebar: "#f4f3f1", // hsl(42 11% 95.2%)
  mutedIcon: "#c8c8cb", // hsl(240 2% 79%)
  success: "#10b981", // emerald-500 — oklch(69.6% 0.17 162.48)
  successForeground: "#1a7f5f",
  info: "#0ea5e9", // sky-500 — oklch(68.5% 0.169 237.323)
  infoForeground: "#1565a0",
  sectionTitle: "#59534e", // oklch(44.6% 0.012 60)
  logo: "#d6734c", // oklch(66% 0.135 42)
  scopePersonal: "rgb(217, 119, 87)",
  scopeProject: "rgb(106, 155, 204)",
  scopeSession: "rgb(120, 140, 93)",
}

export const darkColors: ColorTokens = {
  background: "#21201f", // hsl(30 4% 12.5%)
  foreground: "#f2f0ee", // hsl(40 14% 94%)
  card: "#292826", // hsl(30 4% 15.5%)
  cardForeground: "#f2f0ee",
  primary: "#f2f0ee",
  primaryForeground: "#1d1c1b", // hsl(30 4% 11%)
  secondary: "#32302f", // hsl(30 3% 19%)
  secondaryForeground: "#f2f0ee",
  muted: "#302e2c", // hsl(30 4% 18%)
  mutedForeground: "#aaa6a1", // hsl(34 5% 65%)
  accent: "#32302f",
  accentForeground: "#f2f0ee",
  destructive: "#f66d62", // oklch(70% 0.17 27)
  destructiveForeground: "#1d1c1b",
  border: "#3c3b39", // hsl(30 3% 23%)
  input: "#353331", // hsl(30 3% 20%)
  focus: "#52a1f4", // hsl(211 88% 64%)
  sidebar: "#262523", // hsl(30 4% 14.5%)
  mutedIcon: "#7f7b76", // hsl(32 4% 48%)
  success: "#34d399", // emerald-400 — oklch(76.5% 0.177 163.223)
  successForeground: "#6ee7b7",
  info: "#38bdf8", // sky-400 — oklch(74.6% 0.16 232.661)
  infoForeground: "#7dd3fc",
  sectionTitle: "#e8e7e5", // slate-300 — oklch(92.8% 0.0026 60)
  logo: "#e1815b", // oklch(70% 0.13 42)
  scopePersonal: "rgb(235, 170, 130)",
  scopeProject: "rgb(158, 196, 233)",
  scopeSession: "rgb(176, 199, 146)",
}

/** Web `--radius: 0.5rem` on a 16px root == 8px base. */
export const radius = {
  sm: 6,
  base: 8,
  lg: 12,
  xl: 16,
  full: 999,
} as const

/**
 * Legacy token aliases mapped onto the MemoSync mobile scale in
 * src/lib/typography.ts. New UI should prefer the named typography roles;
 * these aliases remain useful in one-off screen styles.
 * System font throughout (RN default), matching the web system-font approach.
 */
export const typeScale = {
  caption: { fontSize: 12, lineHeight: 16 },
  small: { fontSize: 13, lineHeight: 18 },
  body: { fontSize: 15, lineHeight: 22 },
  bodyLarge: { fontSize: 16, lineHeight: 23 },
  title: { fontSize: 21, lineHeight: 27 },
  largeTitle: { fontSize: 26, lineHeight: 32 },
  /** The pairing code, rendered large in monospace. */
  pairingCode: { fontSize: 29, lineHeight: 38, letterSpacing: 2 },
} as const

/** RN-safe rgba() helper for the hex tokens above. */
export function colorWithAlpha(hex: string, alpha: number): string {
  const normalized = hex.replace("#", "")
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return hex
  const r = Number.parseInt(normalized.slice(0, 2), 16)
  const g = Number.parseInt(normalized.slice(2, 4), 16)
  const b = Number.parseInt(normalized.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/**
 * The web card lift translated to RN: a soft warm shadow on light canvas and
 * a nearly imperceptible one in dark mode, where the hairline does the work.
 */
export function cardShadow(dark: boolean) {
  return {
    shadowColor: dark ? "#000000" : "#4a4038",
    shadowOffset: { width: 0, height: dark ? 4 : 7 },
    shadowOpacity: dark ? 0.22 : 0.075,
    shadowRadius: dark ? 10 : 16,
    elevation: dark ? 2 : 3,
  } as const
}

/** 4px-grid spacing scale. */
export const spacing = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const

export interface Theme {
  colors: ColorTokens
  dark: boolean
}

export function useTheme(): Theme {
  const scheme = useColorScheme()
  const dark = scheme === "dark"
  return { colors: dark ? darkColors : lightColors, dark }
}

export function themeForScheme(scheme: "light" | "dark"): Theme {
  return { colors: scheme === "dark" ? darkColors : lightColors, dark: scheme === "dark" }
}
