import { uiJson } from "../shared/ui-copy"
import { stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { APP_NAME, getDataDir, getRuntimeProfile, SELF_UPDATE_ENABLED } from "../shared/branding"
import {
  isolatedPreviewTarget,
  isPreviewHostForm,
  isPreviewNavigationRequest,
  PREVIEW_CALLBACK_PATH,
  PREVIEW_GRANT_PATH,
  PREVIEW_TICKETS_PATH,
  stripPreviewPathPrefix,
} from "../shared/preview-proxy"
import type { ShareMode } from "../shared/share"
import type { AgentProvider, ChatAttachment } from "../shared/types"
import { AgentCoordinator, buildClaudeSdkRuntimeOptions, buildClaudeSubprocessEnv } from "./agent"
import { AppSettingsManager } from "./app-settings"
import { createAuthManager, validateRequestOrigin } from "./auth"
import type { UpdateInstallAttemptResult } from "./cli-runtime"
import { acquireDataDirectoryLock, acquireDataRootBootstrapLock } from "./data-directory-lock"
import { DiffStore } from "./diff-store"
import { discoverProjects, type DiscoveredProject } from "./discovery"
import { EventStore } from "./event-store"
import { resolveInstallId } from "./install-id"
import { KeybindingsManager } from "./keybindings"
import { readLlmProviderSnapshot, validateLlmProviderCredentials, writeLlmProviderSnapshot } from "./llm-provider"
import { getMachineDisplayName } from "./machine-name"
import { MemoryService } from "./memory"
import { createBranchJsonCaller, memoryRequestContext } from "./memory/branch-caller"
import { createCaptureService } from "./memory/capture"
import { createCheckupService } from "./memory/checkup"
import { createRevisionService } from "./memory/evolution"
import { createMaintenanceService } from "./memory/maintenance"
import { createRelevanceService } from "./memory/relevance"
import { createReviseInjectionService } from "./memory/revise-injection"
import { handleMemoryRequest } from "./memory/routes"
import { createSanitizeService } from "./memory/sanitize"
import { createTraceService } from "./memory/trace"
import { createTransferService } from "./memory/transfer"
import { createTransferDetectService } from "./memory/transfer-detect"
import { createUsePlanService } from "./memory/use-plan"
import { isDefaultDataDirectory, prepareDefaultDataRoot } from "./migrate-data-root"
import { resolveExistingPathWithinRoot } from "./paths"
import { resolvePiConnection } from "./pi-agent"
import { previewProxyTarget, proxyPreviewRequest } from "./preview-proxy"
import { inheritShellPath } from "./process-utils"
import { deployedProviders, getServerProviderCatalog } from "./provider-catalog"
import { loadRegistryModels } from "./registry-models"
import { TerminalManager } from "./terminal-manager"
import { UpdateManager } from "./update-manager"
import { deleteProjectUpload, inferAttachmentContentType, inferProjectFileContentType, persistProjectUpload, resolveExistingProjectUpload } from "./uploads"
import { UsageLogger } from "./usage/logger"
import { listWorkspaceDirectories } from "./workspace-dirs"
import { handleWorkspaceRequest } from "./workspace-routes"
import { createWsRouter, type ClientState } from "./ws-router"

const MAX_UPLOAD_FILES = 50
const MAX_UPLOAD_SIZE_BYTES = 100 * 1024 * 1024
const MAX_UPLOAD_TOTAL_SIZE_BYTES = 200 * 1024 * 1024
const MAX_EDITOR_SAVE_BYTES = 10 * 1024 * 1024
const MAX_REQUEST_BODY_SIZE_BYTES = MAX_UPLOAD_TOTAL_SIZE_BYTES + 1024 * 1024
const STALE_EMPTY_CHAT_PRUNE_INTERVAL_MS = 60 * 1000

export async function persistUploadedFiles(args: {
  projectId: string
  localPath: string
  files: File[]
  persistUpload?: typeof persistProjectUpload
}): Promise<ChatAttachment[]> {
  const persistUpload = args.persistUpload ?? persistProjectUpload
  const attachments: ChatAttachment[] = []

  try {
    for (const file of args.files) {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const attachment = await persistUpload({
        projectId: args.projectId,
        localPath: args.localPath,
        fileName: file.name || "upload",
        bytes,
        fallbackMimeType: file.type || undefined,
      })
      attachments.push(attachment)
    }
  } catch (error) {
    await Promise.allSettled(
      attachments.map((attachment) => deleteProjectUpload({
        localPath: args.localPath,
        storedName: path.basename(attachment.absolutePath),
      }))
    )
    throw error
  }

  return attachments
}

export function validateUploadFiles(files: Array<{ name: string; size: number }>) {
  if (files.length > MAX_UPLOAD_FILES) {
    return { status: 400, error: `You can upload up to ${MAX_UPLOAD_FILES} files at a time.` }
  }
  for (const file of files) {
    if (file.size > MAX_UPLOAD_SIZE_BYTES) {
      return {
        status: 413,
        error: `File "${file.name}" exceeds the ${Math.floor(MAX_UPLOAD_SIZE_BYTES / (1024 * 1024))} MB limit.`,
      }
    }
  }
  const totalSize = files.reduce((sum, file) => sum + file.size, 0)
  if (totalSize > MAX_UPLOAD_TOTAL_SIZE_BYTES) {
    return {
      status: 413,
      error: `Combined uploads exceed the ${Math.floor(MAX_UPLOAD_TOTAL_SIZE_BYTES / (1024 * 1024))} MB limit.`,
    }
  }
  return null
}

export function createAuditAdmission(args: {
  store: { getChat(chatId: string): { provider: AgentProvider | null } | null }
  isMemoryVisible: (chatId: string, memoryId: string) => boolean
}): ((input: { chatId: string; memoryId: string }) => string | null) | undefined {
  // Validate the target against the current chat and visible pool.
  return ({ chatId, memoryId }) => {
    const chat = args.store.getChat(chatId)
    if (!chat) return "This is not an active chat."

    if (chat.provider !== "claude" && chat.provider !== "codex") return "Audit actions are only available in a supported MemoSync chat."
    if (!args.isMemoryVisible(chatId, memoryId)) {
      return "This memory is not in the current chat's Visible Memory Pool."
    }
    return null
  }
}

export interface StartMemoSyncServerOptions {
  port?: number
  host?: string
  openBrowser?: boolean
  share?: ShareMode
  dataDir?: string
  password?: string | null
  strictPort?: boolean
  /**
   * When true, the auth layer trusts X-Forwarded-Proto for CSRF origin
   * checks, redirect URLs, and the Secure cookie flag. The hostname still
   * comes from the request URL / Host header. Only enable when the server is
   * reachable solely through a trusted reverse proxy such as cloudflared.
   */
  trustProxy?: boolean
  /** Isolated HTTPS (or loopback) origin that also reaches this server and
   * may execute preview content; defaults to MEMOSYNC_PREVIEW_ORIGIN. */
  previewOrigin?: string
  /** Public app origin used to bootstrap preview credentials from the preview
   * origin; defaults to MEMOSYNC_APP_ORIGIN. */
  appOrigin?: string
  /** Extra browser origins allowed to access the development API and WebSocket. */
  allowedOrigins?: string[]
  /**
   * Inject (or disable) filesystem project discovery. Discovery scans the
   * HOME of whatever machine the server process runs on (~/.claude,
   * ~/.codex) — tests and QA harnesses pass () => [] so a server boot never
   * walks the developer's real home directory.
   */
  discoverProjects?: () => DiscoveredProject[]
  onMigrationProgress?: (message: string) => void
  update?: {
    version: string
    fetchLatestVersion: (packageName: string) => Promise<string>
    installVersion: (packageName: string, version: string) => UpdateInstallAttemptResult
  }
}

export async function cleanupFailedMemoSyncStartup(args: {
  error: unknown
  cleanups: Array<() => void | Promise<void>>
  releaseLock: () => void
}): Promise<unknown> {
  const failures = [args.error]
  for (const cleanup of args.cleanups.reverse()) {
    try {
      await cleanup()
    } catch (error) {
      failures.push(error)
    }
  }
  try {
    args.releaseLock()
  } catch (error) {
    failures.push(error)
  }
  return failures.length > 1
    ? new AggregateError(failures, "MemoSync startup and cleanup failed")
    : args.error
}

export async function startMemoSyncServer(options: StartMemoSyncServerOptions = {}) {
  const homeDir = homedir()
  const usesDefaultDataDir = !options.dataDir || isDefaultDataDirectory(options.dataDir, homeDir)
  const bootstrapLock = usesDefaultDataDir ? acquireDataRootBootstrapLock(homeDir) : null
  const startupCleanups: Array<() => void | Promise<void>> = []
  let lock: ReturnType<typeof acquireDataDirectoryLock> | undefined
  try {
    if (usesDefaultDataDir) prepareDefaultDataRoot(homeDir)
    lock = acquireDataDirectoryLock(options.dataDir ?? getDataDir(homeDir))
    const dataLock = lock
    const runtime = await startLockedMemoSyncServer(
      { ...options, dataDir: dataLock.dataDir },
      (cleanup) => startupCleanups.push(cleanup),
    )
    let stopping: Promise<void> | undefined
    return {
      ...runtime,
      stop: () => stopping ??= (async () => {
        const stopErrors: unknown[] = []
        try {
          await runtime.stop()
        } catch (error) {
          stopErrors.push(error)
        }
        try {
          dataLock.release()
        } catch (error) {
          stopErrors.push(error)
        }
        if (stopErrors.length === 1) throw stopErrors[0]
        if (stopErrors.length > 1) {
          throw new AggregateError(stopErrors, "MemoSync shutdown and lock release failed")
        }
      })(),
    }
  } catch (error) {
    throw await cleanupFailedMemoSyncStartup({
      error,
      cleanups: startupCleanups,
      releaseLock: () => lock?.release(),
    })
  } finally {
    bootstrapLock?.release()
  }
}

async function startLockedMemoSyncServer(
  options: StartMemoSyncServerOptions,
  onStartupCleanup: (cleanup: () => void | Promise<void>) => void,
) {
  const port = options.port ?? 3210
  const hostname = options.host ?? "127.0.0.1"
  const strictPort = options.strictPort ?? false
  const runtimeProfile = getRuntimeProfile()
  // Resolve the login environment alongside store setup, before any agent can resume.
  const shellPathReady = inheritShellPath()
  const trustProxy = options.trustProxy ?? false
  // Isolated origins for executable preview content (see preview-proxy.ts).
  // An HTTPS MEMOSYNC_PREVIEW_ORIGIN is required when the app is reached
  // through a non-loopback public origin; MEMOSYNC_APP_ORIGIN lets the preview origin
  // find its way back to the grant endpoint.
  const previewOrigin = (options.previewOrigin ?? process.env.MEMOSYNC_PREVIEW_ORIGIN ?? "").trim()
  const appPublicOrigin = (options.appOrigin ?? process.env.MEMOSYNC_APP_ORIGIN ?? "").trim()
  const previewOriginHost = previewOrigin ? new URL(previewOrigin).host : null
  const auth = options.password
    ? createAuthManager(options.password, { trustProxy, previewOrigin, appOrigin: appPublicOrigin })
    : null
  const allowedOrigins = options.allowedOrigins ?? (process.env.MEMOSYNC_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
  const store = new EventStore(options.dataDir)
  const diffStore = new DiffStore(store.dataDir)
  const machineDisplayName = getMachineDisplayName()
  await store.initialize()
  await diffStore.initialize()
  await store.migrateLegacyTranscripts(options.onMigrationProgress)
  // Memory layer (MemoSync): SQLite store + Markdown projection, rooted in the
  // same data dir as the event store. Engine-agnostic; consumed by the memory
  // HTTP routes and (P2+) the per-engine injection/tool adapters. Markdown
  // write-back (startup ingest of hand edits) is part of normal MemoSync.
  const usageEventsPath = path.join(store.dataDir, "experiments", "events.jsonl")
  const memory = new MemoryService({
    dbPath: path.join(store.dataDir, "memory.sqlite"),
    dataDir: path.join(store.dataDir, "memories"),
    logger: new UsageLogger({
      filePath: usageEventsPath,
      installId: resolveInstallId(store.dataDir),
    }),
  })
  onStartupCleanup(() => memory.close())
  let discoveredProjects: DiscoveredProject[] = []

  async function refreshDiscovery() {
    discoveredProjects = (options.discoverProjects ?? discoverProjects)()
    return discoveredProjects
  }

  await refreshDiscovery()

  let server: ReturnType<typeof Bun.serve<ClientState>>
  let router: ReturnType<typeof createWsRouter>
  const terminals = new TerminalManager()
  onStartupCleanup(() => terminals.closeAll())
  const keybindings = new KeybindingsManager()
  onStartupCleanup(() => keybindings.dispose())
  const appSettings = new AppSettingsManager(path.join(store.dataDir, "settings.json"))
  onStartupCleanup(() => appSettings.dispose())
  await appSettings.initialize()
  let prevMemoryPreviewSettings = JSON.stringify(appSettings.getSnapshot().memoryPreview)
  appSettings.onChange((snapshot) => {
    const next = JSON.stringify(snapshot.memoryPreview)
    if (next === prevMemoryPreviewSettings) return
    prevMemoryPreviewSettings = next
    memory.logger.event({
      type: "memory.setting",
      section: "memoryPreview",
      value: { ...snapshot.memoryPreview },
    })
  })
  await keybindings.initialize()
  const updateManager = SELF_UPDATE_ENABLED && options.update
    ? new UpdateManager({
      currentVersion: options.update.version,
      fetchLatestVersion: options.update.fetchLatestVersion,
      installVersion: options.update.installVersion,
      devMode: runtimeProfile === "dev",
      })
    : null
  // Post-turn memory passes run on the selected CLI runtime when available.
  const branchMemory = createBranchJsonCaller({ resolve: context => {
    const chat = context.sessionId ? store.getChat(context.sessionId) : undefined
    const project = store.getProject(context.projectId ?? chat?.projectId ?? "")
    const current = context.sessionId ? agent?.memoryRuntimeChoice(context.sessionId) : undefined
    const provider = current?.provider ?? chat?.provider ?? "claude"
    const messages = chat ? store.getMessages(chat.id) : []
    const lastInit = messages.filter(message => message.kind === "system_init").at(-1)
    const model = current?.model ?? lastInit?.model ?? appSettings.getSnapshot().providerDefaults[provider].model
      ?? getServerProviderCatalog(provider).defaultModel
    const localPath = project?.localPath ?? process.cwd()
    const runtime = provider === "claude" ? buildClaudeSdkRuntimeOptions({
      requestedModel: model,
      env: buildClaudeSubprocessEnv({ localPath }),
    }) : null
    return { provider, localPath, model: runtime?.model ?? model, parentSessionToken: chat?.sessionToken ?? null, subprocessEnv: runtime?.env }
  } })
  const memoryLlm = branchMemory.callJson
  // Cross-context transfer judgment (as-is / rewrite / context-bound) — the
  // route degrades to a verbatim proposal without it.
  const memoryTransfer = createTransferService({ callJson: memoryLlm })
  // Sensitive-candidate redaction (DG1 "confirm" branch) — the route REFUSES
  // without it (a failed redaction must never look like a clean one).
  const memorySanitize = createSanitizeService({ callJson: memoryLlm })
  // Revision drafting (DG4 "propose fixes"): after a repeat-violation streak
  // the system drafts a replacement that lands on the review lane. Exists only
  // where there IS a review lane and a trace pass to trigger it.
  const memoryRevision =
    createRevisionService({ memory, callJson: memoryLlm })
  if (memoryRevision) {
    const scan = memoryRevision.scanAndPropose.bind(memoryRevision)
    memoryRevision.scanAndPropose = input => branchMemory.run({ sessionId: input.sessionId }, () => scan(input))
  }
  // Applies participant-reviewed Checkup actions. Detection belongs to the
  // Checkup service; this service only validates and commits those actions.
  // The session clock shared by Checkup and Transfer: prior sessions of
  // the project that actually RAN a turn (lastTurnOutcome is replayed from
  // turn events) — a fork that only copied a transcript sets hasMessages
  // without ever running, and an archived chat still happened; neither must
  // skew 过期.
  const listRecentSessions = (projectId: string | undefined, excludeSessionId?: string) => {
    if (!projectId) return []
    return store
      .listChats()
      .filter((c) => c.projectId === projectId && c.id !== excludeSessionId && c.lastTurnOutcome !== null)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((c) => ({ id: c.id, startedAt: new Date(c.createdAt).toISOString() }))
  }
  const memoryMaintenance = createMaintenanceService({
        memory,
        // Enables the redundant-pair merge action (LLM-drafted merge proposals).
        callJson: memoryLlm,
      })
  // Step-one library checkup (redesign 2026-08-07 §3): three parallel LLM
  // queries + merge, cache keyed on library content — exists only where the
  // step-one gates exist (the review arm's chat flow).
  const memoryCheckup =
    createCheckupService({ memory, callJson: memoryLlm, listRecentSessions })
  // Transfer detection: turn end prepares source-side rules from other
  // contexts; each next prompt reruns relevance and task-bound Decode/landing.
  // Rides the same arm gating as the checkup, plus the transfer service.
  const memoryTransferDetect =
    memoryTransfer
      ? createTransferDetectService({
          memory,
          callJson: memoryLlm,
          transfer: memoryTransfer,
          listRecentSessions,
          listProjects: () => store.listProjects().map((p) => ({ id: p.id, title: p.title })),
        })
      : null
  // "Ask agent to revise" on the Step 2 gate — natural-language adjustment of
  // the injected set. Same availability as the gate itself.
  const memoryReviseInjection =
    createReviseInjectionService({ callJson: memoryLlm })
  const memoryUsePlan =
    createUsePlanService({ callJson: memoryLlm })
  let agent: AgentCoordinator | null = null
  const auditAdmission = createAuditAdmission({
    store,
    isMemoryVisible: (chatId, memoryId) => {
      const chat = store.getChat(chatId)
      return Boolean(chat && memory.injectedFor(chat.projectId, chatId).some((item) => item.id === memoryId))
    },
  })
  const memoryCapture = createCaptureService({
    memory, callJson: memoryLlm,
  })
  if (memoryCapture) {
    const route = memoryCapture.routeProposal.bind(memoryCapture)
    memoryCapture.routeProposal = (raw, input) => branchMemory.run(input, () => route(raw, input))
  }
  const activeAgent = new AgentCoordinator({
    store,
    memory,
    memoryBranches: true,
    getMemorySettings: () => appSettings.getSnapshot().memory,
    getMemoryPreviewSettings: () => appSettings.getSnapshot().memoryPreview,
    capture: memoryCapture,
    // No logger: the coordinator CAS-validates trace verdicts against live
    // memory state and emits memory.trace itself.
    memoryTrace: createTraceService({ callJson: memoryLlm }),
    memoryRevision,
    memoryCheckup,
    memoryTransferDetect,
    // Sidecar relevance prediction on the receipt (REDESIGN D6): the receipt
    // itself stays a pure plan readout; the prediction arrives as its own
    // entry, visually marked as a guess.
    memoryRelevance: createRelevanceService({ callJson: memoryLlm }),
    memoryUsePlan,
    memoryPreview: true,
    onStateChange: (chatId?: string, options?: { immediate?: boolean }) => {
      if (chatId) {
        if (options?.immediate) {
          void router.broadcastChatStateImmediately(chatId)
          return
        }
        router.scheduleChatStateBroadcast(chatId)
        return
      }
      router.scheduleBroadcast()
    },
  })
  agent = activeAgent
  onStartupCleanup(() => activeAgent.shutdownRuntime())
  router = createWsRouter({
    store,
    diffStore,
    agent: activeAgent,
    terminals,
    keybindings,
    appSettings,
    llmProvider: {
      read: readLlmProviderSnapshot,
      write: writeLlmProviderSnapshot,
      validate: validateLlmProviderCredentials,
    },
    refreshDiscovery,
    getDiscoveredProjects: () => discoveredProjects,
    machineDisplayName,
    updateManager,
    // Thunk: actualPort is assigned when Bun.serve binds, later in this fn.
    getSelfPort: () => actualPort,
  })
  onStartupCleanup(() => router.dispose())

  const distDir = path.join(import.meta.dir, "..", "..", "dist", "client")

  const MAX_PORT_ATTEMPTS = 20
  let actualPort = port

  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    try {
      server = Bun.serve<ClientState>({
        port: actualPort,
        hostname,
        maxRequestBodySize: MAX_REQUEST_BODY_SIZE_BYTES,
        async fetch(req, serverInstance) {
          const url = new URL(req.url)

          // Dev-server preview requests encode the target port in either a
          // localhost subdomain or /__memosync/preview/<port> path, then proxy
          // inside this process's network namespace (see preview-proxy.ts).
          // Executable preview content must live on an ISOLATED origin
          // (<port>.localhost locally, or MEMOSYNC_PREVIEW_ORIGIN when the app
          // is reached through a public gateway) so it can never read the
          // host-only app session cookie or call authenticated /api routes.
          const previewPort = previewProxyTarget(req, actualPort)
          const onPreviewOrigin = previewOriginHost !== null && url.host === previewOriginHost
          if (previewPort !== null || onPreviewOrigin) {
            if (auth && url.pathname === PREVIEW_CALLBACK_PATH) {
              return auth.handlePreviewCallback(req)
            }
            if (previewPort === null) {
              return new Response("Not found", { status: 404 })
            }
            if (!isPreviewHostForm(url.host) && !onPreviewOrigin) {
              // Path form on the app origin: redirect navigations to the
              // isolated origin and explicitly block everything else —
              // upstream content never executes here.
              if (!isPreviewNavigationRequest(req)) {
                return new Response("Forbidden", { status: 403 })
              }
              if (auth && auth.isAuthenticated(req)) {
                return auth.previewTicketRedirect(req, previewPort)
              }
              const isolated = isolatedPreviewTarget(
                req,
                previewPort,
                previewOrigin,
                stripPreviewPathPrefix(url.pathname, previewPort),
              )
              if (isolated) {
                return Response.redirect(`${isolated.origin}${isolated.path}${url.search}`, 302)
              }
              return new Response(
                `<!doctype html><meta charset="utf-8"><title>Preview unavailable</title>` +
                `<body style="font-family:system-ui;color:#667085;display:grid;place-items:center;height:100vh;margin:0">` +
                `<p style="max-width:32rem;padding:0 1.5rem;font-size:14px">` +
                `Previews run on an isolated origin. Open MemoSync locally, or ask whoever hosts` +
                ` this server to set MEMOSYNC_PREVIEW_ORIGIN to an HTTPS origin.` +
                `</p>`,
                { status: 403, headers: { "content-type": "text/html; charset=utf-8" } },
              )
            }
            if (!validateRequestOrigin(req, {
              trustProxy,
              allowedOrigins,
            })) {
              return new Response("Forbidden", { status: 403 })
            }
            if (auth && !auth.isPreviewAuthenticated(req, previewPort)) {
              const bootstrap = auth.previewBootstrapRedirect(req, previewPort)
              if (bootstrap) return bootstrap
              return new Response("Unauthorized", { status: 401 })
            }
            return proxyPreviewRequest(req, url, previewPort)
          }

          if (url.pathname === "/auth/status") {
            return auth
              ? auth.handleStatus(req)
              : uiJson({ enabled: false, authenticated: true })
          }

          if (url.pathname === "/auth/logout") {
            if (req.method !== "POST") {
              return new Response(null, { status: 405, headers: { Allow: "POST" } })
            }

            return auth
              ? auth.handleLogout(req)
              : uiJson({ ok: true })
          }

          if ((url.pathname === "/ws" || url.pathname.startsWith("/api/")) && !validateRequestOrigin(req, {
            trustProxy: options.trustProxy ?? false,
            allowedOrigins,
          })) {
            return new Response("Forbidden", { status: 403 })
          }

          if (auth) {
            if (url.pathname === PREVIEW_GRANT_PATH) {
              if (req.method !== "GET") {
                return new Response(null, { status: 405, headers: { Allow: "GET" } })
              }
              return auth.handlePreviewGrant(req)
            }

            if (url.pathname === PREVIEW_TICKETS_PATH) {
              if (req.method !== "POST") {
                return new Response(null, { status: 405, headers: { Allow: "POST" } })
              }
              return auth.handlePreviewTicketMint(req)
            }

            if (url.pathname === "/auth/login") {
              if (req.method === "GET") {
                return auth.redirectToApp(req)
              }
              if (req.method === "POST") {
                return auth.handleLogin(req, "/")
              }
              return new Response(null, { status: 405, headers: { Allow: "GET, POST" } })
            }
            if (url.pathname === "/ws") {
              if (!auth.isAuthenticated(req)) {
                return new Response("Unauthorized", { status: 401 })
              }
            } else if (url.pathname.startsWith("/api/") && !auth.isAuthenticated(req)) {
              return uiJson({ error: "Unauthorized" }, { status: 401 })
            }
          }

          if (url.pathname === "/ws") {
            const upgraded = serverInstance.upgrade(req, {
              data: {
                subscriptions: new Map(),
                snapshotSignatures: new Map(),
              },
            })
            return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 })
          }

          if (url.pathname === "/health") {
            return uiJson({ ok: true, port: actualPort })
          }

          const uploadResponse = await handleProjectUpload(req, url, store)
          if (uploadResponse) {
            return uploadResponse
          }

          const deleteUploadResponse = await handleProjectUploadDelete(req, url, store)
          if (deleteUploadResponse) {
            return deleteUploadResponse
          }

          const attachmentContentResponse = await handleAttachmentContent(req, url, store)
          if (attachmentContentResponse) {
            return attachmentContentResponse
          }

          const projectFileContentResponse = await handleProjectFileContent(req, url, store)
          if (projectFileContentResponse) {
            return projectFileContentResponse
          }

          const workspaceResponse = await handleWorkspaceRequest(req, url, store, {
          })
          if (workspaceResponse) {
            return workspaceResponse
          }

          const memoryResponse = await branchMemory.run(
            url.pathname.startsWith("/api/memories") ? await memoryRequestContext(req, url) : {},
            () => handleMemoryRequest(req, url, memory, {
            transfer: memoryTransfer,
            sanitize: memorySanitize,
            maintenance: memoryMaintenance,
            reviseInjection: memoryReviseInjection,
            usePlan: memoryUsePlan,
            revision: memoryRevision,
            auditAdmission: auditAdmission,
            workingMemoryUsePlan: (input) => activeAgent.planMemoryPreviewUses(input),
            workingMemoryRevise: input => activeAgent.reviseMemoryPreview(input),
            workingMemoryPool: ({ chatId, previewId }) => {
              const pending = activeAgent.pendingPreviews.get(chatId)
              if (!pending?.published || pending.previewId !== previewId) return null
              const chat = store.getChat(chatId)
              if (!chat) return null
              const previewPool = new Set(pending.memoryIds)
              return memory.injectedFor(chat.projectId, chatId)
                .filter((item) => previewPool.has(item.id))
                .map((item) => item.id)
            },
          }))
          if (memoryResponse) {
            return memoryResponse
          }

          if (url.pathname === "/api/model-registry/models" && req.method === "GET") {

            const connection = await resolvePiConnection()
            return uiJson({ models: connection ? await loadRegistryModels(connection, url.searchParams.get("model") ?? undefined) : [] })
          }

          if (url.pathname === "/api/providers") {
            return uiJson({ data: deployedProviders() })
          }

          // Add Project's path picker browses the WORKSPACE machine's
          // filesystem — participants otherwise read the path field as their
          // own computer (pilot feedback 2026-08-11).
          if (url.pathname === "/api/workspace/dirs") {
            return uiJson({ data: listWorkspaceDirectories(url.searchParams.get("path") ?? undefined) })
          }

          return serveStatic(distDir, url.pathname)
        },
        websocket: {
          open(ws) {
            router.handleOpen(ws)
          },
          message(ws, raw) {
            router.handleMessage(ws, raw)
          },
          drain(ws) {
            void router.handleDrain(ws)
          },
          close(ws) {
            router.handleClose(ws)
          },
        },
      })
      // port 0 = ephemeral: adopt whatever the OS actually bound.
      actualPort = server.port ?? actualPort
      break
    } catch (err: unknown) {
      const isAddrInUse =
        err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EADDRINUSE"
      if (!isAddrInUse || strictPort || attempt === MAX_PORT_ATTEMPTS - 1) {
        throw err
      }
      console.log(`Port ${actualPort} is in use, trying ${actualPort + 1}...`)
      actualPort++
    }
  }

  onStartupCleanup(() => server.stop(true))
  // Do not launch writers until startup can no longer fail to bind, and not
  // before agents can find their CLIs on the login shell's PATH.
  await shellPathReady
  const staleEmptyChatPruneInterval = setInterval(() => {
    void router.pruneStaleEmptyChats()
      .then(() => router.broadcastSnapshots())
  }, STALE_EMPTY_CHAT_PRUNE_INTERVAL_MS)
  onStartupCleanup(() => clearInterval(staleEmptyChatPruneInterval))
  void activeAgent.drainOrphanedQueues()

  const shutdown = async () => {
    clearInterval(staleEmptyChatPruneInterval)
    const shutdownErrors: unknown[] = []
    const attempt = async (action: () => void | Promise<void>) => {
      try {
        await action()
      } catch (error) {
        shutdownErrors.push(error)
      }
    }
    await attempt(() => server.stop(true))
    for (const chatId of [...activeAgent.activeTurns.keys()]) {
      await attempt(() => activeAgent.cancel(chatId))
    }
    await attempt(() => activeAgent.shutdownRuntime())
    await attempt(() => activeAgent.forceStopAllTurns())
    await attempt(() => router.dispose())
    await attempt(() => appSettings.dispose())
    await attempt(() => keybindings.dispose())
    await attempt(() => terminals.closeAll())
    await attempt(() => memory.close())
    await attempt(() => store.compact())
    if (shutdownErrors.length === 1) throw shutdownErrors[0]
    if (shutdownErrors.length > 1) {
      throw new AggregateError(shutdownErrors, "MemoSync shutdown failed")
    }
  }

  return {
    port: actualPort,
    store,
    diffStore,
    updateManager,
    stop: shutdown,
  }
}

export async function handleProjectUpload(
  req: Request,
  url: URL,
  store: EventStore,
) {
  if (req.method !== "POST") {
    return null
  }

  const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/uploads$/)
  if (!match) {
    return null
  }

  const project = store.getProject(match[1])
  if (!project) {
    return uiJson({ error: "Project not found" }, { status: 404 })
  }

  const declaredSize = Number(req.headers.get("content-length"))
  if (Number.isFinite(declaredSize) && declaredSize > MAX_REQUEST_BODY_SIZE_BYTES) {
    return uiJson({ error: "Upload request is too large." }, { status: 413 })
  }

  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    return uiJson({ error: "Could not read the upload request. Please try again." }, { status: 400 })
  }
  const files = formData
    .getAll("files")
    .filter((value): value is File => value instanceof File)

  if (files.length === 0) {
    return uiJson({ error: "No files uploaded" }, { status: 400 })
  }

  const validationError = validateUploadFiles(files)
  if (validationError) {
    return uiJson({ error: validationError.error }, { status: validationError.status })
  }

  const clientSizes = formData.getAll("clientFileSizes")
  if (clientSizes.length > 0) {
    if (clientSizes.length !== files.length || clientSizes.some((value) =>
      typeof value !== "string" || !value.trim() || !Number.isSafeInteger(Number(value)) || Number(value) < 0
    )) {
      return uiJson({ error: "Invalid upload size metadata." }, { status: 400 })
    }
    if (files.some((file, index) => file.size !== Number(clientSizes[index]))) {
      return uiJson({ error: "The uploaded file size does not match. Please try again." }, { status: 400 })
    }
  }

  try {
    const attachments = await persistUploadedFiles({
      projectId: project.id,
      localPath: project.localPath,
      files,
    })
    return uiJson({ attachments })
  } catch (error) {
    console.error("[uploads] Upload failed:", error)
    return uiJson({ error: "Upload failed" }, { status: 500 })
  }
}

async function handleAttachmentContent(req: Request, url: URL, store: EventStore) {
  const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/uploads\/([^/]+)\/content$/)
  if (!match) {
    return null
  }

  if (req.method !== "GET") {
    return new Response(null, {
      status: 405,
      headers: {
        Allow: "GET",
      },
    })
  }

  const project = store.getProject(match[1])
  if (!project) {
    return uiJson({ error: "Project not found" }, { status: 404 })
  }

  const storedName = decodeURIComponent(match[2])
  if (!storedName || storedName.includes("/") || storedName.includes("\\") || storedName === "." || storedName === "..") {
    return uiJson({ error: "Invalid attachment path" }, { status: 400 })
  }

  const resolved = await resolveExistingProjectUpload(project.localPath, storedName)
  if (!resolved.ok) {
    return uiJson(
      { error: resolved.reason === "outside" ? "Invalid attachment path" : "Attachment not found" },
      { status: resolved.reason === "outside" ? 400 : 404 }
    )
  }
  const filePath = resolved.path
  const file = Bun.file(filePath)
  try {
    const info = await stat(filePath)
    if (!info.isFile()) {
      return uiJson({ error: "Attachment not found" }, { status: 404 })
    }
  } catch {
    return uiJson({ error: "Attachment not found" }, { status: 404 })
  }

  return new Response(file, {
    headers: {
      "Content-Type": inferAttachmentContentType(storedName, file.type),
      "X-Content-Type-Options": "nosniff",
    },
  })
}

// Exported for tests (project-file-content.test.ts) — not part of the public API.
export async function handleProjectFileContent(
  req: Request,
  url: URL,
  store: EventStore,
) {
  const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/files\/([^/]+)\/content$/)
  if (!match) {
    return null
  }

  if (req.method !== "GET" && req.method !== "PUT") {
    return new Response(null, {
      status: 405,
      headers: {
        Allow: "GET, PUT",
      },
    })
  }

  if (req.method === "PUT") {
  }

  try {
    const project = store.getProject(match[1])
    if (!project) {
      return uiJson({ error: "Project not found" }, { status: 404 })
    }

    const requestedRelativePath = decodeURIComponent(match[2])
    const relativePath = path.posix.normalize(requestedRelativePath.replaceAll("\\", "/"))
    if (!relativePath || relativePath === "." || relativePath.startsWith("../") || relativePath.includes("/../") || path.posix.isAbsolute(relativePath)) {
      return uiJson({ error: "Invalid project file path" }, { status: 400 })
    }
    const resolved = await resolveExistingPathWithinRoot(project.localPath, relativePath)
    if (!resolved.ok) {
      return uiJson(
        { error: resolved.reason === "outside" ? "Invalid project file path" : "File not found" },
        { status: resolved.reason === "outside" ? 400 : 404 }
      )
    }
    const filePath = resolved.path

    const file = Bun.file(filePath)
    try {
      const info = await stat(filePath)
      if (!info.isFile()) {
        return uiJson({ error: "File not found" }, { status: 404 })
      }
    } catch {
      return uiJson({ error: "File not found" }, { status: 404 })
    }

    if (req.method === "PUT") {
      // Save from the Files editor. Existing files only (resolve above already
      // 404s otherwise), so the panel can't create paths the tree doesn't show.
      const declaredSize = Number(req.headers.get("content-length"))
      if (Number.isFinite(declaredSize) && declaredSize > MAX_EDITOR_SAVE_BYTES) {
        return uiJson({ error: "File too large to save" }, { status: 413 })
      }
      const body = await req.text()
      if (Buffer.byteLength(body, "utf8") > MAX_EDITOR_SAVE_BYTES) {
        return uiJson({ error: "File too large to save" }, { status: 413 })
      }
      try {
        await Bun.write(filePath, body)
        const written = await stat(filePath)
        if (!written.isFile()) throw new Error("File save target is not a file")
      } catch (error) {
        const status = error !== null && typeof error === "object" && "status" in error && error.status === 409 ? 409 : 500
        return uiJson(
          { error: "Failed to write file" },
          { status },
        )
      }
      return uiJson({ data: { saved: true, size: Buffer.byteLength(body, "utf8") } })
    }

    return new Response(file, {
      headers: {
        "Content-Type": inferProjectFileContentType(relativePath, file.type),
        "X-Content-Type-Options": "nosniff",
      },
    })
  } finally {
  }
}

export async function handleProjectUploadDelete(
  req: Request,
  url: URL,
  store: EventStore,
) {
  if (req.method !== "DELETE") {
    return null
  }

  const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/uploads\/([^/]+)$/)
  if (!match) {
    return null
  }

  const project = store.getProject(match[1])
  if (!project) {
    return uiJson({ error: "Project not found" }, { status: 404 })
  }

  const storedName = decodeURIComponent(match[2])
  if (!storedName || storedName.includes("/") || storedName.includes("\\") || storedName === "." || storedName === "..") {
    return uiJson({ error: "Invalid attachment path" }, { status: 400 })
  }

  const deleted = await deleteProjectUpload({
    localPath: project.localPath,
    storedName,
  })

  return uiJson({ ok: deleted })
}

async function serveStatic(distDir: string, pathname: string) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname
  const filePath = path.join(distDir, requestedPath)
  const indexPath = path.join(distDir, "index.html")

  const file = Bun.file(filePath)
  if (await file.exists()) {
    return new Response(file, {
      headers: getStaticHeaders(requestedPath),
    })
  }

  const indexFile = Bun.file(indexPath)
  if (await indexFile.exists()) {
    return new Response(indexFile, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    })
  }

  return new Response(
    `${APP_NAME} client bundle not found. Run \`bun run build\` inside workbench/ first.`,
    { status: 503 }
  )
}

function getStaticHeaders(requestedPath: string) {
  if (requestedPath.endsWith(".html")) {
    return {
      "Cache-Control": "no-store",
    }
  }

  return undefined
}
