// Zustand store for the memory collection, following the app's server-fetched
// collection pattern (see appSettingsStore.ts). Fetched from the memory HTTP API.
import { create } from "zustand"
import { memoriesApi, type MemoryItem } from "../lib/memoriesApi"

export type MemoryHydrationStatus = "idle" | "loading" | "ready" | "error"

interface MemoryStoreState {
  items: MemoryItem[]
  status: MemoryHydrationStatus
  error: string | null
  loadAll: () => Promise<void>
  upsertLocal: (item: MemoryItem) => void
  removeLocal: (id: string) => void
}

let pendingLoad: Promise<void> | null = null

export const useMemoryStore = create<MemoryStoreState>()((set) => ({
  items: [],
  status: "idle",
  error: null,
  loadAll: async () => {
    if (pendingLoad) return pendingLoad
    pendingLoad = (async () => {
      set({ status: "loading", error: null })
      try {
        const items = await memoriesApi.list()
        set({ items, status: "ready" })
      } catch (err) {
        set({ status: "error", error: err instanceof Error ? err.message : "Failed to load memories" })
      } finally {
        pendingLoad = null
      }
    })()
    return pendingLoad
  },
  upsertLocal: (item) =>
    set((state) => {
      const idx = state.items.findIndex((m) => m.id === item.id)
      if (idx === -1) return { items: [...state.items, item] }
      const next = state.items.slice()
      next[idx] = item
      return { items: next }
    }),
  removeLocal: (id) => set((state) => ({ items: state.items.filter((m) => m.id !== id) })),
}))
