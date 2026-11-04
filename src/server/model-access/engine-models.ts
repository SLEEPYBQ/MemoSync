// What a signed-in engine can really run, from the engine itself: a hard-coded
// list goes stale, and differs by account. Neither read starts a turn.
import { spawn } from "node:child_process"
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { ProviderModelOption } from "../../shared/types"
import { executableLauncher } from "./launcher"
import { killProcessTree } from "../process-utils"
import type { RuntimeEnv } from "./legacy"

export interface EngineModels {
  models: ProviderModelOption[]
  defaultModel?: string
}

export type EngineModelReader = (engine: "claude" | "codex", executablePath: string, env: RuntimeEnv) => Promise<EngineModels | null>

const READ_TIMEOUT_MS = 12_000
const MAX_PROTOCOL_BUFFER = 1024 * 1024

interface ClaudeModelInfo {
  value: string
  displayName?: string
  supportsEffort?: boolean
  resolvedModel?: string
  supportedEffortLevels?: readonly string[] | null
}
interface CodexModelInfo {
  id?: string
  model?: string
  displayName?: string
  isDefault?: boolean
  hidden?: boolean
  supportedReasoningEfforts?: readonly { reasoningEffort?: string }[] | null
  defaultReasoningEffort?: string
}

/** Keep the invocation alias separate from the concrete model shown to the user. */
function claudeModelLabel(model: ClaudeModelInfo): string {
  const name = model.displayName?.trim()
  const concrete = model.resolvedModel?.trim() || model.value
  const match = /^claude-([a-z]+)-(\d+)(?:[-.](\d{1,2}))?(?:-\d{8})?(\[[^\]]+\])?$/i.exec(concrete)
  if (match) {
    const [, family, major, minor, window] = match
    const version = minor ? `${major}.${minor}` : major
    // The CLI's full display name can carry useful qualifiers. Its short
    // family name alone cannot tell the user which version will run.
    const label = name && name !== model.value && /\d/.test(name)
      ? name
      : `${family![0]!.toUpperCase()}${family!.slice(1)} ${version}`
    const context = window ?? /\[[^\]]+\]$/.exec(model.value)?.[0]
    return context && !label.includes(context) ? `${label} ${context}` : label
  }
  if (name && concrete !== model.value && name !== concrete) return `${name} · ${concrete}`
  return name || concrete
}

/** "default" only says "whatever the CLI would pick", which one of the others already is. */
export function claudeModelsFrom(list: readonly ClaudeModelInfo[]): EngineModels | null {
  const models = list
    .filter(model => model.value && model.value !== "default")
    .map(model => ({
      id: model.value, label: claudeModelLabel(model), supportsEffort: model.supportsEffort ?? true,
      ...(model.resolvedModel?.trim() ? { resolvedModel: model.resolvedModel.trim() } : {}),
      ...(model.resolvedModel && model.resolvedModel !== model.value ? { aliases: [model.resolvedModel] } : {}),
      ...(model.supportsEffort === false ? { reasoningEfforts: [] } : model.supportedEffortLevels != null ? { reasoningEfforts: [...model.supportedEffortLevels] } : {}),
    }))
  if (!models.length) return null
  const defaultId = list.find(model => model.value === "default")?.resolvedModel
  const defaultModel = models.find(model => model.id === defaultId || model.aliases?.includes(defaultId ?? ""))?.id
  return { models, defaultModel: defaultModel ?? (models.some(model => model.id === "sonnet") ? "sonnet" : models[0]!.id) }
}

export function codexModelsFrom(list: readonly CodexModelInfo[]): EngineModels | null {
  const usable = list.filter(model => !model.hidden && (model.model || model.id))
  const models = usable.map(model => {
    const id = (model.model || model.id)!
    const reasoningEfforts = model.supportedReasoningEfforts?.flatMap(e => typeof e?.reasoningEffort === "string" ? [e.reasoningEffort] : [])
    return {
      id, label: model.displayName?.trim() || id, supportsEffort: (reasoningEfforts?.length ?? 0) > 0,
      ...(reasoningEfforts ? { reasoningEfforts } : {}),
      ...(typeof model.defaultReasoningEffort === "string" ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}),
    }
  })
  if (!models.length) return null
  const chosen = usable.find(model => model.isDefault)
  return { models, ...(chosen ? { defaultModel: (chosen.model || chosen.id)! } : {}) }
}

function withTimeout<T>(work: Promise<T>, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { onTimeout(); reject(new Error("engine-models-timeout")) }, READ_TIMEOUT_MS)
  })
  return Promise.race([work, expired]).finally(() => clearTimeout(timer))
}

async function readClaude(executablePath: string, env: RuntimeEnv) {
  // Waits forever, so the SDK starts up and answers without a prompt to run.
  const idle = (async function* (): AsyncGenerator<SDKUserMessage> { await new Promise(() => {}) })()
  const session = query({ prompt: idle, options: { pathToClaudeCodeExecutable: executablePath, env: env as Record<string, string | undefined> } })
  try {
    return claudeModelsFrom(await withTimeout(session.supportedModels(), () => session.close()))
  } finally {
    session.close()
  }
}

async function readCodex(executablePath: string, env: RuntimeEnv) {
  const launcher = await executableLauncher(executablePath, env)
  const child = spawn(launcher.command, [...launcher.args, "app-server"], { env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true })
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()))
  const replies = new Map<number, { method: string; resolve: (result: unknown) => void; reject: (error: Error) => void }>()
  let failure: Error | undefined
  let stopping = false
  const fail = (error: Error) => {
    if (stopping || failure) return
    failure = error
    for (const pending of replies.values()) pending.reject(error)
    replies.clear()
  }
  child.on("error", fail)
  child.on("exit", () => fail(new Error("engine-models-exited")))
  child.stdin.on("error", fail)
  child.stdin.on("close", () => fail(new Error("engine-models-stdin-closed")))
  child.stdout.on("error", fail)
  child.stdout.on("end", () => fail(new Error("engine-models-stdout-closed")))
  child.stdout.on("close", () => fail(new Error("engine-models-stdout-closed")))
  let buffered = ""
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    if (stopping || failure) return
    buffered += chunk
    if (buffered.length > MAX_PROTOCOL_BUFFER) { fail(new Error("engine-models-buffer-limit")); return }
    for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
      const line = buffered.slice(0, end)
      buffered = buffered.slice(end + 1)
      let message: { id?: number; result?: unknown; error?: unknown } | null
      try { message = JSON.parse(line) } catch { continue /* Not a protocol line. */ }
      if (!message || typeof message !== "object" || typeof message.id !== "number") continue
      const pending = replies.get(message.id)
      if (!pending) continue
      replies.delete(message.id)
      if (message.error != null) pending.reject(new Error(`engine-models-${pending.method}-failed`))
      else if (!Object.hasOwn(message, "result")) pending.reject(new Error("engine-models-invalid-reply"))
      else pending.resolve(message.result)
    }
  })
  let nextId = 1
  const write = (message: unknown) => {
    try {
      if (child.stdin.destroyed || !child.stdin.writable) throw new Error("engine-models-stdin-closed")
      child.stdin.write(`${JSON.stringify(message)}\n`, error => { if (error) fail(error) })
    } catch (error) { fail(error instanceof Error ? error : new Error("engine-models-write-failed")) }
  }
  const request = (method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
    if (failure) { reject(failure); return }
    const id = nextId++
    replies.set(id, { method, resolve, reject })
    write({ id, method, params })
  })
  try {
    // One deadline covers initialization and every page, including a hung final page.
    const read = (async () => {
      const initialized = await request("initialize", { clientInfo: { name: "memosync", version: "0" } })
      if (!initialized || typeof initialized !== "object") throw new Error("engine-models-initialize-failed")
      write({ method: "initialized" })
      const models: CodexModelInfo[] = []
      const cursors = new Set<string>()
      let cursor: string | null = null
      do {
        const reply = await request("model/list", { includeHidden: false, cursor, limit: 100 }) as { data?: CodexModelInfo[]; nextCursor?: unknown } | null
        if (!reply || !Array.isArray(reply.data) || (reply.nextCursor != null && typeof reply.nextCursor !== "string")) throw new Error("engine-models-invalid-reply")
        models.push(...reply.data)
        cursor = reply.nextCursor as string | null | undefined ?? null
        if (cursor !== null) {
          if (cursors.has(cursor)) throw new Error("engine-models-cursor-loop")
          cursors.add(cursor)
        }
      } while (cursor !== null)
      return codexModelsFrom(models)
    })()
    return await withTimeout(read, () => fail(new Error("engine-models-timeout")))
  } finally {
    fail(new Error("engine-models-closed"))
    stopping = true
    child.stdin.destroy()
    child.stdout.destroy()
    await killProcessTree(child)
    await closed
  }
}

export const readEngineModels: EngineModelReader = (engine, executablePath, env) =>
  engine === "claude" ? readClaude(executablePath, env) : readCodex(executablePath, env)
