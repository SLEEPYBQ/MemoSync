import { useCallback, useEffect, useState } from "react"
import type { RegistryModelCard } from "../../shared/model-capabilities"

// Settings and the composer share one in-flight request. The server separately
// caches provider calls and scopes metadata to the configured connection.
const pending = new Map<string, Promise<RegistryModelCard[]>>()
function fetchModels(url: string) {
  let request = pending.get(url)
  if (!request) {
    request = fetch(url)
      .then(async response => {
        if (!response.ok) throw new Error("Model catalog unavailable")
        const data = await response.json()
        return Array.isArray(data.models) ? data.models as RegistryModelCard[] : []
      }).finally(() => { pending.delete(url) })
    pending.set(url, request)
  }
  return request
}

export function useRegistryModels(enabled: boolean, model?: string) {
  const url = `/api/model-registry/models${model ? `?model=${encodeURIComponent(model)}` : ""}`
  const [state, setState] = useState<{ url: string; models: RegistryModelCard[]; loaded: boolean }>({ url: "", models: [], loaded: false })
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision(value => value + 1), [])
  useEffect(() => {
    if (!enabled) return
    let alive = true
    void fetchModels(url).then(models => {
      if (alive) setState({ url, models, loaded: true })
    }, () => {
      if (alive) setState(previous => ({ url, models: previous.url === url ? previous.models : [], loaded: true }))
    })
    return () => { alive = false }
  }, [enabled, url, revision])
  return { models: enabled ? state.models : [], loaded: enabled && state.url === url && state.loaded, refresh }
}
