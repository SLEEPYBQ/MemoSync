import { query, type CanUseTool, type PermissionResult, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { homedir } from "node:os"
import type {
  AgentProvider,
  ChatAttachment,
  ContextWindowUsageSnapshot,
  ModelOptions,
  NormalizedToolCall,
  PendingToolSnapshot,
  ChatActivityStatus,
  QueuedChatMessage,
  TranscriptEntry,
} from "../shared/types"
import { normalizeToolCall } from "../shared/tools"
import type { ClientCommand } from "../shared/protocol"
import { EventStore } from "./event-store"
import { CodexAppServerManager } from "./codex-app-server"
import { type GenerateChatTitleResult, generateTitleForChatDetailed } from "./generate-title"
import type { HarnessEvent, HarnessToolRequest, HarnessTurn } from "./harness-types"
import {
  applyClaudeSdkModels,
  type ClaudeSdkModelInfo,
  codexServiceTierFromModelOptions,
  getServerProviderCatalog,
  normalizeClaudeModelOptions,
  normalizeCodexModelOptions,
  normalizeServerModel,
} from "./provider-catalog"
import { resolveClaudeApiModelId } from "../shared/types"
import { fallbackTitleFromMessage } from "./generate-title"
import type { MemoryService } from "./memory"
import { buildMemoryToolSpecs, dispatchMemoryTool, type MemoryToolContext } from "./memory/tools"
import {
  computeMemoryTurnDelta,
  normalizeMemorySelection,
  planMemoryInjection,
  type MemoryInjectionPlan,
} from "./memory/injection"
import { toClaudeMemoryMcpServer } from "./memory/claude-adapter"
import { resolveConditionPolicy, type ConditionPolicy } from "./experiment/condition"
import {
  buildDeliveredStoreFocusEvent,
  persistDeliveredStoreFocusEvent,
  recordDeliveredStoreFocus,
} from "./experiment/focus"
import type { PendingStaticFocusDelivery, StudyMemoryStore } from "./experiment/study-memory-store"
import type { StaticMemoryExtractor } from "./experiment/static-memory-extractor"
import { materializePendingStaticFocus, reserveDeliveredStaticFocus } from "./experiment/static-focus"
import type { StudyPromptGate, StudyPromptGateInput } from "./study-prompt-gate"
import { claudeSessionFileExists } from "./claude-session-files"
import { ensureProjectDirectory } from "./paths"
import { toCodexDynamicTools } from "./memory/codex-adapter"
import { extractCitations } from "./memory/citations"
import type { CaptureOutcome, CaptureService } from "./memory/capture"
import type { RelevanceService, RelevantMemory } from "./memory/relevance"
import type { ExpectedMemoryUse, UsePlanService } from "./memory/use-plan"
import { coerceTraceOutcome, type TraceOutcome, type TraceService } from "./memory/trace"
import { runForkTrace } from "./memory/trace-fork"
import { runForkCapture } from "./memory/capture-fork"
import { runForkQuery } from "./memory/fork-query"
import type { RevisionService } from "./memory/evolution"
import type { CheckupResult, CheckupService } from "./memory/checkup"
import type {
  TransferDetectService,
  TransferSuggestionCard,
  TransferSuggestionProgress,
  TransferTaskResult,
} from "./memory/transfer-detect"
import type { MemoryItem } from "./memory/types"
import type { MemoryPreviewDecision } from "../shared/types"
import type {
  MemoryBoardBacklogService,
  MemoryBoardOpeningPromptRecovery,
} from "./memory/board-backlog"
import { studyProjectSubprocessEnv } from "./study-project-runtime"
import type { StudyPreviewRuntimeController } from "./study-preview-runtime"
import { toClaudeStudyPreviewMcpServer } from "./study-preview-claude-adapter"
import { isKnownCatalogModel, resolveChatProviderRoute } from "./chat-providers"

export function toMemoryCandidateReferences(items: Array<Pick<MemoryItem, "id">>) {
  return items.map(({ id }) => ({ id }))
}

export function resolveClaudeSessionModel(requestedModel: string, configuredModel = process.env.ANTHROPIC_MODEL) {
  const configured = configuredModel?.trim()
  if (isKnownCatalogModel(requestedModel)) {
    // The picker only offers catalog ids (deepseek-*/glm-*). The chat's pick
    // wins over the env default. Exception: an own-Anthropic setup
    // (MEMOSYNC_USE_OWN_ANTHROPIC=1 with a foreign ANTHROPIC_MODEL) makes the
    // configured model win, or every turn would send a catalog id to an
    // endpoint that has never heard of it.
    return configured && !isKnownCatalogModel(configured) ? configured : requestedModel
  }
  return configured || requestedModel
}

export function buildClaudeSdkRuntimeOptions(args: {
  requestedModel: string
  configuredModel?: string
  env: Readonly<Record<string, string | undefined>>
}) {
  const rawModel = resolveClaudeSessionModel(args.requestedModel, args.configuredModel)
  // Normalize away an operator-supplied suffix first so we never double-append.
  const resolvedModel = rawModel.endsWith("[1m]") ? rawModel.slice(0, -"[1m]".length) : rawModel

  // A non-default vendor (currently GLM) overrides the whole ANTHROPIC_* bundle
  // for THIS session's subprocess so it talks to that vendor's endpoint with
  // its own key. Memory passes are untouched — they stay on the DeepSeek
  // sidecar regardless of which vendor this chat picked.
  const route = resolveChatProviderRoute(resolvedModel, args.env)
  if (route) {
    return {
      model: route.appendOneMillionSuffix ? `${resolvedModel}[1m]` : resolvedModel,
      settings: { autoMemoryEnabled: false, autoDreamEnabled: false },
      env: {
        ...args.env,
        ANTHROPIC_BASE_URL: route.baseUrl,
        // Claude Code reads AUTH_TOKEN; API_KEY covers Anthropic-SDK callers.
        ANTHROPIC_AUTH_TOKEN: route.apiKey,
        ANTHROPIC_API_KEY: route.apiKey,
        ANTHROPIC_MODEL: resolvedModel,
        ANTHROPIC_DEFAULT_OPUS_MODEL: resolvedModel,
        ANTHROPIC_DEFAULT_SONNET_MODEL: resolvedModel,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: route.subagentModel,
        ANTHROPIC_SMALL_FAST_MODEL: route.subagentModel,
        CLAUDE_CODE_SUBAGENT_MODEL: route.subagentModel,
        // The vendor owns its window; don't inherit the DeepSeek boot value.
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: route.autoCompactWindow,
      },
    }
  }

  // Default path: DeepSeek (ANTHROPIC_* already set at boot) or own-Anthropic.
  // Every DeepSeek session runs with the `[1m]` CLI context-window selector
  // (the CLI strips it before calling the provider). Without the selector the
  // CLI books the unknown model id as 200k and its PREFLIGHT rejects long
  // prompts with "Prompt is too long" at ~152k (observed live 2026-08-24).
  const isDeepSeek = resolvedModel.startsWith("deepseek-")
  return {
    model: isDeepSeek ? `${resolvedModel}[1m]` : resolvedModel,
    settings: {
      autoMemoryEnabled: false,
      autoDreamEnabled: false,
    },
    env: {
      ...args.env,
      ...(isDeepSeek
        ? {
            // Auto-compact stays ON, budgeted at 768k of the 1M window (only
            // effective on a [1m] model; 786432 is DeepSeek's documented
            // value). If long sessions drop mid-stream around ~500k, fall
            // back to 400000.
            CLAUDE_CODE_AUTO_COMPACT_WINDOW: args.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || "786432",
          }
        : {}),
    },
  }
}

// Deliberate engine configuration survives; everything else CLAUDE_* is a
// session-internal variable (OAuth scopes, messaging sockets, nested-session
// markers) leaked from a Claude Code shell the server was launched in — the
// SDK subprocess mistakes itself for a nested harness session and hangs at
// boot when it inherits them (observed 2026-08-24 launching MemoSync from a
// Claude Code terminal).
const CLAUDE_ENGINE_ENV_ALLOWLIST = new Set([
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_EFFORT_LEVEL",
])

export function buildClaudeSubprocessEnv(args: {
  localPath: string
  rawStudyProjects: string | undefined
  baseEnv?: Readonly<Record<string, string | undefined>>
}): Record<string, string | undefined> {
  const baseEnv: Record<string, string | undefined> = { ...(args.baseEnv ?? process.env) }
  for (const key of Object.keys(baseEnv)) {
    if ((key === "CLAUDECODE" || key.startsWith("CLAUDE_")) && !CLAUDE_ENGINE_ENV_ALLOWLIST.has(key)) {
      delete baseEnv[key]
    }
  }
  return studyProjectSubprocessEnv(baseEnv, args.localPath, args.rawStudyProjects)
}

const CLAUDE_TOOLSET = [
  "Skill",
  "WebFetch",
  "WebSearch",
  "Task",
  "TaskOutput",
  "Bash",
  "Glob",
  "Grep",
  "Read",
  "Edit",
  "Write",
  "TodoWrite",
  "KillShell",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
] as const

/** Candidate actions can keep changing the target pool while Decode runs.
 * Bound retries so a hot target safely yields no card instead of livelock. */
const MAX_TRANSFER_TARGET_REFRESHES = 3

interface MemoryPreparationCancellation {
  /** Aborts task-local prompt parsing/materialization; shared source Encode is
   * deliberately not wired to this signal. */
  signal: AbortSignal
  requested: Promise<void>
  cancelAndWait: () => Promise<void>
  settle: () => void
}

interface DeferredAutoStartGuard {
  signal: AbortSignal
  authorizeDelivery: () => boolean
  isCommittedCancellationRequested: () => boolean
  markTurnStarted: () => void
}

function createMemoryPreparationCancellation(): MemoryPreparationCancellation {
  const controller = new AbortController()
  let resolveRequested!: () => void
  const requested = new Promise<void>((resolve) => { resolveRequested = resolve })
  let resolveSettled!: () => void
  const settled = new Promise<void>((resolve) => { resolveSettled = resolve })
  let didSettle = false
  return {
    signal: controller.signal,
    requested,
    cancelAndWait: () => {
      if (!controller.signal.aborted) {
        controller.abort()
        resolveRequested()
      }
      return settled
    },
    settle: () => {
      if (didSettle) return
      didSettle = true
      resolveSettled()
    },
  }
}

class PendingAutoCaptureStart {
  phase: "barrier" | "dispatching" = "barrier"
  readonly cancellation = createMemoryPreparationCancellation()
  cancellationReceipt?: Promise<void>
  cancellationOperation?: Promise<void>
  deliveryCommitted = false
  cancelCommittedDelivery = false
  readonly turnStartSettlement: Promise<boolean>
  readonly guard: DeferredAutoStartGuard
  private settleTurnStartOnce: (started: boolean) => void

  constructor(public queuedMessageId: string) {
    let settled = false
    let resolveTurnStart!: (started: boolean) => void
    this.turnStartSettlement = new Promise<boolean>((resolve) => {
      resolveTurnStart = resolve
    })
    this.settleTurnStartOnce = (started) => {
      if (settled) return
      settled = true
      resolveTurnStart(started)
    }
    this.guard = {
      signal: this.cancellation.signal,
      authorizeDelivery: () => {
        if (this.cancellation.signal.aborted) return false
        this.deliveryCommitted = true
        return true
      },
      isCommittedCancellationRequested: () => this.cancelCommittedDelivery,
      markTurnStarted: () => this.settleTurnStartOnce(true),
    }
  }

  settleWithoutTurnStart(): void {
    this.settleTurnStartOnce(false)
  }
}

// Appended to the system prompt in every arm (blinding-safe: names no memory
// system). The agent otherwise cannot know that a dev server it starts is what
// the user previews, or how it becomes reachable. The web app you build is the
// deliverable the user watches, so treat "start a server the user can open" as
// part of finishing a web task.
const BROWSER_USAGE_GUIDE = [
  "## Showing web apps in the participant's Browser panel",
  "",
  "The participant views the app through the Browser panel built into this study interface. The web server runs inside your project container; the participant's own browser cannot reach that container through `localhost`.",
  "",
  "- The supplied study workspace already has its starter dependencies and a project-specific PostgreSQL database. Use the existing `DB_*` environment variables; do not start or reconfigure a system PostgreSQL cluster unless a readiness check proves the provided database is unavailable.",
  "- The study runtime owns one preview server for the assigned project: frontend port 3000 and backend port 3001. It starts and stops that server automatically for every study condition.",
  "- Do not run commands that start, stop, detach, or replace a development server. In particular, do not use `npm run dev`, `npm run start:dev`, `next dev`, `nohup`, `setsid`, `disown`, `pkill`, or `kill`, and do not move either service to another port.",
  "- Do not run a production build (`npm run build`, `next build`, or an equivalent root build) while the managed preview owns this workspace: Next production builds rewrite the same `.next` artifacts used by the live preview. Tests, lint, and `tsc --noEmit` remain available.",
  "- Edit the application normally and rely on the managed server's hot reload. Use preview_status to inspect its phase, fixed ports, and bounded recent log; if it reports degraded or exited, use preview_restart. Do not repair its process lifecycle through Bash.",
  "- Do not deploy, tunnel, or expose the app through an external service.",
  "- Do not tell the participant to open `http://localhost:<port>` in their own browser.",
  "- After the server is ready, tell the participant exactly: open **Browser**, press **Home** if needed, find the server under **Local Servers**, and click the green server card belonging to the current project.",
  "- Prefer browser-side relative URLs such as `/api`. When a separate API server is needed, configure the frontend dev server to proxy those relative API requests to it. Do not embed a participant-facing `localhost` API URL.",
  "- Continue normal code and task verification after making the preview available. A quick HTTP readiness check is enough for the first preview; do not install browser automation solely to prove that the Browser panel can open it. Container-local success does not prove that the participant-visible Browser preview rendered successfully.",
  "- Ask the participant to test the result in the Browser panel. If hot reload is unavailable, ask them to press the Browser panel's **Refresh** button after your changes.",
  "- If the participant reports a blank page, do not claim the app is visible merely because `curl` or local Playwright succeeds. Re-check server logs and app errors, and report that the participant-visible preview may have failed.",
].join("\n")

export function buildClaudeSystemAppend(memoryBlock: string) {
  return [BROWSER_USAGE_GUIDE, memoryBlock].filter(Boolean).join("\n\n")
}

interface PendingToolRequest {
  toolUseId: string
  tool: NormalizedToolCall & { toolKind: "ask_user_question" | "exit_plan_mode" }
  resolve: (result: unknown) => void
}

interface ResumeInterruptedTurn {
  interruptId: string
  memoryId: string
  correction: string
  enforce?: boolean
  /** Server-owned interruption evidence; never trusted from the resume command. */
  quote?: string
  /** The recovery card's confirmed working set for this continuation only. */
  selectedIds: string[]
}

interface StartTurnArgs {
  chatId: string
  provider: AgentProvider
  content: string
  attachments: ChatAttachment[]
  /** Immutable private copies used only at the provider boundary. The
   * participant transcript continues to own `attachments`. */
  providerAttachments?: ChatAttachment[]
  model: string
  effort?: string
  serviceTier?: "fast"
  planMode: boolean
  appendUserPrompt: boolean
  steered?: boolean
  /** Resume of an interrupted turn (2026-08-19 C2): skip the pre-turn gates
   * and the working-memory confirmation — the recovery card confirmed the set. */
  resume?: ResumeInterruptedTurn
  /**
   * The plain user text for the memory passes (preview/capture/trace), when it
   * differs from `content`. A steered message wraps `content` in a
   * <system-message> envelope for the engine; the memory system must see the
   * user's real words, not the wrapper, or it produces off-topic previews and
   * nonsensical candidates (BUG AGENT-4). Undefined = use `content`.
   */
  memoryUserText?: string
  profile?: SendToStartingProfile | null
  /** Stable logical turn id shared by delivery and measurement records. */
  turnId?: string
  /** Internal queue-to-turn linearization guard for deferred Auto delivery. */
  deferredAutoStart?: DeferredAutoStartGuard
  /**
   * Called only after Claude accepts the prompt, with the exact focused ids
   * used by the delivery receipt. Interrupt recovery uses this server-owned
   * result instead of persisting the client selection it started from.
   */
  onMemoryDeliveryAccepted?: (focusedIds: readonly string[]) => void
  /** First-message Long-term review stays inside the blocking Board until explicit Continue. */
  openingReview?: { taskId: string; reviewId: string }
  /** Restart continuation after Candidate → Transfer → Checkup was already durable. */
  openingLongTermAlreadyReady?: boolean
  /** Durable dependency-CAS lineage; positive values force all Long-term stages to recompute in place. */
  openingLongTermRevision?: number
  /** Exact durable Working Memory decision that linearizes provider dispatch. */
  openingWorkingMemory?: {
    previewId: string
    decision: "go_on" | "without_memory"
  }
}

interface ActiveTurn {
  chatId: string
  provider: AgentProvider
  turn: HarnessTurn
  claudePromptSeq?: number
  model: string
  effort?: string
  serviceTier?: "fast"
  planMode: boolean
  status: ChatActivityStatus
  pendingTool: PendingToolRequest | null
  postToolFollowUp: { content: string; planMode: boolean } | null
  hasFinalResult: boolean
  cancelRequested: boolean
  cancelRecorded: boolean
  /**
   * Claude only: the provider emitted this turn's `system_init`. A Stop after
   * that point keeps the persistent Query (the provider acknowledges the
   * cancelled prompt, and the next turn's `system_init` realigns the FIFO);
   * a Stop before it retires the Query because a positional FIFO cannot tell
   * this turn's late frames from the next turn's.
   */
  providerTurnStarted: boolean
  clientTraceId?: string
  profilingStartedAt?: number
  /** 1-based user-visible turn number (count of user_prompt entries) — memory provenance. */
  turnNumber?: number
  /** Stable logical turn id for experiment records. */
  turnId: string
  /** Study task active when this turn began; null outside the study. */
  taskId: string | null
  /** Immutable memory plan used for this turn's boot, prompt text, and measurement. */
  memoryPlan: MemoryInjectionPlan | null
  /** The user message that started this turn — input to the post-turn memory passes. */
  userText?: string
  /** Streamed assistant text chunks, joined at turn end for capture/trace. */
  assistantChunks: string[]
  /** Active memory ids cited ([M-NN]) during this turn. */
  citedIds: Set<string>
  /** User chose "proceed without memory" at the preview gate for this turn. */
  memoryDisabled?: boolean
  /**
   * Snapshot of the memory ids injected for THIS turn, taken at engine boot.
   * Trace labels against this — a memory accepted mid-turn must not be
   * counted as "in play" for the turn that was already running.
   */
  injectedIds: string[]
}

interface ClaudeSessionHandle {
  provider: "claude"
  stream: AsyncIterable<HarnessEvent>
  getAccountInfo?: () => Promise<any>
  interrupt: () => Promise<void>
  close: () => void
  sendPrompt: (
    content: string,
    context?: Pick<MemoryToolContext, "turn" | "engine"> & { promptSeq?: number },
  ) => Promise<void>
  /** Release only the cancelled prompt reservations whose FIFO entries were
   * proven orphaned when a later provider turn started. */
  discardHumanTurnReservations?: (promptSeqs: readonly number[]) => number
  setModel: (model: string) => Promise<void>
  setPermissionMode: (planMode: boolean) => Promise<void>
  supportedModels?: () => Promise<ClaudeSdkModelInfo[]>
  /** The injection plan this session was booted with (null = memory off). Seeds the delta baseline. */
  memoryPlan?: MemoryInjectionPlan | null
}

interface ClaudeSessionState {
  id: string
  chatId: string
  session: ClaudeSessionHandle
  localPath: string
  model: string
  effort?: string
  planMode: boolean
  sessionToken: string | null
  accountInfoLoaded: boolean
  nextPromptSeq: number
  pendingPromptSeqs: number[]
  /** Retired sessions may still have SDK messages queued while Query.close() settles. */
  retired: boolean
  retireReason: string | null
  pump: Promise<void> | null
  /**
   * Rebuild key of the memory shape baked into this session ("memory-off" when
   * disabled). Under the delta model (REDESIGN D1) skills-mode CONTENT changes
   * no longer rebuild — they ride the next user turn as a delta block; only a
   * mode/tools flip (or plain/file content, which has no delta channel) forces
   * a rebuild. The resume token carries the conversation across rebuilds.
   */
  memorySetHash: string
  /**
   * id → version of what the context currently claims (boot snapshot, then
   * updated after every delta append). null = memory off or non-skills mode.
   */
  memoryBaseline: Map<string, number> | null
}

interface AgentCoordinatorArgs {
  store: EventStore
  onStateChange: (chatId?: string, options?: { immediate?: boolean }) => void
  codexManager?: CodexAppServerManager
  generateTitle?: (messageContent: string, cwd: string) => Promise<GenerateChatTitleResult>
  /** MemoSync memory layer; when present, memory tools + context are injected per engine. */
  memory?: MemoryService | null
  /** Forced post-turn capture hook (SPEC §4.1); null disables capture. */
  capture?: CaptureService | null
  /** Post-turn trace labeler (SPEC §4.10); null disables tracing. */
  memoryTrace?: TraceService | null
  /** Fork-based trace override (tests); default runs the real session fork. */
  forkTrace?: typeof runForkTrace
  forkCapture?: typeof runForkCapture
  forkQuery?: typeof runForkQuery
  /** Sidecar relevance prediction for the preview receipt (REDESIGN D6); null disables. */
  memoryRelevance?: RelevanceService | null
  /** Turn-scoped instructions for how Claude should use each selected memory. */
  memoryUsePlan?: UsePlanService | null
  /** Trace-driven revision proposals (self-evolution M4); null disables. */
  memoryRevision?: RevisionService | null
  /** Pre-turn preview gate (SPEC §4.10b): the injection receipt; false disables. */
  memoryPreview?: boolean
  /** Step-one library checkup (redesign 2026-08-07 §3); null disables. */
  memoryCheckup?: CheckupService | null
  /** Transfer detection over out-of-context memories (Transfer design 2026-08-08); null disables. */
  memoryTransferDetect?: TransferDetectService | null
  /** Study-arm policy; decides injection shape + tool registration (default: resolved from env). */
  policy?: ConditionPolicy
  /** Live preview-gate settings (STUDY_PLAN §2.4); default: always on, auto-proceed on empty plans. */
  getMemoryPreviewSettings?: () => { enabled: boolean; autoProceedWhenEmpty: boolean }
  /** Active serial-study task, stamped at turn start. */
  getActiveStudyTaskId?: () => string | null
  /** Study-only project/instruction admission, checked at every queue boundary. */
  studyPromptGate?: StudyPromptGate | null
  /** Durable participant-prompt evidence keyed by the transcript turn id. */
  onParticipantPromptRecorded?: (input: {
    taskId: string
    turnId: string
    chatId: string
    content: string
    attachments: ChatAttachment[]
    acceptedAt: string
  }) => void
  /** Durable first-message Board state machine; absent outside study MemoSync. */
  openingBoardBacklog?: MemoryBoardBacklogService | null
  /** Durable source of truth for study focus/freeze/questionnaire data. */
  studyMemoryStore?: StudyMemoryStore | null
  /** Hidden measurement-only atomizer used by the Static condition. */
  staticMemoryExtractor?: StaticMemoryExtractor | null
  /** Injectable resume-token validity check (default: real ~/.claude session-file lookup). */
  claudeSessionFileExists?: (localPath: string, sessionToken: string) => boolean
  /** Formal-study preview owner shared by Auto, Static, and MemoSync. */
  studyPreviewRuntime?: StudyAgentPreviewRuntime | null
  /** Bounded Query.close() drain wait; injectable for lifecycle tests. */
  claudeRetireTimeoutMs?: number
  startClaudeSession?: (args: {
    localPath: string
    model: string
    effort?: string
    planMode: boolean
    sessionToken: string | null
    forkSession: boolean
    onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
    memory?: MemoryService | null
    /** Routing gate for agent-proposed memories; enables the propose_memory tool. */
    capture?: CaptureService | null
    projectId?: string
    chatId?: string
    policy?: ConditionPolicy
    subprocessEnv?: Record<string, string | undefined>
    /** Precomputed once for this turn so boot, prompt, and measurement share exact text. */
    memoryPlan?: MemoryInjectionPlan | null
    restrictMemoryIds?: string[]
    onMemoryProposal?: (created: MemoryItem[]) => void
    studyPreviewRuntime?: StudyAgentPreviewRuntime | null
  }) => Promise<ClaudeSessionHandle>
}

interface SendToStartingProfile {
  traceId: string
  startedAt: number
}

export interface StudyMemoryQualityFlag {
  code:
    | "capture_failed"
    | "trace_failed"
    | "post_turn_failed"
    | "post_turn_incomplete"
    | "focus_persistence_failed"
    | "static_extraction_failed"
    | "static_focus_persistence_failed"
    | "static_focus_pending"
  blocking: boolean
  taskId: string
  chatId: string
  turnId: string
  turn?: number
}

interface PostTurnMemoryPassArgs {
  chatId: string
  projectId?: string
  engine: string
  turnNumber?: number
  turnId: string
  taskId: string | null
  userText: string
  assistantText: string
  citedIds: string[]
  /** Boot-time snapshot of the injected set (ActiveTurn.injectedIds). */
  injectedIds: string[]
  /** Preview gate said "proceed without memory" — nothing was injected, so no trace. */
  memoryDisabled?: boolean
  /** Claude only: resume token + workspace of the finished session — enables fork trace. */
  claudeSessionToken?: string | null
  localPath?: string
}

function isClaudeSteerLoggingEnabled() {
  return process.env.MEMOSYNC_LOG_CLAUDE_STEER === "1"
}

function logClaudeSteer(stage: string, details?: Record<string, unknown>) {
  if (!isClaudeSteerLoggingEnabled()) return
  console.log("[memosync/claude-steer]", JSON.stringify({
    stage,
    ...details,
  }))
}

const STEERED_MESSAGE_PREFIX = `<system-message>
The user would like to inform you of something while you continue to work. Acknowledge receipt immediately with a text response, then continue with the task at hand, incorporating the user's feedback if needed.
</system-message>`

interface SendMessageOptions {
  provider?: AgentProvider
  model?: string
  modelOptions?: ModelOptions
  effort?: string
  planMode?: boolean
}

function timestamped<T extends Omit<TranscriptEntry, "_id" | "createdAt">>(
  entry: T,
  createdAt = Date.now()
): TranscriptEntry {
  return {
    _id: crypto.randomUUID(),
    createdAt,
    ...entry,
  } as TranscriptEntry
}

function stringFromUnknown(value: unknown) {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function buildSteeredMessageContent(content: string) {
  return content.trim().length > 0
    ? `${STEERED_MESSAGE_PREFIX}\n\n${content}`
    : STEERED_MESSAGE_PREFIX
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function escapeXmlAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

function isSendToStartingProfilingEnabled() {
  return process.env.MEMOSYNC_PROFILE_SEND_TO_STARTING === "1"
}

function elapsedProfileMs(startedAt: number) {
  return Number((performance.now() - startedAt).toFixed(1))
}

function logSendToStartingProfile(
  profile: SendToStartingProfile | null | undefined,
  stage: string,
  details?: Record<string, unknown>
) {
  if (!profile || !isSendToStartingProfilingEnabled()) {
    return
  }

  console.log("[memosync/send->starting][server]", JSON.stringify({
    traceId: profile.traceId,
    stage,
    elapsedMs: elapsedProfileMs(profile.startedAt),
    ...details,
  }))
}

export function buildAttachmentHintText(attachments: ChatAttachment[]) {
  if (attachments.length === 0) return ""

  const lines = attachments.map((attachment) => (
    `<attachment kind="${escapeXmlAttribute(attachment.kind)}" mime_type="${escapeXmlAttribute(attachment.mimeType)}" path="${escapeXmlAttribute(attachment.absolutePath)}" project_path="${escapeXmlAttribute(attachment.relativePath)}" size_bytes="${attachment.size}" display_name="${escapeXmlAttribute(attachment.displayName)}" />`
  ))

  return [
    "<memosync-attachments>",
    ...lines,
    "</memosync-attachments>",
  ].join("\n")
}

export function buildPromptText(content: string, attachments: ChatAttachment[]) {
  const attachmentHint = buildAttachmentHintText(attachments)
  if (!attachmentHint) {
    return content.trim()
  }

  const trimmed = content.trim()
  return [
    trimmed || "Please inspect the attached files.",
    attachmentHint,
  ].join("\n\n").trim()
}

function discardedToolResult(
  tool: NormalizedToolCall & { toolKind: "ask_user_question" | "exit_plan_mode" }
) {
  if (tool.toolKind === "ask_user_question") {
    return {
      discarded: true,
      answers: {},
    }
  }

  return {
    discarded: true,
  }
}

export function normalizeClaudeUsageSnapshot(
  value: unknown,
  maxTokens?: number,
): ContextWindowUsageSnapshot | null {
  const usage = asRecord(value)
  if (!usage) return null

  const directInputTokens = asNumber(usage.input_tokens) ?? asNumber(usage.inputTokens) ?? 0
  const cacheCreationInputTokens =
    asNumber(usage.cache_creation_input_tokens) ?? asNumber(usage.cacheCreationInputTokens) ?? 0
  const cacheReadInputTokens =
    asNumber(usage.cache_read_input_tokens) ?? asNumber(usage.cacheReadInputTokens) ?? 0
  const outputTokens = asNumber(usage.output_tokens) ?? asNumber(usage.outputTokens) ?? 0
  const reasoningOutputTokens =
    asNumber(usage.reasoning_output_tokens) ?? asNumber(usage.reasoningOutputTokens)
  const toolUses = asNumber(usage.tool_uses) ?? asNumber(usage.toolUses)
  const durationMs = asNumber(usage.duration_ms) ?? asNumber(usage.durationMs)

  const inputTokens = directInputTokens + cacheCreationInputTokens + cacheReadInputTokens
  const usedTokens = inputTokens + outputTokens
  if (usedTokens <= 0) {
    return null
  }

  return {
    usedTokens,
    inputTokens,
    ...(cacheReadInputTokens > 0 ? { cachedInputTokens: cacheReadInputTokens } : {}),
    ...(outputTokens > 0 ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    lastUsedTokens: usedTokens,
    lastInputTokens: inputTokens,
    ...(cacheReadInputTokens > 0 ? { lastCachedInputTokens: cacheReadInputTokens } : {}),
    ...(outputTokens > 0 ? { lastOutputTokens: outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { lastReasoningOutputTokens: reasoningOutputTokens } : {}),
    ...(toolUses !== undefined ? { toolUses } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(typeof maxTokens === "number" && maxTokens > 0 ? { maxTokens } : {}),
    // Auto-compact is enabled in this deployment (the study-era kill switch
    // is gone), so the context meter should say so up front.
    compactsAutomatically: true,
  }
}

/**
 * SDK assistant events keep the usage for the current API request under
 * `message.usage`. The top-level `usage` seen on result events is accumulated
 * across every request in a tool-heavy turn and must not drive the context
 * meter.
 */
export function normalizeClaudeAssistantUsageSnapshot(
  message: unknown,
  maxTokens?: number,
): ContextWindowUsageSnapshot | null {
  const record = asRecord(message)
  const nestedMessage = asRecord(record?.message)
  return normalizeClaudeUsageSnapshot(nestedMessage?.usage ?? record?.usage, maxTokens)
}

export function maxClaudeContextWindowFromModelUsage(modelUsage: unknown): number | undefined {
  const record = asRecord(modelUsage)
  if (!record) return undefined

  let maxContextWindow: number | undefined
  for (const value of Object.values(record)) {
    const usage = asRecord(value)
    const contextWindow = asNumber(usage?.contextWindow) ?? asNumber(usage?.context_window)
    if (contextWindow === undefined) continue
    maxContextWindow = Math.max(maxContextWindow ?? 0, contextWindow)
  }
  return maxContextWindow
}

function getClaudeAssistantMessageUsageId(message: any): string | null {
  if (typeof message?.message?.id === "string" && message.message.id) {
    return message.message.id
  }
  if (typeof message?.uuid === "string" && message.uuid) {
    return message.uuid
  }
  return null
}

export function normalizeClaudeStreamMessage(message: any): TranscriptEntry[] {
  const debugRaw = JSON.stringify(message)
  const messageId = typeof message.uuid === "string" ? message.uuid : undefined

  if (message.type === "system" && message.subtype === "init") {
    return [
      timestamped({
        kind: "system_init",
        messageId,
        provider: "claude",
        model: typeof message.model === "string" ? message.model : "unknown",
        tools: Array.isArray(message.tools) ? message.tools : [],
        agents: Array.isArray(message.agents) ? message.agents : [],
        slashCommands: Array.isArray(message.slash_commands)
          ? message.slash_commands.filter((entry: string) => !entry.startsWith("._"))
          : [],
        mcpServers: Array.isArray(message.mcp_servers) ? message.mcp_servers : [],
        debugRaw,
      }),
    ]
  }

  if (message.type === "assistant" && Array.isArray(message.message?.content)) {
    const entries: TranscriptEntry[] = []
    for (const content of message.message.content) {
      if (content.type === "text" && typeof content.text === "string") {
        entries.push(timestamped({
          kind: "assistant_text",
          messageId,
          text: content.text,
          debugRaw,
        }))
      }
      if (content.type === "tool_use" && typeof content.name === "string" && typeof content.id === "string") {
        entries.push(timestamped({
          kind: "tool_call",
          messageId,
          tool: normalizeToolCall({
            toolName: content.name,
            toolId: content.id,
            input: (content.input ?? {}) as Record<string, unknown>,
          }),
          debugRaw,
        }))
      }
    }
    return entries
  }

  if (message.type === "user" && Array.isArray(message.message?.content)) {
    const entries: TranscriptEntry[] = []
    for (const content of message.message.content) {
      if (content.type === "tool_result" && typeof content.tool_use_id === "string") {
        entries.push(timestamped({
          kind: "tool_result",
          messageId,
          toolId: content.tool_use_id,
          content: content.content,
          isError: Boolean(content.is_error),
          debugRaw,
        }))
      }
      if (message.message.role === "user" && typeof message.message.content === "string") {
        entries.push(timestamped({
          kind: "compact_summary",
          messageId,
          summary: message.message.content,
          debugRaw,
        }))
      }
    }
    return entries
  }

  if (message.type === "result") {
    if (message.subtype === "cancelled") {
      return [timestamped({ kind: "interrupted", messageId, debugRaw })]
    }
    return [
      timestamped({
        kind: "result",
        messageId,
        subtype: message.is_error ? "error" : "success",
        isError: Boolean(message.is_error),
        durationMs: typeof message.duration_ms === "number" ? message.duration_ms : 0,
        result: typeof message.result === "string" ? message.result : stringFromUnknown(message.result),
        costUsd: typeof message.total_cost_usd === "number" ? message.total_cost_usd : undefined,
        debugRaw,
      }),
    ]
  }

  if (message.type === "system" && message.subtype === "status" && typeof message.status === "string") {
    return [timestamped({ kind: "status", messageId, status: message.status, debugRaw })]
  }

  if (message.type === "system" && message.subtype === "compact_boundary") {
    return [timestamped({ kind: "compact_boundary", messageId, debugRaw })]
  }

  if (message.type === "system" && message.subtype === "context_cleared") {
    return [timestamped({ kind: "context_cleared", messageId, debugRaw })]
  }

  if (
    message.type === "user" &&
    message.message?.role === "user" &&
    typeof message.message.content === "string" &&
    message.message.content.startsWith("This session is being continued")
  ) {
    return [timestamped({ kind: "compact_summary", messageId, summary: message.message.content, debugRaw })]
  }

  return []
}

export async function* createClaudeHarnessStream(
  q: Query,
  onTurnOriginChange?: (origin: HarnessEvent["origin"]) => void,
  onToolOrigin?: (toolUseId: string, origin: HarnessEvent["origin"]) => void,
  outboundOrigins?: ClaudeOutboundOriginTracker,
): AsyncGenerator<HarnessEvent> {
  let seenAssistantUsageIds = new Set<string>()
  let latestUsageSnapshot: ContextWindowUsageSnapshot | null = null
  let lastKnownContextWindow: number | undefined
  const seenToolOriginIds = new Set<string>()
  const registerToolOrigin = (toolUseId: string, origin: HarnessEvent["origin"]) => {
    if (seenToolOriginIds.has(toolUseId)) return
    seenToolOriginIds.add(toolUseId)
    onToolOrigin?.(toolUseId, origin)
  }
  // Message id of the assistant reply currently streaming (partial events).
  let streamingAssistantMessageId = ""
  // Claude's SDK annotates queued user messages and result messages with an
  // origin, but assistant/partial messages in between do not carry it. Track
  // both the root turn and each parent tool lineage: nested channel/task
  // continuations may interleave with a human root and must never inherit its
  // authority merely because their assistant frame omits origin.
  let rootOrigin: HarnessEvent["origin"] = outboundOrigins?.current() ?? "unknown"
  const lineageOrigins = new Map<string, HarnessEvent["origin"]>()

  for await (const sdkMessage of q as AsyncIterable<any>) {
    const explicitOrigin = (() => {
      const kind = sdkMessage?.origin?.kind
      return kind === "human"
        || kind === "task-notification"
        || kind === "auto-continuation"
        || kind === "channel"
        || kind === "peer"
        || kind === "coordinator"
        ? kind
        : undefined
    })()
    const parentToolUseId = typeof sdkMessage?.parent_tool_use_id === "string"
      ? sdkMessage.parent_tool_use_id
      : null
    const startsQueuedTurn = sdkMessage?.type === "user"
      && sdkMessage?.message?.role === "user"
      && !parentToolUseId
    const isToolResult = sdkMessage?.tool_use_result !== undefined
      || (Array.isArray(sdkMessage?.message?.content)
        && sdkMessage.message.content.some((item: unknown) => (
          Boolean(item && typeof item === "object" && (item as { type?: unknown }).type === "tool_result")
        )))
    if (startsQueuedTurn && !isToolResult) {
      const internalOriginlessFrame = explicitOrigin === undefined && (
        sdkMessage?.isSynthetic === true
        || sdkMessage?.isReplay === true
        || sdkMessage?.shouldQuery === false
      )
      rootOrigin = explicitOrigin
        ?? (internalOriginlessFrame ? "unknown" : outboundOrigins?.current())
        ?? "human"
      outboundOrigins?.observeRoot(rootOrigin)
      onTurnOriginChange?.(rootOrigin)
    }
    if (explicitOrigin !== undefined && parentToolUseId) {
      lineageOrigins.set(parentToolUseId, explicitOrigin)
    }
    const toolResultOrigin = (() => {
      if (!isToolResult) return undefined
      if (!Array.isArray(sdkMessage?.message?.content)) return "unknown"
      let inheritedOrigin: HarnessEvent["origin"]
      let sawToolResult = false
      for (const item of sdkMessage.message.content) {
        if (item?.type !== "tool_result") continue
        sawToolResult = true
        if (typeof item.tool_use_id !== "string") return "unknown"
        const inherited = lineageOrigins.get(item.tool_use_id)
        // A missing id, or a batched frame that joins different lineages,
        // must not borrow the currently active participant root.
        if (inherited === undefined) return "unknown"
        if (inheritedOrigin !== undefined && inheritedOrigin !== inherited) return "unknown"
        inheritedOrigin = inherited
      }
      return sawToolResult ? inheritedOrigin ?? "unknown" : "unknown"
    })()
    if (startsQueuedTurn && isToolResult) {
      // Top-level SDK tool-result frames often omit both origin and parent.
      // Their tool-use ids are then the only safe lineage for the assistant
      // continuation that follows, so make that lineage the current root.
      const continuedOrigin = explicitOrigin ?? toolResultOrigin ?? "unknown"
      const changed = rootOrigin !== continuedOrigin
      rootOrigin = continuedOrigin
      outboundOrigins?.observeRoot(rootOrigin)
      if (changed) onTurnOriginChange?.(rootOrigin)
    }
    if (rootOrigin === "unknown" && outboundOrigins?.current() !== "unknown") {
      rootOrigin = outboundOrigins?.current() ?? "unknown"
    }
    const nestedOrigin = parentToolUseId
      ? lineageOrigins.get(parentToolUseId) ?? "unknown"
      : undefined
    const inheritedOrigin = nestedOrigin !== undefined && toolResultOrigin !== undefined
      ? (nestedOrigin === toolResultOrigin ? nestedOrigin : "unknown")
      : nestedOrigin ?? toolResultOrigin
    const origin = explicitOrigin ?? inheritedOrigin ?? rootOrigin

    // Register provenance before yielding even a session_token. Persisting
    // that token can await storage while the SDK is already asking canUseTool.
    if (sdkMessage?.type === "stream_event") {
      const block = sdkMessage.event?.type === "content_block_start"
        ? sdkMessage.event.content_block
        : null
      if (block?.type === "tool_use" && typeof block.id === "string") {
        lineageOrigins.set(block.id, origin)
        registerToolOrigin(block.id, origin)
      }
    }
    if (sdkMessage?.type === "assistant") {
      for (const content of Array.isArray(sdkMessage.message?.content) ? sdkMessage.message.content : []) {
        if (content?.type === "tool_use" && typeof content.id === "string") {
          lineageOrigins.set(content.id, origin)
          registerToolOrigin(content.id, origin)
        }
      }
    }
    const sessionToken = typeof sdkMessage.session_id === "string" ? sdkMessage.session_id : null
    if (sessionToken) {
      yield { type: "session_token", sessionToken, origin }
    }

    // includePartialMessages: raw Anthropic stream events. Only the top-level
    // assistant reply previews as streaming text — subagent chatter
    // (parent_tool_use_id set) and thinking deltas stay invisible.
    if (sdkMessage?.type === "stream_event") {
      if (!parentToolUseId) {
        const event = sdkMessage.event
        if (event?.type === "message_start" && typeof event.message?.id === "string") {
          streamingAssistantMessageId = event.message.id
        } else if (
          event?.type === "content_block_delta"
          && event.delta?.type === "text_delta"
          && typeof event.delta.text === "string"
          && event.delta.text
        ) {
          yield { type: "assistant_delta", itemId: streamingAssistantMessageId, delta: event.delta.text, origin }
        }
      }
      continue
    }

    if (sdkMessage?.type === "assistant") {
      const usageId = getClaudeAssistantMessageUsageId(sdkMessage)
      const usageSnapshot = normalizeClaudeAssistantUsageSnapshot(sdkMessage, lastKnownContextWindow)
      if (usageId && usageSnapshot && !seenAssistantUsageIds.has(usageId)) {
        seenAssistantUsageIds.add(usageId)
        latestUsageSnapshot = usageSnapshot
        yield {
          type: "transcript",
          origin,
          entry: timestamped({
            kind: "context_window_updated",
            usage: usageSnapshot,
          }),
        }
      }
    }

    if (sdkMessage?.type === "result") {
      const resultContextWindow = maxClaudeContextWindowFromModelUsage(sdkMessage.modelUsage)
      if (resultContextWindow !== undefined) {
        lastKnownContextWindow = resultContextWindow
      }

      const accumulatedUsage = normalizeClaudeUsageSnapshot(
        sdkMessage.usage,
        resultContextWindow ?? lastKnownContextWindow,
      )
      const finalUsage = latestUsageSnapshot
        ? {
            ...latestUsageSnapshot,
            ...(typeof (resultContextWindow ?? lastKnownContextWindow) === "number"
              ? { maxTokens: resultContextWindow ?? lastKnownContextWindow }
              : {}),
            ...(accumulatedUsage && accumulatedUsage.usedTokens > latestUsageSnapshot.usedTokens
              ? { totalProcessedTokens: accumulatedUsage.usedTokens }
              : {}),
          }
        : accumulatedUsage

      if (finalUsage) {
        yield {
          type: "transcript",
          origin,
          entry: timestamped({
            kind: "context_window_updated",
            usage: finalUsage,
          }),
        }
      }

      seenAssistantUsageIds = new Set<string>()
      latestUsageSnapshot = null
    }

    for (const entry of normalizeClaudeStreamMessage(sdkMessage)) {
      yield { type: "transcript", entry, origin }
    }
    if (sdkMessage?.type === "result") {
      rootOrigin = "unknown"
      outboundOrigins?.finishResult(origin)
      rootOrigin = outboundOrigins?.current() ?? "unknown"
      // Results from background and participant roots may interleave. Retire
      // only the lineage that actually completed: clearing the whole table on
      // a task result would erase a still-live participant parent, while
      // retaining a completed human lineage would authorize its late child.
      for (const [toolUseId, lineageOrigin] of lineageOrigins) {
        if (lineageOrigin !== origin) continue
        lineageOrigins.delete(toolUseId)
        // Keep deduplication for other still-live roots too. Otherwise an
        // unrelated result between a partial tool_use and its final assistant
        // frame can re-register the same id after canUseTool already consumed
        // it, leaving stale authority cached in the resolver.
        seenToolOriginIds.delete(toolUseId)
      }
      onTurnOriginChange?.(undefined)
    }
  }
}

export class ClaudeToolOriginResolver {
  private readonly origins = new Map<string, HarnessEvent["origin"]>()
  private readonly waiters = new Map<string, (origin: HarnessEvent["origin"]) => void>()
  private closed = false

  register(toolUseId: string, origin: HarnessEvent["origin"]) {
    if (this.closed) return
    const waiter = this.waiters.get(toolUseId)
    if (waiter) {
      this.waiters.delete(toolUseId)
      waiter(origin)
      return
    }
    this.origins.set(toolUseId, origin)
  }

  async take(toolUseId: string, signal: AbortSignal, timeoutMs = 5_000): Promise<HarnessEvent["origin"]> {
    if (this.closed) return undefined
    if (this.origins.has(toolUseId)) {
      const origin = this.origins.get(toolUseId)
      this.origins.delete(toolUseId)
      return origin
    }
    if (signal.aborted) return undefined

    return await new Promise((resolveOrigin) => {
      let settled = false
      const settle = (origin: HarnessEvent["origin"]) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener("abort", onAbort)
        if (this.waiters.get(toolUseId) === settle) this.waiters.delete(toolUseId)
        resolveOrigin(origin)
      }
      const onAbort = () => settle(undefined)
      const timer = setTimeout(() => settle(undefined), timeoutMs)
      this.waiters.set(toolUseId, settle)
      signal.addEventListener("abort", onAbort, { once: true })
    })
  }

  clear() {
    this.closed = true
    this.origins.clear()
    for (const settle of [...this.waiters.values()]) settle(undefined)
    this.waiters.clear()
  }
}

/**
 * Outbound participant prompts are authoritative even when Claude Code does
 * not echo their SDKUserMessage. A nonhuman continuation may finish first;
 * pending human turns remain reserved and resume as the root fallback.
 */
export class ClaudeOutboundOriginTracker {
  /** Ordered provider prompt ids. Negative ids are anonymous direct-test/
   * compatibility reservations; production Claude prompts use their exact
   * positive coordinator FIFO sequence. */
  private readonly pendingHumanTurns: number[] = []
  private nextAnonymousReservation = 0
  private root: HarnessEvent["origin"] = "unknown"

  beginHumanTurn(promptSeq?: number) {
    const reservation = promptSeq ?? -(this.nextAnonymousReservation += 1)
    if (this.pendingHumanTurns.includes(reservation)) {
      throw new Error(`Duplicate Claude human-turn reservation: ${reservation}`)
    }
    this.pendingHumanTurns.push(reservation)
    if (this.root === "unknown") this.root = "human"
  }

  cancelHumanTurn(promptSeq?: number) {
    const index = promptSeq === undefined
      ? this.pendingHumanTurns.length - 1
      : this.pendingHumanTurns.indexOf(promptSeq)
    if (index >= 0) this.pendingHumanTurns.splice(index, 1)
    if (this.pendingHumanTurns.length === 0 && this.root === "human") this.root = "unknown"
  }

  /**
   * A later `system_init` proves that these older FIFO prompts can no longer
   * emit a result. Release their exact provenance reservations without
   * touching the current participant turn or any non-human lineage.
   */
  discardHumanTurnReservations(promptSeqs: readonly number[]): number {
    const discarded = new Set(promptSeqs)
    const before = this.pendingHumanTurns.length
    for (let index = this.pendingHumanTurns.length - 1; index >= 0; index -= 1) {
      if (discarded.has(this.pendingHumanTurns[index]!)) this.pendingHumanTurns.splice(index, 1)
    }
    if (this.pendingHumanTurns.length === 0 && this.root === "human") this.root = "unknown"
    return before - this.pendingHumanTurns.length
  }

  observeRoot(origin: HarnessEvent["origin"]) {
    this.root = origin ?? "unknown"
  }

  finishResult(origin: HarnessEvent["origin"]) {
    if (origin === "human") this.pendingHumanTurns.shift()
    this.root = this.pendingHumanTurns.length > 0 ? "human" : "unknown"
  }

  current(): HarnessEvent["origin"] {
    return this.root
  }

  clear() {
    this.pendingHumanTurns.splice(0, this.pendingHumanTurns.length)
    this.root = "unknown"
  }
}

export function isStudyToolOriginAllowed(origin: HarnessEvent["origin"]) {
  return origin === "human"
}

export function isStudyBackgroundToolRequest(toolName: string, input: Record<string, unknown>) {
  if (input.run_in_background === true || input.background === true) return true
  if (toolName !== "Bash") return false
  const command = typeof input.command === "string" ? input.command : ""
  return /\b(?:nohup|setsid|disown)\b/i.test(command)
    || /(?<![>&])&(?!&)\s*(?:$|[;\n])/m.test(command)
}

/** Study previews are owned by the server supervisor, never by Claude Bash. */
export function isStudyPreviewLifecycleCommand(command: string): boolean {
  const normalized = command.toLowerCase()
  return [
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start(?::dev)?)\b/,
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b/,
    /\b(?:run\s+dev|run\s+start:dev|npx\s+next\s+dev|bunx\s+next\s+dev)\b/,
    /\b(?:next|nest)\s+(?:dev|start|build)\b/,
    /\b(?:nohup|setsid|disown)\b/,
    /\b(?:pkill|killall|kill)\b/,
    /\bfuser\b[^\n]*\s-k\b/,
  ].some((pattern) => pattern.test(normalized))
}

class AsyncMessageQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = []
  private closed = false

  push(value: T) {
    if (this.closed) {
      throw new Error("Cannot push to a closed queue")
    }

    const waiter = this.waiters.shift()
    if (waiter) {
      waiter({ done: false, value })
      return
    }

    this.values.push(value)
  }

  close() {
    if (this.closed) return
    this.closed = true
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()
      waiter?.({ done: true, value: undefined as never })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        if (this.values.length > 0) {
          return { done: false, value: this.values.shift() as T }
        }

        if (this.closed) {
          return { done: true, value: undefined as never }
        }

        return await new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve)
        })
      },
    }
  }
}

/**
 * Per-turn nudge (REDESIGN D3): keeps the propose_memory channel salient
 * without forcing extraction — the forced hook remains the floor. A stable
 * string, so it costs the same few tokens on every turn and nothing more.
 */
const CAPTURE_NUDGE =
  "If this exchange surfaced durable knowledge (a preference, constraint, lesson, or fact worth keeping across sessions), call propose_memory. If the user explicitly asked you to remember something, always propose it."

/**
 * Per-turn citing reminder: the [M-NN] rule lives once in the boot system
 * prompt (D1) and models drift off it deep into long agentic turns — observed
 * as whole turns with zero inline citations. A stable one-liner in the same
 * reminder envelope keeps the rule salient at constant token cost.
 */
const CITE_NUDGE =
  "When a saved memory shapes what you do or say this turn, cite it inline as [M-NN] at the point of influence — an uncited influence is invisible to the user."

/**
 * Tool-salience reminder, included only when the working set actually has
 * [+detail] items. DeepSeek drifts off boot-prompt tool guidance in long
 * turns; a stable one-liner at the point of action keeps load_memory_detail
 * in reach (user decision 2026-08-05: strengthen tool recall via per-turn
 * blocks rather than injecting every detail wholesale).
 */
const DETAIL_NUDGE =
  "Some active memories are marked [+detail]: their one-line form is a headline, not the full rule. Call load_memory_detail on any [+detail] memory that touches this task BEFORE acting on it."

export async function startClaudeSession(args: {
  localPath: string
  model: string
  effort?: string
  planMode: boolean
  sessionToken: string | null
  forkSession: boolean
  onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
  memory?: MemoryService | null
  /** Routing gate for agent-proposed memories; enables the propose_memory tool. */
  capture?: CaptureService | null
  projectId?: string
  chatId?: string
  /** Study-arm policy; decides injection shape + tool registration (default memosync). */
  policy?: ConditionPolicy
  /** Exact environment inherited by Claude Code and its Bash/tool children. */
  subprocessEnv?: Record<string, string | undefined>
  /** Precomputed once by the coordinator; tests/direct callers may omit it. */
  memoryPlan?: MemoryInjectionPlan | null
  /** Per-turn injection override from an edited preview gate. */
  restrictMemoryIds?: string[]
  /** Fires when the session agent's propose_memory lands candidates — the
   * coordinator appends the transcript review card. */
  onMemoryProposal?: (created: MemoryItem[]) => void
  /** Same server-owned preview diagnostics in every formal study condition. */
  studyPreviewRuntime?: StudyAgentPreviewRuntime | null
}): Promise<ClaudeSessionHandle> {
  // MemoSync memory: what gets injected (and whether the mcp__memory__* tools
  // exist) is the study arm's call — planMemoryInjection is the single source
  // of truth shared with the coordinator's rebuild check. The session is
  // persistent (reused across turns); skills-mode content changes ride per-turn
  // deltas, so this boot block is set once and survives edits (REDESIGN D1).
  const policy = args.policy ?? resolveConditionPolicy()
  const toolOriginResolver = new ClaudeToolOriginResolver()
  const outboundOrigins = new ClaudeOutboundOriginTracker()
  const plan: MemoryInjectionPlan | null = args.memoryPlan !== undefined
    ? args.memoryPlan
    : args.memory
      ? planMemoryInjection({
        policy,
        provider: "claude",
        memory: args.memory,
        projectId: args.projectId,
        chatId: args.chatId,
        workspaceDir: args.localPath,
        restrictToIds: args.restrictMemoryIds,
      })
      : null
  let activeMemoryToolTurn: number | undefined
  let activeMemoryToolEngine: string | undefined
  // Claude sessions persist across user turns, as does their in-process MCP
  // server. Use getters so every tool call reads the context installed just
  // before the corresponding prompt is queued, rather than the boot turn.
  const memoryToolContext: MemoryToolContext = {
    projectId: args.projectId,
    sessionId: args.chatId,
    get turn() {
      return activeMemoryToolTurn
    },
    get engine() {
      return activeMemoryToolEngine
    },
  }
  const memorySpecs =
    args.memory && plan?.registerTools
      ? buildMemoryToolSpecs(args.memory, {
          capture: args.capture,
          pendingCandidateTiming: 'next_turn',
          onProposed: args.onMemoryProposal,
        })
      : []
  const memoryBlock = plan?.block ?? ""
  // Environment guidance appended to the system prompt in EVERY arm (it names
  // no memory system, so it is blinding-safe): the agent otherwise has no way
  // to know that a dev server it starts becomes visible to the user, or how.
  const systemAppend = buildClaudeSystemAppend(memoryBlock)
  const canUseTool: CanUseTool = async (toolName, input, options) => {
    if (policy.studyMode) {
      const toolOrigin = await toolOriginResolver.take(options.toolUseID, options.signal)
      if (!isStudyToolOriginAllowed(toolOrigin)) {
        return {
          behavior: "deny",
          message: toolOrigin
            ? `SDK ${toolOrigin} continuations cannot use tools in a participant study session.`
            : "Tool provenance was unavailable; study tools fail closed.",
        }
      }
      if (isStudyBackgroundToolRequest(toolName, input)) {
        return {
          behavior: "deny",
          message: "Background processes are disabled in study tasks. Use foreground tests, lint, and type-check commands; the study server owns the preview and its build artifacts.",
        }
      }
    }
    if (policy.studyMode && toolName === "KillShell") {
      return {
        behavior: "deny",
        message: "The study server owns preview process lifecycle; KillShell is unavailable in study tasks.",
      }
    }
    if (
      policy.studyMode
      && toolName === "Bash"
      && isStudyPreviewLifecycleCommand(typeof input?.command === "string" ? input.command : "")
    ) {
      return {
        behavior: "deny",
        message: "The study server owns the preview on fixed ports 3000 and 3001. Edit the project and use the managed hot reload; do not start, stop, or replace preview processes.",
      }
    }
    if (toolName !== "AskUserQuestion" && toolName !== "ExitPlanMode") {
      return {
        behavior: "allow",
        updatedInput: input,
      }
    }

    const tool = normalizeToolCall({
      toolName,
      toolId: options.toolUseID,
      input: (input ?? {}) as Record<string, unknown>,
    })

    if (tool.toolKind !== "ask_user_question" && tool.toolKind !== "exit_plan_mode") {
      return {
        behavior: "deny",
        message: "Unsupported tool request",
      }
    }

    const result = await args.onToolRequest({ tool })

    if (tool.toolKind === "ask_user_question") {
      const record = result && typeof result === "object" ? result as Record<string, unknown> : {}
      return {
        behavior: "allow",
        updatedInput: {
          ...(tool.rawInput ?? {}),
          questions: record.questions ?? tool.input.questions,
          answers: record.answers ?? result,
        },
      } satisfies PermissionResult
    }

    const record = result && typeof result === "object" ? result as Record<string, unknown> : {}
    const confirmed = Boolean(record.confirmed)
    if (confirmed) {
      return {
        behavior: "allow",
        updatedInput: {
          ...(tool.rawInput ?? {}),
          ...record,
        },
      } satisfies PermissionResult
    }

    return {
      behavior: "deny",
      message: typeof record.message === "string"
        ? `User wants to suggest edits to the plan: ${record.message}`
        : "User wants to suggest edits to the plan before approving.",
    } satisfies PermissionResult
  }

  const promptQueue = new AsyncMessageQueue<SDKUserMessage>()

  const baseSubprocessEnv = args.subprocessEnv ?? buildClaudeSubprocessEnv({
    localPath: args.localPath,
    rawStudyProjects: policy.studyMode ? process.env.STUDY_PROJECTS : undefined,
  })
  const sdkRuntime = buildClaudeSdkRuntimeOptions({
    requestedModel: args.model,
    configuredModel: baseSubprocessEnv.ANTHROPIC_MODEL,
    env: baseSubprocessEnv,
  })

  const q = query({
    prompt: promptQueue,
    options: {
      cwd: args.localPath,
      // The internal provider remains Claude Code. In formal DeepSeek study
      // sessions sdkRuntime adds the CLI-only [1m] selector; the CLI removes
      // it before calling the Anthropic-compatible endpoint.
      model: sdkRuntime.model,
      effort: args.effort as "low" | "medium" | "high" | "max" | undefined,
      resume: args.sessionToken ?? undefined,
      forkSession: args.forkSession,
      permissionMode: args.planMode ? "plan" : "acceptEdits",
      canUseTool,
      // Body text streams into ChatRuntime.streamingText as it is written —
      // without this the reply pops in whole at turn end (the DeepSeek
      // Anthropic-compatible endpoint streams SSE like the real one).
      includePartialMessages: true,
      tools: [...CLAUDE_TOOLSET],
      systemPrompt: systemAppend
        ? { type: "preset", preset: "claude_code", append: systemAppend }
        : undefined,
      mcpServers: memorySpecs.length || (policy.studyMode && args.studyPreviewRuntime)
        ? {
            ...(memorySpecs.length ? { memory: toClaudeMemoryMcpServer(memorySpecs, memoryToolContext) } : {}),
            ...(policy.studyMode && args.studyPreviewRuntime
              ? { preview: toClaudeStudyPreviewMcpServer(args.studyPreviewRuntime, args.localPath) }
              : {}),
          }
        : undefined,
      // Study mode narrows to user settings only: a workspace CLAUDE.md would
      // otherwise be a second, uncontrolled memory channel in every arm.
      settingSources: policy.studyMode ? ["user"] : ["user", "project", "local"],
      // MemoSync IS the memory system. The harness's own auto-memory
      // (~/.claude/projects/<cwd>/memory/) is a second, uncontrolled
      // read+write channel — observed live: the model wrote MEMORY.md there
      // on a "记住…" request. Flag-level settings outrank user settings.
      settings: sdkRuntime.settings,
      pathToClaudeCodeExecutable: process.env.CLAUDE_EXECUTABLE?.replace(/^~(?=\/|$)/, homedir()) || undefined,
      env: sdkRuntime.env,
    },
  })

  return {
    provider: "claude",
    stream: createClaudeHarnessStream(q, undefined, (toolUseId, origin) => {
      if (policy.studyMode) toolOriginResolver.register(toolUseId, origin)
    }, outboundOrigins),
    getAccountInfo: async () => {
      try {
        return await q.accountInfo()
      } catch {
        return null
      }
    },
    interrupt: async () => {
      await q.interrupt()
    },
    sendPrompt: async (
      content: string,
      context?: Pick<MemoryToolContext, "turn" | "engine"> & { promptSeq?: number },
    ) => {
      activeMemoryToolTurn = context?.turn
      activeMemoryToolEngine = context?.engine
      outboundOrigins.beginHumanTurn(context?.promptSeq)
      try {
        promptQueue.push({
          type: "user",
          message: {
            role: "user",
            content,
          },
          parent_tool_use_id: null,
          session_id: args.sessionToken ?? "",
        })
      } catch (error) {
        outboundOrigins.cancelHumanTurn(context?.promptSeq)
        throw error
      }
    },
    discardHumanTurnReservations: (promptSeqs) => (
      outboundOrigins.discardHumanTurnReservations(promptSeqs)
    ),
    setModel: async (model: string) => {
      await q.setModel(buildClaudeSdkRuntimeOptions({
        requestedModel: model,
        configuredModel: baseSubprocessEnv.ANTHROPIC_MODEL,
        env: baseSubprocessEnv,
      }).model)
    },
    setPermissionMode: async (planMode: boolean) => {
      await q.setPermissionMode(planMode ? "plan" : "acceptEdits")
    },
    supportedModels: async () => await q.supportedModels(),
    memoryPlan: plan,
    close: () => {
      toolOriginResolver.clear()
      outboundOrigins.clear()
      promptQueue.close()
      q.close()
    },
  }
}

interface PreviewControlOperation {
  operationId: string
  taskId: string
  sessionId: string
  chatId: string
  surface: "working_memory"
  action: MemoryPreviewDecision
  controlType: "working_memory"
  payload: { previewId: string; requestedIds: string[]; effectiveIds: string[] }
}

interface PendingMemoryPreview {
  previewId: string
  revision: number
  published: boolean
  /** Server-held Working Memory pool for this exact preview revision. */
  memoryIds: string[]
  /** Server-owned task and memory snapshots used to plan this revision. */
  task: string
  memories: MemoryItem[]
  /** Expected-use text is generated server-side and scoped to this revision. */
  expectedUseById: Map<string, string>
  proposalsId?: string
  transferId?: string
  checkupId?: string
  respond: (
    d: MemoryPreviewDecision,
    memoryIds?: string[],
    expectedUses?: ExpectedMemoryUse[],
    controlOperation?: PreviewControlOperation,
  ) => void
  reopen?: (from: "proposals" | "checkup" | "transfer", stageId: string) => void
}

type TransferGateDecision = "handled" | "skipped" | "cancelled"
type CheckupGateDecision = TransferGateDecision | "reopen_proposals" | "reopen_transfer"
type InternalGateWake<T extends string> = T | "invalidated"

export class AgentCoordinator {
  private readonly store: EventStore
  private readonly onStateChange: (chatId?: string, options?: { immediate?: boolean }) => void
  private readonly codexManager: CodexAppServerManager
  private readonly generateTitle: (messageContent: string, cwd: string) => Promise<GenerateChatTitleResult>
  private readonly startClaudeSessionFn: NonNullable<AgentCoordinatorArgs["startClaudeSession"]>
  private readonly memory: MemoryService | null
  private readonly capture: CaptureService | null
  private readonly memoryTrace: TraceService | null
  private readonly forkTraceFn: typeof runForkTrace
  private readonly forkCaptureFn: typeof runForkCapture
  private readonly forkQueryFn: typeof runForkQuery
  private readonly memoryRelevance: RelevanceService | null
  private readonly memoryUsePlan: UsePlanService | null
  /** Exact per-memory instructions shown in the preview and injected into Claude. */
  private readonly turnExpectedUses = new Map<string, ExpectedMemoryUse[]>()
  /** Pay-attention ids consumed from kv at preview publish, delivered to the boot reminder. */
  private readonly turnPayAttention = new Map<string, Array<{ id: string; quote?: string }>>()
  private readonly memoryRevision: RevisionService | null
  private readonly memoryPreview: boolean
  private readonly memoryCheckup: CheckupService | null
  private readonly memoryTransferDetect: TransferDetectService | null
  private readonly policy: ConditionPolicy
  private readonly getMemoryPreviewSettings: () => { enabled: boolean; autoProceedWhenEmpty: boolean }
  private readonly getActiveStudyTaskId: () => string | null
  private readonly studyPromptGate: StudyPromptGate | null
  private readonly onParticipantPromptRecorded: AgentCoordinatorArgs["onParticipantPromptRecorded"]
  private readonly openingBoardBacklog: MemoryBoardBacklogService | null
  private readonly studyMemoryStore: StudyMemoryStore | null
  private readonly staticMemoryExtractor: StaticMemoryExtractor | null
  private readonly claudeSessionFileExists: (localPath: string, sessionToken: string) => boolean
  private readonly studyPreviewRuntime: StudyAgentPreviewRuntime | null
  private readonly claudeRetireTimeoutMs: number
  private readonly studyTaskChats = new Map<string, Set<string>>()
  private readonly studyTaskProjectPaths = new Map<string, Set<string>>()
  private reportBackgroundError: ((message: string) => void) | null = null
  private readonly claimedPreviewControlOperationIds = new Set<string>()
  /** A response owns the parked preview from before its first await until its
   * decision has finished. This closes concurrent Start/without-memory races. */
  private readonly claimedPreviewResponses = new Map<string, string>()
  readonly activeTurns = new Map<string, ActiveTurn>()
  /**
   * Chats parked on a per-turn memory-preview decision (SPEC §4.10b).
   * `published` flips once the preview card is durably in the transcript —
   * until then the gate is claimable only by cancel (which unwinds it), never
   * by a respond, so a decision can never reference a card that failed to
   * append.
   */
  readonly pendingPreviews = new Map<string, PendingMemoryPreview>()
  /**
   * Chats parked on the step-one proposals gate (redesign 2026-08-07 §3):
   * this conversation's pending memory changes must be reviewed (or
   * explicitly skipped) before anything else happens this turn. Same
   * `published` discipline as pendingPreviews.
   */
  readonly pendingProposalGates = new Map<
    string,
    { proposalsId: string; published: boolean; respond: (d: "reviewed" | "skipped" | "cancelled") => void }
  >()
  /** Chats parked on the step-one checkup gate (container 2) — same discipline. */
  readonly pendingCheckupGates = new Map<
    string,
    {
      checkupId: string
      proposalsId?: string
      transferId?: string
      published: boolean
      respond: (d: CheckupGateDecision) => void
      invalidate: () => void
    }
  >()
  /** Chats parked on the Transfer card (between Step 1 and Step 2) — same discipline. */
  readonly pendingTransferGates = new Map<
    string,
    { transferId: string; published: boolean; respond: (d: TransferGateDecision) => void; invalidate: () => void }
  >()
  /**
   * The turn's live parallel-phase context (Step 1 + Transfer). Lets a
   * settled Step 1 REOPEN while the Transfer stage is still open — the
   * repark runs beside the transfer gate and the caller awaits it before
   * moving to the checkup.
   */
  private readonly activePreparations = new Map<
    string,
    {
      args: StartTurnArgs
      ctx: { project: NonNullable<ReturnType<EventStore["getProject"]>>; turnNumber: number }
      proposalsId?: string
      reparks: Array<Promise<"reviewed" | "skipped" | "cancelled">>
      reopened: boolean
      cancellation: MemoryPreparationCancellation
    }
  >()
  /** Step 2's model checks may still be running when the user returns to Step 1. */
  private readonly inFlightCheckups = new Map<
    string,
    { checkupId: string; proposalsId?: string; transferId?: string; reopenProposalsRequested: boolean; reopenTransferRequested: boolean }
  >()
  /**
   * Per-turn memory selection from an EDITED preview gate (chatId → ids).
   * Every plan computation for the chat consults it so boot, trace snapshot,
   * and rebuild check can't disagree; cleared when the next turn starts.
   */
  private readonly turnMemoryRestriction = new Map<string, string[]>()
  /**
   * Chats whose turn is being STARTED — reserved synchronously so the async
   * window before activeTurns/pendingPreviews is set can't let a second
   * concurrent send launch a duplicate turn.
   */
  // Chats reserved between send() and the engine boot, with the phase the
  // reservation is in — getActiveStatuses folds this in so the pre-park
  // window doesn't read as "idle" to a freshly (re)subscribed client.
  private readonly startingChats = new Map<string, ChatActivityStatus>()
  // Chats where the user hit Stop while the preview gate was still being set
  // up (before pendingPreviews exists). The detached runPreviewGateThenBoot
  // observes this and unwinds instead of parking a gate / booting (BUG AGENT-2).
  private readonly cancelledDuringPreview = new Set<string>()
  readonly drainingStreams = new Map<string, { turn: HarnessTurn }>()
  readonly claudeSessions = new Map<string, ClaudeSessionState>()
  /**
   * Claude result delivery makes the chat look idle before capture/trace have
   * settled. Study freeze waits on these task-scoped promises; unrelated
   * checkup work and Transfer source-rule preparation deliberately continue
   * in the background.
   */
  private readonly inFlightStudyMemoryJobs = new Set<{
    taskId: string
    promise: Promise<StudyMemoryQualityFlag[]>
  }>()
  private readonly studyMemoryQualityByTask = new Map<string, StudyMemoryQualityFlag[]>()
  private readonly pendingStudyMemoryQualityClears = new Map<string, {
    taskId: string
    chatId: string
    turnId: string
    code: string
  }>()
  /** Static atomization is asynchronous, but identity/version application must
   * follow the durable Claude dispatch order within each workspace. */
  private readonly staticFocusJobsByInjection = new Map<string, Promise<StudyMemoryQualityFlag[]>>()
  private readonly staticFocusTailByNamespace = new Map<string, Promise<void>>()
  /**
   * Auto rows are project-local, but a completed turn's broad capture is a
   * causal dependency of every later turn in the active study project, across
   * its chats and sessions. The study serial gate activates only one project
   * at a time, so one process tail preserves that order without joining the
   * projects' memory identities or content.
   */
  private autoProjectCaptureTail: Promise<void> = Promise.resolve()
  private pendingAutoProjectCaptureJobs = 0
  /** Durable queued sends waiting for the ordered Auto capture tail. */
  private readonly pendingAutoCaptureStarts = new Map<string, PendingAutoCaptureStart>()
  /** One startup/retry owner per durable opening-Board claim. */
  private readonly openingBoardRecoveryTasks = new Set<string>()
  private readonly openingBoardRecoveryRetryAttempts = new Map<string, number>()
  private readonly openingBoardRecoveryRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /**
   * In-flight assistant text per chat, accumulated from assistant_delta harness
   * events (DeepSeek/codex agentMessage deltas). Broadcast via ChatRuntime.
   * streamingText only — never persisted; cleared the moment the final
   * assistant_text entry is appended so no snapshot carries both.
   */
  private readonly streamingAssistantTexts = new Map<string, { itemId: string; text: string }>()

  constructor(args: AgentCoordinatorArgs) {
    this.store = args.store
    this.onStateChange = args.onStateChange
    this.codexManager = args.codexManager ?? new CodexAppServerManager()
    this.generateTitle = args.generateTitle ?? generateTitleForChatDetailed
    this.startClaudeSessionFn = args.startClaudeSession ?? startClaudeSession
    this.memory = args.memory ?? null
    this.capture = args.capture ?? null
    this.memoryTrace = args.memoryTrace ?? null
    this.forkTraceFn = args.forkTrace ?? runForkTrace
    this.forkCaptureFn = args.forkCapture ?? runForkCapture
    this.forkQueryFn = args.forkQuery ?? runForkQuery
    this.memoryRelevance = args.memoryRelevance ?? null
    this.memoryUsePlan = args.memoryUsePlan ?? null
    this.memoryRevision = args.memoryRevision ?? null
    this.memoryPreview = args.memoryPreview ?? false
    this.memoryCheckup = args.memoryCheckup ?? null
    this.memoryTransferDetect = args.memoryTransferDetect ?? null
    this.policy = args.policy ?? resolveConditionPolicy()
    this.getMemoryPreviewSettings =
      args.getMemoryPreviewSettings ?? (() => ({ enabled: true, autoProceedWhenEmpty: true }))
    this.getActiveStudyTaskId = args.getActiveStudyTaskId ?? (() => null)
    this.studyPromptGate = args.studyPromptGate ?? null
    this.onParticipantPromptRecorded = args.onParticipantPromptRecorded
    this.openingBoardBacklog = args.openingBoardBacklog ?? null
    this.studyMemoryStore = args.studyMemoryStore ?? null
    this.staticMemoryExtractor = args.staticMemoryExtractor ?? null
    this.claudeSessionFileExists = args.claudeSessionFileExists ?? claudeSessionFileExists
    this.studyPreviewRuntime = args.studyPreviewRuntime ?? null
    this.claudeRetireTimeoutMs = args.claudeRetireTimeoutMs ?? 10_000
  }

  private hasPendingPreviewActivity(chatId: string) {
    return this.pendingPreviews.has(chatId) || this.claimedPreviewResponses.has(chatId)
  }

  /** Atomically transfer one exact parked preview to a response owner. */
  private claimPendingPreviewResponse(chatId: string, pending: PendingMemoryPreview) {
    if (this.claimedPreviewResponses.has(chatId)) return false
    if (this.pendingPreviews.get(chatId) !== pending) return false
    this.pendingPreviews.delete(chatId)
    this.claimedPreviewResponses.set(chatId, pending.previewId)
    return true
  }

  private restorePendingPreviewResponse(chatId: string, pending: PendingMemoryPreview) {
    if (this.claimedPreviewResponses.get(chatId) !== pending.previewId) return
    this.claimedPreviewResponses.delete(chatId)
    if (!this.pendingPreviews.has(chatId)) this.pendingPreviews.set(chatId, pending)
  }

  private releasePendingPreviewResponse(chatId: string, previewId: string) {
    if (this.claimedPreviewResponses.get(chatId) === previewId) {
      this.claimedPreviewResponses.delete(chatId)
    }
  }

  private deletePendingPreviewIfCurrent(chatId: string, pending: PendingMemoryPreview) {
    if (this.pendingPreviews.get(chatId) === pending) this.pendingPreviews.delete(chatId)
  }

  /** Resolve a pending per-turn memory preview with the user's decision. */
  async respondMemoryPreview(command: {
    chatId: string
    previewId: string
    decision: MemoryPreviewDecision
    memoryIds?: string[]
    expectedUses?: ExpectedMemoryUse[]
    operationId?: string
  }) {
    const suppliedOperationId = command.operationId?.trim()
    if (suppliedOperationId && this.claimedPreviewControlOperationIds.has(suppliedOperationId)) {
      throw new Error("This Working Memory Control operation was already recorded")
    }
    if (this.claimedPreviewResponses.get(command.chatId) === command.previewId) {
      throw new Error("This Working Memory preview is already being handled")
    }
    // Note: a respond is accepted even before `published` flips — the card a
    // user clicks is proof the append landed; only cancel() (Stop) can reach
    // a parked gate earlier, and it takes the unwind path instead.
    const pending = this.pendingPreviews.get(command.chatId)
    if (!pending || pending.previewId !== command.previewId) {
      // A parked gate does not survive a restart (pendingPreviews is memory
      // state), but the transcript still renders the card as pending — the
      // user's click must settle it instead of erroring into a stuck spinner.
      if (await this.expireOrphanedPreview(command.chatId, command.previewId)) return
      throw new Error("No matching pending memory preview")
    }
    const requestedIds = command.decision === "go_on"
      ? [...(command.memoryIds ?? pending.memoryIds)]
      : [...(command.memoryIds ?? [])]
    const taskId = this.getActiveStudyTaskId()
    const isFormalMemoSync = this.policy.studyMode && this.policy.condition === "memosync" && Boolean(taskId)
    let effectiveIds = [...requestedIds]
    if (isFormalMemoSync && command.decision === "go_on") {
      if (!this.memory) throw new Error("Memory service is unavailable")
      const chat = this.store.requireChat(command.chatId)
      const previewPool = new Set(pending.memoryIds)
      effectiveIds = normalizeMemorySelection({
        memory: this.memory,
        projectId: chat.projectId,
        chatId: command.chatId,
        selectedIds: requestedIds.filter((id) => previewPool.has(id)),
      })
    }
    if (command.decision !== "go_on") effectiveIds = []
    let controlOperation: PreviewControlOperation | undefined
    if (isFormalMemoSync && taskId) {
      const operationId = suppliedOperationId || `control:${taskId}:working-memory:${command.previewId}:${command.decision}`
      if (operationId.length > 200) throw new Error("operationId must be at most 200 characters")
      controlOperation = {
        operationId,
        taskId,
        sessionId: taskId,
        chatId: command.chatId,
        surface: "working_memory",
        action: command.decision,
        controlType: "working_memory",
        payload: { previewId: command.previewId, requestedIds, effectiveIds },
      }
    }

    // Claim and remove this exact map entry before expected-use planning (or
    // any other await). A second response sees the claim and cannot emit its
    // own attempted event, expire the winner's card, or dispatch Claude.
    if (!this.claimPendingPreviewResponse(command.chatId, pending)) {
      throw new Error("This Working Memory preview is already being handled")
    }

    let handedOff = false
    let attemptedRecorded = false
    try {
      if (controlOperation) {
        const attempted = this.memory?.logger.event({
          type: "study.control_operation",
          ...controlOperation,
          phase: "attempted",
        })
        if (
          attempted !== null
          && typeof attempted === "object"
          && "durableCreated" in attempted
          && attempted.durableCreated === false
        ) {
          throw new Error("This Working Memory Control operation was already recorded")
        }
        attemptedRecorded = true
        this.claimedPreviewControlOperationIds.add(controlOperation.operationId)
      }

      let authoritativeExpectedUses = command.expectedUses
      if (isFormalMemoSync) {
        authoritativeExpectedUses = command.decision === "go_on"
          ? await this.ensurePendingPreviewExpectedUses(pending, effectiveIds)
          : []
      }

      handedOff = true
      pending.respond(
        command.decision,
        command.decision === "go_on"
          ? isFormalMemoSync ? effectiveIds : command.memoryIds
          : undefined,
        authoritativeExpectedUses,
        controlOperation,
      )
    } catch (error) {
      if (!handedOff) this.restorePendingPreviewResponse(command.chatId, pending)
      if (attemptedRecorded && controlOperation) {
        try {
          this.memory?.logger.event({
            type: "study.control_operation",
            ...controlOperation,
            phase: "failed",
            errorClass: error instanceof Error ? error.constructor.name : typeof error,
          })
        } catch {
          // Preserve the server-authority failure as the caller-visible error.
        }
      }
      throw error
    }
  }

  /**
   * Plan the display copy for a live Working Memory preview without trusting
   * client task text, pool membership, or expected-use prose. The route uses
   * this seam for manual additions; Start calls the same planner again for
   * anything not already planned on this exact preview revision.
   */
  async planMemoryPreviewUses(input: {
    chatId: string
    previewId: string
    selectedIds: string[]
  }): Promise<ExpectedMemoryUse[]> {
    const pending = this.pendingPreviews.get(input.chatId)
    if (!pending?.published || pending.previewId !== input.previewId) {
      throw new Error("No matching pending memory preview")
    }
    if (!this.memory) throw new Error("Memory service is unavailable")
    const chat = this.store.requireChat(input.chatId)
    const previewPool = new Set(pending.memoryIds)
    const effectiveIds = normalizeMemorySelection({
      memory: this.memory,
      projectId: chat.projectId,
      chatId: input.chatId,
      selectedIds: input.selectedIds.filter((id) => previewPool.has(id)),
    })
    return await this.ensurePendingPreviewExpectedUses(pending, effectiveIds)
  }

  /** Return to Step 1 or Step 2 while the engine is still parked at preview. */
  async reopenMemoryPreparation(command: {
    chatId: string
    from: "proposals" | "checkup" | "transfer"
    stageId: string
  }) {
    const pending = this.pendingPreviews.get(command.chatId)
    if (pending?.published && pending.reopen) {
      const expectedId =
        command.from === "proposals"
          ? pending.proposalsId
          : command.from === "transfer"
            ? pending.transferId
            : pending.checkupId
      if (!expectedId || expectedId !== command.stageId) {
        throw new Error("This memory review is no longer the active version")
      }
      pending.reopen(command.from, command.stageId)
      return
    }

    // Step 1 and the Transfer card remain editable while Step 2 is computing
    // or waiting for its decision. The current checkup is discarded and
    // regenerated after the user settles the reopened stage again.
    if (command.from === "proposals") {
      const running = this.inFlightCheckups.get(command.chatId)
      if (running?.proposalsId === command.stageId) {
        running.reopenProposalsRequested = true
        return
      }
      const checkup = this.pendingCheckupGates.get(command.chatId)
      if (checkup?.published && checkup.proposalsId === command.stageId) {
        checkup.respond("reopen_proposals")
        return
      }
    }
    if (command.from === "transfer") {
      const running = this.inFlightCheckups.get(command.chatId)
      if (running?.transferId === command.stageId) {
        running.reopenTransferRequested = true
        return
      }
      const checkup = this.pendingCheckupGates.get(command.chatId)
      if (checkup?.published && checkup.transferId === command.stageId) {
        checkup.respond("reopen_transfer")
        return
      }
    }

    // Step 1 reopen while the TRANSFER stage is still open (searching or
    // parked): re-park Step 1 beside it — the turn's caller awaits the
    // repark before moving on, and recomputes downstream state.
    if (command.from === "proposals") {
      const prep = this.activePreparations.get(command.chatId)
      if (prep && prep.proposalsId === command.stageId && !this.pendingProposalGates.has(command.chatId)) {
        prep.reopened = true
        const repark = (async (): Promise<"reviewed" | "skipped" | "cancelled"> => {
          await this.store.appendMessage(
            command.chatId,
            timestamped({
              kind: "memory_preparation_reset",
              revision: prep.reparks.length + 1,
              from: "proposals",
              proposalsId: command.stageId,
            }),
          )
          this.emitStateChange(command.chatId, { immediate: true })
          return await this.parkExistingProposalsGate(prep.args, prep.ctx, command.stageId)
        })()
        prep.reparks.push(repark)
        return
      }
    }

    // Restart orphan (Codex handoff §6.1): the transcript still renders the
    // preparation cards as actionable, but every in-memory park died with the
    // server. Settle the whole preparation as expired — same discipline as
    // respondMemoryPreview — instead of a dead-end error.
    if (await this.expireOrphanedPreparation(command.chatId)) return

    throw new Error("Memory review can only be changed before the agent starts")
  }

  /**
   * Settle EVERY undecided preparation card of an orphaned chat (proposals,
   * checkup, preview) as expired and cancel the orphaned turn. Returns false
   * when something is actually running for the chat (not an orphan).
   */
  private async expireOrphanedPreparation(chatId: string): Promise<boolean> {
    if (
      this.activeTurns.has(chatId) ||
      this.hasPendingPreviewActivity(chatId) ||
      this.pendingProposalGates.has(chatId) ||
      this.pendingCheckupGates.has(chatId) ||
      this.pendingTransferGates.has(chatId) ||
      this.inFlightCheckups.has(chatId) ||
      this.startingChats.has(chatId)
    ) {
      return false
    }
    const messages = this.store.getMessages(chatId)
    const decidedProposals = new Set(
      messages.filter((m) => m.kind === "memory_proposals_decision").map((m) => m.proposalsId),
    )
    const decidedCheckups = new Set(
      messages.filter((m) => m.kind === "memory_checkup_decision").map((m) => m.checkupId),
    )
    const decidedTransfers = new Set(
      messages.filter((m) => m.kind === "memory_transfer_decision").map((m) => m.transferId),
    )
    const decidedPreviews = new Set(
      messages.filter((m) => m.kind === "memory_preview_decision").map((m) => m.previewId),
    )
    let settled = false
    for (const message of messages) {
      if (message.kind === "memory_proposals" && !decidedProposals.has(message.proposalsId)) {
        decidedProposals.add(message.proposalsId)
        await this.store.appendMessage(
          chatId,
          timestamped({ kind: "memory_proposals_decision", proposalsId: message.proposalsId, decision: "expired" }),
        )
        settled = true
      }
      if (message.kind === "memory_transfer" && !decidedTransfers.has(message.transferId)) {
        decidedTransfers.add(message.transferId)
        await this.store.appendMessage(
          chatId,
          timestamped({ kind: "memory_transfer_decision", transferId: message.transferId, decision: "expired" }),
        )
        settled = true
      }
      if (message.kind === "memory_checkup" && !decidedCheckups.has(message.checkupId)) {
        decidedCheckups.add(message.checkupId)
        await this.store.appendMessage(
          chatId,
          timestamped({ kind: "memory_checkup_decision", checkupId: message.checkupId, decision: "expired" }),
        )
        settled = true
      }
      if (message.kind === "memory_preview" && !decidedPreviews.has(message.previewId)) {
        decidedPreviews.add(message.previewId)
        await this.store.appendMessage(
          chatId,
          timestamped({ kind: "memory_preview_decision", previewId: message.previewId, decision: "expired" }),
        )
        settled = true
      }
    }
    if (!settled) return false
    await this.store.recordTurnCancelled(chatId)
    this.emitStateChange(chatId, { immediate: true })
    return true
  }

  /**
   * Resolve a preview that exists undecided in the transcript while nothing
   * is running for the chat: record an "expired" decision (system, never a
   * user choice — analysis must not read it as one) and cancel the orphaned
   * turn. Returns false when this is not that case (real unknown previewId).
   */
  private async expireOrphanedPreview(chatId: string, previewId: string): Promise<boolean> {
    if (this.activeTurns.has(chatId) || this.hasPendingPreviewActivity(chatId) || this.startingChats.has(chatId)) {
      return false
    }
    const messages = this.store.getMessages(chatId)
    const preview = messages.find(
      (m): m is Extract<TranscriptEntry, { kind: "memory_preview" }> =>
        m.kind === "memory_preview" && m.previewId === previewId,
    )
    if (!preview) return false
    const decided = messages.some((m) => m.kind === "memory_preview_decision" && m.previewId === previewId)
    if (decided) return false

    await this.store.appendMessage(
      chatId,
      timestamped({ kind: "memory_preview_decision", previewId, decision: "expired" }),
    )
    await this.store.recordTurnCancelled(chatId)
    this.memory?.logger.event({
      type: "memory.preview",
      sessionId: chatId,
      turn: preview.turn,
      memoryIds: preview.memories.map((m) => m.id),
      decision: "expired",
    })
    this.emitStateChange(chatId, { immediate: true })
    return true
  }

  /** Resolve a parked step-one checkup gate with the user's decision. */
  async respondMemoryCheckup(command: { chatId: string; checkupId: string; decision: "handled" | "skipped" }) {
    const pending = this.pendingCheckupGates.get(command.chatId)
    if (!pending || pending.checkupId !== command.checkupId) {
      if (this.isMemoryGateDecided(command.chatId, "memory_checkup_decision", "checkupId", command.checkupId)) return
      if (await this.expireOrphanedCheckup(command.chatId, command.checkupId)) return
      throw new Error("No matching pending memory checkup gate")
    }
    pending.respond(command.decision)
  }

  /** Restart-orphan discipline for checkup gates (mirrors the proposals gate). */
  private async expireOrphanedCheckup(chatId: string, checkupId: string): Promise<boolean> {
    if (
      this.activeTurns.has(chatId) ||
      this.pendingCheckupGates.has(chatId) ||
      this.pendingProposalGates.has(chatId) ||
      this.pendingTransferGates.has(chatId) ||
      this.hasPendingPreviewActivity(chatId) ||
      this.startingChats.has(chatId)
    ) {
      return false
    }
    const messages = this.store.getMessages(chatId)
    const gate = messages.find(
      (m): m is Extract<TranscriptEntry, { kind: "memory_checkup" }> =>
        m.kind === "memory_checkup" && m.checkupId === checkupId,
    )
    if (!gate) return false
    const decided = messages.some((m) => m.kind === "memory_checkup_decision" && m.checkupId === checkupId)
    if (decided) return false

    await this.store.appendMessage(
      chatId,
      timestamped({ kind: "memory_checkup_decision", checkupId, decision: "expired" }),
    )
    await this.store.recordTurnCancelled(chatId)
    const result = messages.find(
      (m): m is Extract<TranscriptEntry, { kind: "memory_checkup_result" }> =>
        m.kind === "memory_checkup_result" && m.checkupId === checkupId,
    )
    this.memory?.logger.event({
      type: "memory.checkup",
      sessionId: chatId,
      turn: gate.turn,
      suggestions: result?.suggestions.length ?? 0,
      ...(result?.failedKinds?.length ? { failedKinds: result.failedKinds } : {}),
      decision: "expired",
    })
    this.emitStateChange(chatId, { immediate: true })
    return true
  }

  /** Resolve a parked Transfer card with the user's decision. */
  async respondMemoryTransfer(command: { chatId: string; transferId: string; decision: "handled" | "skipped" }) {
    const pending = this.pendingTransferGates.get(command.chatId)
    if (!pending || pending.transferId !== command.transferId) {
      // A duplicate or late click on an already-settled card is a no-op, not
      // an error banner (pilot report 2026-08-11: the red "No matching
      // pending memory transfer card" surfaced while the flow had moved on).
      if (this.isMemoryGateDecided(command.chatId, "memory_transfer_decision", "transferId", command.transferId)) return
      if (await this.expireOrphanedTransfer(command.chatId, command.transferId)) return
      throw new Error("No matching pending memory transfer card")
    }
    pending.respond(command.decision)
  }

  /** True when the transcript already records a decision for this gate id. */
  private isMemoryGateDecided(
    chatId: string,
    kind: "memory_transfer_decision" | "memory_checkup_decision" | "memory_proposals_decision",
    idField: "transferId" | "checkupId" | "proposalsId",
    gateId: string
  ): boolean {
    return this.store
      .getMessages(chatId)
      .some((m) => m.kind === kind && (m as unknown as Record<string, string>)[idField] === gateId)
  }

  /** Restart-orphan discipline for the Transfer card (mirrors the checkup gate). */
  private async expireOrphanedTransfer(chatId: string, transferId: string): Promise<boolean> {
    if (
      this.activeTurns.has(chatId) ||
      this.pendingTransferGates.has(chatId) ||
      this.pendingCheckupGates.has(chatId) ||
      this.pendingProposalGates.has(chatId) ||
      this.hasPendingPreviewActivity(chatId) ||
      this.startingChats.has(chatId)
    ) {
      return false
    }
    const messages = this.store.getMessages(chatId)
    const gate = messages.find(
      (m): m is Extract<TranscriptEntry, { kind: "memory_transfer" }> =>
        m.kind === "memory_transfer" && m.transferId === transferId,
    )
    if (!gate) return false
    const decided = messages.some((m) => m.kind === "memory_transfer_decision" && m.transferId === transferId)
    if (decided) return false

    await this.store.appendMessage(
      chatId,
      timestamped({ kind: "memory_transfer_decision", transferId, decision: "expired" }),
    )
    await this.store.recordTurnCancelled(chatId)
    this.memory?.logger.event({
      type: "memory.transfer_card",
      sessionId: chatId,
      turn: gate.turn,
      suggestions: gate.suggestions.length,
      decision: "expired",
    })
    this.emitStateChange(chatId, { immediate: true })
    return true
  }

  /** Resolve a parked step-one proposals gate with the user's decision. */
  async respondMemoryProposals(command: { chatId: string; proposalsId: string; decision: "reviewed" | "skipped" }) {
    const pending = this.pendingProposalGates.get(command.chatId)
    if (!pending || pending.proposalsId !== command.proposalsId) {
      if (this.isMemoryGateDecided(command.chatId, "memory_proposals_decision", "proposalsId", command.proposalsId)) return
      if (await this.expireOrphanedProposals(command.chatId, command.proposalsId)) return
      throw new Error("No matching pending memory proposals gate")
    }
    pending.respond(command.decision)
  }

  /**
   * Same restart-orphan discipline as expireOrphanedPreview: an undecided
   * memory_proposals card with nothing running settles as "expired" and the
   * orphaned turn is cancelled, instead of erroring into a stuck spinner.
   */
  private async expireOrphanedProposals(chatId: string, proposalsId: string): Promise<boolean> {
    if (this.activeTurns.has(chatId) || this.pendingProposalGates.has(chatId) || this.pendingTransferGates.has(chatId) || this.hasPendingPreviewActivity(chatId) || this.startingChats.has(chatId)) {
      return false
    }
    const messages = this.store.getMessages(chatId)
    const gate = messages.find(
      (m): m is Extract<TranscriptEntry, { kind: "memory_proposals" }> =>
        m.kind === "memory_proposals" && m.proposalsId === proposalsId,
    )
    if (!gate) return false
    const decided = messages.some((m) => m.kind === "memory_proposals_decision" && m.proposalsId === proposalsId)
    if (decided) return false

    await this.store.appendMessage(
      chatId,
      timestamped({ kind: "memory_proposals_decision", proposalsId, decision: "expired" }),
    )
    await this.store.recordTurnCancelled(chatId)
    this.memory?.logger.event({
      type: "memory.proposals",
      sessionId: chatId,
      turn: gate.turn,
      count: gate.candidates.length,
      decision: "expired",
    })
    this.emitStateChange(chatId, { immediate: true })
    return true
  }

  /**
   * Record [M-NN] citations found in a completed assistant text: bump usage_count
   * for each real, active memory cited. usage_count feeds the retrieval boost, so
   * memories the model actually uses rank up over time. Counts any existing
   * injected memory and ignores hallucinated ids.
   *
   * carryoverIds marks cites of memories NOT injected this turn: a session
   * engine keeps its conversation history, so a "proceed without memory" (or
   * edited-selection) turn can still cite ids from earlier turns' context.
   * That is inherent to conversational engines — the telemetry names it so
   * analysis never mistakes carryover for fresh injection.
   */
  private recordMemoryCitations(text: string, sessionId?: string): string[] {
    if (!this.memory || !text) return []
    const cited = extractCitations(text)
    if (!cited.length) return []
    const counted: string[] = []
    for (const id of cited) {
      const m = this.memory.store.getById(id)
      if (m && m.status === "active") {
        this.memory.store.recordUse(id, { actor: "agent", sessionId, via: "citation" })
        counted.push(id)
      }
    }
    const injected = new Set(sessionId ? this.activeTurns.get(sessionId)?.injectedIds ?? [] : [])
    const carryoverIds = counted.filter((id) => !injected.has(id))
    this.memory.logger.event({
      type: "memory.cite",
      sessionId,
      citedIds: cited,
      countedIds: counted,
      ...(carryoverIds.length ? { carryoverIds } : {}),
    })
    return counted
  }

  /**
   * Delegating/Auto mode (evolution policy, F4's two control styles): apply
   * fresh proposals immediately instead of parking them for review. Control
   * moves to the agent; monitoring stays on — every auto-accept renders with
   * an "auto" badge + one-click Revert, and sensitive candidates ALWAYS wait
   * for explicit confirmation (the privacy boundary outranks delegation).
   * Returns the ids that were auto-applied.
   */
  private autoApplyProposals(
    proposals: MemoryItem[],
    args: { chatId: string; turnNumber?: number },
  ): Set<string> {
    const applied = new Set<string>()
    if (!this.memory || this.policy.capture !== "review") return applied
    const mode = this.memory.store.getKv<{ mode?: string }>("evolution_policy")?.mode ?? "ask"
    if (mode !== "auto") return applied
    const touchedProjects = new Set<string | undefined>()
    for (const proposal of proposals) {
      if (proposal.sensitive) continue
      try {
        const meta = { actor: "system" as const, sessionId: args.chatId, turn: args.turnNumber }
        if (this.memory.store.revisionTargetOf(proposal.id)) {
          const outcome = this.memory.store.acceptRevision(proposal.id, meta)
          // The acceptance archived the replaced target(s) — each is a state
          // change of its own and must be in the log (the UI accept path
          // records the same pairs).
          for (const replaced of outcome.replaced) {
            touchedProjects.add(replaced.projectId)
            this.memory.logger.event({
              type: "memory.decision",
              sessionId: args.chatId,
              action: "archive",
              id: replaced.id,
              fromScope: replaced.scope,
              via: "revision_accept",
            })
          }
        } else {
          this.memory.store.update(proposal.id, { status: "active" }, meta)
        }
        applied.add(proposal.id)
        touchedProjects.add(proposal.projectId)
        this.memory.logger.event({
          type: "memory.decision",
          sessionId: args.chatId,
          action: "accept",
          id: proposal.id,
          via: "auto",
        })
      } catch {
        // A failed auto-apply simply leaves the proposal in the review lane.
      }
    }
    // Auto-applied state is ACTIVE state — the Markdown view must say so now,
    // exactly like the UI accept path.
    if (applied.size) {
      const projectIds = [...touchedProjects].filter((p): p is string => Boolean(p))
      if (projectIds.length === 0) this.memory.syncProjection()
      else for (const projectId of projectIds) this.memory.syncProjection(projectId)
    }
    return applied
  }

  /**
   * The post-turn memory passes (SPEC §4.1 capture, §4.10 trace), run
   * fire-and-forget after a successful turn's final result. Never throws — failures go to
   * the background-error reporter and must not break the turn loop.
   */
  private noteStudyMemoryQualityFlag(flag: StudyMemoryQualityFlag): void {
    const existing = this.studyMemoryQualityByTask.get(flag.taskId) ?? []
    const duplicate = existing.some((candidate) => (
      candidate.code === flag.code
      && candidate.chatId === flag.chatId
      && candidate.turnId === flag.turnId
    ))
    try {
      this.studyMemoryStore?.recordStudyMemoryQualityFlag(flag)
    } catch (error) {
      this.reportBackgroundError?.(
        `[study-quality] failed to persist ${flag.code}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (duplicate) return
    this.studyMemoryQualityByTask.set(flag.taskId, [...existing, flag])
  }

  private clearStudyMemoryQualityFlag(args: {
    taskId: string
    chatId: string
    turnId: string
    code: string
  }): void {
    const existing = this.studyMemoryQualityByTask.get(args.taskId) ?? []
    const remaining = existing.filter((flag) => !(
      flag.code === args.code
      && flag.chatId === args.chatId
      && flag.turnId === args.turnId
    ))
    if (remaining.length) this.studyMemoryQualityByTask.set(args.taskId, remaining)
    else this.studyMemoryQualityByTask.delete(args.taskId)
    const clearKey = `${args.taskId}\0${args.code}\0${args.chatId}\0${args.turnId}`
    try {
      this.studyMemoryStore?.clearStudyMemoryQualityFlag(args)
      this.pendingStudyMemoryQualityClears.delete(clearKey)
    } catch (error) {
      this.pendingStudyMemoryQualityClears.set(clearKey, args)
      this.reportBackgroundError?.(
        `[study-quality] failed to clear ${args.code}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private trackStudyMemoryJob(
    taskId: string,
    promise: Promise<StudyMemoryQualityFlag[]>,
    pendingFlag?: StudyMemoryQualityFlag,
  ): void {
    const tracked = { taskId, promise }
    this.inFlightStudyMemoryJobs.add(tracked)
    void promise.then((flags) => {
      for (const flag of flags) this.noteStudyMemoryQualityFlag(flag)
      if (pendingFlag) this.clearStudyMemoryQualityFlag(pendingFlag)
    }).finally(() => {
      this.inFlightStudyMemoryJobs.delete(tracked)
    })
  }

  private enqueueAutoProjectCapture<T>(job: () => Promise<T>): Promise<T> {
    this.pendingAutoProjectCaptureJobs += 1
    const execution = this.autoProjectCaptureTail
      .catch(() => undefined)
      .then(job)
    const tracked = execution.finally(() => {
      this.pendingAutoProjectCaptureJobs = Math.max(0, this.pendingAutoProjectCaptureJobs - 1)
    })
    this.autoProjectCaptureTail = tracked.then(
      () => undefined,
      () => undefined,
    )
    return tracked
  }

  private async awaitAutoProjectCaptureBarrier(): Promise<void> {
    while (true) {
      const observed = this.autoProjectCaptureTail
      await observed
      if (observed === this.autoProjectCaptureTail) return
    }
  }

  private shouldQueueBehindAutoCapture(provider: AgentProvider): boolean {
    return this.policy.studyMode
      && this.policy.condition === "auto"
      && provider === "claude"
      && this.pendingAutoProjectCaptureJobs > 0
  }

  private async recordDeferredTurnStartFailure(chatId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    try {
      await this.store.appendMessage(
        chatId,
        timestamped({ kind: "result", subtype: "error", isError: true, durationMs: 0, result: message }),
      )
      await this.store.recordTurnFailed(chatId, message)
      this.emitStateChange(chatId)
    } catch (recordError) {
      this.reportBackgroundError?.(
        `[auto-deferred-start] chat ${chatId}: could not record failure: ${recordError instanceof Error ? recordError.message : String(recordError)}`,
      )
    }
  }

  private isCancelledDeferredQueueRow(chatId: string, queuedMessageId: string): boolean {
    return this.store.getMessages(chatId).some((entry) => (
      entry.kind === "interrupted"
      && entry.cancelledQueuedMessageId === queuedMessageId
    ))
  }

  /**
   * Returns the first queue row that is still eligible for delivery. A Stop
   * marker survives process restart; if its physical dequeue previously
   * failed, recovery removes it without ever reinterpreting it as a prompt.
   * Failure is fail-closed: do not jump over the tombstoned head to q2.
   */
  private async nextDispatchableQueuedMessage(chatId: string): Promise<QueuedChatMessage | null> {
    while (true) {
      const head = this.store.getQueuedMessages(chatId)[0]
      if (!head) return null
      if (!this.isCancelledDeferredQueueRow(chatId, head.id)) return head
      try {
        await this.store.removeQueuedMessage(chatId, head.id)
      } catch (error) {
        if (this.store.getQueuedMessage(chatId, head.id)) {
          this.reportBackgroundError?.(
            `[auto-deferred-stop] chat ${chatId}: stopped queue row remains blocked: ${error instanceof Error ? error.message : String(error)}`,
          )
          return null
        }
      }
    }
  }

  private resumeNextQueuedMessage(chatId: string): void {
    void this.maybeStartNextQueuedMessage(chatId).catch((error) => {
      void this.recordDeferredTurnStartFailure(chatId, error)
    })
  }

  /**
   * A direct Auto send arriving while the previous turn is still being
   * captured is first persisted in the normal queue, then dispatched only
   * after the ordered Auto capture tail settles. The WebSocket can ack
   * the durable queue row immediately without letting Claude see stale memory.
   */
  private scheduleAutoCaptureQueueDrain(chatId: string, queuedMessageId: string): void {
    if (this.pendingAutoCaptureStarts.has(chatId)) return
    const pending = new PendingAutoCaptureStart(queuedMessageId)
    this.pendingAutoCaptureStarts.set(chatId, pending)
    this.emitStateChange(chatId, { immediate: true })

    void (async () => {
      try {
        const outcome = await Promise.race([
          this.awaitAutoProjectCaptureBarrier().then(() => "ready" as const),
          pending.cancellation.requested.then(() => "cancelled" as const),
        ])
        if (outcome === "cancelled" || pending.cancellation.signal.aborted) return
        pending.phase = "dispatching"
        while (!pending.cancellation.signal.aborted) {
          // The head present when chat.send was acknowledged may be removed by
          // an external queue action while capture is still settling. Dispatch
          // the current durable head so a later row is never stranded behind a
          // stale in-memory id.
          const queued = await this.nextDispatchableQueuedMessage(chatId)
          if (!queued) return
          pending.queuedMessageId = queued.id
          const dispatch = await this.dequeueAndStartQueuedMessage(chatId, queued, {
            deferredAutoStart: pending.guard,
          })
          if (dispatch !== "missing") return
        }
      } catch (error) {
        // Stop is a participant-requested terminal outcome, not a failed send.
        // A store/start await that unwinds after its signal must not append a
        // second, misleading error receipt.
        if (!pending.cancellation.signal.aborted && !pending.cancelCommittedDelivery) {
          await this.recordDeferredTurnStartFailure(chatId, error)
        }
      } finally {
        pending.settleWithoutTurnStart()
        let continueQueue = false
        if (
          pending.phase === "dispatching"
          && (pending.cancellation.signal.aborted || pending.cancelCommittedDelivery)
          && pending.cancellationReceipt
        ) {
          // If Stop won before queue removal began, discard that stopped row
          // here. If removal was already in flight this is a no-op. Waiting for
          // the receipt keeps the next row ordered after the visible Stop.
          let receiptDurable = true
          await pending.cancellationReceipt.catch(() => {
            receiptDurable = false
          })
          if (pending.cancellation.signal.aborted && this.store.getQueuedMessage(chatId, pending.queuedMessageId)) {
            try {
              await this.store.removeQueuedMessage(chatId, pending.queuedMessageId)
            } catch (error) {
              if (this.store.getQueuedMessage(chatId, pending.queuedMessageId)) {
                this.reportBackgroundError?.(
                  `[auto-deferred-stop] chat ${chatId}: could not remove stopped queue row: ${error instanceof Error ? error.message : String(error)}`,
                )
              }
            }
          }
          // Never redispatch the stopped row itself. A failed cleanup leaves it
          // visible for explicit retry/recovery, but it must not be mistaken
          // for q2 merely because it is still the current durable head.
          continueQueue = receiptDurable
            && !this.store.getQueuedMessage(chatId, pending.queuedMessageId)
        }
        if (this.pendingAutoCaptureStarts.get(chatId) === pending) {
          this.pendingAutoCaptureStarts.delete(chatId)
        }
        pending.cancellation.settle()
        this.emitStateChange(chatId)

        if (continueQueue) this.resumeNextQueuedMessage(chatId)
      }
    })()
  }

  private cancelAutoCaptureQueueDrain(
    chatId: string,
    pending: PendingAutoCaptureStart,
    hideInterrupted?: boolean,
  ): Promise<void> {
    if (pending.cancellationOperation) return pending.cancellationOperation

    const stoppedDuringDispatch = pending.phase === "dispatching"
    const committedDelivery = pending.deliveryCommitted
    if (committedDelivery) pending.cancelCommittedDelivery = true
    const barrierSettlement = committedDelivery ? null : pending.cancellation.cancelAndWait()

    pending.cancellationReceipt = (async () => {
      if (!stoppedDuringDispatch) await barrierSettlement
      if (committedDelivery) await pending.turnStartSettlement
      await this.store.appendMessage(chatId, committedDelivery
        ? timestamped({ kind: "interrupted", hidden: hideInterrupted })
        : timestamped({
            kind: "interrupted",
            hidden: hideInterrupted,
            cancelledQueuedMessageId: pending.queuedMessageId,
          }))
      await this.store.recordTurnCancelled(chatId)

      // The marker above is the durable authority. Physical cleanup may fail;
      // every future drain will see the tombstone and remain fail-closed.
      if (!stoppedDuringDispatch && !committedDelivery) {
        try {
          if (this.store.getQueuedMessage(chatId, pending.queuedMessageId)) {
            await this.store.removeQueuedMessage(chatId, pending.queuedMessageId)
          }
        } catch (error) {
          if (this.store.getQueuedMessage(chatId, pending.queuedMessageId)) {
            this.reportBackgroundError?.(
              `[auto-deferred-stop] chat ${chatId}: could not remove stopped barrier row: ${error instanceof Error ? error.message : String(error)}`,
            )
          }
        }
      }
    })()

    pending.cancellationOperation = pending.cancellationReceipt.then(() => {
      this.emitStateChange(chatId, { immediate: true })
      if (!stoppedDuringDispatch) this.resumeNextQueuedMessage(chatId)
    })
    return pending.cancellationOperation
  }

  private launchPostTurnMemoryPasses(args: PostTurnMemoryPassArgs): void {
    if (args.engine !== "claude" || !args.taskId) {
      const run = () => this.runPostTurnMemoryPasses(args)
      void (this.policy.condition === "auto" && args.engine === "claude"
        ? this.enqueueAutoProjectCapture(run)
        : run())
      return
    }

    const taskId = args.taskId
    let resolved = false
    let resolveSettlement!: (flags: StudyMemoryQualityFlag[]) => void
    const promise = new Promise<StudyMemoryQualityFlag[]>((resolve) => {
      resolveSettlement = resolve
    })
    const settle = (flags: StudyMemoryQualityFlag[]) => {
      if (resolved) return
      resolved = true
      resolveSettlement(flags)
    }
    const pendingFlag: StudyMemoryQualityFlag = {
      code: "post_turn_incomplete",
      blocking: false,
      taskId,
      chatId: args.chatId,
      turnId: args.turnId,
      ...(args.turnNumber !== undefined ? { turn: args.turnNumber } : {}),
    }
    this.noteStudyMemoryQualityFlag(pendingFlag)
    this.trackStudyMemoryJob(taskId, promise, pendingFlag)

    const run = () => this.runPostTurnMemoryPasses({
      ...args,
      onStudyMeasurementSettled: settle,
    })
    const execution = this.policy.condition === "auto"
      ? this.enqueueAutoProjectCapture(run)
      : run()
    void execution.catch((error) => {
      this.reportBackgroundError?.(
        `[memory-post-turn] chat ${args.chatId} turn ${args.turnNumber ?? "?"}: ${error instanceof Error ? error.message : String(error)}`
      )
      settle([{
        code: "post_turn_failed",
        blocking: false,
        taskId,
        chatId: args.chatId,
        turnId: args.turnId,
        ...(args.turnNumber !== undefined ? { turn: args.turnNumber } : {}),
      }])
    })
  }

  private staticFocusFailure(
    pending: Pick<PendingStaticFocusDelivery, "taskId" | "chatId" | "turnId" | "turn">,
    code: "static_extraction_failed" | "static_focus_persistence_failed" | "static_focus_pending",
  ): StudyMemoryQualityFlag {
    return {
      code,
      blocking: true,
      taskId: pending.taskId,
      chatId: pending.chatId,
      turnId: pending.turnId,
      turn: pending.turn,
    }
  }

  private enqueuePendingStaticFocus(pending: PendingStaticFocusDelivery): void {
    if (!this.studyMemoryStore || !this.staticMemoryExtractor) return
    if (this.staticFocusJobsByInjection.has(pending.injectionId)) return

    const previous = this.staticFocusTailByNamespace.get(pending.namespace) ?? Promise.resolve()
    const job = previous
      .catch(() => undefined)
      .then(async () => {
        await materializePendingStaticFocus({
          store: this.studyMemoryStore!,
          extractor: this.staticMemoryExtractor!,
          logger: this.memory?.logger ?? { event: () => {} },
          pending,
        })
        this.clearStudyMemoryQualityFlag({
          taskId: pending.taskId,
          chatId: pending.chatId,
          turnId: pending.turnId,
          code: "static_extraction_failed",
        })
        return [] as StudyMemoryQualityFlag[]
      })
      .catch((error) => {
        this.reportBackgroundError?.(
          `[study-static-focus] chat ${pending.chatId} turn ${pending.turn}: ${error instanceof Error ? error.message : String(error)}`,
        )
        return [this.staticFocusFailure(pending, "static_extraction_failed")]
      })
    const tail = job.then(() => undefined)
    this.staticFocusJobsByInjection.set(pending.injectionId, job)
    this.staticFocusTailByNamespace.set(pending.namespace, tail)
    this.trackStudyMemoryJob(pending.taskId, job)
    void tail.finally(() => {
      this.staticFocusJobsByInjection.delete(pending.injectionId)
      if (this.staticFocusTailByNamespace.get(pending.namespace) === tail) {
        this.staticFocusTailByNamespace.delete(pending.namespace)
      }
    })
  }

  /** Resume exact queued payloads after a process restart. Safe to call more
   * than once; the per-injection map prevents duplicate workers. */
  resumePendingStaticFocusMaterializations(taskId?: string): void {
    if (!this.studyMemoryStore || !this.staticMemoryExtractor) return
    for (const pending of this.studyMemoryStore.listPendingStaticFocusDeliveries(
      taskId ? { taskId } : {},
    )) {
      this.enqueuePendingStaticFocus(pending)
    }
  }

  private launchStaticFocusMaterialization(args: {
    taskId: string | null
    projectId?: string
    chatId: string
    turnId: string
    turn: number
    promptText: string
    plan: MemoryInjectionPlan | null
  }): void {
    const taskId = args.taskId
    if (!taskId) return
    const occurrence = {
      taskId,
      chatId: args.chatId,
      turnId: args.turnId,
      turn: args.turn,
    }
    if (!this.studyMemoryStore || !args.plan?.staticPayload || !args.projectId) {
      this.noteStudyMemoryQualityFlag(this.staticFocusFailure(occurrence, "static_focus_persistence_failed"))
      this.reportBackgroundError?.(
        `[study-static-focus] chat ${args.chatId} turn ${args.turn}: Static measurement is unavailable`,
      )
      return
    }
    let pending: PendingStaticFocusDelivery
    try {
      pending = reserveDeliveredStaticFocus({
        store: this.studyMemoryStore,
        taskId,
        namespace: args.projectId,
        chatId: args.chatId,
        turnId: args.turnId,
        turn: args.turn,
        promptText: args.promptText,
        payload: args.plan.staticPayload,
      })
    } catch (error) {
      this.noteStudyMemoryQualityFlag(this.staticFocusFailure(occurrence, "static_focus_persistence_failed"))
      this.reportBackgroundError?.(
        `[study-static-focus] chat ${args.chatId} turn ${args.turn}: could not reserve delivery: ${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }
    if (!this.staticMemoryExtractor) {
      this.noteStudyMemoryQualityFlag(this.staticFocusFailure(pending, "static_extraction_failed"))
      this.reportBackgroundError?.(
        `[study-static-focus] chat ${args.chatId} turn ${args.turn}: Static extractor is unavailable`,
      )
      return
    }
    this.enqueuePendingStaticFocus(pending)
  }

  private async runPostTurnMemoryPasses(
    args: PostTurnMemoryPassArgs & {
      onStudyMeasurementSettled?: (flags: StudyMemoryQualityFlag[]) => void
    },
  ) {
    if (!this.memory || (!args.userText.trim() && !args.assistantText.trim())) {
      args.onStudyMeasurementSettled?.([])
      return
    }

    const qualityFlag = (
      code: StudyMemoryQualityFlag["code"],
    ): StudyMemoryQualityFlag | null => args.taskId
      ? {
          code,
          blocking: code === "focus_persistence_failed" || code === "static_extraction_failed",
          taskId: args.taskId,
          chatId: args.chatId,
          turnId: args.turnId,
          ...(args.turnNumber !== undefined ? { turn: args.turnNumber } : {}),
        }
      : null

    // Capture and trace are INDEPENDENT LLM passes over the same turn text —
    // run them concurrently instead of back-to-back (the serial order doubled
    // post-turn latency for no reason; inline citations are regex-extracted
    // during the turn and never wait on either). Each pass keeps its own
    // error containment.
    const capturePass = async (): Promise<StudyMemoryQualityFlag[]> => {
      if (!this.capture) return []
      try {
        const captureInput = {
          projectId: args.projectId,
          sessionId: args.chatId,
          turn: args.turnNumber,
          engine: args.engine,
          ...(this.policy.studyMode && this.policy.condition === "auto" && args.engine === "claude"
            ? { profile: "auto-project-copy" as const }
            : {}),
          userText: args.userText,
          assistantText: args.assistantText,
        }
        // Fork path first (user decision 2026-08-08, option A): the forked
        // session extracts candidates from its OWN full trajectory — the
        // sidecar pass only ever saw the final prose. Same validation +
        // routing gate either way; any failure falls back to the sidecar.
        // MEMOSYNC_CAPTURE_FORK=0 disables the fork entirely.
        let outcome: CaptureOutcome | null = null
        if (
          args.engine === "claude" &&
          args.claudeSessionToken &&
          args.localPath &&
          process.env.MEMOSYNC_CAPTURE_FORK !== "0"
        ) {
          const raw = await this.forkCaptureFn({
            sessionToken: args.claudeSessionToken,
            localPath: args.localPath,
            profile:
              this.policy.studyMode && this.policy.condition === "auto"
                ? "auto-project-copy"
                : "review",
          })
          if (raw && this.capture.captureFromExtraction) {
            try {
              outcome = await this.capture.captureFromExtraction(raw, captureInput)
            } catch {
              outcome = null
            }
          }
        }
        if (!outcome) outcome = await this.capture.capture(captureInput)
        if (outcome.created.length) {
          const autoIds = this.autoApplyProposals(outcome.created, args)
          // Redesign 2026-08-07 §3: pending proposals no longer card at the
          // turn's end — they park in the store and surface in the NEXT
          // turn's step-one gate. Only auto-applied ones (delegating policy)
          // still card here: they took effect without asking, and the auto
          // badge + Revert is their monitoring surface.
          const autoApplied = outcome.created.filter(({ id }) => autoIds.has(id))
          if (autoApplied.length) {
            await this.store.appendMessage(
              args.chatId,
              timestamped({
                kind: "memory_candidates",
                turn: args.turnNumber,
                // The memory DB is the live source for card content. Persisting
                // raw candidate text here would duplicate sensitive drafts into
                // the append-only transcript even after the user dismissed or
                // sanitized them.
                candidates: autoApplied.map(({ id }) => ({ id, auto: true })),
              })
            )
          }
          this.emitStateChange(args.chatId)
        }
        return []
      } catch (error) {
        this.reportBackgroundError?.(
          `[memory-capture] chat ${args.chatId} turn ${args.turnNumber ?? "?"}: ${error instanceof Error ? error.message : String(error)}`
        )
        const flag = qualityFlag("capture_failed")
        return flag ? [flag] : []
      }
    }

    const tracePass = async (): Promise<StudyMemoryQualityFlag[]> => {
      if (!this.memoryTrace || args.memoryDisabled) return []
      try {
        // "Used" = everything in play this turn: the BOOT-TIME injected
        // snapshot plus any extra memories the model cited (e.g. pulled in via
        // search_memory). Memories accepted mid-turn are not in play.
        const usedIds = [...new Set([...args.injectedIds, ...args.citedIds])]
        const usedMemories = usedIds
          .map((id) => this.memory!.store.getById(id))
          .filter((m): m is MemoryItem => Boolean(m && m.status === "active"))
        if (usedMemories.length) {
          // Audit skeleton (redesign 2026-08-07 §3): the pass can take up to
          // 90s — the card appears immediately as "auditing…" and the final
          // entry for the same turn supersedes this one at hydration.
          await this.store.appendMessage(
            args.chatId,
            timestamped({ kind: "memory_trace", turn: args.turnNumber, status: "pending", labels: [] })
          )
          this.emitStateChange(args.chatId)
          const usedById = new Map(usedMemories.map((m) => [m.id, m]))
          // Fork path first (user design 2026-08-05): ask the question on a
          // fork of the finished session — cached prefix, full trajectory,
          // zero main-context pollution. Any failure falls back to the
          // sidecar; MEMOSYNC_TRACE_FORK=0 disables the fork entirely.
          let outcome: TraceOutcome | null = null
          let tracedVia: "fork" | "sidecar" = "sidecar"
          if (
            args.engine === "claude" &&
            args.claudeSessionToken &&
            args.localPath &&
            process.env.MEMOSYNC_TRACE_FORK !== "0"
          ) {
            const raw = await this.forkTraceFn({
              sessionToken: args.claudeSessionToken,
              localPath: args.localPath,
              usedMemories,
            })
            if (raw) {
              outcome = coerceTraceOutcome(raw, { usedMemories, assistantText: args.assistantText })
              tracedVia = "fork"
            }
          }
          if (!outcome) {
            outcome = await this.memoryTrace!.trace({
              sessionId: args.chatId,
              engine: args.engine,
              turn: args.turnNumber,
              userText: args.userText,
              assistantText: args.assistantText,
              usedMemories,
            })
          }
          // CAS: the pass judged the text it was SHOWN. A memory the user
          // edited or archived while the LLM ran gets no verdict written
          // anywhere — a health dot for text the judgment never saw is worse
          // than a missing one. Dropped ids also lose their summary citation.
          const labels = outcome.labels.filter((l) => {
            const now = this.memory!.store.getById(l.id)
            const snap = usedById.get(l.id)
            return Boolean(now && snap && now.status === "active" && now.content === snap.content)
          })
          const droppedIds = new Set(outcome.labels.map((l) => l.id).filter((id) => !labels.some((l) => l.id === id)))
          const summary =
            outcome.summary && droppedIds.size
              ? outcome.summary.replace(/\[(M-\d+)\]/g, (whole, id: string) => (droppedIds.has(id) ? id : whole))
              : outcome.summary
          if (labels.length) {
            // Self-report vs audit finding (fact/inference line on the card):
            // an id the reply cited inline is the agent's own report; one only
            // the audit surfaced is a post-hoc inference.
            const citedSet = new Set(args.citedIds)
            const labelsWithSource = labels.map((l) => ({ ...l, ...(citedSet.has(l.id) ? { cited: true } : {}) }))
            await this.store.appendMessage(
              args.chatId,
              timestamped({
                kind: "memory_trace",
                turn: args.turnNumber,
                status: "ok",
                labels: labelsWithSource,
                summary,
                ...(droppedIds.size ? { dropped: droppedIds.size } : {}),
              })
            )
            this.memory!.logger.event({
              type: "memory.trace",
              sessionId: args.chatId,
              engine: args.engine,
              turn: args.turnNumber,
              status: "ok",
              via: tracedVia,
              labels: labels.map(({ id, label }) => ({ id, label })),
              ...(droppedIds.size ? { dropped: droppedIds.size } : {}),
            })
            // "Operational" = the memory visibly shaped the turn — that is a
            // use even when the reply never wrote an [M-NN] marker (citations
            // alone leave followed-but-uncited constraints at 0 forever).
            // Cited ids already bumped in recordMemoryCitations. Every label
            // is also recorded as a 'trace' event — the Board's health dot
            // and the offline audit read the per-memory verdict history.
            const cited = new Set(args.citedIds)
            for (const l of labels) {
              this.memory!.store.recordTraceLabel(l.id, l.label, { actor: "agent", sessionId: args.chatId, turn: args.turnNumber })
              if (l.label !== "operational" || cited.has(l.id)) continue
              this.memory!.store.recordUse(l.id, { actor: "agent", sessionId: args.chatId, via: "trace_operational" })
            }
            this.emitStateChange(args.chatId)

            // Self-evolution M4: with this turn's verdicts recorded, memories
            // whose last K traces all read 'violated' get a drafted REVISION
            // proposal — surfaced through the same review lane as capture
            // candidates. In Ask mode the user ratifies; in delegating/Auto
            // mode the proposal applies immediately with a revert handle.
            if (this.memoryRevision) {
              try {
                const proposals = await this.memoryRevision.scanAndPropose({
                  sessionId: args.chatId,
                  engine: args.engine,
                  turn: args.turnNumber,
                  labels: labels.map((l) => ({ id: l.id, label: l.label })),
                })
                if (proposals.length) {
                  const autoIds = this.autoApplyProposals(proposals, args)
                  // Same step-one parking as capture candidates: pending
                  // revision proposals wait for the next turn's gate; only
                  // auto-applied ones card here (auto badge + Revert).
                  const autoApplied = proposals.filter(({ id }) => autoIds.has(id))
                  if (autoApplied.length) {
                    await this.store.appendMessage(
                      args.chatId,
                      timestamped({
                        kind: "memory_candidates",
                        turn: args.turnNumber,
                        candidates: autoApplied.map(({ id }) => ({ id, auto: true })),
                      })
                    )
                  }
                  this.emitStateChange(args.chatId)
                }
              } catch (error) {
                this.reportBackgroundError?.(
                  `[memory-revision] chat ${args.chatId} turn ${args.turnNumber ?? "?"}: ${error instanceof Error ? error.message : String(error)}`
                )
              }
            }
          } else {
            await this.store.appendMessage(
              args.chatId,
              timestamped({
                kind: "memory_trace",
                turn: args.turnNumber,
                status: "discarded",
                labels: [],
                dropped: droppedIds.size || usedMemories.length,
              })
            )
            this.memory!.logger.event({
              type: "memory.trace",
              sessionId: args.chatId,
              engine: args.engine,
              turn: args.turnNumber,
              status: "discarded",
              stage: "cas",
              labels: [],
              dropped: droppedIds.size || usedMemories.length,
            })
            this.emitStateChange(args.chatId)
          }
        } else if (usedIds.length) {
          await this.store.appendMessage(
            args.chatId,
            timestamped({
              kind: "memory_trace",
              turn: args.turnNumber,
              status: "discarded",
              labels: [],
              dropped: usedIds.length,
            })
          )
          this.memory!.logger.event({
            type: "memory.trace",
            sessionId: args.chatId,
            engine: args.engine,
            turn: args.turnNumber,
            status: "discarded",
            stage: "cas",
            labels: [],
            dropped: usedIds.length,
          })
          this.emitStateChange(args.chatId)
        } else {
          // Nothing was in play this turn (zero injected, zero cited). That is
          // still a terminal the transcript must record: without it the chat
          // shows no audit at all and the Memory Record's turn row waits as
          // "running…" forever (2026-08-19 evening revision).
          await this.store.appendMessage(
            args.chatId,
            timestamped({
              kind: "memory_trace",
              turn: args.turnNumber,
              status: "empty",
              labels: [],
            })
          )
          this.memory!.logger.event({
            type: "memory.trace",
            sessionId: args.chatId,
            engine: args.engine,
            turn: args.turnNumber,
            status: "empty",
            labels: [],
          })
          this.emitStateChange(args.chatId)
        }
        return []
      } catch (error) {
        const errorClass = error instanceof Error ? error.name || "Error" : "Error"
        try {
          await this.store.appendMessage(
            args.chatId,
            timestamped({
              kind: "memory_trace",
              turn: args.turnNumber,
              status: "failed",
              labels: [],
              errorClass,
            })
          )
          this.emitStateChange(args.chatId)
        } catch (persistError) {
          this.reportBackgroundError?.(
            `[memory-trace] chat ${args.chatId} turn ${args.turnNumber ?? "?"}: failed to persist terminal: ${persistError instanceof Error ? persistError.message : String(persistError)}`
          )
        }
        this.memory!.logger.event({
          type: "memory.trace",
          sessionId: args.chatId,
          engine: args.engine,
          turn: args.turnNumber,
          status: "failed",
          stage: "trace_pass",
          labels: [],
          errorClass,
        })
        this.reportBackgroundError?.(
          `[memory-trace] chat ${args.chatId} turn ${args.turnNumber ?? "?"}: ${error instanceof Error ? error.message : String(error)}`
        )
        const flag = qualityFlag("trace_failed")
        return flag ? [flag] : []
      }
    }

    const qualityFlags = (await Promise.all([capturePass(), tracePass()])).flat()
    args.onStudyMeasurementSettled?.(qualityFlags)

    const precomputeCheckup = async () => {
      // Checkup precomputation (user decision 2026-08-08, option B): compute
      // the NEXT gate's library checkup now — on the fork when possible (the
      // trajectory informs staleness/conflict judgment), sidecar otherwise —
      // so the next send can reuse the result and Step 2 renders instantly.
      // Runs AFTER capture (its reinforce bumps are part of the dependency
      // key). Partial by design: acceptances at the next gate's Step 1 change
      // the library and still trigger a live recompute there.
      // MEMOSYNC_CHECKUP_FORK=0 skips the fork leg (sidecar still runs).
      if (this.memoryCheckup && this.policy.capture === "review") {
        try {
          const checkupCtx = { projectId: args.projectId, sessionId: args.chatId }
          if (this.memoryCheckup.needsRecompute(checkupCtx)) {
            let primed = false
            if (
              args.engine === "claude" &&
              args.claudeSessionToken &&
              args.localPath &&
              process.env.MEMOSYNC_CHECKUP_FORK !== "0" &&
              this.memoryCheckup.buildForkPrompt &&
              this.memoryCheckup.primeFromForkResult
            ) {
              const request = this.memoryCheckup.buildForkPrompt(checkupCtx)
              if (request) {
                const raw = await this.forkQueryFn({
                  sessionToken: args.claudeSessionToken,
                  localPath: args.localPath,
                  prompt: request.prompt,
                })
                if (
                  raw &&
                  (await this.memoryCheckup.primeFromForkResult(checkupCtx, request.dependencyKey, raw))
                ) primed = true
              }
            }
            if (!primed) await this.memoryCheckup.run(checkupCtx)
          }
        } catch (error) {
          this.reportBackgroundError?.(
            `[memory-checkup-prewarm] chat ${args.chatId} turn ${args.turnNumber ?? "?"}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    }

    const prepareTransferSources = async () => {
      // Automatic Transfer turn-end preparation (confirmed two-stage flow):
      // read memories from other conversations/projects and Encode only their
      // source-side portable rules. Relevance and Decode/landing deliberately
      // wait for the next prompt, whose task is required to judge both.
      if (this.memoryTransferDetect && this.policy.capture === "review") {
        try {
          await this.memoryTransferDetect.prepareSources({
            projectId: args.projectId,
            sessionId: args.chatId,
            projectTitle: args.projectId ? this.store.getProject(args.projectId)?.title : undefined,
          })
        } catch (error) {
          this.reportBackgroundError?.(
            `[memory-transfer-prepare] chat ${args.chatId} turn ${args.turnNumber ?? "?"}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    }

    // Both jobs read the post-capture library and own independent fallback +
    // error containment. Starting them together preserves correctness while
    // giving Transfer its full turn-end preparation window.
    await Promise.all([precomputeCheckup(), prepareTransferSources()])
  }

  setBackgroundErrorReporter(report: ((message: string) => void) | null) {
    this.reportBackgroundError = report
  }

  /**
   * A synchronous freeze check used after StudyRegistry reserves the task.
   * Pending gates and queued messages are unfinished user turns just as much
   * as a streaming reply, so ending the session while any exists is refused.
   */
  studyFreezeBlocker(): string | null {
    if (
      this.startingChats.size > 0
      || this.pendingAutoCaptureStarts.size > 0
      || this.activeTurns.size > 0
      || this.pendingPreviews.size > 0
      || this.claimedPreviewResponses.size > 0
      || this.pendingProposalGates.size > 0
      || this.pendingCheckupGates.size > 0
      || this.pendingTransferGates.size > 0
      || this.activePreparations.size > 0
      || this.inFlightCheckups.size > 0
    ) {
      return "The agent is still working or waiting for a memory decision. Finish or stop that turn first."
    }
    if (this.store.getChatIdsWithQueuedMessages().length > 0) {
      return "A queued message still belongs to this session. Let it finish or remove it first."
    }
    return null
  }

  /** Server-owned task evidence for the Finish gate and researcher dashboard. */
  studyTaskRunEvidence(taskId: string): {
    participantPromptCount: number
    completedAgentTurnCount: number
    unresolvedMemoryInterruptCount: number
  } {
    const promptEvents = (this.studyMemoryStore?.listStudyTelemetryEvents() ?? [])
      .filter((event) => event.kind === "participant_prompt" && event.taskId !== null)
    const promptTaskByTurnId = new Map<string, string>()
    for (const event of promptEvents) {
      const payloadTurnId = typeof event.payload.turnId === "string" ? event.payload.turnId : null
      const fallbackTurnId = event.eventId.split(":").at(-1) ?? null
      const turnId = payloadTurnId?.trim() || fallbackTurnId?.trim()
      if (turnId) promptTaskByTurnId.set(turnId, event.taskId!)
    }

    let completedAgentTurnCount = 0
    const interruptTaskById = new Map<string, string>()
    const resolvedInterruptIds = new Set<string>()
    const chatIds = new Set(promptEvents.map((event) => event.chatId).filter((id): id is string => Boolean(id)))
    for (const chatId of chatIds) {
      let currentTaskId: string | null = null
      let countedSuccessForPrompt = false
      for (const entry of this.store.getMessages(chatId)) {
        if (entry.kind === "user_prompt") {
          // Interrupt recovery reuses interruptId as the continuation turn id.
          // It is not a second participant prompt, but its successful result
          // still belongs to the task that owned the interrupted run.
          currentTaskId = promptTaskByTurnId.get(entry._id) ?? interruptTaskById.get(entry._id) ?? null
          countedSuccessForPrompt = false
          continue
        }
        if (
          entry.kind === "result"
          && entry.subtype === "success"
          && !entry.isError
          && currentTaskId === taskId
          && !countedSuccessForPrompt
        ) {
          completedAgentTurnCount += 1
          countedSuccessForPrompt = true
          continue
        }
        if (entry.kind === "memory_interrupt" && currentTaskId) {
          interruptTaskById.set(entry.interruptId, currentTaskId)
        } else if (entry.kind === "memory_interrupt_resolution") {
          resolvedInterruptIds.add(entry.interruptId)
        }
      }
    }

    return {
      participantPromptCount: promptEvents.filter((event) => event.taskId === taskId).length,
      completedAgentTurnCount,
      unresolvedMemoryInterruptCount: [...interruptTaskById]
        .filter(([interruptId, ownerTaskId]) => ownerTaskId === taskId && !resolvedInterruptIds.has(interruptId))
        .length,
    }
  }

  /** Wait only for questionnaire-changing Claude capture/trace work. */
  async awaitStudyMemorySettled(taskId: string): Promise<StudyMemoryQualityFlag[]> {
    // One explicit retry per freeze attempt also recovers a job that failed
    // earlier in this process. Persistent pending rows remain blocking if the
    // retry still cannot finish.
    this.resumePendingStaticFocusMaterializations(taskId)
    while (true) {
      const pending = [...this.inFlightStudyMemoryJobs]
        .filter((job) => job.taskId === taskId)
        .map((job) => job.promise)
      if (pending.length === 0) {
        for (const pendingClear of [...this.pendingStudyMemoryQualityClears.values()]) {
          if (pendingClear.taskId !== taskId) continue
          this.clearStudyMemoryQualityFlag(pendingClear)
        }
        const flags = [...(this.studyMemoryQualityByTask.get(taskId) ?? [])]
        // A transient SQLite error at the original failure site must not be
        // hidden forever by the in-memory dedupe. Retry every local terminal
        // flag before the immutable snapshot is allowed to form.
        for (const flag of flags) this.noteStudyMemoryQualityFlag(flag)
        for (const durable of this.studyMemoryStore?.listStudyMemoryQualityFlags(taskId) ?? []) {
          if (flags.some((flag) => (
            flag.code === durable.code
            && flag.chatId === durable.chatId
            && flag.turnId === durable.turnId
          ))) continue
          flags.push(durable as StudyMemoryQualityFlag)
        }
        for (const delivery of this.studyMemoryStore?.listPendingStaticFocusDeliveries({ taskId }) ?? []) {
          if (flags.some((flag) => (
            flag.blocking
            && flag.chatId === delivery.chatId
            && flag.turnId === delivery.turnId
          ))) continue
          flags.push(this.staticFocusFailure(delivery, "static_focus_pending"))
        }
        return flags
      }
      await Promise.all(pending)
    }
  }

  getActiveStatuses() {
    const statuses = new Map<string, ChatActivityStatus>()
    // Reservation phase first; a booted ActiveTurn (mutually exclusive by
    // invariant, but defensive) wins.
    for (const [chatId, status] of this.startingChats.entries()) {
      statuses.set(chatId, status)
    }
    for (const chatId of this.pendingAutoCaptureStarts.keys()) {
      statuses.set(chatId, "starting")
    }
    for (const [chatId, turn] of this.activeTurns.entries()) {
      statuses.set(chatId, turn.status)
    }
    return statuses
  }

  getPendingTool(chatId: string): PendingToolSnapshot | null {
    const pending = this.activeTurns.get(chatId)?.pendingTool
    if (!pending) return null
    return { toolUseId: pending.toolUseId, toolKind: pending.tool.toolKind }
  }

  getDrainingChatIds(): Set<string> {
    return new Set(this.drainingStreams.keys())
  }

  getStreamingAssistantTexts(): Map<string, string> {
    const texts = new Map<string, string>()
    for (const [chatId, buffer] of this.streamingAssistantTexts.entries()) {
      if (buffer.text) texts.set(chatId, buffer.text)
    }
    return texts
  }

  /** Fold an assistant_delta harness event into the chat's streaming buffer. */
  private appendAssistantDelta(chatId: string, event: HarnessEvent) {
    if (!event.delta) return
    const itemId = event.itemId ?? ""
    const current = this.streamingAssistantTexts.get(chatId)
    this.streamingAssistantTexts.set(chatId, {
      itemId,
      // A new message item starts a fresh reply (text → tools → more text).
      text: current && current.itemId === itemId ? current.text + event.delta : event.delta,
    })
    this.emitStateChange(chatId)
  }

  private clearStreamingAssistantText(chatId: string) {
    this.streamingAssistantTexts.delete(chatId)
  }

  private emitStateChange(chatId?: string, options?: { immediate?: boolean }) {
    this.onStateChange(chatId, options)
  }

  private refreshClaudeModelCatalog(session: ClaudeSessionHandle) {
    if (!session.supportedModels) return
    void session.supportedModels()
      .then((models) => {
        if (applyClaudeSdkModels(models)) {
          this.emitStateChange(undefined, { immediate: true })
        }
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        this.reportBackgroundError?.(`[claude-models] failed to refresh Claude model catalog: ${message}`)
      })
  }

  getActiveTurnProfile(chatId: string): SendToStartingProfile | null {
    const active = this.activeTurns.get(chatId)
    if (!active?.clientTraceId || active.profilingStartedAt === undefined) {
      return null
    }

    return {
      traceId: active.clientTraceId,
      startedAt: active.profilingStartedAt,
    }
  }

  async stopDraining(chatId: string) {
    const draining = this.drainingStreams.get(chatId)
    if (!draining) return
    draining.turn.close()
    this.drainingStreams.delete(chatId)
    this.emitStateChange(chatId)
  }

  async closeChat(chatId: string) {
    await this.stopDraining(chatId)
    const claudeSession = this.claudeSessions.get(chatId)
    if (claudeSession) {
      await this.retireClaudeSession(claudeSession, "chat_closed")
    }
    this.emitStateChange(chatId)
  }

  /** Recompute the exact live gate whose durable Board row was invalidated. */
  handleBoardBacklogInvalidated(input: { kind: "transfer" | "checkup"; chatId: string; gateId: string }) {
    if (input.kind === "transfer") {
      const pending = this.pendingTransferGates.get(input.chatId)
      if (pending?.transferId === input.gateId) pending.invalidate()
    } else {
      const pending = this.pendingCheckupGates.get(input.chatId)
      if (pending?.checkupId === input.gateId) pending.invalidate()
    }
    this.emitStateChange(input.chatId, { immediate: true })
  }

  /** Close every old-project query before the preview process group changes. */
  private async prepareStudyProjectRuntime(projectPath: string) {
    if (!this.studyPreviewRuntime) return
    const oldSessions = [...this.claudeSessions.values()].filter((session) => session.localPath !== projectPath)
    await Promise.all(oldSessions.map((session) => this.retireClaudeSession(session, "study_project_switch")))
    await this.studyPreviewRuntime.ensure(projectPath)
    const taskId = this.getActiveStudyTaskId()
    if (taskId) {
      const taskPaths = this.studyTaskProjectPaths.get(taskId) ?? new Set<string>()
      taskPaths.add(projectPath)
      this.studyTaskProjectPaths.set(taskId, taskPaths)
    }
  }

  /** Freeze boundary: close SDK queries, await pumps, then stop preview descendants. */
  async retireStudyTaskRuntime(taskId: string) {
    const chatIds = this.studyTaskChats.get(taskId) ?? new Set<string>()
    const sessions = [...chatIds]
      .map((chatId) => this.claudeSessions.get(chatId))
      .filter((session): session is ClaudeSessionState => Boolean(session))
    await Promise.all(sessions.map((session) => this.retireClaudeSession(session, `study_task_freeze:${taskId}`)))
    for (const projectPath of this.studyTaskProjectPaths.get(taskId) ?? []) {
      await this.studyPreviewRuntime?.stop(projectPath)
    }
  }

  async shutdownStudyRuntime() {
    await Promise.all(
      [...this.claudeSessions.values()].map((session) => this.retireClaudeSession(session, "server_shutdown")),
    )
    await this.studyPreviewRuntime?.stop()
  }

  private async retireClaudeSession(session: ClaudeSessionState, reason: string) {
    if (!session.retired) {
      session.retired = true
      session.retireReason = reason
      this.clearStreamingAssistantText(session.chatId)
      session.session.close()
    }
    if (!session.pump) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const drained = await Promise.race([
      session.pump.then(() => true),
      new Promise<false>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), this.claudeRetireTimeoutMs)
      }),
    ])
    if (timer) clearTimeout(timer)
    if (!drained) {
      const message = `[claude-retire-timeout] query pump for chat ${session.chatId} did not close within ${this.claudeRetireTimeoutMs}ms after ${reason}; refusing to replace the preview while the retired CLI may still mutate the workspace`
      this.reportBackgroundError?.(message)
      throw new Error(message)
    }
    if (this.claudeSessions.get(session.chatId) === session) {
      this.claudeSessions.delete(session.chatId)
    }
  }

  private resolveProvider(options: SendMessageOptions, currentProvider: AgentProvider | null) {
    if (currentProvider) return currentProvider
    return options.provider ?? "claude"
  }

  private getProviderSettings(provider: AgentProvider, options: SendMessageOptions) {
    const catalog = getServerProviderCatalog(provider)
    if (provider === "claude") {
      const model = normalizeServerModel(provider, options.model)
      const modelOptions = normalizeClaudeModelOptions(model, options.modelOptions, options.effort)
      return {
        model: resolveClaudeApiModelId(model, modelOptions.contextWindow),
        effort: modelOptions.reasoningEffort,
        serviceTier: undefined,
        planMode: catalog.supportsPlanMode ? Boolean(options.planMode) : false,
      }
    }

    const modelOptions = normalizeCodexModelOptions(options.modelOptions, options.effort)
    return {
      model: normalizeServerModel(provider, options.model),
      effort: modelOptions.reasoningEffort,
      serviceTier: codexServiceTierFromModelOptions(modelOptions),
      planMode: catalog.supportsPlanMode ? Boolean(options.planMode) : false,
    }
  }

  private assertStudyPromptAllowed(input: StudyPromptGateInput): void {
    const refusal = this.studyPromptGate?.(input)
    if (refusal) throw new Error(refusal)
  }

  private async enqueueMessage(
    chatId: string,
    content: string,
    attachments: ChatAttachment[],
    options?: SendMessageOptions,
    channel: "chat.send" | "message.enqueue" = "chat.send",
  ) {
    this.assertStudyPromptAllowed({ chatId, content, channel, attachments })
    const queued = await this.store.enqueueMessage(chatId, {
      content,
      attachments,
      provider: options?.provider,
      model: options?.model,
      modelOptions: options?.modelOptions,
      planMode: options?.planMode,
    })
    this.emitStateChange(chatId)
    return queued
  }

  private async dequeueAndStartQueuedMessage(
    chatId: string,
    queuedMessage: QueuedChatMessage,
    options?: {
      steered?: boolean
      deferredAutoStart?: DeferredAutoStartGuard
    },
  ): Promise<"started" | "cancelled" | "missing"> {
    const deferred = options?.deferredAutoStart
    if (deferred?.signal.aborted) return "cancelled"
    if (!this.store.getQueuedMessage(chatId, queuedMessage.id)) return "missing"
    if (this.isCancelledDeferredQueueRow(chatId, queuedMessage.id)) {
      try {
        await this.store.removeQueuedMessage(chatId, queuedMessage.id)
      } catch (error) {
        if (this.store.getQueuedMessage(chatId, queuedMessage.id)) {
          this.reportBackgroundError?.(
            `[auto-deferred-stop] chat ${chatId}: refused tombstoned queue row: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
      return "cancelled"
    }
    // Validate before removal so a rejected legacy queue item remains visible
    // and reviewable rather than disappearing during automatic/restart drain.
    this.assertStudyPromptAllowed({
      chatId,
      content: queuedMessage.content,
      channel: "queue.dispatch",
      attachments: queuedMessage.attachments,
    })
    if (deferred?.signal.aborted) return "cancelled"
    try {
      await this.store.removeQueuedMessage(chatId, queuedMessage.id)
    } catch (error) {
      // An external queue action can remove the observed head between the
      // scheduler's read and this durable dequeue. Re-read and let the caller
      // continue with the new head instead of treating that race as a failed
      // participant send.
      if (!this.store.getQueuedMessage(chatId, queuedMessage.id)) return "missing"
      throw error
    }
    if (deferred?.signal.aborted) return "cancelled"
    const chat = this.store.requireChat(chatId)
    const provider = this.resolveProvider(queuedMessage, chat.provider)
    const settings = this.getProviderSettings(provider, queuedMessage)
    if (deferred?.signal.aborted) return "cancelled"
    await this.startTurnForChat({
      chatId,
      provider,
      content: options?.steered ? buildSteeredMessageContent(queuedMessage.content) : queuedMessage.content,
      // Memory passes see the user's real words, never the steering wrapper (BUG AGENT-4).
      memoryUserText: options?.steered ? queuedMessage.content : undefined,
      attachments: queuedMessage.attachments,
      model: settings.model,
      effort: settings.effort,
      serviceTier: settings.serviceTier,
      planMode: settings.planMode,
      appendUserPrompt: true,
      steered: options?.steered,
      deferredAutoStart: deferred,
    })
    return deferred?.signal.aborted || deferred?.isCommittedCancellationRequested()
      ? "cancelled"
      : "started"
  }

  /**
   * After a restart, in-memory run state (activeTurns/pendingPreviews/
   * startingChats) is empty, but queued messages persisted to disk are replayed
   * back into the store. Nothing re-triggers them: send() only consults the
   * in-memory maps, so a chat that was mid-run at restart leaves its queue stuck
   * forever, and a fresh message jumps ahead of it, garbling turn order (BUG
   * CORE-2). Re-prime the pipeline by starting the head of every non-running
   * chat's queue; each turn's completion drains the next as usual.
   */
  async drainOrphanedQueues(): Promise<void> {
    for (const chatId of this.store.getChatIdsWithQueuedMessages()) {
      if (
        this.activeTurns.has(chatId)
        || this.hasPendingPreviewActivity(chatId)
        || this.startingChats.has(chatId)
        || this.pendingAutoCaptureStarts.has(chatId)
      ) {
        continue
      }
      try {
        await this.maybeStartNextQueuedMessage(chatId)
      } catch (error) {
        console.error(`[agent] failed to drain queued messages for chat ${chatId} on startup`, error)
      }
    }
  }

  private scheduleOpeningBoardRecovery(taskId: string): void {
    if (this.openingBoardRecoveryRetryTimers.has(taskId)) return
    const attempt = (this.openingBoardRecoveryRetryAttempts.get(taskId) ?? 0) + 1
    if (attempt > 3) return
    this.openingBoardRecoveryRetryAttempts.set(taskId, attempt)
    const delayMs = [100, 500, 1_500][attempt - 1]!
    const timer = setTimeout(() => {
      this.openingBoardRecoveryRetryTimers.delete(taskId)
      if (this.getActiveStudyTaskId() !== taskId) return
      try {
        this.resumeOpeningBoardPreparation()
      } catch (error) {
        // Shutdown/tests can close the durable store before a previously
        // scheduled retry fires. Keep the timer boundary fail-closed instead
        // of leaking an uncaught process error.
        this.reportBackgroundError?.(
          `[opening-board-recovery] task ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }, delayMs)
    timer.unref?.()
    this.openingBoardRecoveryRetryTimers.set(taskId, timer)
  }

  /**
   * Re-prime the exact first MemoSync prompt after a process restart. The
   * private Board receipt owns the participant text, uploads, and composer
   * settings; the durable review id is also the transcript turn id, so a
   * retry can never append or measure a second logical prompt.
   */
  resumeOpeningBoardPreparation(): void {
    const taskId = this.getActiveStudyTaskId()
    if (
      !taskId
      || !this.openingBoardBacklog
      || !this.policy.studyMode
      || this.policy.condition !== "memosync"
      || this.openingBoardRecoveryTasks.has(taskId)
    ) return
    const opening = this.openingBoardBacklog.recoverOpeningPrompt(taskId)
    if (!opening) return

    this.openingBoardRecoveryTasks.add(taskId)
    const recover = async () => {
      if (opening.attachmentFailure) {
        this.reportBackgroundError?.(
          `[opening-board-attachment] task ${taskId}: ${opening.attachmentFailure}`,
        )
        return
      }
      // Recovery is a trusted transport path, not an admission bypass. The
      // exact durable payload must still pass the same canonical study gate;
      // the already-written review id grants only the sanctioned Board
      // exception inside boardPromptRefusal.
      this.assertStudyPromptAllowed({
        chatId: opening.chatId,
        channel: "chat.send",
        content: opening.content,
        attachments: opening.providerAttachments,
        openingReviewId: opening.reviewId,
        verifiedOpeningSnapshot: true,
      })
      const provider = opening.dispatch?.provider ?? "claude"
      if (provider !== "claude") throw new Error("Opening Memory Board recovery only supports the study Claude provider")
      const settings = this.getProviderSettings(provider, opening.dispatch ?? {})
      if (opening.phase === "completed") {
        const messages = this.store.getMessages(opening.chatId)
        const promptIndex = messages.findIndex(
          (message) => message.kind === "user_prompt" && message._id === opening.reviewId,
        )
        const nextPromptIndex = promptIndex < 0
          ? -1
          : messages.findIndex((message, index) => index > promptIndex && message.kind === "user_prompt")
        const turnEntries = promptIndex < 0
          ? []
          : messages.slice(promptIndex + 1, nextPromptIndex < 0 ? undefined : nextPromptIndex)
        const preview = turnEntries.find(
          (message): message is Extract<TranscriptEntry, { kind: "memory_preview" }> => message.kind === "memory_preview",
        )
        if (preview) {
          const decision = turnEntries.filter(
            (message): message is Extract<TranscriptEntry, { kind: "memory_preview_decision" }> =>
              message.kind === "memory_preview_decision" && message.previewId === preview.previewId,
          ).at(-1)
          if (!decision) {
            this.restoreOpeningWorkingMemoryPreview(opening, settings, preview)
            return
          }
          const terminalResult = turnEntries.some((message) => message.kind === "result")
          if (decision.decision === "dismiss") {
            if (terminalResult) return
            // The decision is the participant-owned commit point. If the
            // process died before the turn ledger and transcript terminal were
            // written, finish that cancellation without ever booting Claude.
            await this.store.appendMessage(
              opening.chatId,
              timestamped({
                kind: "result",
                subtype: "cancelled",
                isError: false,
                durationMs: 0,
                result: "The first prompt was cancelled from Working Memory review.",
              }),
            )
            await this.store.recordTurnCancelled(opening.chatId)
            this.emitStateChange(opening.chatId, { immediate: true })
            return
          }
          if (decision.decision !== "go_on" && decision.decision !== "without_memory") return

          const exactDispatch = {
            taskId: opening.taskId,
            chatId: opening.chatId,
            reviewId: opening.reviewId,
            phase: opening.phase,
            previewId: preview.previewId,
            decision: decision.decision,
          } as const
          let delivered = this.studyMemoryStore?.listTaskDeliveries(opening.taskId).some((delivery) =>
            delivery.chatId === opening.chatId && delivery.turnId === opening.reviewId,
          ) ?? false
          let acceptedWithFailedFocusReceipt = this.studyMemoryStore
            ?.listStudyMemoryQualityFlags(opening.taskId)
            .some((flag) => flag.code === "focus_persistence_failed"
              && flag.chatId === opening.chatId
              && flag.turnId === opening.reviewId) ?? false
          if (opening.providerDispatch?.phase === "delivered" && !delivered && !acceptedWithFailedFocusReceipt) {
            try {
              const focus = opening.providerDispatch.focusDelivery
              const selectedIds = decision.decision === "without_memory"
                ? []
                : [...(decision.selectedIds ?? preview.memories.map((memory) => memory.id))]
              const selected = new Set(selectedIds)
              const previewById = new Map(preview.memories.map((memory) => [memory.id, memory]))
              const focusedIds = focus?.memories.map((memory) => memory.id) ?? []
              const expectedOutcome = decision.decision === "without_memory"
                ? "disabled"
                : selectedIds.length > 0 ? "delivered" : "empty"
              const validFocus = Boolean(
                focus
                && focus.taskId === opening.taskId
                && focus.chatId === opening.chatId
                && focus.sessionId === opening.chatId
                && focus.turnId === opening.reviewId
                && focus.turn === preview.turn
                && focus.engine === "claude"
                && focus.mode === "skills"
                && focus.deliveryStage === "queued_to_claude"
                && focus.outcome === expectedOutcome
                && focusedIds.length === selected.size
                && focusedIds.every((id) => selected.has(id))
                && focus.memories.every((memory) => {
                  const snapshot = previewById.get(memory.id)
                  return snapshot?.content === memory.content
                    && snapshot.scope === memory.scope
                    && memory.sourceRef.kind === "memosync_store"
                }),
              )
              if (!validFocus || !focus || !this.memory) {
                throw new Error("The accepted opening focus receipt is missing or does not match its Working Memory decision")
              }
              persistDeliveredStoreFocusEvent({
                event: focus,
                condition: "memosync",
                logger: this.memory.logger,
                studyStore: this.studyMemoryStore ?? undefined,
              })
              delivered = true
            } catch (error) {
              this.noteStudyMemoryQualityFlag({
                code: "focus_persistence_failed",
                blocking: true,
                taskId: opening.taskId,
                chatId: opening.chatId,
                turnId: opening.reviewId,
                turn: preview.turn,
              })
              acceptedWithFailedFocusReceipt = true
              this.reportBackgroundError?.(
                `[study-focus-recovery] chat ${opening.chatId} turn ${preview.turn}: ${error instanceof Error ? error.message : String(error)}`,
              )
            }
          }
          if (terminalResult) return
          const liveOwner = this.activeTurns.has(opening.chatId) || this.startingChats.has(opening.chatId)
          if (opening.providerDispatch?.phase === "dispatching" && delivered) {
            this.openingBoardBacklog!.settleOpeningProviderDispatch(exactDispatch, "delivered")
          }
          if (
            delivered
            || acceptedWithFailedFocusReceipt
            || opening.providerDispatch?.phase === "delivered"
            || opening.providerDispatch?.phase === "failed"
          ) {
            // In-process retries can observe the durable acceptance while the
            // provider still owns a live turn. A restarted coordinator has no
            // such owner: the external prompt must not be replayed, but the
            // participant still needs one explicit terminal and turn outcome.
            if (liveOwner) return
            const message = opening.providerDispatch?.phase === "failed"
              ? "The first prompt was not accepted by the provider and could not complete."
              : "The first prompt was accepted, but its reply was interrupted by a server restart. It was not sent again."
            await this.store.appendMessage(
              opening.chatId,
              timestamped({ kind: "result", subtype: "error", isError: true, durationMs: 0, result: message }),
            )
            await this.store.recordTurnFailed(opening.chatId, message)
            this.emitStateChange(opening.chatId, { immediate: true })
            return
          }
          if (opening.providerDispatch?.phase === "dispatching") {
            // Process death after the durable pre-send claim is ambiguous: the
            // external provider may have accepted it. Never risk a duplicate.
            this.openingBoardBacklog!.settleOpeningProviderDispatch(exactDispatch, "failed")
            const message = "The first prompt could not be safely resumed after provider dispatch was interrupted."
            await this.store.appendMessage(
              opening.chatId,
              timestamped({ kind: "result", subtype: "error", isError: true, durationMs: 0, result: message }),
            )
            await this.store.recordTurnFailed(opening.chatId, message)
            this.emitStateChange(opening.chatId, { immediate: true })
            return
          }
          await this.resumeOpeningWorkingMemoryDecision(opening, settings, preview, decision)
          return
        }
      }
      if (opening.phase === "dispatch_pending") {
        this.openingBoardBacklog!.claimOpeningPromptDispatch(opening)
      }
      const chat = this.store.getChat(opening.chatId)
      if (!chat) throw new Error("The opening Memory Board chat no longer exists")
      await this.startTurnForChat({
        chatId: opening.chatId,
        provider,
        content: opening.content,
        attachments: opening.attachments,
        providerAttachments: opening.providerAttachments,
        model: settings.model,
        effort: settings.effort,
        serviceTier: settings.serviceTier,
        planMode: settings.planMode,
        appendUserPrompt: true,
        turnId: opening.reviewId,
        openingReview: { taskId: opening.taskId, reviewId: opening.reviewId },
        openingLongTermAlreadyReady: opening.phase === "long_term_ready" || opening.phase === "completed",
        openingLongTermRevision: opening.longTermRevision ?? 0,
      })
    }
    void recover()
      .catch((error) => {
        this.reportBackgroundError?.(
          `[opening-board-recovery] task ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
        )
        this.scheduleOpeningBoardRecovery(taskId)
      })
      .finally(() => this.openingBoardRecoveryTasks.delete(taskId))
  }

  private restoreOpeningWorkingMemoryPreview(
    opening: MemoryBoardOpeningPromptRecovery,
    settings: ReturnType<AgentCoordinator["getProviderSettings"]>,
    preview: Extract<TranscriptEntry, { kind: "memory_preview" }>,
  ) {
    if (!this.memory || this.pendingPreviews.has(opening.chatId)) return
    const chat = this.store.requireChat(opening.chatId)
    const project = this.store.getProject(chat.projectId)
    if (!project) throw new Error("The opening Memory Board project no longer exists")
    const memories = preview.memories.map(({ id }) => this.memory!.store.getById(id))
    if (memories.some((memory) => !memory)) {
      throw new Error("The durable Working Memory pool no longer matches the memory store")
    }
    const messages = this.store.getMessages(opening.chatId)
    const expectedUses = messages.filter(
      (message): message is Extract<TranscriptEntry, { kind: "memory_preview_relevance" }> =>
        message.kind === "memory_preview_relevance" && message.previewId === preview.previewId,
    ).at(-1)?.expectedUses ?? []
    const args: StartTurnArgs = {
      chatId: opening.chatId,
      provider: "claude",
      content: opening.content,
      attachments: opening.attachments,
      providerAttachments: opening.providerAttachments,
      model: settings.model,
      effort: settings.effort,
      serviceTier: settings.serviceTier,
      planMode: settings.planMode,
      appendUserPrompt: true,
      turnId: opening.reviewId,
      openingReview: { taskId: opening.taskId, reviewId: opening.reviewId },
      openingLongTermAlreadyReady: true,
    }
    const memoryIds = preview.memories.map(({ id }) => id)
    const pending: PendingMemoryPreview = {
      previewId: preview.previewId,
      revision: 0,
      published: true,
      memoryIds,
      task: preview.task ?? opening.content,
      memories: memories as MemoryItem[],
      expectedUseById: new Map(expectedUses.map((use) => [use.id, use.expectedUse])),
      respond: (decision, selectedIds, authoritativeExpectedUses, controlOperation) => {
        void this.finishMemoryPreview({
          args,
          chat,
          project,
          turnNumber: preview.turn ?? 1,
          previewId: preview.previewId,
          memoryIds,
          decision,
          selectedIds,
          expectedUses: authoritativeExpectedUses,
          controlOperation,
        })
      },
    }
    this.pendingPreviews.set(opening.chatId, pending)
    this.emitStateChange(opening.chatId, { immediate: true })
  }

  /** Resume only the provider half after the Working Memory decision itself
   * was durable. This deliberately does not append/log that decision again. */
  private async resumeOpeningWorkingMemoryDecision(
    opening: MemoryBoardOpeningPromptRecovery,
    settings: ReturnType<AgentCoordinator["getProviderSettings"]>,
    preview: Extract<TranscriptEntry, { kind: "memory_preview" }>,
    decision: Extract<TranscriptEntry, { kind: "memory_preview_decision" }>,
  ) {
    if (decision.decision !== "go_on" && decision.decision !== "without_memory") return
    const chat = this.store.requireChat(opening.chatId)
    const project = this.store.getProject(chat.projectId)
    if (!project) throw new Error("The opening Memory Board project no longer exists")
    if (decision.decision === "go_on" && decision.selectedIds) {
      this.turnMemoryRestriction.set(opening.chatId, decision.selectedIds)
    }
    if (decision.decision === "go_on" && decision.expectedUses?.length) {
      this.turnExpectedUses.set(opening.chatId, decision.expectedUses)
    }
    const args: StartTurnArgs = {
      chatId: opening.chatId,
      provider: "claude",
      content: opening.content,
      attachments: opening.attachments,
      providerAttachments: opening.providerAttachments,
      model: settings.model,
      effort: settings.effort,
      serviceTier: settings.serviceTier,
      planMode: settings.planMode,
      appendUserPrompt: true,
      turnId: opening.reviewId,
      openingReview: { taskId: opening.taskId, reviewId: opening.reviewId },
      openingLongTermAlreadyReady: true,
      openingWorkingMemory: { previewId: preview.previewId, decision: decision.decision },
    }
    this.startingChats.set(opening.chatId, "starting")
    try {
      await this.bootEngineTurn(this.refreshOpeningProviderAttachments(args), {
        chat,
        project,
        turnNumber: preview.turn ?? 1,
        memoryDisabledForTurn: decision.decision === "without_memory",
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.store.appendMessage(
        opening.chatId,
        timestamped({ kind: "result", subtype: "error", isError: true, durationMs: 0, result: message }),
      )
      await this.store.recordTurnFailed(opening.chatId, message)
      this.emitStateChange(opening.chatId, { immediate: true })
      throw error
    } finally {
      this.startingChats.delete(opening.chatId)
    }
  }

  private async maybeStartNextQueuedMessage(chatId: string) {
    if (this.activeTurns.has(chatId)) return false
    const nextQueuedMessage = await this.nextDispatchableQueuedMessage(chatId)
    if (!nextQueuedMessage) return false
    const chat = this.store.getChat(chatId)
    const provider = this.resolveProvider(nextQueuedMessage, chat?.provider ?? null)
    if (this.shouldQueueBehindAutoCapture(provider)) {
      // q2 may have been enqueued while q1 was still active. q1 completion
      // starts broad Auto capture before draining its queue; use the same
      // durable, cancellable owner as an idle direct send instead of removing
      // q2 and blocking invisibly inside startTurnForChat's barrier.
      this.scheduleAutoCaptureQueueDrain(chatId, nextQueuedMessage.id)
      return true
    }
    await this.dequeueAndStartQueuedMessage(chatId, nextQueuedMessage)
    return true
  }

  private async startTurnForChat(args: StartTurnArgs) {
    const deferred = args.deferredAutoStart
    if (deferred?.signal.aborted) return
    const logicalTurnId = args.turnId ?? crypto.randomUUID()
    args.turnId = logicalTurnId
    logSendToStartingProfile(args.profile, "start_turn.begin", {
      chatId: args.chatId,
      provider: args.provider,
      appendUserPrompt: args.appendUserPrompt,
      planMode: args.planMode,
    })

    // Close any lingering draining stream before starting a new turn.
    const draining = this.drainingStreams.get(args.chatId)
    if (draining) {
      draining.turn.close()
      this.drainingStreams.delete(args.chatId)
    }

    const chat = this.store.requireChat(args.chatId)
    if (this.activeTurns.has(args.chatId) || this.hasPendingPreviewActivity(args.chatId) || this.startingChats.has(args.chatId)) {
      throw new Error("Chat is already running")
    }
    // Hold the reservation across every await below (preview pass, engine boot)
    // until the turn hands off to pendingPreviews (parked) or activeTurns (booted).
    this.startingChats.set(args.chatId, "starting")
    // A fresh turn starts unrestricted — an edited gate only scoped the
    // PREVIOUS turn's injection.
    this.turnMemoryRestriction.delete(args.chatId)
    let reservationHandedOff = false
    try {
    if (!chat.provider) {
      await this.store.setChatProvider(args.chatId, args.provider)
      logSendToStartingProfile(args.profile, "start_turn.provider_set", {
        chatId: args.chatId,
        provider: args.provider,
      })
    }
    await this.store.setPlanMode(args.chatId, args.planMode)
    logSendToStartingProfile(args.profile, "start_turn.plan_mode_set", {
      chatId: args.chatId,
      planMode: args.planMode,
    })

    const existingMessages = this.store.getMessages(args.chatId)
    // A recovery retry reuses one logical user-prompt entry. The first attempt
    // may have durably recorded the continuation before the provider boot
    // failed; duplicating that prompt would also invent a second turn number.
    let userPromptEntry = (args.resume || args.openingReview)
      ? existingMessages.find(
          (message): message is Extract<TranscriptEntry, { kind: "user_prompt" }> =>
            message.kind === "user_prompt" && message._id === logicalTurnId,
        )
      : undefined
    const logicalPromptAlreadyAppended = Boolean(userPromptEntry)
    const shouldAppendUserPrompt = args.appendUserPrompt && !logicalPromptAlreadyAppended
    const shouldGenerateTitle = shouldAppendUserPrompt && chat.title === "New Chat" && existingMessages.length === 0
    const optimisticTitle = shouldGenerateTitle ? fallbackTitleFromMessage(args.content) : null
    // 1-based user-visible turn number (memory provenance + the post-turn passes).
    const turnNumber =
      existingMessages.filter((m) => m.kind === "user_prompt").length + (shouldAppendUserPrompt ? 1 : 0)

    if (optimisticTitle) {
      await this.store.renameChat(args.chatId, optimisticTitle)
      logSendToStartingProfile(args.profile, "start_turn.optimistic_title_set", {
        chatId: args.chatId,
        title: optimisticTitle,
      })
    }

    const project = this.store.getProject(chat.projectId)
    if (!project) {
      throw new Error("Project not found")
    }

    if (this.policy.condition === "auto" && args.provider === "claude") {
      await this.awaitAutoProjectCaptureBarrier()
    }

    // Stop can arrive while durable dequeue or any pre-delivery store await is
    // in flight. The queued row has already been claimed, but the participant
    // prompt and Claude process must remain untouched.
    if (deferred?.signal.aborted) return

    if (shouldAppendUserPrompt) {
      userPromptEntry = {
        ...timestamped(
          {
            kind: "user_prompt",
            content: args.content,
            participantContent: args.memoryUserText ?? args.content,
            attachments: args.attachments,
            steered: args.steered,
          },
          Date.now(),
        ),
        _id: logicalTurnId,
      } as Extract<TranscriptEntry, { kind: "user_prompt" }>
      const appended = await this.store.appendMessage(
        args.chatId,
        userPromptEntry,
        deferred
          ? { shouldAppend: deferred.authorizeDelivery }
          : undefined,
      )
      // Stop won while this append was waiting on EventStore's serialized
      // writer. No user_prompt became durable, so this is not a started turn.
      if (appended === false) return
      logSendToStartingProfile(args.profile, "start_turn.user_prompt_appended", {
        chatId: args.chatId,
        entryId: userPromptEntry._id,
      })
    }

    const openingIdentity = args.openingReview
      ? { taskId: args.openingReview.taskId, chatId: args.chatId, reviewId: args.openingReview.reviewId }
      : null
    const openingBookkeeping = openingIdentity && this.openingBoardBacklog
      ? this.openingBoardBacklog.openingPromptBookkeeping(openingIdentity)
      : null
    const openingPromptIndex = userPromptEntry
      ? existingMessages.findIndex((message) => message._id === userPromptEntry?._id)
      : -1
    const hasDurableOpeningProgress = openingPromptIndex >= 0
      && existingMessages.some((_message, index) => index > openingPromptIndex)
    const shouldReconcileOpeningPrompt = Boolean(
      logicalPromptAlreadyAppended
      && openingIdentity
      && !args.openingLongTermAlreadyReady
      && !hasDurableOpeningProgress,
    )
    if (userPromptEntry && (shouldAppendUserPrompt || (
      shouldReconcileOpeningPrompt && !openingBookkeeping?.participantPromptRecorded
    ))) {
      const telemetryTaskId = this.onParticipantPromptRecorded ? this.getActiveStudyTaskId() : null
      if (this.onParticipantPromptRecorded && telemetryTaskId) {
        const telemetryInput = {
          taskId: telemetryTaskId,
          turnId: logicalTurnId,
          chatId: args.chatId,
          content: userPromptEntry.participantContent ?? userPromptEntry.content,
          attachments: userPromptEntry.attachments ?? [],
          acceptedAt: new Date(userPromptEntry.createdAt).toISOString(),
        }
        const persist = () => {
          try {
            this.onParticipantPromptRecorded?.(telemetryInput)
            if (openingIdentity) {
              this.openingBoardBacklog?.markOpeningPromptBookkeeping(openingIdentity, {
                participantPromptRecorded: true,
              })
            }
          } catch (error) {
            // The prompt already has a durable transcript identity. Never
            // reject the send and induce a duplicate prompt; retry the same
            // deterministic telemetry id until SQLite accepts it.
            this.reportBackgroundError?.(
              `[study-telemetry] prompt ${logicalTurnId}: ${error instanceof Error ? error.message : String(error)}`,
            )
            setTimeout(persist, 1_000)
          }
        }
        persist()
      }
    }
    if (!logicalPromptAlreadyAppended || (
      shouldReconcileOpeningPrompt && !openingBookkeeping?.turnStarted
    )) {
      await this.store.recordTurnStarted(args.chatId)
      if (openingIdentity) {
        this.openingBoardBacklog?.markOpeningPromptBookkeeping(openingIdentity, { turnStarted: true })
      }
      deferred?.markTurnStarted()
      logSendToStartingProfile(args.profile, "start_turn.turn_started_recorded", {
        chatId: args.chatId,
      })
    }

    // Once shouldAppend authorized the durable write, finish the normal
    // turn-start record before honoring Stop. This keeps a delivered prompt
    // from becoming an untracked half-turn, while still preventing Claude boot.
    if (deferred?.isCommittedCancellationRequested()) return

    if (shouldGenerateTitle) {
      void this.generateTitleInBackground(args.chatId, args.content, project.localPath, optimisticTitle ?? "New Chat")
    }

    if (deferred?.signal.aborted || deferred?.isCommittedCancellationRequested()) return

    // Per-turn memory Preview gate (SPEC §4.10b): before the engine acts, show
    // the injection receipt — exactly which memories the turn carries — then
    // PARK the turn until the user decides go on / dismiss / proceed without
    // memory. Parking (not blocking) matters: the chat.send ack must return so
    // the client can subscribe and actually see the preview card.
    // Preview failures never block the turn (degrade to no-preview).
    // The gate is a user setting (STUDY_PLAN §2.4): it can be disabled outright,
    // and an empty injected set can auto-proceed (recorded, not parked).
    const previewSettings = this.getMemoryPreviewSettings()
    // A resume-after-interrupt skips every gate: candidates/transfer/checkup
    // were reviewed this session already and the recovery card confirmed the
    // working memory (2026-08-19 C2).
    if (this.memoryPreview && this.memory && args.appendUserPrompt && previewSettings.enabled && !args.resume) {
      // The plan (not the raw item store) defines what the model will see.
      const plan = planMemoryInjection({
        policy: this.policy,
        provider: args.provider,
        memory: this.memory,
        projectId: chat.projectId,
        chatId: args.chatId,
        workspaceDir: project.localPath,
      })
      // Run the gate whenever there are item-based memories to reason about
      // (skills/plain modes) — EVEN when the injected set is empty. An empty
      // plan is not "no gate": runPreviewGateThenBoot records the (empty)
      // preview and either auto-proceeds (setting on) or parks for an explicit
      // decision (setting off) (BUG AGENT-5). File mode has no items to gate.
      if (plan.mode !== "file") {
        // The gate waits on a human — that must not hold the caller's ws ack:
        // the client reads a held ack (10s timeout) as a dead socket,
        // misreports the DELIVERED message as failed, and resurrects the
        // composer draft. The prompt is committed above, so ack now; the gate
        // + boot continue detached, taking the startingChats reservation with
        // them. The status broadcast is synchronous — subscribers learn about
        // the wait before the ack returns.
        this.startingChats.set(args.chatId, "previewing_memory")
        this.emitStateChange(args.chatId, { immediate: true })
        reservationHandedOff = true
        void this.runPreviewGateThenBoot(args, { chat, project, turnNumber, injected: plan.injectedMemories })
        return
      }
    }

    if (deferred?.signal.aborted || deferred?.isCommittedCancellationRequested()) return
    await this.bootEngineTurn(args, { chat, project, turnNumber, memoryDisabledForTurn: false })
    } finally {
      // By now the turn is parked (pendingPreviews) or booted (activeTurns);
      // either way those guard the chat, so releasing the reservation is safe.
      // The detached preview continuation owns (and releases) the reservation
      // it was handed — the early-return above must not release it here.
      if (!reservationHandedOff) this.startingChats.delete(args.chatId)
    }
  }

  /**
   * Step-one container 1 (redesign 2026-08-07 §3): fast-parse the prompt for
   * explicit remember-requests, gather this conversation's pending candidates,
   * and when any exist park the turn on a review gate the user must settle
   * (review or explicit skip) before the injection preview. "none" = nothing
   * to review, stage skipped entirely — zero friction on ordinary messages.
   */
  private async runProposalsGate(
    args: StartTurnArgs,
    ctx: { project: NonNullable<ReturnType<EventStore["getProject"]>>; turnNumber: number },
    options?: { proposalsId?: string; recompute?: boolean },
  ): Promise<{ decision: "none" | "reviewed" | "skipped" | "cancelled"; proposalsId: string }> {
    const existingMessages = args.openingReview ? this.store.getMessages(args.chatId) : []
    const existingParent = existingMessages.filter(
      (message): message is Extract<TranscriptEntry, { kind: "memory_proposals" }> =>
        message.kind === "memory_proposals" && message.openingReviewId === args.openingReview?.reviewId,
    ).at(-1)
    const proposalsId = options?.proposalsId ?? existingParent?.proposalsId ?? crypto.randomUUID()
    if (existingParent && !options?.recompute) {
      const existingDecision = existingMessages.filter(
        (message): message is Extract<TranscriptEntry, { kind: "memory_proposals_decision" }> =>
          message.kind === "memory_proposals_decision" && message.proposalsId === proposalsId,
      ).at(-1)?.decision
      if (existingDecision === "reviewed" || existingDecision === "skipped" || existingDecision === "cancelled") {
        return { decision: existingDecision, proposalsId }
      }
      if (existingDecision === "empty") return { decision: "none", proposalsId }
      if (existingDecision === "expired") return { decision: "cancelled", proposalsId }

      const existingResult = existingMessages.filter(
        (message): message is Extract<TranscriptEntry, { kind: "memory_proposals_result" }> =>
          message.kind === "memory_proposals_result" && message.proposalsId === proposalsId,
      ).at(-1)
      if (existingResult) {
        if (existingResult.candidates.length === 0) {
          await this.store.appendMessage(
            args.chatId,
            timestamped({ kind: "memory_proposals_decision", proposalsId, decision: "empty" }),
          )
          this.memory!.logger.event({
            type: "memory.proposals",
            sessionId: args.chatId,
            engine: args.provider,
            turn: ctx.turnNumber,
            count: 0,
            decision: "empty",
          })
          return { decision: "none", proposalsId }
        }
        const decision = await this.parkExistingProposalsGate(args, ctx, proposalsId)
        return { decision, proposalsId }
      }
    }
    const prep = this.activePreparations.get(args.chatId)
    if (prep) prep.proposalsId = proposalsId
    // Publish the Step 1 shell before the prompt-side capture pass. The user
    // now sees the same left-to-right skeleton used by Step 2 and injection,
    // rather than a generic processing line followed by a sudden card.
    if (!existingParent) {
      await this.store.appendMessage(
        args.chatId,
        timestamped({
          kind: "memory_proposals",
          proposalsId,
          openingReviewId: args.openingReview?.reviewId,
          turn: ctx.turnNumber,
          pending: true,
          candidates: [],
        }),
      )
      this.emitStateChange(args.chatId, { immediate: true })
    }

    // The parse has its own hard timeout, but Stop must not wait for it. Keep a
    // terminal handler attached to the detached task so a late rejection never
    // becomes unhandled; the shared phase signal wins the public gate race.
    if (!prep?.cancellation.signal.aborted) {
      const captureTask = this.capture!.captureFromPrompt({
        projectId: ctx.project.id,
        sessionId: args.chatId,
        turn: ctx.turnNumber,
        engine: args.provider,
        userText: args.memoryUserText ?? args.content,
        signal: prep?.cancellation.signal,
      }).then(
        () => ({ kind: "done" as const }),
        (error: unknown) => ({ kind: "error" as const, error }),
      )
      const captureOutcome = prep
        ? await Promise.race([
            captureTask,
            prep.cancellation.requested.then(() => ({ kind: "cancelled" as const })),
          ])
        : await captureTask
      if (captureOutcome.kind === "error") {
        const error = captureOutcome.error
        this.reportBackgroundError?.(
          `[memory-proposals] chat ${args.chatId} turn ${ctx.turnNumber}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    // This conversation's changes only: captured here, or session-scoped here.
    // Unreviewed candidates from other sessions belong to the Board, not to
    // this chat's turn start.
    const pending = this.memory!.store
      .list({ status: "candidate" })
      .filter((m) => m.provenanceSessionId === args.chatId || m.sessionId === args.chatId)
    await this.store.appendMessage(
      args.chatId,
      timestamped({
        kind: "memory_proposals_result",
        proposalsId,
        candidates: pending.map((candidate) => ({ id: candidate.id })),
      }),
    )

    // Stop landed during the parse await: cancel() already recorded the
    // interruption. PEEK — never consume: the Transfer coroutine running
    // beside us needs to observe the same flag; the caller's finally clears
    // it. Settle the visible shell before unwinding so it never remains a
    // permanent loading card.
    if (prep?.cancellation.signal.aborted || this.cancelledDuringPreview.has(args.chatId)) {
      await this.store.appendMessage(
        args.chatId,
        timestamped({ kind: "memory_proposals_decision", proposalsId, decision: "cancelled" }),
      )
      this.memory!.logger.event({
        type: "memory.proposals",
        sessionId: args.chatId,
        engine: args.provider,
        turn: ctx.turnNumber,
        count: pending.length,
        decision: "cancelled",
      })
      this.emitStateChange(args.chatId, { immediate: true })
      return { decision: "cancelled", proposalsId }
    }

    if (pending.length === 0) {
      // The step still announces itself (user feedback 2026-08-07: silence
      // read as "did Step 1 even run?"): one quiet line, settled immediately,
      // nothing parked.
      await this.store.appendMessage(
        args.chatId,
        timestamped({ kind: "memory_proposals_decision", proposalsId, decision: "empty" }),
      )
      this.memory!.logger.event({
        type: "memory.proposals",
        sessionId: args.chatId,
        engine: args.provider,
        turn: ctx.turnNumber,
        count: 0,
        decision: "empty",
      })
      return { decision: "none", proposalsId }
    }

    const decision = await new Promise<"reviewed" | "skipped" | "cancelled">((resolve) => {
      this.pendingProposalGates.set(args.chatId, {
        proposalsId,
        published: true,
        respond: (d) => {
          this.pendingProposalGates.delete(args.chatId)
          resolve(d)
        },
      })
      this.emitStateChange(args.chatId, { immediate: true })
    })

    await this.store.appendMessage(
      args.chatId,
      timestamped({ kind: "memory_proposals_decision", proposalsId, decision }),
    )
    this.memory!.logger.event({
      type: "memory.proposals",
      sessionId: args.chatId,
      engine: args.provider,
      turn: ctx.turnNumber,
      count: pending.length,
      decision,
    })
    // Cancellation bookkeeping (interrupted + turn record) lives in cancel()
    // — with two gates parked side by side it must happen exactly once.
    if (decision === "cancelled") this.emitStateChange(args.chatId, { immediate: true })
    return { decision, proposalsId }
  }

  /** Re-open the already-published Step 1 parent without re-running capture. */
  private async parkExistingProposalsGate(
    args: StartTurnArgs,
    ctx: { turnNumber: number },
    proposalsId: string,
  ): Promise<"reviewed" | "skipped" | "cancelled"> {
    const messages = this.store.getMessages(args.chatId)
    const parent = messages.find(
      (message): message is Extract<TranscriptEntry, { kind: "memory_proposals" }> =>
        message.kind === "memory_proposals" && message.proposalsId === proposalsId,
    )
    const result = messages
      .filter(
        (message): message is Extract<TranscriptEntry, { kind: "memory_proposals_result" }> =>
          message.kind === "memory_proposals_result" && message.proposalsId === proposalsId,
      )
      .at(-1)
    if (!parent) throw new Error("Memory candidate review is no longer available")
    const candidates = result?.candidates ?? parent.candidates

    const decision = await new Promise<"reviewed" | "skipped" | "cancelled">((resolve) => {
      this.pendingProposalGates.set(args.chatId, {
        proposalsId,
        published: true,
        respond: (next) => {
          this.pendingProposalGates.delete(args.chatId)
          resolve(next)
        },
      })
      this.emitStateChange(args.chatId, { immediate: true })
    })

    await this.store.appendMessage(
      args.chatId,
      timestamped({ kind: "memory_proposals_decision", proposalsId, decision }),
    )
    this.memory!.logger.event({
      type: "memory.proposals",
      sessionId: args.chatId,
      engine: args.provider,
      turn: ctx.turnNumber,
      count: candidates.length,
      decision,
    })
    // Cancellation bookkeeping lives in cancel() (see runProposalsGate).
    if (decision === "cancelled") this.emitStateChange(args.chatId, { immediate: true })
    return decision
  }

  /**
   * Move backward from Step 2 to the already-published Step 1, then mark
   * Step 2 for recomputation. Used both before and after the injected-set
   * preview exists so the user sees one consistent transition.
   */
  private async reopenProposalsBeforeCheckup(input: {
    args: StartTurnArgs
    ctx: { turnNumber: number }
    proposalsId: string
    checkupId: string
    revision: number
    previewId?: string
  }): Promise<{ cancelled: boolean; revision: number }> {
    const { args, ctx, proposalsId, checkupId, previewId } = input
    const revision = input.revision + 1
    this.memory!.logger.event({
      type: "memory.preparation_reopen",
      sessionId: args.chatId,
      engine: args.provider,
      turn: ctx.turnNumber,
      from: "proposals",
      revision,
    })
    await this.store.appendMessage(
      args.chatId,
      timestamped({
        kind: "memory_preparation_reset",
        ...(previewId ? { previewId } : {}),
        revision,
        from: "proposals",
        proposalsId,
        checkupId,
      }),
    )
    this.emitStateChange(args.chatId, { immediate: true })

    const proposalsDecision = await this.parkExistingProposalsGate(args, ctx, proposalsId)
    if (proposalsDecision === "cancelled") return { cancelled: true, revision }

    await this.store.appendMessage(
      args.chatId,
      timestamped({
        kind: "memory_preparation_reset",
        ...(previewId ? { previewId } : {}),
        revision,
        from: "checkup",
        proposalsId,
        checkupId,
      }),
    )
    this.emitStateChange(args.chatId, { immediate: true })
    return { cancelled: false, revision }
  }

  /** Mirror of reopenProposalsBeforeCheckup for the Transfer card: reset,
   * re-park the published card, then reset Step 2 to its skeleton. */
  private async reopenTransferBeforeCheckup(input: {
    args: StartTurnArgs
    ctx: {
      chat: ReturnType<EventStore["requireChat"]>
      project: NonNullable<ReturnType<EventStore["getProject"]>>
      turnNumber: number
    }
    transferId: string
    checkupId: string
    revision: number
    previewId?: string
  }): Promise<{ cancelled: boolean; revision: number }> {
    const { args, ctx, transferId, checkupId, previewId } = input
    const revision = input.revision + 1
    this.memory!.logger.event({
      type: "memory.preparation_reopen",
      sessionId: args.chatId,
      engine: args.provider,
      turn: ctx.turnNumber,
      from: "transfer",
      revision,
    })
    await this.store.appendMessage(
      args.chatId,
      timestamped({
        kind: "memory_preparation_reset",
        ...(previewId ? { previewId } : {}),
        revision,
        from: "transfer",
        transferId,
        checkupId,
      }),
    )
    this.emitStateChange(args.chatId, { immediate: true })

    const transferDecision = await this.parkExistingTransferGate(args, ctx, transferId)
    if (transferDecision === "cancelled") return { cancelled: true, revision }

    await this.store.appendMessage(
      args.chatId,
      timestamped({
        kind: "memory_preparation_reset",
        ...(previewId ? { previewId } : {}),
        revision,
        from: "checkup",
        transferId,
        checkupId,
      }),
    )
    this.emitStateChange(args.chatId, { immediate: true })
    return { cancelled: false, revision }
  }

  /**
   * Re-open the already-published Transfer card without re-running detection:
   * replay the last result's suggestions (CAS-dropping any whose source
   * changed), park, and record the fresh decision.
   */
  private async parkExistingTransferGate(
    args: StartTurnArgs,
    ctx: {
      chat: ReturnType<EventStore["requireChat"]>
      project: NonNullable<ReturnType<EventStore["getProject"]>>
      turnNumber: number
    },
    transferId: string,
  ): Promise<"none" | TransferGateDecision> {
    const messages = this.store.getMessages(args.chatId)
    const parent = messages.find(
      (message): message is Extract<TranscriptEntry, { kind: "memory_transfer" }> =>
        message.kind === "memory_transfer" && message.transferId === transferId,
    )
    if (!parent) throw new Error("Memory transfer review is no longer available")
    const result = messages
      .filter(
        (message): message is Extract<TranscriptEntry, { kind: "memory_transfer_result" }> =>
          message.kind === "memory_transfer_result" && message.transferId === transferId,
      )
      .at(-1)
    const suggestions = result?.suggestions ?? parent.suggestions

    const decision = await new Promise<InternalGateWake<TransferGateDecision>>((resolve) => {
      this.pendingTransferGates.set(args.chatId, {
        transferId,
        published: true,
        respond: (next) => {
          this.pendingTransferGates.delete(args.chatId)
          resolve(next)
        },
        invalidate: () => {
          this.pendingTransferGates.delete(args.chatId)
          resolve("invalidated")
        },
      })
      this.emitStateChange(args.chatId, { immediate: true })
    })

    if (decision === "invalidated") {
      return (await this.runTransferGate(args, ctx, Promise.resolve(), {
        transferId,
        recompute: true,
      })).decision
    }

    await this.store.appendMessage(
      args.chatId,
      timestamped({ kind: "memory_transfer_decision", transferId, decision }),
    )
    this.memory!.logger.event({
      type: "memory.transfer_card",
      sessionId: args.chatId,
      engine: args.provider,
      turn: ctx.turnNumber,
      suggestions: suggestions.length,
      decision,
    })
    // Cancellation bookkeeping lives in cancel() (see runProposalsGate).
    if (decision === "cancelled") this.emitStateChange(args.chatId, { immediate: true })
    return decision
  }

  private transferSnapshotOf(card: TransferSuggestionProgress | TransferSuggestionCard) {
    return {
      sourceId: card.sourceId,
      sourceContent: card.sourceContent,
      sourceScope: card.sourceScope,
      sourceVersion: card.sourceVersion,
      sourceLabel: card.sourceLabel,
      ...(card.encoding ? { rule: card.encoding.rule } : {}),
      ...(card.encoding?.applicability ? { applicability: card.encoding.applicability } : {}),
      ...(card.encoding?.stripped?.length ? { stripped: card.encoding.stripped } : {}),
      ...(card.decoding
        ? {
            content: card.decoding.content,
            abstractionLevel: card.decoding.abstractionLevel,
            suggestedScope: card.decoding.suggestedScope,
            landing: card.decoding.landing,
          }
        : {}),
      ...(card.decoding?.bound?.length ? { bound: card.decoding.bound } : {}),
      ...(card.decoding?.detail ? { detail: card.decoding.detail } : {}),
      ...(card.decoding?.note ? { note: card.decoding.note } : {}),
    }
  }

  /**
   * The Transfer card (Transfer design 2026-08-08, presentation revised on
   * user feedback the same day). The COMPUTATION is parallel with Step 1;
   * the PRESENTATION is staged — perception and implementation deliberately
   * differ:
   * - NOTHING publishes while Step 1 is still undecided (user ruling
   *   2026-08-09: the card appearing beside an open Step 1 broke the staged
   *   order) — detection and materialization run regardless, buffering;
   * - the source-side rules may already be prepared at turn end, but every
   *   prompt runs fresh relevance and task-bound Decode/landing;
   * - the moment Step 1 settles, a scan shell appears only if this prompt's
   *   relevance/landing work is still running;
   * - when Candidate review changed the active target pool, only the selected
   *   rules' Decode/landing is refreshed; relevance is not repeated;
   * - a live search that finds nothing settles as one quiet "empty" line if
   *   its shell ever became visible, and never appears otherwise.
   * Suggestions whose source changed since detection are dropped (CAS); the
   * row actions (accept / decline) ride the memory HTTP routes — this gate
   * only parks for the overall continue.
   */
  private async runTransferGate(
    args: StartTurnArgs,
    ctx: {
      chat: ReturnType<EventStore["requireChat"]>
      project: NonNullable<ReturnType<EventStore["getProject"]>>
      turnNumber: number
    },
    stepOneSettled: Promise<unknown> | null,
    options?: { transferId?: string; recompute?: boolean },
  ): Promise<{ decision: "none" | "handled" | "skipped" | "cancelled"; transferId: string }> {
    const existingMessages = args.openingReview ? this.store.getMessages(args.chatId) : []
    const existingParent = existingMessages.filter(
      (message): message is Extract<TranscriptEntry, { kind: "memory_transfer" }> =>
        message.kind === "memory_transfer" && message.openingReviewId === args.openingReview?.reviewId,
    ).at(-1)
    const transferId = options?.transferId ?? existingParent?.transferId ?? crypto.randomUUID()
    if (existingParent && !options?.recompute) {
      const existingDecision = existingMessages.filter(
        (message): message is Extract<TranscriptEntry, { kind: "memory_transfer_decision" }> =>
          message.kind === "memory_transfer_decision" && message.transferId === transferId,
      ).at(-1)?.decision
      if (existingDecision === "handled" || existingDecision === "skipped" || existingDecision === "cancelled") {
        return { decision: existingDecision, transferId }
      }
      if (existingDecision === "empty") return { decision: "none", transferId }
      if (existingDecision === "expired") return { decision: "cancelled", transferId }

      const finalResult = existingMessages.filter(
        (message): message is Extract<TranscriptEntry, { kind: "memory_transfer_result" }> =>
          message.kind === "memory_transfer_result" && message.transferId === transferId && message.done === true,
      ).at(-1)
      const settledSuggestions = finalResult?.suggestions
        ?? (existingParent.pending ? undefined : existingParent.suggestions)
      if (settledSuggestions) {
        if (settledSuggestions.length === 0) {
          await this.store.appendMessage(
            args.chatId,
            timestamped({ kind: "memory_transfer_decision", transferId, decision: "empty" }),
          )
          this.memory!.logger.event({
            type: "memory.transfer_card",
            sessionId: args.chatId,
            engine: args.provider,
            turn: ctx.turnNumber,
            suggestions: 0,
            decision: "empty",
          })
          return { decision: "none", transferId }
        }
        const decision = await this.parkExistingTransferGate(args, ctx, transferId)
        return { decision, transferId }
      }
    }
    // A fresh transfer stage starts a fresh landing set — the preview badge
    // reflects THIS turn's accepts only.
    this.memory?.clearTransferLandings(args.chatId)
    const taskCtx = {
      projectId: ctx.project.id,
      sessionId: args.chatId,
      projectTitle: ctx.project.title,
      taskText: args.memoryUserText ?? args.content,
      recentContext: this.recentConversationDigest(args.chatId),
    }
    let searched = false
    let taskFinished = false
    let shellPublished = Boolean(existingParent)
    let latestProgress: { cards: TransferSuggestionProgress[]; targetKey: string } | null = null
    const preparation = this.activePreparations.get(args.chatId)
    const cancellation = preparation?.cancellation ?? createMemoryPreparationCancellation()
    const cancelRequested = () => cancellation.signal.aborted
    // The presentation gate: nothing lands in the transcript before Step 1
    // settles. Progress arriving earlier buffers and flushes on settle.
    let stepOneDone = false
    const stepOneGate = (stepOneSettled ?? Promise.resolve())
      .catch(() => {})
      .then(() => {
        stepOneDone = true
      })
    // Serialize every transcript append for this gate — the shell and the
    // streamed results must land in order whatever async path produced them.
    let chain: Promise<void> = Promise.resolve()
    const enqueue = <T extends Omit<TranscriptEntry, "_id" | "createdAt">>(
      entry: T,
      shouldAppend?: () => boolean,
    ) => {
      const write = chain.then(async () => {
        const appended = await this.store.appendMessage(
          args.chatId,
          timestamped(entry),
          shouldAppend ? { shouldAppend } : undefined,
        )
        if (appended === false) return false
        this.emitStateChange(args.chatId, { immediate: true })
        return true
      })
      chain = write.then(() => {})
      return write
    }
    const publishShell = () => {
      if (shellPublished) return chain
      shellPublished = true
      return enqueue({
        kind: "memory_transfer",
        transferId,
        openingReviewId: args.openingReview?.reviewId,
        turn: ctx.turnNumber,
        pending: true,
        suggestions: [],
      })
    }
    const settleCancelledScan = async () => {
      taskFinished = true
      await chain
      if (shellPublished) {
        await enqueue({ kind: "memory_transfer_result", transferId, suggestions: [], done: true })
        await enqueue({ kind: "memory_transfer_decision", transferId, decision: "cancelled" })
      }
      return { decision: "cancelled" as const, transferId }
    }

    const maybePublishShell = () => {
      if (stepOneDone && searched && !taskFinished && !cancelRequested() && !this.cancelledDuringPreview.has(args.chatId)) {
        void publishShell()
      }
    }
    const flushProgress = () => {
      if (!stepOneDone || !latestProgress || cancelRequested() || this.cancelledDuringPreview.has(args.chatId)) return
      // A Decode that started before Candidate review settled is provisional.
      // Never publish it when the target pool moved; the refresh below emits
      // the same selection again against the new target snapshot.
      if (!this.memoryTransferDetect!.landingsStillCurrent(taskCtx, latestProgress.targetKey)) return
      const progress = latestProgress
      void publishShell()
      void enqueue({
        kind: "memory_transfer_result",
        transferId,
        suggestions: progress.cards.map((card) => this.transferSnapshotOf(card)),
      }, () => {
        if (cancelRequested() || this.cancelledDuringPreview.has(args.chatId)) return false
        if (!this.memoryTransferDetect!.landingsStillCurrent(taskCtx, progress.targetKey)) return false
        return progress.cards.every((card) => {
          const source = this.memory!.store.getById(card.sourceId)
          return Boolean(source && source.status === "active" && source.version === card.sourceVersion)
        })
      })
    }
    const onProgress = (cards: TransferSuggestionProgress[], targetKey: string) => {
      if (cancelRequested()) return
      latestProgress = { cards, targetKey }
      flushProgress()
    }
    // Unlike the old full-card reuse, a cold send may still be preparing its
    // source rules. Expose that real work after Step 1 instead of leaving an
    // apparently frozen gap. An actually empty shelf stays silent.
    searched = this.memoryTransferDetect!.hasSourceCandidates(taskCtx)
    maybePublishShell()
    const computeTask = async (): Promise<TransferTaskResult | null> => {
      // Cold start and an overlapping turn-end preparation converge here;
      // the detector shares identical in-flight Encode work.
      await this.memoryTransferDetect!.prepareSources(taskCtx)
      if (cancelRequested()) return null
      const forkPrompt = this.memoryTransferDetect!.buildTaskForkPrompt(taskCtx)
      if (!forkPrompt) return this.memoryTransferDetect!.runTask(taskCtx, { onProgress })
      searched = true
      maybePublishShell()
      const transferForkSessionToken = ctx.chat.pendingForkSessionToken ?? ctx.chat.sessionToken

      if (
        args.provider === "claude" &&
        transferForkSessionToken &&
        ctx.project.localPath &&
        process.env.MEMOSYNC_TRANSFER_FORK !== "0"
      ) {
        try {
          const raw = await this.forkQueryFn({
            sessionToken: transferForkSessionToken,
            localPath: ctx.project.localPath,
            prompt: forkPrompt,
          })
          if (cancelRequested()) return null
          if (raw) {
            const fromFork = await this.memoryTransferDetect!.materializeTaskFromFork(taskCtx, raw, { onProgress })
            if (cancelRequested()) return null
            if (fromFork) return fromFork
          }
        } catch {
          // Invalid/null/failure all take the same sidecar relevance fallback.
        }
        if (cancelRequested()) return null
      }
      const result = await this.memoryTransferDetect!.runTask(taskCtx, { onProgress })
      return cancelRequested() ? null : result
    }

    let result: TransferTaskResult | null = null
    const taskRun = computeTask().then(
      (value) => ({ kind: "result" as const, value }),
      (error: unknown) => ({ kind: "error" as const, error }),
    )
    void stepOneGate.then(() => {
      maybePublishShell()
      flushProgress()
    })
    const taskOutcome = await Promise.race([
      taskRun,
      cancellation.requested.then(() => ({ kind: "cancelled" as const })),
    ])
    if (taskOutcome.kind === "result") {
      result = taskOutcome.value
    } else if (taskOutcome.kind === "error") {
      const error = taskOutcome.error
      this.reportBackgroundError?.(
        `[memory-transfer-live] chat ${args.chatId} turn ${ctx.turnNumber}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    taskFinished = true
    if (taskOutcome.kind === "cancelled") return settleCancelledScan()
    const stepOneOutcome = await Promise.race([
      stepOneGate.then(() => "settled" as const),
      cancellation.requested.then(() => "cancelled" as const),
    ])
    if (stepOneOutcome === "cancelled") return settleCancelledScan()
    await chain
    // Stop landed while the search ran: settle the visible shell before
    // unwinding. PEEK — never consume: the Step 1 coroutine beside us needs
    // the same flag; the caller's finally clears it.
    if (this.cancelledDuringPreview.has(args.chatId)) return settleCancelledScan()

    // Candidate and Transfer relevance ran in parallel. Candidate decisions
    // are now settled, so refresh only landing if their active target pool
    // actually changed; the prompt's relevance selection remains fixed.
    if (result) {
      try {
        let refreshes = 0
        while (
          result
          && !this.memoryTransferDetect!.landingsStillCurrent(taskCtx, result.targetKey)
          && refreshes < MAX_TRANSFER_TARGET_REFRESHES
        ) {
          taskFinished = false
          maybePublishShell()
          const refreshOutcome:
            | { kind: "result"; value: TransferTaskResult }
            | { kind: "error"; error: unknown }
            | { kind: "cancelled" } = await Promise.race([
            this.memoryTransferDetect!.refreshLandingsIfTargetChanged(taskCtx, result, { onProgress }).then(
              (value) => ({ kind: "result" as const, value }),
              (error: unknown) => ({ kind: "error" as const, error }),
            ),
            cancellation.requested.then(() => ({ kind: "cancelled" as const })),
          ])
          if (refreshOutcome.kind === "cancelled") return settleCancelledScan()
          if (refreshOutcome.kind === "error") throw refreshOutcome.error
          result = refreshOutcome.value
          refreshes += 1
        }
        taskFinished = true
      } catch (error) {
        taskFinished = true
        this.reportBackgroundError?.(
          `[memory-transfer-landing-refresh] chat ${args.chatId} turn ${ctx.turnNumber}: ${error instanceof Error ? error.message : String(error)}`,
        )
        result = null
      }
    }
    await chain

    // The target may move after the bounded refresh loop finishes but before
    // its buffered transcript work drains. Never publish that stale landing;
    // a later turn can materialize the still-reusable source rule again.
    if (result && !this.memoryTransferDetect!.landingsStillCurrent(taskCtx, result.targetKey)) result = null

    // Stop may arrive while a Candidate-induced landing refresh is running.
    if (this.cancelledDuringPreview.has(args.chatId)) return settleCancelledScan()

    const settleEmpty = async () => {
      if (shellPublished) {
        // The search was VISIBLE — it must settle into a quiet line, never
        // vanish. An invisible task-local search that completed empty stays absent.
        await enqueue({ kind: "memory_transfer_result", transferId, suggestions: [], done: true })
        await enqueue({ kind: "memory_transfer_decision", transferId, decision: "empty" })
        this.memory!.logger.event({
          type: "memory.transfer_card",
          sessionId: args.chatId,
          engine: args.provider,
          turn: ctx.turnNumber,
          suggestions: 0,
          decision: "empty",
        })
      }
      return { decision: "none" as const, transferId }
    }

    // Source validation after buffered progress drained is a correctness
    // boundary. The target was checked immediately above; both are repeated at
    // the serialized transcript write because either store can move meanwhile.
    const finalResult = result
    const live = (finalResult?.cards ?? []).filter((card) => {
      const now = this.memory!.store.getById(card.sourceId)
      return Boolean(now && now.status === "active" && now.version === card.sourceVersion)
    })
    if (live.length === 0) return settleEmpty()

    const finalStillFresh = () => {
      if (cancelRequested() || this.cancelledDuringPreview.has(args.chatId)) return false
      if (!finalResult || !this.memoryTransferDetect!.landingsStillCurrent(taskCtx, finalResult.targetKey)) return false
      return live.every((card) => {
        const source = this.memory!.store.getById(card.sourceId)
        return Boolean(source && source.status === "active" && source.version === card.sourceVersion)
      })
    }

    // Park BEFORE the final entries land (same discipline as
    // pendingPreviews): the moment the card is visible a respond can arrive,
    // and it must find the gate — a respond can only name this transferId
    // after seeing the entry, so the early park is strictly safe.
    let resolveDecision!: (d: InternalGateWake<TransferGateDecision>) => void
    const decisionPromise = new Promise<InternalGateWake<TransferGateDecision>>((resolve) => {
      resolveDecision = resolve
    })
    this.pendingTransferGates.set(args.chatId, {
      transferId,
      published: true,
      respond: (d) => {
        this.pendingTransferGates.delete(args.chatId)
        resolveDecision(d)
      },
      invalidate: () => {
        this.pendingTransferGates.delete(args.chatId)
        resolveDecision("invalidated")
      },
    })
    const finalAppended = shellPublished
      ? await enqueue({
          kind: "memory_transfer_result",
          transferId,
          suggestions: live.map((card) => this.transferSnapshotOf(card)),
          done: true,
        }, finalStillFresh)
      : await enqueue({
        kind: "memory_transfer",
        transferId,
        openingReviewId: args.openingReview?.reviewId,
        turn: ctx.turnNumber,
          suggestions: live.map((card) => this.transferSnapshotOf(card)),
        }, finalStillFresh)
    if (!finalAppended) {
      this.pendingTransferGates.delete(args.chatId)
      // No card became respondable, but release the locally-owned promise so
      // neither it nor its resolver can outlive this discarded finalization.
      resolveDecision("cancelled")
      if (cancelRequested() || this.cancelledDuringPreview.has(args.chatId)) return settleCancelledScan()
      return settleEmpty()
    }
    this.emitStateChange(args.chatId, { immediate: true })
    const decision = await decisionPromise

    if (decision === "invalidated") {
      return await this.runTransferGate(args, ctx, Promise.resolve(), {
        transferId,
        recompute: true,
      })
    }

    await this.store.appendMessage(
      args.chatId,
      timestamped({ kind: "memory_transfer_decision", transferId, decision }),
    )
    this.memory!.logger.event({
      type: "memory.transfer_card",
      sessionId: args.chatId,
      engine: args.provider,
      turn: ctx.turnNumber,
      suggestions: live.length,
      decision,
    })
    // Cancellation bookkeeping lives in cancel() (see runProposalsGate).
    if (decision === "cancelled") this.emitStateChange(args.chatId, { immediate: true })
    return { decision, transferId }
  }

  private async runCheckupGate(
    args: StartTurnArgs,
    ctx: { project: NonNullable<ReturnType<EventStore["getProject"]>>; turnNumber: number },
    options?: { checkupId?: string; proposalsId?: string; transferId?: string; reuseParent?: boolean },
  ): Promise<{ decision: "none" | "handled" | "skipped" | "cancelled" | "reopen_proposals" | "reopen_transfer"; checkupId: string }> {
    const existingMessages = args.openingReview ? this.store.getMessages(args.chatId) : []
    const existingParent = !options?.checkupId
      ? existingMessages.filter(
          (message): message is Extract<TranscriptEntry, { kind: "memory_checkup" }> =>
            message.kind === "memory_checkup" && message.openingReviewId === args.openingReview?.reviewId,
        ).at(-1)
      : undefined
    const checkupId = options?.checkupId ?? existingParent?.checkupId ?? crypto.randomUUID()
    const reuseParent = Boolean(options?.reuseParent || existingParent)
    if (existingParent) {
      const existingDecision = existingMessages.filter(
        (message): message is Extract<TranscriptEntry, { kind: "memory_checkup_decision" }> =>
          message.kind === "memory_checkup_decision" && message.checkupId === checkupId,
      ).at(-1)?.decision
      if (existingDecision === "handled" || existingDecision === "skipped" || existingDecision === "cancelled") {
        return { decision: existingDecision, checkupId }
      }
      if (existingDecision === "empty" || existingDecision === "failed") return { decision: "none", checkupId }
      if (existingDecision === "expired") return { decision: "cancelled", checkupId }

      const existingResult = existingMessages.filter(
        (message): message is Extract<TranscriptEntry, { kind: "memory_checkup_result" }> =>
          message.kind === "memory_checkup_result" && message.checkupId === checkupId,
      ).at(-1)
      if (existingResult) {
        if (existingResult.suggestions.length === 0) {
          const failedKinds = [...new Set(existingResult.failedKinds ?? [])]
          const failed = failedKinds.length > 0
          await this.store.appendMessage(
            args.chatId,
            timestamped({ kind: "memory_checkup_decision", checkupId, decision: failed ? "failed" : "empty" }),
          )
          this.memory!.logger.event({
            type: "memory.checkup",
            sessionId: args.chatId,
            engine: args.provider,
            turn: ctx.turnNumber,
            suggestions: 0,
            cached: false,
            ...(failedKinds.length ? { failedKinds } : {}),
            decision: failed ? "failed" : "clear",
          })
          return { decision: "none", checkupId }
        }
        const decision = await new Promise<InternalGateWake<CheckupGateDecision>>((resolve) => {
          this.pendingCheckupGates.set(args.chatId, {
            checkupId,
            proposalsId: options?.proposalsId,
            transferId: options?.transferId,
            published: true,
            respond: (next) => {
              this.pendingCheckupGates.delete(args.chatId)
              resolve(next)
            },
            invalidate: () => {
              this.pendingCheckupGates.delete(args.chatId)
              resolve("invalidated")
            },
          })
          this.emitStateChange(args.chatId, { immediate: true })
        })
        if (decision === "invalidated") {
          return await this.runCheckupGate(args, ctx, {
            ...options,
            checkupId,
            reuseParent: true,
          })
        }
        if (decision === "reopen_proposals" || decision === "reopen_transfer") {
          return { decision, checkupId }
        }
        await this.store.appendMessage(
          args.chatId,
          timestamped({ kind: "memory_checkup_decision", checkupId, decision }),
        )
        this.memory!.logger.event({
          type: "memory.checkup",
          sessionId: args.chatId,
          engine: args.provider,
          turn: ctx.turnNumber,
          suggestions: existingResult.suggestions.length,
          cached: false,
          ...(existingResult.failedKinds?.length ? { failedKinds: existingResult.failedKinds } : {}),
          decision,
        })
        return { decision, checkupId }
      }
    }
    const checkupCtx = { projectId: ctx.project.id, sessionId: args.chatId }
    const runState = {
      checkupId,
      proposalsId: options?.proposalsId,
      transferId: options?.transferId,
      reopenProposalsRequested: false,
      reopenTransferRequested: false,
    }
    this.inFlightCheckups.set(args.chatId, runState)
    let skeletonShown = false
    let result: CheckupResult = { suggestions: [], cached: true }
    try {
      if (this.memoryCheckup!.needsRecompute(checkupCtx)) {
        skeletonShown = true
        if (!reuseParent) {
          await this.store.appendMessage(
            args.chatId,
            timestamped({
              kind: "memory_checkup",
              checkupId,
              openingReviewId: args.openingReview?.reviewId,
              turn: ctx.turnNumber,
              pending: true,
            }),
          )
        }
        this.emitStateChange(args.chatId, { immediate: true })
      }
      result = await this.memoryCheckup!.run(checkupCtx)
    } catch (error) {
      this.reportBackgroundError?.(
        `[memory-checkup] chat ${args.chatId} turn ${ctx.turnNumber}: ${error instanceof Error ? error.message : String(error)}`,
      )
      result = {
        suggestions: [],
        cached: false,
        failedKinds: ["conflict", "redundancy", "staleness"],
      }
    }
    if (runState.reopenProposalsRequested || runState.reopenTransferRequested) {
      this.inFlightCheckups.delete(args.chatId)
      return { decision: runState.reopenProposalsRequested ? "reopen_proposals" : "reopen_transfer", checkupId }
    }
    let cancelledDuringRun = this.cancelledDuringPreview.delete(args.chatId)
    const failedKinds = cancelledDuringRun ? [] : [...new Set(result.failedKinds ?? [])]
    // Settle the skeleton whatever happened — a pending container must never
    // dangle in the transcript. When no skeleton was needed, append the
    // completed parent now; Step 2 remains visible even when its answer is
    // "nothing needs attention".
    if (!skeletonShown && !cancelledDuringRun && !reuseParent) {
      await this.store.appendMessage(args.chatId, timestamped({
        kind: "memory_checkup",
        checkupId,
        openingReviewId: args.openingReview?.reviewId,
        turn: ctx.turnNumber,
      }))
    }
    if (skeletonShown || !cancelledDuringRun) {
      await this.store.appendMessage(
        args.chatId,
        timestamped({
          kind: "memory_checkup_result",
          checkupId,
          suggestions: cancelledDuringRun ? [] : result.suggestions,
          ...(failedKinds.length ? { failedKinds } : {}),
        }),
      )
    }
    // Stop can land while the serialized result append is waiting. Claim it
    // again before publishing an empty terminal or parking a suggestion gate;
    // otherwise cancel() has already returned and no future responder exists
    // to release the late gate.
    if (!cancelledDuringRun && this.cancelledDuringPreview.delete(args.chatId)) {
      cancelledDuringRun = true
    }
    if (runState.reopenProposalsRequested || runState.reopenTransferRequested) {
      this.inFlightCheckups.delete(args.chatId)
      return { decision: runState.reopenProposalsRequested ? "reopen_proposals" : "reopen_transfer", checkupId }
    }
    if (cancelledDuringRun) {
      this.inFlightCheckups.delete(args.chatId)
      await this.store.appendMessage(
        args.chatId,
        timestamped({ kind: "memory_checkup_decision", checkupId, decision: "cancelled" }),
      )
      this.memory!.logger.event({
        type: "memory.checkup",
        sessionId: args.chatId,
        engine: args.provider,
        turn: ctx.turnNumber,
        suggestions: 0,
        cached: result.cached,
        decision: "cancelled",
      })
      this.emitStateChange(args.chatId, { immediate: true })
      return { decision: "cancelled", checkupId }
    }
    if (result.suggestions.length === 0) {
      this.inFlightCheckups.delete(args.chatId)
      const analysisFailed = failedKinds.length > 0
      // Settle the container like the proposals/transfer gates do ("empty"):
      // an undecided memory step reads as an open gate to the client, which
      // then suppresses the streaming footer for the entire turn.
      await this.store.appendMessage(
        args.chatId,
        timestamped({
          kind: "memory_checkup_decision",
          checkupId,
          decision: analysisFailed ? "failed" : "empty",
        }),
      )
      this.memory!.logger.event({
        type: "memory.checkup",
        sessionId: args.chatId,
        engine: args.provider,
        turn: ctx.turnNumber,
        suggestions: 0,
        cached: result.cached,
        ...(failedKinds.length ? { failedKinds } : {}),
        decision: analysisFailed ? "failed" : "clear",
      })
      this.emitStateChange(args.chatId)
      return { decision: "none", checkupId }
    }

    const decision = await new Promise<InternalGateWake<CheckupGateDecision>>((resolve) => {
      this.pendingCheckupGates.set(args.chatId, {
        checkupId,
        proposalsId: options?.proposalsId,
        transferId: options?.transferId,
        // The result entry is durably appended above — the gate is
        // respondable the moment it parks.
        published: true,
        respond: (d) => {
          this.pendingCheckupGates.delete(args.chatId)
          resolve(d)
        },
        invalidate: () => {
          this.pendingCheckupGates.delete(args.chatId)
          resolve("invalidated")
        },
      })
      this.inFlightCheckups.delete(args.chatId)
      this.emitStateChange(args.chatId, { immediate: true })
    })

    if (decision === "invalidated") {
      return await this.runCheckupGate(args, ctx, {
        ...options,
        checkupId,
        reuseParent: true,
      })
    }

    if (decision === "reopen_proposals" || decision === "reopen_transfer") return { decision, checkupId }

    await this.store.appendMessage(
      args.chatId,
      timestamped({ kind: "memory_checkup_decision", checkupId, decision }),
    )
    this.memory!.logger.event({
      type: "memory.checkup",
      sessionId: args.chatId,
      engine: args.provider,
      turn: ctx.turnNumber,
      suggestions: result.suggestions.length,
      cached: result.cached,
      ...(failedKinds.length ? { failedKinds } : {}),
      decision,
    })
    // Cancellation bookkeeping lives in cancel() (see runProposalsGate).
    if (decision === "cancelled") this.emitStateChange(args.chatId, { immediate: true })
    return { decision, checkupId }
  }

  /**
   * Re-enter Step 1 or Step 2 while the turn is still parked before engine
   * boot. The same transcript parents are reset in place; every dependent
   * result is revalidated, with unchanged Checkup work reused, before the
   * preview becomes actionable again.
   */
  private async runReopenedMemoryPreparation(input: {
    args: StartTurnArgs
    ctx: {
      chat: ReturnType<EventStore["requireChat"]>
      project: NonNullable<ReturnType<EventStore["getProject"]>>
      turnNumber: number
      injected: MemoryItem[]
    }
    previewId: string
    revision: number
    proposalsId?: string
    transferId?: string
    checkupId?: string
    from: "proposals" | "checkup" | "transfer"
    stageId: string
  }) {
    const { args, previewId, from } = input
    let revision = input.revision
    try {
      if (
        !input.checkupId ||
        (from === "proposals" && !input.proposalsId) ||
        (from === "transfer" && !input.transferId)
      ) {
        throw new Error("This memory review step is no longer available")
      }

      this.memory!.logger.event({
        type: "memory.preparation_reopen",
        sessionId: args.chatId,
        engine: args.provider,
        turn: input.ctx.turnNumber,
        from,
        revision,
      })

      await this.store.appendMessage(
        args.chatId,
        timestamped({
          kind: "memory_preparation_reset",
          previewId,
          revision,
          from,
          proposalsId: input.proposalsId,
          transferId: input.transferId,
          checkupId: input.checkupId,
        }),
      )
      this.emitStateChange(args.chatId, { immediate: true })

      if (from === "transfer") {
        const decision = await this.parkExistingTransferGate(args, input.ctx, input.transferId!)
        if (decision === "cancelled") return

        // The Transfer card settled again. Step 2 changes from "waiting" to
        // the shared result; Checkup recomputes only when its dependencies
        // changed during the reopened review.
        await this.store.appendMessage(
          args.chatId,
          timestamped({
            kind: "memory_preparation_reset",
            previewId,
            revision,
            from: "checkup",
            proposalsId: input.proposalsId,
            checkupId: input.checkupId,
          }),
        )
        this.emitStateChange(args.chatId, { immediate: true })
      }

      if (from === "proposals") {
        const decision = await this.parkExistingProposalsGate(args, input.ctx, input.proposalsId!)
        if (decision === "cancelled") return

        // Step 1 settled again. Step 2 now changes from "waiting" to the
        // shared result; Checkup recomputes only when its dependencies changed.
        await this.store.appendMessage(
          args.chatId,
          timestamped({
            kind: "memory_preparation_reset",
            previewId,
            revision,
            from: "checkup",
            proposalsId: input.proposalsId,
            checkupId: input.checkupId,
          }),
        )
        this.emitStateChange(args.chatId, { immediate: true })
      }

      while (true) {
        const checkup = await this.runCheckupGate(args, input.ctx, {
          checkupId: input.checkupId,
          proposalsId: input.proposalsId,
          transferId: input.transferId,
          reuseParent: true,
        })
        if (checkup.decision === "cancelled") return
        if (checkup.decision === "reopen_transfer") {
          if (!input.transferId) throw new Error("Memory transfer review is no longer available")
          const reopened = await this.reopenTransferBeforeCheckup({
            args,
            ctx: input.ctx,
            transferId: input.transferId,
            checkupId: input.checkupId,
            revision,
            previewId,
          })
          revision = reopened.revision
          if (reopened.cancelled) return
          continue
        }
        if (checkup.decision !== "reopen_proposals") break
        if (!input.proposalsId) throw new Error("Memory candidate review is no longer available")
        const reopened = await this.reopenProposalsBeforeCheckup({
          args,
          ctx: input.ctx,
          proposalsId: input.proposalsId,
          checkupId: input.checkupId,
          revision,
          previewId,
        })
        revision = reopened.revision
        if (reopened.cancelled) return
      }

      const injected = planMemoryInjection({
        policy: this.policy,
        provider: args.provider,
        memory: this.memory!,
        projectId: input.ctx.project.id,
        chatId: args.chatId,
        workspaceDir: input.ctx.project.localPath,
      }).injectedMemories

      await this.refreshMemoryPreviewGate({
        ...input,
        revision,
        ctx: { ...input.ctx, injected },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.store.appendMessage(
        args.chatId,
        timestamped({ kind: "result", subtype: "error", isError: true, durationMs: 0, result: message }),
      )
      await this.store.recordTurnFailed(args.chatId, message)
      this.emitStateChange(args.chatId)
    } finally {
      this.startingChats.delete(args.chatId)
      this.cancelledDuringPreview.delete(args.chatId)
    }
  }

  /**
   * Truncated digest of the last turns' user/assistant text, EXCLUDING the
   * just-appended current prompt (the task rides separately). The cheap
   * context that de-biases the latency-critical pre-turn pass without paying
   * a fork (user decision 2026-08-08, option C).
   */
  private recentConversationDigest(
    chatId: string,
    maxTurns = 2,
    maxCharsPerText = 600,
    maxTotalChars = 3000,
    // Pre-turn callers exclude the newest prompt because it IS the current
    // task and rides separately from this prior-turn digest.
    options?: { includeCurrentTurn?: boolean },
  ): string {
    const messages = this.store.getMessages(chatId)
    const parts: string[] = []
    let priorPrompts = 0
    let skippedCurrentPrompt = options?.includeCurrentTurn === true
    let total = 0
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!
      if (m.kind === "user_prompt") {
        if (!skippedCurrentPrompt) {
          skippedCurrentPrompt = true
          continue
        }
        priorPrompts += 1
        const text = `User: ${m.content.slice(0, maxCharsPerText)}`
        parts.unshift(text)
        total += text.length
        if (priorPrompts >= maxTurns || total >= maxTotalChars) break
      } else if (m.kind === "assistant_text" && skippedCurrentPrompt && m.text.trim()) {
        const text = `Assistant: ${m.text.slice(0, maxCharsPerText)}`
        parts.unshift(text)
        total += text.length
        if (total >= maxTotalChars) break
      }
    }
    return parts.join("\n")
  }

  /**
   * One-call fast path (user decision 2026-08-08): the relevance response
   * already carries expectedUse per pick; only ids it missed (carryovers it
   * dropped, model omissions) go through the standalone Use Planner. Halves
   * the pre-turn wait in the common case without weakening the contract.
   */
  private async resolveExpectedUses(
    task: string,
    memories: MemoryItem[],
    selectedIds: string[],
    relevant: RelevantMemory[],
  ): Promise<ExpectedMemoryUse[]> {
    const fromRelevance = new Map(
      relevant
        .filter((item) => typeof item.expectedUse === "string" && item.expectedUse.trim())
        .map((item) => [item.id, item.expectedUse!.trim().slice(0, 220)]),
    )
    const missing = selectedIds.filter((id) => !fromRelevance.has(id))
    const planned = missing.length ? await this.planExpectedMemoryUses(task, memories, missing) : []
    const plannedById = new Map(planned.map((use) => [use.id, use.expectedUse]))
    return selectedIds
      .map((id) => ({ id, expectedUse: fromRelevance.get(id) ?? plannedById.get(id) ?? "" }))
      .filter((use) => use.expectedUse)
  }

  private async planExpectedMemoryUses(
    task: string,
    memories: MemoryItem[],
    selectedIds: string[],
  ): Promise<ExpectedMemoryUse[]> {
    const selected = new Set(selectedIds)
    const inputs = memories
      .filter((memory) => selected.has(memory.id))
      .map((memory) => ({
        id: memory.id,
        content: memory.content,
        hasDetail: Boolean(memory.detail),
      }))
    if (!inputs.length) return []
    if (this.memoryUsePlan) return await this.memoryUsePlan.plan({ task, memories: inputs })
    return inputs.map((memory) => ({
      id: memory.id,
      expectedUse: memory.hasDetail
        ? "Load the detailed memory, then apply it while completing this task."
        : "Apply this memory while completing the task.",
    }))
  }

  private async ensurePendingPreviewExpectedUses(
    pending: PendingMemoryPreview,
    selectedIds: string[],
  ): Promise<ExpectedMemoryUse[]> {
    const allowed = new Set(pending.memoryIds)
    const selected = [...new Set(selectedIds)].filter((id) => allowed.has(id))
    const missing = selected.filter((id) => !pending.expectedUseById.has(id))
    if (missing.length) {
      let planned: ExpectedMemoryUse[] = []
      try {
        planned = await this.planExpectedMemoryUses(pending.task, pending.memories, missing)
      } catch {
        // A preview decision must not fail because the optional planner is
        // unavailable. The fallback remains server-authored and deterministic.
      }
      const plannedById = new Map(
        planned
          .filter((use) => missing.includes(use.id) && typeof use.expectedUse === "string" && use.expectedUse.trim())
          .map((use) => [use.id, use.expectedUse.trim().slice(0, 220)]),
      )
      for (const id of missing) {
        const memory = pending.memories.find((item) => item.id === id)
        if (!memory) continue
        pending.expectedUseById.set(
          id,
          plannedById.get(id)
            ?? (memory.detail
              ? "Load the detailed memory, then apply it while completing this task."
              : "Apply this memory while completing the task."),
        )
      }
    }
    return selected.flatMap((id) => {
      const expectedUse = pending.expectedUseById.get(id)
      return expectedUse ? [{ id, expectedUse }] : []
    })
  }

  /** Replace one parked preview in place after an earlier review changed. */
  private async refreshMemoryPreviewGate(input: {
    args: StartTurnArgs
    ctx: {
      chat: ReturnType<EventStore["requireChat"]>
      project: NonNullable<ReturnType<EventStore["getProject"]>>
      turnNumber: number
      injected: MemoryItem[]
    }
    previewId: string
    revision: number
    proposalsId?: string
    transferId?: string
    checkupId?: string
  }) {
    const { args, ctx, previewId, revision } = input
    const memoryIds = ctx.injected.map((memory) => memory.id)
    const attentionIds = (this.turnPayAttention.get(args.chatId) ?? []).map((e) => e.id).filter((id) => memoryIds.includes(id))
    const willAssessRelevance = Boolean(this.memoryRelevance) && ctx.injected.length > 0

    this.turnExpectedUses.delete(args.chatId)
    const pending: PendingMemoryPreview = {
      previewId,
      revision,
      published: false,
      memoryIds,
      task: args.memoryUserText ?? args.content,
      memories: ctx.injected,
      expectedUseById: new Map(),
      proposalsId: input.proposalsId,
      transferId: input.transferId,
      checkupId: input.checkupId,
      respond: (decision, selectedIds, expectedUses, controlOperation) => {
        this.deletePendingPreviewIfCurrent(args.chatId, pending)
        void this.finishMemoryPreview({
          args,
          chat: ctx.chat,
          project: ctx.project,
          turnNumber: ctx.turnNumber,
          previewId,
          memoryIds,
          decision,
          selectedIds,
          expectedUses,
          controlOperation,
        })
      },
      reopen: (from, stageId) => {
        this.deletePendingPreviewIfCurrent(args.chatId, pending)
        this.startingChats.set(args.chatId, "previewing_memory")
        void this.runReopenedMemoryPreparation({
          ...input,
          ctx,
          revision: revision + 1,
          from,
          stageId,
        })
      },
    }
    this.pendingPreviews.set(args.chatId, pending)

    await this.store.appendMessage(
      args.chatId,
      timestamped({
        kind: "memory_preview_update",
        previewId,
        ...(this.policy.studyMode && this.policy.condition === "memosync"
          ? { taskId: this.getActiveStudyTaskId() ?? undefined }
          : {}),
        revision,
        memories: ctx.injected.map((memory) => ({ id: memory.id, content: memory.content, scope: memory.scope })),
        relevancePending: willAssessRelevance,
        ...(attentionIds.length ? { attentionIds } : {}),
      }),
    )
    const parked = this.pendingPreviews.get(args.chatId)
    if (parked?.previewId === previewId && parked.revision === revision) parked.published = true

    if (this.cancelledDuringPreview.delete(args.chatId)) {
      this.pendingPreviews.delete(args.chatId)
      this.emitStateChange(args.chatId, { immediate: true })
      return
    }
    this.emitStateChange(args.chatId, { immediate: true })

    if (willAssessRelevance) {
      const userText = args.memoryUserText ?? args.content
      const settle = async (relevant: RelevantMemory[]) => {
        const current = this.pendingPreviews.get(args.chatId)
        if (current?.previewId !== previewId || current.revision !== revision) return
        const selectedIds = [...new Set([...attentionIds, ...relevant.map((item) => item.id)])]
        const expectedUses = await this.resolveExpectedUses(userText, ctx.injected, selectedIds, relevant)
        const stillCurrent = this.pendingPreviews.get(args.chatId)
        if (stillCurrent?.previewId !== previewId || stillCurrent.revision !== revision) return
        for (const use of expectedUses) stillCurrent.expectedUseById.set(use.id, use.expectedUse)
        this.turnExpectedUses.set(args.chatId, expectedUses)
        await this.store.appendMessage(
          args.chatId,
          timestamped({ kind: "memory_preview_relevance", previewId, revision, relevant: relevant.map(({ id, why }) => ({ id, why })), expectedUses }),
        )
        this.emitStateChange(args.chatId)
      }
      void this.memoryRelevance!
        .assess(userText, ctx.injected, {
          mustInclude: attentionIds,
          recentContext: this.recentConversationDigest(args.chatId),
        })
        .then(settle)
        .catch(() => settle([]).catch(() => {}))
    }
  }

  /**
   * Detached continuation of startTurnForChat once a preview gate engages:
   * append the injection receipt, then park for the user's decision (or
   * auto-proceed on an empty set) and boot. No ws command awaits this —
   * failures are recorded on the transcript the way finishMemoryPreview
   * records them. Owns the startingChats reservation handed over by
   * startTurnForChat. No LLM is involved: the receipt reports exactly what
   * the injection plan says, nothing predicted.
   */
  private async runPreviewGateThenBoot(
    args: StartTurnArgs,
    ctx: {
      chat: ReturnType<EventStore["requireChat"]>
      project: NonNullable<ReturnType<EventStore["getProject"]>>
      turnNumber: number
      injected: MemoryItem[]
    },
  ) {
    try {
      let gated = false
      // Flipped by the parked respond closure: once a decision claims the
      // gate, finishMemoryPreview owns the turn — no path here may boot it.
      let claimed = false
      let automaticOpeningWorkingMemory: StartTurnArgs["openingWorkingMemory"]
      try {
        // The user hit Stop before the gate parked (BUG AGENT-2): cancel()
        // already recorded the interruption — unwind without a preview card,
        // parking, or boot. (finally still releases the reservation.)
        if (this.cancelledDuringPreview.delete(args.chatId)) return
        // —— Step one (redesign 2026-08-07 §3): container 1 then container 2,
        // both BEFORE the injection receipt. Container 1 reviews this
        // conversation's pending memory changes (last turn's captures + a
        // fast parse of the just-sent prompt — an explicit "remember X" is
        // acknowledged at the turn's start, not after the whole reply).
        // Container 2 is the library checkup on the post-review library.
        let stepOneTouched = false
        let proposalsId: string | undefined
        let transferId: string | undefined
        let checkupId: string | undefined
        let durableParents: TranscriptEntry[] = []
        if (args.openingReview) {
          durableParents = this.store.getMessages(args.chatId)
          proposalsId = durableParents.filter(
            (message): message is Extract<TranscriptEntry, { kind: "memory_proposals" }> =>
              message.kind === "memory_proposals" && message.openingReviewId === args.openingReview?.reviewId,
          ).at(-1)?.proposalsId
          transferId = durableParents.filter(
            (message): message is Extract<TranscriptEntry, { kind: "memory_transfer" }> =>
              message.kind === "memory_transfer" && message.openingReviewId === args.openingReview?.reviewId,
          ).at(-1)?.transferId
          checkupId = durableParents.filter(
            (message): message is Extract<TranscriptEntry, { kind: "memory_checkup" }> =>
              message.kind === "memory_checkup" && message.openingReviewId === args.openingReview?.reviewId,
          ).at(-1)?.checkupId
        }
        // Step 1 and the Transfer card COMPUTE in parallel; the transfer's
        // presentation is staged inside runTransferGate: after Step 1, show a
        // scanning shell only while current-task materialization is still
        // running; otherwise publish only a completed non-empty card. Cancel
        // resolves every parked gate and records the interruption once.
        if (!args.openingLongTermAlreadyReady) {
        const recomputeOpeningLongTerm = Boolean(args.openingReview && (args.openingLongTermRevision ?? 0) > 0)
        let recomputeProposals = recomputeOpeningLongTerm
        let recomputeTransfer = recomputeOpeningLongTerm
        let recomputeCheckup = recomputeOpeningLongTerm
        if (recomputeOpeningLongTerm && args.openingReview) {
          const revision = args.openingLongTermRevision!
          let resetIndex = durableParents.findIndex((message) => (
            message.kind === "memory_preparation_reset"
            && message.openingReviewId === args.openingReview?.reviewId
            && message.revision === revision
          ))
          if (resetIndex < 0) {
            const resetFrom = proposalsId ? "proposals" : transferId ? "transfer" : "checkup"
            await this.store.appendMessage(
              args.chatId,
              timestamped({
                kind: "memory_preparation_reset",
                openingReviewId: args.openingReview.reviewId,
                revision,
                from: resetFrom,
                proposalsId,
                transferId,
                checkupId,
              }),
            )
            this.emitStateChange(args.chatId, { immediate: true })
            durableParents = this.store.getMessages(args.chatId)
            resetIndex = durableParents.findIndex((message) => (
              message.kind === "memory_preparation_reset"
              && message.openingReviewId === args.openingReview?.reviewId
              && message.revision === revision
            ))
          }
          const afterReset = resetIndex < 0 ? [] : durableParents.slice(resetIndex + 1)
          recomputeProposals = !proposalsId || !afterReset.some((message) => (
            message.kind === "memory_proposals_decision" && message.proposalsId === proposalsId
          ))
          recomputeTransfer = !transferId || !afterReset.some((message) => (
            message.kind === "memory_transfer_decision" && message.transferId === transferId
          ))
          recomputeCheckup = !checkupId || !afterReset.some((message) => (
            message.kind === "memory_checkup_decision" && message.checkupId === checkupId
          ))
        }
        this.activePreparations.set(args.chatId, {
          args,
          ctx,
          reparks: [],
          reopened: false,
          cancellation: createMemoryPreparationCancellation(),
        })
        const proposalsRun =
          this.capture && this.policy.capture === "review"
            ? this.runProposalsGate(args, ctx, recomputeProposals
                ? { proposalsId, recompute: true }
                : undefined)
            : null
        const transferRun =
          this.memoryTransferDetect && this.policy.capture === "review"
            ? this.runTransferGate(
                args,
                ctx,
                proposalsRun ?? Promise.resolve(),
                recomputeTransfer ? { transferId, recompute: true } : undefined,
              )
            : null
        if (proposalsRun || transferRun) {
          const [proposalsStage, transferStage] = await Promise.all([proposalsRun, transferRun])
          if (proposalsStage) {
            proposalsId = proposalsStage.proposalsId
            if (proposalsStage.decision !== "none" && proposalsStage.decision !== "cancelled") stepOneTouched = true
          }
          if (transferStage && transferStage.decision !== "none" && transferStage.decision !== "cancelled") {
            stepOneTouched = true
            transferId = transferStage.transferId
          }
          const prep = this.activePreparations.get(args.chatId)
          if (
            prep?.cancellation.signal.aborted
            || proposalsStage?.decision === "cancelled"
            || transferStage?.decision === "cancelled"
          ) return
          // A Step 1 reopened DURING the phase re-parked beside the transfer
          // gate — the turn cannot move on before it settles again.
          while (prep && prep.reparks.length) {
            const decision = await prep.reparks.shift()!
            if (decision === "cancelled") return
          }
          if (prep?.reopened) stepOneTouched = true
        }
        const completedPreparation = this.activePreparations.get(args.chatId)
        this.activePreparations.delete(args.chatId)
        completedPreparation?.cancellation.settle()
        if (this.memoryCheckup) {
          let checkupRevision = 0
          let checkupOptions: {
            checkupId?: string
            proposalsId?: string
            transferId?: string
            reuseParent?: boolean
          } = {
            proposalsId,
            transferId,
            ...(recomputeCheckup && checkupId ? { checkupId, reuseParent: true } : {}),
          }

          while (true) {
            const stage = await this.runCheckupGate(args, ctx, checkupOptions)
            checkupId = stage.checkupId
            if (stage.decision === "cancelled") return
            if (stage.decision !== "reopen_proposals" && stage.decision !== "reopen_transfer") {
              if (stage.decision !== "none") stepOneTouched = true
              break
            }
            stepOneTouched = true
            if (stage.decision === "reopen_transfer") {
              if (!transferId) throw new Error("Memory transfer review is no longer available")
              const reopened = await this.reopenTransferBeforeCheckup({
                args,
                ctx,
                transferId,
                checkupId,
                revision: checkupRevision,
              })
              checkupRevision = reopened.revision
              if (reopened.cancelled) return
              checkupOptions = { checkupId, proposalsId, transferId, reuseParent: true }
              continue
            }
            if (!proposalsId) throw new Error("Memory candidate review is no longer available")

            const reopened = await this.reopenProposalsBeforeCheckup({
              args,
              ctx,
              proposalsId,
              checkupId,
              revision: checkupRevision,
            })
            checkupRevision = reopened.revision
            if (reopened.cancelled) return
            checkupOptions = { checkupId, proposalsId, transferId, reuseParent: true }
          }
        }
        // Changes accepted/resolved at the gates are effective NOW — recompute
        // the plan so the injection receipt (and the boot) carry them this
        // same turn (the causal chain the design demands).
        if (stepOneTouched) {
          ctx = {
            ...ctx,
            injected: planMemoryInjection({
              policy: this.policy,
              provider: args.provider,
              memory: this.memory!,
              projectId: ctx.project.id,
              chatId: args.chatId,
              workspaceDir: ctx.project.localPath,
            }).injectedMemories,
          }
        }
        }
        if (args.openingReview) {
          if (!this.openingBoardBacklog) {
            throw new Error("Opening Memory Board state is unavailable")
          }
          const openingState = {
            taskId: args.openingReview.taskId,
            chatId: args.chatId,
            reviewId: args.openingReview.reviewId,
            phase: "preparing" as const,
          }
          this.openingBoardBacklog.markOpeningPromptLongTermReady(openingState)
          this.emitStateChange(args.chatId, { immediate: true })
          const completion = await this.openingBoardBacklog.waitForOpeningPromptCompletion(openingState)
          if (completion === "invalidated") {
            // A Board mutation changed the authoritative Visible Memory Pool
            // after Candidate → Transfer → Checkup settled. Release this stale
            // preparation without a terminal; bounded recovery reruns the
            // complete Long-term pipeline against the new dependency state.
            // This is a new participant-authored dependency revision, not a
            // retry of an earlier transient failure, so it owns a fresh retry
            // budget even if preparation had previously exhausted one.
            this.openingBoardRecoveryRetryAttempts.delete(args.openingReview.taskId)
            this.scheduleOpeningBoardRecovery(args.openingReview.taskId)
            return
          }
          if (this.cancelledDuringPreview.delete(args.chatId)) return
        }
        const previewId = crypto.randomUUID()
        // The receipt IS the injection plan: every injected memory, verbatim.
        const memoryIds = ctx.injected.map((m) => m.id)
        const injectedIdSet = new Set(memoryIds)
        const transferredIds = (this.memory?.getTransferLandings(args.chatId) ?? []).filter((id) =>
          injectedIdSet.has(id)
        )
        // Pay-attention carryover (redesign 2026-08-07, 4.3.4 follow-up ①):
        // ids the user flagged on the last audit seed this turn's injected
        // list and ride the boot reminder. Consumed once.
        const attentionKey = `pay_attention:${args.chatId}`
        const queuedAttention = this.memory!.store.getKv<Array<string | { id: string; quote?: string }>>(attentionKey)
        // Enforce entries (2026-08-19 D1) carry the violation quote; legacy
        // queues hold bare id strings — normalize both shapes.
        const queuedEntries = Array.isArray(queuedAttention)
          ? queuedAttention.map((e) => (typeof e === "string" ? { id: e } : e)).filter((e) => memoryIds.includes(e.id))
          : []
        const attentionIds = queuedEntries.map((e) => e.id)
        if (Array.isArray(queuedAttention) && queuedAttention.length) {
          this.memory!.store.setKv(attentionKey, [])
          this.turnPayAttention.set(args.chatId, queuedEntries)
        }
        const autoProceed = this.getMemoryPreviewSettings().autoProceedWhenEmpty && ctx.injected.length === 0
        // Maintenance attention no longer rides the gate (redesign 2026-08-07
        // §3): the step-one checkup container is its one home in the chat
        // flow; the Board keeps the inventory view.
        // Park BEFORE the card lands in the transcript: the moment the entry
        // is visible a respond can arrive, and it must find the gate. Parking
        // after the append left a microtask window where a fast respond threw
        // "No matching pending memory preview".
        if (!autoProceed) {
          const pending: PendingMemoryPreview = {
            previewId,
            revision: 0,
            published: false,
            memoryIds,
            task: args.memoryUserText ?? args.content,
            memories: ctx.injected,
            expectedUseById: new Map(),
            proposalsId,
            transferId,
            checkupId,
            respond: (decision, selectedIds, expectedUses, controlOperation) => {
              claimed = true
              this.deletePendingPreviewIfCurrent(args.chatId, pending)
              void this.finishMemoryPreview({
                args,
                chat: ctx.chat,
                project: ctx.project,
                turnNumber: ctx.turnNumber,
                previewId,
                memoryIds,
                decision,
                selectedIds,
                expectedUses,
                controlOperation,
              })
            },
            reopen: (from, stageId) => {
              claimed = true
              this.deletePendingPreviewIfCurrent(args.chatId, pending)
              this.startingChats.set(args.chatId, "previewing_memory")
              void this.runReopenedMemoryPreparation({
                args,
                ctx,
                previewId,
                revision: 1,
                proposalsId: proposalsId!,
                transferId,
                checkupId: checkupId!,
                from,
                stageId,
              })
            },
          }
          this.pendingPreviews.set(args.chatId, pending)
          gated = true
        }
        const willAssessRelevance = !autoProceed && Boolean(this.memoryRelevance) && ctx.injected.length > 0
        await this.store.appendMessage(
          args.chatId,
          timestamped({
            kind: "memory_preview",
            previewId,
            ...(this.policy.studyMode && this.policy.condition === "memosync"
              ? { taskId: this.getActiveStudyTaskId() ?? undefined }
              : {}),
            turn: ctx.turnNumber,
            task: args.memoryUserText ?? args.content,
            memories: ctx.injected.map((m) => ({ id: m.id, content: m.content, scope: m.scope })),
            // Which injected items this turn's transfer stage landed —
            // including reinforce-merges, so an accepted transfer is always
            // visibly accounted for in the receipt.
            ...(transferredIds.length ? { transferredIds } : {}),
            ...(willAssessRelevance ? { relevancePending: true } : {}),
            ...(attentionIds.length ? { attentionIds } : {}),
          })
        )
        // The card is durably in the transcript — the gate is now respondable.
        const parked = this.pendingPreviews.get(args.chatId)
        if (parked && parked.previewId === previewId) parked.published = true
        // REDESIGN D6: fire the sidecar relevance prediction DETACHED — the
        // receipt lands instantly; the highlight follows as its own entry
        // (~1-2s) and, when it beats the user's decision, also rides the
        // prompt as a "possibly relevant" hint. Failures vanish silently.
        if (willAssessRelevance) {
          const userText = args.memoryUserText ?? args.content
          // The gate card shows "picking likely-relevant…" until an entry
          // lands — so EVERY outcome appends one: hits, an empty list, and
          // failure all resolve the pending state (an empty list IS the
          // prediction "nothing clearly applies").
          const settle = async (relevant: RelevantMemory[]) => {
            const current = this.pendingPreviews.get(args.chatId)
            // The user may have reopened Step 1/2 while this revision-0
            // prediction was in flight. Never let that stale answer replace
            // the regenerated preview's relevance or next-prompt hint.
            if (current?.previewId !== previewId || current.revision !== 0) return
            const selectedIds = [...new Set([...attentionIds, ...relevant.map((item) => item.id)])]
            const expectedUses = await this.resolveExpectedUses(userText, ctx.injected, selectedIds, relevant)
            const stillCurrent = this.pendingPreviews.get(args.chatId)
            if (stillCurrent?.previewId !== previewId || stillCurrent.revision !== 0) return
            for (const use of expectedUses) stillCurrent.expectedUseById.set(use.id, use.expectedUse)
            if (relevant.length > 0) {
              this.memory!.logger.event({
                type: "memory.relevance",
                sessionId: args.chatId,
                turn: ctx.turnNumber,
                ids: relevant.map((r) => r.id),
              })
            }
            this.turnExpectedUses.set(args.chatId, expectedUses)
            await this.store.appendMessage(
              args.chatId,
              timestamped({ kind: "memory_preview_relevance", previewId, revision: 0, relevant: relevant.map(({ id, why }) => ({ id, why })), expectedUses })
            )
            this.emitStateChange(args.chatId)
          }
          void this.memoryRelevance!
            .assess(userText, ctx.injected, {
              mustInclude: attentionIds,
              recentContext: this.recentConversationDigest(args.chatId),
            })
            .then(settle)
            .catch(() => settle([]).catch(() => {}))
        }
        if (autoProceed) {
          // Stop can land during the preview-entry append here too — an
          // auto-proceeding turn is still a cancelled turn.
          if (this.cancelledDuringPreview.delete(args.chatId)) {
            this.emitStateChange(args.chatId, { immediate: true })
            return
          }
          // No memory in play this turn: record an automatic go_on (the
          // preview entry above keeps the research log complete) and boot
          // without parking — the friction is only spent when memory matters.
          await this.store.appendMessage(
            args.chatId,
            timestamped({ kind: "memory_preview_decision", previewId, decision: "go_on", auto: true })
          )
          if (args.openingReview) automaticOpeningWorkingMemory = { previewId, decision: "go_on" }
          this.memory!.logger.event({
            type: "memory.preview",
            sessionId: args.chatId,
            engine: args.provider,
            turn: ctx.turnNumber,
            memoryIds,
            decision: "auto_go_on",
          })
        } else if (this.cancelledDuringPreview.delete(args.chatId)) {
          // Stop landed during the appendMessage await above — unpark rather
          // than leave a gate for an already-cancelled turn (BUG AGENT-2),
          // unless a respond already claimed it (then the decision wins and
          // finishMemoryPreview owns the turn).
          if (this.pendingPreviews.get(args.chatId)?.previewId === previewId) {
            this.pendingPreviews.delete(args.chatId)
            gated = false
          }
          this.emitStateChange(args.chatId, { immediate: true })
          return
        }
        this.emitStateChange(args.chatId, { immediate: true })
      } catch (error) {
        const cancelled = this.cancelledDuringPreview.delete(args.chatId)
        if (!cancelled) {
          this.reportBackgroundError?.(
            `[memory-preview] chat ${args.chatId} turn ${ctx.turnNumber}: ${error instanceof Error ? error.message : String(error)}`
          )
        }
        // A decision may already own this turn: a respond claimed the gate
        // (finishMemoryPreview boots or cancels it), or Stop cancelled it
        // before the card was published. Degrading to a boot in either case
        // would run a second engine for the turn / resurrect a cancelled one.
        if (claimed) return
        if (cancelled) {
          this.pendingPreviews.delete(args.chatId)
          return
        }
        if (args.openingReview) {
          // The opening Board is an admission barrier, not an optional preview
          // enhancement. A failed durable phase transition must reach the
          // detached outer failure recorder; booting here would bypass the
          // Board while its server state still says preparing.
          this.pendingPreviews.delete(args.chatId)
          throw error
        }
        // Preview failures never block the turn — degrade to no-preview.
        this.pendingPreviews.delete(args.chatId)
        gated = false
      }
      if (gated) return
      await this.bootEngineTurn(
        automaticOpeningWorkingMemory ? { ...args, openingWorkingMemory: automaticOpeningWorkingMemory } : args,
        {
        chat: ctx.chat,
        project: ctx.project,
        turnNumber: ctx.turnNumber,
        memoryDisabledForTurn: false,
        },
      )
    } catch (error) {
      // The turn is detached from any chat.send ack here — record the failure
      // in the transcript the way the engine loops do.
      const message = error instanceof Error ? error.message : String(error)
      try {
        await this.store.appendMessage(
          args.chatId,
          timestamped({ kind: "result", subtype: "error", isError: true, durationMs: 0, result: message })
        )
        await this.store.recordTurnFailed(args.chatId, message)
      } finally {
        if (args.openingReview) this.scheduleOpeningBoardRecovery(args.openingReview.taskId)
        this.emitStateChange(args.chatId)
      }
    } finally {
      // Parked (pendingPreviews guards the chat), booted (activeTurns), or
      // failed — in every case the handed-over reservation is done.
      this.startingChats.delete(args.chatId)
      const activePreparation = this.activePreparations.get(args.chatId)
      this.activePreparations.delete(args.chatId)
      // Never leak a cancel flag or an abort handle into a later turn.
      this.cancelledDuringPreview.delete(args.chatId)
      // Resolve Stop only after every public busy/freeze guard is gone.
      activePreparation?.cancellation.settle()
    }
  }

  /**
   * Resume a preview-parked turn with the user's decision: record it
   * (append-only), then cancel the turn (dismiss) or boot the engine —
   * with injection disabled for "proceed without memory".
   */
  private async finishMemoryPreview(ctx: {
    args: StartTurnArgs
    chat: ReturnType<EventStore["requireChat"]>
    project: NonNullable<ReturnType<EventStore["getProject"]>>
    turnNumber: number
    previewId: string
    /** The receipt's full injected set. */
    memoryIds: string[]
    decision: MemoryPreviewDecision
    /** Present when the user EDITED the gate — inject only these this turn. */
    selectedIds?: string[]
    /** Exact instructions approved in the preview UI. */
    expectedUses?: ExpectedMemoryUse[]
    controlOperation?: PreviewControlOperation
  }) {
    const { args, decision } = ctx
    try {
      const selected = new Set(ctx.selectedIds ?? ctx.memoryIds)
      const expectedUses = (ctx.expectedUses ?? this.turnExpectedUses.get(args.chatId) ?? [])
        .filter((use) => selected.has(use.id) && typeof use.expectedUse === "string" && use.expectedUse.trim())
        .map((use) => ({ id: use.id, expectedUse: use.expectedUse.trim().slice(0, 220) }))
      await this.store.appendMessage(
        args.chatId,
        timestamped({ kind: "memory_preview_decision", previewId: ctx.previewId, decision, selectedIds: ctx.selectedIds, expectedUses })
      )
      this.memory?.logger.event({
        type: "memory.preview",
        ...(ctx.controlOperation ? { operationId: ctx.controlOperation.operationId } : {}),
        sessionId: args.chatId,
        engine: args.provider,
        turn: ctx.turnNumber,
        memoryIds: ctx.memoryIds,
        decision,
        selectedIds: ctx.selectedIds,
      })
      // An edited go_on scopes injection to the selection for THIS turn only —
      // consumed by every plan computation until the next turn starts.
      if (decision === "go_on" && ctx.selectedIds) {
        this.turnMemoryRestriction.set(args.chatId, ctx.selectedIds)
      }
      if (decision === "go_on" && expectedUses.length) {
        this.turnExpectedUses.set(args.chatId, expectedUses)
      }
      if (decision !== "go_on") this.turnExpectedUses.delete(args.chatId)

      if (decision === "dismiss") {
        await this.store.recordTurnCancelled(args.chatId)
        if (ctx.controlOperation) {
          try {
            this.memory?.logger.event({
              type: "study.control_operation",
              ...ctx.controlOperation,
              phase: "completed",
            })
          } catch {
            // The participant decision is already durable in the transcript.
          }
        }
        // Cancellation is now durable and any phased terminal was attempted.
        // Release before queue draining, which deliberately treats the claim
        // as a busy owner and would otherwise leave the next row parked.
        this.releasePendingPreviewResponse(args.chatId, ctx.previewId)
        this.emitStateChange(args.chatId, { immediate: true })
        await this.maybeStartNextQueuedMessage(args.chatId)
        return
      }

      this.emitStateChange(args.chatId)
      const providerArgs = args.openingReview && (decision === "go_on" || decision === "without_memory")
        ? { ...args, openingWorkingMemory: { previewId: ctx.previewId, decision } }
        : args
      await this.bootEngineTurn(this.refreshOpeningProviderAttachments(providerArgs), {
        chat: ctx.chat,
        project: ctx.project,
        turnNumber: ctx.turnNumber,
        memoryDisabledForTurn: decision === "without_memory",
      })
      if (ctx.controlOperation) {
        try {
          this.memory?.logger.event({
            type: "study.control_operation",
            ...ctx.controlOperation,
            phase: "completed",
          })
        } catch {
          // Claude accepted the dispatch; do not induce a duplicate retry.
        }
      }
    } catch (error) {
      if (ctx.controlOperation) {
        try {
          this.memory?.logger.event({
            type: "study.control_operation",
            ...ctx.controlOperation,
            phase: "failed",
            errorClass: error instanceof Error ? error.constructor.name : typeof error,
          })
        } catch {
          // Preserve the provider/transcript error as the participant-visible failure.
        }
      }
      // The turn is detached from any chat.send ack here — record the failure
      // in the transcript the way the engine loops do.
      const message = error instanceof Error ? error.message : String(error)
      await this.store.appendMessage(
        args.chatId,
        timestamped({ kind: "result", subtype: "error", isError: true, durationMs: 0, result: message })
      )
      await this.store.recordTurnFailed(args.chatId, message)
      this.emitStateChange(args.chatId)
    } finally {
      this.releasePendingPreviewResponse(args.chatId, ctx.previewId)
    }
  }

  /** Re-verify the private snapshot at the last in-process boundary before
   * Claude can observe its path. The opening Board may remain visible for
   * minutes after the first recovery check. */
  private refreshOpeningProviderAttachments(args: StartTurnArgs): StartTurnArgs {
    if (!args.openingReview || !this.openingBoardBacklog) return args
    const recovered = this.openingBoardBacklog.recoverOpeningPrompt(args.openingReview.taskId)
    if (
      !recovered
      || recovered.chatId !== args.chatId
      || recovered.reviewId !== args.openingReview.reviewId
    ) {
      throw new Error("The immutable opening attachment receipt is no longer available")
    }
    if (recovered.attachmentFailure) throw new Error(recovered.attachmentFailure)
    return { ...args, providerAttachments: recovered.providerAttachments }
  }

  /** Boot the engine for a turn (post-gate half of startTurnForChat). */
  private async bootEngineTurn(
    args: StartTurnArgs,
    ctx: {
      chat: ReturnType<EventStore["requireChat"]>
      project: NonNullable<ReturnType<EventStore["getProject"]>>
      turnNumber: number
      memoryDisabledForTurn: boolean
    }
  ) {
    const { chat, project, turnNumber, memoryDisabledForTurn } = ctx
    const turnRestriction = args.resume?.selectedIds ?? this.turnMemoryRestriction.get(args.chatId)
    const providerAttachments = args.providerAttachments ?? args.attachments

    // The project dir can vanish under a recorded project (a container rebuild
    // wipes non-volume paths); spawning an engine with a missing cwd fails as
    // a misleading "native binary failed to launch" / posix_spawn ENOENT
    // (QA BUG-001/002/004). Recreate it before any boot.
    await ensureProjectDirectory(project.localPath)

    // Snapshot BEFORE any engine boot awaits: what this turn injects (trace's
    // ground truth). Sourced from the injection plan, NOT injectedFor — in
    // file mode the model sees workspace files, so no item ids are "in play".
    const turnMemoryPlan =
      this.memory && !memoryDisabledForTurn
        ? planMemoryInjection({
            policy: this.policy,
            provider: args.provider,
            memory: this.memory,
            projectId: chat.projectId,
            chatId: args.chatId,
            workspaceDir: project.localPath,
            restrictToIds: turnRestriction,
          })
        : null
    const injectedIdsAtBoot = turnMemoryPlan?.injectedMemories.map((m) => m.id) ?? []

    const onToolRequest = async (request: HarnessToolRequest): Promise<unknown> => {
      const active = this.activeTurns.get(args.chatId)
      if (!active) {
        throw new Error("Chat turn ended unexpectedly")
      }

      active.status = "waiting_for_user"
      this.emitStateChange(args.chatId)

      return await new Promise<unknown>((resolve) => {
        active.pendingTool = {
          toolUseId: request.tool.toolId,
          tool: request.tool,
          resolve,
        }
      })
    }

    let turn: HarnessTurn
    if (args.provider === "claude") {
      logSendToStartingProfile(args.profile, "start_turn.provider_boot.begin", {
        chatId: args.chatId,
        provider: args.provider,
        model: args.model,
      })
      turn = await this.startClaudeTurn({
        chatId: args.chatId,
        localPath: project.localPath,
        model: args.model,
        effort: args.effort,
        planMode: args.planMode,
        sessionToken: chat.pendingForkSessionToken ?? chat.sessionToken,
        forkSession: Boolean(chat.pendingForkSessionToken),
        onToolRequest,
        projectId: chat.projectId,
        memoryEnabled: !memoryDisabledForTurn,
        memoryPlan: turnMemoryPlan,
        restrictMemoryIds: turnRestriction,
      })
      logSendToStartingProfile(args.profile, "start_turn.provider_boot.ready", {
        chatId: args.chatId,
        provider: args.provider,
        model: args.model,
      })
    } else {
      logSendToStartingProfile(args.profile, "start_turn.provider_boot.begin", {
        chatId: args.chatId,
        provider: args.provider,
        model: args.model,
      })
      // MemoSync memory for Codex: declare the memory tools as dynamic tools
      // (when the arm has tools at all), inject the arm's block as
      // developer_instructions, and dispatch item/tool/call to the memory
      // handler. Codex injection is per-turn, so file-mode contents are
      // naturally fresh each turn.
      // "Proceed without memory" (preview gate): skip injection for this turn.
      // The dynamic tool declarations are thread-level and persist regardless.
      const codexPlan: MemoryInjectionPlan | null =
        this.memory && !memoryDisabledForTurn
          ? planMemoryInjection({
              policy: this.policy,
              provider: "codex",
              memory: this.memory,
              projectId: chat.projectId,
              chatId: args.chatId,
              workspaceDir: project.localPath,
              restrictToIds: turnRestriction,
            })
          : null
      // "Proceed without memory" must also cut off tool DISPATCH this turn —
      // not just the injected block (bug-hunt #9). (Codex dynamic-tool
      // DECLARATIONS are thread-level and persist across turns by protocol, but
      // with no dispatch handler a call this turn is a no-op.)
      const codexMemorySpecs =
        this.memory && this.policy.memoryTools && !memoryDisabledForTurn
          ? buildMemoryToolSpecs(this.memory, {
              capture: this.capture,
              onProposed: (created, info) => {
                // Redesign 2026-08-07 §3: mid-turn proposals park in the store
                // and surface at the NEXT turn's step-one gate. Only
                // auto-applied ones (delegating policy) card immediately —
                // they took effect without asking.
                const autoIds = info?.resurfaced ? new Set<string>() : this.autoApplyProposals(created, { chatId: args.chatId })
                const autoApplied = created.filter(({ id }) => autoIds.has(id))
                if (!autoApplied.length) return
                void this.store
                  .appendMessage(
                    args.chatId,
                    timestamped({
                      kind: "memory_candidates",
                      candidates: autoApplied.map(({ id }) => ({ id, auto: true })),
                    })
                  )
                  .then(() => this.emitStateChange(args.chatId))
                  .catch(() => {})
              },
            })
          : []
      const codexMemoryBlock = codexPlan?.block ?? ""
      if (this.memory && codexPlan && codexMemoryBlock) {
        this.memory.logger.event({
          type: "memory.inject",
          sessionId: args.chatId,
          engine: "codex",
          memories: codexPlan.injectedMemories.map((m) => ({ id: m.id, scope: m.scope })),
          tokenEstimate: Math.ceil(codexMemoryBlock.length / 4),
          mode: codexPlan.mode,
          staticFiles: codexPlan.staticFiles.length ? codexPlan.staticFiles : undefined,
        })
      }
      const onDynamicToolCall = codexMemorySpecs.length
        ? async (name: string, toolArgs: Record<string, unknown>) => {
            const r = await dispatchMemoryTool(codexMemorySpecs, name, toolArgs, {
              projectId: chat.projectId,
              sessionId: args.chatId,
            })
            return { text: r.text, isError: r.isError }
          }
        : undefined
      const sessionToken = await this.codexManager.startSession({
        chatId: args.chatId,
        cwd: project.localPath,
        model: args.model,
        serviceTier: args.serviceTier,
        sessionToken: chat.sessionToken,
        pendingForkSessionToken: chat.pendingForkSessionToken,
        dynamicTools: codexMemorySpecs.length ? toCodexDynamicTools(codexMemorySpecs) : undefined,
      })
      if (chat.pendingForkSessionToken && sessionToken) {
        await this.store.setPendingForkSessionToken(args.chatId, null)
      }
      logSendToStartingProfile(args.profile, "start_turn.session_ready", {
        chatId: args.chatId,
        provider: args.provider,
        model: args.model,
      })
      turn = await this.codexManager.startTurn({
        chatId: args.chatId,
        content: buildPromptText(args.content, providerAttachments),
        model: args.model,
        effort: args.effort as any,
        serviceTier: args.serviceTier,
        planMode: args.planMode,
        onToolRequest,
        developerInstructions: codexMemoryBlock || undefined,
        onDynamicToolCall,
      })
      logSendToStartingProfile(args.profile, "start_turn.provider_boot.ready", {
        chatId: args.chatId,
        provider: args.provider,
        model: args.model,
      })
    }

    const active: ActiveTurn = {
      chatId: args.chatId,
      provider: args.provider,
      turn,
      model: args.model,
      effort: args.effort,
      serviceTier: args.serviceTier,
      planMode: args.planMode,
      status: args.provider === "claude" ? "running" : "starting",
      pendingTool: null,
      postToolFollowUp: null,
      hasFinalResult: false,
      cancelRequested: false,
      cancelRecorded: false,
      providerTurnStarted: false,
      clientTraceId: args.profile?.traceId,
      profilingStartedAt: args.profile?.startedAt,
      turnNumber,
      turnId: args.turnId!,
      taskId: this.getActiveStudyTaskId(),
      memoryPlan: turnMemoryPlan,
      // Capture/trace judge the user's real words, not the steer wrapper (BUG AGENT-4).
      userText: args.memoryUserText ?? args.content,
      assistantChunks: [],
      citedIds: new Set<string>(),
      memoryDisabled: memoryDisabledForTurn,
      injectedIds: injectedIdsAtBoot,
    }
    this.activeTurns.set(args.chatId, active)
    if (active.taskId) {
      const taskChats = this.studyTaskChats.get(active.taskId) ?? new Set<string>()
      taskChats.add(args.chatId)
      this.studyTaskChats.set(active.taskId, taskChats)
      const taskPaths = this.studyTaskProjectPaths.get(active.taskId) ?? new Set<string>()
      taskPaths.add(project.localPath)
      this.studyTaskProjectPaths.set(active.taskId, taskPaths)
    }
    logSendToStartingProfile(args.profile, "start_turn.active_turn_registered", {
      chatId: args.chatId,
      status: active.status,
    })
    this.emitStateChange(args.chatId, { immediate: active.status === "starting" })
    logSendToStartingProfile(args.profile, "start_turn.state_change_emitted", {
      chatId: args.chatId,
      status: active.status,
    })

    if (turn.getAccountInfo) {
      void turn.getAccountInfo()
        .then(async (accountInfo) => {
          if (!accountInfo) return
          if (args.provider === "claude") {
            const session = this.claudeSessions.get(args.chatId)
            if (session) {
              if (session.accountInfoLoaded) return
              session.accountInfoLoaded = true
            } else {
              return
            }
          }
          await this.store.appendMessage(args.chatId, timestamped({ kind: "account_info", accountInfo }))
          this.emitStateChange(args.chatId)
        })
        .catch(() => undefined)
    }

    if (args.provider === "claude") {
      const session = this.claudeSessions.get(args.chatId)
      if (!session) {
        throw new Error("Claude session was not initialized")
      }
      // REDESIGN D1/D3: memory changes ride the user turn as a delta block —
      // the session's system prompt is never rebuilt for them, so the prompt
      // cache survives — and the capture nudge rides the same envelope so the
      // agent keeps its propose_memory agency in mind. Quiet turns with no
      // nudge append nothing.
      let promptText = buildPromptText(args.content, providerAttachments)
      let deliveredFocusIds = [...active.injectedIds]
      let deliveredVisiblePool = active.memoryPlan?.bakedMemories ?? []
      let deliveredFocusedMemories = active.memoryPlan?.injectedMemories ?? []
      let deliveredExpectedUses: ExpectedMemoryUse[] = []
      let deliveredResumeInterruptId: string | undefined
      let nextMemoryBaseline: Map<string, number> | null = null
      const repeatedFocusText = active.memoryPlan?.mode === "plain" || active.memoryPlan?.mode === "file"
        ? active.memoryPlan.block
        : ""
      if (repeatedFocusText) {
        promptText += `\n\n<system-reminder>\n${repeatedFocusText}\n</system-reminder>`
      }
      if (session.memoryBaseline && this.memory) {
        const delta = computeMemoryTurnDelta({
          memory: this.memory,
          projectId: chat.projectId,
          chatId: args.chatId,
          baseline: session.memoryBaseline,
          restrictToIds: turnRestriction,
        })
        // Commit the new baseline only after Claude accepts this prompt. If
        // sendPrompt fails, the next attempt must resend the same delta.
        nextMemoryBaseline = delta.nextBaseline
        deliveredFocusIds = delta.effectiveIds
        deliveredVisiblePool = delta.visibleMemories
        deliveredFocusedMemories = delta.effectiveMemories
        const reminderParts: string[] = []
        if (delta.block) reminderParts.push(delta.block)
        // The relevance PREDICTION (one-shot, best-effort): a hint, framed as
        // such — the agent still owns the judgment of what actually applies.
        // Focus items that carry a detail get named for load_memory_detail
        // (option A, 2026-08-05): the tool call stays the agent's act — and
        // stays measurable — but it is pointed at, not left to chance.
        // Pay-attention follow-up ①: the flagged ids are named outright — a
        // violated-last-turn memory gets an explicit compliance reminder, not
        // just a prediction-flavored hint.
        // Enforce (2026-08-19 D1): a hard order, not a nudge — the memory is
        // locked into this run and the order cites the violation evidence.
        // An enforce the user cancelled at the confirmation card (removed from
        // the selection) must not ride: filter by the turn's restriction.
        const turnRestrictionForEnforce = turnRestriction
        const payAttention = (this.turnPayAttention.get(args.chatId) ?? []).filter(
          (e) => turnRestrictionForEnforce === undefined || turnRestrictionForEnforce.includes(e.id),
        )
        this.turnPayAttention.delete(args.chatId)
        if (payAttention.length) {
          reminderParts.push(
            payAttention
              .map(
                (e) =>
                  `ENFORCED THIS RUN: [${e.id}] MUST be followed — the user explicitly enforced it after it was violated on the previous turn.` +
                  (e.quote ? ` Evidence of that violation: "${e.quote}"` : ""),
              )
              .join("\n"),
          )
        }
        // Resume-after-interrupt (2026-08-19 C2): continuation, not a redo —
        // the cancelled partial trajectory is still in this session's history.
        const resumeCtx = args.resume
        deliveredResumeInterruptId = resumeCtx?.interruptId
        if (resumeCtx) {
          if (resumeCtx.enforce) {
            if (!deliveredFocusIds.includes(resumeCtx.memoryId)) {
              // The pool changed after recovery preflight but before prompt
              // composition. Abort without dispatching a false hard order or
              // leaving the chat registered as running; the durable prompt id
              // remains reusable by a corrected retry.
              if (this.activeTurns.get(args.chatId) === active) this.activeTurns.delete(args.chatId)
              this.startingChats.delete(args.chatId)
              active.turn.close()
              this.emitStateChange(args.chatId, { immediate: true })
              throw new Error("The enforced memory is no longer in the current chat's effective Working Memory")
            }
            reminderParts.push(
              `ENFORCED THIS RUN: [${resumeCtx.memoryId}] MUST be followed — the user explicitly enforced it while recovering an interrupted turn.` +
                (resumeCtx.quote ? ` Evidence of that violation: "${resumeCtx.quote}"` : "") +
                (resumeCtx.correction ? ` Required correction: "${resumeCtx.correction}"` : ""),
            )
          }
          const selectionNote = deliveredFocusIds.includes(resumeCtx.memoryId)
            ? ""
            : ` [${resumeCtx.memoryId}] was removed from this turn's working memory.`
          reminderParts.push(
            "RESUMING AN INTERRUPTED TURN: your previous reply above was stopped by the user midway " +
              `after they identified a problem involving [${resumeCtx.memoryId}]. Do not redo work that already completed; ` +
              `continue from where it stopped.${selectionNote} Participant correction: ${resumeCtx.correction}`,
          )
        }
        const expectedUses = this.turnExpectedUses.get(args.chatId)
        this.turnExpectedUses.delete(args.chatId)
        if (expectedUses?.length) {
          deliveredExpectedUses = expectedUses
          const detailIds = this.policy.memoryTools
            ? expectedUses.filter((use) => Boolean(this.memory!.store.getById(use.id)?.detail)).map((use) => use.id)
            : []
          const withDetail = new Set(detailIds)
          reminderParts.push(
            "How the selected memories are expected to guide this turn:\n" +
              expectedUses
                .map((use) => `- [${use.id}]${withDetail.has(use.id) ? " [+detail]" : ""} ${use.expectedUse}`)
                .join("\n") +
              (detailIds.length
                ? ` Load the [+detail] ones (${detailIds.map((id) => `[${id}]`).join(", ")}) with load_memory_detail before relying on them.`
                : ""),
          )
        }
        // Cite nudge rides every memory-bearing turn; an edited gate that
        // selected ZERO memories is the one case with nothing to cite.
        const memoryBearingTurn =
          this.policy.memoryTools && (turnRestriction === undefined || turnRestriction.length > 0)
        if (memoryBearingTurn) {
          reminderParts.push(CITE_NUDGE)
          // Tool salience for DeepSeek: only when the working set really has
          // [+detail] items (stable string — constant cache cost).
          const injectedNow = this.memory!.injectedFor(chat.projectId, args.chatId)
          if (injectedNow.some((m) => m.detail && (turnRestriction === undefined || turnRestriction.includes(m.id)))) {
            reminderParts.push(DETAIL_NUDGE)
          }
        }
        if (this.capture && this.policy.memoryTools) reminderParts.push(CAPTURE_NUDGE)
        if (reminderParts.length > 0) {
          promptText += `\n\n<system-reminder>\n${reminderParts.join("\n\n")}\n</system-reminder>`
        }
      }
      const promptSeq = session.nextPromptSeq + 1
      session.nextPromptSeq = promptSeq
      session.pendingPromptSeqs.push(promptSeq)
      active.claudePromptSeq = promptSeq
      logClaudeSteer("claude_prompt_sent", {
        chatId: args.chatId,
        sessionId: session.id,
        promptSeq,
        activeStatus: active.status,
        contentPreview: args.content.slice(0, 160),
        pendingPromptSeqs: [...session.pendingPromptSeqs],
      })
      const openingFocusDelivery = args.openingReview && args.openingWorkingMemory && this.memory
        ? buildDeliveredStoreFocusEvent({
            condition: "memosync",
            taskId: active.taskId,
            chatId: args.chatId,
            turnId: active.turnId,
            turn: active.turnNumber ?? turnNumber,
            mode: "skills",
            promptText,
            visiblePool: deliveredVisiblePool,
            focusedMemories: deliveredFocusedMemories,
            expectedUses: deliveredExpectedUses,
            disabled: active.memoryDisabled,
            resumeOfInterruptId: deliveredResumeInterruptId,
          })
        : null
      const openingProviderDispatch = args.openingReview && args.openingWorkingMemory
        ? {
            taskId: args.openingReview.taskId,
            chatId: args.chatId,
            reviewId: args.openingReview.reviewId,
            phase: "completed" as const,
            previewId: args.openingWorkingMemory.previewId,
            decision: args.openingWorkingMemory.decision,
            ...(openingFocusDelivery ? { focusDelivery: openingFocusDelivery } : {}),
          }
        : null
      if (openingProviderDispatch) {
        const claim = this.openingBoardBacklog?.claimOpeningProviderDispatch(openingProviderDispatch)
        if (claim !== "claimed") {
          throw new Error(`Opening prompt provider dispatch is already ${claim ?? "unavailable"}`)
        }
      }
      try {
        await session.session.sendPrompt(promptText, {
          turn: active.turnNumber ?? turnNumber,
          engine: "claude",
          promptSeq,
        })
      } catch (error) {
        try {
          if (openingProviderDispatch) {
            this.openingBoardBacklog!.settleOpeningProviderDispatch(openingProviderDispatch, "failed")
          }
        } finally {
          // bootEngineTurn registered the turn before asking the persistent
          // Claude session to accept this prompt. A definitive rejection never
          // reaches runClaudeSession's event loop, so release only this exact
          // owner here and close its unusable session. Otherwise the chat and
          // study freeze barrier remain busy forever.
          if (this.activeTurns.get(args.chatId) === active) {
            this.activeTurns.delete(args.chatId)
          }
          if (this.claudeSessions.get(args.chatId) === session) {
            this.claudeSessions.delete(args.chatId)
          }
          this.clearStreamingAssistantText(args.chatId)
          session.session.close()
          active.turn.close()
          this.emitStateChange(args.chatId, { immediate: true })
        }
        throw error
      }
      if (openingProviderDispatch) {
        this.openingBoardBacklog!.settleOpeningProviderDispatch(openingProviderDispatch, "delivered")
      }
      if (nextMemoryBaseline) session.memoryBaseline = nextMemoryBaseline
      active.injectedIds = deliveredFocusIds
      args.onMemoryDeliveryAccepted?.([...deliveredFocusIds])
      if (this.memory && (this.policy.condition === "memosync" || this.policy.condition === "auto")) {
        try {
          if (openingFocusDelivery) {
            persistDeliveredStoreFocusEvent({
              event: openingFocusDelivery,
              condition: "memosync",
              logger: this.memory.logger,
              studyStore: this.studyMemoryStore ?? undefined,
            })
          } else {
            recordDeliveredStoreFocus({
              logger: this.memory.logger,
              studyStore: this.studyMemoryStore ?? undefined,
              condition: this.policy.condition,
              taskId: active.taskId,
              chatId: args.chatId,
              turnId: active.turnId,
              turn: active.turnNumber ?? turnNumber,
              mode: this.policy.condition === "memosync" ? "skills" : "plain",
              promptText,
              visiblePool: deliveredVisiblePool,
              focusedMemories: deliveredFocusedMemories,
              getAutoProjectCloneRef: this.policy.condition === "auto"
                ? (memoryId) => this.memory!.getAutoProjectCloneRef(memoryId)
                : undefined,
              expectedUses: this.policy.condition === "memosync" ? deliveredExpectedUses : undefined,
              disabled: active.memoryDisabled,
              focusPayloadText: repeatedFocusText || undefined,
              resumeOfInterruptId: deliveredResumeInterruptId,
            })
          }
        } catch (error) {
          if (active.taskId) {
            this.noteStudyMemoryQualityFlag({
              code: "focus_persistence_failed",
              blocking: true,
              taskId: active.taskId,
              chatId: args.chatId,
              turnId: active.turnId,
              turn: active.turnNumber ?? turnNumber,
            })
          }
          this.reportBackgroundError?.(
            `[study-focus] chat ${args.chatId} turn ${active.turnNumber ?? turnNumber}: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      } else if (this.policy.condition === "static") {
        this.launchStaticFocusMaterialization({
          taskId: active.taskId,
          projectId: chat.projectId,
          chatId: args.chatId,
          turnId: active.turnId,
          turn: active.turnNumber ?? turnNumber,
          promptText,
          plan: active.memoryPlan,
        })
      }
      logSendToStartingProfile(args.profile, "start_turn.claude_prompt_sent", {
        chatId: args.chatId,
      })
      return
    }

    void this.runTurn(active)
  }

  private async startClaudeTurn(args: {
    chatId: string
    localPath: string
    model: string
    effort?: string
    planMode: boolean
    sessionToken: string | null
    forkSession: boolean
    onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
    projectId?: string
    /** false = "proceed without memory": boot/reboot the session without the memory block/tools. */
    memoryEnabled?: boolean
    /** Exact plan already computed for this turn. */
    memoryPlan?: MemoryInjectionPlan | null
    /** Exact turn-only selection confirmed by the gate or interrupt recovery card. */
    restrictMemoryIds?: string[]
  }): Promise<HarnessTurn> {
    // Ensure/recover the one managed preview on every participant prompt, not
    // only when the Claude query happens to rebuild. Project switches retire
    // the old query before the supervisor replaces its process group.
    await this.prepareStudyProjectRuntime(args.localPath)
    let session = this.claudeSessions.get(args.chatId)
    const memoryEnabled = args.memoryEnabled ?? true

    // What forces a session rebuild (REDESIGN D1): enabled/disabled flips,
    // mode/tools flips (arm switch), and plain/file CONTENT changes — those
    // modes have no delta channel. Skills-mode content changes deliberately do
    // NOT rebuild: they ride the next user turn as a delta block, so the
    // prompt cache survives every edit/accept/archive. The key comes from the
    // same plan the session boot uses, so check and boot can never disagree.
    const turnPlan = args.memoryPlan !== undefined
      ? args.memoryPlan
      : memoryEnabled && this.memory
        ? planMemoryInjection({
            policy: this.policy,
            provider: "claude",
            memory: this.memory,
            projectId: args.projectId,
            chatId: args.chatId,
            workspaceDir: args.localPath,
            restrictToIds: args.restrictMemoryIds,
          })
        : null
    const desiredMemoryHash = turnPlan?.sessionRebuildKey ?? "memory-off"
    if (
      !session ||
      session.retired ||
      session.localPath !== args.localPath ||
      session.effort !== args.effort ||
      session.memorySetHash !== desiredMemoryHash ||
      args.forkSession
    ) {
      let resumeToken = session?.sessionToken ?? args.sessionToken
      // Engine session files live on the container FS, not the /data volume:
      // after a container rebuild/recreate the stored token has no backing
      // file, resume fails as a misleading "native binary failed to launch",
      // and the chat is permanently stuck. Validate and fall back to a fresh
      // session (context lost, chat alive).
      if (resumeToken && !this.claudeSessionFileExists(args.localPath, resumeToken)) {
        console.warn(
          `[claude] resume token for chat ${args.chatId} has no session file (recreated container?) — starting fresh`,
        )
        resumeToken = null
        await this.store.setSessionToken(args.chatId, null)
      }
      if (session) {
        await this.retireClaudeSession(session, "session_rebuild")
      }

      const started = await this.startClaudeSessionFn({
        localPath: args.localPath,
        model: args.model,
        effort: args.effort,
        planMode: args.planMode,
        sessionToken: resumeToken,
        forkSession: args.forkSession,
        onToolRequest: args.onToolRequest,
        memory: memoryEnabled ? this.memory : null,
        capture: memoryEnabled ? this.capture : null,
        projectId: args.projectId,
        chatId: args.chatId,
        policy: this.policy,
        studyPreviewRuntime: this.studyPreviewRuntime,
        subprocessEnv: buildClaudeSubprocessEnv({
          localPath: args.localPath,
          rawStudyProjects: this.policy.studyMode ? process.env.STUDY_PROJECTS : undefined,
        }),
        memoryPlan: turnPlan,
        restrictMemoryIds: args.restrictMemoryIds,
        // Redesign 2026-08-07 §3: agent-channel proposals park in the store
        // and surface at the NEXT turn's step-one gate, same as hook-channel
        // ones. Only auto-applied proposals (delegating policy) card
        // immediately — they took effect without asking.
        onMemoryProposal: (created) => {
          const autoIds = this.autoApplyProposals(created, { chatId: args.chatId })
          const autoApplied = created.filter(({ id }) => autoIds.has(id))
          if (!autoApplied.length) return
          void this.store
            .appendMessage(
              args.chatId,
              timestamped({
                kind: "memory_candidates",
                candidates: autoApplied.map(({ id }) => ({ id, auto: true })),
              })
            )
            .then(() => this.emitStateChange(args.chatId))
            .catch(() => {})
        },
      })
      this.refreshClaudeModelCatalog(started)

      // Baseline = what the boot block actually baked (full set, ignoring any
      // per-turn restriction). Prefer the plan the session function really
      // used; test stubs that don't report one fall back to this turn's plan.
      const bootPlan = started.memoryPlan !== undefined ? started.memoryPlan : turnPlan
      session = {
        id: crypto.randomUUID(),
        chatId: args.chatId,
        session: started,
        localPath: args.localPath,
        model: args.model,
        effort: args.effort,
        planMode: args.planMode,
        sessionToken: resumeToken,
        accountInfoLoaded: false,
        nextPromptSeq: 0,
        pendingPromptSeqs: [],
        retired: false,
        retireReason: null,
        pump: null,
        memorySetHash: desiredMemoryHash,
        memoryBaseline:
          bootPlan?.mode === "skills"
            ? new Map(bootPlan.bakedMemories.map((m) => [m.id, m.version]))
            : null,
      }
      this.claudeSessions.set(args.chatId, session)
      session.pump = this.runClaudeSession(session)
    } else {
      if (session.model !== args.model) {
        await session.session.setModel(args.model)
        session.model = args.model
      }
      if (session.planMode !== args.planMode) {
        await session.session.setPermissionMode(args.planMode)
        session.planMode = args.planMode
      }
    }

    return {
      provider: "claude",
      stream: {
        async *[Symbol.asyncIterator]() {},
      },
      getAccountInfo: session.session.getAccountInfo,
      interrupt: session.session.interrupt,
      close: () => {},
    }
  }

  async send(command: Extract<ClientCommand, { type: "chat.send" }>) {
    const profile = command.clientTraceId
      ? { traceId: command.clientTraceId, startedAt: performance.now() }
      : null
    let chatId = command.chatId

    logSendToStartingProfile(profile, "chat_send.received", {
      existingChatId: command.chatId ?? null,
      projectId: command.projectId ?? null,
    })

    // Reject before createChat so a wrong-project or copied prompt cannot
    // leave an empty chat as its only side effect.
    this.assertStudyPromptAllowed({
      chatId,
      projectId: command.projectId,
      channel: "chat.send",
      content: command.content,
      attachments: command.attachments,
      openingReviewId: command.openingReviewId,
    })

    if (!chatId) {
      if (!command.projectId) {
        throw new Error("Missing projectId for new chat")
      }
      const created = await this.store.createChat(command.projectId)
      chatId = created.id
      logSendToStartingProfile(profile, "chat_send.chat_created", {
        chatId,
        projectId: command.projectId,
      })
    }

    // Recheck after awaited createChat but before a
    // prompt can be queued, persisted, focused, or started. With no await
    // between this check and startTurnForChat's synchronous reservation, a
    // concurrent study freeze must now either win here or observe the turn.
    this.assertStudyPromptAllowed({
      chatId,
      content: command.content,
      channel: "chat.send",
      attachments: command.attachments,
      openingReviewId: command.openingReviewId,
    })

    const chat = this.store.requireChat(chatId)
    const provider = this.resolveProvider(command, chat.provider)
    let openingReview: StartTurnArgs["openingReview"]
    if (command.openingReviewId) {
      const taskId = this.getActiveStudyTaskId()
      if (
        !taskId
        || !this.openingBoardBacklog
        || !this.policy.studyMode
        || this.policy.condition !== "memosync"
        || provider !== "claude"
      ) {
        throw new Error("Opening Memory Board prompt preparation is unavailable")
      }
      const openingInput = {
        taskId,
        chatId,
        reviewId: command.openingReviewId,
        content: command.content,
        attachments: command.attachments ?? [],
      }
      if (this.openingBoardBacklog.claimOpeningPromptDispatch(openingInput) === "duplicate") {
        return { chatId, openingReviewDuplicate: true as const }
      }
      openingReview = { taskId, reviewId: command.openingReviewId }
    }
    if (
      this.activeTurns.has(chatId)
      || this.hasPendingPreviewActivity(chatId)
      || this.startingChats.has(chatId)
      || this.pendingAutoCaptureStarts.has(chatId)
    ) {
      if (openingReview) throw new Error("The opening first message cannot be queued behind another turn")
      const queuedMessage = await this.enqueueMessage(chatId, command.content, command.attachments ?? [], {
        provider: command.provider,
        model: command.model,
        modelOptions: command.modelOptions,
        effort: command.effort,
        planMode: command.planMode,
      })
      return { chatId, queuedMessageId: queuedMessage.id, queued: true as const }
    }

    const settings = this.getProviderSettings(provider, command)
    if (this.shouldQueueBehindAutoCapture(provider)) {
      const queuedMessage = await this.enqueueMessage(chatId, command.content, command.attachments ?? [], {
        provider: command.provider,
        model: command.model,
        modelOptions: command.modelOptions,
        effort: command.effort,
        planMode: command.planMode,
      })
      this.scheduleAutoCaptureQueueDrain(chatId, queuedMessage.id)
      logSendToStartingProfile(profile, "chat_send.ready_for_ack", {
        chatId,
        provider,
        model: settings.model,
        deferredForAutoCapture: true,
      })
      return { chatId, queuedMessageId: queuedMessage.id, queued: true as const }
    }

    await this.startTurnForChat({
      chatId,
      provider,
      content: command.content,
      attachments: command.attachments ?? [],
      model: settings.model,
      effort: settings.effort,
      serviceTier: settings.serviceTier,
      planMode: settings.planMode,
      appendUserPrompt: true,
      profile,
      openingReview,
      ...(openingReview ? { turnId: openingReview.reviewId } : {}),
    })

    logSendToStartingProfile(profile, "chat_send.ready_for_ack", {
      chatId,
      provider,
      model: settings.model,
    })

    return { chatId }
  }

  async enqueue(command: Extract<ClientCommand, { type: "message.enqueue" }>) {
    const queuedMessage = await this.enqueueMessage(command.chatId, command.content, command.attachments ?? [], {
      provider: command.provider,
      model: command.model,
      modelOptions: command.modelOptions,
      planMode: command.planMode,
    }, "message.enqueue")
    return { queuedMessageId: queuedMessage.id }
  }

  async steer(command: Extract<ClientCommand, { type: "message.steer" }>) {
    const queuedMessage = this.store.getQueuedMessage(command.chatId, command.queuedMessageId)
    if (!queuedMessage) {
      throw new Error("Queued message not found")
    }
    this.assertStudyPromptAllowed({
      chatId: command.chatId,
      content: queuedMessage.content,
      channel: "message.steer",
      attachments: queuedMessage.attachments,
    })

    logClaudeSteer("steer_requested", {
      chatId: command.chatId,
      queuedMessageId: command.queuedMessageId,
      activeTurn: this.activeTurns.has(command.chatId),
      queuedMessagePreview: queuedMessage.content.slice(0, 160),
    })

    // "Running" is any of activeTurns / parked preview gate / starting-or-
    // previewing reservation — not just activeTurns. Cancelling a parked gate or
    // an in-flight preview pass settles it (see cancel()); then we re-check.
    const isBusy = () =>
      this.activeTurns.has(command.chatId)
      || this.hasPendingPreviewActivity(command.chatId)
      || this.startingChats.has(command.chatId)
      || this.pendingAutoCaptureStarts.has(command.chatId)

    if (isBusy()) {
      await this.cancel(command.chatId, { hideInterrupted: true })
    }

    logClaudeSteer("steer_after_cancel", {
      chatId: command.chatId,
      stillActive: this.activeTurns.has(command.chatId),
    })

    // Throw BEFORE touching the queue: dequeueAndStartQueuedMessage removes the
    // message first and only then starts the turn, so if the chat were still
    // busy (e.g. the previewing-memory reservation cancel can't yet abort), the
    // startTurnForChat guard would throw AFTER the message was already deleted —
    // losing it entirely (BUG AGENT-1). Guarding here keeps it in the queue.
    if (isBusy()) {
      throw new Error("Chat is still running")
    }

    await this.dequeueAndStartQueuedMessage(command.chatId, queuedMessage, { steered: true })
  }

  async dequeue(command: Extract<ClientCommand, { type: "message.dequeue" }>) {
    const queuedMessage = this.store.getQueuedMessage(command.chatId, command.queuedMessageId)
    if (!queuedMessage) {
      throw new Error("Queued message not found")
    }

    await this.store.removeQueuedMessage(command.chatId, command.queuedMessageId)
  }

  async forkChat(chatId: string) {
    const chat = this.store.requireChat(chatId)
    if (this.activeTurns.has(chatId) || this.drainingStreams.has(chatId)) {
      throw new Error("Chat must be idle before forking")
    }
    if (!chat.provider) {
      throw new Error("Chat must have a provider before forking")
    }
    if (!chat.sessionToken && !chat.pendingForkSessionToken) {
      throw new Error("Chat has no session to fork")
    }

    const forked = await this.store.forkChat(chatId)
    return { chatId: forked.id }
  }

  private async runClaudeSession(session: ClaudeSessionState) {
    try {
      for await (const event of session.session.stream) {
        if (session.retired) {
          this.reportBackgroundError?.(
            `[claude-retired-event] dropped ${event.entry?.kind ?? event.type} for chat ${session.chatId} after ${session.retireReason ?? "retirement"}`,
          )
          continue
        }
        const participantOrigin = event.origin === "human"
          || (!this.policy.studyMode && (event.origin === undefined || event.origin === "unknown"))
        if (!participantOrigin) {
          this.reportBackgroundError?.(
            `[claude-background-event] dropped ${event.entry?.kind ?? event.type} with origin ${event.origin} for chat ${session.chatId}`,
          )
          continue
        }
        if (event.type === "session_token" && event.sessionToken) {
          session.sessionToken = event.sessionToken
          await this.store.setSessionToken(session.chatId, event.sessionToken)
          this.emitStateChange(session.chatId)
          continue
        }

        if (event.type === "assistant_delta") {
          this.appendAssistantDelta(session.chatId, event)
          continue
        }

        if (!event.entry) continue
        if (event.entry.kind === "assistant_text" || event.entry.kind === "result" || event.entry.kind === "interrupted") {
          // Final text replaces the streaming preview in the same broadcast;
          // result/interrupted also sweep it in case no final text arrived.
          this.clearStreamingAssistantText(session.chatId)
        }
        await this.store.appendMessage(session.chatId, event.entry)
        const active = this.activeTurns.get(session.chatId)
        if (event.entry.kind === "compact_boundary") {
          // Longitudinal signal: recall/citation behavior changes character
          // across a compaction boundary, so the record needs its timestamp.
          this.memory?.logger.event({
            type: "turn.compacted",
            sessionId: session.chatId,
            engine: "claude",
            ...(active?.turnNumber !== undefined ? { turn: active.turnNumber } : {}),
          })
        }
        if (event.entry.kind === "assistant_text") {
          const counted = this.recordMemoryCitations(event.entry.text, session.chatId)
          if (active) {
            active.assistantChunks.push(event.entry.text)
            for (const id of counted) active.citedIds.add(id)
          }
        }
        if (event.entry.kind === "system_init" && active) {
          active.status = "running"
          active.providerTurnStarted = true
          // The CLI runs turns strictly in order, so once this turn has
          // started no acknowledgement for an earlier prompt can still arrive.
          // Drop orphaned sequences (a Stop the provider never acknowledged)
          // so this turn's own result is matched to this turn.
          if (active.claudePromptSeq !== undefined) {
            const activeSeq = active.claudePromptSeq
            const orphaned = session.pendingPromptSeqs.filter((seq) => seq < activeSeq)
            if (orphaned.length > 0) {
              const releasedOriginReservations = session.session
                .discardHumanTurnReservations?.(orphaned) ?? 0
              session.pendingPromptSeqs.splice(
                0,
                session.pendingPromptSeqs.length,
                ...session.pendingPromptSeqs.filter((seq) => seq >= activeSeq),
              )
              logClaudeSteer("claude_prompt_fifo_resync", {
                chatId: session.chatId,
                sessionId: session.id,
                activePromptSeq: activeSeq,
                droppedPromptSeqs: orphaned,
                releasedOriginReservations,
              })
            }
          }
          const chat = this.store.getChat(session.chatId)
          if (
            chat?.pendingForkSessionToken
            && session.sessionToken
            && session.sessionToken !== chat.pendingForkSessionToken
          ) {
            await this.store.setPendingForkSessionToken(session.chatId, null)
          }
          logClaudeSteer("claude_event_system_init", {
            chatId: session.chatId,
            sessionId: session.id,
            activePromptSeq: active.claudePromptSeq ?? null,
            pendingPromptSeqs: [...session.pendingPromptSeqs],
          })
        }

        const completedClaudePromptSeq = event.entry.kind === "result" || event.entry.kind === "interrupted"
          ? (session.pendingPromptSeqs.shift() ?? null)
          : null

        logClaudeSteer("claude_event", {
          chatId: session.chatId,
          sessionId: session.id,
          entryKind: event.entry.kind,
          eventOrigin: event.origin ?? "human",
          activePromptSeq: active?.claudePromptSeq ?? null,
          completedPromptSeq: completedClaudePromptSeq,
          activeStatus: active?.status ?? null,
          pendingPromptSeqs: [...session.pendingPromptSeqs],
        })

        if (event.entry.kind === "result" && active && completedClaudePromptSeq === (active.claudePromptSeq ?? null)) {
          active.hasFinalResult = true
          if (event.entry.isError) {
            await this.store.recordTurnFailed(session.chatId, event.entry.result || "Turn failed")
          } else if (!active.cancelRequested) {
            await this.store.recordTurnFinished(session.chatId)
            const chat = this.store.getChat(session.chatId)
            this.launchPostTurnMemoryPasses({
              chatId: session.chatId,
              projectId: chat?.projectId,
              engine: "claude",
              turnNumber: active.turnNumber,
              turnId: active.turnId,
              taskId: active.taskId,
              userText: active.userText ?? "",
              assistantText: active.assistantChunks.join("\n"),
              citedIds: [...active.citedIds],
              memoryDisabled: active.memoryDisabled,
              injectedIds: [...active.injectedIds],
              claudeSessionToken: chat?.sessionToken,
              localPath: chat?.projectId ? this.store.getProject(chat.projectId)?.localPath : undefined,
            })
          }
          this.activeTurns.delete(session.chatId)
          if (!active.cancelRequested) {
            // Starting the next queued message can fail (project dir gone after
            // a container rebuild, engine reboot failure). Without this guard
            // the throw escaped to the outer catch AFTER activeTurns was already
            // deleted — so nothing was recorded and the persistent session was
            // silently torn down, dropping the message (BUG AGENT-3). Record it
            // the way the Codex path does, and keep this session alive.
            try {
              await this.maybeStartNextQueuedMessage(session.chatId)
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              await this.store.appendMessage(
                session.chatId,
                timestamped({ kind: "result", subtype: "error", isError: true, durationMs: 0, result: message }),
              )
              await this.store.recordTurnFailed(session.chatId, message)
            }
          }
        }

        this.emitStateChange(session.chatId)
      }
    } catch (error) {
      const active = this.activeTurns.get(session.chatId)
      if (active && !active.cancelRequested) {
        const message = error instanceof Error ? error.message : String(error)
        await this.store.appendMessage(
          session.chatId,
          timestamped({
            kind: "result",
            subtype: "error",
            isError: true,
            durationMs: 0,
            result: message,
          })
        )
        await this.store.recordTurnFailed(session.chatId, message)
      }
    } finally {
      // Only clean up if the registry still points at THIS session — a
      // rebuild (effort change, memory-set change) may already have replaced
      // it, and deleting unconditionally would tear down the successor.
      const isCurrent = !session.retired && this.claudeSessions.get(session.chatId) === session
      // A stream that dies mid-reply (network drop, upstream 5xx) never
      // yields the assistant_text/result entry that normally retires the
      // streaming preview — sweep it here or every later snapshot keeps
      // showing the phantom half-typed reply.
      if (isCurrent) this.clearStreamingAssistantText(session.chatId)
      if (isCurrent) this.claudeSessions.delete(session.chatId)
      const active = this.activeTurns.get(session.chatId)
      if (isCurrent && active?.provider === "claude") {
        if (active.cancelRequested && !active.cancelRecorded) {
          await this.store.recordTurnCancelled(session.chatId)
        }
        this.activeTurns.delete(session.chatId)
      }
      session.session.close()
      this.emitStateChange(session.chatId)
    }
  }

  private async generateTitleInBackground(chatId: string, messageContent: string, cwd: string, expectedCurrentTitle: string) {
    try {
      const result = await this.generateTitle(messageContent, cwd)
      if (result.failureMessage) {
        this.reportBackgroundError?.(
          `[title-generation] chat ${chatId} failed provider title generation: ${result.failureMessage}`
        )
      }
      if (!result.title || result.usedFallback) return

      const chat = this.store.requireChat(chatId)
      if (chat.title !== expectedCurrentTitle) return

      await this.store.renameChat(chatId, result.title)
      this.emitStateChange(chatId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.reportBackgroundError?.(
        `[title-generation] chat ${chatId} failed background title generation: ${message}`
      )
    }
  }

  private async runTurn(active: ActiveTurn) {
    try {
      for await (const event of active.turn.stream) {
        // Once cancelled, stop processing further stream events.
        // cancel() already removed us from activeTurns and notified the UI.
        if (active.cancelRequested) break

        if (event.type === "session_token" && event.sessionToken) {
          await this.store.setSessionToken(active.chatId, event.sessionToken)
          const chat = this.store.getChat(active.chatId)
          if (
            chat?.pendingForkSessionToken
            && event.sessionToken !== chat.pendingForkSessionToken
          ) {
            await this.store.setPendingForkSessionToken(active.chatId, null)
          }
          this.emitStateChange(active.chatId)
          continue
        }

        if (event.type === "assistant_delta") {
          this.appendAssistantDelta(active.chatId, event)
          continue
        }

        if (!event.entry) continue
        if (event.entry.kind === "assistant_text") {
          // Retire the streaming preview in the same broadcast that carries
          // the final entry — a snapshot must never show the text twice.
          this.clearStreamingAssistantText(active.chatId)
        }
        await this.store.appendMessage(active.chatId, event.entry)
        if (event.entry.kind === "assistant_text") {
          const counted = this.recordMemoryCitations(event.entry.text, active.chatId)
          active.assistantChunks.push(event.entry.text)
          for (const id of counted) active.citedIds.add(id)
        }

        if (event.entry.kind === "system_init") {
          active.status = "running"
        }

        if (event.entry.kind === "result") {
          active.hasFinalResult = true
          if (event.entry.isError) {
            await this.store.recordTurnFailed(active.chatId, event.entry.result || "Turn failed")
          } else if (!active.cancelRequested) {
            await this.store.recordTurnFinished(active.chatId)
            const chat = this.store.getChat(active.chatId)
            this.launchPostTurnMemoryPasses({
              chatId: active.chatId,
              projectId: chat?.projectId,
              engine: "codex",
              turnNumber: active.turnNumber,
              turnId: active.turnId,
              taskId: active.taskId,
              userText: active.userText ?? "",
              assistantText: active.assistantChunks.join("\n"),
              citedIds: [...active.citedIds],
              memoryDisabled: active.memoryDisabled,
              injectedIds: [...active.injectedIds],
            })
          }
          // Remove from activeTurns as soon as the result arrives so the UI
          // transitions to idle immediately. The stream may still be open
          // (e.g. background tasks), but the user should be able to send
          // new messages without having to hit stop first.
          this.activeTurns.delete(active.chatId)
          // Track the still-open stream so the UI can show a draining
          // indicator and the user can stop background tasks.
          this.drainingStreams.set(active.chatId, { turn: active.turn })
        }

        this.emitStateChange(active.chatId)
      }
    } catch (error) {
      if (!active.cancelRequested) {
        const message = error instanceof Error ? error.message : String(error)
        await this.store.appendMessage(
          active.chatId,
          timestamped({
            kind: "result",
            subtype: "error",
            isError: true,
            durationMs: 0,
            result: message,
          })
        )
        await this.store.recordTurnFailed(active.chatId, message)
      }
    } finally {
      // Whatever ended the stream (result, error, cancel), no partial reply
      // may keep rendering as if it were still being written.
      this.clearStreamingAssistantText(active.chatId)
      if (active.cancelRequested && !active.cancelRecorded) {
        await this.store.recordTurnCancelled(active.chatId)
      }
      active.turn.close()
      // Only remove if we're still the active turn for this chat.
      // We may have already been removed by result handling or cancel(),
      // and a new turn may have started for the same chatId.
      if (this.activeTurns.get(active.chatId) === active) {
        this.activeTurns.delete(active.chatId)
      }
      // Stream has fully ended — no longer draining.
      this.drainingStreams.delete(active.chatId)
      this.emitStateChange(active.chatId)

      if (active.postToolFollowUp && !active.cancelRequested) {
        try {
          await this.startTurnForChat({
            chatId: active.chatId,
            provider: active.provider,
            content: active.postToolFollowUp.content,
            attachments: [],
            model: active.model,
            effort: active.effort,
            serviceTier: active.serviceTier,
            planMode: active.postToolFollowUp.planMode,
            appendUserPrompt: false,
            turnId: active.turnId,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await this.store.appendMessage(
            active.chatId,
            timestamped({
              kind: "result",
              subtype: "error",
              isError: true,
              durationMs: 0,
              result: message,
            })
          )
          await this.store.recordTurnFailed(active.chatId, message)
          this.emitStateChange(active.chatId)
        }
      } else if (!active.cancelRequested) {
        try {
          await this.maybeStartNextQueuedMessage(active.chatId)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await this.store.appendMessage(
            active.chatId,
            timestamped({
              kind: "result",
              subtype: "error",
              isError: true,
              durationMs: 0,
              result: message,
            })
          )
          await this.store.recordTurnFailed(active.chatId, message)
          this.emitStateChange(active.chatId)
        }
      }
    }
  }

  private assertMemoSyncClaudeControl(chatId: string): void {
    const chat = this.store.requireChat(chatId)
    // Per-memory interrupt/resume is a memosync-condition Claude feature. It is
    // available in the normal deployment (studyMode false) and in the memosync
    // study arm alike — but never in the auto/static baseline arms or on Codex.
    if (this.policy.condition !== "memosync" || chat.provider !== "claude") {
      throw new Error("Per-memory interrupt is only available on the MemoSync Claude engine")
    }
  }

  /**
   * Per-memory interrupt (2026-08-19 C1/C3): the participant stopped the turn
   * because they identified a problem involving one working-memory item. Cancels exactly like
   * Stop, then adds the attribution a plain Stop lacks: the flagged memory,
   * the anchor quote, the turn's working set — plus the measurement side
   * effects: a participant-issued violated verdict in the memory event log
   * (never an audit card), and a memory.interrupt event. The recovery card
   * parks at the interruption point as a memory_interrupt entry.
   */
  async interruptMemory(args: { chatId: string; memoryId: string; quote?: string }) {
    const { chatId, memoryId } = args
    this.assertMemoSyncClaudeControl(chatId)
    const active = this.activeTurns.get(chatId)
    if (!active || active.provider !== "claude") {
      throw new Error("A MemoSync Claude turn must be running before a memory can interrupt it")
    }
    // Snapshot BEFORE cancel(): it tears down the active turn and drops the
    // streaming text this attribution is built from.
    const turnNumber = active.turnNumber
    const workingIds = active.injectedIds
    // The citation id is client-controlled. A chip from an older transcript
    // row must never cancel the current turn or write a violated verdict for a
    // memory that was not actually delivered in this turn.
    if (!workingIds.includes(memoryId)) {
      throw new Error(`Memory ${memoryId} is not part of the current turn's working memory`)
    }
    const streamed = this.streamingAssistantTexts.get(chatId)?.text ?? ""
    const citedOrder: string[] = []
    for (const match of streamed.matchAll(/\[(M-\d+)\]/g)) {
      const id = match[1]
      if (id && !citedOrder.includes(id)) citedOrder.push(id)
    }
    const messages = this.store.getMessages(chatId)
    let prompt = ""
    for (let i = messages.length - 1; i >= 0; i--) {
      const entry = messages[i] as { kind: string; content?: string }
      if (entry.kind === "user_prompt") {
        prompt = entry.content ?? ""
        break
      }
    }
    // Cited-first in first-mention order (the user tends to click the last
    // chip they saw; earlier citations may also be wrong — C2 lower layer).
    const workingSet = [
      ...citedOrder.filter((id) => workingIds.includes(id)).map((id) => ({ id, cited: true })),
      ...workingIds.filter((id) => !citedOrder.includes(id)).map((id) => ({ id, cited: false })),
    ]

    const interruptId = crypto.randomUUID()
    const quote = args.quote?.trim() ? args.quote.trim().slice(0, 300) : undefined
    // Persist the participant control before cancelling the run. A failed
    // SQLite authority write must leave the treatment state untouched.
    this.memory?.logger.event({
      type: "memory.interrupt",
      eventId: `control:interrupt:${interruptId}`,
      interruptId,
      ...(active.taskId ? { taskId: active.taskId, sessionId: active.taskId } : { sessionId: chatId }),
      chatId,
      id: memoryId,
      turn: turnNumber,
      quote,
    })
    await this.cancel(chatId, { skipPostTurnMemoryPasses: true })

    this.memory?.store.recordTraceLabel(memoryId, "violated", { actor: "user", sessionId: chatId, turn: turnNumber })
    await this.store.appendMessage(
      chatId,
      timestamped({ kind: "memory_interrupt", interruptId, memoryId, quote, prompt, workingSet, turn: turnNumber }),
    )
    this.emitStateChange(chatId, { immediate: true })
  }

  /**
   * Resume after a per-memory interrupt (2026-08-19 C2): re-dispatch the
   * interrupted prompt as a NEW turn that skips the pre-turn gates and the
   * working-memory confirmation — the recovery card already confirmed the
   * set — and rides a continuation instruction plus the participant's
   * correction. Continuation is real: the engine session keeps the partial
   * trajectory, so the reminder tells it to keep completed work.
   */
  async resumeInterrupted(args: {
    chatId: string
    interruptId: string
    correction: string
    selectedIds: string[]
    enforce?: boolean
  }) {
    const { chatId } = args
    this.assertMemoSyncClaudeControl(chatId)
    if (this.activeTurns.has(chatId)) throw new Error("A turn is already running")
    const messages = this.store.getMessages(chatId)
    const entry = messages.find(
      (m): m is Extract<typeof m, { kind: "memory_interrupt" }> =>
        (m as { kind?: string }).kind === "memory_interrupt" &&
        (m as { interruptId?: string }).interruptId === args.interruptId,
    )
    if (!entry) throw new Error("No matching memory interrupt")
    const alreadyResolved = messages.some(
      (m) =>
        (m as { kind?: string }).kind === "memory_interrupt_resolution" &&
        (m as { interruptId?: string }).interruptId === args.interruptId,
    )
    if (alreadyResolved) throw new Error("Interrupt already resumed")

    const correction = args.correction?.trim()
    if (!correction) throw new Error("A correction is required to resume")
    const chat = this.store.requireChat(chatId)
    const memory = this.memory
    if (!memory) throw new Error("Memory service is unavailable")
    const enforce = args.enforce === true
    const selectedIds = normalizeMemorySelection({
      memory,
      projectId: chat.projectId,
      chatId,
      selectedIds: enforce ? [...args.selectedIds, entry.memoryId] : args.selectedIds,
    })
    if (enforce && !selectedIds.includes(entry.memoryId)) {
      throw new Error("The enforced memory is no longer in the current chat's effective Working Memory")
    }

    const resumedTaskId = this.getActiveStudyTaskId()
    if (resumedTaskId) {
      // The click/decision is the measured Control act. Persist it before the
      // provider continuation so telemetry failure cannot create an
      // unmeasured resumed run.
      this.memory?.logger.event({
        type: "memory.resume",
        eventId: `control:resume:${args.interruptId}`,
        interruptId: args.interruptId,
        taskId: resumedTaskId,
        sessionId: resumedTaskId,
        chatId,
        id: entry.memoryId,
        enforced: enforce,
      })
      if (enforce) {
        this.memory?.logger.event({
          type: "memory.audit_action",
          eventId: `control:resume-enforce:${args.interruptId}`,
          taskId: resumedTaskId,
          sessionId: resumedTaskId,
          chatId,
          id: entry.memoryId,
          action: "enforce",
        })
      }
    }

    const provider = (chat.provider ?? "claude") as AgentProvider
    const settings = this.getProviderSettings(provider, {} as SendMessageOptions)
    let deliveryAccepted = false
    let deliveredSelectedIds: string[] = []
    await this.startTurnForChat({
      chatId,
      provider,
      content: entry.prompt,
      attachments: [],
      model: settings.model,
      effort: settings.effort,
      serviceTier: settings.serviceTier,
      planMode: false,
      appendUserPrompt: true,
      // Stable across retries: if provider boot fails after the prompt entry is
      // durable, startTurn reuses that entry and its turn number.
      turnId: args.interruptId,
      onMemoryDeliveryAccepted: (focusedIds) => {
        deliveryAccepted = true
        deliveredSelectedIds = [...focusedIds]
      },
      resume: {
        interruptId: args.interruptId,
        memoryId: entry.memoryId,
        correction,
        selectedIds,
        ...(enforce ? { enforce: true, quote: entry.quote } : {}),
      },
    })
    if (!deliveryAccepted) {
      throw new Error("Claude did not accept the interrupt recovery delivery")
    }
    // The recovery decision becomes durable only after Claude accepted the
    // continuation. A failed provider boot therefore leaves the card open and
    // retryable instead of falsely claiming the interrupt was resolved.
    await this.store.appendMessage(
      chatId,
      timestamped({
        kind: "memory_interrupt_resolution",
        interruptId: args.interruptId,
        correction,
        selectedIds: deliveredSelectedIds,
        ...(enforce ? { enforced: true } : {}),
      }),
    )
    this.emitStateChange(chatId, { immediate: true })
  }

  async cancel(
    chatId: string,
    options?: {
      hideInterrupted?: boolean
      /** C3 per-memory interrupt: the incomplete turn must produce no automatic
       * Capture, Trace, Checkup precompute, or Transfer source preparation. */
      skipPostTurnMemoryPasses?: boolean
    },
  ) {
    // Drop any half-written streaming reply right away — the engine unwind
    // below may take a moment and the partial must not linger as if live.
    this.clearStreamingAssistantText(chatId)
    // Also clean up any draining stream for this chat.
    const draining = this.drainingStreams.get(chatId)
    if (draining) {
      draining.turn.close()
      this.drainingStreams.delete(chatId)
    }

    // A direct Auto send can be durably queued while it waits for the prior
    // turn's Project Copy capture. Stop cancels that pending dispatch itself: the
    // queue row is removed only after the barrier waiter confirms it cannot
    // append a late user prompt or boot Claude.
    const deferredAutoStart = this.pendingAutoCaptureStarts.get(chatId)
    if (
      deferredAutoStart
      && !this.activeTurns.has(chatId)
      && !this.hasPendingPreviewActivity(chatId)
      && this.startingChats.get(chatId) !== "previewing_memory"
    ) {
      await this.cancelAutoCaptureQueueDrain(chatId, deferredAutoStart, options?.hideInterrupted)
      return
    }

    // Stop while parked at a step-one gate: resolve EVERY parked gate as
    // "cancelled" (Step 1 and the Transfer card park side by side since
    // 2026-08-08), set the preview-cancel flag so a sibling coroutine still
    // computing unwinds when it reaches its check, and record the
    // interruption ONCE here — the gate coroutines only settle their own
    // transcript entries.
    const proposalsParked = this.pendingProposalGates.get(chatId)
    const transferParked = this.pendingTransferGates.get(chatId)
    const checkupParked = this.pendingCheckupGates.get(chatId)
    if (proposalsParked || transferParked || checkupParked) {
      const preparation = this.activePreparations.get(chatId)
      this.cancelledDuringPreview.add(chatId)
      proposalsParked?.respond("cancelled")
      transferParked?.respond("cancelled")
      checkupParked?.respond("cancelled")
      // The shared phase signal releases Prompt Parse and task-local Transfer
      // together. Source preparation is shared across turns and keeps running.
      await preparation?.cancellation.cancelAndWait()
      await this.store.appendMessage(chatId, timestamped({ kind: "interrupted", hidden: options?.hideInterrupted }))
      await this.store.recordTurnCancelled(chatId)
      this.emitStateChange(chatId, { immediate: true })
      return
    }

    // Stop while parked at the preview gate = dismissing the turn — but only
    // once the card is published. Before that, a "dismiss" decision would
    // reference a preview entry that may never land; unwind through the
    // cancelled-during-preview path instead (the gate coroutine observes it).
    const parked = this.pendingPreviews.get(chatId)
    if (parked) {
      if (parked.published) {
        parked.respond("dismiss")
        return
      }
      this.pendingPreviews.delete(chatId)
      this.cancelledDuringPreview.add(chatId)
      await this.store.appendMessage(chatId, timestamped({ kind: "interrupted", hidden: options?.hideInterrupted }))
      await this.store.recordTurnCancelled(chatId)
      this.emitStateChange(chatId, { immediate: true })
      return
    }

    // Stop DURING the preview-gate LLM pass (reservation held, gate not parked
    // yet): the in-flight runPreviewGateThenBoot observes this flag and unwinds
    // (BUG AGENT-2). Record the interruption here so the UI reflects it now.
    if (this.startingChats.get(chatId) === "previewing_memory") {
      const preparation = this.activePreparations.get(chatId)
      this.cancelledDuringPreview.add(chatId)
      await preparation?.cancellation.cancelAndWait()
      await this.store.appendMessage(chatId, timestamped({ kind: "interrupted", hidden: options?.hideInterrupted }))
      await this.store.recordTurnCancelled(chatId)
      this.emitStateChange(chatId, { immediate: true })
      return
    }

    const active = this.activeTurns.get(chatId)
    if (!active) return

    logClaudeSteer("cancel_requested", {
      chatId,
      provider: active.provider,
      activePromptSeq: active.claudePromptSeq ?? null,
    })

    // Guard against concurrent cancel() calls — only the first one does work.
    if (active.cancelRequested) return
    active.cancelRequested = true

    const pendingTool = active.pendingTool
    active.pendingTool = null

    if (pendingTool) {
      const result = discardedToolResult(pendingTool.tool)
      await this.store.appendMessage(
        chatId,
        timestamped({
          kind: "tool_result",
          toolId: pendingTool.toolUseId,
          content: result,
        })
      )
      if (active.provider === "codex" && pendingTool.tool.toolKind === "exit_plan_mode") {
        pendingTool.resolve(result)
      }
    }

    await this.store.appendMessage(chatId, timestamped({ kind: "interrupted", hidden: options?.hideInterrupted }))
    await this.store.recordTurnCancelled(chatId)
    active.cancelRecorded = true
    active.hasFinalResult = true

    // Remove from activeTurns immediately so the UI reflects the cancellation
    // right away, rather than waiting for interrupt() which may hang.
    this.activeTurns.delete(chatId)
    this.emitStateChange(chatId)

    // A formal-study Stop leaves an incomplete output. Do not learn from it or
    // run post-turn audit/precomputation; the participant must complete a fresh
    // run before Finish can open. Preserve the legacy non-study behavior.
    if (!this.policy.studyMode && !options?.skipPostTurnMemoryPasses) {
      const chat = this.store.getChat(chatId)
      this.launchPostTurnMemoryPasses({
        chatId,
        projectId: chat?.projectId,
        engine: active.provider,
        turnNumber: active.turnNumber,
        turnId: active.turnId,
        taskId: active.taskId,
        userText: active.userText ?? "",
        assistantText: active.assistantChunks.join("\n"),
        citedIds: [...active.citedIds],
        memoryDisabled: true,
        injectedIds: [],
      })
    }
    logClaudeSteer("cancel_active_turn_deleted", {
      chatId,
      provider: active.provider,
      activePromptSeq: active.claudePromptSeq ?? null,
    })

    // A formal-study Stop keeps the persistent Query once the provider has
    // started the turn: the CLI acknowledges the cancelled prompt (every pilot
    // Stop was acknowledged within 100 ms), and if it ever does not, the next
    // turn's `system_init` drops the orphaned FIFO entry. Only a Stop that
    // arrives before any provider frame is ambiguous — a positional FIFO could
    // not tell this turn's late init/ack from the next turn's — so that case
    // retires the Query fail-closed; the persisted session token resumes
    // context on the next send.
    if (this.policy.studyMode && active.provider === "claude" && !active.providerTurnStarted) {
      const session = this.claudeSessions.get(chatId)
      if (session) {
        try {
          await this.retireClaudeSession(session, "study_turn_cancel_before_start")
        } catch (error) {
          // Stop already cancelled the turn; a slow pump must not turn that
          // into a participant-visible failure. The session is retired and
          // its remaining frames are dropped by the pump's retired guard.
          this.reportBackgroundError?.(
            `[claude-retire] chat ${chatId}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      } else {
        // The pump may have closed concurrently after `active` was captured.
        active.turn.close()
      }
      return
    }

    // Interrupt/close is best-effort — the turn is already removed from
    // active state above, and runTurn()'s finally block will also call close().
    try {
      await Promise.race([
        active.turn.interrupt(),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ])
    } catch {
      // interrupt() failed — force close
    }
    active.turn.close()
  }

  async respondTool(command: Extract<ClientCommand, { type: "chat.respondTool" }>) {
    const active = this.activeTurns.get(command.chatId)
    if (!active || !active.pendingTool) {
      throw new Error("No pending tool request")
    }

    const pending = active.pendingTool
    if (pending.toolUseId !== command.toolUseId) {
      throw new Error("Tool response does not match active request")
    }

    await this.store.appendMessage(
      command.chatId,
      timestamped({
        kind: "tool_result",
        toolId: command.toolUseId,
        content: command.result,
      })
    )

    active.pendingTool = null
    active.status = "running"

    if (pending.tool.toolKind === "exit_plan_mode") {
      const result = (command.result ?? {}) as {
        confirmed?: boolean
        clearContext?: boolean
        message?: string
      }
      if (result.confirmed && result.clearContext) {
        await this.store.setSessionToken(command.chatId, null)
        await this.store.appendMessage(command.chatId, timestamped({ kind: "context_cleared" }))
      }

      if (active.provider === "codex") {
        active.postToolFollowUp = result.confirmed
          ? {
              content: result.message
                ? `Proceed with the approved plan. Additional guidance: ${result.message}`
                : "Proceed with the approved plan.",
              planMode: false,
            }
          : {
              content: result.message
                ? `Revise the plan using this feedback: ${result.message}`
                : "Revise the plan using this feedback.",
              planMode: true,
            }
      }
    }

    pending.resolve(command.result)

    this.emitStateChange(command.chatId)
  }
}
type StudyAgentPreviewRuntime = Pick<StudyPreviewRuntimeController, "ensure" | "status" | "restart" | "stop">
