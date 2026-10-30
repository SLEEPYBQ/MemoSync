import { applyLanguage } from "../i18n"
import { create } from "zustand"
import type { AppSettingsPatch, AppSettingsSnapshot } from "../../shared/types"

type AppSettingsHydrationStatus = "idle" | "loading" | "ready" | "error"

interface AppSettingsStoreState {
  settings: AppSettingsSnapshot | null
  hydrationStatus: AppSettingsHydrationStatus
  setHydrationStatus: (status: AppSettingsHydrationStatus) => void
  setFromServer: (settings: AppSettingsSnapshot) => void
  applyOptimisticPatch: (patch: AppSettingsPatch) => void
}

export function mergeAppSettingsPatch(
  settings: AppSettingsSnapshot,
  patch: AppSettingsPatch
): AppSettingsSnapshot {
  return {
    ...settings,
    ...patch,
    terminal: {
      ...settings.terminal,
      ...patch.terminal,
    },
    editor: {
      ...settings.editor,
      ...patch.editor,
    },
    providerDefaults: {
      claude: {
        ...settings.providerDefaults.claude,
        ...patch.providerDefaults?.claude,
        modelOptions: {
          ...settings.providerDefaults.claude.modelOptions,
          ...patch.providerDefaults?.claude?.modelOptions,
        },
      },
      codex: {
        ...settings.providerDefaults.codex,
        ...patch.providerDefaults?.codex,
        modelOptions: {
          ...settings.providerDefaults.codex.modelOptions,
          ...patch.providerDefaults?.codex?.modelOptions,
        },
      },
      pi: {
        ...settings.providerDefaults.pi,
        ...patch.providerDefaults?.pi,
        modelOptions: {
          ...settings.providerDefaults.pi.modelOptions,
          ...patch.providerDefaults?.pi?.modelOptions,
        },
      },
    },
    memory: {
      ...settings.memory,
      ...patch.memory,
    },
    memoryPreview: {
      ...settings.memoryPreview,
      ...patch.memoryPreview,
    },
  }
}

export const useAppSettingsStore = create<AppSettingsStoreState>()((set) => ({
  settings: null,
  hydrationStatus: "idle",
  setHydrationStatus: (hydrationStatus) => set({ hydrationStatus }),
  setFromServer: (settings) => {
    void applyLanguage(settings.language ?? "system")
    set({ settings, hydrationStatus: "ready" })
  },
  applyOptimisticPatch: (patch) => {
    if (patch.language) void applyLanguage(patch.language)
    set((state) => ({
      settings: state.settings ? mergeAppSettingsPatch(state.settings, patch) : state.settings,
    }))
  },
}))

// A running app follows OS/browser changes only while System is selected.
if (typeof window !== "undefined") {
  window.addEventListener("languagechange", () => {
    if (useAppSettingsStore.getState().settings?.language === "system") void applyLanguage("system")
  })
}
