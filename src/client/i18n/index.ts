import i18next from "i18next"
import { initReactI18next, useTranslation } from "react-i18next"
import type { AppLanguagePreference } from "../../shared/types"
import { en, zhCN } from "./resources"

export const RESOLVED_LANGUAGE_STORAGE_KEY = "memosync:resolved-language"
export type ResolvedLanguage = "en" | "zh-CN"

export function resolveLanguage(preference: AppLanguagePreference, languages: readonly string[] = []): ResolvedLanguage {
  if (preference !== "system") return preference
  return languages.some((language) => /^zh/i.test(language)) ? "zh-CN" : "en"
}

function browserLanguages(): readonly string[] {
  return typeof navigator === "undefined" ? [] : navigator.languages ?? [navigator.language]
}

function initialLanguage(): ResolvedLanguage {
  try {
    const cached = localStorage.getItem(RESOLVED_LANGUAGE_STORAGE_KEY)
    if (cached === "en" || cached === "zh-CN") return cached
  } catch { /* Storage may be disabled. */ }
  return resolveLanguage("system", browserLanguages())
}

export const i18n = i18next.createInstance()
void i18n.use(initReactI18next).init({
  resources: { en, "zh-CN": zhCN },
  lng: initialLanguage(),
  fallbackLng: "en",
  supportedLngs: ["en", "zh-CN"],
  load: "currentOnly",
  defaultNS: "common",
  initImmediate: false,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
})

function syncLanguage(language: string) {
  if (typeof document !== "undefined") document.documentElement.lang = language
  try { localStorage.setItem(RESOLVED_LANGUAGE_STORAGE_KEY, language) } catch { /* Storage may be disabled. */ }
}
i18n.on("languageChanged", syncLanguage)
syncLanguage(i18n.language)

export function applyLanguage(preference: AppLanguagePreference) {
  return i18n.changeLanguage(resolveLanguage(preference, browserLanguages()))
}

/** Subscribe standalone message components as well as the app and export viewer. */
export function useI18n() {
  return useTranslation().i18n.language
}

export const t = i18n.t.bind(i18n) as typeof i18n.t
export function getLocale(): ResolvedLanguage { return i18n.resolvedLanguage === "zh-CN" ? "zh-CN" : "en" }
export function formatNumber(value: number, options?: Intl.NumberFormatOptions) {
  return new Intl.NumberFormat(getLocale(), options).format(value)
}
export function formatRelativeTime(value: number, unit: Intl.RelativeTimeFormatUnit) {
  return new Intl.RelativeTimeFormat(getLocale(), { numeric: "auto" }).format(value, unit)
}

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common"
    resources: typeof en
    strictKeyChecks: true
  }
}
