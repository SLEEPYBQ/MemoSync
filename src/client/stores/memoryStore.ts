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

export const useMemoryStore = create<MemoryStoreState>()((set) => {
  let loadGeneration = 0
  let pendingMutations: Map<string, MemoryItem | null> | null = null
  return {
    items: [],
    status: "idle",
    error: null,
    loadAll: async () => {
      const generation = ++loadGeneration
      const mutations = new Map<string, MemoryItem | null>()
      pendingMutations = mutations
      set({ status: "loading", error: null })
      try {
        const items = await memoriesApi.list()
        if (generation !== loadGeneration) return
        const merged = new Map(items.map((item) => [item.id, item]))
        for (const [id, item] of mutations) {
          if (item) merged.set(id, item)
          else merged.delete(id)
        }
        set({ items: mutations.size ? [...merged.values()] : items, status: "ready", error: null })
      } catch (err) {
        if (generation === loadGeneration) {
          set({ status: "error", error: err instanceof Error ? err.message : "Failed to load memories" })
        }
      } finally {
        if (generation === loadGeneration) pendingMutations = null
      }
    },
    upsertLocal: (item) => {
      pendingMutations?.set(item.id, item)
      set((state) => {
        const idx = state.items.findIndex((m) => m.id === item.id)
        if (idx === -1) return { items: [...state.items, item] }
        const next = state.items.slice()
        next[idx] = item
        return { items: next }
      })
    },
    removeLocal: (id) => {
      pendingMutations?.set(id, null)
      set((state) => ({ items: state.items.filter((m) => m.id !== id) }))
    },
  }
})
