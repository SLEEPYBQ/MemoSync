import { randomUUID } from "node:crypto"
import { access, chmod, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import OpenAI from "openai"
import { getLlmProviderFilePath } from "../shared/branding"
import { acquireLlmProviderFileLock } from "./data-directory-lock"
import { SystemCredentialStore, type Keyring } from "./model-access/keyring"
import { atomicJson } from "./model-access/storage"
import {
  DEFAULT_OPENAI_SDK_MODEL,
  DEFAULT_OPENROUTER_SDK_MODEL,
  type LlmProviderFile,
  type LlmProviderKind,
  type LlmProviderSnapshot,
  type LlmProviderValidationResult,
} from "../shared/types"

export const OPENAI_BASE_URL = "https://api.openai.com/v1"
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

const DEFAULT_PROVIDER: LlmProviderKind = "openai"

function formatDisplayPath(filePath: string) {
  const homePath = homedir()
  if (filePath === homePath) return "~"
  if (filePath.startsWith(`${homePath}${path.sep}`)) {
    return `~${filePath.slice(homePath.length)}`
  }
  return filePath
}

function resolveProvider(value: unknown) {
  if (value === "openai" || value === "openrouter" || value === "custom") {
    return value
  }
  return null
}

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

export function resolveLlmProviderBaseUrl(provider: LlmProviderKind, baseUrl: string) {
  if (provider === "openai") return OPENAI_BASE_URL
  if (provider === "openrouter") return OPENROUTER_BASE_URL
  return baseUrl.trim()
}

export function resolveLlmProviderDefaultModel(provider: LlmProviderKind) {
  if (provider === "openai") return DEFAULT_OPENAI_SDK_MODEL
  if (provider === "openrouter") return DEFAULT_OPENROUTER_SDK_MODEL
  return ""
}

export function normalizeLlmProviderSnapshot(
  value: unknown,
  filePath = getLlmProviderFilePath(homedir())
): LlmProviderSnapshot {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
  const warnings: string[] = []

  if (!source) {
    return createDefaultSnapshot(
      filePath,
      value === undefined || value === null ? null : "LLM provider file must contain a JSON object. Using defaults."
    )
  }

  const provider = resolveProvider(source.provider)
  const apiKey = normalizeString(source.apiKey)
  const model = normalizeString(source.model)
  const baseUrl = normalizeString(source.baseUrl)

  if (!provider) {
    warnings.push("provider must be one of openai, openrouter, or custom")
  }
  if (source.apiKey !== undefined && typeof source.apiKey !== "string") {
    warnings.push("apiKey must be a string")
  }
  if (source.model !== undefined && typeof source.model !== "string") {
    warnings.push("model must be a string")
  }
  if (source.baseUrl !== undefined && source.baseUrl !== null && typeof source.baseUrl !== "string") {
    warnings.push("baseUrl must be a string or null")
  }
  if ((provider ?? DEFAULT_PROVIDER) === "custom" && !baseUrl) {
    warnings.push("custom provider requires a baseUrl")
  }

  const normalizedProvider = provider ?? DEFAULT_PROVIDER
  const resolvedModel = model || resolveLlmProviderDefaultModel(normalizedProvider)
  const resolvedBaseUrl = resolveLlmProviderBaseUrl(normalizedProvider, baseUrl)
  const enabled = warnings.length === 0 && apiKey.length > 0 && resolvedModel.length > 0 && resolvedBaseUrl.length > 0

  return {
    provider: normalizedProvider,
    apiKey,
    model: resolvedModel,
    baseUrl,
    resolvedBaseUrl,
    enabled,
    warning: warnings.length > 0 ? `Some LLM provider settings are invalid: ${warnings.join("; ")}` : null,
    filePathDisplay: formatDisplayPath(filePath),
  }
}

function createDefaultSnapshot(filePath: string, warning: string | null = null): LlmProviderSnapshot {
  return {
    provider: DEFAULT_PROVIDER,
    apiKey: "",
    model: DEFAULT_OPENAI_SDK_MODEL,
    baseUrl: "",
    resolvedBaseUrl: OPENAI_BASE_URL,
    enabled: false,
    warning,
    filePathDisplay: formatDisplayPath(filePath),
  }
}

const providerOperations = new Map<string, Promise<void>>()

function withProviderFile<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  // Preserve submission order while the provider-file lock coordinates other processes.
  const absolute = path.resolve(filePath)
  const key = process.platform === "win32" ? absolute.toLowerCase() : absolute
  const result = (providerOperations.get(key) ?? Promise.resolve()).then(async () => {
    const lock = await acquireLlmProviderFileLock(absolute)
    try { return await operation() }
    finally { lock.release() }
  })
  const tail = result.then(() => undefined, () => undefined)
  providerOperations.set(key, tail)
  return result.finally(() => {
    if (providerOperations.get(key) === tail) providerOperations.delete(key)
  })
}

async function readProviderFile(filePath: string): Promise<{ value?: unknown; warning?: string }> {
  try {
    const text = await readFile(filePath, "utf8")
    // Older versions used the process umask for the plaintext file.
    await chmod(filePath, 0o600).catch(() => {})
    if (!text.trim()) return { warning: "LLM provider file was empty. Using defaults." }
    return { value: JSON.parse(text) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return {}
    if (error instanceof SyntaxError) return { warning: "LLM provider file is invalid JSON. Using defaults." }
    throw error
  }
}

function providerRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
}

function isCredentialRef(ref: unknown): ref is string {
  return typeof ref === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(ref)
}

type ProviderMetadata = { provider?: unknown; model?: unknown; baseUrl?: unknown }

function retiredCredentialRefs(value: unknown, activeRef?: string): string[] {
  const retired = providerRecord(value)?.retiredCredentialRefs
  return Array.isArray(retired) ? [...new Set(retired.filter(ref => isCredentialRef(ref) && ref !== activeRef))] : []
}

function commitProviderFile(filePath: string, metadata: ProviderMetadata, activeRef?: string, retired: string[] = []) {
  atomicJson(filePath, {
    ...metadata,
    credentialRef: activeRef,
    retiredCredentialRefs: retired.length ? retired : undefined,
  })
}

async function retireProviderCredentials(
  filePath: string,
  vault: SystemCredentialStore,
  metadata: ProviderMetadata,
  activeRef: string | undefined,
  retired: string[]
) {
  const remaining: string[] = []
  for (const ref of retired) {
    try { await vault.set(ref, null) }
    catch { remaining.push(ref) }
  }
  if (remaining.length !== retired.length) {
    try { commitProviderFile(filePath, metadata, activeRef, remaining) }
    catch { /* The committed file still tracks the entries, so retrying is safe. */ }
  }
}

async function saveProviderFile(
  filePath: string,
  vault: SystemCredentialStore,
  metadata: ProviderMetadata,
  apiKey: string,
  previous: { activeRef?: string; key?: string; retired: string[] }
) {
  const reused = apiKey && apiKey === previous.key ? previous.activeRef : undefined
  // A fresh reference keeps the last committed configuration usable until
  // the metadata rename succeeds.
  const staged = apiKey && !reused ? randomUUID() : undefined
  const activeRef = reused ?? staged
  const retired = previous.activeRef && previous.activeRef !== activeRef
    ? [...previous.retired, previous.activeRef] : previous.retired
  try {
    if (staged) {
      await vault.set(staged, apiKey)
      if (await vault.get(staged) !== apiKey) throw new Error("llm-provider-credential-write-failed")
    }
    commitProviderFile(filePath, metadata, activeRef, retired)
  } catch (error) {
    if (staged) await vault.set(staged, null).catch(() => {})
    throw error
  }
  await retireProviderCredentials(filePath, vault, metadata, activeRef, retired)
}

function unavailableProvider(filePath: string, source: Record<string, unknown>): LlmProviderSnapshot {
  const snapshot = normalizeLlmProviderSnapshot({ ...source, apiKey: "" }, filePath)
  return { ...snapshot, warning: snapshot.warning ?? "LLM provider credential is unavailable in protected storage." }
}

export async function readLlmProviderSnapshot(filePath = getLlmProviderFilePath(homedir()), keyring?: Keyring) {
  try { await access(filePath) }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return createDefaultSnapshot(filePath)
    throw error
  }

  return withProviderFile(filePath, async () => {
    const { value, warning } = await readProviderFile(filePath)
    if (warning) return createDefaultSnapshot(filePath, warning)

    const source = providerRecord(value)
    if (!source) return normalizeLlmProviderSnapshot(value, filePath)
    const { provider, model, baseUrl } = source
    const metadata = { provider, model, baseUrl }
    const vault = new SystemCredentialStore(filePath, keyring)
    const activeRef = isCredentialRef(source.credentialRef) ? source.credentialRef : undefined
    if (source.credentialRef !== undefined && !activeRef) return unavailableProvider(filePath, source)

    const retired = retiredCredentialRefs(source, activeRef)
    if (activeRef) {
      try {
        const apiKey = await vault.get(activeRef)
        if (apiKey) {
          await retireProviderCredentials(filePath, vault, metadata, activeRef, retired)
          return normalizeLlmProviderSnapshot({ ...metadata, apiKey }, filePath)
        }
      } catch {
        // A locked or unavailable vault should keep the provider disabled.
      }
      return unavailableProvider(filePath, source)
    }

    const snapshot = normalizeLlmProviderSnapshot(value, filePath)
    if (snapshot.apiKey) {
      try {
        await saveProviderFile(filePath, vault, metadata, snapshot.apiKey, { retired })
      } catch {
        // Keep the legacy file available for a later migration attempt.
        return unavailableProvider(filePath, source)
      }
    } else {
      await retireProviderCredentials(filePath, vault, metadata, undefined, retired)
    }
    return snapshot
  })
}

export async function writeLlmProviderSnapshot(
  value: Pick<LlmProviderFile, "provider" | "apiKey" | "model"> & { baseUrl: string },
  filePath = getLlmProviderFilePath(homedir()),
  keyring?: Keyring
) {
  const snapshot = normalizeLlmProviderSnapshot(value, filePath)
  return withProviderFile(filePath, async () => {
    const { value: previous } = await readProviderFile(filePath)
    const vault = new SystemCredentialStore(filePath, keyring)
    const oldRef = providerRecord(previous)?.credentialRef
    const previousRef = isCredentialRef(oldRef) ? oldRef : undefined
    const previousKey = previousRef ? await vault.get(previousRef) : undefined
    if (!snapshot.apiKey && normalizeString(providerRecord(previous)?.apiKey)) {
      // A masked Settings submission must preserve legacy credential data
      // while the vault remains unavailable.
      await vault.get("legacy-migration")
    }
    await saveProviderFile(filePath, vault, {
      provider: snapshot.provider,
      model: snapshot.model,
      baseUrl: snapshot.provider === "custom" ? snapshot.baseUrl : null,
    }, snapshot.apiKey, {
      activeRef: previousRef,
      key: previousKey,
      retired: retiredCredentialRefs(previous, previousRef),
    })
    return snapshot
  })
}

function toSerializableValue(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value
  if (Array.isArray(value)) {
    return value.map((entry) => toSerializableValue(entry))
  }
  if (value instanceof Error) {
    return toSerializableValue(Object.fromEntries(
      Object.getOwnPropertyNames(value).map((key) => [key, (value as unknown as Record<string, unknown>)[key]])
    ))
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record).map((key) => [key, toSerializableValue(record[key])])
    )
  }
  return String(value)
}

export async function validateLlmProviderCredentials(
  value: Pick<LlmProviderSnapshot, "provider" | "apiKey" | "model" | "baseUrl">
): Promise<LlmProviderValidationResult> {
  const snapshot = normalizeLlmProviderSnapshot(value)
  if (!snapshot.enabled) {
    return {
      ok: false,
      error: {
        type: "config_error",
        message: snapshot.warning ?? "LLM provider configuration is incomplete.",
      },
    }
  }

  try {
    const client = new OpenAI({
      apiKey: snapshot.apiKey,
      baseURL: snapshot.resolvedBaseUrl,
    })
    await client.responses.create({
      model: snapshot.model,
      input: "Reply with ok.",
      max_output_tokens: 5,
    })
    return {
      ok: true,
      error: null,
    }
  } catch (error) {
    return {
      ok: false,
      error: toSerializableValue(error),
    }
  }
}
