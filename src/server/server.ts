import path from "node:path"
import { stat } from "node:fs/promises"
import { APP_NAME, getRuntimeProfile, LOG_PREFIX, SELF_UPDATE_ENABLED } from "../shared/branding"
import { parseStudyProjects, registerStudyProjects, resolveRegisteredStudyProjects, type RegisteredStudyProject } from "./study-projects"
import { studyWorkspaceStarterReady } from "./study-workspace-provenance"
import { createStudyPromptGate, type StudyPromptGate } from "./study-prompt-gate"
import { createStudyOpeningAttachmentSnapshotStore } from "./study-opening-attachments"
import { createStudySessionAttribution } from "./study-session-attribution"
import { createStudyWorkingMemoryEvidenceAdmission } from "./study-working-memory-evidence"
import type { AgentProvider, ChatAttachment } from "../shared/types"
import { DEFAULT_DEEPSEEK_MODEL_ID } from "../shared/types"
import { getStudyTask, type StudyTask } from "../shared/studyTasks"
import { applyStudyModelPin, deployedProviders } from "./provider-catalog"
import type { ShareMode } from "../shared/share"
import { createAuthManager, validateRequestOrigin } from "./auth"
import { listWorkspaceDirectories } from "./workspace-dirs"
import { EventStore } from "./event-store"
import { migrateLegacyDataRoot } from "./migrate-data-root"
import { AgentCoordinator } from "./agent"
import { AppSettingsManager } from "./app-settings"
import { DiffStore } from "./diff-store"
import { discoverProjects, type DiscoveredProject } from "./discovery"
import { KeybindingsManager } from "./keybindings"
import { readLlmProviderSnapshot, validateLlmProviderCredentials, writeLlmProviderSnapshot } from "./llm-provider"
import { getMachineDisplayName } from "./machine-name"
import { TerminalManager } from "./terminal-manager"
import { StudyPreviewRuntime } from "./study-preview-runtime"
import { UpdateManager } from "./update-manager"
import type { UpdateInstallAttemptResult } from "./cli-runtime"
import { createWsRouter, type ClientState } from "./ws-router"
import { isPathPreviewProxyRequest, previewProxyTarget, proxyPreviewRequest } from "./preview-proxy"
import { MemoryService } from "./memory"
import { handleMemoryRequest } from "./memory/routes"
import { handleStudyRequest } from "./study-routes"
import { StudyQuestionnaireService, StudyQuestionnaireError } from "./study-questionnaire-service"
import { describeStudyWorkspace, resolveStudyWorkspaceProject, snapshotStudyWorkspace } from "./study-workspace-snapshot"
import { StudySurveyService } from "./study-survey-service"
import { StudyRegistry } from "./study-registry"
import { StudyOnboardingService } from "./study-onboarding"
import { StudyTelemetryService } from "./study-telemetry"
import { createStudyParticipantPromptReconciler } from "./study-participant-prompt-recovery"
import { ExperimentLogger } from "./experiment/logger"
import { resolveInstallId } from "./install-id"
import { StudyMemoryStore } from "./experiment/study-memory-store"
import { createStudyBaselineProjectCopyPreparer } from "./experiment/study-baseline-project-copy"
import { createStaticMemoryExtractor } from "./experiment/static-memory-extractor"
import { resolveFrozenStaticObjectStates } from "./experiment/static-freeze"
import { createDeepSeekJsonCaller } from "./memory/deepseek"
import { createCaptureService } from "./memory/capture"
import { createTraceService } from "./memory/trace"
import { createRelevanceService } from "./memory/relevance"
import { createTransferService } from "./memory/transfer"
import { createSanitizeService } from "./memory/sanitize"
import { createRevisionService } from "./memory/evolution"
import { createMaintenanceService } from "./memory/maintenance"
import { createCheckupService } from "./memory/checkup"
import { createTransferDetectService } from "./memory/transfer-detect"
import { createReviseInjectionService } from "./memory/revise-injection"
import { createUsePlanService } from "./memory/use-plan"
import { createSummaryService } from "./memory/summary"
import { createMemoryBoardBacklogService } from "./memory/board-backlog"
import { handleWorkspaceRequest, runDurableStaticEditOperation } from "./workspace-routes"
import { resolveConditionPolicy, type ConditionPolicy } from "./experiment/condition"
import { deleteProjectUpload, inferAttachmentContentType, inferProjectFileContentType, persistProjectUpload, resolveExistingProjectUpload } from "./uploads"
import { ensureProjectDirectory, resolveExistingPathWithinRoot } from "./paths"
import type { StudyProjectAccess } from "./study-project-access"
import { isStaticMemoryMarkdownPath } from "../shared/staticMemoryPath"

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
        fileName: file.name,
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

/**
 * Keep study identity authority in the server layer. The memory route only
 * receives this refusal callback and never reads StudyRegistry or EventStore.
 */
export function createStudyEnforceAdmission(args: {
  policy: ConditionPolicy
  store: { getChat(chatId: string): { provider: AgentProvider | null } | null }
  studyPromptGate: StudyPromptGate | null
}): ((sessionId: string) => string | null) | undefined {
  const studyPromptGate = args.studyPromptGate
  if (!args.policy.studyMode || args.policy.condition !== "memosync" || !studyPromptGate) {
    return undefined
  }
  return (sessionId) => {
    const chat = args.store.getChat(sessionId)
    if (!chat) return "This is not an active study chat."
    if (chat.provider !== "claude") return "Enforce is only available in an active Claude study chat."
    return studyPromptGate({ chatId: sessionId, content: "" })
  }
}

export function createStudyAuditAdmission(args: {
  policy: ConditionPolicy
  store: { getChat(chatId: string): { provider: AgentProvider | null } | null }
  studyPromptGate: StudyPromptGate | null
  isMemoryVisible: (chatId: string, memoryId: string) => boolean
}): ((input: { chatId: string; memoryId: string }) => string | null) | undefined {
  // Audit follow-ups (Enforce / Draft fix) exist in the memosync condition —
  // in the normal deployment (studyMode false) as well as the memosync study
  // arm. The study prompt gate (freeze/lifecycle) only applies when present.
  if (args.policy.condition !== "memosync") return undefined
  return ({ chatId, memoryId }) => {
    const chat = args.store.getChat(chatId)
    if (!chat) return "This is not an active chat."
    if (chat.provider !== "claude") return "Audit actions are only available in a Claude chat."
    if (args.studyPromptGate) {
      const refusal = args.studyPromptGate({ chatId, content: "" })
      if (refusal) return refusal
    }
    if (!args.isMemoryVisible(chatId, memoryId)) {
      return "This memory is not in the current chat's Visible Memory Pool."
    }
    return null
  }
}

export function createStudyWorkingMemoryAdmission(args: {
  policy: ConditionPolicy
  store: {
    getChat(chatId: string): { provider: AgentProvider | null } | null
  }
  studyPromptGate: StudyPromptGate | null
  getPendingPreview: (chatId: string) => {
    previewId: string
    published: boolean
    memoryIds: string[]
  } | null
}): ((input: {
  chatId: string
  previewId: string
  memoryId?: string
}) => string | null) | undefined {
  if (!args.policy.studyMode || args.policy.condition !== "memosync" || !args.studyPromptGate) return undefined
  return (input) => {
    const chat = args.store.getChat(input.chatId)
    if (!chat) return "This is not an active study chat."
    if (chat.provider !== "claude") return "Working Memory is only available in an active Claude study chat."
    const promptRefusal = args.studyPromptGate!({ chatId: input.chatId, content: "" })
    if (promptRefusal) return promptRefusal

    const pending = args.getPendingPreview(input.chatId)
    if (!pending?.published || pending.previewId !== input.previewId) {
      return "This Working Memory selection is no longer active."
    }
    if (input.memoryId && !pending.memoryIds.includes(input.memoryId)) {
      return "This memory is not in the current Working Memory pool."
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

export async function startMemoSyncServer(options: StartMemoSyncServerOptions = {}) {
  const port = options.port ?? 3210
  const hostname = options.host ?? "127.0.0.1"
  const strictPort = options.strictPort ?? false
  const runtimeProfile = getRuntimeProfile()
  const auth = options.password ? createAuthManager(options.password, { trustProxy: options.trustProxy ?? false }) : null
  const allowedOrigins = options.allowedOrigins ?? (process.env.MEMOSYNC_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
  if (!options.dataDir) migrateLegacyDataRoot()
  // Study-condition policy: decides which memory behaviors exist in this
  // instance (capture surfacing, preview gate, trace, board/working-set access)
  // and whether remote git/GitHub access exists at all. Resolved BEFORE any
  // service construction so arm isolation covers construction side effects,
  // not just HTTP routes.
  const conditionPolicy = resolveConditionPolicy()
  const store = new EventStore(options.dataDir)
  // Study deployments keep participants on local-only git.
  const diffStore = new DiffStore(store.dataDir, { remoteGitEnabled: !conditionPolicy.studyMode })
  const machineDisplayName = getMachineDisplayName()
  await store.initialize()
  await diffStore.initialize()
  await store.migrateLegacyTranscripts(options.onMigrationProgress)
  // Study cross-project support (STUDY_PLAN §2.1 / T4): the orchestrator
  // provisions multiple project workspaces per participant and lists them in
  // STUDY_PROJECTS; register them here so all study projects appear
  // deterministically (no participant hand-adds a project).
  let assignedStudyProjects: ReadonlyMap<StudyTask["projectSlug"], RegisteredStudyProject> = new Map()
  try {
    const studySpecs = parseStudyProjects(process.env.STUDY_PROJECTS)
    if (!conditionPolicy.studyMode) {
      for (const spec of studySpecs) await ensureProjectDirectory(spec.localPath)
    }
    const studyProjects = await registerStudyProjects(store, studySpecs)
    if (conditionPolicy.studyMode) {
      assignedStudyProjects = resolveRegisteredStudyProjects(
        studySpecs,
        studyProjects,
        (slug, localPath) => studyWorkspaceStarterReady(localPath, slug),
      )
    }
    if (studyProjects.length) {
      console.log(`${LOG_PREFIX} registered ${studyProjects.length} study project(s): ${studyProjects.map((p) => p.title).join(", ")}`)
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} STUDY_PROJECTS is misconfigured:`, error)
    throw error
  }
  // Controlled experiment: participants get no engine/model/effort choice.
  // The catalog narrows to Claude Code on the arm's configured DeepSeek
  // model at effort "high" (DeepSeek's official default strength) — the
  // dropdowns still open, they just hold one entry each (2026-08-09).
  if (conditionPolicy.studyMode) {
    applyStudyModelPin(process.env.DEEPSEEK_MODEL || DEFAULT_DEEPSEEK_MODEL_ID)
  }
  // Memory layer (MemoSync): SQLite store + Markdown projection, rooted in the
  // same data dir as the event store. Engine-agnostic; consumed by the memory
  // HTTP routes and (P2+) the per-engine injection/tool adapters. Markdown
  // write-back (startup ingest of hand edits) exists only where memory is
  // user-operable — the auto/static arms must never gain a write path the
  // condition locks elsewhere.
  const studyEventsPath = path.join(store.dataDir, "experiments", "events.jsonl")
  const studyMemoryStore = conditionPolicy.studyMode
    ? new StudyMemoryStore(path.join(store.dataDir, "experiments", "study.sqlite"))
    : null
  // Formal allocations receive their immutable identity from the orchestrator.
  // Fixed-arm local images without that env remain bootable for diagnostics,
  // but onboarding/session routes fail closed rather than accepting a browser
  // supplied identity.
  const studyParticipantId = process.env.PARTICIPANT_ID?.trim() ?? ""
  const studyOnboarding = studyMemoryStore && studyParticipantId
    ? new StudyOnboardingService({
        store: studyMemoryStore,
        allocationParticipantId: studyParticipantId,
        expectedProlificId: process.env.PROLIFIC_PID,
      })
    : null
  // Canonical lifecycle is recovered before the logger so every durable
  // interaction is attributed against SQLite-backed freeze/completion state.
  // The registry's JSONL replay scans the WHOLE events file synchronously at
  // boot looking for study.* lifecycle events — which non-study deployments
  // never emit, while their telemetry grows that file without bound. Skip the
  // scan entirely outside study mode (behavior-identical: zero matches).
  const studyRegistry = new StudyRegistry(
    conditionPolicy.studyMode ? studyEventsPath : undefined,
    undefined,
    studyMemoryStore ?? undefined,
  )
  const studyTelemetry = studyMemoryStore && studyParticipantId
    ? new StudyTelemetryService({
        store: studyMemoryStore,
        participantId: studyParticipantId,
        condition: conditionPolicy.condition,
        activeTask: () => {
          const taskId = studyRegistry.activeTaskId()
          if (!taskId) return null
          const state = studyRegistry.freezeState(taskId)
          return state ? { taskId, state } : null
        },
      })
    : null
  const studyParticipantPromptReconciler = studyTelemetry
    ? createStudyParticipantPromptReconciler({
        transcript: store,
        registry: studyRegistry,
        telemetry: studyTelemetry,
        assignedProjects: assignedStudyProjects,
      })
    : null
  // Transcript append precedes prompt telemetry. Repair a process loss in
  // that narrow seam before the listener can expose freeze or export routes.
  studyParticipantPromptReconciler?.reconcile()
  const memory = new MemoryService({
    dbPath: path.join(store.dataDir, "memory.sqlite"),
    dataDir: path.join(store.dataDir, "memories"),
    logger: new ExperimentLogger({
      filePath: studyEventsPath,
      // Study allocations stamp the orchestrator-owned PARTICIPANT_ID; every
      // other deployment stamps a persisted per-install id so longitudinal
      // event streams from different machines stay separable.
      participant: studyParticipantId || resolveInstallId(store.dataDir),
      durableSink: studyTelemetry ? (input) => studyTelemetry.recordServerEvent(input) : undefined,
    }),
  })
  const beginStudyMemoryMutation = conditionPolicy.studyMode
    ? () => studyRegistry.beginTreatmentMemoryMutation()
    : undefined
  let discoveredProjects: DiscoveredProject[] = []

  async function refreshDiscovery() {
    discoveredProjects = (options.discoverProjects ?? discoverProjects)()
    return discoveredProjects
  }

  await refreshDiscovery()

  let server: ReturnType<typeof Bun.serve<ClientState>>
  let router: ReturnType<typeof createWsRouter>
  const terminals = new TerminalManager()
  const keybindings = new KeybindingsManager()
  const appSettings = new AppSettingsManager(path.join(store.dataDir, "settings.json"))
  await appSettings.initialize()
  // A participant toggling the preview gate is research data (STUDY_PLAN §2.4)
  // — log every memoryPreview settings change, whether via UI or file edit.
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
  // Post-turn memory passes (capture + trace) run on DeepSeek; without a key
  // they are disabled and the app degrades to recall-only memory. The
  // condition policy further gates which passes exist for this study arm.
  const memoryLlm = createDeepSeekJsonCaller()
  const staticMemoryExtractor =
    memoryLlm && studyMemoryStore && conditionPolicy.condition === "static"
      ? createStaticMemoryExtractor({
          callJson: memoryLlm,
          modelId: process.env.DEEPSEEK_MODEL || DEFAULT_DEEPSEEK_MODEL_ID,
          cache: studyMemoryStore,
        })
      : null
  // Cross-context transfer judgment (as-is / rewrite / context-bound) — the
  // route degrades to a verbatim proposal without it.
  const memoryTransfer = memoryLlm && conditionPolicy.boardWritable ? createTransferService({ callJson: memoryLlm }) : null
  // Sensitive-candidate redaction (DG1 "confirm" branch) — the route REFUSES
  // without it (a failed redaction must never look like a clean one).
  const memorySanitize = memoryLlm && conditionPolicy.capture === "review" ? createSanitizeService({ callJson: memoryLlm }) : null
  // Revision drafting (DG4 "propose fixes"): after a repeat-violation streak
  // the system drafts a replacement that lands on the review lane. Exists only
  // where there IS a review lane and a trace pass to trigger it.
  const memoryRevision =
    memoryLlm && conditionPolicy.capture === "review" && conditionPolicy.trace
      ? createRevisionService({ memory, callJson: memoryLlm })
      : null
  // Applies participant-reviewed Checkup actions. Detection belongs to the
  // Checkup service; this service only validates and commits those actions.
  // Auto-arm summary panel (baseline B1): the arm's only memory surface — a
  // prose summary + a conversation-only control channel. Exists only where
  // capture is silent (the auto condition) and an LLM is configured.
  const memorySummary =
    memoryLlm && conditionPolicy.condition === "auto" ? createSummaryService({ memory, callJson: memoryLlm }) : null
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
  const memoryMaintenance = conditionPolicy.preview
    ? createMaintenanceService({
        memory,
        // Enables the redundant-pair merge action (LLM-drafted merge proposals).
        callJson: memoryLlm ?? undefined,
      })
    : null
  // Step-one library checkup (redesign 2026-08-07 §3): three parallel LLM
  // queries + merge, cache keyed on library content — exists only where the
  // step-one gates exist (the review arm's chat flow).
  const memoryCheckup =
    memoryLlm && conditionPolicy.preview && conditionPolicy.capture === "review"
      ? createCheckupService({ memory, callJson: memoryLlm, listRecentSessions })
      : null
  // Transfer detection: turn end prepares source-side rules from other
  // contexts; each next prompt reruns relevance and task-bound Decode/landing.
  // Rides the same arm gating as the checkup, plus the transfer service.
  const memoryTransferDetect =
    memoryLlm && memoryTransfer && conditionPolicy.preview && conditionPolicy.capture === "review"
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
    memoryLlm && conditionPolicy.preview ? createReviseInjectionService({ callJson: memoryLlm }) : null
  const memoryUsePlan =
    memoryLlm && conditionPolicy.preview ? createUsePlanService({ callJson: memoryLlm }) : null
  const studyOpeningAttachmentSnapshots = conditionPolicy.studyMode && conditionPolicy.condition === "memosync"
    ? createStudyOpeningAttachmentSnapshotStore(path.join(store.dataDir, "experiments", "opening-attachments"))
    : undefined
  let agent: AgentCoordinator | null = null
  const memoryBoardBacklog = createMemoryBoardBacklogService({
    transcript: store,
    receiptStore: memory.store,
    memoryState: memory.store,
    assignedProjectIds: () => new Set([...assignedStudyProjects.values()].map((project) => project.projectId)),
    currentTaskId: () => studyRegistry.activeTaskId(),
    projectIdForTask: (taskId) => {
      const task = getStudyTask(taskId)
      return task ? assignedStudyProjects.get(task.projectSlug)?.projectId ?? null : null
    },
    openingAttachmentSnapshots: studyOpeningAttachmentSnapshots,
    onInvalidated: (entry) => {
      memory.logger.event({
        type: "memory.board_backlog",
        ...entry,
        outcome: "invalidated",
      })
      agent?.handleBoardBacklogInvalidated(entry)
    },
  })
  const studyPromptGate = conditionPolicy.studyMode
    ? createStudyPromptGate({
        registry: studyRegistry,
        store,
        assignedProjects: assignedStudyProjects,
        uiReceipts: { has: (key) => studyMemoryStore?.hasUiReceipt(key) ?? false },
        onboarding: studyOnboarding,
        boardPromptRefusal: conditionPolicy.condition === "memosync"
          ? (taskId, input) => memoryBoardBacklog.promptRefusal(taskId, input.openingReviewId
              ? {
                  taskId,
                  chatId: input.chatId ?? "",
                  reviewId: input.openingReviewId,
                  content: input.content,
                  attachments: input.attachments ?? [],
                  channel: input.channel ?? "chat.send",
                }
              : undefined)
          : undefined,
        allowVerbatimInstruction: process.env.STUDY_INTERNAL_QA_ALLOW_VERBATIM === "1",
        openingAttachmentSnapshots: studyOpeningAttachmentSnapshots,
        recordInstructionGuardViolation: (violation) => {
          const eventId = crypto.randomUUID()
          const recordedAt = new Date().toISOString()
          const event = {
            eventId,
            recordedAt,
            ...violation,
            disqualifying: true as const,
          }
          // This evidence can affect compensation eligibility, so its source
          // of truth is transactional study.sqlite. JSONL remains the common
          // cross-condition analysis projection and never contains raw text.
          studyMemoryStore?.recordInstructionGuardEvent(event)
          memory.logger.event({ type: "study.instruction_guard", ...event })
        },
      })
    : null
  const studyAuditAdmission = createStudyAuditAdmission({
    policy: conditionPolicy,
    store,
    studyPromptGate,
    isMemoryVisible: (chatId, memoryId) => {
      const chat = store.getChat(chatId)
      return Boolean(chat && memory.injectedFor(chat.projectId, chatId).some((item) => item.id === memoryId))
    },
  })
  const studySessionAttribution = createStudySessionAttribution({
    policy: conditionPolicy,
    registry: studyRegistry,
  })
  const studyPreviewRuntime = conditionPolicy.studyMode ? new StudyPreviewRuntime() : null
  const activeAgent = new AgentCoordinator({
    store,
    memory,
    policy: conditionPolicy,
    studyMemoryStore,
    staticMemoryExtractor,
    studyPreviewRuntime,
    getActiveStudyTaskId: () => conditionPolicy.studyMode ? studyRegistry.activeTaskId() : null,
    studyPromptGate,
    onParticipantPromptRecorded: studyTelemetry
      ? (input) => studyTelemetry.recordParticipantPrompt(input)
      : undefined,
    openingBoardBacklog: conditionPolicy.studyMode && conditionPolicy.condition === "memosync"
      ? memoryBoardBacklog
      : null,
    getMemoryPreviewSettings: () => appSettings.getSnapshot().memoryPreview,
    capture:
      memoryLlm && conditionPolicy.capture !== "off"
          ? createCaptureService({
            memory,
            callJson: memoryLlm,
            surface: conditionPolicy.capture,
            durablePromptCapture: conditionPolicy.studyMode && conditionPolicy.condition === "memosync",
          })
        : null,
    // No logger: the coordinator CAS-validates trace verdicts against live
    // memory state and emits memory.trace itself.
    memoryTrace: memoryLlm && conditionPolicy.trace ? createTraceService({ callJson: memoryLlm }) : null,
    memoryRevision,
    memoryCheckup,
    memoryTransferDetect,
    // Sidecar relevance prediction on the receipt (REDESIGN D6): the receipt
    // itself stays a pure plan readout; the prediction arrives as its own
    // entry, visually marked as a guess.
    memoryRelevance: memoryLlm && conditionPolicy.preview ? createRelevanceService({ callJson: memoryLlm }) : null,
    memoryUsePlan,
    memoryPreview: conditionPolicy.preview,
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
  const studyWorkingMemoryAdmission = createStudyWorkingMemoryAdmission({
    policy: conditionPolicy,
    store,
    studyPromptGate,
    getPendingPreview: (chatId) => activeAgent.pendingPreviews.get(chatId) ?? null,
  })
  const studyWorkingMemoryEvidenceAdmission = createStudyWorkingMemoryEvidenceAdmission({
    policy: conditionPolicy,
    registry: studyRegistry,
    store,
    assignedProjects: assignedStudyProjects,
    getPendingPreview: (chatId) => activeAgent.pendingPreviews.get(chatId) ?? null,
  })
  const studyQuestionnaire = studyMemoryStore
    ? new StudyQuestionnaireService({
        store: studyMemoryStore,
        registry: studyRegistry,
        logger: memory.logger,
        memoryStore: memory.store,
        getAutoProjectCloneRef: (memoryId) => memory.getAutoProjectCloneRef(memoryId),
        studyFreezeBlocker: () => activeAgent.studyFreezeBlocker(),
        reconcileParticipantPrompts: () => {
          studyParticipantPromptReconciler?.reconcile()
        },
        awaitStudyMemorySettled: (taskId) => activeAgent.awaitStudyMemorySettled(taskId),
        retireStudyTaskRuntime: (taskId) => activeAgent.retireStudyTaskRuntime(taskId),
        getTaskRunEvidence: (taskId) => activeAgent.studyTaskRunEvidence(taskId),
        captureWorkspaceState: async (taskId) => {
          const assigned = resolveStudyWorkspaceProject(taskId, assignedStudyProjects)
          return describeStudyWorkspace(assigned.sourceDir)
        },
        snapshotWorkspace: async ({ taskId, snapshotId, frozenAt }) => {
          const assigned = resolveStudyWorkspaceProject(taskId, assignedStudyProjects)
          return snapshotStudyWorkspace({
            dataDir: store.dataDir,
            ...assigned,
            taskId,
            snapshotId,
            frozenAt,
          })
        },
        resolveAdditionalObjectStates: async (taskId, identities) => {
          const staticIdentities = identities.filter((identity) => identity.scheme === "static")
          if (staticIdentities.length === 0) return []
          if (!staticMemoryExtractor) {
            throw new StudyQuestionnaireError(
              "Static memory measurement is unavailable. Please retry or let the experimenter know.",
              503,
            )
          }
          try {
            return await resolveFrozenStaticObjectStates({
              taskId,
              identities: staticIdentities,
              store: studyMemoryStore,
              extractor: staticMemoryExtractor,
              getWorkspaceDir: (namespace) => store.getProject(namespace)?.localPath,
            })
          } catch (error) {
            throw new StudyQuestionnaireError(
              error instanceof Error
                ? `Could not freeze Static memory state: ${error.message}`
                : "Could not freeze Static memory state.",
              503,
            )
          }
        },
        getChatInfo: (chatId) => {
          const chat = store.getChat(chatId)
          return chat ? { title: chat.title, projectId: chat.projectId } : undefined
        },
      })
    : null
  const studyBaselineProjectCopyPreparer = studyMemoryStore
    ? createStudyBaselineProjectCopyPreparer({
        policy: conditionPolicy,
        store: studyMemoryStore,
        dataDir: store.dataDir,
        memory,
        summaries: memorySummary,
        assignedProjects: assignedStudyProjects,
      })
    : null
  const studySurvey = studyMemoryStore
    ? new StudySurveyService({
        store: studyMemoryStore,
        registry: studyRegistry,
        logger: memory.logger,
        allocationParticipantId: studyParticipantId,
        nextSessionPreparer: studyBaselineProjectCopyPreparer,
        completionUrl: process.env.PROLIFIC_COMPLETION_URL,
      })
    : null
  const studyProjectAccess: StudyProjectAccess | undefined = conditionPolicy.studyMode
    ? {
        projectRefusal: (projectId) => {
          const taskId = studyRegistry.activeTaskId()
          const task = taskId ? getStudyTask(taskId) : undefined
          const assigned = task ? assignedStudyProjects.get(task.projectSlug) : undefined
          if (!task || !assigned?.starterReady || assigned.projectId !== projectId) {
            return "Open the active task brief and use the assigned project."
          }
          return studyRegistry.promptRefusal()
        },
      }
    : undefined
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
    // Study deployments cut non-essential outbound access (skills.sh).
    remoteSkillsEnabled: !conditionPolicy.studyMode,
    studyProjectAccess,
    studyPreviewRuntime: studyPreviewRuntime ?? undefined,
    canAutoHealStudyPreview: (projectId) => {
      if (!conditionPolicy.studyMode) return false
      const taskId = studyRegistry.activeTaskId()
      if (!taskId || studyRegistry.postSessionPending() || studyRegistry.freezeState(taskId) !== "open") return false
      const task = getStudyTask(taskId)
      return Boolean(task && assignedStudyProjects.get(task.projectSlug)?.projectId === projectId)
    },
    // Study arms only: the serial gate can refuse prompts (chat from a
    // completed session, pending questionnaire, or a finished study).
  })
  // Static atomization is measurement-only and may have been interrupted by
  // a process restart after Claude accepted the exact text. Replay those
  // durable payloads before the HTTP listener can accept a freeze request.
  activeAgent.resumePendingStaticFocusMaterializations()
  // The first MemoSync prompt is already owned by a durable opening-Board
  // claim before it reaches AgentCoordinator. Re-prime that exact logical
  // turn after restart; its review id prevents a second prompt/turn/telemetry
  // record and Working Memory still waits for the final Board Continue.
  activeAgent.resumeOpeningBoardPreparation()
  const staleEmptyChatPruneInterval = setInterval(() => {
    void router.pruneStaleEmptyChats()
      .then(() => router.broadcastSnapshots())
  }, STALE_EMPTY_CHAT_PRUNE_INTERVAL_MS)

  // Re-prime any chat whose queue was left stranded by a restart (BUG CORE-2).
  // Fire-and-forget: engine boots can be slow and must not block the listener;
  // drainOrphanedQueues logs its own per-chat errors.
  void activeAgent.drainOrphanedQueues()

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
          const previewPort = previewProxyTarget(req, actualPort)
          if (previewPort !== null) {
            // The public path form shares the app origin, so it must inherit
            // the app's CSRF and password boundary. The localhost-subdomain
            // form remains a local-only compatibility route; host-only auth
            // cookies are not sent to <port>.localhost.
            if (isPathPreviewProxyRequest(req, previewPort)) {
              if (!validateRequestOrigin(req, {
                trustProxy: options.trustProxy ?? false,
                allowedOrigins,
              })) {
                return new Response("Forbidden", { status: 403 })
              }
              if (auth && !auth.isAuthenticated(req)) {
                return new Response("Unauthorized", { status: 401 })
              }
            }
            return proxyPreviewRequest(req, url, previewPort)
          }

          if (url.pathname === "/auth/status") {
            return auth
              ? auth.handleStatus(req)
              : Response.json({ enabled: false, authenticated: true })
          }

          if (url.pathname === "/auth/logout") {
            if (req.method !== "POST") {
              return new Response(null, { status: 405, headers: { Allow: "POST" } })
            }

            return auth
              ? auth.handleLogout(req)
              : Response.json({ ok: true })
          }

          if ((url.pathname === "/ws" || url.pathname.startsWith("/api/")) && !validateRequestOrigin(req, {
            trustProxy: options.trustProxy ?? false,
            allowedOrigins,
          })) {
            return new Response("Forbidden", { status: 403 })
          }

          if (auth) {
            if (url.pathname === "/auth/login") {
              if (req.method === "GET") {
                return auth.redirectToApp(req)
              }
              if (req.method === "POST") {
                return auth.handleLogin(req, "/")
              }
              return new Response(null, { status: 405, headers: { Allow: "GET, POST" } })
            }

            // The experimenter's unfreeze escape hatch authenticates by its
            // admin key alone (checked in the study routes): mid-session
            // rescue must not require fishing a participant's cookie.
            const isStudyAdminRequest =
              url.pathname === "/api/study/unfreeze" && req.headers.has("x-study-admin")
            if (url.pathname === "/ws") {
              if (!auth.isAuthenticated(req)) {
                return new Response("Unauthorized", { status: 401 })
              }
            } else if (url.pathname.startsWith("/api/") && !isStudyAdminRequest && !auth.isAuthenticated(req)) {
              return Response.json({ error: "Unauthorized" }, { status: 401 })
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
            return Response.json({ ok: true, port: actualPort })
          }

          const uploadResponse = await handleProjectUpload(req, url, store, studyProjectAccess)
          if (uploadResponse) {
            return uploadResponse
          }

          const deleteUploadResponse = await handleProjectUploadDelete(req, url, store, studyProjectAccess)
          if (deleteUploadResponse) {
            return deleteUploadResponse
          }

          const attachmentContentResponse = await handleAttachmentContent(req, url, store)
          if (attachmentContentResponse) {
            return attachmentContentResponse
          }

          const projectFileContentResponse = await handleProjectFileContent(req, url, store, {
            beginStudyMemoryMutation,
            experimentLogger: memory.logger,
            getActiveStudyTaskId: () => conditionPolicy.studyMode ? studyRegistry.activeTaskId() : null,
            studyProjectAccess,
          })
          if (projectFileContentResponse) {
            return projectFileContentResponse
          }

          const workspaceResponse = await handleWorkspaceRequest(req, url, store, {
            beginStudyMemoryMutation,
            experimentLogger: memory.logger,
            getActiveStudyTaskId: () => conditionPolicy.studyMode ? studyRegistry.activeTaskId() : null,
            studyProjectAccess,
          })
          if (workspaceResponse) {
            return workspaceResponse
          }

          const memoryResponse = await handleMemoryRequest(req, url, memory, conditionPolicy, {
            transfer: memoryTransfer,
            sanitize: memorySanitize,
            maintenance: memoryMaintenance,
            summary: memorySummary,
            summaryProjectRefusal: studyProjectAccess?.projectRefusal,
            reviseInjection: memoryReviseInjection,
            usePlan: memoryUsePlan,
            revision: memoryRevision,
            boardBacklog: memoryBoardBacklog,
            boardReviewAdmission: (taskId) => {
              if (studyRegistry.activeTaskId() !== taskId) return "This is not the active study session."
              if (studyRegistry.postSessionPending()) return "Post-session questions now own this session."
              if (studyRegistry.freezeState(taskId) !== "open") return "This study session is no longer open."
              return null
            },
            openingPromptAdmission: ({ chatId, reviewId, content, attachments }) => {
              if (!studyPromptGate?.admitOpening) return "Study prompt admission is unavailable."
              return studyPromptGate.admitOpening({
                chatId,
                channel: "chat.send",
                content,
                attachments: attachments as ChatAttachment[],
                openingReviewId: reviewId,
                openingBoardPreparation: true,
              })
            },
            resumeOpeningBoardPreparation: () => activeAgent.resumeOpeningBoardPreparation(),
            blockingBoardReviewRequired: () => {
              if (conditionPolicy.condition !== "memosync") return false
              const taskId = studyRegistry.activeTaskId()
              if (!taskId) return false
              const review = memoryBoardBacklog.reviewState(taskId)
              return review.reviewed !== true || (
                review.openingPrompt !== undefined && review.openingPrompt.phase !== "completed"
              )
            },
            auditAdmission: studyAuditAdmission,
            workingMemorySelectionAdmission: studyWorkingMemoryAdmission,
            workingMemoryEvidenceAdmission: studyWorkingMemoryEvidenceAdmission,
            workingMemoryUsePlan: (input) => activeAgent.planMemoryPreviewUses(input),
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
            studySessionAttribution,
            beginStudyMemoryMutation,
          })
          if (memoryResponse) {
            return memoryResponse
          }

          // Experiment shell: task briefs + the post-session quiz over the
          // immutable set of memories actually focused during the session.
          const studyResponse = await handleStudyRequest(req, url, {
            registry: studyRegistry,
            questionnaire: studyQuestionnaire,
            survey: studySurvey,
            onboarding: studyOnboarding,
            telemetry: studyTelemetry,
            adminKey: process.env.STUDY_ADMIN_KEY,
            instructionGuard: studyMemoryStore
              ? {
                  recordUiAttempt: (attempt) => {
                    const event = {
                      eventId: crypto.randomUUID(),
                      recordedAt: new Date().toISOString(),
                      channel: "ui" as const,
                      reason: "ui_attempt" as const,
                      disqualifying: false,
                      ...attempt,
                    }
                    // UI events are deterrence/review signals only. A browser
                    // shortcut is never, by itself, compensation evidence.
                    studyMemoryStore.recordInstructionGuardEvent(event)
                    memory.logger.event({ type: "study.instruction_guard", ...event })
                  },
                }
              : undefined,
            uiReceipts: studyMemoryStore
              ? {
                  has: (key) => studyMemoryStore.hasUiReceipt(key),
                  record: (key) => studyMemoryStore.recordUiReceipt(key, new Date().toISOString()),
                }
              : undefined,
            assignedProject: (taskId) => {
              const task = getStudyTask(taskId)
              const assigned = task ? assignedStudyProjects.get(task.projectSlug) : undefined
              return assigned
                ? { projectId: assigned.projectId, starterReady: assigned.starterReady }
                : null
            },
          })
          if (studyResponse) {
            return studyResponse
          }

          // The client reads the study-condition policy to gate its surfaces
          // (Memory Board nav, session-memories panel, review cards). The
          // provider catalog rides along so the launcher's picker honors the
          // study pin even before any chat snapshot exists.
          if (url.pathname === "/api/condition") {
            return Response.json({ data: conditionPolicy, providers: deployedProviders() })
          }

          // Add Project's path picker browses the WORKSPACE machine's
          // filesystem — participants otherwise read the path field as their
          // own computer (pilot feedback 2026-08-11).
          if (url.pathname === "/api/workspace/dirs") {
            return Response.json({ data: listWorkspaceDirectories(url.searchParams.get("path") ?? undefined) })
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

  const shutdown = async () => {
    clearInterval(staleEmptyChatPruneInterval)
    for (const chatId of [...activeAgent.activeTurns.keys()]) {
      await activeAgent.cancel(chatId)
    }
    await activeAgent.shutdownStudyRuntime()
    router.dispose()
    appSettings.dispose()
    keybindings.dispose()
    terminals.closeAll()
    memory.close()
    studyMemoryStore?.close()
    await store.compact()
    server.stop(true)
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
  studyProjectAccess?: StudyProjectAccess,
) {
  if (req.method !== "POST") {
    return null
  }

  const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/uploads$/)
  if (!match) {
    return null
  }

  const projectRefusal = studyProjectAccess?.projectRefusal(match[1])
  if (projectRefusal) {
    return Response.json(
      { error: { code: "STUDY_PROJECT_LOCKED", message: projectRefusal } },
      { status: 409 },
    )
  }

  const project = store.getProject(match[1])
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 })
  }

  const declaredSize = Number(req.headers.get("content-length"))
  if (Number.isFinite(declaredSize) && declaredSize > MAX_REQUEST_BODY_SIZE_BYTES) {
    return Response.json({ error: "Upload request is too large." }, { status: 413 })
  }

  const formData = await req.formData()
  const files = formData
    .getAll("files")
    .filter((value): value is File => value instanceof File)

  if (files.length === 0) {
    return Response.json({ error: "No files uploaded" }, { status: 400 })
  }

  const validationError = validateUploadFiles(files)
  if (validationError) {
    return Response.json({ error: validationError.error }, { status: validationError.status })
  }

  try {
    const attachments = await persistUploadedFiles({
      projectId: project.id,
      localPath: project.localPath,
      files,
    })
    return Response.json({ attachments })
  } catch (error) {
    console.error("[uploads] Upload failed:", error)
    return Response.json({ error: "Upload failed" }, { status: 500 })
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
    return Response.json({ error: "Project not found" }, { status: 404 })
  }

  const storedName = decodeURIComponent(match[2])
  if (!storedName || storedName.includes("/") || storedName.includes("\\") || storedName === "." || storedName === "..") {
    return Response.json({ error: "Invalid attachment path" }, { status: 400 })
  }

  const resolved = await resolveExistingProjectUpload(project.localPath, storedName)
  if (!resolved.ok) {
    return Response.json(
      { error: resolved.reason === "outside" ? "Invalid attachment path" : "Attachment not found" },
      { status: resolved.reason === "outside" ? 400 : 404 }
    )
  }
  const filePath = resolved.path
  const file = Bun.file(filePath)
  try {
    const info = await stat(filePath)
    if (!info.isFile()) {
      return Response.json({ error: "Attachment not found" }, { status: 404 })
    }
  } catch {
    return Response.json({ error: "Attachment not found" }, { status: 404 })
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
  options: {
    beginStudyMemoryMutation?: () => (() => void) | null
    experimentLogger?: Pick<ExperimentLogger, "event">
    getActiveStudyTaskId?: () => string | null
    studyProjectAccess?: StudyProjectAccess
  } = {},
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
    const projectRefusal = options.studyProjectAccess?.projectRefusal(match[1])
    if (projectRefusal) {
      return Response.json(
        { error: { code: "STUDY_PROJECT_LOCKED", message: projectRefusal } },
        { status: 409 },
      )
    }
  }

  const releaseStudyMutation = req.method === "PUT"
    ? options.beginStudyMemoryMutation?.()
    : undefined
  if (req.method === "PUT" && options.beginStudyMemoryMutation && !releaseStudyMutation) {
    return Response.json(
      { error: { code: "STUDY_FROZEN", message: "The current session is ending. Workspace files can no longer be changed." } },
      { status: 409 },
    )
  }

  try {
    const project = store.getProject(match[1])
    if (!project) {
      return Response.json({ error: "Project not found" }, { status: 404 })
    }

    const requestedRelativePath = decodeURIComponent(match[2])
    const relativePath = path.posix.normalize(requestedRelativePath.replaceAll("\\", "/"))
    if (!relativePath || relativePath === "." || relativePath.startsWith("../") || relativePath.includes("/../") || path.posix.isAbsolute(relativePath)) {
      return Response.json({ error: "Invalid project file path" }, { status: 400 })
    }
    if (
      req.method === "PUT"
      && resolveConditionPolicy().condition === "static"
      && isStaticMemoryMarkdownPath(relativePath)
      && !isStaticMemoryMarkdownPath(requestedRelativePath)
    ) {
      return Response.json({ error: "Invalid Static memory file path" }, { status: 400 })
    }

    const resolved = await resolveExistingPathWithinRoot(project.localPath, relativePath)
    if (!resolved.ok) {
      return Response.json(
        { error: resolved.reason === "outside" ? "Invalid project file path" : "File not found" },
        { status: resolved.reason === "outside" ? 400 : 404 }
      )
    }
    const filePath = resolved.path

    const file = Bun.file(filePath)
    try {
      const info = await stat(filePath)
      if (!info.isFile()) {
        return Response.json({ error: "File not found" }, { status: 404 })
      }
    } catch {
      return Response.json({ error: "File not found" }, { status: 404 })
    }

    if (req.method === "PUT") {
      // Save from the Files editor. Existing files only (resolve above already
      // 404s otherwise), so the panel can't create paths the tree doesn't show.
      const declaredSize = Number(req.headers.get("content-length"))
      if (Number.isFinite(declaredSize) && declaredSize > MAX_EDITOR_SAVE_BYTES) {
        return Response.json({ error: "File too large to save" }, { status: 413 })
      }
      const body = await req.text()
      if (Buffer.byteLength(body, "utf8") > MAX_EDITOR_SAVE_BYTES) {
        return Response.json({ error: "File too large to save" }, { status: 413 })
      }
      let previousContent = ""
      try {
        previousContent = await file.text()
      } catch {
        // The file was resolved above; a raced read failure will still be
        // handled by the write response below.
      }
      const isStaticMemoryMarkdown = isStaticMemoryMarkdownPath(relativePath)
      const changedStaticMemory = resolveConditionPolicy().condition === "static"
        && isStaticMemoryMarkdown
        && body !== previousContent
      const activeTaskId = options.getActiveStudyTaskId?.() ?? null
      const operationId = req.headers.get("x-memosync-event-id")?.trim() || undefined
      if (changedStaticMemory && activeTaskId && !operationId) {
        return Response.json(
          { error: { code: "EVENT_ID_REQUIRED", message: "A durable Static edit operationId is required during the study" } },
          { status: 400 },
        )
      }
      const durationHeader = req.headers.get("x-memosync-edit-duration-ms")
      const rawDuration = durationHeader === null ? Number.NaN : Number(durationHeader)
      const durationMs = Number.isFinite(rawDuration) && rawDuration >= 0 ? Math.round(rawDuration) : undefined
      const writeAndStat = async () => {
        await Bun.write(filePath, body)
        const written = await stat(filePath)
        if (!written.isFile()) throw new Error("Static memory target is not a file")
      }
      try {
        if (changedStaticMemory) {
          await runDurableStaticEditOperation({
            logger: options.experimentLogger,
            taskId: activeTaskId,
            operationId,
            chatId: req.headers.get("x-memosync-session-id") || undefined,
            projectId: project.id,
            path: relativePath,
            durationMs,
            run: writeAndStat,
          })
        } else {
          await writeAndStat()
        }
      } catch (error) {
        const status = error !== null && typeof error === "object" && "status" in error && error.status === 409 ? 409 : 500
        return Response.json(
          status === 409
            ? { error: { code: "OPERATION_ALREADY_RECORDED", message: "This Static memory edit was already recorded. Refresh to recover its current outcome." } }
            : { error: "Failed to write file" },
          { status },
        )
      }
      return Response.json({ data: { saved: true, size: Buffer.byteLength(body, "utf8") } })
    }

    return new Response(file, {
      headers: {
        "Content-Type": inferProjectFileContentType(relativePath, file.type),
        "X-Content-Type-Options": "nosniff",
      },
    })
  } finally {
    releaseStudyMutation?.()
  }
}

export async function handleProjectUploadDelete(
  req: Request,
  url: URL,
  store: EventStore,
  studyProjectAccess?: StudyProjectAccess,
) {
  if (req.method !== "DELETE") {
    return null
  }

  const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/uploads\/([^/]+)$/)
  if (!match) {
    return null
  }

  const projectRefusal = studyProjectAccess?.projectRefusal(match[1])
  if (projectRefusal) {
    return Response.json(
      { error: { code: "STUDY_PROJECT_LOCKED", message: projectRefusal } },
      { status: 409 },
    )
  }

  const project = store.getProject(match[1])
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 })
  }

  const storedName = decodeURIComponent(match[2])
  if (!storedName || storedName.includes("/") || storedName.includes("\\") || storedName === "." || storedName === "..") {
    return Response.json({ error: "Invalid attachment path" }, { status: 400 })
  }

  const deleted = await deleteProjectUpload({
    localPath: project.localPath,
    storedName,
  })

  return Response.json({ ok: deleted })
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
