import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { RegistryModelCard } from "../shared/model-capabilities"
import type { RegistryConnection } from "./registry-models"
import { PI_REASONING_OPTIONS, type PiReasoningEffort } from "../shared/types"

const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {}
const positive = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined
const price = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined
const valid = new Set<string>(PI_REASONING_OPTIONS.map(e => e.id))
const bare = (id: string) => id.toLowerCase().split("/").at(-1)!
const endpoint = (url: string) => { try { return new URL(url).origin + new URL(url).pathname.replace(/\/+$/, "") } catch { return "" } }
const makerAliases: Record<string, string> = { zai: "zhipuai", "zai-coding-plan": "zhipuai" }

interface CatalogRow { provider: string; id: string; canonical?: string; card: RegistryModelCard }
export interface CatalogMatch { card: RegistryModelCard; scope: "provider" | "model" }

/** A metadata index, never a source of credentials, routing URLs or available model IDs. */
export class ModelsDevCatalog {
  private providers = new Map<string, string[]>()
  private rows: CatalogRow[] = []
  private own = new Map<string, CatalogRow>()
  private aliases = new Map<string, CatalogRow[]>()

  constructor(value: unknown) {
    for (const [provider, raw] of Object.entries(object(value))) {
      const p = object(raw)
      const urls = [p.api, provider === "openai" ? "https://api.openai.com/v1" : undefined]
        .filter((v): v is string => typeof v === "string").map(endpoint).filter(Boolean)
      this.providers.set(provider, urls)
      for (const [id, rawModel] of Object.entries(object(p.models))) {
        const m = object(rawModel)
        if (!Object.keys(m).length) continue
        const options = Array.isArray(m.reasoning_options) ? m.reasoning_options.map(object) : []
        const effort = options.find(o => o.type === "effort")
        const efforts = Array.isArray(effort?.values) ? [...new Set(effort.values
          .map(v => v === "none" ? "off" : v)
          .filter((v): v is PiReasoningEffort => typeof v === "string" && valid.has(v) && v !== "default"))] : []
        const kind = effort ? "effort" : options.some(o => o.type === "toggle") ? "toggle"
          : options.some(o => o.type === "budget_tokens") ? "budget" : m.reasoning === false ? "none" : "unknown"
        // A toggle doesn't establish that this endpoint accepts reasoning_effort=none.
        const levels: PiReasoningEffort[] = efforts.length ? efforts : [kind === "none" ? "off" : "default"]
        const limit = object(m.limit), cost = object(m.cost), modalities = object(m.modalities)
        const card: RegistryModelCard = {
          id, label: typeof m.name === "string" ? m.name : id,
          supportsEffort: efforts.some(e => e !== "off"), reasoningKind: kind,
          reasoningEfforts: levels, defaultReasoningEffort: levels.includes("medium") ? "medium" : levels.find(e => e !== "off") ?? levels[0]!,
          metadataSource: "models.dev", contextWindow: positive(limit.input) ?? positive(limit.context), maxTokens: positive(limit.output),
          inputModalities: Array.isArray(modalities.input) ? modalities.input.filter((v): v is string => typeof v === "string") : undefined,
          supportsStructuredOutput: typeof m.structured_output === "boolean" ? m.structured_output : undefined,
          cost: Object.keys(cost).length ? { input: price(cost.input), output: price(cost.output), cacheRead: price(cost.cache_read), cacheWrite: price(cost.cache_write) } : undefined,
        }
        const row = { provider, id, canonical: typeof m.canonical_model_id === "string" ? m.canonical_model_id.toLowerCase() : undefined, card }
        this.rows.push(row)
        this.own.set(`${provider}/${id.toLowerCase()}`, row)
        for (const alias of new Set([id.toLowerCase(), bare(id), row.canonical, row.canonical ? bare(row.canonical) : undefined])) {
          if (alias) this.aliases.set(alias, [...this.aliases.get(alias) ?? [], row])
        }
      }
    }
  }

  get size() { return this.rows.length }

  lookup(connection: RegistryConnection, id: string): CatalogMatch | undefined {
    const base = endpoint(connection.baseUrl)
    const providers = [...this.providers].filter(([, urls]) => urls.includes(base)).map(([p]) => p)
    const exact = providers.map(p => this.own.get(`${p}/${id.toLowerCase()}`)).find(Boolean)
    if (exact) return { card: exact.card, scope: "provider" }

    const normalized = id.toLowerCase()
    const direct = (this.aliases.get(normalized) ?? []).filter(r => r.id.toLowerCase() === normalized || r.canonical === normalized)
    // A namespace is part of the model's identity. Expand only through an
    // explicit canonical link, never another model with the same last segment.
    let candidates = normalized.includes("/")
      ? [...new Set(direct.flatMap(r => [r, ...(r.canonical ? this.aliases.get(r.canonical)?.filter(other => other.canonical === r.canonical) ?? [] : [])]))]
      : this.aliases.get(normalized) ?? []
    // An explicit canonical ID can disambiguate models sharing the same bare name.
    if (candidates.some(r => r.canonical === id.toLowerCase())) {
      candidates = candidates.filter(r => r.canonical === id.toLowerCase())
    }
    if (!candidates.length) return
    // Same name isn't enough when the catalog explicitly identifies different models.
    const identities = new Set(candidates.map(r => r.canonical ?? bare(r.id)))
    const canonicals = new Set(candidates.flatMap(r => r.canonical ? [r.canonical] : []))
    if (canonicals.size > 1 || (!canonicals.size && identities.size > 1)) return
    const own = candidates.find(r => providers.includes(r.provider))
    if (own) return { card: own.card, scope: "provider" }
    const makers = candidates.filter(r => r.canonical?.startsWith(`${makerAliases[r.provider] ?? r.provider}/`))
    const choices = makers.length ? makers : candidates
    // Unknown source records do not outvote records that actually declare capabilities.
    const known = choices.filter(r => r.card.reasoningKind !== "unknown")
    if (!known.length) return
    const votes = new Map<string, { row: CatalogRow; providers: Set<string> }>()
    for (const r of known) {
      const key = `${r.card.reasoningKind}:${[...r.card.reasoningEfforts].sort().join(",")}`
      // Count a reseller once even if it lists the same model under multiple host IDs.
      const vote = votes.get(key) ?? { row: r, providers: new Set<string>() }
      vote.providers.add(r.provider)
      votes.set(key, vote)
    }
    const best = [...votes].sort(([a, x], [b, y]) => y.providers.size - x.providers.size || x.row.card.reasoningEfforts.length - y.row.card.reasoningEfforts.length || a.localeCompare(b))[0]?.[1].row
    return best ? { card: best.card, scope: "model" } : undefined
  }
}

const TTL = 24 * 60 * 60_000
const MAX_BYTES = 32 * 1024 * 1024
export function createModelsDevCatalogLoader(deps: {
  fetch?: (input: string, init?: RequestInit) => Promise<Response>; now?: () => number; cachePath?: string | false
} = {}) {
  const now = deps.now ?? Date.now
  const cachePath = deps.cachePath ?? join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "memosync", "models.dev.json")
  let catalog = new ModelsDevCatalog({}), expires = 0, initialized = false
  let pending: Promise<ModelsDevCatalog> | undefined
  return (): Promise<ModelsDevCatalog> => {
    if (pending) return pending
    if (initialized && now() < expires) return Promise.resolve(catalog)
    pending = (async () => {
      if (!initialized) {
        initialized = true
        if (cachePath) {
          try {
            const saved = JSON.parse(await readFile(cachePath, "utf8"))
            const disk = new ModelsDevCatalog(saved.data)
            if (disk.size && typeof saved.fetchedAt === "number" && saved.fetchedAt <= now()) {
              catalog = disk; expires = saved.fetchedAt + TTL
            }
          } catch { /* A missing or damaged cache is fetched again. */ }
        }
        if (now() < expires) return catalog
      }
      try {
        // Public metadata request: never send the registry's API key to models.dev.
        const response = await (deps.fetch ?? fetch)("https://models.dev/api.json", { signal: AbortSignal.timeout(3_000) })
        if (!response.ok) throw new Error("Model capability catalog unavailable")
        const reader = response.body?.getReader()
        if (!reader) throw new Error("Empty model capability catalog")
        const chunks: Uint8Array[] = []
        let size = 0
        try {
          while (true) {
            const chunk = await reader.read()
            if (chunk.done) break
            size += chunk.value.byteLength
            if (size > MAX_BYTES) throw new Error("Model capability catalog too large")
            chunks.push(chunk.value)
          }
        } finally { await reader.cancel().catch(() => {}) }
        const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        const next = new ModelsDevCatalog(data)
        if (!next.size) throw new Error("Invalid model capability catalog")
        catalog = next; expires = now() + TTL
        if (cachePath) {
          const temp = `${cachePath}.${randomUUID()}.tmp`
          try {
            await mkdir(dirname(cachePath), { recursive: true })
            await writeFile(temp, JSON.stringify({ fetchedAt: now(), data }))
            await rename(temp, cachePath)
          } catch { /* Read-only disks still allow the in-memory catalog. */ }
          finally { await unlink(temp).catch(() => {}) }
        }
      } catch { expires = now() + 60_000 /* Keep last good metadata, including across restarts. */ }
      return catalog
    })().finally(() => { pending = undefined })
    return pending
  }
}

export const loadModelsDevCatalog = createModelsDevCatalogLoader()
