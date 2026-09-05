import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ServerWebSocket } from "bun"
import { DEFAULT_DEEPSEEK_MODEL_ID, PROTOCOL_VERSION } from "../shared/types"
import type { ClientCommand, ClientEnvelope, ServerEnvelope, SubscriptionTopic } from "../shared/protocol"
import { isClientEnvelope } from "../shared/protocol"
import type { AgentCoordinator } from "./agent"
import type { AppSettingsManager } from "./app-settings"
import type { DiscoveredProject } from "./discovery"
import { DiffStore } from "./diff-store"
import { EventStore } from "./event-store"
import { openExternal } from "./external-open"
import { KeybindingsManager } from "./keybindings"
import { killLocalHttpServer, listLocalHttpServers } from "./local-http-servers"
import { ensureProjectDirectory, resolveLocalPath } from "./paths"
import { readProjectQuickActions, writeProjectQuickActions } from "./project-quick-actions"
import { writeStandaloneTranscriptExport } from "./standalone-export"
import { TerminalManager } from "./terminal-manager"
import type { UpdateManager } from "./update-manager"
import type { StudyProjectAccess } from "./study-project-access"
import type { StudyPreviewRuntimeController } from "./study-preview-runtime"
import { deriveChatSnapshot, deriveLocalProjectsSnapshot, deriveMemoryRecordTranscript, deriveSidebarData } from "./read-models"
import type {
  AppSettingsPatch,
  AppSettingsSnapshot,
  InstalledSkillsSnapshot,
  LlmProviderSnapshot,
  LlmProviderValidationResult,
  SkillInstallResult,
  SkillSearchSnapshot,
  SkillUninstallResult,
} from "../shared/types"

const DEFAULT_CHAT_RECENT_LIMIT = 200
const DROPPED_SNAPSHOT_RETRY_MS = 10
const SKILL_AGENT_ALIASES = ["universal", "claude-code"] as const
const STUDY_PROJECT_MUTATING_CHAT_COMMANDS = new Set<ClientCommand["type"]>([
  "chat.initGit",
  "chat.publishToGitHub",
  "chat.mergeBranch",
  "chat.checkoutBranch",
  "chat.syncBranch",
  "chat.createBranch",
  "chat.commitDiffs",
  "chat.discardDiffFile",
  "chat.ignoreDiffFile",
  "chat.exportStandalone",
])

function isSendToStartingProfilingEnabled() {
  return process.env.MEMOSYNC_PROFILE_SEND_TO_STARTING === "1"
}

function logSendToStartingProfile(
  traceId: string | null | undefined,
  startedAt: number | null | undefined,
  stage: string,
  details?: Record<string, unknown>
) {
  if (!traceId || startedAt === undefined || startedAt === null || !isSendToStartingProfilingEnabled()) {
    return
  }

  console.log("[memosync/send->starting][server]", JSON.stringify({
    traceId,
    stage,
    elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
    ...details,
  }))
}

function countSubscriptionsByTopic(ws: ServerWebSocket<ClientState>) {
  let sidebar = 0
  let chat = 0
  let projectGit = 0
  let localProjects = 0
  let update = 0
  let keybindings = 0
  let appSettings = 0
  let terminal = 0

  for (const topic of ws.data.subscriptions.values()) {
    switch (topic.type) {
      case "sidebar":
        sidebar += 1
        break
      case "chat":
        chat += 1
        break
      case "project-git":
        projectGit += 1
        break
      case "local-projects":
        localProjects += 1
        break
      case "update":
        update += 1
        break
      case "keybindings":
        keybindings += 1
        break
      case "app-settings":
        appSettings += 1
        break
      case "terminal":
        terminal += 1
        break
    }
  }

  return {
    total: ws.data.subscriptions.size,
    sidebar,
    chat,
    projectGit,
    localProjects,
    update,
    keybindings,
    appSettings,
    terminal,
  }
}

export interface ClientState {
  subscriptions: Map<string, SubscriptionTopic>
  snapshotSignatures: Map<string, string>
  protectedDraftChatIds?: Set<string>
}

interface CreateWsRouterArgs {
  store: EventStore
  diffStore?: Pick<DiffStore, "getProjectSnapshot" | "refreshSnapshot" | "initializeGit" | "getGitHubPublishInfo" | "checkGitHubRepoAvailability" | "publishToGitHub" | "listBranches" | "previewMergeBranch" | "mergeBranch" | "syncBranch" | "checkoutBranch" | "createBranch" | "generateCommitMessage" | "commitFiles" | "discardFile" | "ignoreFile" | "readPatch">
  agent: AgentCoordinator
  terminals: TerminalManager
  keybindings: KeybindingsManager
  appSettings?: Pick<AppSettingsManager, "getSnapshot"> & Partial<Pick<AppSettingsManager, "writePatch" | "onChange">>
  llmProvider?: {
    read: () => Promise<LlmProviderSnapshot>
    write: (value: Pick<LlmProviderSnapshot, "provider" | "apiKey" | "model" | "baseUrl">) => Promise<LlmProviderSnapshot>
    validate: (value: Pick<LlmProviderSnapshot, "provider" | "apiKey" | "model" | "baseUrl">) => Promise<LlmProviderValidationResult>
  }
  refreshDiscovery: () => Promise<DiscoveredProject[]>
  getDiscoveredProjects: () => DiscoveredProject[]
  machineDisplayName: string
  updateManager: UpdateManager | null
  /** The port this app itself serves on — excluded from local-server discovery
   * so the panel doesn't "discover" MemoSync itself. */
  getSelfPort?: () => number
  /**
   * Study deployments cut every non-essential outbound connection: the
   * skills.sh registry (search/install) refuses here. Defaults to enabled.
   */
  remoteSkillsEnabled?: boolean
  /** Present only in study mode: project topology is researcher-managed. */
  studyProjectAccess?: StudyProjectAccess
  /** Formal-study preview owner; Browser polling may recover only its current degraded project. */
  studyPreviewRuntime?: Pick<StudyPreviewRuntimeController, "recover">
  canAutoHealStudyPreview?: (projectId: string) => boolean
  listLocalHttpServersFn?: typeof listLocalHttpServers
  killLocalHttpServerFn?: typeof killLocalHttpServer
}

interface SnapshotBroadcastFilter {
  includeSidebar?: boolean
  includeLocalProjects?: boolean
  includeUpdate?: boolean
  includeKeybindings?: boolean
  includeAppSettings?: boolean
  chatIds?: Set<string>
  projectIds?: Set<string>
  terminalIds?: Set<string>
}

interface SnapshotComputationCache {
  sidebar?: {
    data: ReturnType<typeof deriveSidebarData>
    signature: string
  }
}

/** Prevent older snapshot loops from overtaking newer terminal state on a
 * different socket when several browser tabs are connected. */
export function createSerialExecutor() {
  let tail: Promise<void> = Promise.resolve()
  return function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation, operation)
    tail = result.then(() => undefined, () => undefined)
    return result
  }
}

function getSidebarProjectOrder(store: EventStore) {
  return typeof store.getSidebarProjectOrder === "function"
    ? store.getSidebarProjectOrder()
    : []
}

function maskLlmProviderSnapshot(snapshot: LlmProviderSnapshot): LlmProviderSnapshot {
  return {
    ...snapshot,
    apiKey: "",
    hasApiKey: snapshot.apiKey.trim().length > 0,
  }
}

function resolveSubmittedLlmApiKey(
  current: LlmProviderSnapshot,
  provider: LlmProviderSnapshot["provider"],
  submittedApiKey: string,
  submittedBaseUrl: string,
) {
  const submitted = submittedApiKey.trim()
  if (submitted) return submitted
  // A saved key belongs to its provider. Reusing it after switching providers
  // could disclose that credential to a different (or custom) endpoint.
  const sameEndpoint = provider !== "custom" || current.baseUrl.trim() === submittedBaseUrl.trim()
  return current.provider === provider && sameEndpoint ? current.apiKey : ""
}

function send(ws: ServerWebSocket<ClientState>, message: ServerEnvelope) {
  const payload = JSON.stringify(message)
  return {
    payloadBytes: payload.length,
    status: ws.send(payload),
  }
}

export function assertSafeSkillSource(source: string) {
  const normalized = source.trim()
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) {
    throw new Error("Skill source must be an owner/repo pair.")
  }
  return normalized
}

export function assertSafeSkillId(skillId: string) {
  const normalized = skillId.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(normalized)) {
    throw new Error("Skill id is invalid.")
  }
  return normalized
}

export function getGlobalSkillLockPath() {
  const xdgStateHome = process.env.XDG_STATE_HOME?.trim()
  if (xdgStateHome) {
    return path.join(xdgStateHome, "skills", ".skill-lock.json")
  }
  return path.join(os.homedir(), ".agents", ".skill-lock.json")
}

function asString(value: unknown) {
  return typeof value === "string" ? value : ""
}

export function parseInstalledSkillsLock(parsed: unknown, lockFilePath: string): InstalledSkillsSnapshot {
  const skillsRecord = parsed
    && typeof parsed === "object"
    && "skills" in parsed
    && parsed.skills
    && typeof parsed.skills === "object"
    && !Array.isArray(parsed.skills)
      ? parsed.skills as Record<string, unknown>
      : {}

  const skills = Object.entries(skillsRecord)
    .filter(([, entry]) => entry && typeof entry === "object" && !Array.isArray(entry))
    .map(([name, entry]) => {
      const record = entry as Record<string, unknown>
      return {
        name,
        source: asString(record.source),
        sourceType: asString(record.sourceType),
        sourceUrl: asString(record.sourceUrl),
        skillPath: asString(record.skillPath) || undefined,
        installedAt: asString(record.installedAt),
        updatedAt: asString(record.updatedAt),
        pluginName: asString(record.pluginName) || undefined,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))

  return {
    lockFilePath,
    skills,
  }
}

export async function listInstalledSkills(lockFilePath = getGlobalSkillLockPath()): Promise<InstalledSkillsSnapshot> {
  try {
    return parseInstalledSkillsLock(JSON.parse(await readFile(lockFilePath, "utf8")), lockFilePath)
  } catch {
    return {
      lockFilePath,
      skills: [],
    }
  }
}

export async function searchSkills(query: string, limit = 100): Promise<SkillSearchSnapshot> {
  const normalizedQuery = query.trim()
  if (normalizedQuery.length < 2) {
    return {
      query: normalizedQuery,
      searchType: "fuzzy",
      skills: [],
      count: 0,
      duration_ms: 0,
    }
  }

  const normalizedLimit = Math.max(1, Math.min(100, Math.trunc(limit)))
  const url = new URL("https://skills.sh/api/search")
  url.searchParams.set("q", normalizedQuery)
  url.searchParams.set("limit", String(normalizedLimit))

  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    throw new Error(`Skills search failed with status ${response.status}.`)
  }

  const payload = await response.json() as Partial<SkillSearchSnapshot>
  return {
    query: typeof payload.query === "string" ? payload.query : normalizedQuery,
    searchType: typeof payload.searchType === "string" ? payload.searchType : "fuzzy",
    skills: Array.isArray(payload.skills)
      ? payload.skills
        .filter((skill) => (
          skill
          && typeof skill === "object"
          && typeof skill.id === "string"
          && typeof skill.skillId === "string"
          && typeof skill.name === "string"
          && typeof skill.source === "string"
        ))
        .map((skill) => ({
          id: skill.id,
          skillId: skill.skillId,
          name: skill.name,
          installs: typeof skill.installs === "number" ? skill.installs : 0,
          source: skill.source,
        }))
      : [],
    count: typeof payload.count === "number" ? payload.count : 0,
    duration_ms: typeof payload.duration_ms === "number" ? payload.duration_ms : 0,
  }
}

export function buildInstallSkillCommand(source: string, skillId: string) {
  return [
    process.platform === "win32" ? "npx.cmd" : "npx",
    "skills",
    "add",
    assertSafeSkillSource(source),
    "--skill",
    assertSafeSkillId(skillId),
    "--global",
    "--agent",
    ...SKILL_AGENT_ALIASES,
    "--yes",
  ]
}

export function buildUninstallSkillCommand(skillId: string) {
  return [
    process.platform === "win32" ? "npx.cmd" : "npx",
    "skills",
    "remove",
    assertSafeSkillId(skillId),
    "--global",
    "--agent",
    ...SKILL_AGENT_ALIASES,
    "--yes",
  ]
}

async function runSkillCommand(command: string[]) {
  const cwd = os.homedir()
  const subprocess = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      DISABLE_TELEMETRY: process.env.DISABLE_TELEMETRY ?? "1",
    },
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ])

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `skills CLI exited with code ${exitCode}.`)
  }

  return { cwd, stdout, stderr }
}

export async function installSkill(source: string, skillId: string): Promise<SkillInstallResult> {
  const command = buildInstallSkillCommand(source, skillId)
  const { cwd, stdout, stderr } = await runSkillCommand(command)
  return {
    source: command[3],
    skillId: command[5],
    command,
    cwd,
    stdout,
    stderr,
  }
}

export async function uninstallSkill(skillId: string): Promise<SkillUninstallResult> {
  const command = buildUninstallSkillCommand(skillId)
  const { cwd, stdout, stderr } = await runSkillCommand(command)
  return {
    skillId: command[3],
    command,
    cwd,
    stdout,
    stderr,
  }
}

function ensureSnapshotSignatures(ws: ServerWebSocket<ClientState>) {
  if (!ws.data.snapshotSignatures) {
    ws.data.snapshotSignatures = new Map()
  }

  return ws.data.snapshotSignatures
}

export function createWsRouter({
  store,
  diffStore,
  agent,
  terminals,
  keybindings,
  appSettings,
  llmProvider,
  refreshDiscovery,
  getDiscoveredProjects,
  machineDisplayName,
  updateManager,
  getSelfPort,
  remoteSkillsEnabled = true,
  studyProjectAccess,
  studyPreviewRuntime,
  canAutoHealStudyPreview = () => false,
  listLocalHttpServersFn = listLocalHttpServers,
  killLocalHttpServerFn = killLocalHttpServer,
}: CreateWsRouterArgs) {
  const sockets = new Set<ServerWebSocket<ClientState>>()
  const dirtySnapshotSockets = new Set<ServerWebSocket<ClientState>>()
  const pendingSnapshotRetryTimers = new Map<ServerWebSocket<ClientState>, ReturnType<typeof setTimeout>>()
  let pendingBroadcastTimer: ReturnType<typeof setTimeout> | null = null
  let pendingBroadcastAll = false
  const pendingBroadcastChatIds = new Set<string>()
  const enqueueSnapshotBroadcast = createSerialExecutor()
  const resolvedDiffStore = diffStore ?? {
    getProjectSnapshot: () => ({ status: "unknown", branchName: undefined, defaultBranchName: undefined, hasOriginRemote: undefined, originRepoSlug: undefined, hasUpstream: undefined, aheadCount: undefined, behindCount: undefined, lastFetchedAt: undefined, files: [] as const, branchHistory: { entries: [] as const } }),
    refreshSnapshot: async () => false,
    initializeGit: async () => ({ ok: true, branchName: undefined, snapshotChanged: false }),
    getGitHubPublishInfo: async () => ({ ghInstalled: false, authenticated: false, activeAccountLogin: undefined, owners: [], suggestedRepoName: "my-repo" }),
    checkGitHubRepoAvailability: async () => ({ available: false, message: "Unavailable" }),
    publishToGitHub: async () => ({ ok: false, title: "Publish failed", message: "Unavailable", snapshotChanged: false }),
    listBranches: async () => ({ recent: [], local: [], remote: [], pullRequests: [], pullRequestsStatus: "unavailable" as const }),
    previewMergeBranch: async () => ({ currentBranchName: undefined, targetBranchName: "", targetDisplayName: "", status: "error" as const, commitCount: 0, hasConflicts: false, message: "Merge preview unavailable." }),
    mergeBranch: async () => ({ ok: false as const, title: "Merge failed", message: "Merge unavailable.", snapshotChanged: false }),
    syncBranch: async () => ({ ok: true, action: "fetch" as const, branchName: undefined, snapshotChanged: false }),
    checkoutBranch: async () => ({ ok: true, branchName: undefined, snapshotChanged: false }),
    createBranch: async () => ({ ok: true, branchName: "main", snapshotChanged: false }),
    generateCommitMessage: async () => ({ subject: "Update selected files", body: "", usedFallback: true, failureMessage: null }),
    commitFiles: async () => ({ ok: true, mode: "commit_only" as const, branchName: undefined, pushed: false, snapshotChanged: false }),
    discardFile: async () => ({ snapshotChanged: false }),
    ignoreFile: async () => ({ snapshotChanged: false }),
    readPatch: async () => ({ patch: "" }),
  }
  const resolvedLlmProvider = llmProvider ?? {
    read: async () => ({
      provider: "openai" as const,
      apiKey: "",
      model: "gpt-5.4-mini",
      baseUrl: "",
      resolvedBaseUrl: "https://api.openai.com/v1",
      enabled: false,
      warning: null,
      filePathDisplay: "~/.memosync/llm-provider.json",
    }),
    write: async ({ provider, apiKey, model, baseUrl }: {
      provider: "openai" | "openrouter" | "custom"
      apiKey: string
      model: string
      baseUrl: string
    }) => ({
      provider,
      apiKey,
      model,
      baseUrl,
      resolvedBaseUrl: provider === "openrouter"
        ? "https://openrouter.ai/api/v1"
        : provider === "custom"
          ? baseUrl
          : "https://api.openai.com/v1",
      enabled: false,
      warning: null,
      filePathDisplay: "~/.memosync/llm-provider.json",
    }),
    validate: async () => ({
      ok: false,
      error: {
        type: "config_error",
        message: "LLM provider validation unavailable.",
      },
    }),
  }
  let llmProviderWriteQueue: Promise<void> = Promise.resolve()
  function enqueueLlmProviderWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = llmProviderWriteQueue.then(operation, operation)
    llmProviderWriteQueue = result.then(() => undefined, () => undefined)
    return result
  }
  let fallbackAppSettingsSnapshot: AppSettingsSnapshot = {
    browserSettingsMigrated: false,
    theme: "system",
    chatSoundPreference: "always",
    chatSoundId: "funk",
    terminal: {
      scrollbackLines: 1_000,
      minColumnWidth: 450,
    },
    editor: {
      preset: "cursor",
      commandTemplate: "cursor {path}",
    },
    defaultProvider: "last_used",
    providerDefaults: {
      claude: {
        model: DEFAULT_DEEPSEEK_MODEL_ID,
        modelOptions: {
          reasoningEffort: "high",
          contextWindow: "1m",
        },
        planMode: false,
      },
      codex: {
        model: "gpt-5.5",
        modelOptions: {
          reasoningEffort: "high",
          fastMode: false,
        },
        planMode: false,
      },
    },
    memoryPreview: {
      enabled: true,
      autoProceedWhenEmpty: true,
    },
    warning: null,
    filePathDisplay: "~/.memosync/data/settings.json",
  }
  const mergeAppSettingsPatch = (snapshot: AppSettingsSnapshot, patch: AppSettingsPatch): AppSettingsSnapshot => ({
    ...snapshot,
    ...patch,
    terminal: {
      ...snapshot.terminal,
      ...patch.terminal,
    },
    editor: {
      ...snapshot.editor,
      ...patch.editor,
    },
    providerDefaults: {
      claude: {
        ...snapshot.providerDefaults.claude,
        ...patch.providerDefaults?.claude,
        modelOptions: {
          ...snapshot.providerDefaults.claude.modelOptions,
          ...patch.providerDefaults?.claude?.modelOptions,
        },
      },
      codex: {
        ...snapshot.providerDefaults.codex,
        ...patch.providerDefaults?.codex,
        modelOptions: {
          ...snapshot.providerDefaults.codex.modelOptions,
          ...patch.providerDefaults?.codex?.modelOptions,
        },
      },
    },
    memoryPreview: {
      ...snapshot.memoryPreview,
      ...patch.memoryPreview,
    },
  })
  const resolvedAppSettings = {
    getSnapshot: () => appSettings?.getSnapshot() ?? fallbackAppSettingsSnapshot,
    writePatch: async (patch: AppSettingsPatch) => {
      if (appSettings?.writePatch) return await appSettings.writePatch(patch)
      fallbackAppSettingsSnapshot = mergeAppSettingsPatch(appSettings?.getSnapshot() ?? fallbackAppSettingsSnapshot, patch)
      return fallbackAppSettingsSnapshot
    },
    onChange: (listener: (snapshot: AppSettingsSnapshot) => void) => appSettings?.onChange?.(listener) ?? (() => {}),
  }

  function getProtectedChatIds() {
    const activeStatuses = agent.getActiveStatuses()
    const drainingChatIds = typeof agent.getDrainingChatIds === "function"
      ? agent.getDrainingChatIds()
      : new Set<string>()
    return new Set([
      ...activeStatuses.keys(),
      ...drainingChatIds.values(),
    ])
  }

  function getProtectedDraftChatIds(extraSockets?: Iterable<ServerWebSocket<ClientState>>) {
    const protectedChatIds = new Set<string>()

    for (const socket of sockets) {
      for (const chatId of socket.data.protectedDraftChatIds ?? []) {
        protectedChatIds.add(chatId)
      }
    }

    for (const socket of extraSockets ?? []) {
      for (const chatId of socket.data.protectedDraftChatIds ?? []) {
        protectedChatIds.add(chatId)
      }
    }

    return protectedChatIds
  }

  async function maybePruneStaleEmptyChats(extraSockets?: Iterable<ServerWebSocket<ClientState>>) {
    const startedAt = performance.now()
    const activeChatIds = getProtectedChatIds()
    const protectedDraftChatIds = getProtectedDraftChatIds(extraSockets)
    const prunedChatIds = await store.pruneStaleEmptyChats?.({
      activeChatIds,
      protectedChatIds: protectedDraftChatIds,
    })
    if (isSendToStartingProfilingEnabled()) {
      console.log("[memosync/send->starting][server]", JSON.stringify({
        stage: "ws.prune_stale_empty_chats",
        elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
        activeChatCount: activeChatIds.size,
        protectedDraftChatCount: protectedDraftChatIds.size,
        prunedCount: prunedChatIds?.length ?? 0,
        totalChatCount: store.state.chatsById.size,
        totalProjectCount: store.state.projectsById.size,
      }))
    }
  }

  function shouldIncludeTopic(topic: SubscriptionTopic, filter?: SnapshotBroadcastFilter) {
    if (!filter) {
      return true
    }

    if (topic.type === "sidebar") {
      return Boolean(filter.includeSidebar)
    }
    if (topic.type === "local-projects") {
      return Boolean(filter.includeLocalProjects)
    }
    if (topic.type === "update") {
      return Boolean(filter.includeUpdate)
    }
    if (topic.type === "keybindings") {
      return Boolean(filter.includeKeybindings)
    }
    if (topic.type === "app-settings") {
      return Boolean(filter.includeAppSettings)
    }
    if (topic.type === "chat") {
      return filter.chatIds?.has(topic.chatId) ?? false
    }
    if (topic.type === "project-git") {
      return filter.projectIds?.has(topic.projectId) ?? false
    }
    if (topic.type === "terminal") {
      return filter.terminalIds?.has(topic.terminalId) ?? false
    }

    return true
  }

  function getSidebarSnapshotCacheEntry(cache?: SnapshotComputationCache) {
    if (cache?.sidebar) {
      return cache.sidebar
    }

    const startedAt = performance.now()
    const data = deriveSidebarData(store.state, agent.getActiveStatuses(), {
      sidebarProjectOrder: getSidebarProjectOrder(store),
      drainingChatIds: agent.getDrainingChatIds(),
    })
    if (isSendToStartingProfilingEnabled()) {
      const totalChats = data.projectGroups.reduce((count, group) => count + group.chats.length, 0)
      console.log("[memosync/send->starting][server]", JSON.stringify({
        stage: "ws.sidebar_snapshot_built",
        elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
        projectGroupCount: data.projectGroups.length,
        chatCount: totalChats,
        totalChatCount: store.state.chatsById.size,
        totalProjectCount: store.state.projectsById.size,
      }))
    }

    const sidebar = {
      data,
      signature: JSON.stringify({
        type: "sidebar" as const,
        data,
      }),
    }

    if (cache) {
      cache.sidebar = sidebar
    }

    return sidebar
  }

  function createEnvelope(id: string, topic: SubscriptionTopic, cache?: SnapshotComputationCache): ServerEnvelope {
    if (topic.type === "sidebar") {
      const sidebar = getSidebarSnapshotCacheEntry(cache)
      return {
        v: PROTOCOL_VERSION,
        type: "snapshot",
        id,
        snapshot: {
          type: "sidebar",
          data: sidebar.data,
        },
      }
    }

    if (topic.type === "local-projects") {
      const discoveredProjects = getDiscoveredProjects()
      const data = deriveLocalProjectsSnapshot(store.state, discoveredProjects, machineDisplayName)

      return {
        v: PROTOCOL_VERSION,
        type: "snapshot",
        id,
        snapshot: {
          type: "local-projects",
          data,
        },
      }
    }

    if (topic.type === "keybindings") {
      return {
        v: PROTOCOL_VERSION,
        type: "snapshot",
        id,
        snapshot: {
          type: "keybindings",
          data: keybindings.getSnapshot(),
        },
      }
    }

    if (topic.type === "app-settings") {
      return {
        v: PROTOCOL_VERSION,
        type: "snapshot",
        id,
        snapshot: {
          type: "app-settings",
          data: resolvedAppSettings.getSnapshot(),
        },
      }
    }

    if (topic.type === "update") {
      return {
        v: PROTOCOL_VERSION,
        type: "snapshot",
        id,
        snapshot: {
          type: "update",
          data: updateManager?.getSnapshot() ?? {
            currentVersion: "unknown",
            latestVersion: null,
            status: "idle",
            updateAvailable: false,
            lastCheckedAt: null,
            error: null,
            installAction: "restart",
            reloadRequestedAt: null,
          },
        },
      }
    }

    if (topic.type === "terminal") {
      return {
        v: PROTOCOL_VERSION,
        type: "snapshot",
        id,
        snapshot: {
          type: "terminal",
          data: terminals.getSnapshot(topic.terminalId),
        },
      }
    }

    if (topic.type === "project-git") {
      return {
        v: PROTOCOL_VERSION,
        type: "snapshot",
        id,
        snapshot: {
          type: "project-git",
          data: store.getProject(topic.projectId)
            ? resolvedDiffStore.getProjectSnapshot(topic.projectId)
            : null,
        },
      }
    }

    return {
      v: PROTOCOL_VERSION,
      type: "snapshot",
      id,
      snapshot: {
        type: "chat",
        data: deriveChatSnapshot(
          store.state,
          agent.getActiveStatuses(),
          agent.getDrainingChatIds(),
          topic.chatId,
          (chatId) => {
            const recent = store.getRecentChatHistory(chatId, topic.recentLimit ?? DEFAULT_CHAT_RECENT_LIMIT)
            const allMessages = (typeof store.getMessages === "function" ? store.getMessages(chatId) : null)
              ?? recent.messages
            return {
              ...recent,
              memoryRecordMessages: deriveMemoryRecordTranscript(allMessages),
            }
          },
          agent.getStreamingAssistantTexts()
        ),
      },
    }
  }

  async function pushSnapshots(
    ws: ServerWebSocket<ClientState>,
    options?: { skipPrune?: boolean; filter?: SnapshotBroadcastFilter; cache?: SnapshotComputationCache; retryDropped?: boolean }
  ) {
    const pushStartedAt = performance.now()
    if (!options?.skipPrune) {
      await maybePruneStaleEmptyChats([ws])
    }
    const snapshotSignatures = ensureSnapshotSignatures(ws)
    let sentCount = 0
    let skippedCount = 0
    for (const [id, topic] of ws.data.subscriptions.entries()) {
      if (!shouldIncludeTopic(topic, options?.filter)) {
        continue
      }
      const envelopeStartedAt = performance.now()
      // Building a chat snapshot loads that chat's transcript from disk. If one
      // chat's transcript is unreadable (e.g. corruption a mid-append kill left
      // behind), it must not abort this socket's remaining topics — nor, via
      // broadcastSnapshots' shared loop, every OTHER socket's updates (BUG WS-2).
      // Skip just the failing topic and keep going.
      let envelope: ReturnType<typeof createEnvelope>
      try {
        envelope = createEnvelope(id, topic, options?.cache)
      } catch (error) {
        console.error(`[ws-router] failed to build snapshot for topic ${topic.type}${topic.type === "chat" ? `:${topic.chatId}` : ""}`, error)
        // Tell THIS subscriber its topic is broken — without a scoped error
        // the subscription just freezes silently (the client keeps showing
        // the last good snapshot forever).
        send(ws, {
          v: PROTOCOL_VERSION,
          type: "error",
          id,
          message: `Snapshot failed for ${topic.type}${topic.type === "chat" ? ` ${topic.chatId}` : ""}: ${error instanceof Error ? error.message : String(error)}`,
        })
        continue
      }
      const createdAt = performance.now()
      if (envelope.type !== "snapshot") continue
      const signature = topic.type === "sidebar"
        ? getSidebarSnapshotCacheEntry(options?.cache).signature
        : JSON.stringify(envelope.snapshot)
      const signatureReadyAt = topic.type === "sidebar" ? createdAt : performance.now()
      if (snapshotSignatures.get(id) === signature) {
        skippedCount += 1
        continue
      }
      if (topic.type === "chat" && envelope.snapshot.type === "chat" && envelope.snapshot.data?.runtime.status === "starting") {
        const profile = agent.getActiveTurnProfile(topic.chatId)
        logSendToStartingProfile(profile?.traceId, profile?.startedAt, "ws.snapshot_sent", {
          chatId: topic.chatId,
          status: envelope.snapshot.data.runtime.status,
          messageCount: envelope.snapshot.data.messages.length,
          buildMs: Number((createdAt - envelopeStartedAt).toFixed(1)),
          signatureMs: Number((signatureReadyAt - createdAt).toFixed(1)),
          signatureBytes: signature.length,
        })
      }
      const { payloadBytes, status } = send(ws, envelope)
      // Bun reports -1 after accepting the message into its queue; only 0
      // means the snapshot was dropped and still needs a later retry.
      if (status !== 0) {
        snapshotSignatures.set(id, signature)
        sentCount += 1
      } else {
        dirtySnapshotSockets.add(ws)
        if (options?.retryDropped !== false) {
          scheduleDroppedSnapshotRetry(ws)
        }
      }
      if (topic.type === "chat" && envelope.snapshot.type === "chat" && envelope.snapshot.data?.runtime.status === "starting") {
        const profile = agent.getActiveTurnProfile(topic.chatId)
        logSendToStartingProfile(profile?.traceId, profile?.startedAt, "ws.snapshot_send_completed", {
          chatId: topic.chatId,
          payloadBytes,
        })
      }
    }
    if (isSendToStartingProfilingEnabled()) {
      console.log("[memosync/send->starting][server]", JSON.stringify({
        stage: "ws.push_snapshots_completed",
        elapsedMs: Number((performance.now() - pushStartedAt).toFixed(1)),
        skipPrune: Boolean(options?.skipPrune),
        sentCount,
        skippedCount,
        ...countSubscriptionsByTopic(ws),
      }))
    }
  }

  async function performBroadcastSnapshots() {
    const startedAt = performance.now()
    let socketCount = 0
    const cache: SnapshotComputationCache = {}
    for (const ws of sockets) {
      socketCount += 1
      // One socket's failure must never starve the rest of the batch (BUG WS-2).
      try {
        await pushSnapshots(ws, { skipPrune: true, cache })
      } catch (error) {
        console.error("[ws-router] broadcastSnapshots: skipped a socket after error", error)
      }
    }
    if (isSendToStartingProfilingEnabled()) {
      console.log("[memosync/send->starting][server]", JSON.stringify({
        stage: "ws.broadcast_snapshots_completed",
        elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
        pruneMs: 0,
        socketCount,
        totalChatCount: store.state.chatsById.size,
        totalProjectCount: store.state.projectsById.size,
      }))
    }
  }

  async function performBroadcastFilteredSnapshots(filter: SnapshotBroadcastFilter) {
    const startedAt = performance.now()
    let socketCount = 0
    const cache: SnapshotComputationCache = {}
    for (const ws of sockets) {
      socketCount += 1
      try {
        await pushSnapshots(ws, { skipPrune: true, filter, cache })
      } catch (error) {
        console.error("[ws-router] broadcastFilteredSnapshots: skipped a socket after error", error)
      }
    }
    if (isSendToStartingProfilingEnabled()) {
      console.log("[memosync/send->starting][server]", JSON.stringify({
        stage: "ws.broadcast_filtered_snapshots_completed",
        elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
        socketCount,
        includeSidebar: Boolean(filter.includeSidebar),
        chatCount: filter.chatIds?.size ?? 0,
        projectCount: filter.projectIds?.size ?? 0,
      }))
    }
  }

  function broadcastSnapshots() {
    return enqueueSnapshotBroadcast(performBroadcastSnapshots)
  }

  function broadcastFilteredSnapshots(filter: SnapshotBroadcastFilter) {
    return enqueueSnapshotBroadcast(() => performBroadcastFilteredSnapshots(filter))
  }

  function scheduleBroadcast() {
    pendingBroadcastAll = true
    pendingBroadcastChatIds.clear()
    if (pendingBroadcastTimer) {
      return
    }
    pendingBroadcastTimer = setTimeout(() => {
      pendingBroadcastTimer = null
      const shouldBroadcastAll = pendingBroadcastAll
      const chatIds = new Set(pendingBroadcastChatIds)
      pendingBroadcastAll = false
      pendingBroadcastChatIds.clear()
      if (shouldBroadcastAll) {
        void broadcastSnapshots()
        return
      }
      if (chatIds.size > 0) {
        void broadcastFilteredSnapshots({
          includeSidebar: true,
          chatIds,
        })
      }
    }, 16)
  }

  function scheduleChatStateBroadcast(chatId: string) {
    if (!pendingBroadcastAll) {
      pendingBroadcastChatIds.add(chatId)
    }
    if (pendingBroadcastTimer) {
      return
    }
    pendingBroadcastTimer = setTimeout(() => {
      pendingBroadcastTimer = null
      const shouldBroadcastAll = pendingBroadcastAll
      const chatIds = new Set(pendingBroadcastChatIds)
      pendingBroadcastAll = false
      pendingBroadcastChatIds.clear()
      if (shouldBroadcastAll) {
        void broadcastSnapshots()
        return
      }
      if (chatIds.size > 0) {
        void broadcastFilteredSnapshots({
          includeSidebar: true,
          chatIds,
        })
      }
    }, 16)
  }

  async function broadcastChatAndSidebar(chatId: string) {
    await broadcastFilteredSnapshots({
      includeSidebar: true,
      chatIds: new Set([chatId]),
    })
  }

  async function broadcastChatStateImmediately(chatId: string) {
    await broadcastChatAndSidebar(chatId)
  }

  function clearDroppedSnapshotRetry(ws: ServerWebSocket<ClientState>) {
    const timer = pendingSnapshotRetryTimers.get(ws)
    if (timer !== undefined) clearTimeout(timer)
    pendingSnapshotRetryTimers.delete(ws)
  }

  function scheduleDroppedSnapshotRetry(ws: ServerWebSocket<ClientState>) {
    if (!sockets.has(ws) || pendingSnapshotRetryTimers.has(ws)) return
    const timer = setTimeout(() => {
      pendingSnapshotRetryTimers.delete(ws)
      if (!dirtySnapshotSockets.delete(ws) || !sockets.has(ws)) return
      // One prompt retry heals a transient connection issue without spinning.
      // If it is also dropped, keep the socket dirty for drain/heartbeat resync.
      void pushSnapshots(ws, { skipPrune: true, retryDropped: false })
    }, DROPPED_SNAPSHOT_RETRY_MS)
    pendingSnapshotRetryTimers.set(ws, timer)
  }

  async function retryDirtySnapshots(ws: ServerWebSocket<ClientState>) {
    clearDroppedSnapshotRetry(ws)
    if (!dirtySnapshotSockets.delete(ws) || !sockets.has(ws)) return
    await pushSnapshots(ws, { skipPrune: true })
  }

  async function handleDrain(ws: ServerWebSocket<ClientState>) {
    await retryDirtySnapshots(ws)
  }

  function broadcastError(message: string) {
    for (const ws of sockets) {
      send(ws, {
        v: PROTOCOL_VERSION,
        type: "error",
        message,
      })
    }
  }

  function pushTerminalSnapshot(terminalId: string) {
    for (const ws of sockets) {
      const snapshotSignatures = ensureSnapshotSignatures(ws)
      for (const [id, topic] of ws.data.subscriptions.entries()) {
        if (topic.type !== "terminal" || topic.terminalId !== terminalId) continue
        const envelope = createEnvelope(id, topic)
        if (envelope.type !== "snapshot") continue
        const signature = JSON.stringify(envelope.snapshot)
        if (snapshotSignatures.get(id) === signature) continue
        snapshotSignatures.set(id, signature)
        send(ws, envelope)
      }
    }
  }

  function pushTerminalEvent(terminalId: string, event: Extract<ServerEnvelope, { type: "event" }>["event"]) {
    for (const ws of sockets) {
      for (const [id, topic] of ws.data.subscriptions.entries()) {
        if (topic.type !== "terminal" || topic.terminalId !== terminalId) continue
        send(ws, {
          v: PROTOCOL_VERSION,
          type: "event",
          id,
          event,
        })
      }
    }
  }

  const disposeTerminalEvents = terminals.onEvent((event) => {
    pushTerminalEvent(event.terminalId, event)
  })

  const disposeKeybindingEvents = keybindings.onChange(() => {
    for (const ws of sockets) {
      const snapshotSignatures = ensureSnapshotSignatures(ws)
      for (const [id, topic] of ws.data.subscriptions.entries()) {
        if (topic.type !== "keybindings") continue
        const envelope = createEnvelope(id, topic)
        if (envelope.type !== "snapshot") continue
        const signature = JSON.stringify(envelope.snapshot)
        if (snapshotSignatures.get(id) === signature) continue
        snapshotSignatures.set(id, signature)
        send(ws, envelope)
      }
    }
  })

  const disposeAppSettingsEvents = resolvedAppSettings.onChange(() => {
    for (const ws of sockets) {
      const snapshotSignatures = ensureSnapshotSignatures(ws)
      for (const [id, topic] of ws.data.subscriptions.entries()) {
        if (topic.type !== "app-settings") continue
        const envelope = createEnvelope(id, topic)
        if (envelope.type !== "snapshot") continue
        const signature = JSON.stringify(envelope.snapshot)
        if (snapshotSignatures.get(id) === signature) continue
        snapshotSignatures.set(id, signature)
        send(ws, envelope)
      }
    }
  })

  const disposeUpdateEvents = updateManager?.onChange(() => {
    for (const ws of sockets) {
      const snapshotSignatures = ensureSnapshotSignatures(ws)
      for (const [id, topic] of ws.data.subscriptions.entries()) {
        if (topic.type !== "update") continue
        const envelope = createEnvelope(id, topic)
        if (envelope.type !== "snapshot") continue
        const signature = JSON.stringify(envelope.snapshot)
        if (snapshotSignatures.get(id) === signature) continue
        snapshotSignatures.set(id, signature)
        send(ws, envelope)
      }
    }
  }) ?? (() => {})

  agent.setBackgroundErrorReporter?.(broadcastError)

  function resolveChatProject(chatId: string) {
    const chat = store.getChat(chatId)
    if (!chat) throw new Error("Chat not found")
    const project = store.getProject(chat.projectId)
    if (!project) throw new Error("Project not found")
    return { chat, project }
  }

  function resolveStudyMutationProjectId(command: ClientCommand): string | null {
    if (command.type === "project.writeQuickActions" || command.type === "terminal.create") {
      return command.projectId
    }
    if (command.type === "terminal.input") {
      const terminal = terminals.getSnapshot(command.terminalId)
      if (!terminal) throw new Error("Terminal not found")
      const terminalPath = resolveLocalPath(terminal.cwd)
      const project = store.listProjects().find((candidate) => resolveLocalPath(candidate.localPath) === terminalPath)
      if (!project) throw new Error("Terminal does not belong to a registered study project.")
      return project.id
    }
    if (
      STUDY_PROJECT_MUTATING_CHAT_COMMANDS.has(command.type)
      && "chatId" in command
      && typeof command.chatId === "string"
    ) {
      return resolveChatProject(command.chatId).project.id
    }
    return null
  }

  async function handleCommand(ws: ServerWebSocket<ClientState>, message: Extract<ClientEnvelope, { type: "command" }>) {
    const { command, id } = message
    try {
      if (
        studyProjectAccess
        && ["project.open", "project.create", "project.rename", "project.remove", "sidebar.reorderProjectGroups"].includes(command.type)
      ) {
        throw new Error("Project selection and mutation are managed by the study.")
      }
      if (studyProjectAccess && command.type === "chat.create") {
        const refusal = studyProjectAccess.projectRefusal(command.projectId)
        if (refusal) throw new Error(refusal)
      }
      if (studyProjectAccess && command.type === "chat.fork") {
        throw new Error("Chat forking is disabled during the study. Start the current task from its task brief.")
      }
      if (studyProjectAccess) {
        const mutationProjectId = resolveStudyMutationProjectId(command)
        if (mutationProjectId) {
          const refusal = studyProjectAccess.projectRefusal(mutationProjectId)
          if (refusal) throw new Error(refusal)
        }
      }
      switch (command.type) {
        case "system.ping": {
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await retryDirtySnapshots(ws)
          return
        }
        case "browser.listLocalHttpServers": {
          const project = command.projectId ? store.getProject(command.projectId) : null
          if (project && studyPreviewRuntime && canAutoHealStudyPreview(project.id)) {
            try {
              // The supervisor serializes this second admission check with
              // recovery; a concurrently queued freeze marks the project
              // blocked synchronously and therefore cannot be resurrected.
              await studyPreviewRuntime.recover(
                project.localPath,
                () => canAutoHealStudyPreview(project.id),
              )
            } catch (error) {
              console.warn(
                `[study-preview] Browser recovery failed for ${project.id}: ${error instanceof Error ? error.message : String(error)}`,
              )
            }
          }
          const scanned = await listLocalHttpServersFn({
            projectPath: project?.localPath,
            projectTerminalRootPids: project ? terminals.getRootPidsByCwd(project.localPath) : [],
            excludePorts: getSelfPort ? [getSelfPort()] : [],
          })
          // In Docker the iframe runs outside the container, so in-container
          // localhost:PORT is unreachable. PREVIEW_VIA_PROXY lets the client
          // choose a localhost-subdomain route for local use or a same-origin
          // path route behind Cloudflare / SSH (preview-proxy.ts). Host runs
          // keep the direct address (WebSocket/HMR intact).
          const preferProxy = process.env.PREVIEW_VIA_PROXY === "1"
          const result = scanned.map((server) => ({
            ...server,
            ...(preferProxy ? { preferProxy: true } : {}),
            canKill: !studyProjectAccess,
          }))
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "browser.killLocalHttpServer": {
          if (studyProjectAccess) {
            throw new Error("Preview process lifecycle is managed by the study.")
          }
          const result = await killLocalHttpServerFn(command.port)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "project.readQuickActions": {
          const project = store.getProject(command.projectId)
          if (!project) {
            throw new Error("Project not found")
          }
          const result = await readProjectQuickActions(project.localPath)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "project.writeQuickActions": {
          const project = store.getProject(command.projectId)
          if (!project) {
            throw new Error("Project not found")
          }
          const result = await writeProjectQuickActions(project.localPath, command.quickActions)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "update.check": {
          const snapshot = updateManager
            ? await updateManager.checkForUpdates({ force: command.force })
            : {
                currentVersion: "unknown",
                latestVersion: null,
                status: "error",
                updateAvailable: false,
                lastCheckedAt: Date.now(),
                error: "Update manager unavailable.",
                installAction: "restart",
                reloadRequestedAt: null,
              }
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: snapshot })
          return
        }
        case "update.install": {
          if (!updateManager) {
            throw new Error("Update manager unavailable.")
          }
          const result = await updateManager.installUpdate()
          send(ws, {
            v: PROTOCOL_VERSION,
            type: "ack",
            id,
            result,
          })
          return
        }
        case "settings.readKeybindings": {
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: keybindings.getSnapshot() })
          return
        }
        case "settings.writeKeybindings": {
          const snapshot = await keybindings.write(command.bindings)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: snapshot })
          return
        }
        case "settings.readAppSettings": {
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: resolvedAppSettings.getSnapshot() })
          return
        }
        case "settings.writeAppSettingsPatch": {
          const snapshot = await resolvedAppSettings.writePatch(command.patch)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: snapshot })
          return
        }
        case "settings.readLlmProvider": {
          const snapshot = await resolvedLlmProvider.read()
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: maskLlmProviderSnapshot(snapshot) })
          return
        }
        case "settings.writeLlmProvider": {
          // Keep read-key-reuse-write as one ordered operation. Settings input
          // events can overlap, and unique temp files alone do not guarantee
          // that the last submitted value wins.
          const snapshot = await enqueueLlmProviderWrite(async () => {
            const current = await resolvedLlmProvider.read()
            return resolvedLlmProvider.write({
              provider: command.provider,
              apiKey: resolveSubmittedLlmApiKey(current, command.provider, command.apiKey, command.baseUrl),
              model: command.model,
              baseUrl: command.baseUrl,
            })
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: maskLlmProviderSnapshot(snapshot) })
          return
        }
        case "settings.validateLlmProvider": {
          const current = await resolvedLlmProvider.read()
          const result = await resolvedLlmProvider.validate({
            provider: command.provider,
            apiKey: resolveSubmittedLlmApiKey(current, command.provider, command.apiKey, command.baseUrl),
            model: command.model,
            baseUrl: command.baseUrl,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "skills.search": {
          if (!remoteSkillsEnabled) {
            throw new Error("The skills registry is disabled on this deployment.")
          }
          const snapshot = await searchSkills(command.query, command.limit)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: snapshot })
          return
        }
        case "skills.install": {
          if (!remoteSkillsEnabled) {
            throw new Error("The skills registry is disabled on this deployment.")
          }
          const result = await installSkill(command.source, command.skillId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "skills.uninstall": {
          const result = await uninstallSkill(command.skillId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "skills.listInstalled": {
          const result = await listInstalledSkills()
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "project.open": {
          await ensureProjectDirectory(command.localPath)
          const normalizedPath = resolveLocalPath(command.localPath)
          const existingProjectId = store.state.projectIdsByPath.get(normalizedPath)
          const project = await store.openProject(command.localPath)
          await refreshDiscovery()
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: { projectId: project.id } })
          if (!existingProjectId) {
          }
          break
        }
        case "project.create": {
          await ensureProjectDirectory(command.localPath)
          const normalizedPath = resolveLocalPath(command.localPath)
          const existingProjectId = store.state.projectIdsByPath.get(normalizedPath)
          const project = await store.openProject(command.localPath, command.title)
          await refreshDiscovery()
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: { projectId: project.id } })
          if (!existingProjectId) {
          }
          break
        }
        case "project.rename": {
          await store.renameProjectSidebarTitle(command.projectId, command.title)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastFilteredSnapshots({ includeSidebar: true })
          return
        }
        case "project.remove": {
          // Cancel + close any running turns in this project's chats before
          // hiding it — otherwise an agent keeps executing tools against the
          // project directory with no UI left to see or stop it (BUG WS-3).
          // Mirrors chat.delete's cancel + closeChat.
          for (const chat of store.listChatsByProject(command.projectId)) {
            await agent.cancel(chat.id)
            await agent.closeChat(chat.id)
          }
          await store.removeProject(command.projectId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          break
        }
        case "sidebar.reorderProjectGroups": {
          await store.setSidebarProjectOrder(command.projectIds)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastFilteredSnapshots({ includeSidebar: true })
          return
        }
        case "project.readDiffPatch": {
          const project = store.getProject(command.projectId)
          if (!project) {
            throw new Error("Project not found")
          }
          const result = await resolvedDiffStore.readPatch({
            projectPath: project.localPath,
            path: command.path,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "system.openExternal": {
          await openExternal(command)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          break
        }
        case "chat.create": {
          const chat = await store.createChat(command.projectId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: { chatId: chat.id } })
          await broadcastChatAndSidebar(chat.id)
          return
        }
        case "chat.fork": {
          const result = await agent.forkChat(command.chatId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          await broadcastFilteredSnapshots({ includeSidebar: true })
          return
        }
        case "chat.rename": {
          await store.renameChat(command.chatId, command.title)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastChatAndSidebar(command.chatId)
          return
        }
        case "chat.archive": {
          await store.archiveChat(command.chatId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastFilteredSnapshots({ includeSidebar: true })
          return
        }
        case "chat.unarchive": {
          await store.unarchiveChat(command.chatId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastChatAndSidebar(command.chatId)
          return
        }
        case "chat.delete": {
          await agent.cancel(command.chatId)
          await agent.closeChat(command.chatId)
          await store.deleteChat(command.chatId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastFilteredSnapshots({ includeSidebar: true })
          return
        }
        case "chat.markRead": {
          await store.setChatReadState(command.chatId, false)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastChatAndSidebar(command.chatId)
          return
        }
        case "chat.setDraftProtection": {
          ws.data.protectedDraftChatIds = new Set(command.chatIds)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          break
        }
        case "chat.send": {
          // AgentCoordinator owns study admission. Keeping it at the queue
          // authority covers send, steer, auto-drain and restart without
          // duplicate router checks or alternate-channel bypasses.
          const result = await agent.send(command)
          const profile = command.clientTraceId && result.chatId
            ? agent.getActiveTurnProfile(result.chatId)
            : null
          logSendToStartingProfile(profile?.traceId ?? command.clientTraceId, profile?.startedAt, "ws.chat_send_ack", {
            chatId: result.chatId ?? null,
          })
          const { payloadBytes } = send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          logSendToStartingProfile(profile?.traceId ?? command.clientTraceId, profile?.startedAt, "ws.chat_send_ack_completed", {
            chatId: result.chatId ?? null,
            payloadBytes,
          })
          return
        }
        case "chat.refreshDiffs": {
          const { project } = resolveChatProject(command.chatId)
          const changed = await resolvedDiffStore.refreshSnapshot(project.id, project.localPath)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          if (changed) {
            void broadcastSnapshots()
          }
          return
        }
        case "chat.initGit": {
          const { project } = resolveChatProject(command.chatId)
          const result = await resolvedDiffStore.initializeGit({
            projectId: project.id,
            projectPath: project.localPath,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          if (result.snapshotChanged) {
            void broadcastSnapshots()
          }
          return
        }
        case "chat.getGitHubPublishInfo": {
          const { project } = resolveChatProject(command.chatId)
          const result = await resolvedDiffStore.getGitHubPublishInfo({
            projectPath: project.localPath,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "chat.checkGitHubRepoAvailability": {
          const result = await resolvedDiffStore.checkGitHubRepoAvailability({
            owner: command.owner,
            name: command.name,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "chat.publishToGitHub": {
          const { project } = resolveChatProject(command.chatId)
          const result = await resolvedDiffStore.publishToGitHub({
            projectId: project.id,
            projectPath: project.localPath,
            owner: command.owner,
            name: command.name,
            visibility: command.visibility,
            description: command.description,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          if (result.snapshotChanged) {
            void broadcastSnapshots()
          }
          return
        }
        case "chat.listBranches": {
          const { project } = resolveChatProject(command.chatId)
          const result = await resolvedDiffStore.listBranches({
            projectPath: project.localPath,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "chat.previewMergeBranch": {
          const { project } = resolveChatProject(command.chatId)
          const result = await resolvedDiffStore.previewMergeBranch({
            projectPath: project.localPath,
            branch: command.branch,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "chat.mergeBranch": {
          const { project } = resolveChatProject(command.chatId)
          const result = await resolvedDiffStore.mergeBranch({
            projectId: project.id,
            projectPath: project.localPath,
            branch: command.branch,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          if (result.snapshotChanged) {
            void broadcastSnapshots()
          }
          return
        }
        case "chat.checkoutBranch": {
          const { project } = resolveChatProject(command.chatId)
          const result = await resolvedDiffStore.checkoutBranch({
            projectId: project.id,
            projectPath: project.localPath,
            branch: command.branch,
            bringChanges: command.bringChanges,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          if (result.snapshotChanged) {
            void broadcastSnapshots()
          }
          return
        }
        case "chat.syncBranch": {
          const { project } = resolveChatProject(command.chatId)
          const result = await resolvedDiffStore.syncBranch({
            projectId: project.id,
            projectPath: project.localPath,
            action: command.action,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          if (result.snapshotChanged) {
            void broadcastSnapshots()
          }
          return
        }
        case "chat.createBranch": {
          const { project } = resolveChatProject(command.chatId)
          const result = await resolvedDiffStore.createBranch({
            projectId: project.id,
            projectPath: project.localPath,
            name: command.name,
            baseBranchName: command.baseBranchName,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          if (result.snapshotChanged) {
            void broadcastSnapshots()
          }
          return
        }
        case "chat.generateCommitMessage": {
          const { project } = resolveChatProject(command.chatId)
          const result = await resolvedDiffStore.generateCommitMessage({
            projectPath: project.localPath,
            paths: command.paths,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "chat.commitDiffs": {
          const { project } = resolveChatProject(command.chatId)
          const result = await resolvedDiffStore.commitFiles({
            projectId: project.id,
            projectPath: project.localPath,
            paths: command.paths,
            summary: command.summary,
            description: command.description,
            mode: command.mode,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          if (result.snapshotChanged) {
            void broadcastSnapshots()
          }
          return
        }
        case "chat.discardDiffFile": {
          const { project } = resolveChatProject(command.chatId)
          const result = await resolvedDiffStore.discardFile({
            projectId: project.id,
            projectPath: project.localPath,
            path: command.path,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          if (result.snapshotChanged) {
            void broadcastSnapshots()
          }
          return
        }
        case "chat.ignoreDiffFile": {
          const { project } = resolveChatProject(command.chatId)
          const result = await resolvedDiffStore.ignoreFile({
            projectId: project.id,
            projectPath: project.localPath,
            path: command.path,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          if (result.snapshotChanged) {
            void broadcastSnapshots()
          }
          return
        }
        case "chat.cancel": {
          await agent.cancel(command.chatId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "chat.interruptMemory": {
          await agent.interruptMemory(command)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "chat.resumeInterrupted": {
          await agent.resumeInterrupted(command)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "chat.stopDraining": {
          await agent.stopDraining(command.chatId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "chat.exportStandalone": {
          const { chat, project } = resolveChatProject(command.chatId)
          const result = await writeStandaloneTranscriptExport({
            chatId: chat.id,
            title: chat.title,
            localPath: project.localPath,
            theme: command.theme,
            attachmentMode: command.attachmentMode,
            messages: store.getMessages(command.chatId),
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "chat.loadHistory": {
          const chat = store.getChat(command.chatId)
          if (!chat) throw new Error("Chat not found")
          const page = store.getMessagesPageBefore(command.chatId, command.beforeCursor, command.limit)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: page })
          return
        }
        case "chat.respondTool": {
          await agent.respondTool(command)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "chat.respondMemoryPreview": {
          await agent.respondMemoryPreview(command)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "chat.respondMemoryProposals": {
          await agent.respondMemoryProposals(command)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "chat.respondMemoryCheckup": {
          await agent.respondMemoryCheckup(command)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "chat.respondMemoryTransfer": {
          await agent.respondMemoryTransfer(command)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "chat.reopenMemoryPreparation": {
          await agent.reopenMemoryPreparation(command)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "message.enqueue": {
          const result = await agent.enqueue(command)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          await broadcastChatAndSidebar(command.chatId)
          return
        }
        case "message.steer": {
          await agent.steer(command)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastChatAndSidebar(command.chatId)
          return
        }
        case "message.dequeue": {
          await agent.dequeue(command)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          await broadcastChatAndSidebar(command.chatId)
          return
        }
        case "terminal.create": {
          const project = store.getProject(command.projectId)
          if (!project) {
            throw new Error("Project not found")
          }
          // The project dir can vanish under a recorded project (e.g. a Docker
          // container rebuild wipes non-volume paths) — spawning a shell with a
          // missing cwd fails as a misleading posix_spawn ENOENT on the shell.
          await ensureProjectDirectory(project.localPath)
          const snapshot = terminals.createTerminal({
            projectPath: project.localPath,
            terminalId: command.terminalId,
            cols: command.cols,
            rows: command.rows,
            scrollback: command.scrollback,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: snapshot })
          return
        }
        case "terminal.input": {
          terminals.write(command.terminalId, command.data)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "terminal.resize": {
          terminals.resize(command.terminalId, command.cols, command.rows)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "terminal.close": {
          terminals.close(command.terminalId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          pushTerminalSnapshot(command.terminalId)
          return
        }
      }

      await broadcastSnapshots()
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error)
      console.error("[ws-router] command failed", {
        id,
        type: command.type,
        message: messageText,
      })
      send(ws, { v: PROTOCOL_VERSION, type: "error", id, message: messageText })
    }
  }

  return {
    handleOpen(ws: ServerWebSocket<ClientState>) {
      sockets.add(ws)
    },
    handleClose(ws: ServerWebSocket<ClientState>) {
      sockets.delete(ws)
      dirtySnapshotSockets.delete(ws)
      clearDroppedSnapshotRetry(ws)
    },
    handleDrain,
    broadcastSnapshots,
    broadcastChatStateImmediately,
    scheduleBroadcast,
    scheduleChatStateBroadcast,
    pruneStaleEmptyChats: () => maybePruneStaleEmptyChats(),
    async handleMessage(ws: ServerWebSocket<ClientState>, raw: string | Buffer | ArrayBuffer | Uint8Array) {
      let parsed: unknown
      try {
        parsed = JSON.parse(String(raw))
      } catch {
        send(ws, { v: PROTOCOL_VERSION, type: "error", message: "Invalid JSON" })
        return
      }

      if (!isClientEnvelope(parsed)) {
        send(ws, { v: PROTOCOL_VERSION, type: "error", message: "Invalid envelope" })
        return
      }

      if (parsed.type === "subscribe") {
        const snapshotSignatures = ensureSnapshotSignatures(ws)
        ws.data.subscriptions.set(parsed.id, parsed.topic)
        snapshotSignatures.delete(parsed.id)
        if (parsed.topic.type === "local-projects") {
          void refreshDiscovery().then(() => {
            if (ws.data.subscriptions.has(parsed.id)) {
              void pushSnapshots(ws, { skipPrune: true })
            }
          })
          return
        }
        await pushSnapshots(ws, { skipPrune: true })
        return
      }

      if (parsed.type === "unsubscribe") {
        const snapshotSignatures = ensureSnapshotSignatures(ws)
        ws.data.subscriptions.delete(parsed.id)
        snapshotSignatures.delete(parsed.id)
        send(ws, { v: PROTOCOL_VERSION, type: "ack", id: parsed.id })
        return
      }

      await handleCommand(ws, parsed)
    },
    dispose() {
      if (pendingBroadcastTimer) {
        clearTimeout(pendingBroadcastTimer)
      }
      for (const timer of pendingSnapshotRetryTimers.values()) clearTimeout(timer)
      pendingSnapshotRetryTimers.clear()
      dirtySnapshotSockets.clear()
      agent.setBackgroundErrorReporter?.(null)
      disposeTerminalEvents()
      disposeKeybindingEvents()
      disposeAppSettingsEvents()
      disposeUpdateEvents()
    },
  }
}
