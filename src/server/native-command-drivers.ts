import type { Query } from "@anthropic-ai/claude-agent-sdk"
import type { AgentSession } from "@earendil-works/pi-coding-agent"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { CodexReviewTarget, RuntimeCommand, RuntimeConnector, RuntimeDiscovery, RuntimeSkill, RuntimeSourceProof } from "../shared/runtime-commands"
import { discovery, type NativeCommandDiscovery, type NativeCommandRuntime } from "./command-registry"
import { contextIdentity, HOST_CONTRACT } from "./context-compiler"

/** MemoSync's own memory tool servers are host plumbing, not user connectors. */
const HOST_MCP = { claude: "memory", opencode: "memosync" } as const

/** Same model task as codex-rs/tui/prompt_for_init_command.md, not an init RPC. */
export const CODEX_INIT_PROMPT = `Generate a file named AGENTS.md that serves as a contributor guide for this repository.
Before writing, check whether AGENTS.md already exists in the current working directory. If it does, do not overwrite or modify it.
Your goal is to produce a clear, concise, and well-structured document with descriptive headings and actionable explanations for each section.
Follow the outline below, but adapt as needed — add sections if relevant, and omit those that do not apply to this project.

Document Requirements

- Title the document "Repository Guidelines".
- Use Markdown headings (#, ##, etc.) for structure.
- Keep the document concise. 200-400 words is optimal.
- Keep explanations short, direct, and specific to this repository.
- Provide examples where helpful (commands, directory paths, naming patterns).
- Maintain a professional, instructional tone.

Recommended Sections

Project Structure & Module Organization

- Outline the project structure, including where the source code, tests, and assets are located.

Build, Test, and Development Commands

- List key commands for building, testing, and running locally (e.g., npm test, make build).
- Briefly explain what each command does.

Coding Style & Naming Conventions

- Specify indentation rules, language-specific style preferences, and naming patterns.
- Include any formatting or linting tools used.

Testing Guidelines

- Identify testing frameworks and coverage requirements.
- State test naming conventions and how to run tests.

Commit & Pull Request Guidelines

- Summarize commit message conventions found in the project’s Git history.
- Outline pull request requirements (descriptions, linked issues, screenshots, etc.).

(Optional) Add other sections if relevant, such as Security & Configuration Tips, Architecture Overview, or Agent-Specific Instructions.`

/** No shell parsing or TUI strings: convert the documented slash arguments into a public target. */
export function parseCodexReviewTarget(args: string): CodexReviewTarget {
  const text = args.trim()
  if (!text || text === 'uncommitted') return { type: 'uncommittedChanges' }
  const [kind, ...parts] = text.split(/\s+/)
  if (kind === 'base') {
    if (parts.length !== 1) throw new Error('Review base requires one branch: /review base <branch>')
    return { type: 'baseBranch', branch: parts[0]! }
  }
  if (kind === 'commit') {
    if (!parts.length) throw new Error('Review commit requires a commit: /review commit <sha> [title]')
    return { type: 'commit', sha: parts[0]!, title: parts.slice(1).join(' ') || null }
  }
  const instructions = kind === 'custom' ? text.slice(kind.length).trim() : text
  if (!instructions) throw new Error('Review custom requires instructions')
  return { type: 'custom', instructions }
}

function proof(api: string, version: string): RuntimeSourceProof { return { api, version, evidence: "native-response" } }
/** SDK 0.3.241 / native 2.1.241 baseline and the documented 2.1 CLI input replay API. */
export function supportsClaudeInputReplay(version: string) {
  const patch = version.match(/(?:^|\s)2\.1\.(\d+)(?:$|\s)/)?.[1]
  return patch !== undefined && Number(patch) >= 241
}
function command(name: string, description: string, source: RuntimeSourceProof, route: RuntimeCommand["route"] = "native-prompt", skill = false): RuntimeCommand {
  return { id: `${skill ? "skill" : "native"}:${name}`, name, description, namespace: skill ? "skill" : "native", owner: "native-engine",
    arguments: { type: "string" }, requiresIdle: true, sideEffect: "model-turn", route, source, requiredRuntimeVersion: source.version }
}
async function discover<T>(source: RuntimeSourceProof, load: () => Promise<T[]>): Promise<RuntimeDiscovery<T>> {
  try { return discovery("ready", await load(), source) }
  catch (error) { return discovery(isUnsupported(error) ? "unsupported" : "failed", [], source, isUnsupported(error) ? "Public native API unsupported by this runtime/version" : "Native discovery failed") }
}
function isUnsupported(error: unknown) { return error instanceof Error && /method not found|unknown method|unsupported|not implemented|404/i.test(error.message) }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw new Error("Invalid native discovery response"); return value }
function connectorState(value: unknown): RuntimeConnector["state"] {
  return ["connected", "needs-auth", "disabled", "failed", "stale-schema"].includes(String(value)) ? value as RuntimeConnector["state"] : value === "needs_auth" ? "needs-auth" : "discovered"
}
/** Observe the existing Query stream; never start a second execution loop. */
export function createClaudeCommandRuntime(args: {
  query: Pick<Query, "supportedCommands" | "mcpServerStatus"> & { interrupt(): Promise<unknown>; reloadSkills?: Query['reloadSkills'] }
  session: () => string
  version: string
  acknowledgesInputs: boolean
  push: (text: string, uuid: string, shouldQuery: boolean) => void
  close: () => void
}) {
  let alive = true, hasCompact = false
  const knownSkillNames = new Set<string>()
  let nativeSession = args.session()
  const listeners = new Set<() => void>()
  let pending: { id: string; boundary: boolean; restore: boolean; acknowledged: boolean; resolve(): void; reject(error: Error): void } | undefined
  const invoke = (text: string, restore: boolean, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    signal.throwIfAborted()
    if (pending) throw new Error("Native control is busy")
    const id = crypto.randomUUID()
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); pending = undefined }
    const onAbort = () => { cleanup(); reject(new Error("Native control cancelled")) }
    const timer = setTimeout(() => { cleanup(); alive = false; args.close(); reject(new Error("Native control completion timed out")) }, 120_000)
    pending = { id, boundary: false, restore, acknowledged: false, resolve: () => { cleanup(); resolve() }, reject: error => { cleanup(); reject(error) } }
    signal.addEventListener("abort", onAbort, { once: true })
    try { args.push(text, id, !restore) } catch { pending?.reject(new Error("Native control input failed")) }
  })
  const runtime: NativeCommandRuntime = {
    instance: crypto.randomUUID(), get session() { return nativeSession }, version: args.version, alive: () => alive,
    onChanged(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async discover() {
      const source = proof("Query.supportedCommands()", args.version)
      const commands = await discover<RuntimeCommand>(source, async () => (await args.query.supportedCommands()).map(c => ({ ...command(c.name, c.description, source), arguments: { type: "string" as const, hint: c.argumentHint } })))
      const skillSource = proof('Query.reloadSkills()', args.version)
      const skills: RuntimeDiscovery<RuntimeSkill> = args.query.reloadSkills ? await discover(skillSource, async () => {
        const result = await args.query.reloadSkills!()
        return result.skills.map(s => ({ id: s.name, name: s.name, description: s.description, discovered: true,
          loaded: null, enabled: true, source: skillSource }))
      }) : discovery('unsupported', [], source, 'This runtime does not expose skill identity or current-session instruction loading')
      if (skills.status === 'ready' && commands.status === 'ready') {
        for (const skill of skills.items) knownSkillNames.add(skill.name)
        commands.items = [...commands.items.filter(c => !knownSkillNames.has(c.name)),
          ...skills.items.map(s => command(s.name, s.description, skillSource, 'native-prompt', true))]
      }
      hasCompact = commands.status === "ready" && commands.items.some(c => c.name === "compact")
      const mcpSource = proof("Query.mcpServerStatus()", args.version)
      const connectors = await discover(mcpSource, async () => (await args.query.mcpServerStatus()).filter(s => s.name !== HOST_MCP.claude).map(s => ({ id: `mcp:${s.name}`, name: s.name, kind: "mcp" as const,
        state: connectorState(s.status), schemaRevision: s.tools ? contextIdentity(s.tools) : undefined, source: mcpSource })))
      return { commands, skills, connectors }
    },
    compactSource: { api: 'Query input /compact + compact_boundary + correlated result', version: args.version, evidence: 'public-api' },
    get compact() { return hasCompact ? (signal: AbortSignal) => invoke("/compact", false, signal) : undefined },
    restore: args.acknowledgesInputs ? async (text, signal) => { await invoke(`${HOST_CONTRACT}\n\n${text}`, true, signal); return { delivery: "native-accepted" } } : undefined,
    async cancel() { alive = false; try { await args.query.interrupt() } finally { args.close() } },
  }
  return { runtime,
    observe(message: unknown): boolean {
      const m = record(message)
      if (m.type === 'system' && m.subtype === 'init' && typeof m.session_id === 'string') nativeSession = m.session_id
      if (m.type === "system" && m.subtype === "commands_changed") { for (const listener of listeners) listener(); return true }
      if (!pending) return false
      const origin = record(m.origin).kind
      if (typeof origin === 'string' && origin !== 'human') return false
      if (m.type === 'user' && m.uuid === pending.id && pending.restore) { pending.acknowledged = true; return true }
      if (m.type === "system" && m.subtype === "compact_boundary" && record(m.compact_metadata).trigger === 'manual') pending.boundary = true
      if (m.type === "result") {
        // Control inputs own the idle Query until their result; no ordinary turn/capture is admitted.
        const ids = [m.user_message_uuid, ...(Array.isArray(m.user_message_uuids) ? m.user_message_uuids : [])]
        if (ids.some(id => id === pending!.id)) {
          if (m.is_error || (pending.restore ? !pending.acknowledged : !pending.boundary)) pending.reject(new Error("Native compact or no-reply append completion was not observed"))
          else pending.resolve()
        }
      }
      return true
    },
    dispose() { alive = false; pending?.reject(new Error("Native session closed")); listeners.clear() },
  }
}

export function createPiCommandRuntime(session: AgentSession, profile: string, alive: () => boolean, version = 'unknown'): NativeCommandRuntime {
  const source = proof("AgentSession.resourceLoader / promptTemplates", version)
  return { instance: crypto.randomUUID(), get session() { return session.sessionId }, version, profile, alive,
    async discover() {
      await session.resourceLoader.reload?.()
      const skills = session.resourceLoader.getSkills().skills
      const commands = [
        ...session.promptTemplates.map(t => command(t.name, t.description, source)),
        ...skills.map(s => command(`skill:${s.name}`, s.description, source, "native-prompt", true)),
      ]
      return { commands: discovery("ready", commands, source), skills: discovery("ready", skills.map(s => ({ id: s.name, name: s.name, description: s.description,
        discovered: true, loaded: null, enabled: true, source })), source),
        connectors: discovery("unsupported", [], proof("Pi SDK MCP extension binding", version), "This isolated SDK session does not bind the CLI MCP extension") }
    },
    compactSource: { api: 'AgentSession.compact()', version, evidence: 'public-api' },
    async compact(signal) { signal.throwIfAborted(); if (session.isStreaming) throw new Error("Pi session is busy"); await session.compact(); signal.throwIfAborted() },
    async restore(text, signal) { signal.throwIfAborted(); await session.sendCustomMessage({ customType: "memosync-context", content: `${HOST_CONTRACT}\n\n${text}`, display: false }, { triggerTurn: false }); signal.throwIfAborted(); return { delivery: "native-accepted" } },
    async cancel() { session.abortCompaction(); await session.abort() },
  }
}

export function createOpencodeCommandRuntime(args: { client: OpencodeClient; session: () => string; version: string; alive: () => boolean; model: () => { providerID: string; modelID: string } | undefined }): NativeCommandRuntime {
  const source = proof("command.list", args.version)
  return { instance: crypto.randomUUID(), get session() { return args.session() }, version: args.version, alive: args.alive,
    async discover() {
      const commands = await discover(source, async () => {
        const response = await args.client.command.list()
        if (response.error) throw new Error("command.list failed")
        return array(response.data).map(value => { const c = record(value); if (typeof c.name !== "string") throw new Error("Invalid command"); return command(c.name, String(c.description ?? ""), source, "session-command", c.source === "skill") })
      })
      const skillSource = proof("app.skills", args.version)
      const skills = await discover<RuntimeSkill>(skillSource, async () => {
        const response = await args.client.app.skills()
        if (response.error) throw new Error("skill API unsupported")
        return array(response.data).map(value => { const s = record(value); if (typeof s.name !== 'string') throw new Error('Invalid skill'); return { id: s.name, name: s.name, description: String(s.description ?? ""), discovered: true,
          loaded: null, enabled: null, instructionVersion: typeof s.content === 'string' ? contextIdentity(s.content) : undefined, source: skillSource } })
      })
      const mcpSource = proof("mcp.status", args.version)
      const connectors = await discover<RuntimeConnector>(mcpSource, async () => {
        const response = await args.client.mcp.status()
        if (response.error) throw new Error("mcp.status failed")
        return Object.entries(response.data ?? {}).filter(([name]) => name !== HOST_MCP.opencode).map(([name, value]) => ({ id: `mcp:${name}`, name, kind: "mcp", state: connectorState(record(value).status), source: mcpSource }))
      })
      return { commands, skills, connectors }
    },
    compactSource: { api: 'session.summarize (await native handler)', version: args.version, evidence: 'public-api' },
    compact: /(?:^|\s)1\.19\.5(?:$|\s)/.test(args.version) && args.model() ? async signal => {
      const model = args.model()
      if (!model) throw new Error("OpenCode compaction requires an explicit native model")
      const result = await args.client.session.summarize({ sessionID: args.session(), ...model, auto: false }, { signal })
      if (result.error || result.data !== true) throw new Error("OpenCode summarize failed")
    } : undefined,
    async restore(text, signal) {
      const result = await args.client.session.prompt({ sessionID: args.session(), noReply: true, parts: [{ type: "text", text: `${HOST_CONTRACT}\n\n${text}` }] }, { signal })
      if (result.error) throw new Error("OpenCode context append failed")
      return { delivery: "native-accepted" }
    },
    async cancel() { const result = await args.client.session.abort({ sessionID: args.session() }); if (result.error) throw new Error("OpenCode abort failed") },
  }
}

/** Codex's TUI commands have no blanket app-server equivalent. Only advertise routed public APIs. */
export async function discoverCodexCommands(request: (method: string, params: unknown) => Promise<unknown>, cwd: string, version: string): Promise<NativeCommandDiscovery> {
  const source = proof("skills/list", version)
  const skills = await discover<RuntimeSkill>(source, async () => {
    const result = record(await request("skills/list", { cwds: [cwd], forceReload: true }))
    return array(result.data).flatMap(value => array(record(value).skills)).map(value => {
      const s = record(value)
      if (typeof s.name !== "string") throw new Error("Invalid skill")
      return { id: typeof s.path === "string" ? s.path : s.name, name: s.name, description: String(s.description ?? ""), discovered: true, loaded: null,
        enabled: typeof s.enabled === "boolean" ? s.enabled : null, source }
    })
  })
  const mcpSource = proof("mcpServerStatus/list", version)
  const connectors = await discover<RuntimeConnector>(mcpSource, async () => {
    const items: RuntimeConnector[] = []
    let cursor: string | undefined
    const seen = new Set<string>()
    do {
      const result = record(await request("mcpServerStatus/list", cursor ? { cursor } : {}))
      items.push(...array(result.data).map(value => { const s = record(value); if (typeof s.name !== 'string') throw new Error('Invalid MCP status'); return { id: `mcp:${s.name}`, name: s.name, kind: 'mcp' as const,
        state: s.authStatus === 'notLoggedIn' ? 'needs-auth' as const : 'discovered' as const,
        schemaRevision: s.tools ? contextIdentity(s.tools) : undefined, source: mcpSource } }))
      cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined
      if (cursor && (seen.has(cursor) || seen.size >= 64)) throw new Error('Invalid MCP pagination')
      if (cursor) seen.add(cursor)
    } while (cursor)
    return items
  })
  const skillCommands = skills.status === 'ready' ? skills.items.filter(s => s.enabled !== false && s.id !== s.name).map(s => ({
    ...command(`skill:${s.name}`, s.description ?? '', source, 'native-skill', true), nativeSkill: { name: s.name, path: s.id },
  })) : []
  const reviewSource: RuntimeSourceProof = { api: 'review/start (inline) + turn events', version, evidence: 'public-api' }
  const initSource: RuntimeSourceProof = { api: 'MemoSync init prompt via turn/start (Codex TUI init behavior)', version, evidence: 'host-config' }
  const commands: RuntimeCommand[] = [
    { ...command('review', 'Review changes using the native reviewer', reviewSource, 'review-start'),
      arguments: { type: 'string', hint: '[uncommitted | base <branch> | commit <sha> [title] | custom <instructions>]' } },
    { ...command('init', 'Create AGENTS.md through an initialization turn (MemoSync host command)', initSource, 'host-prompt'),
      id: 'host:init', namespace: 'host', owner: 'memosync' },
    ...skillCommands,
  ]
  // Independently mapped controls remain usable when skill discovery is unsupported or fails.
  return { commands: discovery('ready', commands, reviewSource), skills, connectors }
}
