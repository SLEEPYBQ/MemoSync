import { create } from "zustand"
import { persist } from "zustand/middleware"

// Last engine-reported slash-command list per provider (system_init). A fresh
// chat has no system_init until its first turn boots — this cache lets the
// composer's "/" autocomplete work there too. Refreshed on every init.
interface SlashCommandsState {
  byProvider: Record<string, string[]>
  remember: (provider: string, commands: string[]) => void
}

export const useSlashCommandsStore = create<SlashCommandsState>()(
  persist(
    (set) => ({
      byProvider: {},
      remember: (provider, commands) =>
        set((state) => {
          if (commands.length === 0) return state
          const current = state.byProvider[provider]
          if (current && current.length === commands.length && current.every((c, i) => c === commands[i])) {
            return state
          }
          return { byProvider: { ...state.byProvider, [provider]: commands } }
        }),
    }),
    { name: "slash-commands-by-provider", version: 1 },
  ),
)
