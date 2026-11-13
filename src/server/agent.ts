import { createHash } from 'node:crypto'
import { CaptureQueue, type CaptureJob } from './memory/capture-queue'
import { snapshotParentLaunch, type ParentLaunch, type ClaudeParentLaunch } from './memory/parent-launch'
import { isRuntimeCommandSelection, runtimeCommandSelectionKey, type ChatCommandCatalog, type CodexReviewTarget, type ExecuteRuntimeCommand, type RuntimeCommand, type RuntimeCommandSelection } from '../shared/runtime-commands'
import { CommandRegistry, type NativeCommandRuntime } from './command-registry'
import { CODEX_INIT_PROMPT, createClaudeCommandRuntime, parseCodexReviewTarget, supportsClaudeInputReplay } from './native-command-drivers'
import { compileContext, contextIdentity, HOST_CONTRACT, renderCompiledContext, type ContextBaseline, type NativeContextTarget, type PreparedNativeContext, type StableToolSchema } from './context-compiler'
import type { NativeExecutionPolicy, PolicyCallScope } from '../shared/harness-capabilities'
import { HarnessPolicyService, defaultExecutionPolicy, executionPolicyKey, isMemoryTool, isNativeExecutionPolicy } from './harness-policy'
import { lastEngineExecutable } from './model-access/executables'
import { getModelAccessService } from "./model-access/service"
import { resolveEngineRuntime, runtimeForEnv, type EngineRuntime } from "./model-access/runtime"
import { query, type CanUseTool, type PermissionResult, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { ClientCommand } from "../shared/protocol"
import { normalizeToolCall } from "../shared/tools"
import type {
  AgentProvider,
  ChatActivityStatus,
  ChatAttachment,
  ContextWindowUsageSnapshot,
  MemoryPreviewDecision,
  MemoryPreviewSettings,
  ModelOptions,
  NormalizedToolCall,
  PendingToolSnapshot,
  QueuedChatMessage,
  TranscriptEntry,
} from "../shared/types"
import { resolveClaudeApiModelId, resolveModelReasoningEffort } from "../shared/types"
import { isKnownCatalogModel, resolveChatProviderRoute } from "./chat-providers"
import { claudeSessionFileExists } from "./claude-session-files"
import { CodexAppServerManager } from "./codex-app-server"
import { EventStore } from "./event-store"
import { fallbackTitleFromMessage, generateTitleForChatDetailed, type GenerateChatTitleResult } from "./generate-title"
import type { HarnessEvent, HarnessToolRequest, HarnessTurn } from "./harness-types"
import type { MemoryService } from "./memory"
import { getMemoryConfirmation, memoryConfirmationReasons, recordMemoryConfirmation } from "./memory/confirmation"
import { MemoryBranchPipeline, type BranchRequest } from "./memory/branch-pipeline"
import { createMemoryBranch, type MemoryBranch } from "./memory/branch-runtime"
import { memoryStageSchema } from "./memory/branch-schemas"
import {
  buildAuditBranchPrompt,
  buildWorkingMemoryBranchPrompt,
  MemoryBranchResultError,
  parseAuditBranchResult,
  parseWorkingMemoryBranchResult,
} from "./memory/branch-stages"
import type { CaptureOutcome, CaptureService } from "./memory/capture"
import { runForkCapture } from "./memory/capture-fork"
import type { CheckupResult, CheckupService } from "./memory/checkup"
import { extractCitations } from "./memory/citations"
import { toClaudeMemoryMcpServer } from "./memory/claude-adapter"
import { HostActionService, dispatchHostAction, hostActionToolSpecs, isHostActionTool, type HostAdmissionLease } from "./host-actions"
import type { HostNativeToolContext } from "../shared/host-actions"
import { toCodexDynamicTools } from "./memory/codex-adapter"
import type { RevisionService } from "./memory/evolution"
import { runForkQuery } from "./memory/fork-query"
import {
  computeMemoryTurnDelta,
  normalizeMemorySelection,
  planMemoryInjection,
  type MemoryInjectionPlan,
} from "./memory/injection"
import { compileMemoryView, relationLifecycleOverrides } from "./memory/view"
import type { RelevanceService, RelevantMemory } from "./memory/relevance"
import { buildMemoryToolSpecs, dispatchMemoryTool, type MemoryToolContext, type MemoryToolSpec } from "./memory/tools"
import { coerceTraceOutcome, type TraceOutcome, type TraceService } from "./memory/trace"
import { runForkTrace } from "./memory/trace-fork"
import type {
  TransferDetectService,
  TransferSuggestionCard,
  TransferSuggestionProgress,
  TransferTaskResult,
} from "./memory/transfer-detect"
import type { MemoryItem } from "./memory/types"
import type { ExpectedMemoryUse, UsePlanService } from "./memory/use-plan"
import { ensureProjectDirectory } from "./paths"
import { OpencodeAgentManager } from "./opencode-agent"
import { PiAgentManager, resolvePiConnection, type PiConnection } from "./pi-agent"
import {
  applyClaudeSdkModels,
  codexServiceTierFromModelOptions,
  getServerProviderCatalog,
  normalizeClaudeModelOptions,
  normalizeCodexModelOptions,
  normalizePiModelOptions,
  normalizeServerModel,
  type ClaudeSdkModelInfo,
  deployedProviders,
} from "./provider-catalog"
import { assertIsolatedClaudeCredentials, buildIsolatedClaudeEnv, resolveOfficialClaudeEnv } from "./provider-runtime"
import {
  recordDeliveredStoreFocus,
} from "./usage/focus"

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
}): { model: string; settings: { autoMemoryEnabled: boolean; autoDreamEnabled: boolean }; env: Record<string, string | undefined> } {
  const inherited = runtimeForEnv(args.env)
  if (inherited) return { model: inherited.model, env: inherited.env, settings: { autoMemoryEnabled: false, autoDreamEnabled: false } }
  const official = args.requestedModel === "sonnet" || args.requestedModel === "opus" || args.requestedModel.startsWith("claude-")
  const configuredModel = args.configuredModel ?? (args.env.MEMOSYNC_USE_OWN_ANTHROPIC === "1" ? args.env.ANTHROPIC_MODEL : "")
  const rawModel = official ? args.requestedModel : resolveClaudeSessionModel(args.requestedModel, configuredModel ?? "")
  if (official) args = { ...args, env: resolveOfficialClaudeEnv(args.env) }
  // Normalize away an operator-supplied suffix first so we never double-append.
  const resolvedModel = rawModel.endsWith("[1m]") ? rawModel.slice(0, -"[1m]".length) : rawModel

  // A non-default vendor (currently GLM) overrides the whole ANTHROPIC_* bundle
  // for THIS session's subprocess so it talks to that vendor's endpoint with
  // its own key. MemoSync memory branches receive this same resolved bundle.
  const route = resolveChatProviderRoute(resolvedModel, args.env)
  if (route) {
    assertIsolatedClaudeCredentials({ ...args.env, ANTHROPIC_API_KEY: route.apiKey, ANTHROPIC_AUTH_TOKEN: route.apiKey })
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
  assertIsolatedClaudeCredentials(args.env)
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
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_EFFORT_LEVEL",
])

export function buildClaudeSubprocessEnv(args: {
  localPath: string
  baseEnv?: Readonly<Record<string, string | undefined>>
}): Record<string, string | undefined> {
  const inherited = runtimeForEnv(args.baseEnv)
  if (inherited) return inherited.env
  const rawEnv = args.baseEnv ?? process.env
  const baseEnv: Record<string, string | undefined> = buildIsolatedClaudeEnv(rawEnv)
  for (const key of Object.keys(baseEnv)) {
    if ((key === "CLAUDECODE" || key.startsWith("CLAUDE_")) && !CLAUDE_ENGINE_ENV_ALLOWLIST.has(key)) {
      delete baseEnv[key]
    }
  }
  return baseEnv
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

// Explain the product Browser/proxy boundary to every provider.
const BROWSER_USAGE_GUIDE = [
  "## Showing web apps in the Browser panel",
  "The Browser panel previews local web servers through MemoSync's proxy.",
  "Start the project's development server when a web task needs a live preview, and wait until it is ready.",
  "Bind the server to 0.0.0.0 when the workspace runs in a container or on a remote machine.",
  "Tell the user the port and the page to open in the Browser panel. Their own localhost may be a different machine.",
  "Use the project's documented scripts and environment. Inspect the existing configuration before choosing a port or changing dependencies.",
  "Use relative URLs such as /api and configure the frontend dev server to proxy backend requests when necessary.",
  "The user can press Home, select the project's server card, and use the Browser panel's Refresh button. Verify the proxied page if the user reports a blank page; local server success alone does not prove it renders through the proxy.",
].join("\n")

export function buildClaudeSystemAppend(memoryBlock: string) {
  return [BROWSER_USAGE_GUIDE, HOST_CONTRACT, memoryBlock].filter(Boolean).join("\n\n")
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

export interface TurnMemoryState {
  readonly control: "review" | "auto"
  readonly memoryActive: boolean
  readonly learnActive: boolean
}

/** Snapshot the user settings and chat switch once when a turn starts. */
export function resolveTurnMemoryState(
  settings: { enabled: boolean; learn: boolean; control?: "review" | "auto" },
  memoryDisabled = false,
): TurnMemoryState {
  const memoryActive = (settings.enabled && !memoryDisabled)
  return { control: settings.control ?? "review", memoryActive, learnActive: memoryActive && (settings.learn) }
}

interface StartTurnArgs {
  nativeSkill?: { name: string; path: string }
  nativeReview?: CodexReviewTarget
  hostPrompt?: string
  approvedMemoryViewRevision?: string
  connectionId?: string
  engineRuntime?: EngineRuntime
  memoryState?: TurnMemoryState
  memoryPreviewSettings?: Readonly<Required<MemoryPreviewSettings>>
  chatId: string
  provider: AgentProvider
  content: string
  attachments: ChatAttachment[]
  /** Immutable private copies used only at the provider boundary. The
   * user transcript continues to own `attachments`. */
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
  /** Transport-owned identity; never read this from the model/client command body. */
  hostClientId?: string
  hostAdmission?: HostAdmissionLease
  policyScope?: PolicyCallScope
  /** Stable logical turn id shared by delivery and measurement records. */
  turnId?: string
  /**
   * Called only after Claude accepts the prompt, with the exact focused ids
   * used by the delivery receipt. Interrupt recovery uses this server-owned
   * result instead of persisting the client selection it started from.
   */
  onMemoryDeliveryAccepted?: (focusedIds: readonly string[]) => void
  startupReservation?: StartupReservation
}

interface StartupReservation {
  cancelled: boolean
  cancellation?: Promise<void>
  controller?: AbortController
  promptWrite?: Promise<unknown>
  cancellationPending?: boolean
  cancellationComplete?: boolean
  startupSettled?: boolean
  superseded?: boolean
}

interface ActiveTurn {
  engineRuntime?: EngineRuntime
  parentLaunch?: ParentLaunch
  analysisPolicyKey?: string
  projectId?: string
  localPath?: string
  sessionToken?: string | null
  expectedUses?: ExpectedMemoryUse[]
  memoryState: TurnMemoryState
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
  startupReservation?: StartupReservation
  /**
   * Claude only: the provider emitted this turn's `system_init`. A Stop after
   * that point keeps the persistent Query (the provider acknowledges the
   * cancelled prompt). Before it, retire the Query: UUIDs identify results,
   * but untagged late assistant/tool frames still cannot be safely attributed.
   */
  providerTurnStarted: boolean
  clientTraceId?: string
  profilingStartedAt?: number
  /** 1-based user-visible turn number (count of user_prompt entries) — memory provenance. */
  turnNumber?: number
  /** Stable logical turn id for local usage records. */
  turnId: string
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
  memoryDeliveryAccepted?: boolean
  /**
   * Snapshot of the memory ids injected for THIS turn, taken at engine boot.
   * Trace labels against this — a memory accepted mid-turn must not be
   * counted as "in play" for the turn that was already running.
   */
  injectedIds: string[]
}

/** Model-access codes the client can explain; other preparation errors stay generic. */
const PREPARATION_ERROR_CODES = new Set([
  "connection-invalid", "connection-missing", "connection-key-missing", "connection-protocol-unsupported",
  "engine-setup-invalid", "model-unavailable", "account-signed-out", "executable-missing", "executable-broken",
  "executable-incompatible", "model-access-unavailable", "engine-runtime-mismatch",
])

interface ClaudeExecutionControl {
  permissionMode: Extract<NativeExecutionPolicy, { engine: "claude" }>["permissionMode"]
  isCurrent: () => boolean
  canUseMemory?: (name: string) => boolean
  approve: (name: string, input: Record<string, unknown>, requestId: string) => Promise<boolean>
  onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
  onApplied: () => Promise<void>
}

interface ClaudeSessionHandle {
  commandRuntime?: NativeCommandRuntime
  initialize?: () => Promise<unknown>
  setExecutionControl?: (control: ClaudeExecutionControl | undefined) => void
  parentLaunch?: ClaudeParentLaunch
  provider: "claude"
  stream: AsyncIterable<HarnessEvent>
  getAccountInfo?: () => Promise<any>
  interrupt: () => Promise<void>
  close: () => void
  sendPrompt: (
    content: string,
    context?: Pick<MemoryToolContext, "turn" | "engine" | "allowedMemoryIds" | "memoryView"> & { promptSeq?: number; promptId?: string; prepareContext?: (target: NativeContextTarget) => PreparedNativeContext },
  ) => Promise<void>
  /** Known for the bundled SDK; override wrappers are detected on their first tagged result. */
  echoesPromptIds?: boolean
  /** Revoke tool authority while retaining the prompt as a late-result tombstone. */
  revokeHumanTurnReservation?: (promptSeq: number) => void
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
  /** Retained after result so late provider frames obey the last turn snapshot. */
  memoryState?: TurnMemoryState
  id: string
  chatId: string
  session: ClaudeSessionHandle
  localPath: string
  model: string
  effort?: string
  planMode: boolean
  sessionToken: string | null
  /** Latest prompt whose token was saved, including untagged current-turn frames. */
  sessionTokenPromptSeq: number
  accountInfoLoaded: boolean
  nextPromptSeq: number
  cancelledPromptSeqs: Set<number>
  pendingPrompts: Array<{ seq: number; id: string }>
  echoesPromptIds: boolean
  /** Retired sessions may still have SDK messages queued while Query.close() settles. */
  retired: boolean
  retireReason: string | null
  pump: Promise<void> | null
  /**
   * Rebuild key of the memory shape baked into this session ("memory-off" when
   * disabled). Under the delta model (REDESIGN D1) skills-mode CONTENT changes
   * no longer rebuild — they ride the next user turn as a delta block; only a
   * tools flip forces
   * a rebuild. The resume token carries the conversation across rebuilds.
   */
  memorySetHash: string
  providerRuntimeKey: string
  /**
   * id → version of what the context currently claims (boot snapshot, then
   * updated after every delta append). null = memory off or non-skills mode.
   */
  memoryBaseline: import("./memory/injection").MemoryBaseline | null
}

interface AgentCoordinatorArgs {
  hostActions?: HostActionService
  harnessPolicies?: HarnessPolicyService
  store: EventStore
  /** P2 supplies complete host tool declarations; no dependency on its implementation or UI. */
  stableToolSchemas?: (input: { chatId: string; engine: AgentProvider }) => readonly StableToolSchema[]
  onStateChange: (chatId?: string, options?: { immediate?: boolean }) => void
  codexManager?: CodexAppServerManager
  opencodeManager?: OpencodeAgentManager
  piManager?: PiAgentManager
  /** Injectable for tests; defaults to the Model Registry/env resolution. */
  resolvePiConnection?: () => Promise<PiConnection | null>
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
  /** Persistent C/T/M/W/A conversations; injected in tests, enabled in the application. */
  memoryBranches?: boolean
  createMemoryBranch?: typeof createMemoryBranch
  /** Recovery resolves the original runtime identity; injectable for offline tests. */
  resolveCaptureRuntime?: typeof resolveEngineRuntime
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
  /** User switches, sampled only when a new turn begins. */
  getMemorySettings?: () => { enabled: boolean; learn: boolean; control?: "review" | "auto" }

  getMemoryPreviewSettings?: () => MemoryPreviewSettings
  /** Injectable resume-token validity check (default: real ~/.claude session-file lookup). */
  claudeSessionFileExists?: typeof claudeSessionFileExists
  /** Bounded Query.close() drain wait; injectable for lifecycle tests. */
  claudeRetireTimeoutMs?: number
  startClaudeSession?: (args: {
    localPath: string
    model: string
    effort?: string
    planMode: boolean
    sessionToken: string | null
    forkSession: boolean
    executionControl?: ClaudeExecutionControl
    onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
    hostActionsEnabled?: boolean
    memory?: MemoryService | null
    /** Routing gate for agent-proposed memories; enables the propose_memory tool. */
    capture?: CaptureService | null
    projectId?: string
    chatId?: string
    engineRuntime?: EngineRuntime
    subprocessEnv?: Record<string, string | undefined>
    /** Precomputed once for this turn so boot, prompt, and measurement share exact text. */
    memoryPlan?: MemoryInjectionPlan | null
    restrictMemoryIds?: string[]
    onMemoryProposal?: (created: MemoryItem[]) => void
  }) => Promise<ClaudeSessionHandle>
}

interface DurableCaptureInput {
  finished: Omit<PostTurnMemoryPassArgs, 'parentLaunch' | 'engineRuntime' | 'injectedMemories' | 'expectedUses'>
  policyKey: string
  runtime?: { fingerprint: string; connectionId?: string; model: string }
}

function captureRuntimeFingerprint(runtime: EngineRuntime): string {
  // Credentials and profile paths never leave this process; only their digest
  // is journaled so recovery cannot silently switch endpoints or profiles.
  return createHash('sha256').update(JSON.stringify({ ...runtime, env: Object.entries(runtime.env).sort(([a], [b]) => a.localeCompare(b)) })).digest('hex')
}

interface SendToStartingProfile {
  traceId: string
  startedAt: number
}

interface PostTurnMemoryPassArgs {
  /** Launch of the completed turn; detached passes must never use the next turn. */
  parentLaunch?: ParentLaunch
  engineRuntime?: EngineRuntime
  analysisPolicyKey?: string
  memoryState?: TurnMemoryState
  chatId: string
  projectId?: string
  engine: string
  turnNumber?: number
  turnId: string
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
  sessionToken?: string | null
  injectedMemories?: MemoryItem[]
  executionText?: string
  expectedUses?: ExpectedMemoryUse[]
  executionTools?: Array<{ toolId: string; text: string }>
  model?: string
  effort?: string
  serviceTier?: "fast"
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

interface CommandPreparation {
  selection: RuntimeCommandSelection
  key: string
  policyRevision: number
  accessRevision?: number
  memoryKey: string
  controller: AbortController
  promise: Promise<void>
  status: 'preparing' | 'ready' | 'error'
  message?: string
}

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

async function interruptTurnWithTimeout(turn: HarnessTurn) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      turn.interrupt(),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 5_000) }),
    ])
  } finally {
    clearTimeout(timer)
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
  // Keep raw SDK JSON only for the init raw view and tool_use_result extraction.
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
        debugRaw: JSON.stringify(message),
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
        }))
      }
    }
    return entries
  }

  if (message.type === "user" && Array.isArray(message.message?.content)) {
    const entries: TranscriptEntry[] = []
    let debugRaw: string | undefined
    for (const content of message.message.content) {
      if (content.type === "tool_result" && typeof content.tool_use_id === "string") {
        debugRaw ??= JSON.stringify(message)
        entries.push(timestamped({
          kind: "tool_result",
          debugRaw,
          messageId,
          toolId: content.tool_use_id,
          content: content.content,
          isError: Boolean(content.is_error),
        }))
      }
      if (message.message.role === "user" && typeof message.message.content === "string") {
        entries.push(timestamped({
          kind: "compact_summary",
          messageId,
          summary: message.message.content,
        }))
      }
    }
    return entries
  }

  if (message.type === "result") {
    if (message.subtype === "cancelled") {
      return [timestamped({ kind: "interrupted", messageId })]
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
      }),
    ]
  }

  if (message.type === "system" && message.subtype === "status" && typeof message.status === "string") {
    return [timestamped({ kind: "status", messageId, status: message.status })]
  }

  if (message.type === "system" && message.subtype === "compact_boundary") {
    return [timestamped({ kind: "compact_boundary", messageId })]
  }

  if (message.type === "system" && message.subtype === "context_cleared") {
    return [timestamped({ kind: "context_cleared", messageId })]
  }

  if (
    message.type === "user" &&
    message.message?.role === "user" &&
    typeof message.message.content === "string" &&
    message.message.content.startsWith("This session is being continued")
  ) {
    return [timestamped({ kind: "compact_summary", messageId, summary: message.message.content })]
  }

  return []
}

function claudeResultPromptIds(message: any): string[] | undefined {
  const ids = Array.isArray(message.user_message_uuids)
    ? message.user_message_uuids.filter((id: unknown): id is string => typeof id === "string" && id.length > 0)
    : []
  if (ids.length) return ids
  return typeof message.user_message_uuid === "string" && message.user_message_uuid
    ? [message.user_message_uuid] : undefined
}

export async function* createClaudeHarnessStream(
  q: Query,
  onTurnOriginChange?: (origin: HarnessEvent["origin"]) => void,
  onToolOrigin?: (toolUseId: string, origin: HarnessEvent["origin"]) => void,
  outboundOrigins?: ClaudeOutboundOriginTracker,
  observeControl?: (message: unknown) => boolean,
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
    if (observeControl?.(sdkMessage)) continue
    const promptIds = sdkMessage?.type === "result" ? claudeResultPromptIds(sdkMessage) : undefined
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
        ?? (typeof sdkMessage.uuid === 'string' ? outboundOrigins?.originForPromptId(sdkMessage.uuid) : undefined)
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
        // must not borrow the currently active user root.
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
      yield { type: "session_token", sessionToken, origin, promptIds }
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
          promptIds,
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
          promptIds,
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
      yield { type: "transcript", entry, origin, promptIds }
    }
    if (sdkMessage?.type === "result") {
      rootOrigin = "unknown"
      outboundOrigins?.finishResult(origin, promptIds, sdkMessage.is_error === true || sdkMessage.subtype === "cancelled")
      rootOrigin = outboundOrigins?.current() ?? "unknown"
      // Results from background and user roots may interleave. Retire
      // only the lineage that actually completed: clearing the whole table on
      // a task result would erase a still-live user parent, while
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
 * Outbound user prompts are authoritative even when Claude Code does
 * not echo their SDKUserMessage. A nonhuman continuation may finish first;
 * pending human turns remain reserved and resume as the root fallback.
 */
export class ClaudeOutboundOriginTracker {
  /** Ordered provider prompt ids. Negative ids are anonymous direct-test/
   * compatibility reservations; production Claude prompts use their exact
   * positive coordinator FIFO sequence. */
  private readonly pendingHumanTurns: number[] = []
  private readonly promptIds = new Map<number, string>()
  private readonly revokedHumanTurns = new Set<number>()
  private echoesPromptIds: boolean
  constructor(echoesPromptIds = false) { this.echoesPromptIds = echoesPromptIds }
  private nextAnonymousReservation = 0
  private root: HarnessEvent["origin"] = "unknown"

  beginHumanTurn(promptSeq?: number, promptId?: string) {
    const reservation = promptSeq ?? -(this.nextAnonymousReservation += 1)
    if (this.pendingHumanTurns.includes(reservation)) {
      throw new Error(`Duplicate Claude human-turn reservation: ${reservation}`)
    }
    this.pendingHumanTurns.push(reservation)
    if (promptId) this.promptIds.set(reservation, promptId)
    if (this.root === "unknown") this.root = "human"
  }

  cancelHumanTurn(promptSeq?: number) {
    const index = promptSeq === undefined
      ? this.pendingHumanTurns.length - 1
      : this.pendingHumanTurns.indexOf(promptSeq)
    if (index >= 0) {
      this.revokedHumanTurns.delete(this.pendingHumanTurns[index]!)
      this.promptIds.delete(this.pendingHumanTurns[index]!)
      this.pendingHumanTurns.splice(index, 1)
    }
    if (!this.hasHumanAuthority() && this.root === "human") this.root = "unknown"
  }

  private hasHumanAuthority() {
    return this.pendingHumanTurns.some(seq => !this.revokedHumanTurns.has(seq))
  }

  /** Input replay acknowledges the exact reservation; a cancelled UUID cannot regain human authority. */
  originForPromptId(id: string): HarnessEvent['origin'] | undefined {
    for (const [seq, promptId] of this.promptIds) if (promptId === id) return this.revokedHumanTurns.has(seq) ? 'unknown' : 'human'
    return undefined
  }

  revokeHumanTurn(promptSeq: number) {
    if (this.pendingHumanTurns.includes(promptSeq)) this.revokedHumanTurns.add(promptSeq)
    if (!this.hasHumanAuthority() && this.root === "human") this.root = "unknown"
  }

  /**
   * A later `system_init` proves that these older FIFO prompts can no longer
   * emit a result. Release their exact provenance reservations without
   * touching the current user turn or any non-human lineage.
   */
  discardHumanTurnReservations(promptSeqs: readonly number[]): number {
    const discarded = new Set(promptSeqs)
    const before = this.pendingHumanTurns.length
    for (let index = this.pendingHumanTurns.length - 1; index >= 0; index -= 1) {
      if (discarded.has(this.pendingHumanTurns[index]!)) {
        this.revokedHumanTurns.delete(this.pendingHumanTurns[index]!)
        this.promptIds.delete(this.pendingHumanTurns[index]!)
        this.pendingHumanTurns.splice(index, 1)
      }
    }
    if (!this.hasHumanAuthority() && this.root === "human") this.root = "unknown"
    return before - this.pendingHumanTurns.length
  }

  observeRoot(origin: HarnessEvent["origin"]) {
    this.root = origin ?? "unknown"
  }

  finishResult(origin: HarnessEvent["origin"], promptIds?: string[], endedEarly = false) {
    if (promptIds?.length) {
      this.echoesPromptIds = true
      this.discardHumanTurnReservations(this.pendingHumanTurns.filter(seq => promptIds.includes(this.promptIds.get(seq) ?? "")))
    } else if (origin === "human" && (!this.echoesPromptIds || endedEarly)) {
      const seq = this.pendingHumanTurns[0]
      if (seq !== undefined) this.cancelHumanTurn(seq)
    }
    this.root = this.hasHumanAuthority() ? "human" : "unknown"
  }

  current(): HarnessEvent["origin"] {
    return this.root
  }

  clear() {
    this.pendingHumanTurns.splice(0, this.pendingHumanTurns.length)
    this.promptIds.clear()
    this.revokedHumanTurns.clear()
    this.root = "unknown"
  }
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
  /** Test seam: production always uses the SDK query factory. */
  queryFn?: typeof query
  localPath: string
  model: string
  effort?: string
  planMode: boolean
  sessionToken: string | null
  forkSession: boolean
  onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
  hostActionsEnabled?: boolean
  executionControl?: ClaudeExecutionControl
  memory?: MemoryService | null
  /** Routing gate for agent-proposed memories; enables the propose_memory tool. */
  capture?: CaptureService | null
  projectId?: string
  chatId?: string
  /** Exact environment inherited by Claude Code and its Bash/tool children. */
  engineRuntime?: EngineRuntime
  subprocessEnv?: Record<string, string | undefined>
  /** Precomputed once by the coordinator; tests/direct callers may omit it. */
  memoryPlan?: MemoryInjectionPlan | null
  /** Per-turn injection override from an edited preview gate. */
  restrictMemoryIds?: string[]
  /** Fires when the session agent's propose_memory lands candidates — the
   * coordinator appends the transcript review card. */
  onMemoryProposal?: (created: MemoryItem[]) => void
}): Promise<ClaudeSessionHandle> {
  let executionControl = args.executionControl
  let currentPlanMode = args.planMode
  const toolOriginResolver = new ClaudeToolOriginResolver()
  const echoesPromptIds = !process.env.CLAUDE_EXECUTABLE
  const outboundOrigins = new ClaudeOutboundOriginTracker(echoesPromptIds)
  const plan: MemoryInjectionPlan | null = args.memoryPlan !== undefined
    ? args.memoryPlan
    : args.memory
      ? planMemoryInjection({
        memory: args.memory,
        projectId: args.projectId,
        chatId: args.chatId,
        restrictToIds: args.restrictMemoryIds,
      })
      : null
  let activeMemoryToolTurn: number | undefined
  let activeMemoryToolEngine: string | undefined
  let activeMemoryToolIds: readonly string[] | undefined = plan?.injectedMemories.map(item => item.id)
  let activeMemoryToolView: MemoryToolContext["memoryView"] = plan?.view
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
    get allowedMemoryIds() { return activeMemoryToolIds },
    get memoryView() { return activeMemoryToolView },
  }
  let nativeControlInput = false
  const memorySpecs: MemoryToolSpec[] = (args.memory && plan?.registerTools
      ? buildMemoryToolSpecs(args.memory, {
          capture: args.capture,
          pendingCandidateTiming: 'next_turn',
          onProposed: args.onMemoryProposal,
        })
      : []).map(spec => ({ ...spec, handler: async (...input: Parameters<typeof spec.handler>) => nativeControlInput
        ? { text: 'Memory tools are disabled during native context control.', isError: true }
        : spec.handler(...input) }))
  // Claude MCP lacks verified native call provenance; its handlers fail unavailable.
  if (args.hostActionsEnabled) memorySpecs.push(...hostActionToolSpecs())
  const memoryBlock = plan?.block ?? ""
  // Append environment guidance so the agent knows how a dev server it
  // starts becomes visible to the user.
  const systemAppend = buildClaudeSystemAppend(memoryBlock)
  const canUseTool: CanUseTool = async (toolName, input, options) => {
    if (nativeControlInput) return { behavior: 'deny', message: 'Native context control does not authorize tool execution.' }
    if (toolName !== "AskUserQuestion" && toolName !== "ExitPlanMode") {
      const control = executionControl
      const allowed = !control || control.isCurrent() && await control.approve(toolName, input, options.toolUseID)
      if (!allowed || control && (executionControl !== control || !control.isCurrent())) return { behavior: "deny", message: "Execution approval denied or expired" }
      return { behavior: "allow", updatedInput: input }
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

    const control = executionControl
    if (control && !control.isCurrent()) return { behavior: "deny", message: "Stale native question" }
    const result = await (control?.onToolRequest ?? args.onToolRequest)({ tool })
    if (control && (executionControl !== control || !control.isCurrent())) return { behavior: "deny", message: "Stale native question reply" }

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

  const engineRuntime = args.engineRuntime ?? await resolveEngineRuntime({ engine: "claude", model: args.model, env: args.subprocessEnv })
  const sdkRuntime = { ...engineRuntime, settings: { autoMemoryEnabled: false, autoDreamEnabled: false } }

  const launchOptions = {
    cwd: args.localPath,
    model: sdkRuntime.model,
    effort: (args.effort === "ultracode" ? "xhigh" : args.effort) as "low" | "medium" | "high" | "xhigh" | "max" | undefined,
    resume: args.sessionToken ?? undefined,
    forkSession: args.forkSession,
    permissionMode: args.planMode ? "plan" : executionControl?.permissionMode ?? "acceptEdits",
    ...(executionControl?.permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
    canUseTool,
    hooks: {
      PreToolUse: [{ hooks: [async () => executionControl && !executionControl.isCurrent()
        ? { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: "Execution policy changed or turn ended" } }
        : {}] }],
    },
    // Body text streams into ChatRuntime.streamingText as it is written —
    // without this the reply pops in whole at turn end (the DeepSeek
    // Anthropic-compatible endpoint streams SSE like the real one).
    includePartialMessages: true,
    ...(supportsClaudeInputReplay(engineRuntime.executable.version ?? '') ? { extraArgs: { 'replay-user-messages': null } } : {}),
    tools: [...CLAUDE_TOOLSET],
    systemPrompt: systemAppend
      ? { type: "preset", preset: "claude_code", append: systemAppend }
      : undefined,
    mcpServers: memorySpecs.length
      ? {
          memory: toClaudeMemoryMcpServer(memorySpecs.map(spec => ({ ...spec, handler: (input, context) => {
            if (executionControl && !executionControl.isCurrent()) return { text: "Execution policy changed or turn ended", isError: true }
            if (executionControl?.canUseMemory?.(spec.name) === false) return { text: "Memory access is disabled", isError: true }
            return spec.handler(input, context)
          } })), memoryToolContext),
        }
      : undefined,
    settingSources: engineRuntime.isolated ? [] : ["user", "project", "local"],
    // MemoSync IS the memory system. The harness's own auto-memory
    // (~/.claude/projects/<cwd>/memory/) is a second, uncontrolled
    // read+write channel — observed live: the model wrote MEMORY.md there
    // on a "记住…" request. Flag-level settings outrank user settings.
    settings: args.effort === "ultracode" ? { ...sdkRuntime.settings, ultracode: true } : sdkRuntime.settings,
    pathToClaudeCodeExecutable: engineRuntime.executable.path,
    env: sdkRuntime.env,
  } satisfies import("@anthropic-ai/claude-agent-sdk").Options
  const parentLaunch: ClaudeParentLaunch = {
    provider: "claude", memorySpecs,
    options: {
      model: launchOptions.model, effort: launchOptions.effort, tools: launchOptions.tools,
      systemPrompt: launchOptions.systemPrompt, settingSources: launchOptions.settingSources,
      settings: launchOptions.settings, permissionMode: launchOptions.permissionMode,
      env: launchOptions.env, pathToClaudeCodeExecutable: launchOptions.pathToClaudeCodeExecutable,
    },
  }
  const q = (args.queryFn ?? query)({ prompt: promptQueue, options: launchOptions })
  const controls = createClaudeCommandRuntime({ query: q, session: () => args.sessionToken ?? '',
    version: engineRuntime.executable.version ?? 'unknown', acknowledgesInputs: supportsClaudeInputReplay(engineRuntime.executable.version ?? ''),
    push: (content, uuid, shouldQuery) => {
      // Control inputs have no human turn reservation and cannot run memory tools.
      nativeControlInput = true
      activeMemoryToolIds = []
      promptQueue.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, shouldQuery,
        session_id: args.sessionToken ?? '', uuid: uuid as SDKUserMessage['uuid'] })
    }, close: () => { promptQueue.close(); q.close() },
  })
  const acceptedContexts = new Map<string, () => void>()
  const nativeStream = createClaudeHarnessStream(q, undefined, (toolUseId, origin) => {}, outboundOrigins, message => {
    const m = message as { type?: string; uuid?: string; user_message_uuid?: string; user_message_uuids?: string[]; session_id?: string }
    const ids = m.type === 'user' ? [m.uuid] : m.type === 'result' ? [m.user_message_uuid, ...(m.user_message_uuids ?? [])] : []
    for (const id of ids) {
      if (!id) continue
      const accepted = acceptedContexts.get(id)
      if (accepted) { acceptedContexts.delete(id); accepted() }
    }
    return controls.observe(message)
  })

  return {
    provider: "claude",
    commandRuntime: controls.runtime,
    initialize: async () => {
      const result = await q.initializationResult()
      // The launch permission is a native control acknowledgement; it does not need a model turn.
      const control = executionControl
      if (control && !currentPlanMode && control.isCurrent()) {
        await q.setPermissionMode(control.permissionMode)
        if (executionControl === control && control.isCurrent()) await control.onApplied()
      }
      return result
    },
    setExecutionControl: (control) => { executionControl = control },
    echoesPromptIds,
    parentLaunch,
    stream: { async *[Symbol.asyncIterator]() { try { yield* nativeStream } finally { controls.dispose() } } },
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
      context?: Pick<MemoryToolContext, "turn" | "engine" | "allowedMemoryIds" | "memoryView"> & { promptSeq?: number; promptId?: string; prepareContext?: (target: NativeContextTarget) => PreparedNativeContext },
    ) => {
      nativeControlInput = false
      // This control request is a native acknowledgement, unlike enqueueing a prompt.
      // Reapply every turn, including reused Queries and plan -> execute transitions.
      if (executionControl) {
        const control = executionControl
        if (!control.isCurrent()) throw new Error("Stale execution policy turn")
        await q.setPermissionMode(currentPlanMode ? "plan" : control.permissionMode)
        if (executionControl !== control || !control.isCurrent()) throw new Error("Stale execution policy acknowledgement")
        if (!currentPlanMode) await control.onApplied()
      }
      const prepared = context?.prepareContext?.({ nativeSession: controls.runtime.session || controls.runtime.instance,
        nativeInstance: controls.runtime.instance, version: controls.runtime.version })
      if (prepared?.text) content = `${prepared.text}\n\n${content}`
      if (prepared && context?.promptId) acceptedContexts.set(context.promptId, prepared.accepted)
      activeMemoryToolTurn = context?.turn
      activeMemoryToolEngine = context?.engine
      activeMemoryToolIds = context?.allowedMemoryIds
      activeMemoryToolView = context?.memoryView
      outboundOrigins.beginHumanTurn(context?.promptSeq, context?.promptId)
      try {
        promptQueue.push({
          type: "user",
          message: {
            role: "user",
            content,
          },
          parent_tool_use_id: null,
          session_id: args.sessionToken ?? "",
          ...(context?.promptId ? { uuid: context.promptId as SDKUserMessage["uuid"] } : {}),
        })
      } catch (error) {
        if (context?.promptId) acceptedContexts.delete(context.promptId)
        outboundOrigins.cancelHumanTurn(context?.promptSeq)
        throw error
      }
    },
    revokeHumanTurnReservation: (promptSeq) => outboundOrigins.revokeHumanTurn(promptSeq),
    discardHumanTurnReservations: (promptSeqs) => (
      outboundOrigins.discardHumanTurnReservations(promptSeqs)
    ),
    setModel: async (model: string) => {
      const bare = model.replace(/\[1m\]$/, "")
      const selected = sdkRuntime.isolated ? (sdkRuntime.model.endsWith("[1m]") ? `${bare}[1m]` : bare) : model
      await q.setModel(selected)
      parentLaunch.options.model = selected
    },
    setPermissionMode: async (planMode: boolean) => {
      const mode = planMode ? "plan" : executionControl?.permissionMode ?? "acceptEdits"
      await q.setPermissionMode(mode)
      currentPlanMode = planMode
      parentLaunch.options.permissionMode = mode
    },
    supportedModels: async () => await q.supportedModels(),
    memoryPlan: plan,
    close: () => {
      controls.dispose()
      toolOriginResolver.clear()
      outboundOrigins.clear()
      promptQueue.close()
      q.close()
    },
  }
}

interface PendingMemoryPreview {
  chatId?: string
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
  confirmationMode: "on_change" | "every_turn"
  proposedIds?: Set<string>
  autoProceed?: boolean
  assertCurrentView?: () => void
  proposalsId?: string
  transferId?: string
  checkupId?: string
  respond: (
    d: MemoryPreviewDecision,
    memoryIds?: string[],
    expectedUses?: ExpectedMemoryUse[],
    operationId?: string,
  ) => void
  reopen?: (from: "proposals" | "checkup" | "transfer", stageId: string) => void
}

type TransferGateDecision = "handled" | "skipped" | "cancelled"
type CheckupGateDecision = TransferGateDecision | "reopen_proposals" | "reopen_transfer"
type InternalGateWake<T extends string> = T | "invalidated"

export const IDLE_SESSION_TIMEOUT_MS = 30 * 60_000

export class AgentCoordinator {
  private readonly hostActions?: HostActionService
  private readonly store: EventStore
  private readonly onStateChange: (chatId?: string, options?: { immediate?: boolean }) => void
  private readonly harnessPolicies: HarnessPolicyService
  private readonly policyScopes = new Map<string, PolicyCallScope>()
  private readonly policyApprovals = new Map<string, PolicyCallScope>()
  private readonly policyChanges = new Set<string>()
  private readonly interactionQueues = new Map<string, Promise<unknown>>()
  private readonly respondingTools = new Set<string>()
  private readonly questionToolIds = new Map<string, string>()
  private readonly codexManager: CodexAppServerManager
  private readonly opencodeManager: OpencodeAgentManager
  private readonly piManager: PiAgentManager
  private readonly hasCustomPiConnection: boolean
  private readonly resolvePiConnectionFn: () => Promise<PiConnection | null>
  private readonly generateTitle: (messageContent: string, cwd: string) => Promise<GenerateChatTitleResult>
  private readonly startClaudeSessionFn: NonNullable<AgentCoordinatorArgs["startClaudeSession"]>
  private readonly memory: MemoryService | null
  private readonly capture: CaptureService | null
  private readonly memoryTrace: TraceService | null
  private readonly forkTraceFn: typeof runForkTrace
  private readonly forkCaptureFn: typeof runForkCapture
  private readonly forkQueryFn: typeof runForkQuery
  private readonly memoryBranches: boolean
  private readonly createMemoryBranchFn: typeof createMemoryBranch
  private readonly resolveCaptureRuntimeFn: typeof resolveEngineRuntime
  private readonly branchPreparations = new Map<string, {
    pipeline: MemoryBranchPipeline
    args: StartTurnArgs
    snapshots: { transfer: Map<string, string>; changes: Map<string, string> }
  }>()
  private readonly workingBranches = new Map<string, MemoryBranch>()
  private readonly auditBranches = new Map<string, Set<MemoryBranch>>()
  /** Detached from foreground turns; every completed turn has its own journal row. */
  private readonly captureQueue: CaptureQueue<DurableCaptureInput> | null
  private captureRecoveryStarted = false
  private readonly captureLaunches = new Map<string, Pick<PostTurnMemoryPassArgs, 'engineRuntime' | 'parentLaunch'>>()
  private readonly automaticCaptures = new Map<string, {
    controller: AbortController
    branch?: MemoryBranch
    task?: Promise<void>
  }>()
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
  private readonly getMemorySettings: () => { enabled: boolean; learn: boolean; control?: "review" | "auto" }
  private readonly getMemoryPreviewSettings: () => MemoryPreviewSettings
  private readonly claudeSessionFileExists: typeof claudeSessionFileExists
  private readonly claudeRetireTimeoutMs: number
  private reportBackgroundError: ((message: string) => void) | null = null
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
  // Hold only live startup owners; a settled startup releases its map entry,
  // while a newer reservation marks any still-pending predecessor superseded.
  private readonly startupReservations = new Map<string, StartupReservation>()
  private readonly engineStartAbortControllers = new Map<string, AbortController>()
  private readonly closedChats = new Set<string>()
  private runtimeStopping = false
  private readonly idleCloseTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly memoryWork = new Map<string, number>()
  // Chats where the user hit Stop while the preview gate was still being set
  // up (before pendingPreviews exists). The detached runPreviewGateThenBoot
  // observes this and unwinds instead of parking a gate / booting (BUG AGENT-2).
  private readonly cancelledDuringPreview = new Set<string>()
  readonly drainingStreams = new Map<string, { turn: HarnessTurn }>()
  readonly claudeSessions = new Map<string, ClaudeSessionState>()
  /**
   * In-flight assistant text per chat, accumulated from assistant_delta harness
   * events (DeepSeek/codex agentMessage deltas). Broadcast via ChatRuntime.
   * streamingText only — never persisted; cleared the moment the final
   * assistant_text entry is appended so no snapshot carries both.
   */
  private readonly streamingAssistantTexts = new Map<string, { itemId: string; text: string }>()

  constructor(args: AgentCoordinatorArgs) {
    this.hostActions = args.hostActions
    this.harnessPolicies = args.harnessPolicies ?? new HarnessPolicyService()
    this.store = args.store
    this.onStateChange = args.onStateChange
    this.codexManager = args.codexManager ?? new CodexAppServerManager()
    this.codexManager.setCommandContextRestorer?.((chatId, text, signal) => this.codexManager.appendDeveloperContext(chatId, text, signal))
    this.stableToolSchemas = args.stableToolSchemas ?? (() => [])
    this.opencodeManager = args.opencodeManager ?? new OpencodeAgentManager()
    this.piManager = args.piManager ?? new PiAgentManager()
    this.hasCustomPiConnection = Boolean(args.resolvePiConnection)
    this.resolvePiConnectionFn = args.resolvePiConnection ?? resolvePiConnection
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
    this.getMemorySettings = args.getMemorySettings ?? (() => ({ enabled: true, learn: true }))
    this.memoryBranches = (args.memoryBranches ?? Boolean(args.createMemoryBranch))
    this.createMemoryBranchFn = args.createMemoryBranch ?? createMemoryBranch
    this.resolveCaptureRuntimeFn = args.resolveCaptureRuntime ?? resolveEngineRuntime
    this.captureQueue = this.memoryBranches && this.memory ? new CaptureQueue(this.memory.db) : null
    this.getMemoryPreviewSettings =
      args.getMemoryPreviewSettings ?? (() => ({ enabled: true, autoProceedWhenEmpty: true, confirmationMode: "on_change" }))
    this.claudeSessionFileExists = args.claudeSessionFileExists ?? claudeSessionFileExists
    this.claudeRetireTimeoutMs = args.claudeRetireTimeoutMs ?? 10_000
  }

  private newMemoryBranch(args: Pick<StartTurnArgs, "chatId" | "provider" | "model" | "effort" | "serviceTier" | "engineRuntime">, purpose: string, parent?: string | null, parentLaunch?: ParentLaunch, completedTurn = false, turnId?: string) {
    const chat = this.store.requireChat(args.chatId)
    if (this.isEngineStartBlocked(args.chatId) || chat.memoryDisabled || !this.getMemorySettings().enabled) throw new Error('Memory branch is no longer enabled')
    const project = this.store.getProject(chat.projectId)
    if (!project) throw new Error("Memory branch project is unavailable")
    const runtime = args.engineRuntime ?? (completedTurn ? undefined : this.sessionRuntimes.get(args.chatId))
    const parentSessionToken = parent === undefined ? chat.pendingForkSessionToken ?? chat.sessionToken : parent
    const branch = this.createMemoryBranchFn({
      provider: args.provider,
      parentSessionToken,
      localPath: project.localPath,
      model: runtime?.model ?? args.model,
      effort: args.effort,
      serviceTier: args.serviceTier,
      subprocessEnv: runtime?.env,
      runtime,
      purpose,
      // A completion snapshot also disambiguates successive models on one token.
      parentLaunch: parentLaunch ?? (completedTurn ? undefined : this.sessionLaunches.get(`${args.provider}:${parentSessionToken}`) ?? this.parentLaunches.get(args.chatId)),
      onRequest: observation => {
        this.memory?.logger.event({ type: 'memory.latency', sessionId: args.chatId, turnId,
          stage: purpose, segment: 'branch_request', branchId: observation.branchId, durationMs: observation.durationMs,
          requestCount: observation.requestCount, outcome: observation.outcome })
        this.memory?.logger.event({ type: 'memory.latency', sessionId: args.chatId, turnId,
          stage: purpose, segment: 'host', branchId: observation.branchId, durationMs: observation.hostDurationMs, outcome: observation.outcome })
      },
    })
    this.memory?.logger.event({ type: "memory.branch", sessionId: args.chatId, engine: args.provider, purpose, branchId: branch.id, mode: branch.mode })
    let branchDisposed = false
    const tracked: MemoryBranch = {
      get id() { return branch.id },
      get mode() { return branch.mode },
      get sessionToken() { return branch.sessionToken },
      ask: (prompt, options) => this.trackMemoryWork(args.chatId, () => {
        if (this.isEngineStartBlocked(args.chatId) || !this.store.getChat(args.chatId) || this.store.getChat(args.chatId)?.memoryDisabled || !this.getMemorySettings().enabled) throw new Error('Memory branch is no longer enabled')
        return branch.ask(prompt, options)
      }),
      dispose: () => {
        if (branchDisposed) return
        branchDisposed = true
        this.auditBranches.get(args.chatId)?.delete(tracked)
        const cleanup = branch.dispose()
        if (!cleanup) return
        this.branchCleanups.add(cleanup)
        void cleanup.catch(() => this.reportBackgroundError?.("OpenCode memory branch cleanup failed")).finally(() => this.branchCleanups.delete(cleanup))
        return cleanup
      },
    }
    if (purpose === 'audit') {
      const audits = this.auditBranches.get(args.chatId) ?? new Set<MemoryBranch>()
      audits.add(tracked)
      this.auditBranches.set(args.chatId, audits)
    }
    return tracked
  }

  private cancelAudits(chatId: string) {
    for (const branch of this.auditBranches.get(chatId) ?? []) branch.dispose()
    this.auditBranches.delete(chatId)
  }

  private memoryBranchSnapshot(): Map<string, string> {
    return new Map((this.memory?.store.list() ?? []).map(item => [item.id, JSON.stringify({
      id: item.id, version: item.version, status: item.status, content: item.content, detail: item.detail,
      scope: item.scope, projectId: item.projectId, sessionId: item.sessionId,
      relations: this.memory!.store.getRelations(item.id),
      pendingRevision: this.memory!.store.hasOpenRevision(item.id),
    })]))
  }

  private readonly runtimeSelections = new Map<string, string>()
  private readonly sessionRuntimes = new Map<string, EngineRuntime>()
  private readonly branchCleanups = new Set<Promise<void>>()
  private readonly parentLaunches = new Map<string, ParentLaunch>()
  private readonly sessionLaunches = new Map<string, ParentLaunch>()

  memoryRuntimeChoice(chatId: string) {
    const current = this.activeTurns.get(chatId) ?? this.branchPreparations.get(chatId)?.args
    if (current) return { provider: current.provider, model: current.model, effort: current.effort, serviceTier: current.serviceTier, runtime: this.sessionRuntimes.get(chatId) ?? (current as StartTurnArgs).engineRuntime }
    const runtime = this.sessionRuntimes.get(chatId)
    return runtime ? { provider: runtime.engine, model: runtime.model, runtime } : undefined
  }

  private startMemoryBranches(args: StartTurnArgs, ctx: { project: NonNullable<ReturnType<EventStore["getProject"]>>; turnNumber: number }) {
    if (!this.memoryBranches) return
    const hostStarted = performance.now()
    this.disposeMemoryBranches(args.chatId)
    const captureInput = { projectId: ctx.project.id, sessionId: args.chatId, turn: ctx.turnNumber, engine: args.provider, userText: args.memoryUserText ?? args.content, policyKey: this.memoryAnalysisPolicyKey(args.chatId, args.provider) }
    const candidate = this.capture?.buildBranchPrompt?.(captureInput)
    const transfer = this.memoryTransferDetect?.buildTaskBranchPrompt?.({ ...captureInput, projectTitle: ctx.project.title, taskText: captureInput.userText })
    const changes = this.memoryCheckup?.buildBranchPrompt?.(captureInput, captureInput.userText)
    const empty = (raw: Record<string, unknown>): BranchRequest => ({ prompt: '', dependencyKey: '', skip: { raw, reason: 'service-unavailable' } })
    const snapshot = this.memoryBranchSnapshot()
    this.branchPreparations.set(args.chatId, {
      args,
      snapshots: { transfer: new Map(snapshot), changes: new Map(snapshot) },
      pipeline: new MemoryBranchPipeline({
        createBranch: purpose => this.newMemoryBranch(args, purpose, undefined, undefined, false, args.turnId),
        onStage: (stage, outcome, reason) => this.memory?.logger.event({ type: 'memory.scheduling', sessionId: args.chatId, turnId: args.turnId, stage, outcome, reason }),
        requests: {
          candidate: candidate ?? empty({ candidates: [] }),
          transfer: this.memoryBranchRequest(args, transfer ?? empty({ suggestions: [] })),
          changes: this.memoryBranchRequest(args, changes ?? empty({ conflicts: [], redundancy: [], staleness: [] })),
        },
      }),
    })
    this.memory?.logger.event({ type: 'memory.latency', sessionId: args.chatId, turnId: args.turnId, stage: 'preparation-start', segment: 'host', durationMs: performance.now() - hostStarted })
  }

  private memoryWait(chatId: string, stage: string, turnId?: string) {
    const started = performance.now()
    let settled = false
    return (outcome: string) => {
      if (settled) return
      settled = true
      this.memory?.logger.event({ type: 'memory.latency', sessionId: chatId, turnId, stage, segment: 'human_wait', durationMs: performance.now() - started, outcome })
    }
  }

  private memoryPolicyKey() {
    return JSON.stringify(this.getMemorySettings())
  }

  private memoryAnalysisPolicyKey(chatId: string, engine: AgentProvider): string {
    const selected = this.executionPolicyFor(chatId, engine)
    return JSON.stringify([this.memoryPolicyKey(), executionPolicyKey(selected.policy), selected.revision])
  }

  private memoryViewGuard(args: StartTurnArgs, allowArchived = false): () => void {
    const initialChat = this.store.requireChat(args.chatId)
    const initialItems = this.memory?.injectedFor(initialChat.projectId, args.chatId) ?? []
    const initialIds = initialItems.map(item => item.id)
    const initialEventSeq = this.memory?.store.latestEventSeq()
    const initialIdSet = new Set(initialIds)
    const key = () => {
      const chat = this.store.requireChat(args.chatId)
      return JSON.stringify([args.memoryUserText ?? args.content, this.memoryAnalysisPolicyKey(args.chatId, args.provider),
        chat.memoryDisabled, this.memory && planMemoryInjection({ memory: this.memory, projectId: chat.projectId, chatId: args.chatId }).view.revision])
    }
    const approved = key()
    return () => {
      if (key() === approved) return
      if (allowArchived && this.memory) {
        const chat = this.store.requireChat(args.chatId)
        const visible = this.memory.injectedFor(chat.projectId, args.chatId)
        const current = initialIds.map(id => this.memory!.store.getById(id))
        const visibleIds = new Set(visible.map(item => item.id))
        if (visible.every(item => initialIdSet.has(item.id))
          && current.every(item => item && (item.status === 'archived' || (item.status === 'active' && visibleIds.has(item.id))))) {
          // Reconstruct the approved view with only lifecycle changes reversed.
          const restored = current.map(item => ({ ...item!, status: 'active' as const }))
          const overrides = relationLifecycleOverrides(this.memory, initialIds, initialEventSeq)
          const archivedIds = new Set([
            ...current.filter(item => item?.status === 'archived').map(item => item!.id),
            ...overrides.archivedAsActive,
          ])
          const revision = compileMemoryView(this.memory, restored, restored, chat.projectId, args.chatId, archivedIds, overrides.restoredAsArchived).revision
          const reconstructed = JSON.stringify([args.memoryUserText ?? args.content, this.memoryAnalysisPolicyKey(args.chatId, args.provider), chat.memoryDisabled, revision])
          if (reconstructed === approved) return
        }
      }
      throw new Error('Working memory changed during review. Reopen preparation to review the updated items.')
    }
  }

  private memoryBranchRequest(args: StartTurnArgs, request: BranchRequest): BranchRequest {
    const chat = this.store.requireChat(args.chatId)
    const view = this.memory ? planMemoryInjection({ memory: this.memory, projectId: chat.projectId, chatId: args.chatId }).view : undefined
    return { ...request, viewKey: JSON.stringify({ policy: this.memoryAnalysisPolicyKey(args.chatId, args.provider), task: args.memoryUserText ?? args.content,
      viewRevision: view?.revision,
      projectId: chat.projectId, chatId: args.chatId, disabled: chat.memoryDisabled,
      store: [...this.memoryBranchSnapshot()].sort(([a], [b]) => a.localeCompare(b)),
      declined: (this.memory?.store.list() ?? []).filter(item => this.memory!.store.getKv(`transfer_declined:${item.id}:${chat.projectId ?? args.chatId}`)).map(item => item.id).sort(),
    }) }
  }

  private async continueMemoryBranch(chatId: string, stage: "transfer" | "changes", review: string, dependencyKey: string, currentRequest?: BranchRequest | null) {
    const preparation = this.branchPreparations.get(chatId)
    if (!preparation) throw new Error("Memory preparation branch is unavailable")
    const previous = preparation.snapshots[stage]
    const next = this.memoryBranchSnapshot()
    const upsert = [...next].filter(([id, value]) => previous.get(id) !== value).map(([, value]) => JSON.parse(value))
    const remove = [...previous.keys()].filter(id => !next.has(id))
    preparation.snapshots[stage] = next
    const chat = this.store.requireChat(chatId)
    const decisions = this.store.getMessages(chatId).filter(message =>
      (message.kind === "memory_proposals_decision" || message.kind === "memory_transfer_decision" || message.kind === "memory_checkup_decision")
      && message.createdAt >= (this.store.getMessages(chatId).find(entry => entry._id === preparation.args.turnId)?.createdAt ?? Infinity),
    ).map(({ _id, createdAt, ...decision }) => decision)
    const declinedSources = (this.memory?.store.list() ?? []).filter(item => this.memory!.store.getKv(`transfer_declined:${item.id}:${chat.projectId ?? chatId}`)).map(item => item.id)
    return await preparation.pipeline.continue(stage, { review, changes: { upsert, remove, decisions, declinedSources }, dependencyKey,
      request: currentRequest ? this.memoryBranchRequest(preparation.args, currentRequest) : undefined,
    })
  }

  private disposeMemoryBranches(chatId: string) {
    this.branchPreparations.get(chatId)?.pipeline.dispose()
    this.branchPreparations.delete(chatId)
    this.workingBranches.get(chatId)?.dispose()
    this.workingBranches.delete(chatId)
  }

  private restoreUndeliveredEnforcement(chatId: string) {
    if (this.activeTurns.get(chatId)?.memoryDeliveryAccepted) return
    const entries = this.turnPayAttention.get(chatId)
    if (!entries?.length || !this.memory) return
    const queued = this.memory.store.getKv<Array<string | { id: string; quote?: string }>>(`pay_attention:${chatId}`) ?? []
    const merged = new Map(queued.map(item => typeof item === "string" ? [item, { id: item }] : [item.id, item]))
    for (const item of entries) if (!merged.has(item.id)) merged.set(item.id, item)
    this.memory.store.setKv(`pay_attention:${chatId}`, [...merged.values()])
    this.turnPayAttention.delete(chatId)
  }

  private async refreshTransferAfterCandidateReview(args: StartTurnArgs, turnNumber: number) {
    if (!this.memoryBranches || !this.memoryTransferDetect) return false
    const chat = this.store.requireChat(args.chatId)
    const project = this.store.getProject(chat.projectId)
    if (!project) throw new Error("Transfer project is unavailable")
    const transferId = this.store.getMessages(args.chatId).filter(message => message.kind === "memory_transfer").at(-1)?.transferId
    const stage = await this.runTransferGate(args, { chat, project, turnNumber }, Promise.resolve(), { transferId, recompute: true })
    return stage.decision === "cancelled"
  }

  private async assessWorkingMemory(args: StartTurnArgs, memories: MemoryItem[], mandatoryIds: string[]): Promise<RelevantMemory[]> {
    if (!this.memoryBranches) return this.memoryRelevance?.assess(args.memoryUserText ?? args.content, memories, {
      mustInclude: mandatoryIds, recentContext: this.recentConversationDigest(args.chatId),
    }) ?? []
    this.workingBranches.get(args.chatId)?.dispose()
    const branch = this.newMemoryBranch(args, "working-memory")
    this.workingBranches.set(args.chatId, branch)
    const assertCurrentView = this.memoryViewGuard(args, true)
    const input = { task: args.memoryUserText ?? args.content, memories, mandatoryIds }
    const raw = await branch.ask(buildWorkingMemoryBranchPrompt(input), { schema: memoryStageSchema("working-memory") })
    assertCurrentView()
    const result = parseWorkingMemoryBranchResult(raw, input)
    const expected = new Map(result.expectedUses.map(use => [use.id, use.expectedUse]))
    return result.relevant.map(item => ({ ...item, expectedUse: expected.get(item.id) }))
  }

  private async reportWorkingMemoryFailure(chatId: string, previewId: string, revision: number) {
    const pending = this.pendingPreviews.get(chatId)
    if (pending?.previewId !== previewId || pending.revision !== revision) return
    await this.store.appendMessage(chatId, timestamped({
      kind: "memory_preview_relevance", previewId, revision, relevant: [], expectedUses: [],
      errorUiText: { code: "selectionFailed" },
      error: "Working-memory selection failed. Select the memories to use and confirm to retry their expected-use planning, or reopen preparation.",
    }))
    this.emitStateChange(chatId)
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
    return this.respondToMemoryPreview(command)
  }

  private async respondToMemoryPreview(command: Parameters<AgentCoordinator["respondMemoryPreview"]>[0], auto = false) {
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
    let effectiveIds = [...requestedIds]
    if (command.decision === "go_on") {
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
    // Claim and remove this exact map entry before expected-use planning (or
    // any other await). A second response sees the claim and cannot emit its
    // own attempted event, expire the winner's card, or dispatch Claude.
    if (!this.claimPendingPreviewResponse(command.chatId, pending)) {
      throw new Error("This Working Memory preview is already being handled")
    }
    pending.autoProceed = auto

    let handedOff = false
    try {

      const authoritativeExpectedUses = command.decision === "go_on"
        ? await this.ensurePendingPreviewExpectedUses(pending, effectiveIds)
        : []
      if (command.decision === 'go_on') pending.assertCurrentView?.()
      if (command.decision === 'go_on' && this.memory) {
        const chat = this.store.requireChat(command.chatId)
        effectiveIds = normalizeMemorySelection({ memory: this.memory, projectId: chat.projectId, chatId: command.chatId, selectedIds: effectiveIds })
        if (auto && memoryConfirmationReasons(
          pending.memories.filter(item => effectiveIds.includes(item.id)),
          getMemoryConfirmation(this.memory.store, command.chatId),
          (this.turnPayAttention.get(command.chatId) ?? []).map(item => item.id),
        ).length) throw new Error("Working memory needs confirmation.")
      }

      handedOff = true
      pending.respond(
        command.decision,
        command.decision === "go_on"
          ? effectiveIds
          : undefined,
        authoritativeExpectedUses.filter(use => effectiveIds.includes(use.id)),
        command.operationId,
      )
    } catch (error) {
      if (!handedOff) this.restorePendingPreviewResponse(command.chatId, pending)
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
    for (const id of effectiveIds) (pending.proposedIds ??= new Set()).add(id)
    return await this.ensurePendingPreviewExpectedUses(pending, effectiveIds)
  }

  async reviseMemoryPreview(input: { chatId: string; previewId: string; instruction: string; selectedIds: string[] }) {
    const pending = this.pendingPreviews.get(input.chatId)
    const branch = this.workingBranches.get(input.chatId)
    if (!pending?.published || pending.previewId !== input.previewId || !branch) throw new Error("No matching working-memory branch")
    pending.assertCurrentView?.()
    const liveIds = new Set(this.memory?.injectedFor(this.store.requireChat(input.chatId).projectId, input.chatId).map(item => item.id) ?? [])
    const selected = new Set(input.selectedIds.filter(id => liveIds.has(id)))
    for (const id of selected) (pending.proposedIds ??= new Set()).add(id)
    const mandatoryIds = (this.turnPayAttention.get(input.chatId) ?? []).filter(item => selected.has(item.id)).map(item => item.id)
    const branchInput = { task: pending.task, memories: pending.memories.filter(item => liveIds.has(item.id)), mandatoryIds }
    const raw = await branch.ask([
      'The developer is adjusting working memory. Continue in this same branch. Answer questions while preserving the selection; follow instructions about selection with minimal changes. Include a short reply field.',
      `Current selection: ${JSON.stringify([...selected])}. Developer message: ${JSON.stringify(input.instruction)}`,
      buildWorkingMemoryBranchPrompt(branchInput),
    ].join('\n\n'), { schema: memoryStageSchema("working-memory"), budget: { maxTurns: 3, maxToolCalls: 1 } })
    if (this.pendingPreviews.get(input.chatId) !== pending) throw new Error("Working-memory preview changed during revision")
    pending.assertCurrentView?.()
    const result = parseWorkingMemoryBranchResult(raw, branchInput)
    for (const use of result.expectedUses) pending.expectedUseById.set(use.id, use.expectedUse)
    for (const item of result.relevant) (pending.proposedIds ??= new Set()).add(item.id)
    return { selectedIds: result.relevant.map(item => item.id), reply: typeof raw.reply === "string" ? raw.reply : "Updated working memory for this task." }
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
      // an error banner: the flow has already moved on.
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
  private recordMemoryCitations(text: string, sessionId?: string, memoryState?: TurnMemoryState): string[] {
    if (!this.memory || !text || memoryState?.memoryActive === false) return []
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
    args: { chatId: string; turnNumber?: number; memoryState?: TurnMemoryState },
  ): Set<string> {
    const applied = new Set<string>()
    if (!this.memory) return applied
    const memoryState = args.memoryState ?? resolveTurnMemoryState(this.getMemorySettings(), this.store.requireChat(args.chatId).memoryDisabled)
    if (!memoryState.learnActive) return applied
    const mode = this.memory.store.getKv<{ mode?: string }>("evolution_policy")?.mode ?? "ask"
    if (memoryState.control !== "auto" && mode !== "auto") return applied
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

  private isCancelledQueueRow(chatId: string, queuedMessageId: string): boolean {
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
      if (!this.isCancelledQueueRow(chatId, head.id)) return head
      try {
        await this.store.removeQueuedMessage(chatId, head.id)
      } catch (error) {
        if (this.store.getQueuedMessage(chatId, head.id)) {
          this.reportBackgroundError?.(
            `[queue-dispatch] chat ${chatId}: stopped queue row remains blocked: ${error instanceof Error ? error.message : String(error)}`,
          )
          return null
        }
      }
    }
  }

  private launchPostTurnMemoryPasses(args: PostTurnMemoryPassArgs, active: ActiveTurn): void {
    if (args.memoryState?.memoryActive === false) return
    // The source is the completed turn, even if cancellation or persistence
    // awaits have already allowed a successor to enter activeTurns.
    args.engineRuntime ??= active.engineRuntime
    args.parentLaunch ??= active.parentLaunch
    args.analysisPolicyKey ??= active.analysisPolicyKey
    args.projectId = active.projectId
    if (this.memoryBranches) {
      args.injectedMemories = active.memoryPlan?.injectedMemories.map(item => ({ ...item }))
      args.expectedUses = active.expectedUses
      args.model = active.model
      args.effort = active.effort
      args.serviceTier = active.serviceTier
      const messages = this.store.getMessages(args.chatId)
      const start = messages.findIndex(message => message._id === args.turnId)
      const nextTurn = start >= 0 ? messages.findIndex((message, index) => index > start && message.kind === 'user_prompt') : -1
      const turnMessages = start >= 0 ? messages.slice(start + 1, nextTurn < 0 ? undefined : nextTurn) : []
      args.executionText = turnMessages.filter(message => message.kind === "tool_call" || message.kind === "tool_result")
        .map(message => JSON.stringify(message)).join("\n")
      args.executionTools = turnMessages.flatMap(message => {
        if (message.kind === "tool_call") return [{ toolId: message.tool.toolId, text: JSON.stringify(message.tool) }]
        if (message.kind === "tool_result") return [{ toolId: message.toolId, text: typeof message.content === "string" ? message.content : JSON.stringify(message.content) }]
        return []
      })
      args.sessionToken = active.sessionToken
      args.localPath = active.localPath
    }
    void this.trackMemoryWork(args.chatId, () => this.runPostTurnMemoryPasses(args)).catch((error) => {
      this.reportBackgroundError?.(`[memory-post-turn] chat ${args.chatId}: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  private cancelAutomaticCapture(chatId: string, reason = 'chat-closed', preserve = false): void {
    const run = this.automaticCaptures.get(chatId)
    run?.controller.abort(new Error(reason))
    run?.branch?.dispose()
    if (!preserve) {
      this.captureQueue?.cancelChat(chatId, reason)
      for (const key of this.captureLaunches.keys()) if (key.startsWith(`${chatId}:`)) this.captureLaunches.delete(key)
    }
  }

  /** Called by the settings owner, and also checked at every job boundary. */
  memorySettingsChanged(chatId?: string): void {
    const settings = this.getMemorySettings()
    const chats = new Set([...(this.captureQueue?.list().filter(job => ['pending', 'running', 'ready', 'applying'].includes(job.status)).map(job => job.chatId) ?? []), ...this.auditBranches.keys()])
    if (chatId) chats.add(chatId)
    for (const id of chats) {
      const chat = this.store.getChat(id)
      if (!chat || chat.memoryDisabled || !settings.enabled) { this.cancelAudits(id); this.disposeMemoryBranches(id) }
      if (!chat || chat.memoryDisabled || !settings.enabled || !settings.learn || settings.control !== 'auto') this.cancelAutomaticCapture(id, 'memory-disabled-or-policy-changed')
    }
  }

  /** Call once after store/settings initialization. Native launch snapshots
   * stay in memory; recovery resolves only the original runtime identity. */
  recoverAutomaticCaptures(): void {
    if (!this.captureQueue || this.runtimeStopping || this.captureRecoveryStarted) return
    this.captureRecoveryStarted = true
    this.captureQueue.recover()
    for (const chatId of new Set(this.captureQueue.list().filter(job => ['pending', 'ready'].includes(job.status)).map(job => job.chatId))) this.drainAutomaticCaptures(chatId)
  }

  getAutomaticCaptureOutcomes(chatId: string) {
    return (this.captureQueue?.list(chatId) ?? []).map(({ payload, result, ...job }) => job)
  }

  private captureInvalidReason(job: CaptureJob<DurableCaptureInput>): string | undefined {
    const chat = this.store.getChat(job.chatId)
    const finished = job.payload.finished
    if (!chat || chat.deletedAt || this.closedChats.has(job.chatId)) return 'chat-unavailable'
    if (chat.projectId !== job.projectId || !this.store.getProject(chat.projectId) || this.store.getProject(chat.projectId)?.localPath !== finished.localPath) return 'scope-changed'
    const settings = this.getMemorySettings()
    if (chat.memoryDisabled || !settings.enabled || !settings.learn || settings.control !== 'auto' || this.memoryPolicyKey() !== job.payload.policyKey) return 'memory-disabled-or-policy-changed'
    if (finished.analysisPolicyKey !== this.memoryAnalysisPolicyKey(job.chatId, finished.engine as AgentProvider)) return 'execution-policy-changed'
    if (!this.store.getMessages(job.chatId).some(message => message._id === job.turnId)) return 'original-turn-unavailable'
  }

  private launchAutomaticCapture(args: PostTurnMemoryPassArgs): void {
    if (!this.captureQueue || !this.capture?.buildBranchPrompt || !this.capture.captureFromBranch
      || args.memoryState?.control !== 'auto' || !args.memoryState.memoryActive
      || !args.memoryState.learnActive || args.memoryDisabled || this.isEngineStartBlocked(args.chatId)) return
    const { parentLaunch, engineRuntime, injectedMemories, expectedUses, ...finished } = args
    const runtime = engineRuntime ? { fingerprint: captureRuntimeFingerprint(engineRuntime), connectionId: engineRuntime.connectionId, model: engineRuntime.model } : undefined
    const enqueued = this.captureQueue.enqueue({ chatId: args.chatId, turnId: args.turnId, projectId: args.projectId, turnNumber: args.turnNumber ?? 0 }, { finished, policyKey: this.memoryPolicyKey(), runtime })
    this.memory?.logger.event({ type: 'memory.scheduling', sessionId: args.chatId, turnId: args.turnId, stage: 'automatic-capture', ...enqueued })
    if (enqueued.outcome === 'queued') this.captureLaunches.set(`${args.chatId}:${args.turnId}`, { parentLaunch, engineRuntime })
    this.drainAutomaticCaptures(args.chatId)
  }

  private drainAutomaticCaptures(chatId: string): void {
    if (!this.captureQueue || this.automaticCaptures.has(chatId) || this.runtimeStopping) return
    const queue = this.captureQueue
    const run: { controller: AbortController; branch?: MemoryBranch; task?: Promise<void> } = { controller: new AbortController() }
    this.automaticCaptures.set(chatId, run)
    const signal = run.controller.signal
    const task = async () => {
      try {
        let job: CaptureJob<DurableCaptureInput> | undefined
        while (!signal.aborted && (job = queue.next(chatId))) {
          const current = job
          const launchKey = `${chatId}:${current.turnId}`
          let hostStarted: number | undefined
          try {
            const invalid = this.captureInvalidReason(current)
            if (invalid) { queue.finish(current, 'skipped', invalid); continue }
            const finished = current.payload.finished
            const launch = this.captureLaunches.get(launchKey)
            let runtime = launch?.engineRuntime
            // A request that survived restart must never borrow the next turn's
            // runtime, model defaults, task or parent launch. No credentials are
            // persisted. Missing/changed identities settle without model work.
            if (!launch && current.status === 'pending') {
              const reference = current.payload.runtime
              if (!reference) { queue.finish(current, 'skipped', 'original-runtime-unavailable'); continue }
              runtime = await this.resolveCaptureRuntimeFn({ engine: finished.engine as AgentProvider, model: reference.model, connectionId: reference.connectionId })
              signal.throwIfAborted()
              if (captureRuntimeFingerprint(runtime) !== reference.fingerprint) { queue.finish(current, 'skipped', 'runtime-changed'); continue }
            }
            signal.throwIfAborted()
            const invalidAfterResolve = this.captureInvalidReason(current)
            if (invalidAfterResolve) { queue.finish(current, 'skipped', invalidAfterResolve); continue }
            const input = { projectId: current.projectId, sessionId: chatId, turn: current.turnNumber, engine: finished.engine, userText: finished.userText, policyKey: finished.analysisPolicyKey, signal }
            this.memory?.logger.event({ type: 'memory.latency', sessionId: chatId, turnId: current.turnId, stage: 'automatic-capture', segment: 'queue_wait', durationMs: Date.now() - current.enqueuedAt })
            if (current.status === 'pending') {
              if (!queue.transition(current, 'pending', 'running')) continue
              const request = this.capture!.buildBranchPrompt!(input)
              const branch = this.newMemoryBranch({ chatId, provider: finished.engine as AgentProvider,
                model: finished.model ?? runtime?.model ?? '', effort: finished.effort, serviceTier: finished.serviceTier, engineRuntime: runtime },
                'candidate', finished.sessionToken ?? finished.claudeSessionToken ?? null, launch?.parentLaunch, true, current.turnId)
              run.branch = branch
              let rejectAbort!: () => void
              const cancelled = new Promise<never>((_, reject) => {
                rejectAbort = () => reject(signal.reason)
                signal.addEventListener('abort', rejectAbort, { once: true })
              })
              try {
                const prompt = [request.prompt,
                  'BOUND COMPLETED TURN: extract observations only from this original turn. Later turns in inherited native history are not evidence for this capture. Do not execute or continue the task.',
                  JSON.stringify({ turnId: current.turnId, turn: current.turnNumber, task: finished.userText,
                    assistantText: finished.assistantText, executionText: finished.executionText, executionTools: finished.executionTools }),
                ].join('\n\n')
                const raw = await Promise.race([branch.ask(prompt, { schema: memoryStageSchema('candidate'), signal }), cancelled])
                signal.throwIfAborted()
                queue.ready(current, { raw, dependencyKey: request.dependencyKey })
              } finally {
                signal.removeEventListener('abort', rejectAbort)
                if (!signal.aborted) branch.dispose()
                run.branch = undefined
              }
            }
            signal.throwIfAborted()
            const invalidAfterAnalysis = this.captureInvalidReason(current)
            if (invalidAfterAnalysis) { queue.finish(current, 'skipped', invalidAfterAnalysis); continue }
            const ready = queue.get(chatId, current.turnId)
            if (!ready?.result || !queue.transition(current, 'ready', 'applying')) continue
            hostStarted = performance.now()
            const outcome = await this.capture!.captureFromBranch!(ready.result.raw, input, ready.result.dependencyKey)
            signal.throwIfAborted()
            // Commit the terminal receipt before transcript publication. A
            // restart cannot replay reinforcement after an append failure.
            queue.finish(current, 'completed')
            await this.publishCapturedProposals(outcome, finished)
          } catch (error) {
            if (!signal.aborted) {
              queue.finish(current, 'failed', error instanceof Error ? error.message : String(error))
              this.reportBackgroundError?.(`[memory-auto-capture] chat ${chatId} turn ${current.turnNumber}: ${error instanceof Error ? error.message : String(error)}`)
            }
          } finally {
            this.captureLaunches.delete(launchKey)
            if (hostStarted !== undefined) this.memory?.logger.event({ type: 'memory.latency', sessionId: chatId, turnId: current.turnId, stage: 'automatic-capture', segment: 'host', durationMs: performance.now() - hostStarted })
            const outcome = queue.get(chatId, current.turnId)
            if (outcome) this.memory?.logger.event({ type: 'memory.scheduling', sessionId: chatId, turnId: current.turnId, stage: 'automatic-capture', outcome: outcome.status, reason: outcome.reason })
          }
        }
      } finally {
        if (this.automaticCaptures.get(chatId) === run) this.automaticCaptures.delete(chatId)
        if (!this.isEngineStartBlocked(chatId) && queue.next(chatId)) this.drainAutomaticCaptures(chatId)
      }
    }
    run.task = task()
    void run.task.catch(error => this.reportBackgroundError?.(`[memory-auto-capture-queue] ${String(error)}`))
  }

  private async publishCapturedProposals(outcome: CaptureOutcome, args: PostTurnMemoryPassArgs): Promise<void> {
    if (!outcome.created.length) return
    const autoIds = this.autoApplyProposals(outcome.created, args)
    // Pending (including sensitive) proposals live on the Memory Board. Only
    // applied items get the existing auto card and one-click Revert.
    const autoApplied = outcome.created.filter(({ id }) => autoIds.has(id))
    if (autoApplied.length) {
      await this.store.appendMessage(args.chatId, timestamped({
        kind: "memory_candidates", turn: args.turnNumber,
        // Keep content out of the append-only transcript, including drafts.
        candidates: autoApplied.map(({ id }) => ({ id, auto: true })),
      }))
    }
    this.emitStateChange(args.chatId)
  }

  private async runPostTurnMemoryPasses(
    args: PostTurnMemoryPassArgs,
  ) {
    if (args.memoryState?.memoryActive === false || !this.memory || (!args.userText.trim() && !args.assistantText.trim())) {
      return
    }

    // Capture and trace are INDEPENDENT LLM passes over the same turn text —
    // run them concurrently instead of back-to-back (the serial order doubled
    // post-turn latency for no reason; inline citations are regex-extracted
    // during the turn and never wait on either). Each pass keeps its own
    // error containment.
    const capturePass = async (): Promise<void> => {
      // Review C stays pre-turn. Automatic C learns from this finished turn
      // independently of both the next turn and the concurrent audit.
      if (this.memoryBranches) {
        this.launchAutomaticCapture(args)
        return
      }
      if (!this.capture || args.memoryState?.learnActive === false) return
      try {
        const captureInput = {
          projectId: args.projectId,
          sessionId: args.chatId,
          turn: args.turnNumber,
          engine: args.engine,
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
            runtime: args.engineRuntime ?? this.sessionRuntimes.get(args.chatId),
            sessionToken: args.claudeSessionToken,
            localPath: args.localPath,
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
        await this.publishCapturedProposals(outcome, args)
        return
      } catch (error) {
        this.reportBackgroundError?.(
          `[memory-capture] chat ${args.chatId} turn ${args.turnNumber ?? "?"}: ${error instanceof Error ? error.message : String(error)}`
        )
        return
      }
    }

    const tracePass = async (): Promise<void> => {
      if ((!this.memoryTrace && !this.memoryBranches) || args.memoryDisabled) return
      // Hidden entries still hydrate and feed the Memory Record. Even the
      // pending skeleton stays quiet until a terminal verdict finds a violation.
      const automatic = args.memoryState?.control === "auto"
      try {
        // "Used" = everything in play this turn: the BOOT-TIME injected
        // snapshot plus any extra memories the model cited (e.g. pulled in via
        // search_memory). Memories accepted mid-turn are not in play.
        const usedIds = [...new Set([...args.injectedIds, ...args.citedIds])]
        const injectedById = new Map((args.injectedMemories ?? []).map(item => [item.id, item]))
        const usedMemories = usedIds
          .map((id) => injectedById.get(id) ?? this.memory!.store.getById(id))
          .filter((m): m is MemoryItem => Boolean(m && m.status === "active"))
        if (usedMemories.length) {
          // Publish the pending card before the bounded audit request; its
          // final entry for the same turn supersedes it at hydration.
          await this.store.appendMessage(
            args.chatId,
            timestamped({ kind: "memory_trace", hidden: automatic, turn: args.turnNumber, status: "pending", labels: [] })
          )
          this.emitStateChange(args.chatId)
          const usedById = new Map(usedMemories.map((m) => [m.id, m]))
          const corrections = usedMemories.flatMap(item => this.memory!.store.recentTraceCorrections(item.id, 3))
          // MemoSync always uses a child of the completed conversation. The
          // legacy path below retains its configured fork/sidecar policy.
          let outcome: TraceOutcome | null = null
          let tracedVia: "fork" | "sidecar" = "sidecar"
          if (this.memoryBranches) {
            const provider = args.engine as AgentProvider
            const settings = { ...this.getProviderSettings(provider, { model: args.model, effort: args.effort }), serviceTier: args.serviceTier }
            const branch = this.newMemoryBranch({ chatId: args.chatId, provider, ...settings, engineRuntime: args.engineRuntime }, "audit", args.sessionToken ?? args.claudeSessionToken ?? null, args.parentLaunch, true, args.turnId)
            const auditInput = { usedMemories, corrections, assistantText: args.assistantText, executionText: args.executionText, executionTools: args.executionTools, task: args.userText, expectedUses: args.expectedUses }
            try {
              const raw = await branch.ask(buildAuditBranchPrompt(auditInput), { schema: memoryStageSchema("audit") })
              try {
                outcome = parseAuditBranchResult(raw, auditInput)
              } catch (error) {
                if (!(error instanceof MemoryBranchResultError)) throw error
                const repaired = await branch.ask([
                  `The audit response did not satisfy its required format: ${error.message}`,
                  "Correct only the structured response using the evidence and analysis already in this conversation. Do not inspect more files or run a new analysis.",
                  "Return every supplied memory ID exactly once. not_applicable requires a separate missing field; violated requires cause and impact. Use null for optional fields with no evidence. Never invent a verdict or evidence to fill a field.",
                ].join("\n\n"), { schema: memoryStageSchema("audit"), budget: { maxTurns: 2, maxToolCalls: 0 } })
                outcome = parseAuditBranchResult(repaired, auditInput)
              }
              tracedVia = "fork"
            } finally { branch.dispose() }
          }
          if (
            !this.memoryBranches &&
            args.engine === "claude" &&
            args.claudeSessionToken &&
            args.localPath &&
            process.env.MEMOSYNC_TRACE_FORK !== "0"
          ) {
            const raw = await this.forkTraceFn({
              runtime: args.engineRuntime ?? this.sessionRuntimes.get(args.chatId),
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
              corrections,
            })
          }
          // CAS: the pass judged the text it was SHOWN. A memory the user
          // edited or archived while the LLM ran gets no verdict written
          // anywhere — a health dot for text the judgment never saw is worse
          // than a missing one. Dropped ids also lose their summary citation.
          if (this.isEngineStartBlocked(args.chatId) || !this.store.getChat(args.chatId) || this.store.getChat(args.chatId)?.memoryDisabled || !this.getMemorySettings().enabled) return
          const labels = outcome.labels.filter((l) => {
            const now = this.memory!.store.getById(l.id)
            const snap = usedById.get(l.id)
            return Boolean(now && snap && now.status === "active" && now.version === snap.version && now.content === snap.content && now.detail === snap.detail)
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
                hidden: automatic && !labelsWithSource.some(({ label }) => label === "violated"),
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
              this.memory!.store.recordTraceLabel(l.id, l.label, { actor: "agent", sessionId: args.chatId, turn: args.turnNumber, cited: cited.has(l.id) })
              if (l.label !== "operational" || cited.has(l.id)) continue
              this.memory!.store.recordUse(l.id, { actor: "agent", sessionId: args.chatId, turn: args.turnNumber, via: "trace_operational" })
            }
            this.emitStateChange(args.chatId)

            // Self-evolution M4: with this turn's verdicts recorded, memories
            // whose last K traces all read 'violated' get a drafted REVISION
            // proposal — surfaced through the same review lane as capture
            // candidates. In Ask mode the user ratifies; in delegating/Auto
            // mode the proposal applies immediately with a revert handle.
            if (this.memoryRevision && args.memoryState?.learnActive !== false) {
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
                hidden: automatic,
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
              hidden: automatic,
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
              hidden: automatic,
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
        return
      } catch (error) {
        const errorClass = error instanceof Error ? error.name || "Error" : "Error"
        try {
          await this.store.appendMessage(
            args.chatId,
            timestamped({
              kind: "memory_trace",
              hidden: automatic,
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
        return
      }
    }

    await Promise.all([capturePass(), tracePass()])
    if (this.memoryBranches) return

    const precomputeCheckup = async () => {
      // Checkup precomputation (user decision 2026-08-08, option B): compute
      // the NEXT gate's library checkup now — on the fork when possible (the
      // trajectory informs staleness/conflict judgment), sidecar otherwise —
      // so the next send can reuse the result and Step 2 renders instantly.
      // Runs AFTER capture (its reinforce bumps are part of the dependency
      // key). Partial by design: acceptances at the next gate's Step 1 change
      // the library and still trigger a live recompute there.
      // MEMOSYNC_CHECKUP_FORK=0 skips the fork leg (sidecar still runs).
      if (args.memoryState?.learnActive !== false && this.memoryCheckup) {
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
            runtime: args.engineRuntime ?? this.sessionRuntimes.get(args.chatId),
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
      if (args.memoryState?.learnActive !== false && this.memoryTransferDetect) {
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

  private readonly stableToolSchemas: NonNullable<AgentCoordinatorArgs["stableToolSchemas"]>
  private readonly contextBaselines = new Map<string, ContextBaseline>()
  private readonly contextGenerations = new Map<string, number>()
  private readonly contextEpochs = new Map<string, { session: string; epoch: number }>()
  private readonly commandRegistry = new CommandRegistry(chatId => this.emitStateChange(chatId))
  private readonly commandPreparations = new Map<string, CommandPreparation>()
  private readonly commandSelections = new Map<string, RuntimeCommandSelection>()

  getCommandCatalog(chatId: string): ChatCommandCatalog {
    const chat = this.store.getChat(chatId)
    const runtime = this.sessionRuntimes.get(chatId)
    const preparation = this.commandPreparations.get(chatId)
    const selection = preparation?.selection ?? this.commandSelections.get(chatId)
    const provider = selection?.provider ?? chat?.provider
    const describe = (snapshot: ChatCommandCatalog): ChatCommandCatalog => ({ ...snapshot,
      ...(selection ? { selection, selectionKey: runtimeCommandSelectionKey(selection) } : {}),
      ...(preparation ? { preparation: { status: preparation.status, message: preparation.message } } : {}),
    })
    const claude = this.claudeSessions.get(chatId)
    const native = provider === 'claude' ? (!claude?.retired ? claude?.session.commandRuntime : undefined)
      : provider === 'pi' ? this.piManager.getCommandRuntime?.(chatId)
      : provider === 'opencode' ? this.opencodeManager.getCommandRuntime?.(chatId)
      : provider === 'codex' ? this.codexManager.getCommandRuntime?.(chatId) : undefined
    const project = chat ? this.store.getProject(chat.projectId) : undefined
    if (!chat || !provider || !project || !native || !native.alive() || (preparation && preparation.status !== 'ready')) {
      this.commandRegistry.unbind(chatId)
      return describe(this.commandRegistry.snapshot(chatId))
    }
    const policy = this.getHarnessSnapshot(chatId, provider)?.policy
    this.commandRegistry.bind(chatId, {
      identity: { engine: provider, nativeInstance: native.instance, nativeSession: native.session,
        policyRevision: policy?.effectiveRevision ?? 0, desiredPolicyRevision: policy?.desiredRevision ?? 1,
        version: native.version, profile: native.profile ?? contextIdentity({ isolated: runtime?.isolated,
          home: runtime?.env.HOME, claude: runtime?.env.CLAUDE_CONFIG_DIR, codex: runtime?.env.CODEX_HOME, xdg: runtime?.env.XDG_CONFIG_HOME }),
        workspace: project.localPath, mode: contextIdentity({ selection, planMode: selection?.planMode ?? chat.planMode, model: runtime?.model, connection: runtime?.connectionId, memoryDisabled: chat.memoryDisabled }) },
      native, busy: () => this.idleCloseBlocked(chatId),
      restoreText: () => this.prepareCurrentContext(chatId, { nativeSession: native.session, nativeInstance: native.instance, version: native.version }).text,
      contextAccepted: () => this.prepareCurrentContext(chatId, { nativeSession: native.session, nativeInstance: native.instance, version: native.version }).accepted(),
      invalidateContext: () => this.invalidateNativeContext(chatId),
      submit: (entry, args, hostClientId) => this.send({ type: 'chat.send', chatId, content: `${entry.nativeSkill ? `$${entry.nativeSkill.name}` : `/${entry.name}`}${args ? ` ${args}` : ''}`,
        provider, model: selection?.model ?? runtime?.model, modelOptions: selection?.modelOptions ?? (runtime?.connectionId ? { connectionId: runtime.connectionId } : undefined), planMode: selection?.planMode ?? chat.planMode }, hostClientId, entry),
    })
    const snapshot = this.commandRegistry.snapshot(chatId)
    if (runtime) snapshot.connectors.items.push({ id: `model:${runtime.connectionId ?? runtime.engine}`, name: runtime.model, kind: 'model-provider',
      state: 'discovered', source: { api: 'EngineRuntime (configured; authentication not probed)', version: native.version, evidence: 'host-config' } })
    return describe(snapshot)
  }

  async readCommandCatalog(chatId: string, refresh = false, selection?: RuntimeCommandSelection) {
    const chat = this.store.requireChat(chatId)
    if (selection !== undefined) {
      if (!isRuntimeCommandSelection(selection)) throw new Error('Invalid command runtime selection')
      if (chat.provider && chat.provider !== selection.provider) throw new Error('Command engine does not match the chat')
      this.prepareCommandSession(chatId, selection, refresh)
    }
    const snapshot = this.getCommandCatalog(chatId)
    if (snapshot.preparation?.status !== 'preparing' && (refresh || snapshot.commands.status === 'unknown')) await this.commandRegistry.refresh(chatId)
    return this.getCommandCatalog(chatId)
  }

  private commandMemoryKey(chatId: string) {
    const chat = this.store.requireChat(chatId)
    return contextIdentity({ memoryDisabled: chat.memoryDisabled, settings: this.getMemorySettings() })
  }

  private prepareCommandSession(chatId: string, selection: RuntimeCommandSelection, retry: boolean) {
    if (this.isEngineStartBlocked(chatId)) return
    const key = runtimeCommandSelectionKey(selection)
    const policyRevision = this.executionPolicyFor(chatId, selection.provider).revision
    const accessRevision = getModelAccessService()?.revision
    const memoryKey = this.commandMemoryKey(chatId)
    const previous = this.commandPreparations.get(chatId)
    const same = previous?.key === key && previous.policyRevision === policyRevision && previous.accessRevision === accessRevision && previous.memoryKey === memoryKey
    if (same && (previous.status === 'preparing' || (previous.status === 'ready' && this.getCommandCatalog(chatId).runtime) || (previous.status === 'error' && !retry))) return
    // A composer edit cannot rebuild a runtime that owns an ordinary turn or a native operation.
    const commandStartup = previous && (previous.status === 'preparing' || this.engineStartAbortControllers.get(chatId) === previous.controller)
    if (this.idleCloseBlocked(chatId) && !commandStartup) return
    if (this.activeTurns.has(chatId) || this.startingChats.has(chatId) || this.commandRegistry.isRunning(chatId)) return
    if (!previous && this.commandSelections.get(chatId) && runtimeCommandSelectionKey(this.commandSelections.get(chatId)!) === key && this.getCommandCatalog(chatId).runtime) return
    previous?.controller.abort()
    this.commandRegistry.unbind(chatId)
    this.commandSelections.set(chatId, structuredClone(selection))
    const record: CommandPreparation = { selection: structuredClone(selection), key, policyRevision, accessRevision, memoryKey,
      controller: new AbortController(), promise: Promise.resolve(), status: 'preparing' }
    this.commandPreparations.set(chatId, record)
    this.cancelIdleClose(chatId)
    record.promise = (async () => {
      // The old initializer must finish closing its handles before its replacement can publish.
      await previous?.promise
      if (record.controller.signal.aborted || this.commandPreparations.get(chatId) !== record) return
      this.engineStartAbortControllers.set(chatId, record.controller)
      try {
        await this.retireCommandSession(chatId)
        record.controller.signal.throwIfAborted()
        await this.initializeCommandSession(chatId, record)
        record.controller.signal.throwIfAborted()
        if (this.commandPreparations.get(chatId) !== record) return
        record.status = 'ready'
        this.getCommandCatalog(chatId)
        void this.commandRegistry.refresh(chatId).catch(() => {})
      } catch (error) {
        if (!record.controller.signal.aborted && this.commandPreparations.get(chatId) === record) {
          record.status = 'error'
          // Only stable model-access codes (e.g. account-signed-out) reach the UI; raw native errors may hold private data.
          const code = error instanceof Error && PREPARATION_ERROR_CODES.has(error.message) ? error.message : ''
          record.message = code || 'Native session initialization failed. Check the selected model connection and retry.'
        }
        await this.retireCommandSession(chatId).catch(() => {})
      } finally {
        if (this.engineStartAbortControllers.get(chatId) === record.controller) this.engineStartAbortControllers.delete(chatId)
        this.emitStateChange(chatId)
      }
    })()
    this.emitStateChange(chatId)
  }

  private async settleCommandPreparation(args: StartTurnArgs) {
    const prepared = this.commandPreparations.get(args.chatId)
    if (!prepared) return
    const desired = this.getProviderSettings(prepared.selection.provider, prepared.selection)
    const same = prepared.selection.provider === args.provider && desired.model === args.model && desired.connectionId === args.connectionId
      && desired.effort === args.effort && desired.serviceTier === args.serviceTier && desired.planMode === args.planMode
      && prepared.policyRevision === this.executionPolicyFor(args.chatId, args.provider).revision
      && prepared.accessRevision === getModelAccessService()?.revision && prepared.memoryKey === this.commandMemoryKey(args.chatId)
    if (same) await prepared.promise
    else {
      await this.cancelCommandPreparation(args.chatId)
      await this.retireCommandSession(args.chatId)
    }
    if ((!same || prepared.status === 'error') && this.commandPreparations.get(args.chatId) === prepared) this.commandPreparations.delete(args.chatId)
  }

  private cancelCommandPreparation(chatId: string) {
    const record = this.commandPreparations.get(chatId)
    if (!record) return
    record.controller.abort()
    record.status = 'error'
    record.message = 'Native session preparation was cancelled. Refresh to retry.'
    this.commandRegistry.unbind(chatId)
    return record.promise
  }

  private async retireCommandSession(chatId: string) {
    await this.codexManager.stopSession?.(chatId)
    this.piManager.closeChat?.(chatId)
    this.opencodeManager.closeChat?.(chatId)
    const session = this.claudeSessions.get(chatId)
    if (session && !session.retired) await this.retireClaudeSession(session, 'session_rebuild')
  }

  private async initializeCommandSession(chatId: string, record: CommandPreparation) {
    const chat = this.store.requireChat(chatId)
    const project = this.store.getProject(chat.projectId)
    if (!project) throw new Error('Project not found')
    const { selection, controller } = record
    const signal = controller.signal
    const settings = this.getProviderSettings(selection.provider, selection)
    let runtime: EngineRuntime | undefined
    const runtimeKey = JSON.stringify([selection.provider, settings.model, settings.connectionId, getModelAccessService()?.revision])
    if (!(selection.provider === 'pi' && this.hasCustomPiConnection)) {
      runtime = this.runtimeSelections.get(chatId) === runtimeKey ? this.sessionRuntimes.get(chatId) : undefined
      runtime ??= await resolveEngineRuntime({ engine: selection.provider, model: settings.model, connectionId: settings.connectionId })
      signal.throwIfAborted()
      this.sessionRuntimes.set(chatId, runtime)
      this.runtimeSelections.set(chatId, runtimeKey)
    }
    await ensureProjectDirectory(project.localPath)
    signal.throwIfAborted()
    const memoryState = resolveTurnMemoryState(this.getMemorySettings(), chat.memoryDisabled)
    const memoryEnabled = memoryState.memoryActive
    const memorySpecs = this.memory ? buildMemoryToolSpecs(this.memory, { capture: memoryState.learnActive ? this.capture : null }) : []
    const specs = [...memorySpecs, ...(this.hostActions ? hostActionToolSpecs() : [])]
    const { policy, revision } = this.executionPolicyFor(chatId, selection.provider)
    this.harnessPolicies.ensure(chatId, policy, revision, chat.executionPolicyStates?.[selection.provider])
    const scope = this.harnessPolicies.beginTurn(chatId, policy, revision, `command-preparation:${crypto.randomUUID()}`,
      this.harnessRuntimeVersion(selection.provider, runtime?.executable.version))
    const isCurrent = () => !signal.aborted && this.commandPreparations.get(chatId) === record && !this.policyChanges.has(chatId)
      && record.accessRevision === getModelAccessService()?.revision && record.memoryKey === this.commandMemoryKey(chatId) && this.harnessPolicies.isCurrent(scope)
    const applied = async (sessionID?: string) => {
      if (!isCurrent()) throw new Error('Stale command preparation')
      const choice = this.harnessPolicies.registry.snapshot(selection.provider, this.harnessRuntimeVersion(selection.provider, runtime?.executable.version))
        .executionPolicies.find(c => executionPolicyKey(c.policy) === executionPolicyKey(policy))
      if (choice?.availability === 'available') {
        const state = this.harnessPolicies.applied(scope, sessionID)
        if (state) await this.store.setExecutionPolicyState?.(chatId, state)
      }
    }
    const sessionToken = chat.pendingForkSessionToken ?? chat.sessionToken
    let preparedToken: string | null | undefined
    if (selection.provider === 'claude') {
      const session = await this.startClaudeTurn({ engineRuntime: runtime, chatId, localPath: project.localPath, model: settings.model,
        effort: settings.effort, planMode: settings.planMode, sessionToken, forkSession: Boolean(chat.pendingForkSessionToken),
        projectId: chat.projectId, memoryEnabled, learnEnabled: memoryState.learnActive,
        signal, onToolRequest: async () => ({ cancelled: true }),
        executionControl: { permissionMode: policy.engine === 'claude' ? policy.permissionMode : 'default', isCurrent,
          canUseMemory: () => false, approve: async () => false, onToolRequest: async () => ({ cancelled: true }), onApplied: () => applied() },
      })
      if (!session) throw new Error('Command preparation cancelled')
      const handle = this.claudeSessions.get(chatId)!.session
      const onAbort = () => handle.close()
      signal.addEventListener('abort', onAbort, { once: true })
      try { signal.throwIfAborted(); await handle.initialize?.(); signal.throwIfAborted() }
      finally { signal.removeEventListener('abort', onAbort) }
    } else if (selection.provider === 'codex') {
      preparedToken = await this.codexManager.startSession({ chatId, cwd: project.localPath, model: settings.model, serviceTier: settings.serviceTier,
        runtime, signal, sessionToken: chat.sessionToken, pendingForkSessionToken: chat.pendingForkSessionToken,
        dynamicTools: specs.length ? toCodexDynamicTools(specs) : undefined,
        executionPolicy: chat.executionPolicyVersion && policy.engine === 'codex' ? policy : undefined })
      if (chat.executionPolicyVersion) await applied(preparedToken ?? undefined)
    } else if (selection.provider === 'pi') {
      const connection = runtime?.piConnection ?? await this.resolvePiConnectionFn()
      signal.throwIfAborted()
      preparedToken = await this.piManager.prepareSession({ chatId, cwd: project.localPath, model: runtime?.model ?? settings.model,
        effort: normalizePiModelOptions(undefined, settings.effort).reasoningEffort, connection, signal, sessionToken,
        forkSession: Boolean(chat.pendingForkSessionToken), memorySpecs: specs.length ? specs : undefined,
        beforeToolCall: async () => ({ block: true, reason: 'No active model turn' }), isPolicyCurrent: isCurrent })
    } else {
      preparedToken = await this.opencodeManager.prepareSession({ chatId, cwd: project.localPath, model: runtime?.model ?? settings.model,
        runtime, signal, sessionToken, forkSession: Boolean(chat.pendingForkSessionToken), memorySpecs: specs.length ? specs : undefined,
        executionPolicy: chat.executionPolicyVersion && policy.engine === 'opencode' ? policy : undefined,
        isPolicyCurrent: isCurrent, onExecutionPolicyApplied: applied })
    }
    signal.throwIfAborted()
    if (!isCurrent()) throw new Error('Stale command preparation')
    if (preparedToken) {
      await this.store.setSessionToken(chatId, preparedToken)
      if (chat.pendingForkSessionToken) await this.store.setPendingForkSessionToken(chatId, null)
    }
  }

  async executeCommand(command: ExecuteRuntimeCommand, hostClientId?: string) {
    const chat = this.store.requireChat(command.chatId)
    this.getCommandCatalog(command.chatId)
    this.cancelIdleClose(command.chatId)
    // A command run from the landing page opens that chat, so its output must have somewhere to show.
    if (chat.draft) {
      await this.store.promoteDraft(command.chatId)
      this.emitStateChange()
    }
    return await this.commandRegistry.execute(command, hostClientId) as { chatId: string; operationId?: string }
  }

  async cancelCommand(chatId: string, operationId: string) { await this.commandRegistry.cancel(chatId, operationId) }

  private invalidateNativeContext(chatId: string) {
    this.contextGenerations.set(chatId, (this.contextGenerations.get(chatId) ?? 0) + 1)
    this.contextBaselines.delete(chatId)
    const session = this.claudeSessions.get(chatId)
    if (session?.memoryBaseline) session.memoryBaseline = new Map()
  }

  /** Build against the admitted memory view; compilation alone never advances native delivery. */
  private prepareCurrentContext(chatId: string, target: NativeContextTarget, options: {
    plan?: MemoryInjectionPlan | null; disabled?: boolean; tools?: readonly StableToolSchema[]
  } = {}): PreparedNativeContext {
    const chat = this.store.requireChat(chatId)
    const restriction = this.turnMemoryRestriction.get(chatId)
    const disabled = options.disabled ?? (chat.memoryDisabled || !this.getMemorySettings().enabled)
    const plan = options.plan !== undefined ? options.plan : this.memory && !disabled
      ? planMemoryInjection({ memory: this.memory, projectId: chat.projectId, chatId, restrictToIds: restriction }) : null
    const memories = disabled ? [] : (plan?.injectedMemories ?? []).map(m => ({ id: m.id, version: m.version, content: m.content, scope: m.scope,
      semantics: { signature: plan?.view.signatures[m.id], hasDetail: Boolean(m.detail), type: m.type } }))
    const launch = this.parentLaunches.get(chatId)
    const declarations = launch?.provider === 'codex' ? launch.session.dynamicTools ?? []
      : toCodexDynamicTools(launch?.provider === 'claude' ? launch.memorySpecs : launch?.options.memorySpecs ?? [])
    const declaredTools = options.tools ?? declarations.map(tool => ({ name: tool.name, description: tool.description, schema: tool.inputSchema }))
    const hostTools = this.stableToolSchemas({ chatId, engine: chat.provider ?? 'claude' })
    // Memory/learn switches change eligibility, not the stable schema inventory.
    const memoryTools = this.memory ? toCodexDynamicTools(buildMemoryToolSpecs(this.memory, { capture: this.capture }))
      .map(tool => ({ name: tool.name, description: tool.description, schema: tool.inputSchema })) : []
    const tools = [...memoryTools, ...hostTools]
    const availableHostTools = [...(disabled ? [] : declaredTools.map(tool => tool.name)), ...hostTools.map(tool => tool.name)].sort()
    if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error('Duplicate stable tool declaration')
    const policy = this.getHarnessSnapshot(chatId)?.policy
    const runtime = this.sessionRuntimes.get(chatId)
    const catalog = this.commandRegistry.snapshot(chatId)
    const nativeCapabilities = catalog.runtime?.nativeSession === target.nativeSession && catalog.runtime.nativeInstance === target.nativeInstance
      ? { commands: catalog.commands, skills: catalog.skills, connectors: catalog.connectors } : null
    const runtimeIdentity = { engine: chat.provider, ...target, workspace: this.store.getProject(chat.projectId)?.localPath,
      profile: contextIdentity({ isolated: runtime?.isolated, home: runtime?.env.HOME, claude: runtime?.env.CLAUDE_CONFIG_DIR, codex: runtime?.env.CODEX_HOME, xdg: runtime?.env.XDG_CONFIG_HOME }),
      model: runtime?.model, planMode: chat.planMode, nativeCapabilities, availableHostTools,
      policy: { effectiveRevision: policy?.effectiveRevision ?? 0, desiredRevision: policy?.desiredRevision ?? 1, effective: policy?.effective ?? null, status: policy?.status ?? 'pending' } }
    const generation = this.contextGenerations.get(chatId) ?? 0
    const previous = this.contextBaselines.get(chatId)
    const oldEpoch = this.contextEpochs.get(chatId)
    const epoch = oldEpoch?.session === target.nativeSession ? oldEpoch.epoch : (oldEpoch?.epoch ?? -1) + 1
    this.contextEpochs.set(chatId, { session: target.nativeSession, epoch })
    // A different native thread starts with a full view. It may be a fork/resume: do not assert history erasure.
    const baseline = previous?.nativeSession === target.nativeSession ? previous : undefined
    const compiled = compileContext({ epoch, nativeSession: target.nativeSession, runtimeIdentity,
      capabilityRevision: contextIdentity(tools), policyRevision: policy?.effectiveRevision ?? 0, tools,
      view: { revision: disabled ? contextIdentity({ disabled: true }) : plan?.view.revision ?? contextIdentity([]),
        selectionRevision: contextIdentity(memories.map(m => m.id)), memories } }, baseline)
    return { text: renderCompiledContext(compiled, !baseline), accepted: () => {
      // A stale native receipt cannot overwrite a newer accepted baseline or a compact invalidation.
      if ((this.contextGenerations.get(chatId) ?? 0) === generation && this.contextBaselines.get(chatId) === previous && this.contextEpochs.get(chatId)?.session === target.nativeSession) {
        this.contextBaselines.set(chatId, compiled.nextBaseline)
      }
    } }
  }

  getActiveStatuses() {
    const statuses = new Map<string, ChatActivityStatus>()
    // Reservation phase first; a booted ActiveTurn (mutually exclusive by
    // invariant, but defensive) wins.
    for (const [chatId, status] of this.startingChats.entries()) {
      statuses.set(chatId, status)
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

  private cancelIdleClose(chatId: string) {
    const timer = this.idleCloseTimers.get(chatId)
    if (timer) clearTimeout(timer)
    this.idleCloseTimers.delete(chatId)
  }

  private hasIdleSession(chatId: string) {
    const claude = this.claudeSessions.get(chatId)
    return Boolean((claude && !claude.retired) || this.codexManager.hasSession?.(chatId) || this.opencodeManager.hasSession?.(chatId) || this.piManager.getCommandRuntime?.(chatId)?.alive())
  }

  private idleCloseBlocked(chatId: string) {
    return this.commandRegistry.isRunning(chatId) || this.activeTurns.has(chatId) || this.startingChats.has(chatId)
      || this.startupReservations.has(chatId) || this.engineStartAbortControllers.has(chatId)
      || this.drainingStreams.has(chatId)
      || this.pendingPreviews.has(chatId) || this.pendingProposalGates.has(chatId)
      || this.pendingTransferGates.has(chatId) || this.pendingCheckupGates.has(chatId)
      || this.activePreparations.has(chatId) || this.inFlightCheckups.has(chatId)
      || this.claimedPreviewResponses.has(chatId) || (this.memoryWork.get(chatId) ?? 0) > 0
      || this.store.getQueuedMessages(chatId).length > 0
      || Boolean(this.claudeSessions.get(chatId)?.pendingPrompts.some(prompt =>
        !this.claudeSessions.get(chatId)!.cancelledPromptSeqs.has(prompt.seq)))
      || Boolean(this.codexManager.hasPendingWork?.(chatId))
      || Boolean(this.opencodeManager.hasPendingWork?.(chatId))
  }

  /** All work must be settled for a full 30 minutes, including detached memory passes. */
  private updateIdleClose(chatId: string) {
    if (this.runtimeStopping || this.closedChats.has(chatId) || !this.hasIdleSession(chatId) || this.idleCloseBlocked(chatId)) {
      this.cancelIdleClose(chatId)
      return
    }
    if (this.idleCloseTimers.has(chatId)) return
    const timer = setTimeout(() => {
      if (this.idleCloseTimers.get(chatId) !== timer) return
      this.idleCloseTimers.delete(chatId)
      void this.closeIdleSession(chatId).catch(error => {
        this.reportBackgroundError?.(`[idle-session] chat ${chatId}: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, IDLE_SESSION_TIMEOUT_MS)
    timer.unref?.()
    this.idleCloseTimers.set(chatId, timer)
  }

  private async closeIdleSession(chatId: string) {
    if (this.runtimeStopping || this.closedChats.has(chatId) || this.idleCloseBlocked(chatId)) return
    // No await between checking and retiring: a concurrent send either owns
    // the startup reservation or sees a retired Query and waits for its pump.
    this.commandRegistry.unbind(chatId)
    this.commandPreparations.delete(chatId)
    this.codexManager.stopSession(chatId)
    this.piManager.closeChat(chatId)
    this.opencodeManager.closeChat(chatId)
    const session = this.claudeSessions.get(chatId)
    if (session && !session.retired) await this.retireClaudeSession(session, "idle_timeout")
    await this.retireHarnessPolicyIfAbsent(chatId)
    this.emitStateChange(chatId)
  }

  /** Count underlying work, not the cancellation race that may finish before it. */
  private async trackMemoryWork<T>(chatId: string, work: () => Promise<T>): Promise<T> {
    this.memoryWork.set(chatId, (this.memoryWork.get(chatId) ?? 0) + 1)
    this.cancelIdleClose(chatId)
    try {
      return await work()
    } finally {
      const remaining = (this.memoryWork.get(chatId) ?? 1) - 1
      if (remaining) this.memoryWork.set(chatId, remaining)
      else this.memoryWork.delete(chatId)
      this.updateIdleClose(chatId)
    }
  }

  private emitStateChange(chatId?: string, options?: { immediate?: boolean }) {
    if (chatId) this.updateIdleClose(chatId)
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

  private abortEngineStart(chatId: string) {
    this.engineStartAbortControllers.get(chatId)?.abort()
    void this.cancelCommandPreparation(chatId)
  }

  private reserveStartup(args: StartTurnArgs, status: ChatActivityStatus = "starting") {
    this.cancelIdleClose(args.chatId)
    const reservation = args.startupReservation ?? { cancelled: false }
    const previous = this.startupReservations.get(args.chatId)
    if (previous && previous !== reservation) previous.superseded = true
    reservation.startupSettled = false
    args.startupReservation = reservation
    this.startupReservations.set(args.chatId, reservation)
    this.startingChats.set(args.chatId, status)
    return reservation
  }

  private releaseStartupStatus(chatId: string, reservation?: StartupReservation) {
    if (!reservation || this.startupReservations.get(chatId) !== reservation) return
    if (reservation.cancellationPending && !reservation.cancellationComplete) return
    this.startingChats.delete(chatId)
  }

  private settleStartupReservation(chatId: string, reservation?: StartupReservation) {
    if (!reservation) return
    reservation.startupSettled = true
    this.releaseStartupStatus(chatId, reservation)
    if (this.startupReservations.get(chatId) !== reservation) return
    if (reservation.cancellationPending && !reservation.cancellationComplete) return
    if (
      this.hasPendingPreviewActivity(chatId)
      || this.activePreparations.get(chatId)?.args.startupReservation === reservation
    ) return
    this.startupReservations.delete(chatId)
    this.updateIdleClose(chatId)
    if (reservation.cancelled && !this.isEngineStartBlocked(chatId)
      && !this.activeTurns.has(chatId) && !this.startingChats.has(chatId)) {
      void this.maybeStartNextQueuedMessage(chatId).catch((error) => {
        this.reportBackgroundError?.(
          `[startup-cancel] chat ${chatId}: could not drain queued messages: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
    }
  }

  private startupReservationIsCurrent(chatId: string, reservation?: StartupReservation) {
    if (!reservation) return !this.startupReservations.has(chatId) && !this.isEngineStartBlocked(chatId)
    return !reservation.cancelled
      && !reservation.superseded
      && this.startupReservations.get(chatId) === reservation
      && !this.isEngineStartBlocked(chatId)
  }

  private cancelStartupReservation(chatId: string, reservation: StartupReservation) {
    reservation.cancelled = true
    reservation.cancellationPending = true
    reservation.controller?.abort()
    this.releaseStartupStatus(chatId, reservation)
  }

  private canStopStartupSession(chatId: string, reservation?: StartupReservation) {
    const currentReservation = this.startupReservations.get(chatId)
    const active = this.activeTurns.get(chatId)
    if (!reservation) return !currentReservation && !active
    return !reservation.superseded
      && currentReservation === reservation
      && (!active || active.startupReservation === reservation)
  }

  private recordStartupCancellation(
    chatId: string,
    reservation: StartupReservation,
    hidden?: boolean,
  ) {
    if (reservation.cancellation) return reservation.cancellation
    reservation.cancellationPending = true
    const promptWrite = reservation.promptWrite
    reservation.cancellation = (async () => {
      try {
        await promptWrite?.catch(() => {})
        await this.store.appendMessage(chatId, timestamped({ kind: "interrupted", hidden }))
        await this.store.recordTurnCancelled(chatId)
        this.emitStateChange(chatId, { immediate: true })
      } finally {
        reservation.cancellationComplete = true
        this.releaseStartupStatus(chatId, reservation)
        if (reservation.startupSettled) this.settleStartupReservation(chatId, reservation)
      }
    })()
    return reservation.cancellation
  }

  private isEngineStartBlocked(chatId: string) {
    return this.runtimeStopping || this.closedChats.has(chatId) || this.policyChanges.has(chatId)
  }

  async discardDraft(chatId: string) {
    // Claim the discard before closing handles. A concurrent send that promoted
    // first makes this a no-op, so its real session cannot be cancelled here.
    const discarded = await this.store.discardDraft(chatId)
    if (discarded) await this.closeChat(chatId)
  }

  async closeChat(chatId: string) {
    this.hostActions?.revokeChat(chatId, "Chat closed")
    this.commandRegistry.unbind(chatId)
    this.endPolicyTurn(chatId)
    this.cancelIdleClose(chatId)
    this.closedChats.add(chatId)
    this.cancelAutomaticCapture(chatId)
    this.cancelAudits(chatId)
    this.disposeMemoryBranches(chatId)
    const commandPreparation = this.commandPreparations.get(chatId)?.promise
    this.abortEngineStart(chatId)
    const reservation = this.startupReservations.get(chatId)
    if (reservation) {
      reservation.cancelled = true
      reservation.superseded = true
      reservation.controller?.abort()
      this.startingChats.delete(chatId)
      this.startupReservations.delete(chatId)
    }
    this.cancelledDuringPreview.delete(chatId)
    await this.codexManager.stopSession(chatId)
    await this.stopDraining(chatId)
    this.piManager.closeChat(chatId)
    this.opencodeManager.closeChat(chatId)
    this.parentLaunches.delete(chatId)
    this.sessionRuntimes.delete(chatId)
    this.runtimeSelections.delete(chatId)
    await commandPreparation
    this.commandPreparations.delete(chatId)
    this.commandSelections.delete(chatId)
    const claudeSession = this.claudeSessions.get(chatId)
    if (claudeSession) {
      await this.retireClaudeSession(claudeSession, "chat_closed")
    }
    await this.retireHarnessPolicyIfAbsent(chatId)
    this.emitStateChange(chatId)
  }

  invalidateMemoryGate(input: { kind: "transfer" | "checkup"; chatId: string; gateId: string }) {
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
  async shutdownRuntime() {
    this.commandRegistry.dispose()
    this.runtimeStopping = true
    const commandPreparations = [...this.commandPreparations.values()].map(record => record.promise)
    for (const chatId of this.commandPreparations.keys()) this.cancelCommandPreparation(chatId)
    for (const chatId of this.auditBranches.keys()) this.cancelAudits(chatId)
    for (const chatId of this.idleCloseTimers.keys()) this.cancelIdleClose(chatId)
    const captureTasks = [...this.automaticCaptures.values()].flatMap(run => run.task ? [run.task] : [])
    for (const chatId of this.automaticCaptures.keys()) this.cancelAutomaticCapture(chatId, 'server-shutdown', true)
    await Promise.allSettled(captureTasks)
    this.captureLaunches.clear()
    for (const controller of this.engineStartAbortControllers.values()) controller.abort()
    const codexCleanup = this.codexManager.stopAll()
    for (const chatId of new Set([...this.branchPreparations.keys(), ...this.workingBranches.keys()])) this.disposeMemoryBranches(chatId)
    this.piManager.dispose()
    await Promise.allSettled([...this.branchCleanups])
    await this.opencodeManager.dispose()
    await Promise.allSettled(commandPreparations)
    this.commandPreparations.clear()
    this.commandSelections.clear()
    this.sessionRuntimes.clear()
    this.runtimeSelections.clear()
    await Promise.all([
      codexCleanup,
      ...[...this.claudeSessions.values()].map((session) => this.retireClaudeSession(session, "server_shutdown")),
    ])
  }

  /** Shutdown safety net: a cancel() that fails while persisting the
   * interruption can leave its provider turn unclosed. Close everything that
   * is still live so the data-directory lock is not released over an active
   * writer. */
  async forceStopAllTurns() {
    const errors: unknown[] = []
    const attempt = async (action: () => void | Promise<void>) => {
      try {
        await action()
      } catch (error) {
        errors.push(error)
      }
    }
    for (const [chatId, active] of [...this.activeTurns.entries()]) {
      // interrupt() may never settle; bound it so a hung turn cannot stall
      // close(), the remaining turns, or the data-lock release.
      await attempt(() => interruptTurnWithTimeout(active.turn))
      await attempt(() => active.turn.close())
      if (this.activeTurns.get(chatId) === active) this.activeTurns.delete(chatId)
    }
    for (const [chatId, draining] of [...this.drainingStreams.entries()]) {
      await attempt(() => draining.turn.close())
      if (this.drainingStreams.get(chatId) === draining) this.drainingStreams.delete(chatId)
    }
    for (const session of this.claudeSessions.values()) {
      await attempt(() => session.session.close())
    }
    await attempt(() => this.codexManager.stopAll())
    await attempt(() => this.opencodeManager.dispose())
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) {
      throw new AggregateError(errors, "Failed to stop remaining agent turns")
    }
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
    const connectionId = options.modelOptions?.connectionId ?? (provider === "opencode" ? undefined : options.modelOptions?.[provider]?.connectionId)
    const access = getModelAccessService()?.setup(provider).access
    const modelConnectionId = connectionId ?? (access?.mode === "connection" ? access.connectionId : undefined)
    if (provider === "claude") {
      const model = connectionId && options.model ? options.model : normalizeServerModel(provider, options.model)
      const modelOptions = normalizeClaudeModelOptions(model, options.modelOptions, options.effort)
      const entry = deployedProviders().find(provider => provider.id === "claude")?.models.find(option => option.id === model && (modelConnectionId ? option.connectionId === modelConnectionId : !option.connectionId))
      return {
        connectionId,
        // An account's models are the CLI's own ids. Adding [1m] to one asks for a
        // window its list didn't offer.
        model: !modelConnectionId && entry && !entry.contextWindowOptions?.length
          ? model
          : resolveClaudeApiModelId(model, modelOptions.contextWindow),
        // Carried as the effort value so changing it rebuilds the session, as any effort change does.
        effort: modelOptions.ultracode && entry?.reasoningEfforts?.includes("xhigh") ? "ultracode" : resolveModelReasoningEffort(entry, modelOptions.reasoningEffort),
        serviceTier: undefined,
        planMode: catalog.supportsPlanMode ? Boolean(options.planMode) : false,
      }
    }

    if (provider === "opencode") {
      return { connectionId, model: options.model?.trim() || normalizeServerModel(provider), effort: undefined, serviceTier: undefined, planMode: false }
    }
    if (provider === "pi") {
      const piModelOptions = normalizePiModelOptions(options.modelOptions, options.effort)
      return {
        connectionId,
        model: connectionId && options.model ? options.model : normalizeServerModel(provider, options.model),
        effort: piModelOptions.reasoningEffort,
        serviceTier: undefined,
        planMode: false,
      }
    }

    const modelOptions = normalizeCodexModelOptions(options.modelOptions, options.effort)
    const model = connectionId && options.model ? options.model : normalizeServerModel(provider, options.model)
    const entry = deployedProviders().find(provider => provider.id === "codex")?.models.find(option => option.id === model && (modelConnectionId ? option.connectionId === modelConnectionId : !option.connectionId))
    return {
      connectionId,
      model,
      effort: resolveModelReasoningEffort(entry, modelOptions.reasoningEffort),
      serviceTier: codexServiceTierFromModelOptions(modelOptions),
      planMode: catalog.supportsPlanMode ? Boolean(options.planMode) : false,
    }
  }

  private async enqueueMessage(
    chatId: string,
    content: string,
    attachments: ChatAttachment[],
    options?: SendMessageOptions,
    channel: "chat.send" | "message.enqueue" = "chat.send",
  ) {
    if (content.trimStart().startsWith('/')) throw new Error('Native commands require an idle session and its current command catalog')
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
    },
  ): Promise<"started" | "cancelled" | "missing"> {
    if (!this.store.getQueuedMessage(chatId, queuedMessage.id)) return "missing"
    if (this.isCancelledQueueRow(chatId, queuedMessage.id)) {
      try {
        await this.store.removeQueuedMessage(chatId, queuedMessage.id)
      } catch (error) {
        if (this.store.getQueuedMessage(chatId, queuedMessage.id)) {
          this.reportBackgroundError?.(
            `[queue-dispatch] chat ${chatId}: refused tombstoned queue row: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
      return "cancelled"
    }
    if (queuedMessage.content.trimStart().startsWith('/')) throw new Error('Queued native commands must be resubmitted through the current command catalog')
    try {
      await this.store.removeQueuedMessage(chatId, queuedMessage.id)
    } catch (error) {
      // An external queue action can remove the observed head between the
      // scheduler's read and this durable dequeue. Re-read and let the caller
      // continue with the new head instead of treating that race as a failed
      // user send.
      if (!this.store.getQueuedMessage(chatId, queuedMessage.id)) return "missing"
      throw error
    }
    const chat = this.store.requireChat(chatId)
    const provider = this.resolveProvider(queuedMessage, chat.provider)
    const settings = this.getProviderSettings(provider, queuedMessage)
    this.commandSelections.set(chatId, { provider, model: queuedMessage.model, modelOptions: queuedMessage.modelOptions, planMode: queuedMessage.planMode })
    await this.startTurnForChat({
      chatId,
      provider,
      content: options?.steered ? buildSteeredMessageContent(queuedMessage.content) : queuedMessage.content,
      // Memory passes see the user's real words, never the steering wrapper (BUG AGENT-4).
      memoryUserText: options?.steered ? queuedMessage.content : undefined,
      attachments: queuedMessage.attachments,
      connectionId: settings.connectionId,
      model: settings.model,
      effort: settings.effort,
      serviceTier: settings.serviceTier,
      planMode: settings.planMode,
      appendUserPrompt: true,
      steered: options?.steered,
    })
    return "started"
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

  private async maybeStartNextQueuedMessage(chatId: string) {
    if (this.commandRegistry.isRunning(chatId) || this.activeTurns.has(chatId)) return false
    const nextQueuedMessage = await this.nextDispatchableQueuedMessage(chatId)
    if (!nextQueuedMessage) return false
    await this.dequeueAndStartQueuedMessage(chatId, nextQueuedMessage)
    return true
  }

  private async startTurnForChat(args: StartTurnArgs) {
    if (this.commandRegistry.isRunning(args.chatId)) throw new Error('Native context control is running')
    if (/^\s*\/compact(?:\s|$)/.test(args.content)) throw new Error('Compact must use the native command control route')
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
    args.memoryState ??= resolveTurnMemoryState(this.getMemorySettings(), chat.memoryDisabled)
    if (!args.memoryPreviewSettings) {
      const settings = this.getMemoryPreviewSettings()
      args.memoryPreviewSettings = {
        enabled: settings.enabled,
        autoProceedWhenEmpty: settings.autoProceedWhenEmpty,
        confirmationMode: settings.confirmationMode === "every_turn" ? "every_turn" : "on_change",
      }
    }
    if (this.activeTurns.has(args.chatId) || this.hasPendingPreviewActivity(args.chatId) || this.startingChats.has(args.chatId)) {
      throw new Error("Chat is already running")
    }
    // Hold the reservation across every await below (preview pass, engine boot)
    // until the turn hands off to pendingPreviews (parked) or activeTurns (booted).
    const reservation = this.reserveStartup(args)
    const startupCancelled = () => reservation.cancelled
    // A fresh turn starts unrestricted — an edited gate only scoped the
    // PREVIOUS turn's injection.
    this.turnMemoryRestriction.delete(args.chatId)
    // A review planner's task-specific guidance belongs to its own turn. Auto
    // starts from the index; interrupt recovery retains its existing context.
    if (args.memoryState.control === "auto" && !args.resume) this.turnExpectedUses.delete(args.chatId)
    let reservationHandedOff = false
    try {
    await this.settleCommandPreparation(args)
    if (startupCancelled()) return
    // Freeze execution and host admission together, before runtime/memory startup awaits.
    if (this.policyChanges.has(args.chatId)) throw new Error("Execution policy change in progress")
    const selectedPolicy = this.executionPolicyFor(args.chatId, args.provider)
    this.harnessPolicies.ensure(args.chatId, selectedPolicy.policy, selectedPolicy.revision, chat.executionPolicyStates?.[args.provider])
    args.policyScope = this.harnessPolicies.beginTurn(args.chatId, selectedPolicy.policy, selectedPolicy.revision, logicalTurnId,
      this.harnessRuntimeVersion(args.provider, args.engineRuntime?.executable.version ?? lastEngineExecutable(args.provider)?.version))
    this.policyScopes.set(args.chatId, args.policyScope)
    if (this.hostActions) {
      const hostProject = this.store.getProject(chat.projectId)
      if (hostProject) args.hostAdmission = this.hostActions.captureAdmission({
        chatId: args.chatId, admittedTurnId: logicalTurnId, workspaceRef: chat.projectId,
        workspaceRoot: hostProject.localPath, targetClientId: args.hostClientId, policyScope: args.policyScope,
      })
    }
    if (!(args.provider === "pi" && this.hasCustomPiConnection)) {
      const selection = JSON.stringify([args.provider, args.model, args.connectionId, getModelAccessService()?.revision])
      if (!args.engineRuntime && this.runtimeSelections.get(args.chatId) === selection) args.engineRuntime = this.sessionRuntimes.get(args.chatId)
      args.engineRuntime ??= await resolveEngineRuntime({ engine: args.provider, model: args.model, connectionId: args.connectionId })
      this.runtimeSelections.set(args.chatId, selection)
    }
    if (startupCancelled()) return
    if (!chat.provider) {
      await this.store.setChatProvider(args.chatId, args.provider)
      if (startupCancelled()) return
      logSendToStartingProfile(args.profile, "start_turn.provider_set", {
        chatId: args.chatId,
        provider: args.provider,
      })
    }
    await this.store.setPlanMode(args.chatId, args.planMode)
    if (startupCancelled()) return
    logSendToStartingProfile(args.profile, "start_turn.plan_mode_set", {
      chatId: args.chatId,
      planMode: args.planMode,
    })

    const existingMessages = this.store.getMessages(args.chatId)
    // A recovery retry reuses one logical user-prompt entry. The first attempt
    // may have durably recorded the continuation before the provider boot
    // failed; duplicating that prompt would also invent a second turn number.
    let userPromptEntry = args.resume
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
      if (startupCancelled()) return
      logSendToStartingProfile(args.profile, "start_turn.optimistic_title_set", {
        chatId: args.chatId,
        title: optimisticTitle,
      })
    }

    const project = this.store.getProject(chat.projectId)
    if (!project) {
      throw new Error("Project not found")
    }

    if (shouldAppendUserPrompt) {
      userPromptEntry = {
        ...timestamped(
          {
            kind: "user_prompt",
            content: args.content,
            // Retain the stored field name for compatibility with older transcripts.
            participantContent: args.memoryUserText ?? args.content,
            attachments: args.attachments,
            steered: args.steered,
          },
          Date.now(),
        ),
        _id: logicalTurnId,
      } as Extract<TranscriptEntry, { kind: "user_prompt" }>
      const promptWrite = this.store.appendMessage(args.chatId, userPromptEntry)
      reservation.promptWrite = promptWrite
      try {
        await promptWrite
      } finally {
        if (reservation.promptWrite === promptWrite) reservation.promptWrite = undefined
      }
      if (startupCancelled()) return
      logSendToStartingProfile(args.profile, "start_turn.user_prompt_appended", {
        chatId: args.chatId,
        entryId: userPromptEntry._id,
      })
    }

    if (!logicalPromptAlreadyAppended) {
      await this.store.recordTurnStarted(args.chatId)
      if (startupCancelled()) return
      logSendToStartingProfile(args.profile, "start_turn.turn_started_recorded", {
        chatId: args.chatId,
      })
    }

    if (args.memoryState.memoryActive && this.memory && !args.resume) {
      const key = `expiry_seen:${args.chatId}`
      const previousCursor = this.memory.store.getKv<number>(key)
      const cursor = previousCursor ?? this.memory.store.latestEventSeq()
      if (previousCursor === null) this.memory.store.setKv(key, cursor)
      this.memory.expireDue()
      const { ids, lastSeq } = this.memory.store.expirationsSince(cursor, chat.projectId, args.chatId)
      if (ids.length) {
        await this.store.appendMessage(args.chatId, timestamped({ kind: "memory_expired", ids, turn: turnNumber }))
        this.emitStateChange(args.chatId)
      }
      this.memory.store.setKv(key, lastSeq)
      if (startupCancelled()) return
    }

    if (shouldGenerateTitle) {
      void this.generateTitleInBackground(args.chatId, args.content, project.localPath, optimisticTitle ?? "New Chat")
    }

    const previewSettings = args.memoryPreviewSettings
    // A resume-after-interrupt skips every gate: candidates/transfer/checkup
    // were reviewed this session already and the recovery card confirmed the
    // working memory (2026-08-19 C2).
    if (args.memoryState.memoryActive && args.memoryState.control !== "auto" && this.memoryPreview && this.memory && args.appendUserPrompt && previewSettings.enabled && !args.resume) {
      // The plan (not the raw item store) defines what the model will see.
      const plan = planMemoryInjection({
        memory: this.memory,
        projectId: chat.projectId,
        chatId: args.chatId,
      })
      // Run the gate whenever there are item-based memories to reason about
      // — EVEN when the injected set is empty. An empty
      // plan is not "no gate": runPreviewGateThenBoot records the (empty)
      // preview and either auto-proceeds (setting on) or parks for an explicit
      // decision (setting off) (BUG AGENT-5).
      {
        // The gate waits on a human — that must not hold the caller's ws ack:
        // the client reads a held ack (10s timeout) as a dead socket,
        // misreports the DELIVERED message as failed, and resurrects the
        // composer draft. The prompt is committed above, so ack now; the gate
        // + boot continue detached, taking the startingChats reservation with
        // them. The status broadcast is synchronous — subscribers learn about
        // the wait before the ack returns.
        this.reserveStartup(args, "previewing_memory")
        this.emitStateChange(args.chatId, { immediate: true })
        reservationHandedOff = true
        void this.runPreviewGateThenBoot(args, { chat, project, turnNumber, injected: plan.injectedMemories })
        return
      }
    }

    await this.bootEngineTurn(args, { chat, project, turnNumber, memoryDisabledForTurn: !args.memoryState.memoryActive })
    } finally {
      // By now the turn is parked (pendingPreviews) or booted (activeTurns);
      // either way those guard the chat, so releasing the reservation is safe.
      // The detached preview continuation owns (and releases) the reservation
      // it was handed — the early-return above must not release it here.
      if (!reservationHandedOff) {
        if (!this.activeTurns.has(args.chatId)) this.endPolicyTurn(args.chatId, logicalTurnId)
        this.settleStartupReservation(args.chatId, reservation)
      }
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
    const proposalsId = options?.proposalsId ?? crypto.randomUUID()
    const prep = this.activePreparations.get(args.chatId)
    if (prep) prep.proposalsId = proposalsId
    // Publish the Step 1 shell before the prompt-side capture pass. The user
    // now sees the same left-to-right skeleton used by Step 2 and injection,
    // rather than a generic processing line followed by a sudden card.

      await this.store.appendMessage(
        args.chatId,
        timestamped({
          kind: "memory_proposals",
          proposalsId,
          turn: ctx.turnNumber,
          pending: true,
          candidates: [],
        }),
      )
      this.emitStateChange(args.chatId, { immediate: true })

    // The parse has its own hard timeout, but Stop must not wait for it. Keep a
    // terminal handler attached to the detached task so a late rejection never
    // becomes unhandled; the shared phase signal wins the public gate race.
    if (!prep?.cancellation.signal.aborted) {
      const captureInput = {
        projectId: ctx.project.id,
        sessionId: args.chatId,
        turn: ctx.turnNumber,
        engine: args.provider,
        userText: args.memoryUserText ?? args.content,
        policyKey: this.memoryAnalysisPolicyKey(args.chatId, args.provider),
        signal: prep?.cancellation.signal,
      }
      const branches = this.branchPreparations.get(args.chatId)
      const captureTask = this.trackMemoryWork(args.chatId, () => branches
        ? branches.pipeline.result("candidate").then(result => this.capture!.captureFromBranch!(result.raw, captureInput, result.dependencyKey))
        : this.capture!.captureFromPrompt(captureInput)).then(
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
        if (this.memoryBranches) throw error
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
      const finishWaiting = this.memoryWait(args.chatId, 'candidate', args.turnId)
      this.pendingProposalGates.set(args.chatId, {
        proposalsId,
        published: true,
        respond: (d) => {
          this.pendingProposalGates.delete(args.chatId)
          finishWaiting(d)
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
      const finishWaiting = this.memoryWait(args.chatId, 'candidate', args.turnId)
      this.pendingProposalGates.set(args.chatId, {
        proposalsId,
        published: true,
        respond: (next) => {
          this.pendingProposalGates.delete(args.chatId)
          finishWaiting(next)
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
    if (await this.refreshTransferAfterCandidateReview(args, ctx.turnNumber)) return { cancelled: true, revision }

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
      const finishWaiting = this.memoryWait(args.chatId, 'transfer', args.turnId)
      this.pendingTransferGates.set(args.chatId, {
        transferId,
        published: true,
        respond: (next) => {
          this.pendingTransferGates.delete(args.chatId)
          finishWaiting(next)
          resolve(next)
        },
        invalidate: () => {
          this.pendingTransferGates.delete(args.chatId)
          finishWaiting("invalidated")
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
    const existingMessages = options?.transferId ? this.store.getMessages(args.chatId) : []
    const existingParent = existingMessages.filter(
      (message): message is Extract<TranscriptEntry, { kind: "memory_transfer" }> =>
        message.kind === "memory_transfer" && message.transferId === options?.transferId,
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
    if (!options?.recompute) this.memory?.clearTransferLandings(args.chatId)
    const taskCtx = {
      projectId: ctx.project.id,
      sessionId: args.chatId,
      projectTitle: ctx.project.title,
      taskText: args.memoryUserText ?? args.content,
      policyKey: this.memoryAnalysisPolicyKey(args.chatId, args.provider),
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
      const branches = this.branchPreparations.get(args.chatId)
      if (branches) {
        await branches.pipeline.result("transfer")
        return null // Materialize after Candidate review against its approved store.
      }
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
            runtime: args.engineRuntime ?? this.sessionRuntimes.get(args.chatId),
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
    const taskRun = this.trackMemoryWork(args.chatId, computeTask).then(
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

    if (this.memoryBranches) {
      const request = this.memoryTransferDetect!.buildTaskBranchPrompt!(taskCtx)
      const updated = await this.continueMemoryBranch(args.chatId, "transfer", "Candidate review", request.dependencyKey, request)
      result = await this.memoryTransferDetect!.materializeTaskFromBranch!(taskCtx, updated.raw, updated.dependencyKey)
      if (!result) throw new Error("Memory transfer dependencies changed during review; prepare this turn again")
    }

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
            this.trackMemoryWork(args.chatId, () => this.memoryBranches ? (async () => {
              const request = this.memoryTransferDetect!.buildTaskBranchPrompt!(taskCtx)
              const updated = await this.continueMemoryBranch(args.chatId, "transfer", "Candidate edits", request.dependencyKey, request)
              const fresh = await this.memoryTransferDetect!.materializeTaskFromBranch!(taskCtx, updated.raw, updated.dependencyKey)
              if (!fresh) throw new Error("Memory transfer dependencies changed")
              return fresh
            })() : this.memoryTransferDetect!.refreshLandingsIfTargetChanged(taskCtx, result!, { onProgress })).then(
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
    const finishWaiting = this.memoryWait(args.chatId, 'transfer', args.turnId)
    this.pendingTransferGates.set(args.chatId, {
      transferId,
      published: true,
      respond: (d) => {
        this.pendingTransferGates.delete(args.chatId)
        finishWaiting(d)
        resolveDecision(d)
      },
      invalidate: () => {
        this.pendingTransferGates.delete(args.chatId)
        finishWaiting("invalidated")
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
    const checkupId = options?.checkupId ?? crypto.randomUUID()
    const reuseParent = Boolean(options?.reuseParent)
    const checkupCtx = { projectId: ctx.project.id, sessionId: args.chatId, taskText: args.memoryUserText ?? args.content, policyKey: this.memoryAnalysisPolicyKey(args.chatId, args.provider) }
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
              turn: ctx.turnNumber,
              pending: true,
            }),
          )
        }
        this.emitStateChange(args.chatId, { immediate: true })
      }
      if (this.memoryBranches) {
        const request = this.memoryCheckup!.buildBranchPrompt?.(checkupCtx, args.memoryUserText ?? args.content)
          ?? this.memoryCheckup!.buildForkPrompt!(checkupCtx)
        const prepared = await this.continueMemoryBranch(args.chatId, "changes", "Transfer and memory review", request?.dependencyKey ?? "", request)
        const checked = await this.memoryCheckup!.primeFromBranchResult!(checkupCtx, prepared.dependencyKey, prepared.raw)
        if (!checked) throw new Error("Memory change dependencies changed during analysis")
        result = checked
      } else {
        result = await this.trackMemoryWork(args.chatId, () => this.memoryCheckup!.run(checkupCtx))
      }
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
      if (analysisFailed && this.memoryBranches) throw new Error("Memory-change analysis failed. Retry preparation before running the coding agent.")
      return { decision: "none", checkupId }
    }

    const decision = await new Promise<InternalGateWake<CheckupGateDecision>>((resolve) => {
      const finishWaiting = this.memoryWait(args.chatId, 'changes', args.turnId)
      this.pendingCheckupGates.set(args.chatId, {
        checkupId,
        proposalsId: options?.proposalsId,
        transferId: options?.transferId,
        // The result entry is durably appended above — the gate is
        // respondable the moment it parks.
        published: true,
        respond: (d) => {
          this.pendingCheckupGates.delete(args.chatId)
          finishWaiting(d)
          resolve(d)
        },
        invalidate: () => {
          this.pendingCheckupGates.delete(args.chatId)
          finishWaiting("invalidated")
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
        if (await this.refreshTransferAfterCandidateReview(args, input.ctx.turnNumber)) return

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
        memory: this.memory!,
        projectId: input.ctx.project.id,
        chatId: args.chatId,
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
      this.settleStartupReservation(args.chatId, args.startupReservation)
      if (this.startupReservations.get(args.chatId) === args.startupReservation) {
        this.cancelledDuringPreview.delete(args.chatId)
      }
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
    pending.assertCurrentView?.()
    const allowed = new Set(pending.memoryIds)
    const selected = [...new Set(selectedIds)].filter((id) => allowed.has(id))
    if (this.memoryBranches) {
      for (const id of selected) {
        const snapshot = pending.memories.find(item => item.id === id)
        const current = this.memory?.store.getById(id)
        if (!snapshot || !current || current.status !== "active" || current.version !== snapshot.version || current.content !== snapshot.content || current.detail !== snapshot.detail) {
          throw new Error("Working memory changed during review. Reopen preparation to review the updated items.")
        }
      }
    }
    const missing = selected.filter((id) => !pending.expectedUseById.has(id))
    if (missing.length) {
      let planned: ExpectedMemoryUse[] = []
      try {
        const branch = pending.chatId ? this.workingBranches.get(pending.chatId) : undefined
        if (this.memoryBranches) {
          if (!branch) throw new Error("Working-memory branch is unavailable; reopen memory preparation")
          const input = { task: pending.task, memories: pending.memories.filter(item => selected.includes(item.id)), mandatoryIds: selected }
          const raw = await branch.ask(`The developer confirmed these items. Continue your selection analysis and provide an expected use for each.\n${buildWorkingMemoryBranchPrompt(input)}`, { schema: memoryStageSchema("working-memory"), budget: { maxTurns: 3, maxToolCalls: 1 } })
          planned = parseWorkingMemoryBranchResult(raw, input).expectedUses
        } else planned = await this.planExpectedMemoryUses(pending.task, pending.memories, missing)
      } catch (error) {
        if (this.memoryBranches) throw error
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
    pending.assertCurrentView?.()
    return selected.flatMap((id) => {
      const expectedUse = pending.expectedUseById.get(id)
      return expectedUse ? [{ id, expectedUse }] : []
    })
  }

  private async settleWorkingMemory(args: StartTurnArgs, pending: PendingMemoryPreview, attentionIds: string[], relevant: RelevantMemory[], turnNumber: number) {
    if (this.pendingPreviews.get(args.chatId) !== pending || !this.memory) return
    const chat = this.store.requireChat(args.chatId)
    let selectedIds = normalizeMemorySelection({
      memory: this.memory, projectId: chat.projectId, chatId: args.chatId,
      selectedIds: [...new Set([...attentionIds, ...relevant.map(item => item.id)])].filter(id => pending.memoryIds.includes(id)),
    })
    const plannedUses = await this.resolveExpectedUses(pending.task, pending.memories, selectedIds, relevant)
    if (this.pendingPreviews.get(args.chatId) !== pending) return
    selectedIds = normalizeMemorySelection({ memory: this.memory, projectId: chat.projectId, chatId: args.chatId, selectedIds })
    if (pending.confirmationMode === "on_change") pending.assertCurrentView?.()
    const expectedUses = plannedUses.filter(use => selectedIds.includes(use.id))
    for (const id of selectedIds) (pending.proposedIds ??= new Set()).add(id)
    for (const use of expectedUses) pending.expectedUseById.set(use.id, use.expectedUse)
    const reasons = memoryConfirmationReasons(pending.memories, getMemoryConfirmation(this.memory.store, args.chatId), attentionIds)
    if (relevant.length) this.memory.logger.event({ type: "memory.relevance", sessionId: args.chatId, turn: turnNumber, ids: relevant.map(item => item.id) })
    this.turnExpectedUses.set(args.chatId, expectedUses)
    await this.store.appendMessage(args.chatId, timestamped({
      kind: "memory_preview_relevance", previewId: pending.previewId, revision: pending.revision,
      relevant: relevant.filter(item => selectedIds.includes(item.id)).map(({ id, why }) => ({ id, why })),
      expectedUses, confirmationReasons: reasons,
    }))
    if (this.pendingPreviews.get(args.chatId) !== pending) return
    if (pending.confirmationMode === "on_change") pending.assertCurrentView?.()
    selectedIds = normalizeMemorySelection({ memory: this.memory, projectId: chat.projectId, chatId: args.chatId, selectedIds })
    this.emitStateChange(args.chatId)
    const settings = args.memoryPreviewSettings!
    const reasonsById = new Set(reasons.map(reason => reason.id))
    const hasExpectedUse = new Set(expectedUses.filter(use => use.expectedUse.trim()).map(use => use.id))
    const snapshotsCurrent = selectedIds.every(id => {
      const snapshot = pending.memories.find(item => item.id === id)
      const current = this.memory!.store.getById(id)
      return snapshot && current?.status === "active" && current.version === snapshot.version
    })
    if (pending.confirmationMode === "on_change" && snapshotsCurrent
      && selectedIds.every(id => hasExpectedUse.has(id) && !reasonsById.has(id))
      && !attentionIds.length && (selectedIds.length > 0 || settings.autoProceedWhenEmpty)) {
      await this.respondToMemoryPreview({ chatId: args.chatId, previewId: pending.previewId, decision: "go_on", memoryIds: selectedIds }, true)
    }
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
    const previewSettings = args.memoryPreviewSettings!
    const memoryIds = ctx.injected.map((memory) => memory.id)
    const attentionIds = (this.turnPayAttention.get(args.chatId) ?? []).map((e) => e.id).filter((id) => memoryIds.includes(id))
    const willAssessRelevance = (this.memoryBranches || Boolean(this.memoryRelevance)) && ctx.injected.length > 0

    this.turnExpectedUses.delete(args.chatId)
    const finishWaiting = this.memoryWait(args.chatId, 'working-memory', args.turnId)
    const pending: PendingMemoryPreview = {
      chatId: args.chatId,
      previewId,
      revision,
      published: false,
      memoryIds,
      task: args.memoryUserText ?? args.content,
      memories: ctx.injected,
      expectedUseById: new Map(),
      confirmationMode: previewSettings.confirmationMode,
      proposedIds: new Set(willAssessRelevance ? [] : memoryIds),
      assertCurrentView: this.memoryBranches || previewSettings.confirmationMode !== "every_turn" ? this.memoryViewGuard(args, true) : undefined,
      proposalsId: input.proposalsId,
      transferId: input.transferId,
      checkupId: input.checkupId,
      respond: (decision, selectedIds, expectedUses, operationId) => {
        finishWaiting(decision)
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
          operationId,
          auto: pending.autoProceed,
          confirmationMode: pending.confirmationMode,
          confirmedMemories: pending.memories.filter(item => selectedIds?.includes(item.id)),
          removedIds: [...(pending.proposedIds ?? [])].filter(id => !selectedIds?.includes(id)),
        })
      },
      reopen: (from, stageId) => {
        finishWaiting('reopened')
        this.deletePendingPreviewIfCurrent(args.chatId, pending)
        this.reserveStartup(args, "previewing_memory")
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
        confirmationMode: pending.confirmationMode,
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
      void this.trackMemoryWork(args.chatId, () => this.assessWorkingMemory(args, ctx.injected, attentionIds)
        .then(relevant => this.settleWorkingMemory(args, pending, attentionIds, relevant, ctx.turnNumber))
        .catch(() => this.reportWorkingMemoryFailure(args.chatId, previewId, revision)))
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
    const previewSettings = args.memoryPreviewSettings!
    try {
      let gated = false
      // Flipped by the parked respond closure: once a decision claims the
      // gate, finishMemoryPreview owns the turn — no path here may boot it.
      let claimed = false
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

        // Step 1 and the Transfer card COMPUTE in parallel; the transfer's
        // presentation is staged inside runTransferGate: after Step 1, show a
        // scanning shell only while current-task materialization is still
        // running; otherwise publish only a completed non-empty card. Cancel
        // resolves every parked gate and records the interruption once.
        if (args.memoryState?.learnActive !== false) {
        let recomputeProposals = false
        let recomputeTransfer = false
        let recomputeCheckup = false

        this.activePreparations.set(args.chatId, {
          args,
          ctx,
          reparks: [],
          reopened: false,
          cancellation: createMemoryPreparationCancellation(),
        })
        this.startMemoryBranches(args, ctx)
        const proposalsRun =
          this.capture
            ? this.runProposalsGate(args, ctx, recomputeProposals
                ? { proposalsId, recompute: true }
                : undefined)
            : null
        if (this.memoryBranches) {
          // M incorporates Candidate decisions while T is still being reviewed.
          void (proposalsRun ?? Promise.resolve()).then(() => {
            if (this.cancelledDuringPreview.has(args.chatId)) return
            const checkupCtx = { projectId: ctx.project.id, sessionId: args.chatId, taskText: args.memoryUserText ?? args.content, policyKey: this.memoryAnalysisPolicyKey(args.chatId, args.provider) }
            const request = this.memoryCheckup?.buildBranchPrompt?.(checkupCtx, args.memoryUserText ?? args.content)
              ?? this.memoryCheckup?.buildForkPrompt?.(checkupCtx)
            return this.continueMemoryBranch(args.chatId, "changes", "Candidate review", request?.dependencyKey ?? "", request)
          }).catch(() => {})
        }
        const transferRun =
          this.memoryTransferDetect
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
          if (prep?.reopened) {
            stepOneTouched = true
            if (await this.refreshTransferAfterCandidateReview(args, ctx.turnNumber)) return
          }
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
        if (stepOneTouched || this.memoryBranches) {
          ctx = {
            ...ctx,
            injected: planMemoryInjection({
              memory: this.memory!,
              projectId: ctx.project.id,
              chatId: args.chatId,
            }).injectedMemories,
          }
        }
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
        const autoProceed = previewSettings.autoProceedWhenEmpty && ctx.injected.length === 0
        // Maintenance attention no longer rides the gate (redesign 2026-08-07
        // §3): the step-one checkup container is its one home in the chat
        // flow; the Board keeps the inventory view.
        // Park BEFORE the card lands in the transcript: the moment the entry
        // is visible a respond can arrive, and it must find the gate. Parking
        // after the append left a microtask window where a fast respond threw
        // "No matching pending memory preview".
        if (!autoProceed) {
          const finishWaiting = this.memoryWait(args.chatId, 'working-memory', args.turnId)
          const pending: PendingMemoryPreview = {
            chatId: args.chatId,
            previewId,
            revision: 0,
            published: false,
            memoryIds,
            task: args.memoryUserText ?? args.content,
            memories: ctx.injected,
            expectedUseById: new Map(),
            confirmationMode: previewSettings.confirmationMode,
            proposedIds: new Set((this.memoryBranches || Boolean(this.memoryRelevance)) && ctx.injected.length > 0 ? [] : memoryIds),
            assertCurrentView: this.memoryBranches || previewSettings.confirmationMode !== "every_turn" ? this.memoryViewGuard(args, true) : undefined,
            proposalsId,
            transferId,
            checkupId,
            respond: (decision, selectedIds, expectedUses, operationId) => {
              finishWaiting(decision)
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
                operationId,
                auto: pending.autoProceed,
                confirmationMode: pending.confirmationMode,
                confirmedMemories: pending.memories.filter(item => selectedIds?.includes(item.id)),
                removedIds: [...(pending.proposedIds ?? [])].filter(id => !selectedIds?.includes(id)),
              })
            },
            reopen: (from, stageId) => {
              finishWaiting('reopened')
              claimed = true
              this.deletePendingPreviewIfCurrent(args.chatId, pending)
              this.reserveStartup(args, "previewing_memory")
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
        const willAssessRelevance = !autoProceed && (this.memoryBranches || Boolean(this.memoryRelevance)) && ctx.injected.length > 0
        await this.store.appendMessage(
          args.chatId,
          timestamped({
            kind: "memory_preview",
            previewId,
            confirmationMode: this.pendingPreviews.get(args.chatId)?.confirmationMode ?? previewSettings.confirmationMode,
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
        // prompt as a "possibly relevant" hint.
        if (willAssessRelevance) {
          // The gate card shows "picking likely-relevant…" until an entry
          // lands — so EVERY outcome appends one: hits, an empty list, and
          // failure all resolve the pending state (an empty list IS the
          // prediction "nothing clearly applies").
          void this.trackMemoryWork(args.chatId, () => this.assessWorkingMemory(args, ctx.injected, attentionIds)
            .then(relevant => {
              const pending = this.pendingPreviews.get(args.chatId)
              if (!pending || pending.previewId !== previewId || pending.revision !== 0) return
              return this.settleWorkingMemory(args, pending, attentionIds, relevant, ctx.turnNumber)
            })
            .catch(() => this.reportWorkingMemoryFailure(args.chatId, previewId, 0)))
        }
        if (autoProceed) {
          // Stop can land during the preview-entry append here too — an
          // auto-proceeding turn is still a cancelled turn.
          if (this.cancelledDuringPreview.delete(args.chatId)) {
            this.emitStateChange(args.chatId, { immediate: true })
            return
          }
          // No memory in play this turn: record an automatic go_on (the
          // preview entry above records the empty selection) and boot
          // without parking — the friction is only spent when memory matters.
          await this.store.appendMessage(
            args.chatId,
            timestamped({ kind: "memory_preview_decision", previewId, decision: "go_on", auto: true })
          )

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
        if (this.memoryBranches) {
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
        args,
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
      this.restoreUndeliveredEnforcement(args.chatId)
      const message = error instanceof Error ? error.message : String(error)
      try {
        await this.store.appendMessage(
          args.chatId,
          timestamped({ kind: "result", subtype: "error", isError: true, durationMs: 0, result: message })
        )
        await this.store.recordTurnFailed(args.chatId, message)
      } finally {

        this.emitStateChange(args.chatId)
      }
    } finally {
      // Parked (pendingPreviews guards the chat), booted (activeTurns), or
      // failed — in every case the handed-over reservation is done.
      const ownsReservation = this.startupReservations.get(args.chatId) === args.startupReservation
      const activePreparation = this.activePreparations.get(args.chatId)
      if (activePreparation && activePreparation.args.startupReservation === args.startupReservation) {
        this.activePreparations.delete(args.chatId)
      }
      // Never leak a cancel flag or an abort handle into a later turn.
      if (ownsReservation) this.cancelledDuringPreview.delete(args.chatId)
      // Resolve Stop only after every public busy/freeze guard is gone.
      if (activePreparation && activePreparation.args.startupReservation === args.startupReservation) {
        activePreparation.cancellation.settle()
      }
      this.settleStartupReservation(args.chatId, args.startupReservation)
      if (!this.pendingPreviews.has(args.chatId) && !this.activeTurns.has(args.chatId)) this.disposeMemoryBranches(args.chatId)
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
    operationId?: string
    expectedUses?: ExpectedMemoryUse[]
    auto?: boolean
    confirmationMode?: "on_change" | "every_turn"
    confirmedMemories?: MemoryItem[]
    removedIds?: string[]
  }) {
    const { args, decision } = ctx
    try {
      if (args.startupReservation) {
        if (!this.startupReservationIsCurrent(args.chatId, args.startupReservation)) return
      } else if (this.startupReservations.has(args.chatId) || this.activeTurns.has(args.chatId)
        || this.isEngineStartBlocked(args.chatId)) return
      this.reserveStartup(args)
      const selected = new Set(ctx.selectedIds ?? ctx.memoryIds)
      if ((this.memoryBranches || ctx.confirmationMode === "on_change") && this.memory && decision === 'go_on') args.approvedMemoryViewRevision = planMemoryInjection({
        memory: this.memory, projectId: ctx.chat.projectId, chatId: args.chatId, restrictToIds: [...selected],
      }).view.revision
      const expectedUses = (ctx.expectedUses ?? this.turnExpectedUses.get(args.chatId) ?? [])
        .filter((use) => selected.has(use.id) && typeof use.expectedUse === "string" && use.expectedUse.trim())
        .map((use) => ({ id: use.id, expectedUse: use.expectedUse.trim().slice(0, 220) }))
      await this.store.appendMessage(
        args.chatId,
        timestamped({ kind: "memory_preview_decision", previewId: ctx.previewId, decision, selectedIds: ctx.selectedIds, expectedUses,
          ...(ctx.auto ? { auto: true, ...(ctx.selectedIds?.length ? { autoReason: "confirmed" as const } : {}) } : {}) })
      )
      if (!this.startupReservationIsCurrent(args.chatId, args.startupReservation)) return
      if (!ctx.auto && decision !== "dismiss" && this.memory) {
        recordMemoryConfirmation(this.memory.store, args.chatId, decision === "go_on" ? ctx.confirmedMemories ?? [] : [], ctx.removedIds ?? [])
      }
      this.memory?.logger.event({
        type: "memory.preview",
        operationId: ctx.operationId,
        sessionId: args.chatId,
        engine: args.provider,
        turn: ctx.turnNumber,
        memoryIds: ctx.auto ? ctx.selectedIds ?? [] : ctx.memoryIds,
        decision: ctx.auto ? "auto_go_on" : decision,
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
        this.restoreUndeliveredEnforcement(args.chatId)
        this.disposeMemoryBranches(args.chatId)
        await this.store.recordTurnCancelled(args.chatId)
        // Cancellation is now durable and any phased terminal was attempted.
        // Release before queue draining, which deliberately treats the claim
        // as a busy owner and would otherwise leave the next row parked.
        this.releasePendingPreviewResponse(args.chatId, ctx.previewId)
        this.releaseStartupStatus(args.chatId, args.startupReservation)
        this.emitStateChange(args.chatId, { immediate: true })
        await this.maybeStartNextQueuedMessage(args.chatId)
        return
      }

      this.emitStateChange(args.chatId)
      await this.bootEngineTurn(args, {
        chat: ctx.chat,
        project: ctx.project,
        turnNumber: ctx.turnNumber,
        memoryDisabledForTurn: decision === "without_memory",
      })
    } catch (error) {
      if (args.startupReservation?.cancelled || args.startupReservation?.superseded
        || this.isEngineStartBlocked(args.chatId)) return
      this.restoreUndeliveredEnforcement(args.chatId)
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
      this.settleStartupReservation(args.chatId, args.startupReservation)
    }
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
    if (this.isEngineStartBlocked(args.chatId)) return
    const { chat, project, turnNumber, memoryDisabledForTurn } = ctx
    const hostAdmission = args.hostAdmission
    const reservation = args.startupReservation
    const turnRestriction = args.resume?.selectedIds ?? this.turnMemoryRestriction.get(args.chatId)
    const providerAttachments = args.providerAttachments ?? args.attachments
    if (reservation?.cancelled) return
    const startController = new AbortController()
    if (reservation) reservation.controller = startController
    this.engineStartAbortControllers.set(args.chatId, startController)
    let bootedActive: ActiveTurn | undefined
    let admitTurn!: () => void
    const turnReady = new Promise<void>(resolve => { admitTurn = resolve })
    let turn: HarnessTurn
    try {
    this.disposeMemoryBranches(args.chatId)
    if (args.engineRuntime) this.sessionRuntimes.set(args.chatId, args.engineRuntime)

    // The project dir can vanish under a recorded project (a container rebuild
    // wipes non-volume paths); spawning an engine with a missing cwd fails as
    // a misleading "native binary failed to launch" / posix_spawn ENOENT
    // (QA BUG-001/002/004). Recreate it before any boot.
    await ensureProjectDirectory(project.localPath)
    if (reservation?.cancelled || startController.signal.aborted || this.isEngineStartBlocked(args.chatId)) return

    // Snapshot BEFORE any engine boot awaits: what this turn injects (trace's
    // ground truth). Use the confirmed selection in the injection plan,
    // not the full visible pool returned by injectedFor.
    const turnMemoryPlan =
      this.memory && !memoryDisabledForTurn
        ? planMemoryInjection({
            memory: this.memory,
            projectId: chat.projectId,
            chatId: args.chatId,
            restrictToIds: turnRestriction,
          })
        : null
    if (args.approvedMemoryViewRevision && args.approvedMemoryViewRevision !== turnMemoryPlan?.view.revision) {
      throw new Error('Working memory changed after approval. Reopen preparation to review the updated view.')
    }
    const injectedIdsAtBoot = turnMemoryPlan?.injectedMemories.map((m) => m.id) ?? []
    if (this.policyChanges.has(args.chatId)) throw new Error("Execution policy change in progress")
    const selectedPolicy = this.executionPolicyFor(args.chatId, args.provider)
    const executionPolicy = selectedPolicy.policy
    const legacyExecution = !chat.executionPolicyVersion
    const policyScope = args.policyScope
    if (!policyScope || !this.harnessPolicies.isCurrent(policyScope) || policyScope.policyRevision !== selectedPolicy.revision) throw new Error("Stale execution policy admission")
    this.harnessPolicies.observeRuntime(policyScope, this.harnessRuntimeVersion(args.provider, args.engineRuntime?.executable.version ?? lastEngineExecutable(args.provider)?.version))
    await this.store.setExecutionPolicyState?.(args.chatId, this.harnessPolicies.state(args.chatId, args.provider))
    const isPolicyCurrent = () => !this.policyChanges.has(args.chatId) && this.harnessPolicies.isCurrent(policyScope)
    const onExecutionPolicyApplied = async (nativeSessionId?: string) => {
      if (!isPolicyCurrent()) throw new Error("Stale execution policy acknowledgement")
      const choice = this.harnessPolicies.registry.snapshot(args.provider, this.harnessRuntimeVersion(args.provider, args.engineRuntime?.executable.version ?? lastEngineExecutable(args.provider)?.version))
        .executionPolicies.find(c => executionPolicyKey(c.policy) === executionPolicyKey(executionPolicy))
      // Only a native acknowledgement for an adapter-supported policy advances effective state.
      if (!choice || choice.availability !== "available") return
      const state = this.harnessPolicies.applied(policyScope, nativeSessionId)
      if (state) await this.store.setExecutionPolicyState?.(args.chatId, state)
      if (!isPolicyCurrent()) throw new Error("Stale execution policy acknowledgement")
      this.emitStateChange(args.chatId)
    }
    const canUseMemory = (name: string) => {
      const settings = this.getMemorySettings()
      const live = this.store.getChat(args.chatId)
      return !memoryDisabledForTurn && !!live && !live.deletedAt && !live.memoryDisabled && settings.enabled
        && (!name.endsWith('propose_memory') || (settings.learn && args.memoryState?.learnActive !== false))
    }
    const requestNativeApproval = async (name: string, input: Record<string, unknown>, requestId?: string) => {
      await turnReady
      return this.requestExecutionApproval(policyScope, name, input, requestId)
    }
    const authorizeHostTool = async (name: string, input: Record<string, unknown>, requestId?: string) => {
      await turnReady
      if (!isPolicyCurrent() || this.activeTurns.get(args.chatId)?.turnId !== policyScope.turnId) return false
      if (legacyExecution) return true
      const decision = this.harnessPolicies.admit(policyScope, name)
      if (decision === "deny") return false
      if (decision === "allow") return true
      return requestNativeApproval(name, input, requestId)
    }

    const onToolRequest = (request: HarnessToolRequest): Promise<unknown> => this.queuePolicyInteraction(policyScope, async () => {
      await turnReady
      const active = this.activeTurns.get(args.chatId)
      if (!isPolicyCurrent() || !active || active.turnId !== policyScope.turnId || active.pendingTool) {
        return { cancelled: true, error: "Native question expired" }
      }
      const tool = this.bindPolicyQuestion(policyScope, request.tool)
      this.policyApprovals.set(tool.toolId, policyScope)
      active.status = "waiting_for_user"
      try {
        const result = await new Promise<unknown>(resolve => {
          active.pendingTool = { toolUseId: tool.toolId, tool, resolve }
          this.emitStateChange(args.chatId)
        })
        return isPolicyCurrent() ? result : { cancelled: true, error: "Native question expired" }
      } finally { this.policyApprovals.delete(tool.toolId) }
    })

    if (args.provider === "claude") {
      logSendToStartingProfile(args.profile, "start_turn.provider_boot.begin", {
        chatId: args.chatId,
        provider: args.provider,
        model: args.model,
      })
      const claudeTurn = await this.startClaudeTurn({
        engineRuntime: args.engineRuntime,
        chatId: args.chatId,
        localPath: project.localPath,
        model: args.model,
        effort: args.effort,
        planMode: args.planMode,
        sessionToken: chat.pendingForkSessionToken ?? chat.sessionToken,
        forkSession: Boolean(chat.pendingForkSessionToken),
        executionControl: {
          permissionMode: executionPolicy.engine === "claude" ? executionPolicy.permissionMode : "default",
          isCurrent: isPolicyCurrent,
          canUseMemory,
          approve: async (name, input, requestId) => {
            if (!isPolicyCurrent() || executionPolicy.engine !== "claude") return false
            if (legacyExecution || isMemoryTool(name)) return true
            return executionPolicy.permissionMode !== "dontAsk" && await requestNativeApproval(name, input, requestId)
          },
          onToolRequest,
          onApplied: () => onExecutionPolicyApplied(),
        },
        onToolRequest,
        projectId: chat.projectId,
        memoryEnabled: !memoryDisabledForTurn,
        learnEnabled: args.memoryState?.learnActive !== false,
        memoryState: args.memoryState,
        memoryPlan: turnMemoryPlan,
        restrictMemoryIds: turnRestriction,
        startupReservation: reservation,
      })
      if (!claudeTurn) return
      turn = claudeTurn
      if (reservation?.cancelled || startController.signal.aborted || this.isEngineStartBlocked(args.chatId)) {
        turn.close()
        return
      }
      logSendToStartingProfile(args.profile, "start_turn.provider_boot.ready", {
        chatId: args.chatId,
        provider: args.provider,
        model: args.model,
      })
    } else if (args.provider === "pi" || args.provider === "opencode") {
      logSendToStartingProfile(args.profile, "start_turn.provider_boot.begin", {
        chatId: args.chatId,
        provider: args.provider,
        model: args.model,
      })
      // Pi and OpenCode share the injection plan and per-turn memory dispatch.
      // Both engines deliver changing memory through normal prompt content.
      // Each adapter binds the current dispatch context to its reused session.
      // "Proceed without memory" (preview gate) skips both the block and
      // dispatch for this turn.
      const piPlan: MemoryInjectionPlan | null = turnMemoryPlan
      const piMemorySpecs =
        this.memory
          ? buildMemoryToolSpecs(this.memory, {
              capture: args.memoryState?.learnActive === false ? null : this.capture,
              onProposed: (created, info) => {
                const autoIds = info?.resurfaced ? new Set<string>() : this.autoApplyProposals(created, { chatId: args.chatId, memoryState: args.memoryState })
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
      const piHostSpecs = this.hostActions ? hostActionToolSpecs() : []
      const piAllSpecs = [...piMemorySpecs, ...piHostSpecs]
      const piSelected = new Set(piPlan?.injectedMemories.map(item => item.id) ?? [])
      const piExpectedUses = (this.turnExpectedUses.get(args.chatId) ?? []).filter(use => piSelected.has(use.id))
      const piEnforced = (this.turnPayAttention.get(args.chatId) ?? []).filter(item => piSelected.has(item.id))
      const piMemoryBlock = [
        piPlan?.block ?? "",
        piExpectedUses.length ? `How the selected memories are expected to guide this turn:\n${piExpectedUses.map(use => `[${use.id}] ${use.expectedUse}`).join("\n")}` : "",
        ...piEnforced.map(item => `ENFORCED THIS RUN: [${item.id}] MUST be followed.${item.quote ? ` Previous violation: ${item.quote}` : ""}`),
        args.resume ? `RESUMING AN INTERRUPTED TURN: continue the existing conversation and completed work. Correction: ${args.resume.correction}` : "",
        args.resume?.enforce ? `ENFORCED THIS RUN: [${args.resume.memoryId}] MUST be followed. ${args.resume.correction}` : "",
      ].filter(Boolean).join("\n\n")
      if (args.resume?.enforce && !piSelected.has(args.resume.memoryId)) throw new Error("The enforced memory is no longer in Working Memory")
      if (this.memory && piPlan && piMemoryBlock) {
        this.memory.logger.event({
          type: "memory.inject",
          sessionId: args.chatId,
          engine: args.provider,
          memories: piPlan.injectedMemories.map((m) => ({ id: m.id, scope: m.scope })),
          tokenEstimate: Math.ceil(piMemoryBlock.length / 4),
          mode: piPlan.mode,
        })
      }
      const piMemoryDispatch = piAllSpecs.length
        ? async (name: string, toolArgs: Record<string, unknown>, signal?: AbortSignal, native?: HostNativeToolContext) => {
            if (isHostActionTool(name)) {
              if (!isPolicyCurrent()) return dispatchHostAction(undefined, undefined, name, toolArgs)
              return dispatchHostAction(this.hostActions, hostAdmission, name, toolArgs, native, signal)
            }
            if (!isPolicyCurrent()) return { text: "Execution policy changed or turn ended", isError: true }
            if (!canUseMemory(name)) return { text: "Memory access is disabled", isError: true }
            return dispatchMemoryTool(piMemorySpecs, name, toolArgs, {
              projectId: chat.projectId,
              sessionId: args.chatId,
              turn: turnNumber,
              engine: args.provider,
              allowedMemoryIds: piPlan?.injectedMemories.map(item => item.id) ?? [],
              memoryView: piPlan?.view,
            })
          }
        : undefined
      if (args.provider === "opencode") {
        const opencodeLaunch: import("./opencode-agent").StartOpencodeTurnArgs = {
          signal: startController.signal, chatId: args.chatId, cwd: project.localPath,
          content: buildPromptText(args.content, providerAttachments),
          model: args.engineRuntime?.model ?? args.model, runtime: args.engineRuntime,
          memoryContext: piMemoryBlock || undefined,
          prepareContext: target => this.prepareCurrentContext(args.chatId, target, { plan: piPlan, disabled: memoryDisabledForTurn,
            tools: toCodexDynamicTools(piMemorySpecs).map(t => ({ name: t.name, description: t.description, schema: t.inputSchema })) }),
          sessionToken: chat.pendingForkSessionToken ?? chat.sessionToken,
          forkSession: Boolean(chat.pendingForkSessionToken),
          memorySpecs: piAllSpecs.length ? piAllSpecs : undefined,
          memoryDispatch: piMemoryDispatch, onToolRequest,
          executionPolicy: !legacyExecution && executionPolicy.engine === "opencode" ? executionPolicy : undefined,
          isPolicyCurrent, onExecutionPolicyApplied,
          onPermissionRequest: request => requestNativeApproval(request.permission, { ...request }, request.id),
          onLaunch: launch => this.parentLaunches.set(args.chatId, launch),
        }
        turn = await this.opencodeManager.startTurn(opencodeLaunch)
      } else {
      const connection = args.engineRuntime?.piConnection ?? await this.resolvePiConnectionFn()
      if (reservation?.cancelled || startController.signal.aborted || this.isEngineStartBlocked(args.chatId)) return
      const piPrompt = buildPromptText(args.content, providerAttachments)
      const piLaunch: import("./pi-agent").StartPiTurnArgs = {
        signal: startController.signal,
        chatId: args.chatId,
        cwd: project.localPath,
        content: piMemoryBlock ? `${piMemoryBlock}\n\n${piPrompt}` : piPrompt,
        prepareContext: target => this.prepareCurrentContext(args.chatId, target, { plan: piPlan, disabled: memoryDisabledForTurn,
          tools: toCodexDynamicTools(piMemorySpecs).map(t => ({ name: t.name, description: t.description, schema: t.inputSchema })) }),
        model: args.engineRuntime?.model ?? args.model,
        effort: normalizePiModelOptions(undefined, args.effort).reasoningEffort,
        sessionToken: chat.pendingForkSessionToken ?? chat.sessionToken,
        forkSession: Boolean(chat.pendingForkSessionToken),
        connection,
        memorySpecs: piAllSpecs.length ? piAllSpecs : undefined,
        memoryDispatch: piMemoryDispatch,
        beforeToolCall: async (name, input) => await authorizeHostTool(name, input) && isPolicyCurrent() ? undefined : { block: true, reason: "Execution approval denied or expired" },
        isPolicyCurrent,
        onExecutionPolicyApplied,
        onLaunch: (launch) => this.parentLaunches.set(args.chatId, launch),
      }
      this.parentLaunches.set(args.chatId, { provider: "pi", options: { model: piLaunch.model, effort: piLaunch.effort, connection, memorySpecs: piLaunch.memorySpecs, toolNames: piLaunch.toolNames } })
      turn = await this.piManager.startTurn(piLaunch)
      }
      if (reservation?.cancelled || startController.signal.aborted || this.isEngineStartBlocked(args.chatId)) {
        turn.close()
        return
      }
      this.turnPayAttention.delete(args.chatId)
      args.onMemoryDeliveryAccepted?.(piPlan?.injectedMemories.map(item => item.id) ?? [])
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
      // when enabled, append the memory block through native developer-item
      // injection at the idle boundary, and dispatch item/tool/call to the memory
      // handler. File-mode contents are naturally fresh each turn.
      // "Proceed without memory" (preview gate): skip injection for this turn.
      // The dynamic tool declarations are thread-level and persist regardless.
      const codexPlan: MemoryInjectionPlan | null =
        this.memory && !memoryDisabledForTurn
          ? planMemoryInjection({
              memory: this.memory,
              projectId: chat.projectId,
              chatId: args.chatId,
              restrictToIds: turnRestriction,
            })
          : null
      // "Proceed without memory" must also cut off tool DISPATCH this turn —
      // not just the injected block (bug-hunt #9). (Codex dynamic-tool
      // DECLARATIONS are thread-level and persist across turns by protocol, but
      // with no dispatch handler a call this turn is a no-op.)
      const codexMemorySpecs =
        this.memory
          ? buildMemoryToolSpecs(this.memory, {
              capture: args.memoryState?.learnActive === false ? null : this.capture,
              onProposed: (created, info) => {
                // Redesign 2026-08-07 §3: mid-turn proposals park in the store
                // and surface at the NEXT turn's step-one gate. Only
                // auto-applied ones (delegating policy) card immediately —
                // they took effect without asking.
                const autoIds = info?.resurfaced ? new Set<string>() : this.autoApplyProposals(created, { chatId: args.chatId, memoryState: args.memoryState })
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
      const codexAllSpecs = [...codexMemorySpecs, ...(this.hostActions ? hostActionToolSpecs() : [])]
      const codexSelected = new Set(codexPlan?.injectedMemories.map(item => item.id) ?? [])
      const expectedUses = (this.turnExpectedUses.get(args.chatId) ?? []).filter(use => codexSelected.has(use.id))
      const enforced = (this.turnPayAttention.get(args.chatId) ?? []).filter(item => codexSelected.has(item.id))
      const codexMemoryBlock = [
        codexPlan?.block ?? "",
        expectedUses.length ? `How the selected memories are expected to guide this turn:\n${expectedUses.map(use => `[${use.id}] ${use.expectedUse}`).join("\n")}` : "",
        ...enforced.map(item => `ENFORCED THIS RUN: [${item.id}] MUST be followed.${item.quote ? ` Previous violation: ${item.quote}` : ""}`),
        args.resume ? `RESUMING AN INTERRUPTED TURN: continue the existing conversation and completed work. Correction: ${args.resume.correction}` : "",
        args.resume?.enforce ? `ENFORCED THIS RUN: [${args.resume.memoryId}] MUST be followed. ${args.resume.correction}` : "",
      ].filter(Boolean).join("\n\n")
      if (args.resume?.enforce && !codexSelected.has(args.resume.memoryId)) throw new Error("The enforced memory is no longer in Working Memory")
      if (this.memory && codexPlan && codexMemoryBlock) {
        this.memory.logger.event({
          type: "memory.inject",
          sessionId: args.chatId,
          engine: "codex",
          memories: codexPlan.injectedMemories.map((m) => ({ id: m.id, scope: m.scope })),
          tokenEstimate: Math.ceil(codexMemoryBlock.length / 4),
          mode: codexPlan.mode,
        })
      }
      const onDynamicToolCall = codexAllSpecs.length
        ? async (name: string, toolArgs: Record<string, unknown>, native?: HostNativeToolContext) => {
            if (isHostActionTool(name)) {
              if (!isPolicyCurrent()) return dispatchHostAction(undefined, undefined, name, toolArgs)
              return dispatchHostAction(this.hostActions, hostAdmission, name, toolArgs, native)
            }
            if (!isPolicyCurrent()) return { text: "Execution policy changed or turn ended", isError: true }
            if (!canUseMemory(name)) return { text: "Memory access is disabled", isError: true }
            const r = await dispatchMemoryTool(codexMemorySpecs, name, toolArgs, {
              projectId: chat.projectId,
              sessionId: args.chatId,
              turn: turnNumber,
              engine: "codex",
              allowedMemoryIds: codexPlan?.injectedMemories.map(item => item.id) ?? [],
              memoryView: codexPlan?.view,
            })
            return { text: r.text, isError: r.isError }
          }
        : undefined
      const codexLaunch: import("./codex-app-server").StartCodexSessionArgs = {
        runtime: args.engineRuntime,
        signal: startController.signal,
        chatId: args.chatId,
        cwd: project.localPath,
        model: args.model,
        serviceTier: args.serviceTier,
        sessionToken: chat.sessionToken,
        pendingForkSessionToken: chat.pendingForkSessionToken,
        dynamicTools: codexAllSpecs.length ? toCodexDynamicTools(codexAllSpecs) : undefined,
        executionPolicy: !legacyExecution && executionPolicy.engine === "codex" ? executionPolicy : undefined,
      }
      this.parentLaunches.set(args.chatId, { provider: "codex", session: { model: codexLaunch.model, serviceTier: codexLaunch.serviceTier, dynamicTools: codexLaunch.dynamicTools, runtime: codexLaunch.runtime }, turn: { model: args.model, effort: args.effort as any, serviceTier: args.serviceTier, planMode: args.planMode, developerInstructions: codexMemoryBlock || undefined } })
      const sessionToken = await this.codexManager.startSession(codexLaunch)
      // thread/start|resume acknowledged this exact policy before the idle developer append.
      // turn/start still rechecks policy scope and acknowledges its own native boundary.
      if (codexLaunch.executionPolicy) await onExecutionPolicyApplied(sessionToken ?? undefined)
      const launch = this.parentLaunches.get(args.chatId)
      if (sessionToken && launch) this.sessionLaunches.set(`codex:${sessionToken}`, launch)
      if (reservation?.cancelled || startController.signal.aborted || this.isEngineStartBlocked(args.chatId)) {
        return
      }
      if (chat.pendingForkSessionToken && sessionToken) {
        await this.store.setPendingForkSessionToken(args.chatId, null)
        if (reservation?.cancelled || startController.signal.aborted || this.isEngineStartBlocked(args.chatId)) {
          return
        }
      }
      logSendToStartingProfile(args.profile, "start_turn.session_ready", {
        chatId: args.chatId,
        provider: args.provider,
        model: args.model,
      })
      try {
        turn = await this.codexManager.startTurn({
          signal: startController.signal,
          chatId: args.chatId,
          content: buildPromptText(args.hostPrompt ?? args.content, providerAttachments),
          model: args.model,
          effort: args.effort as any,
          serviceTier: args.serviceTier,
          planMode: args.planMode,
          onToolRequest,
          executionPolicy: !legacyExecution && executionPolicy.engine === "codex" ? executionPolicy : undefined,
          isPolicyCurrent, onExecutionPolicyApplied,
          onApprovalRequest: async request => await requestNativeApproval(request.kind === "command_execution" ? "commandExecution" : "fileChange", { ...request.params }, `${typeof request.requestId}:${request.requestId}`) && isPolicyCurrent() ? "accept" : "decline",
          nativeSkill: args.nativeSkill,
          reviewTarget: args.nativeReview,
          developerInstructions: codexMemoryBlock || undefined,
          prepareContext: target => this.prepareCurrentContext(args.chatId, target, { plan: codexPlan, disabled: memoryDisabledForTurn,
            tools: toCodexDynamicTools(codexMemorySpecs).map(t => ({ name: t.name, description: t.description, schema: t.inputSchema })) }),
          onDynamicToolCall,
        })
      } catch (error) {
        if (startController.signal.aborted || this.isEngineStartBlocked(args.chatId)) {
          return
        }
        throw error
      }
      if (reservation?.cancelled || startController.signal.aborted || this.isEngineStartBlocked(args.chatId)) {
        turn.close()
        return
      }
      this.turnPayAttention.delete(args.chatId)
      args.onMemoryDeliveryAccepted?.(codexPlan?.injectedMemories.map(item => item.id) ?? [])
      logSendToStartingProfile(args.profile, "start_turn.provider_boot.ready", {
        chatId: args.chatId,
        provider: args.provider,
        model: args.model,
      })
    }

    if (reservation?.cancelled || startController.signal.aborted || this.isEngineStartBlocked(args.chatId)) {
      startController.abort()
      turn.close()
      return
    }

    const parentLaunch = this.parentLaunches.get(args.chatId)
    const active: ActiveTurn = {
      engineRuntime: args.engineRuntime ? structuredClone(args.engineRuntime) : undefined,
      parentLaunch: parentLaunch ? snapshotParentLaunch(parentLaunch) : undefined,
      analysisPolicyKey: this.memoryAnalysisPolicyKey(args.chatId, args.provider),
      projectId: chat.projectId,
      localPath: project.localPath,
      sessionToken: chat.sessionToken,
      expectedUses: this.turnExpectedUses.get(args.chatId)?.map(use => ({ ...use })),
      memoryState: args.memoryState ?? { control: "review", memoryActive: true, learnActive: true },
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
      startupReservation: reservation,
      providerTurnStarted: false,
      clientTraceId: args.profile?.traceId,
      profilingStartedAt: args.profile?.startedAt,
      turnNumber,
      turnId: args.turnId!,
      memoryPlan: turnMemoryPlan,
      // Capture/trace judge the user's real words, not the steer wrapper (BUG AGENT-4).
      userText: args.memoryUserText ?? args.content,
      assistantChunks: [],
      citedIds: new Set<string>(),
      memoryDisabled: memoryDisabledForTurn,
      // Pi accepts its memory block inside the user prompt (there is no
      // developer_instructions channel) — delivery counts like Codex's.
      memoryDeliveryAccepted: args.provider === "codex" || args.provider === "pi" || args.provider === "opencode",
      injectedIds: injectedIdsAtBoot,
    }
    this.activeTurns.set(args.chatId, active)
    bootedActive = active
    admitTurn()
    } catch (error) {
      const scope = this.policyScopes.get(args.chatId)
      if (scope) {
        const state = this.harnessPolicies.failed(scope, error instanceof Error ? error.message : String(error))
        if (state) await this.store.setExecutionPolicyState?.(args.chatId, state)
      }
      if ((args.provider === "pi" || args.provider === "opencode") && (startController.signal.aborted || this.isEngineStartBlocked(args.chatId))) return
      throw error
    } finally {
      admitTurn()
      if (!bootedActive) this.endPolicyTurn(args.chatId, args.turnId)
      if (this.engineStartAbortControllers.get(args.chatId) === startController) {
        this.engineStartAbortControllers.delete(args.chatId)
      }
      if (reservation?.controller === startController) reservation.controller = undefined
      if (args.provider === "codex" && !bootedActive && (startController.signal.aborted || this.isEngineStartBlocked(args.chatId))) {
        if (this.canStopStartupSession(args.chatId, reservation)) this.codexManager.stopSession(args.chatId)
      }
    }
    const active = bootedActive
    if (!active) return
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
      let nextMemoryBaseline: import("./memory/injection").MemoryBaseline | null = null
      let deliveredMemoryView = active.memoryPlan?.view
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
        deliveredMemoryView = delta.view
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
              this.releaseStartupStatus(args.chatId, args.startupReservation)
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
              `continue from where it stopped.${selectionNote} User correction: ${resumeCtx.correction}`,
          )
        }
        const expectedUses = (this.turnExpectedUses.get(args.chatId) ?? []).filter(use => deliveredFocusIds.includes(use.id))
        if (this.memoryBranches) this.turnExpectedUses.set(args.chatId, expectedUses)
        else this.turnExpectedUses.delete(args.chatId)
        if (expectedUses?.length) {
          deliveredExpectedUses = expectedUses
          const detailIds = expectedUses.filter((use) => Boolean(this.memory!.store.getById(use.id)?.detail)).map((use) => use.id)
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
          (turnRestriction === undefined || turnRestriction.length > 0)
        if (memoryBearingTurn) {
          reminderParts.push(CITE_NUDGE)
          // Tool salience for DeepSeek: only when the working set really has
          // [+detail] items (stable string — constant cache cost).
          const injectedNow = this.memory!.injectedFor(chat.projectId, args.chatId)
          if (injectedNow.some((m) => m.detail && (turnRestriction === undefined || turnRestriction.includes(m.id)))) {
            reminderParts.push(DETAIL_NUDGE)
          }
        }
        if (active.memoryState.learnActive && this.capture) reminderParts.push(CAPTURE_NUDGE)
        if (reminderParts.length > 0) {
          promptText += `\n\n<system-reminder>\n${reminderParts.join("\n\n")}\n</system-reminder>`
        }
      }
      const promptSeq = session.nextPromptSeq + 1
      session.nextPromptSeq = promptSeq
      const promptId = crypto.randomUUID()
      session.pendingPrompts.push({ seq: promptSeq, id: promptId })
      active.claudePromptSeq = promptSeq
      logClaudeSteer("claude_prompt_sent", {
        chatId: args.chatId,
        sessionId: session.id,
        promptSeq,
        activeStatus: active.status,
        contentPreview: args.content.slice(0, 160),
        pendingPromptSeqs: session.pendingPrompts.map(prompt => prompt.seq),
      })
      try {
        await session.session.sendPrompt(promptText, {
          allowedMemoryIds: deliveredFocusIds,
          memoryView: deliveredMemoryView,
          turn: active.turnNumber ?? turnNumber,
          engine: "claude",
          promptSeq,
          promptId,
          prepareContext: target => {
            const prepared = this.prepareCurrentContext(args.chatId, target, { plan: active.memoryPlan ? { ...active.memoryPlan,
              injectedMemories: deliveredFocusedMemories, view: deliveredMemoryView! } : null, disabled: memoryDisabledForTurn })
            return { text: prepared.text, accepted: () => {
              if (session.retired || active.cancelRequested) return
              prepared.accepted()
              if (nextMemoryBaseline) session.memoryBaseline = nextMemoryBaseline
            } }
          },
        })
      } catch (error) {
        // A rejected prompt cannot leave this turn or provider session active.
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
        throw error
      }
      if (reservation?.cancelled || active.cancelRequested || this.activeTurns.get(args.chatId) !== active) {
        return
      }
      active.memoryDeliveryAccepted = true
      this.turnPayAttention.delete(args.chatId)
      active.injectedIds = deliveredFocusIds
      if (active.memoryPlan) active.memoryPlan = { ...active.memoryPlan, injectedMemories: deliveredFocusedMemories.map(item => ({ ...item })) }
      args.onMemoryDeliveryAccepted?.([...deliveredFocusIds])
      if (active.memoryState.memoryActive && this.memory) {
        try {

            recordDeliveredStoreFocus({
              logger: this.memory.logger,
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

        } catch (error) {
          this.reportBackgroundError?.(
            `[memory-focus] chat ${args.chatId} turn ${active.turnNumber ?? turnNumber}: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
      logSendToStartingProfile(args.profile, "start_turn.claude_prompt_sent", {
        chatId: args.chatId,
      })
      return
    }

    void this.runTurn(active)
  }

  private async startClaudeTurn(args: {
    engineRuntime?: EngineRuntime
    chatId: string
    localPath: string
    model: string
    effort?: string
    planMode: boolean
    sessionToken: string | null
    forkSession: boolean
    executionControl?: ClaudeExecutionControl
    onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
    projectId?: string
    /** false = "proceed without memory": boot/reboot the session without the memory block/tools. */
    memoryEnabled?: boolean
    learnEnabled?: boolean
    memoryState?: TurnMemoryState
    /** Exact plan already computed for this turn. */
    memoryPlan?: MemoryInjectionPlan | null
    /** Exact turn-only selection confirmed by the gate or interrupt recovery card. */
    restrictMemoryIds?: string[]
    startupReservation?: StartupReservation
    signal?: AbortSignal
  }): Promise<HarnessTurn | null> {
    const current = () => !args.signal?.aborted && this.startupReservationIsCurrent(args.chatId, args.startupReservation)
    if (!current()) return null
    let session = this.claudeSessions.get(args.chatId)
    const memoryEnabled = args.memoryEnabled ?? true
    const engineRuntime = args.engineRuntime ?? await resolveEngineRuntime({ engine: "claude", model: args.model })
    const subprocessEnv = engineRuntime.env
    // Endpoint, credentials, profile and native limits belong to the process.
    // Account-mode model changes may use setModel; every other launch field
    // (including output/context limits and executable identity) must match.
    const providerRuntimeKey = captureRuntimeFingerprint({
      ...engineRuntime, model: engineRuntime.isolated ? engineRuntime.model : '',
    })

    // What forces a session rebuild (REDESIGN D1): enabled/disabled flips,
    // and tools flips. Skills-mode content changes deliberately do
    // NOT rebuild: they ride the next user turn as a delta block, so the
    // prompt cache survives every edit/accept/archive. The key comes from the
    // same plan the session boot uses, so check and boot can never disagree.
    const turnPlan = args.memoryPlan !== undefined
      ? args.memoryPlan
      : memoryEnabled && this.memory
        ? planMemoryInjection({
            memory: this.memory,
            projectId: args.projectId,
            chatId: args.chatId,
            restrictToIds: args.restrictMemoryIds,
          })
        : null
    const desiredMemoryHash = (turnPlan?.sessionRebuildKey ?? "memory-off")
      + (memoryEnabled ? `:learn=${args.learnEnabled !== false}` : "")
    if (
      !session ||
      session.retired ||
      session.localPath !== args.localPath ||
      session.effort !== args.effort ||
      session.memorySetHash !== desiredMemoryHash ||
      session.providerRuntimeKey !== providerRuntimeKey ||
      args.forkSession
    ) {
      let resumeToken = session?.sessionToken ?? args.sessionToken
      // Engine session files live on the container FS, not the /data volume:
      // after a container rebuild/recreate the stored token has no backing
      // file, resume fails as a misleading "native binary failed to launch",
      // and the chat is permanently stuck. Validate and fall back to a fresh
      // session (context lost, chat alive).
      if (resumeToken && !this.claudeSessionFileExists(args.localPath, resumeToken, undefined, engineRuntime.env)) {
        console.warn(
          `[claude] resume token for chat ${args.chatId} has no session file (recreated container?) — starting fresh`,
        )
        resumeToken = null
        await this.store.setSessionToken(args.chatId, null)
      }
      if (!current()) return null
      if (session) {
        await this.retireClaudeSession(session, "session_rebuild")
      }
      if (!current()) return null

      const started = await this.startClaudeSessionFn({
        localPath: args.localPath,
        model: args.model,
        effort: args.effort,
        planMode: args.planMode,
        sessionToken: resumeToken,
        forkSession: args.forkSession,
        onToolRequest: args.onToolRequest,
        hostActionsEnabled: Boolean(this.hostActions),
        executionControl: args.executionControl,
        memory: memoryEnabled ? this.memory : null,
        capture: memoryEnabled && args.learnEnabled !== false ? this.capture : null,
        projectId: args.projectId,
        chatId: args.chatId,
        subprocessEnv,
        engineRuntime,
        memoryPlan: turnPlan,
        restrictMemoryIds: args.restrictMemoryIds,
        // Redesign 2026-08-07 §3: agent-channel proposals park in the store
        // and surface at the NEXT turn's step-one gate, same as hook-channel
        // ones. Only auto-applied proposals (delegating policy) card
        // immediately — they took effect without asking.
        onMemoryProposal: (created) => {
          if (!memoryEnabled || args.learnEnabled === false) return
          const autoIds = this.autoApplyProposals(created, { chatId: args.chatId, memoryState: this.activeTurns.get(args.chatId)?.memoryState })
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
      if (!current()) {
        try {
          started.close()
        } catch (error) {
          this.reportBackgroundError?.(
            `[claude-retire] chat ${args.chatId}: stale startup close failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        return null
      }
      if (started.parentLaunch) this.parentLaunches.set(args.chatId, started.parentLaunch)
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
        sessionTokenPromptSeq: 0,
        accountInfoLoaded: false,
        nextPromptSeq: 0,
        pendingPrompts: [],
        cancelledPromptSeqs: new Set(),
        echoesPromptIds: started.echoesPromptIds ?? false,
        retired: false,
        retireReason: null,
        pump: null,
        memoryState: args.memoryState,
        memorySetHash: desiredMemoryHash,
        providerRuntimeKey,
        memoryBaseline:
          bootPlan?.mode === "skills"
            ? bootPlan.baseline
            : null,
      }
      this.claudeSessions.set(args.chatId, session)
      session.pump = this.runClaudeSession(session)
    } else {
      // Query callbacks outlive the boot turn; replace every turn's dispatch context.
      session.session.setExecutionControl?.(args.executionControl)
      if (session.model !== args.model) {
        await session.session.setModel(args.model)
        session.model = args.model
      }
      if (session.planMode !== args.planMode) {
        await session.session.setPermissionMode(args.planMode)
        session.planMode = args.planMode
      }
    }

    session.session.setExecutionControl?.(args.executionControl)
    session.memoryState = args.memoryState
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

  private executionPolicyFor(chatId: string, engine: AgentProvider) {
    const chat = this.store.requireChat(chatId)
    this.harnessPolicies.reconcileNativeRuntime(chatId, engine, this.harnessNativeRuntime(chatId, engine))
    return chat.executionPolicies?.[engine] ?? { policy: defaultExecutionPolicy(engine, !chat.executionPolicyVersion), revision: 1 }
  }

  getHarnessSnapshot(chatId: string, engine?: AgentProvider) {
    const chat = this.store.getChat(chatId)
    if (!chat || chat.deletedAt) return undefined
    if (engine && !["claude", "codex", "pi", "opencode"].includes(engine)) throw new Error("Invalid harness engine")
    if (engine && chat.provider && chat.provider !== engine) throw new Error("Execution policy engine does not match the chat")
    // Before the first turn, the pushed snapshot follows the engine the composer is preparing.
    const prepared = this.commandPreparations.get(chatId)?.selection.provider ?? this.commandSelections.get(chatId)?.provider
    const selected = this.executionPolicyFor(chatId, engine ?? chat.provider ?? prepared ?? "claude")
    return this.harnessPolicies.snapshot(chatId, selected.policy, selected.revision, chat.executionPolicyStates?.[selected.policy.engine], this.harnessRuntimeVersion(selected.policy.engine, lastEngineExecutable(selected.policy.engine)?.version), this.harnessNativeRuntime(chatId, selected.policy.engine))
  }

  private harnessNativeRuntime(chatId: string, engine: AgentProvider): "absent" | "starting" | "present" {
    const claude = this.claudeSessions.get(chatId)
    const native = engine === "claude" ? claude?.session.commandRuntime
      : engine === "codex" ? this.codexManager.getCommandRuntime?.(chatId)
      : engine === "opencode" ? this.opencodeManager.getCommandRuntime?.(chatId)
      : this.piManager.getCommandRuntime?.(chatId)
    // A retiring Claude pump remains a native handle until it has drained.
    const present = engine === "claude" ? Boolean(claude?.pump || native?.alive())
      : native ? native.alive()
      : engine === "codex" && !this.codexManager.getCommandRuntime ? Boolean(this.codexManager.hasSession?.(chatId))
      : engine === "opencode" && !this.opencodeManager.getCommandRuntime ? Boolean(this.opencodeManager.hasSession?.(chatId)) : false
    if (present) return "present"
    return this.engineStartAbortControllers.has(chatId) ? "starting" : "absent"
  }

  private async retireHarnessPolicyIfAbsent(chatId: string) {
    const chat = this.store.getChat(chatId)
    if (!chat?.provider || this.harnessNativeRuntime(chatId, chat.provider) !== "absent") return
    const selected = this.executionPolicyFor(chatId, chat.provider)
    this.harnessPolicies.ensure(chatId, selected.policy, selected.revision, chat.executionPolicyStates?.[chat.provider])
    const state = this.harnessPolicies.nativeRuntimeRetired(chatId, chat.provider)
    await this.store.setExecutionPolicyState?.(chatId, state)
  }

  private harnessRuntimeVersion(engine: AgentProvider, version?: string) {
    return engine === "pi" && process.env.MEMOSYNC_EXTERNAL_AGENTS !== "1" ? "1.5.0" : version
  }

  getEngineCapabilities(engine: AgentProvider) {
    if (!["claude", "codex", "pi", "opencode"].includes(engine)) throw new Error("Invalid harness engine")
    return this.harnessPolicies.registry.snapshot(engine, this.harnessRuntimeVersion(engine, lastEngineExecutable(engine)?.version))
  }

  async setExecutionPolicy(command: Extract<ClientCommand, { type: "chat.setExecutionPolicy" }>) {
    if (!isNativeExecutionPolicy(command.policy)) throw new Error("Invalid execution policy")
    const chat = this.store.requireChat(command.chatId)
    if (chat.deletedAt) throw new Error("Chat deleted")
    if (chat.provider && chat.provider !== command.policy.engine) throw new Error("Execution policy engine does not match the chat")
    if (this.policyChanges.has(command.chatId)) throw new Error("Execution policy change in progress")
    const selected = this.executionPolicyFor(command.chatId, command.policy.engine)
    this.harnessPolicies.snapshot(command.chatId, selected.policy, selected.revision, chat.executionPolicyStates?.[command.policy.engine], this.harnessRuntimeVersion(command.policy.engine, lastEngineExecutable(command.policy.engine)?.version))
    const running = this.harnessNativeRuntime(command.chatId, command.policy.engine) !== "absent"
    const state = this.harnessPolicies.request(command.chatId, command.policy, command.expectedRevision, running)
    this.policyChanges.add(command.chatId)
    this.cancelAutomaticCapture(command.chatId, 'execution-policy-changed')
    this.cancelAudits(command.chatId)
    this.disposeMemoryBranches(command.chatId)
    this.abortEngineStart(command.chatId)
    // Revocation is synchronous; persistence and native interruption follow it.
    this.emitStateChange(command.chatId)
    try {
      await this.store.setExecutionPolicyState(command.chatId, state, true)
      if (running || this.activeTurns.has(command.chatId) || this.drainingStreams.has(command.chatId) || this.startingChats.has(command.chatId)) await this.cancel(command.chatId, { skipPostTurnMemoryPasses: true })
      const session = this.claudeSessions.get(command.chatId)
      if (session) await this.retireClaudeSession(session, "session_rebuild")
      await this.codexManager.stopSession(command.chatId)
      this.piManager.closeChat(command.chatId)
      await this.opencodeManager.closeChat(command.chatId)
      this.parentLaunches.delete(command.chatId)
      // Some adapters stop asynchronously. A remaining live handle is still pending retirement.
      const retired = this.harnessNativeRuntime(command.chatId, command.policy.engine) === "present"
        ? this.harnessPolicies.state(command.chatId, command.policy.engine)
        : this.harnessPolicies.nativeRuntimeRetired(command.chatId, command.policy.engine)
      await this.store.setExecutionPolicyState(command.chatId, retired)
      return retired
    } catch (error) {
      this.releasePolicyInteraction(command.chatId)
      throw error
    } finally {
      this.policyChanges.delete(command.chatId)
      this.emitStateChange(command.chatId)
    }
  }

  private bindPolicyQuestion(scope: PolicyCallScope, tool: HarnessToolRequest["tool"]): HarnessToolRequest["tool"] {
    const key = `${scope.chatId}:${scope.engine}:${scope.generation}:${tool.toolId}`
    let toolId = this.questionToolIds.get(key)
    if (!toolId) {
      toolId = `native-question:${scope.generation}:${crypto.randomUUID()}`
      this.questionToolIds.set(key, toolId)
    }
    return { ...tool, toolId }
  }

  private bindPolicyEntry(scope: PolicyCallScope, entry: TranscriptEntry): TranscriptEntry {
    if (entry.kind === "tool_call" && (entry.tool.toolKind === "ask_user_question" || entry.tool.toolKind === "exit_plan_mode")) {
      return { ...entry, tool: this.bindPolicyQuestion(scope, entry.tool as HarnessToolRequest["tool"]) }
    }
    if (entry.kind === "tool_result") {
      const toolId = this.questionToolIds.get(`${scope.chatId}:${scope.engine}:${scope.generation}:${entry.toolId}`)
      if (toolId) return { ...entry, toolId }
    }
    return entry
  }

  private queuePolicyInteraction<T>(scope: PolicyCallScope, run: () => Promise<T>): Promise<T> {
    const previous = this.interactionQueues.get(scope.chatId) ?? Promise.resolve()
    const task = previous.catch(() => {}).then(run)
    this.interactionQueues.set(scope.chatId, task)
    void task.finally(() => { if (this.interactionQueues.get(scope.chatId) === task) this.interactionQueues.delete(scope.chatId) }).catch(() => {})
    return task
  }

  private releasePolicyInteraction(chatId: string) {
    const active = this.activeTurns.get(chatId)
    if (active?.pendingTool && this.policyApprovals.has(active.pendingTool.toolUseId)) {
      const pending = active.pendingTool
      active.pendingTool = null
      pending.resolve({ cancelled: true, error: "Execution request expired" })
    }
  }

  private endPolicyTurn(chatId: string, turnId?: string, release = true) {
    const scope = this.policyScopes.get(chatId)
    if (!scope || turnId && scope.turnId !== turnId) return
    this.harnessPolicies.endTurn(scope)
    if (release) this.releasePolicyInteraction(chatId)
    for (const key of this.questionToolIds.keys()) if (key.startsWith(`${scope.chatId}:${scope.engine}:${scope.generation}:`)) this.questionToolIds.delete(key)
    this.policyScopes.delete(chatId)
  }

  private async requestExecutionApproval(scope: PolicyCallScope, name: string, input: Record<string, unknown>, requestId: string = crypto.randomUUID()): Promise<boolean> {
    return this.queuePolicyInteraction(scope, async () => {
      if (!this.harnessPolicies.isCurrent(scope)) return false
      const active = this.activeTurns.get(scope.chatId)
      if (!active || active.turnId !== scope.turnId || active.pendingTool) return false
      const toolId = `approval:${scope.generation}:${requestId}:${crypto.randomUUID()}`
      const question = `Allow ${name} once?\n${JSON.stringify(input, null, 2)}`
      const tool = normalizeToolCall({ toolName: "AskUserQuestion", toolId, input: { questions: [{ question, header: "Execution approval", options: [{ label: "Allow once", description: "Authorize only this native request." }, { label: "Deny", description: "Reject this native request." }], multiSelect: false }] } }) as HarnessToolRequest["tool"]
      this.policyApprovals.set(toolId, Object.freeze({ ...scope, requestId }))
      await this.store.appendMessage(scope.chatId, timestamped({ kind: "tool_call", tool }))
      if (!this.harnessPolicies.isCurrent(scope) || this.activeTurns.get(scope.chatId) !== active) { this.policyApprovals.delete(toolId); return false }
      active.status = "waiting_for_user"
      const result = await new Promise<unknown>(resolve => {
        active.pendingTool = { toolUseId: toolId, tool, resolve }
        this.emitStateChange(scope.chatId)
      })
      this.policyApprovals.delete(toolId)
      const answers = result && typeof result === "object" ? (result as { answers?: Record<string, unknown> }).answers : undefined
      const answer = answers?.[question]
      const approved = answer === "Allow once" || (Array.isArray(answer) && answer.length === 1 && answer[0] === "Allow once")
      return approved && this.harnessPolicies.isCurrent(scope) && this.activeTurns.get(scope.chatId) === active
    })
  }

  async setMemoryDisabled(chatId: string, disabled: boolean) {

    if (typeof disabled !== "boolean") throw new Error("disabled must be a boolean")
    await this.store.setMemoryDisabled(chatId, disabled)
    this.memorySettingsChanged(chatId)
    this.emitStateChange(chatId)
  }

  async send(command: Extract<ClientCommand, { type: "chat.send" }>, hostClientId?: string, nativeCommandValidated: boolean | RuntimeCommand = false) {
    if (command.memoryDisabled !== undefined && typeof command.memoryDisabled !== "boolean") {
      throw new Error("memoryDisabled must be a boolean")
    }
    const profile = command.clientTraceId
      ? { traceId: command.clientTraceId, startedAt: performance.now() }
      : null
    let chatId = command.chatId

    logSendToStartingProfile(profile, "chat_send.received", {
      existingChatId: command.chatId ?? null,
      projectId: command.projectId ?? null,
    })

    if (!chatId) {
      if (!command.projectId) {
        throw new Error("Missing projectId for new chat")
      }
      const created = await this.store.createChat(command.projectId)
      chatId = created.id
      if (command.memoryDisabled !== undefined) {
        await this.store.setMemoryDisabled(chatId, command.memoryDisabled)
      }
      logSendToStartingProfile(profile, "chat_send.chat_created", {
        chatId,
        projectId: command.projectId,
      })
    }

    const chat = this.store.requireChat(chatId)
    const provider = this.resolveProvider(command, chat.provider)
    if (this.commandRegistry.isRunning(chatId)) throw new Error('Native context control is running')
    if (chat.draft && command.memoryDisabled !== undefined) {
      await this.store.setMemoryDisabled(chatId, command.memoryDisabled)
    }
    if (!nativeCommandValidated && command.content.trimStart().startsWith('/')) {
      if (command.attachments?.length) throw new Error('Native commands do not accept attachments')
      const match = command.content.trim().match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/)
      const selection: RuntimeCommandSelection = { provider, model: command.model, modelOptions: command.modelOptions, planMode: command.planMode }
      if (!this.getCommandCatalog(chatId).runtime || command.model || command.modelOptions || command.planMode !== undefined) {
        await this.readCommandCatalog(chatId, false, selection)
      }
      await this.commandPreparations.get(chatId)?.promise
      const catalog = await this.readCommandCatalog(chatId)
      const entry = match && catalog.commands.items.find(item => item.name === match[1])
      if (!entry || !catalog.runtimeKey) throw new Error('Command unavailable in the current native session; refresh its catalog')
      if (chat.draft) {
        await this.store.promoteDraft(chatId)
        this.emitStateChange()
      }
      return this.executeCommand({ type: 'chat.executeCommand', chatId, runtimeKey: catalog.runtimeKey, expectedRevision: catalog.revision,
        commandId: entry.id, arguments: match?.[2] ?? '' }, hostClientId)
    }
    if (chat.draft) {
      await this.store.promoteDraft(chatId)
      // Promotion can also open the project: refresh local-project subscribers
      // as well as chat/sidebar subscribers, including native slash submissions.
      this.emitStateChange()
    }
    if (
      this.activeTurns.has(chatId)
      || this.hasPendingPreviewActivity(chatId)
      || this.startingChats.has(chatId)
    ) {
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
    this.commandSelections.set(chatId, { provider, model: command.model, modelOptions: command.modelOptions, planMode: command.planMode })

    await this.startTurnForChat({
      chatId,
      provider,
      content: command.content,
      nativeSkill: typeof nativeCommandValidated === "object" ? nativeCommandValidated.nativeSkill : undefined,
      nativeReview: typeof nativeCommandValidated === 'object' && nativeCommandValidated.route === 'review-start'
        ? parseCodexReviewTarget(command.content.replace(/^\/review(?:\s+|$)/, '')) : undefined,
      hostPrompt: typeof nativeCommandValidated === 'object' && nativeCommandValidated.route === 'host-prompt' ? CODEX_INIT_PROMPT : undefined,
      attachments: command.attachments ?? [],
      connectionId: settings.connectionId,
      model: settings.model,
      effort: settings.effort,
      serviceTier: settings.serviceTier,
      planMode: settings.planMode,
      appendUserPrompt: true,
      hostClientId,
      profile,
    })

    logSendToStartingProfile(profile, "chat_send.ready_for_ack", {
      chatId,
      provider,
      connectionId: settings.connectionId,
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
    this.emitStateChange(command.chatId)
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

  private takeAnsweredClaudePrompts(session: ClaudeSessionState, event: HarnessEvent): number[] {
    if (event.promptIds?.length) {
      session.echoesPromptIds = true
      const answered = session.pendingPrompts.filter(prompt => event.promptIds!.includes(prompt.id))
      session.pendingPrompts = session.pendingPrompts.filter(prompt => !event.promptIds!.includes(prompt.id))
      return answered.map(prompt => prompt.seq)
    }
    const endedEarly = event.entry?.kind === "interrupted" || (event.entry?.kind === "result" && event.entry.isError)
    if (session.echoesPromptIds && !endedEarly) return []
    const head = session.pendingPrompts.shift()
    return head ? [head.seq] : []
  }

  private async runClaudeSession(session: ClaudeSessionState) {
    try {
      for await (const event of session.session.stream) {
        if (session.retired || this.claudeSessions.get(session.chatId) !== session) {
          this.reportBackgroundError?.(
            `[claude-retired-event] dropped ${event.entry?.kind ?? event.type} for chat ${session.chatId} after ${session.retireReason ?? "retirement"}`,
          )
          continue
        }
        // Tagged stale results (including their token/usage metadata) cannot
        // mutate a later turn. Unidentified successful background results also
        // cannot consume a prompt on a UUID-capable session.
        const matchingPrompts = event.promptIds?.length
          ? session.pendingPrompts.filter(prompt => event.promptIds!.includes(prompt.id)) : []
        if (event.promptIds?.length && matchingPrompts.length === 0) continue
        this.cancelIdleClose(session.chatId)
        this.updateIdleClose(session.chatId)
        const userOrigin = event.origin === "human"
          || ((event.origin === undefined || event.origin === "unknown"))
        if (!userOrigin) {
          this.reportBackgroundError?.(
            `[claude-background-event] dropped ${event.entry?.kind ?? event.type} with origin ${event.origin} for chat ${session.chatId}`,
          )
          continue
        }
        if (event.type === "session_token" && event.sessionToken) {
          // A cancelled prompt may still supply the newest resume token. Keep
          // it unless a later prompt has already supplied a token of its own.
          const promptSeq = matchingPrompts.length > 0
            ? Math.max(...matchingPrompts.map(prompt => prompt.seq)) : session.nextPromptSeq
          if (promptSeq < session.sessionTokenPromptSeq) continue
          session.sessionTokenPromptSeq = promptSeq
          const launch = this.parentLaunches.get(session.chatId)
          if (launch) this.sessionLaunches.set(`claude:${event.sessionToken}`, launch)
          session.sessionToken = event.sessionToken
          const tokenOwner = this.activeTurns.get(session.chatId)
          if (tokenOwner?.provider === 'claude' && tokenOwner.claudePromptSeq === promptSeq) tokenOwner.sessionToken = event.sessionToken
          await this.store.setSessionToken(session.chatId, event.sessionToken)
          this.emitStateChange(session.chatId)
          continue
        }

        if (event.type === "assistant_delta") {
          this.appendAssistantDelta(session.chatId, event)
          continue
        }

        if (!event.entry) continue
        // Result-derived usage arrives before the result itself. Suppress it
        // without consuming the reservations needed to attribute that result.
        if (event.entry.kind === "context_window_updated" && matchingPrompts.length > 0
          && matchingPrompts.every(prompt => session.cancelledPromptSeqs.has(prompt.seq))) continue
        const completedPromptSeqs = event.entry.kind === "result" || event.entry.kind === "interrupted"
          ? this.takeAnsweredClaudePrompts(session, event) : []
        if ((event.entry.kind === "result" || event.entry.kind === "interrupted") && completedPromptSeqs.length === 0) continue
        // Stop already persisted the interruption. A late SDK result belongs
        // to the cancelled prompts, even if steer has started a new turn.
        const cancelledResult = completedPromptSeqs.length > 0
          && completedPromptSeqs.every(seq => session.cancelledPromptSeqs.has(seq))
        for (const seq of completedPromptSeqs) session.cancelledPromptSeqs.delete(seq)
        if (cancelledResult && event.entry.kind === "result") continue
        if (event.entry.kind === "assistant_text" || event.entry.kind === "result" || event.entry.kind === "interrupted") {
          // Final text replaces the streaming preview in the same broadcast;
          // result/interrupted also sweep it in case no final text arrived.
          this.clearStreamingAssistantText(session.chatId)
        }
        const policyScope = this.policyScopes.get(session.chatId)
        if (policyScope) event.entry = this.bindPolicyEntry(policyScope, event.entry)
        await this.store.appendMessage(session.chatId, event.entry)
        const active = this.activeTurns.get(session.chatId)
        if (event.entry.kind === "compact_boundary") this.invalidateNativeContext(session.chatId)
        if (event.entry.kind === "compact_boundary" && (active?.memoryState ?? session.memoryState)?.memoryActive !== false) {
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
          const counted = this.recordMemoryCitations(event.entry.text, session.chatId, active?.memoryState ?? session.memoryState)
          if (active) {
            active.assistantChunks.push(event.entry.text)
            for (const id of counted) active.citedIds.add(id)
          }
        }
        if (event.entry.kind === "system_init" && active) {
          void this.readCommandCatalog(session.chatId, true).catch(() => {})
          active.status = "running"
          active.providerTurnStarted = true
          // Compatibility for wrappers that never echo UUIDs: retain their
          // historical init/FIFO resync. UUID sessions keep older prompts so a
          // late result can be attributed even after this turn starts.
          if (!session.echoesPromptIds && active.claudePromptSeq !== undefined) {
            const activeSeq = active.claudePromptSeq
            const orphaned = session.pendingPrompts.filter(prompt => prompt.seq < activeSeq).map(prompt => prompt.seq)
            if (orphaned.length > 0) {
              const releasedOriginReservations = session.session
                .discardHumanTurnReservations?.(orphaned) ?? 0
              session.pendingPrompts = session.pendingPrompts.filter(prompt => prompt.seq >= activeSeq)
              for (const seq of orphaned) session.cancelledPromptSeqs.delete(seq)
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
            pendingPromptSeqs: session.pendingPrompts.map(prompt => prompt.seq),
          })
        }

        logClaudeSteer("claude_event", {
          chatId: session.chatId,
          sessionId: session.id,
          entryKind: event.entry.kind,
          eventOrigin: event.origin ?? "human",
          activePromptSeq: active?.claudePromptSeq ?? null,
          completedPromptSeqs,
          activeStatus: active?.status ?? null,
          pendingPromptSeqs: session.pendingPrompts.map(prompt => prompt.seq),
        })

        if (event.entry.kind === "result" && active && active.claudePromptSeq !== undefined && completedPromptSeqs.includes(active.claudePromptSeq)) {
          active.hasFinalResult = true
          if (event.entry.isError) {
            await this.store.recordTurnFailed(session.chatId, event.entry.result || "Turn failed")
          } else if (!active.cancelRequested) {
            await this.store.recordTurnFinished(session.chatId)
            const chat = this.store.getChat(session.chatId)
            if (!active.cancelRequested) this.launchPostTurnMemoryPasses({
              chatId: session.chatId,
              projectId: chat?.projectId,
              engine: "claude",
              turnNumber: active.turnNumber,
              turnId: active.turnId,
              userText: active.userText ?? "",
              assistantText: active.assistantChunks.join("\n"),
              citedIds: [...active.citedIds],
              memoryState: active.memoryState,
              memoryDisabled: active.memoryDisabled,
              injectedIds: [...active.injectedIds],
              claudeSessionToken: chat?.sessionToken,
              localPath: active.localPath,
            }, active)
          }
          this.endPolicyTurn(session.chatId, active.turnId)
          if (this.activeTurns.get(session.chatId) === active) this.activeTurns.delete(session.chatId)
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
      if (!session.retired && this.claudeSessions.get(session.chatId) === session && active && !active.cancelRequested) {
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
        this.endPolicyTurn(session.chatId, active.turnId)
        this.activeTurns.delete(session.chatId)
      }
      session.session.close()
      if (isCurrent) await this.retireHarnessPolicyIfAbsent(session.chatId)
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
          active.sessionToken = event.sessionToken
          const launch = this.parentLaunches.get(active.chatId)
          if (launch) this.sessionLaunches.set(`${active.provider}:${event.sessionToken}`, launch)
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
        if (event.entry.kind === "compact_boundary") this.invalidateNativeContext(active.chatId)
        if (event.entry.kind === "assistant_text") {
          // Retire the streaming preview in the same broadcast that carries
          // the final entry — a snapshot must never show the text twice.
          this.clearStreamingAssistantText(active.chatId)
        }
        const policyScope = this.policyScopes.get(active.chatId)
        if (policyScope && policyScope.turnId === active.turnId) event.entry = this.bindPolicyEntry(policyScope, event.entry)
        await this.store.appendMessage(active.chatId, event.entry)
        if (event.entry.kind === "assistant_text") {
          const counted = this.recordMemoryCitations(event.entry.text, active.chatId, active.memoryState)
          active.assistantChunks.push(event.entry.text)
          for (const id of counted) active.citedIds.add(id)
        }

        if (event.entry.kind === "system_init") {
          void this.readCommandCatalog(active.chatId, true).catch(() => {})
          active.status = "running"
        }

        if (event.entry.kind === "result") {
          active.hasFinalResult = true
          if (event.entry.isError) {
            await this.store.recordTurnFailed(active.chatId, event.entry.result || "Turn failed")
          } else if (!active.cancelRequested) {
            await this.store.recordTurnFinished(active.chatId)
            const chat = this.store.getChat(active.chatId)
            if (!active.cancelRequested) this.launchPostTurnMemoryPasses({
              chatId: active.chatId,
              projectId: chat?.projectId,
              engine: active.provider,
              turnNumber: active.turnNumber,
              turnId: active.turnId,
              userText: active.userText ?? "",
              assistantText: active.assistantChunks.join("\n"),
              citedIds: [...active.citedIds],
              memoryState: active.memoryState,
              memoryDisabled: active.memoryDisabled,
              injectedIds: [...active.injectedIds],
            }, active)
          }
          // Remove from activeTurns as soon as the result arrives so the UI
          // transitions to idle immediately. The stream may still be open
          // (e.g. background tasks), but the user should be able to send
          // new messages without having to hit stop first.
          this.endPolicyTurn(active.chatId, active.turnId)
          if (this.activeTurns.get(active.chatId) === active) this.activeTurns.delete(active.chatId)
          // Track the still-open stream so the UI can show a draining
          // indicator and the user can stop background tasks.
          if (!active.cancelRequested) this.drainingStreams.set(active.chatId, { turn: active.turn })
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
        this.endPolicyTurn(active.chatId, active.turnId)
        this.activeTurns.delete(active.chatId)
      }
      // A predecessor must not clear a successor's draining stream.
      if (this.drainingStreams.get(active.chatId)?.turn === active.turn) this.drainingStreams.delete(active.chatId)
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

  private assertMemoSyncControl(chatId: string): void {
    const chat = this.store.requireChat(chatId)
    if (!["claude", "codex", "pi", "opencode"].includes(chat.provider ?? "")) {
      throw new Error("Per-memory interrupt is only available on a supported MemoSync engine")
    }
  }

  /**
   * Per-memory interrupt (2026-08-19 C1/C3): the user stopped the turn
   * because they identified a problem involving one working-memory item. Cancels exactly like
   * Stop, then adds the attribution a plain Stop lacks: the flagged memory,
   * the anchor quote, the turn's working set — plus the measurement side
   * effects: a user-issued violated verdict in the memory event log
   * (never an audit card), and a memory.interrupt event. The recovery card
   * parks at the interruption point as a memory_interrupt entry.
   */
  async interruptMemory(args: { chatId: string; memoryId: string; quote?: string }) {
    const { chatId, memoryId } = args
    this.assertMemoSyncControl(chatId)
    const active = this.activeTurns.get(chatId)
    if (!active) {
      throw new Error("A MemoSync turn must be running before a memory can interrupt it")
    }
    if (!active.memoryState.memoryActive) throw new Error("Memory is disabled for this turn")
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
    // Record the local interrupt action before cancelling the run.
    this.memory?.logger.event({
      type: "memory.interrupt",
      eventId: `control:interrupt:${interruptId}`,
      interruptId,
      sessionId: chatId,
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
   * set — and rides a continuation instruction plus the user's
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
    this.assertMemoSyncControl(chatId)
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
    const memoryState = resolveTurnMemoryState(this.getMemorySettings(), chat.memoryDisabled)
    if (!memoryState.memoryActive) throw new Error("Memory is disabled for this chat")
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

    const provider = (chat.provider ?? "claude") as AgentProvider
    const lastModel = messages.filter(message => message.kind === "system_init").at(-1)?.model
    const settings = this.getProviderSettings(provider, { model: lastModel })
    let deliveryAccepted = false
    let deliveredSelectedIds: string[] = []
    await this.startTurnForChat({
      chatId,
      provider,
      content: entry.prompt,
      attachments: [],
      connectionId: settings.connectionId,
      model: settings.model,
      effort: settings.effort,
      serviceTier: settings.serviceTier,
      planMode: false,
      appendUserPrompt: true,
      // Stable across retries: if provider boot fails after the prompt entry is
      // durable, startTurn reuses that entry and its turn number.
      turnId: args.interruptId,
      memoryState,
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
      throw new Error("The coding agent did not accept the interrupt recovery delivery")
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
    this.memory?.logger.event({
      type: "memory.resume",
      eventId: `resume:${args.interruptId}`,
      interruptId: args.interruptId,
      sessionId: chatId,
      chatId,
      id: entry.memoryId,
      enforced: enforce,
    })
    if (enforce) {
      this.memory?.logger.event({
        type: "memory.audit_action",
        eventId: `enforce:${args.interruptId}`,
        sessionId: chatId,
        chatId,
        id: entry.memoryId,
        action: "enforce",
      })
    }
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
    this.hostActions?.revokeChat(chatId)
    if (this.commandPreparations.get(chatId)?.status === 'preparing') {
      const preparation = this.cancelCommandPreparation(chatId)
      if (!this.startingChats.has(chatId) && !this.activeTurns.has(chatId)) {
        await preparation
        this.emitStateChange(chatId)
        return
      }
    }
    if (this.commandRegistry.isRunning(chatId)) {
      const operation = this.commandRegistry.snapshot(chatId).operation
      if (operation) await this.commandRegistry.cancel(chatId, operation.id)
      return
    }
    this.endPolicyTurn(chatId, undefined, false)
    this.restoreUndeliveredEnforcement(chatId)
    this.disposeMemoryBranches(chatId)
    // Drop any half-written streaming reply right away — the engine unwind
    // below may take a moment and the partial must not linger as if live.
    this.clearStreamingAssistantText(chatId)
    // Also clean up any draining stream for this chat.
    const draining = this.drainingStreams.get(chatId)
    if (draining) {
      draining.turn.close()
      this.drainingStreams.delete(chatId)
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
      const reservation = this.startupReservations.get(chatId)
      if (reservation) {
        this.cancelStartupReservation(chatId, reservation)
      }
      this.cancelledDuringPreview.add(chatId)
      proposalsParked?.respond("cancelled")
      transferParked?.respond("cancelled")
      checkupParked?.respond("cancelled")
      // The shared phase signal releases Prompt Parse and task-local Transfer
      // together. Source preparation is shared across turns and keeps running.
      await preparation?.cancellation.cancelAndWait()
      if (reservation) {
        await this.recordStartupCancellation(chatId, reservation, options?.hideInterrupted)
      } else {
        await this.store.appendMessage(chatId, timestamped({ kind: "interrupted", hidden: options?.hideInterrupted }))
        await this.store.recordTurnCancelled(chatId)
        this.emitStateChange(chatId, { immediate: true })
      }
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
      const reservation = this.startupReservations.get(chatId)
      if (reservation) this.cancelStartupReservation(chatId, reservation)
      this.cancelledDuringPreview.add(chatId)
      if (reservation) {
        await this.recordStartupCancellation(chatId, reservation, options?.hideInterrupted)
      } else {
        await this.store.appendMessage(chatId, timestamped({ kind: "interrupted", hidden: options?.hideInterrupted }))
        await this.store.recordTurnCancelled(chatId)
        this.emitStateChange(chatId, { immediate: true })
      }
      return
    }

    // Stop DURING the preview-gate LLM pass (reservation held, gate not parked
    // yet): the in-flight runPreviewGateThenBoot observes this flag and unwinds
    // (BUG AGENT-2). Record the interruption here so the UI reflects it now.
    const active = this.activeTurns.get(chatId)
    if (!active && this.startingChats.get(chatId) === "previewing_memory") {
      const preparation = this.activePreparations.get(chatId)
      const reservation = this.startupReservations.get(chatId)
      if (reservation) {
        this.cancelStartupReservation(chatId, reservation)
      }
      this.cancelledDuringPreview.add(chatId)
      await preparation?.cancellation.cancelAndWait()
      if (reservation) {
        await this.recordStartupCancellation(chatId, reservation, options?.hideInterrupted)
      } else {
        await this.store.appendMessage(chatId, timestamped({ kind: "interrupted", hidden: options?.hideInterrupted }))
        await this.store.recordTurnCancelled(chatId)
        this.emitStateChange(chatId, { immediate: true })
      }
      return
    }

    // Stop while the provider is queued or initializing: cancel its abort
    // barrier now and record the interruption immediately. bootEngineTurn's
    // in-flight codex startup receives this signal even when runtime starts
    // are serialized behind another profile migration.
    if (!active && this.startingChats.get(chatId) === "starting") {
      const reservation = this.startupReservations.get(chatId)
      if (reservation) {
        this.cancelStartupReservation(chatId, reservation)
        await this.recordStartupCancellation(chatId, reservation, options?.hideInterrupted)
      } else {
        await this.store.appendMessage(chatId, timestamped({ kind: "interrupted", hidden: options?.hideInterrupted }))
        await this.store.recordTurnCancelled(chatId)
        this.emitStateChange(chatId, { immediate: true })
      }
      return
    }

    if (!active) return

    logClaudeSteer("cancel_requested", {
      chatId,
      provider: active.provider,
      activePromptSeq: active.claudePromptSeq ?? null,
    })

    // Guard against concurrent cancel() calls — only the first one does work.
    if (active.cancelRequested) return
    active.cancelRequested = true
    if (active.provider === "claude" && active.claudePromptSeq !== undefined) {
      const session = this.claudeSessions.get(chatId)
      session?.cancelledPromptSeqs.add(active.claudePromptSeq)
      session?.session.revokeHumanTurnReservation?.(active.claudePromptSeq)
    }
    if (active.startupReservation) {
      this.cancelStartupReservation(chatId, active.startupReservation)
    }

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
      // Release all native waiters; their frozen policy scopes now deny replies.
      pendingTool.resolve(result)
    }

    await this.store.appendMessage(chatId, timestamped({ kind: "interrupted", hidden: options?.hideInterrupted }))
    await this.store.recordTurnCancelled(chatId)
    if (active.startupReservation) {
      active.startupReservation.cancellationComplete = true
      this.releaseStartupStatus(chatId, active.startupReservation)
      if (active.startupReservation.startupSettled) {
        this.settleStartupReservation(chatId, active.startupReservation)
      }
    }
    active.cancelRecorded = true
    active.hasFinalResult = true

    // Remove from activeTurns immediately so the UI reflects the cancellation
    // right away, rather than waiting for interrupt() which may hang.
    this.activeTurns.delete(chatId)
    this.emitStateChange(chatId)

    // Per-memory interrupts skip post-turn work; ordinary Stop keeps it.
    if (!options?.skipPostTurnMemoryPasses) {
      const chat = this.store.getChat(chatId)
      this.launchPostTurnMemoryPasses({
        chatId,
        projectId: chat?.projectId,
        engine: active.provider,
        turnNumber: active.turnNumber,
        turnId: active.turnId,
        userText: active.userText ?? "",
        assistantText: active.assistantChunks.join("\n"),
        citedIds: [...active.citedIds],
        memoryState: active.memoryState,
        memoryDisabled: true,
        injectedIds: [],
      }, active)
    }
    logClaudeSteer("cancel_active_turn_deleted", {
      chatId,
      provider: active.provider,
      activePromptSeq: active.claudePromptSeq ?? null,
    })

    // Keep the before-start guard: result UUIDs do not identify late assistant
    // or tool frames. Retiring the Query prevents those from contaminating the
    // next turn's transcript, memory citations, and capture/trace inputs.
    if (active.provider === "claude" && !active.providerTurnStarted) {
      const session = this.claudeSessions.get(chatId)
      if (session) {
        try {
          await this.retireClaudeSession(session, "turn_cancel_before_start")
        } catch (error) {
          // Stop already cancelled the turn; a slow pump must not turn that
          // into a user-visible failure. The session is retired and its
          // remaining frames are dropped by the pump's retired guard.
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
      await interruptTurnWithTimeout(active.turn)
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
    const approvalScope = this.policyApprovals.get(command.toolUseId)
    if (approvalScope && (!this.harnessPolicies.isCurrent(approvalScope) || active.turnId !== approvalScope.turnId)) {
      throw new Error("Stale execution approval")
    }
    if (pending.toolUseId !== command.toolUseId) {
      throw new Error("Tool response does not match active request")
    }

    const responseKey = `${command.chatId}:${command.toolUseId}`
    if (this.respondingTools.has(responseKey)) throw new Error("Tool response already in progress")
    this.respondingTools.add(responseKey)
    try {
      await this.store.appendMessage(
        command.chatId,
        timestamped({
          kind: "tool_result",
          toolId: command.toolUseId,
          content: command.result,
        })
      )

      if (this.activeTurns.get(command.chatId) !== active || active.pendingTool !== pending || (approvalScope && !this.harnessPolicies.isCurrent(approvalScope))) {
        throw new Error("Stale tool response")
      }
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

      if (this.activeTurns.get(command.chatId) !== active || active.pendingTool !== pending || approvalScope && !this.harnessPolicies.isCurrent(approvalScope)) throw new Error("Stale tool response")
      active.pendingTool = null
      pending.resolve(command.result)

      this.emitStateChange(command.chatId)
    } finally { this.respondingTools.delete(responseKey) }
  }
}
