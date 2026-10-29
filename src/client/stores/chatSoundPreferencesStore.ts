import { t } from "../i18n"
import { create } from "zustand"
import type { ChatSoundId, ChatSoundPreference } from "../../shared/types"

export type { ChatSoundId, ChatSoundPreference }

export const DEFAULT_CHAT_SOUND_PREFERENCE: ChatSoundPreference = "always"
export const DEFAULT_CHAT_SOUND_ID: ChatSoundId = "funk"

export const CHAT_SOUND_OPTIONS: Array<{ value: ChatSoundId; label: string }> = [
  { value: "blow", get label() { return t("settings:blow") } },
  { value: "bottle", get label() { return t("settings:bottle") } },
  { value: "frog", get label() { return t("settings:frog") } },
  { value: "funk", get label() { return t("settings:funk") } },
  { value: "glass", get label() { return t("settings:glass") } },
  { value: "ping", get label() { return t("settings:ping") } },
  { value: "pop", get label() { return t("settings:pop") } },
  { value: "purr", get label() { return t("settings:purr") } },
  { value: "tink", get label() { return t("settings:tink") } },
]

export function normalizeChatSoundPreference(value?: string): ChatSoundPreference {
  switch (value) {
    case "never":
    case "unfocused":
    case "always":
      return value
    default:
      return DEFAULT_CHAT_SOUND_PREFERENCE
  }
}

export function normalizeChatSoundId(value?: string): ChatSoundId {
  switch (value) {
    case "blow":
    case "bottle":
    case "frog":
    case "funk":
    case "glass":
    case "ping":
    case "pop":
    case "purr":
    case "tink":
      return value
    default:
      return DEFAULT_CHAT_SOUND_ID
  }
}

export interface ChatSoundPreferencesState {
  chatSoundPreference: ChatSoundPreference
  chatSoundId: ChatSoundId
  setChatSoundPreference: (value: ChatSoundPreference) => void
  setChatSoundId: (value: ChatSoundId) => void
}

export const useChatSoundPreferencesStore = create<ChatSoundPreferencesState>()(
  (set) => ({
    chatSoundPreference: DEFAULT_CHAT_SOUND_PREFERENCE,
    chatSoundId: DEFAULT_CHAT_SOUND_ID,
    setChatSoundPreference: (value) => set({ chatSoundPreference: normalizeChatSoundPreference(value) }),
    setChatSoundId: (value) => set({ chatSoundId: normalizeChatSoundId(value) }),
  })
)
