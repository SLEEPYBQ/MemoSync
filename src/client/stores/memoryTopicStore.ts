import { create } from "zustand"
import { memoriesApi, type MemoryTopic } from "../lib/memoriesApi"
import { useMemoryStore } from "./memoryStore"

interface MemoryTopicState {
  topics: MemoryTopic[]
  error: string | null
  loading: boolean
  load: () => Promise<void>
}

let loading: Promise<void> | null = null
export const useMemoryTopicStore = create<MemoryTopicState>()((set) => ({
  topics: [],
  error: null,
  loading: false,
  load: () => {
    if (loading) return loading
    set({ loading: true, error: null })
    loading = memoriesApi.topics().then(topics => { set({ topics }) }).catch(err => {
      set({ error: err instanceof Error ? err.message : String(err) })
    }).finally(() => { loading = null; set({ loading: false }) })
    return loading
  },
}))

export async function refreshMemoryTopics(): Promise<void> {
  // A request started before a mutation may still be in flight. Let it settle
  // before asking for the directory that includes the completed mutation.
  if (loading) await loading
  await Promise.all([useMemoryTopicStore.getState().load(), useMemoryStore.getState().loadAll()])
}
