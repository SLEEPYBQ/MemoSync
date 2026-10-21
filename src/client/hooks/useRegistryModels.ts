import { useCallback, useEffect, useState } from "react"
import type { RegistryModelCard } from "../../shared/model-capabilities"

// Settings and the composer share one in-flight request. The server separately
// caches provider calls and scopes metadata to the configured connection.
let pending: Promise<RegistryModelCard[]> | undefined
function fetchModels() {
  if (!pending) pending = fetch("/api/model-registry/models")
    .then(async response => {
      if (!response.ok) throw new Error("Model catalog unavailable")
      const data = await response.json()
      return Array.isArray(data.models) ? data.models as RegistryModelCard[] : []
    }).finally(() => { pending = undefined })
  return pending
}

export function useRegistryModels(enabled: boolean) {
  const [models, setModels] = useState<RegistryModelCard[]>([])
  const [loaded, setLoaded] = useState(false)
  const refresh = useCallback(() => {
    if (!enabled) return
    // A failed refresh keeps the last usable metadata for this mounted picker.
    void fetchModels().then(setModels, () => {}).finally(() => setLoaded(true))
  }, [enabled])
  useEffect(() => {
    if (!enabled) return
    let alive = true
    void fetchModels().then(data => { if (alive) setModels(data) }, () => {})
      .finally(() => { if (alive) setLoaded(true) })
    return () => { alive = false }
  }, [enabled])
  return { models, loaded, refresh }
}
