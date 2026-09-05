// Client mirror of the study-condition policy (GET /api/condition) — gates
// which memory surfaces the UI shows (Board nav, bring-in panel). Fetched
// once per page load; defaults to the full memosync policy until the fetch
// resolves (the policy is static for an instance's lifetime).
import { useEffect, useState } from "react"
import type { ConditionPolicy } from "../../server/experiment/condition"
import { PROVIDERS, type ProviderCatalogEntry } from "../../shared/types"

export type { ConditionPolicy }

const DEFAULT_POLICY: ConditionPolicy = {
  condition: "memosync",
  capture: "review",
  preview: true,
  trace: true,
  boardVisible: true,
  boardWritable: true,
  bringIn: true,
  injection: "skills",
  memoryTools: true,
  studyMode: false,
}

let cached: ConditionPolicy | null = null
let inflight: Promise<ConditionPolicy> | null = null
let resolvedFromServer = false
let conditionLoadFailed = false
// A study shell can arrive just before its same-origin API is ready (for
// example during a reverse-proxy/container handoff). Retry that narrow window
// with a bounded backoff; after 1s the shell still fails closed.
const CONDITION_LOAD_RETRY_DELAYS_MS = [0, 250, 750] as const
// The server's provider catalog rides the same response — in study mode it is
// pinned to one engine/model/effort, and the launcher (no chat snapshot yet)
// must honor that pin instead of the static client-side catalog.
let cachedProviders: ProviderCatalogEntry[] | null = null

function wait(ms: number) {
  return new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms))
}

export async function requestConditionPolicyWithRetry({
  fetchPolicy = () => fetch("/api/condition", { cache: "no-store" }),
  retryDelaysMs = CONDITION_LOAD_RETRY_DELAYS_MS,
  sleep = wait,
}: {
  fetchPolicy?: () => Promise<Response>
  retryDelaysMs?: readonly number[]
  sleep?: (ms: number) => Promise<void>
} = {}) {
  let lastError: unknown = new Error("condition request failed")

  for (const delayMs of retryDelaysMs) {
    if (delayMs > 0) await sleep(delayMs)
    try {
      const response = await fetchPolicy()
      if (!response.ok) throw new Error(`condition request failed (${response.status})`)
      const body = await response.json()
      if (!body?.data) throw new Error("condition response is missing data")
      return body
    } catch (error) {
      lastError = error
    }
  }

  throw lastError
}

export function fetchConditionPolicy(): Promise<ConditionPolicy> {
  if (cached) return Promise.resolve(cached)
  if (!inflight) {
    inflight = requestConditionPolicyWithRetry()
      .then((body) => {
        cached = body.data as ConditionPolicy
        resolvedFromServer = true
        conditionLoadFailed = false
        if (Array.isArray(body?.providers) && body.providers.length > 0) {
          cachedProviders = body.providers as ProviderCatalogEntry[]
        }
        return cached
      })
      .catch(() => {
        // Legacy hooks retain their previous fallback value, but AppLayout
        // remains hidden because `resolvedFromServer` is false. This preserves
        // the fail-closed treatment boundary after the bounded retries end.
        cached = DEFAULT_POLICY
        resolvedFromServer = false
        conditionLoadFailed = true
        return cached
      })
  }
  return inflight
}

// Claude-only deployment: until the server catalog arrives, fall back to the
// shared catalog minus Codex so the picker never flashes an engine this build
// does not ship.
const FALLBACK_PROVIDERS = PROVIDERS.filter((provider) => provider.id === "claude")

/** The server's provider catalog (study pin included); static fallback until it arrives. */
export function useServerProviders(): ProviderCatalogEntry[] {
  const [providers, setProviders] = useState<ProviderCatalogEntry[]>(cachedProviders ?? FALLBACK_PROVIDERS)
  useEffect(() => {
    let alive = true
    void fetchConditionPolicy().then(() => {
      if (alive && cachedProviders) setProviders(cachedProviders)
    })
    return () => {
      alive = false
    }
  }, [])
  return providers
}

export function useConditionPolicy(): ConditionPolicy {
  const [policy, setPolicy] = useState<ConditionPolicy>(cached ?? DEFAULT_POLICY)
  useEffect(() => {
    let alive = true
    void fetchConditionPolicy().then((p) => {
      if (alive) setPolicy(p)
    })
    return () => {
      alive = false
    }
  }, [])
  return policy
}

/**
 * Like useConditionPolicy, but null until the real policy arrives — for
 * surfaces that must not fall back to the memosync default while waiting
 * (the brand mark: a baseline arm must never flash the MemoSync identity).
 */
export function useConditionPolicyResolved(): ConditionPolicy | null {
  const [policy, setPolicy] = useState<ConditionPolicy | null>(resolvedFromServer ? cached : null)
  useEffect(() => {
    let alive = true
    void fetchConditionPolicy().then((p) => {
      if (alive && resolvedFromServer) setPolicy(p)
    })
    return () => {
      alive = false
    }
  }, [])
  return policy
}

/** A failed condition request is an experiment-integrity error, not a signal
 * to guess a treatment. AppLayout shows a neutral retry screen. */
export function useConditionPolicyLoadFailed(): boolean {
  const [failed, setFailed] = useState(conditionLoadFailed)
  useEffect(() => {
    let alive = true
    void fetchConditionPolicy().then(() => {
      if (alive) setFailed(conditionLoadFailed)
    })
    return () => {
      alive = false
    }
  }, [])
  return failed
}
