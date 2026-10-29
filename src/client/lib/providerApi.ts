import { t, useI18n } from "../i18n"
import { useEffect, useState } from "react"
import { PROVIDERS, type ProviderCatalogEntry } from "../../shared/types"

const FALLBACK_PROVIDERS = PROVIDERS.filter((provider) => provider.id === "claude")
let cached: ProviderCatalogEntry[] | null = null
let inflight: Promise<ProviderCatalogEntry[]> | null = null

export async function requestProviders(fetchProviders = () => fetch("/api/providers", { cache: "no-store" })): Promise<ProviderCatalogEntry[]> {
  const response = await fetchProviders()
  if (!response.ok) throw new Error(t("errors:providerRequestFailedValue0", { v0: response.status }))
  const body = await response.json()
  if (!Array.isArray(body?.data)) throw new Error(t("errors:providerResponseIsMissingData"))
  return body.data
}

function fetchProviders(): Promise<ProviderCatalogEntry[]> {
  if (cached) return Promise.resolve(cached)
  if (!inflight) {
    inflight = requestProviders().then((providers) => { cached = providers; return providers })
      .catch(() => FALLBACK_PROVIDERS)
      .finally(() => { inflight = null })
  }
  return inflight
}

export function useServerProviders(): ProviderCatalogEntry[] {
  useI18n()
  const [providers, setProviders] = useState(cached ?? FALLBACK_PROVIDERS)
  useEffect(() => {
    let alive = true
    void fetchProviders().then((value) => { if (alive) setProviders(value) })
    return () => { alive = false }
  }, [])
  return providers
}
