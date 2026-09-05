export const STORE_VERSION = 2 as const
export const PROTOCOL_VERSION = 1 as const

export type AgentProvider = "claude" | "codex"
export type LlmProviderKind = "openai" | "openrouter" | "custom"
export type AppThemePreference = "light" | "dark" | "system"
export type ChatSoundPreference = "never" | "unfocused" | "always"
export type ChatSoundId = "blow" | "bottle" | "frog" | "funk" | "glass" | "ping" | "pop" | "purr" | "tink"
export type DefaultProviderPreference = "last_used" | AgentProvider
export type EditorPreset = "cursor" | "vscode" | "xcode" | "windsurf" | "custom"
export const DEFAULT_OPENAI_SDK_MODEL = "gpt-5.4-mini"
export const DEFAULT_OPENROUTER_SDK_MODEL = "moonshotai/kimi-k2.5:nitro"
export const DEFAULT_DEEPSEEK_MODEL_ID = "deepseek-v4-flash"

export type AttachmentKind = "image" | "file"
export type StandaloneTranscriptAttachmentMode = "metadata" | "bundle"
export type StandaloneTranscriptTheme = "light" | "dark"

export interface SkillSearchResult {
  id: string
  skillId: string
  name: string
  installs: number
  source: string
}

export interface SkillSearchSnapshot {
  query: string
  searchType: string
  skills: SkillSearchResult[]
  count: number
  duration_ms: number
}

export interface SkillInstallResult {
  source: string
  skillId: string
  command: string[]
  cwd: string
  stdout: string
  stderr: string
}

export interface SkillUninstallResult {
  skillId: string
  command: string[]
  cwd: string
  stdout: string
  stderr: string
}

export interface InstalledSkillSummary {
  name: string
  source: string
  sourceType: string
  sourceUrl: string
  skillPath?: string
  installedAt: string
  updatedAt: string
  pluginName?: string
}

export interface InstalledSkillsSnapshot {
  lockFilePath: string
  skills: InstalledSkillSummary[]
}

export interface ChatAttachment {
  id: string
  kind: AttachmentKind
  displayName: string
  absolutePath: string
  relativePath: string
  contentUrl: string
  mimeType: string
  size: number
}

export interface StandaloneTranscriptBundle {
  version: 1
  chatId: string
  title: string
  localPath: string
  exportedAt: string
  viewerVersion: string
  theme: StandaloneTranscriptTheme
  attachmentMode: StandaloneTranscriptAttachmentMode
  messages: TranscriptEntry[]
}

export interface StandaloneTranscriptExportResult {
  ok: true
  outputDir: string
  indexHtmlPath: string
  transcriptJsonPath: string
  attachmentMode: StandaloneTranscriptAttachmentMode
  totalAttachmentCount: number
  bundledAttachmentCount: number
}

export type StandaloneTranscriptExportCommandResult = StandaloneTranscriptExportResult

export interface QueuedChatMessage {
  id: string
  content: string
  attachments: ChatAttachment[]
  createdAt: number
  provider?: AgentProvider
  model?: string
  modelOptions?: ModelOptions
  planMode?: boolean
}

export interface InternalUserAttachmentsData {
  userText: string
  attachments: ChatAttachment[]
  llmHintText: string
}

export interface ProviderModelOption {
  id: string
  label: string
  supportsEffort: boolean
  aliases?: readonly string[]
  contextWindowOptions?: readonly ProviderContextWindowOption[]
  supportsMaxReasoningEffort?: boolean
  /** Vendor shown on the composer's provider chip when this model is picked
   * (the Claude-engine catalog now spans vendors: DeepSeek + GLM). Absent =
   * the provider's own label. */
  vendor?: string
}

export interface ProviderEffortOption {
  id: string
  label: string
}

export interface ProviderContextWindowOption {
  id: ClaudeContextWindow
  label: string
}

// DeepSeek thinking only distinguishes high and max — no lower tiers.
export const CLAUDE_REASONING_OPTIONS = [
  { id: "high", label: "High" },
  { id: "max", label: "Max" },
] as const satisfies readonly ProviderEffortOption[]

export const CODEX_REASONING_OPTIONS = [
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "XHigh" },
] as const satisfies readonly ProviderEffortOption[]

export type ClaudeReasoningEffort = (typeof CLAUDE_REASONING_OPTIONS)[number]["id"]
export type CodexReasoningEffort = (typeof CODEX_REASONING_OPTIONS)[number]["id"]
export type ClaudeContextWindow = "200k" | "1m"
export type ServiceTier = "fast"

export interface ClaudeModelOptions {
  reasoningEffort: ClaudeReasoningEffort
  contextWindow: ClaudeContextWindow
}

export interface CodexModelOptions {
  reasoningEffort: CodexReasoningEffort
  fastMode: boolean
}

export interface ProviderModelOptionsByProvider {
  claude: ClaudeModelOptions
  codex: CodexModelOptions
}

export interface ProviderPreference<TModelOptions> {
  model: string
  modelOptions: TModelOptions
  planMode: boolean
}

export type ChatProviderPreferences = {
  claude: ProviderPreference<ClaudeModelOptions>
  codex: ProviderPreference<CodexModelOptions>
}

export type ModelOptions = Partial<{
  [K in AgentProvider]: Partial<ProviderModelOptionsByProvider[K]>
}>

export const DEFAULT_CLAUDE_MODEL_OPTIONS = {
  reasoningEffort: "high",
  // DeepSeek V4 models carry a 1M-token context window (docs.deepseek.com);
  // "200k" only applies to real Anthropic models, which this catalog no
  // longer lists directly.
  contextWindow: "1m",
} as const satisfies ClaudeModelOptions

export const DEFAULT_CODEX_MODEL_OPTIONS = {
  reasoningEffort: "high",
  fastMode: false,
} as const satisfies CodexModelOptions

export function isClaudeReasoningEffort(value: unknown): value is ClaudeReasoningEffort {
  return CLAUDE_REASONING_OPTIONS.some((option) => option.id === value)
}

export function isCodexReasoningEffort(value: unknown): value is CodexReasoningEffort {
  return CODEX_REASONING_OPTIONS.some((option) => option.id === value)
}

export const CLAUDE_CONTEXT_WINDOW_OPTIONS = [
  { id: "200k", label: "200k" },
  { id: "1m", label: "1M" },
] as const satisfies readonly ProviderContextWindowOption[]

export function isClaudeContextWindow(value: unknown): value is ClaudeContextWindow {
  return CLAUDE_CONTEXT_WINDOW_OPTIONS.some((option) => option.id === value)
}

export interface ProviderCatalogEntry {
  id: AgentProvider
  label: string
  defaultModel: string
  defaultEffort?: string
  supportsPlanMode: boolean
  models: ProviderModelOption[]
  efforts: ProviderEffortOption[]
}

export const PROVIDERS: ProviderCatalogEntry[] = [
  {
    id: "claude",
    label: "DeepSeek",
    defaultModel: DEFAULT_DEEPSEEK_MODEL_ID,
    defaultEffort: "high",
    supportsPlanMode: true,
    models: [
      {
        id: DEFAULT_DEEPSEEK_MODEL_ID,
        label: "V4 Flash",
        supportsEffort: true,
        vendor: "DeepSeek",
        aliases: [
          "fable",
          "sonnet",
          "haiku",
          "claude-sonnet-4-6",
          "claude-haiku-4-5-20251001",
        ],
        contextWindowOptions: [CLAUDE_CONTEXT_WINDOW_OPTIONS[1]],
        supportsMaxReasoningEffort: true,
      },
      {
        id: "deepseek-v4-flash-vision-exp",
        label: "V4 Vision",
        supportsEffort: true,
        vendor: "DeepSeek",
        contextWindowOptions: [CLAUDE_CONTEXT_WINDOW_OPTIONS[1]],
        supportsMaxReasoningEffort: true,
      },
      {
        id: "deepseek-v4-pro",
        label: "V4 Pro",
        supportsEffort: true,
        vendor: "DeepSeek",
        aliases: ["opus", "claude-opus-4-8"],
        contextWindowOptions: [CLAUDE_CONTEXT_WINDOW_OPTIONS[1]],
        supportsMaxReasoningEffort: true,
      },
      {
        // GLM-5.3-Flash ("牛来", 智谱 2026-08-26): 1M-native multimodal, routed
        // per-chat to its own endpoint+key (see server/chat-providers.ts).
        // Runs on the same Claude Code engine; memory passes stay on DeepSeek.
        id: "glm-5.3-flash",
        label: "GLM-5.3 Flash",
        supportsEffort: true,
        vendor: "GLM",
        contextWindowOptions: [CLAUDE_CONTEXT_WINDOW_OPTIONS[1]],
        supportsMaxReasoningEffort: true,
      },
    ],
    efforts: [...CLAUDE_REASONING_OPTIONS],
  },
  {
    id: "codex",
    label: "Codex",
    defaultModel: "gpt-5.5",
    supportsPlanMode: true,
    models: [
      { id: "gpt-5.5", label: "GPT-5.5", supportsEffort: false },
      { id: "gpt-5.4", label: "GPT-5.4", supportsEffort: false },
      { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", supportsEffort: false, aliases: ["gpt-5-codex"] },
      { id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark", supportsEffort: false },
    ],
    efforts: [],
  },
]

export function getProviderCatalog(provider: AgentProvider): ProviderCatalogEntry {
  const entry = PROVIDERS.find((candidate) => candidate.id === provider)
  if (!entry) {
    throw new Error(`Unknown provider: ${provider}`)
  }
  return entry
}

function getProviderModelMatch(provider: AgentProvider, modelId?: string): ProviderModelOption | undefined {
  if (!modelId) return undefined

  return getProviderCatalog(provider).models.find((candidate) =>
    candidate.id === modelId || candidate.aliases?.includes(modelId)
  )
}

export function normalizeProviderModelId(
  provider: AgentProvider,
  modelId?: string,
  fallbackModelId?: string
): string {
  return getProviderModelMatch(provider, modelId)?.id
    ?? fallbackModelId
    ?? getProviderCatalog(provider).defaultModel
}

export function normalizeClaudeModelId(modelId?: string, fallbackModelId = DEFAULT_DEEPSEEK_MODEL_ID): string {
  return normalizeProviderModelId("claude", modelId, fallbackModelId)
}

export function normalizeCodexModelId(modelId?: string, fallbackModelId = "gpt-5.5"): string {
  return normalizeProviderModelId("codex", modelId, fallbackModelId)
}

export function getProviderModelOption(provider: AgentProvider, modelId: string): ProviderModelOption | undefined {
  const normalizedModelId = normalizeProviderModelId(provider, modelId)
  return getProviderCatalog(provider).models.find((candidate) => candidate.id === normalizedModelId)
}

export function getClaudeModelOption(modelId: string): ProviderModelOption | undefined {
  return getProviderModelOption("claude", modelId)
}

export function supportsClaudeMaxReasoningEffort(modelId: string): boolean {
  return Boolean(getClaudeModelOption(modelId)?.supportsMaxReasoningEffort)
}

export function getClaudeContextWindowOptions(modelId: string): readonly ProviderContextWindowOption[] {
  return getClaudeModelOption(modelId)?.contextWindowOptions ?? []
}

export function normalizeClaudeContextWindow(modelId: string, contextWindow?: unknown): ClaudeContextWindow {
  const options = getClaudeContextWindowOptions(modelId)
  if (options.length === 0) return DEFAULT_CLAUDE_MODEL_OPTIONS.contextWindow
  // Fall back to the MODEL's first option, not the global default — a stored
  // "200k" from before the catalog carried real windows must coerce to what
  // the model actually has.
  return options.some((option) => option.id === contextWindow)
    ? contextWindow as ClaudeContextWindow
    : options[0].id
}

export function resolveClaudeApiModelId(modelId: string, contextWindow?: ClaudeContextWindow): string {
  // Catalog vendors (DeepSeek, GLM) keep their bare id; the server decides
  // per-vendor whether the `[1m]` selector applies (buildClaudeSdkRuntimeOptions).
  if (modelId.startsWith("deepseek-") || modelId.startsWith("glm-")) return modelId
  return contextWindow === "1m" ? `${modelId}[1m]` : modelId
}

export function resolveClaudeContextWindowTokens(contextWindow: ClaudeContextWindow): number {
  switch (contextWindow) {
    case "1m":
      return 1_000_000
    case "200k":
    default:
      return 200_000
  }
}

export type ChatActivityStatus =
  | "idle"
  | "starting"
  /** The pre-turn memory-preview LLM pass is in flight (memosync arm). */
  | "previewing_memory"
  | "running"
  | "waiting_for_user"
  | "failed"

export interface ProjectSummary {
  id: string
  localPath: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface SidebarChatRow {
  _id: string
  _creationTime: number
  chatId: string
  title: string
  status: ChatActivityStatus
  unread: boolean
  localPath: string
  provider: AgentProvider | null
  lastMessageAt?: number
  hasAutomation: boolean
  canFork?: boolean
}

export interface SidebarProjectGroup {
  groupKey: string
  title: string
  realTitle: string
  sidebarTitle?: string
  localPath: string
  chats: SidebarChatRow[]
  previewChats: SidebarChatRow[]
  olderChats: SidebarChatRow[]
  archivedChats?: SidebarChatRow[]
  defaultCollapsed: boolean
}

export interface SidebarData {
  projectGroups: SidebarProjectGroup[]
}

export interface LocalProjectSummary {
  localPath: string
  title: string
  source: "saved" | "discovered"
  lastOpenedAt?: number
  chatCount: number
}

export interface LocalProjectsSnapshot {
  machine: {
    id: "local"
    displayName: string
    platform: NodeJS.Platform
  }
  projects: LocalProjectSummary[]
}

/** Memory-preview gate behavior (STUDY_PLAN §2.4 — a system setting, not a study manipulation). */
export interface MemoryPreviewSettings {
  /** Master switch for the per-turn preview gate. */
  enabled: boolean
  /** Auto-proceed (logged as an automatic go_on) when the plan involves no memories. */
  autoProceedWhenEmpty: boolean
}

export interface AppSettingsSnapshot {
  browserSettingsMigrated: boolean
  theme: AppThemePreference
  chatSoundPreference: ChatSoundPreference
  chatSoundId: ChatSoundId
  terminal: {
    scrollbackLines: number
    minColumnWidth: number
  }
  editor: {
    preset: EditorPreset
    commandTemplate: string
  }
  defaultProvider: DefaultProviderPreference
  providerDefaults: ChatProviderPreferences
  memoryPreview: MemoryPreviewSettings
  warning: string | null
  filePathDisplay: string
}

export interface AppSettingsPatch {
  browserSettingsMigrated?: boolean
  theme?: AppThemePreference
  chatSoundPreference?: ChatSoundPreference
  chatSoundId?: ChatSoundId
  terminal?: Partial<AppSettingsSnapshot["terminal"]>
  editor?: Partial<AppSettingsSnapshot["editor"]>
  defaultProvider?: DefaultProviderPreference
  providerDefaults?: {
    claude?: Partial<ProviderPreference<ClaudeModelOptions>>
    codex?: Partial<ProviderPreference<CodexModelOptions>>
  }
  memoryPreview?: Partial<MemoryPreviewSettings>
}

export interface LlmProviderFile {
  provider?: LlmProviderKind
  apiKey?: string
  model?: string
  baseUrl?: string | null
}

export interface LlmProviderSnapshot {
  provider: LlmProviderKind
  apiKey: string
  /** Public settings responses mask apiKey and expose only this presence bit. */
  hasApiKey?: boolean
  model: string
  baseUrl: string
  resolvedBaseUrl: string
  enabled: boolean
  warning: string | null
  filePathDisplay: string
}

export interface LlmProviderValidationResult {
  ok: boolean
  error: unknown | null
}

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "up_to_date"
  | "updating"
  | "restart_pending"
  | "error"

export interface UpdateSnapshot {
  currentVersion: string
  latestVersion: string | null
  status: UpdateStatus
  updateAvailable: boolean
  lastCheckedAt: number | null
  error: string | null
  installAction: "restart" | "reload"
  reloadRequestedAt: number | null
}

export type UpdateInstallErrorCode =
  | "version_not_live_yet"
  | "install_failed"
  | "command_missing"

export interface UpdateInstallResult {
  ok: boolean
  action: "restart" | "reload"
  errorCode: UpdateInstallErrorCode | null
  userTitle: string | null
  userMessage: string | null
}

export type KeybindingAction =
  | "toggleEmbeddedTerminal"
  | "toggleRightSidebar"
  | "openInFinder"
  | "openInEditor"
  | "addSplitTerminal"
  | "jumpToSidebarChat"
  | "createChatInCurrentProject"
  | "openAddProject"

export const DEFAULT_KEYBINDINGS: Record<KeybindingAction, string[]> = {
  toggleEmbeddedTerminal: ["cmd+j", "ctrl+`"],
  toggleRightSidebar: ["cmd+b", "ctrl+b"],
  openInFinder: ["cmd+alt+f", "ctrl+alt+f"],
  openInEditor: ["cmd+shift+o", "ctrl+shift+o"],
  addSplitTerminal: ["cmd+/", "ctrl+/"],
  jumpToSidebarChat: ["cmd+alt"],
  createChatInCurrentProject: ["cmd+alt+n"],
  openAddProject: ["cmd+alt+o"],
}

export interface KeybindingsSnapshot {
  bindings: Record<KeybindingAction, string[]>
  warning: string | null
  filePathDisplay: string
}

export interface McpServerInfo {
  name: string
  status: string
  error?: string
}

export interface AccountInfo {
  email?: string
  organization?: string
  subscriptionType?: string
  tokenSource?: string
  apiKeySource?: string
}

export interface AskUserQuestionOption {
  label: string
  description?: string
}

export interface AskUserQuestionItem {
  id?: string
  question: string
  header?: string
  options?: AskUserQuestionOption[]
  multiSelect?: boolean
}

export type AskUserQuestionAnswerMap = Record<string, string[]>

export interface TodoItem {
  content: string
  status: "pending" | "in_progress" | "completed"
  activeForm: string
}

interface TranscriptEntryBase {
  _id: string
  messageId?: string
  createdAt: number
  hidden?: boolean
  debugRaw?: string
}

interface ToolCallBase<TKind extends string, TInput> {
  kind: "tool"
  toolKind: TKind
  toolName: string
  toolId: string
  input: TInput
  rawInput?: Record<string, unknown>
}

export interface AskUserQuestionToolCall
  extends ToolCallBase<"ask_user_question", { questions: AskUserQuestionItem[] }> { }

export interface ExitPlanModeToolCall
  extends ToolCallBase<"exit_plan_mode", { plan?: string; summary?: string }> { }

export interface TodoWriteToolCall
  extends ToolCallBase<"todo_write", { todos: TodoItem[] }> { }

export interface SkillToolCall
  extends ToolCallBase<"skill", { skill: string }> { }

export interface GlobToolCall
  extends ToolCallBase<"glob", { pattern: string }> { }

export interface GrepToolCall
  extends ToolCallBase<"grep", { pattern: string; outputMode?: string }> { }

export interface BashToolCall
  extends ToolCallBase<"bash", { command: string; description?: string; timeoutMs?: number; runInBackground?: boolean }> { }

export interface WebSearchToolCall
  extends ToolCallBase<"web_search", { query: string }> { }

export interface ReadFileToolCall
  extends ToolCallBase<"read_file", { filePath: string }> { }

export interface WriteFileToolCall
  extends ToolCallBase<"write_file", { filePath: string; content: string }> { }

export interface EditFileToolCall
  extends ToolCallBase<"edit_file", { filePath: string; oldString: string; newString: string }> { }

export interface DeleteFileToolCall
  extends ToolCallBase<"delete_file", { filePath: string; content: string }> { }

export interface SubagentTaskToolCall
  extends ToolCallBase<"subagent_task", { subagentType?: string }> { }

export interface McpGenericToolCall
  extends ToolCallBase<"mcp_generic", { server: string; tool: string; payload: Record<string, unknown> }> { }

export interface UnknownToolCall
  extends ToolCallBase<"unknown_tool", { payload: Record<string, unknown> }> { }

export type NormalizedToolCall =
  | AskUserQuestionToolCall
  | ExitPlanModeToolCall
  | TodoWriteToolCall
  | SkillToolCall
  | GlobToolCall
  | GrepToolCall
  | BashToolCall
  | WebSearchToolCall
  | ReadFileToolCall
  | WriteFileToolCall
  | EditFileToolCall
  | DeleteFileToolCall
  | SubagentTaskToolCall
  | McpGenericToolCall
  | UnknownToolCall

export interface ToolResultEntry extends TranscriptEntryBase {
  kind: "tool_result"
  toolId: string
  content: unknown
  isError?: boolean
}

export interface UserPromptEntry extends TranscriptEntryBase {
  kind: "user_prompt"
  content: string
  /** Exact participant-authored text when `content` carries a provider wrapper. */
  participantContent?: string
  attachments?: ChatAttachment[]
  steered?: boolean
}

export interface SystemInitEntry extends TranscriptEntryBase {
  kind: "system_init"
  provider: AgentProvider
  model: string
  tools: string[]
  agents: string[]
  slashCommands: string[]
  mcpServers: McpServerInfo[]
}

export interface AccountInfoEntry extends TranscriptEntryBase {
  kind: "account_info"
  accountInfo: AccountInfo
}

export interface AssistantTextEntry extends TranscriptEntryBase {
  kind: "assistant_text"
  text: string
}

export interface ToolCallEntry extends TranscriptEntryBase {
  kind: "tool_call"
  tool: NormalizedToolCall
}

export interface ResultEntry extends TranscriptEntryBase {
  kind: "result"
  subtype: "success" | "error" | "cancelled"
  isError: boolean
  durationMs: number
  result: string
  costUsd?: number
}

export interface StatusEntry extends TranscriptEntryBase {
  kind: "status"
  status: string
}

export interface ContextWindowUsageSnapshot {
  usedTokens: number
  totalProcessedTokens?: number
  maxTokens?: number
  inputTokens?: number
  cachedInputTokens?: number
  outputTokens?: number
  reasoningOutputTokens?: number
  lastUsedTokens?: number
  lastInputTokens?: number
  lastCachedInputTokens?: number
  lastOutputTokens?: number
  lastReasoningOutputTokens?: number
  toolUses?: number
  durationMs?: number
  compactsAutomatically: boolean
}

export interface ChatDiffFile {
  path: string
  changeType: "added" | "deleted" | "modified" | "renamed"
  isUntracked: boolean
  additions: number
  deletions: number
  patchDigest: string
  mimeType?: string
  size?: number
}

export interface ChatBranchHistoryEntry {
  sha: string
  summary: string
  description: string
  authorName?: string
  authoredAt: string
  tags: string[]
  githubUrl?: string
}

export interface ChatBranchHistorySnapshot {
  entries: ChatBranchHistoryEntry[]
}

export type ChatBranchListEntryKind = "local" | "remote" | "pull_request"

export interface ChatBranchListEntry {
  id: string
  kind: ChatBranchListEntryKind
  name: string
  displayName: string
  updatedAt?: string
  description?: string
  remoteRef?: string
  prNumber?: number
  prTitle?: string
  headRefName?: string
  headLabel?: string
  headRepoCloneUrl?: string
  isCrossRepository?: boolean
}

export interface ChatBranchListResult {
  currentBranchName?: string
  defaultBranchName?: string
  recent: ChatBranchListEntry[]
  local: ChatBranchListEntry[]
  remote: ChatBranchListEntry[]
  pullRequests: ChatBranchListEntry[]
  pullRequestsStatus: "available" | "unavailable" | "error"
  pullRequestsError?: string
}

export interface GitHubPublishInfo {
  ghInstalled: boolean
  authenticated: boolean
  activeAccountLogin?: string
  owners: string[]
  suggestedRepoName: string
}

export interface GitHubRepoAvailabilityResult {
  available: boolean
  message: string
}

export interface BranchMetadata {
  branchName?: string
  defaultBranchName?: string
  hasOriginRemote?: boolean
  originRepoSlug?: string
  hasUpstream?: boolean
}

export interface UpstreamStatus {
  aheadCount?: number
  behindCount?: number
  lastFetchedAt?: string
}

export interface ChatDiffSnapshot extends BranchMetadata, UpstreamStatus {
  status: "unknown" | "ready" | "no_repo"
  files: ChatDiffFile[]
  branchHistory?: ChatBranchHistorySnapshot
}

export interface BranchActionSuccess {
  ok: true
  branchName?: string
  snapshotChanged: boolean
}

export interface BranchActionFailure {
  ok: false
  title: string
  message: string
  detail?: string
  cancelled?: boolean
  snapshotChanged?: boolean
}

export type ChatSyncSuccess = BranchActionSuccess & {
  action: "fetch" | "pull" | "push" | "publish"
  aheadCount?: number
  behindCount?: number
}

export type ChatSyncFailure = BranchActionFailure & {
  action: "fetch" | "pull" | "push" | "publish"
}

export type ChatSyncResult = ChatSyncSuccess | ChatSyncFailure

export type DiffCommitMode = "commit_and_push" | "commit_only"

export type ChatCheckoutBranchSuccess = BranchActionSuccess
export type ChatCheckoutBranchFailure = BranchActionFailure
export type ChatCheckoutBranchResult = ChatCheckoutBranchSuccess | ChatCheckoutBranchFailure

export type ChatCreateBranchSuccess = BranchActionSuccess & { branchName: string }
export type ChatCreateBranchFailure = BranchActionFailure
export type ChatCreateBranchResult = ChatCreateBranchSuccess | ChatCreateBranchFailure

export type ChatMergePreviewStatus = "up_to_date" | "mergeable" | "conflicts" | "error"

export interface ChatMergePreviewResult {
  currentBranchName?: string
  targetBranchName: string
  targetDisplayName: string
  status: ChatMergePreviewStatus
  commitCount: number
  hasConflicts: boolean
  message: string
  detail?: string
}

export type ChatMergeBranchSuccess = BranchActionSuccess
export type ChatMergeBranchFailure = BranchActionFailure
export type ChatMergeBranchResult = ChatMergeBranchSuccess | ChatMergeBranchFailure

export type DiffCommitSuccess = BranchActionSuccess & {
  mode: DiffCommitMode
  pushed: boolean
}

export type DiffCommitFailure = BranchActionFailure & {
  mode: DiffCommitMode
  phase: "commit" | "push"
  localCommitCreated?: boolean
}

export type DiffCommitResult = DiffCommitSuccess | DiffCommitFailure

export interface ContextWindowUpdatedEntry extends TranscriptEntryBase {
  kind: "context_window_updated"
  usage: ContextWindowUsageSnapshot
}

export interface CompactBoundaryEntry extends TranscriptEntryBase {
  kind: "compact_boundary"
}

export interface CompactSummaryEntry extends TranscriptEntryBase {
  kind: "compact_summary"
  summary: string
}

export interface ContextClearedEntry extends TranscriptEntryBase {
  kind: "context_cleared"
}

export interface InterruptedEntry extends TranscriptEntryBase {
  kind: "interrupted"
  /** Durable tombstone for an Auto queue row stopped before delivery. Internal
   * queue recovery metadata; omitted from ordinary active-turn interruptions. */
  cancelledQueuedMessageId?: string
}

/** One memory candidate surfaced by the forced capture hook (MemoSync SPEC §4.1). */
export interface MemoryCandidateSnapshot {
  id: string
  /** True when this card RE-SURFACES an earlier, still-unreviewed proposal
   * (a re-proposal collapsed into it) — the card says so instead of
   * pretending to be new. */
  resurfaced?: boolean
  /**
   * True when delegating/Auto mode applied this proposal without asking.
   * The card then shows an "auto" badge + one-click Revert instead of the
   * Accept/Dismiss pair — control moved to the agent, monitoring stayed on.
   */
  auto?: boolean
  /**
   * Candidate content is resolved from the memory database at render time.
   * These optional fields only keep older transcript rows readable; new rows
   * deliberately persist the id alone so rejected secrets are not duplicated
   * into append-only chat history.
   */
  content?: string
  detail?: string
  type?: string
  scope?: string
  topic?: string
  abstractionLevel?: string
  sensitive?: boolean
}

/** Review cards for capture-surfaced memory candidates, appended after a turn. */
export interface MemoryCandidatesEntry extends TranscriptEntryBase {
  kind: "memory_candidates"
  candidates: MemoryCandidateSnapshot[]
  turn?: number
}

/** Post-turn audit (4.2.4 Auditing Memory Use): each in-play memory labeled by the audit pass. */
export interface MemoryTraceEntry extends TranscriptEntryBase {
  kind: "memory_trace"
  labels: Array<{
    id: string
    label: "operational" | "injected_without_effect" | "violated" | "not_applicable"
    note?: string
    quote?: string
    /** Not-applicable only: the absent object/opportunity the audit named. */
    missing?: string
    /** Violated only: whether the violation visibly hurt the outcome. */
    impact?: "negative" | "none"
    /** Violated only: what the audit diagnosed — drives the two follow-up actions. */
    cause?: "not_followed" | "memory_conflict"
    /** True when the reply itself cited this id inline (self-report); absent = the audit found it post hoc. */
    cited?: boolean
  }>
  /** Terminal state for the post-turn pass. "pending" = the audit is still
   * running (skeleton entry, superseded by the final entry for the same turn).
   * "empty" = no memory was in play this turn, so there was nothing to audit
   * (explicit terminal so the record settles instead of waiting forever). */
  status?: "ok" | "failed" | "discarded" | "pending" | "empty"
  /** Error class only; raw provider messages are kept out of the durable transcript. */
  errorClass?: string
  /** Verdicts intentionally omitted because the underlying memory changed before commit. */
  dropped?: number
  /** One-sentence turn recap with [M-NN] citations for the memories that mattered (timeline anchor). */
  summary?: string
  turn?: number
}

export type MemoryPreviewDecision = "go_on" | "dismiss" | "without_memory"

/**
 * Per-turn Preview (SPEC §4.10b), appended BEFORE the engine acts: which
 * memories the turn brings, the expected outcome, and whether they changed the
 * plan. Pending until a matching MemoryPreviewDecisionEntry is appended
 * (append-only log; the hydrated message folds the decision in).
 */
/**
 * A maintenance signal riding the gate — at most one per preview, visually
 * secondary. conflict = superseded by a newer memory; revision = a drafted
 * replacement is waiting for a decision; stale = 过期, no reference for
 * `sessionsQuiet` prior sessions (paper's "three commits", session units).
 */
export interface PreviewAttention {
  kind: "conflict" | "revision" | "redundant" | "stale" | "promotion"
  memoryId: string
  content: string
  proposalId?: string
  sessionsQuiet?: number
  /** 'redundant' only: the other half of the near-duplicate pair. */
  otherMemoryId?: string
  otherContent?: string
  /** 'promotion' only: the wider scope this memory has earned. */
  promoteTo?: "project" | "personal"
  /** 'promotion' only: uses + re-observations backing the suggestion. */
  evidenceCount?: number
}

/**
 * The injection receipt: exactly which memories this turn carries, straight
 * from the injection plan — nothing predicted, nothing judged.
 */
export interface MemoryPreviewEntry extends TranscriptEntryBase {
  kind: "memory_preview"
  previewId: string
  /** Formal-study task that owned this preview; durable late-evidence lineage. */
  taskId?: string
  turn?: number
  /** User task used by the turn-scoped Use Planner. */
  task?: string
  memories: Array<{ id: string; content: string; scope: string }>
  /** Injected items landed by THIS turn's transfer stage (incl. reinforce-merges). */
  transferredIds?: string[]
  /** Back-compat single item (first of `attentions`). */
  attention?: PreviewAttention
  /** EVERY open attention item, priority-ordered (user decision 2026-08-05). */
  attentions?: PreviewAttention[]
  /** True when a relevance prediction was kicked off for this preview — the
   * gate card shows a "picking likely-relevant…" state until the
   * memory_preview_relevance entry lands (possibly with an empty list). */
  relevancePending?: boolean
  /** Redesign 2026-08-07: ids the user marked "pay attention" on a previous
   * audit — they seed the injected list with their own source label. */
  attentionIds?: string[]
}

/** A turn-scoped instruction that is both reviewed in the UI and injected. */
export interface ExpectedMemoryUse {
  id: string
  expectedUse: string
}

/**
 * The user's go-on / dismiss / proceed-without-memory decision for a preview.
 * "expired" is system-recorded, never user-requested: a parked gate lost to a
 * server restart resolves as expired when the user tries to decide it.
 */
export interface MemoryPreviewDecisionEntry extends TranscriptEntryBase {
  kind: "memory_preview_decision"
  previewId: string
  decision: MemoryPreviewDecision | "expired"
  /** True when the system auto-proceeded (empty injected set + setting on). */
  auto?: boolean
  /** Present when the user EDITED the gate: only these ids injected this turn. */
  selectedIds?: string[]
  /** Exact turn-scoped instructions shown in the UI and sent to Claude. */
  expectedUses?: ExpectedMemoryUse[]
}

/**
 * Per-memory interrupt (2026-08-19 C1/C2): the participant stopped the turn
 * because they identified a problem involving one working-memory item. Appended right after the
 * cancellation; the client renders it as the inline recovery card. Pending
 * until a matching MemoryInterruptResolutionEntry is appended.
 */
export interface MemoryInterruptEntry extends TranscriptEntryBase {
  kind: "memory_interrupt"
  interruptId: string
  /** The memory the participant flagged by clicking its citation chip. */
  memoryId: string
  /** The streamed sentence the participant stopped at — the recovery card's anchor quote. */
  quote?: string
  /** The interrupted turn's original user prompt; resume re-dispatches it. */
  prompt: string
  /** The interrupted turn's working memory, with per-item cited-so-far state in first-mention order. */
  workingSet: Array<{ id: string; cited: boolean }>
  turn?: number
}

/** The participant's recovery decision for one interrupt. */
export interface MemoryInterruptResolutionEntry extends TranscriptEntryBase {
  kind: "memory_interrupt_resolution"
  interruptId: string
  /** Participant-authored, turn-local correction sent with the resumed run. */
  correction?: string
  /** Read compatibility for transcripts written before recovery used one composer. */
  action?: "content_fixed" | "usage_correction" | "removed_only"
  /** The working-memory ids the resumed turn actually carries. */
  selectedIds: string[]
  /** The flagged memory was hard-locked into this resumed run only. */
  enforced?: boolean
}

/**
 * The sidecar relevance PREDICTION for a preview (REDESIGN D6) — appended
 * when the LLM pass lands (usually ~1-2s after the receipt). A model guess,
 * never a system fact: the card renders it as "likely relevant", visually
 * apart from the injected/cited facts.
 */
export interface MemoryPreviewRelevanceEntry extends TranscriptEntryBase {
  kind: "memory_preview_relevance"
  previewId: string
  /** Preview regeneration number; omitted by older transcripts (= 0). */
  revision?: number
  relevant: Array<{ id: string; why: string }>
  /** Use Planner output for the initially selected relevant/attention items. */
  expectedUses?: ExpectedMemoryUse[]
}

/** Replaces a parked preview's contents after an earlier review is reopened. */
export interface MemoryPreviewUpdateEntry extends TranscriptEntryBase {
  kind: "memory_preview_update"
  previewId: string
  /** Formal-study task that owned this regenerated preview revision. */
  taskId?: string
  revision: number
  memories: Array<{ id: string; content: string; scope: string }>
  relevancePending?: boolean
  attentionIds?: string[]
}

/**
 * Step-one container 1 (redesign 2026-08-07 §3): this conversation's pending
 * proposed memory changes — last turn's captures plus the fresh prompt parse —
 * parked at the turn's start for review BEFORE the agent boots. Candidate
 * content resolves from the memory DB at render time (id-only persistence,
 * same discipline as MemoryCandidatesEntry).
 */
export interface MemoryProposalsEntry extends TranscriptEntryBase {
  kind: "memory_proposals"
  proposalsId: string
  /** Durable opening-Board claim that owns this otherwise ordinary gate. */
  openingReviewId?: string
  turn?: number
  /** True while the prompt-side capture pass is still running. */
  pending?: boolean
  candidates: MemoryCandidateSnapshot[]
}

/** Settles the Step 1 skeleton with the candidate ids found by the pass. */
export interface MemoryProposalsResultEntry extends TranscriptEntryBase {
  kind: "memory_proposals_result"
  proposalsId: string
  candidates: MemoryCandidateSnapshot[]
}

/**
 * Settles a memory_proposals gate. "reviewed" = the user worked the container
 * and continued; "skipped" = the user explicitly skipped; "cancelled" = Stop
 * killed the turn while parked; "expired" = system-recorded for a gate lost
 * to a server restart (never a user choice); "empty" = system-recorded, the
 * step ran and found nothing to review (the card renders as one quiet line
 * so the user still SEES that Step 1 happened).
 */
export interface MemoryProposalsDecisionEntry extends TranscriptEntryBase {
  kind: "memory_proposals_decision"
  proposalsId: string
  decision: "reviewed" | "skipped" | "cancelled" | "expired" | "empty"
}

/** One checkup suggestion as persisted on the transcript (content resolves from the DB at render). */
export type MemoryCheckupKind = "conflict" | "redundancy" | "staleness"

export interface MemoryCheckupSuggestionSnapshot {
  kind: MemoryCheckupKind | "promotion"
  memoryId: string
  otherMemoryId?: string
  promoteTo?: "project" | "personal"
  reason: string
}

/**
 * Step-one container 2 (redesign 2026-08-07 §3): the library checkup.
 * Appended with `pending: true` while the four queries run (the container
 * renders as a skeleton with status words); the matching result entry
 * settles it.
 */
export interface MemoryCheckupEntry extends TranscriptEntryBase {
  kind: "memory_checkup"
  checkupId: string
  openingReviewId?: string
  turn?: number
  pending?: boolean
}

export interface MemoryCheckupResultEntry extends TranscriptEntryBase {
  kind: "memory_checkup_result"
  checkupId: string
  suggestions: MemoryCheckupSuggestionSnapshot[]
  /** Absent on historical and complete results; present when sidecar lanes failed. */
  failedKinds?: MemoryCheckupKind[]
}

/**
 * Settles a checkup gate (same vocabulary as the proposals gate). "empty" =
 * every requested check completed and found nothing to review. "failed" =
 * one or more checks did not complete and no suggestion gate was needed.
 * Both are system-recorded because an undecided memory step is an open gate
 * to the client and would suppress the streaming footer for the whole turn.
 */
export interface MemoryCheckupDecisionEntry extends TranscriptEntryBase {
  kind: "memory_checkup_decision"
  checkupId: string
  decision: "handled" | "skipped" | "cancelled" | "expired" | "empty" | "failed"
}

/**
 * One Transfer suggestion snapshot: source identity/version, a reusable
 * source-prepared rule, and this prompt's task-local materialization. The
 * transcript persists the review evidence verbatim until the user acts.
 */
export interface MemoryTransferSuggestionSnapshot {
  sourceId: string
  sourceContent: string
  sourceScope: "personal" | "project" | "session"
  /** CAS guard: accept only applies while the live source still matches. */
  sourceVersion: number
  /** First-segment label: a project title, or the conversation shelf. */
  sourceLabel: string
  /** @deprecated Historical transcript compatibility only. New Transfer
   * suggestions never set this field, and the client renders `true` rows as
   * passive retired receipts with no scope-changing action. */
  widening?: boolean
  /** Legacy (pre-2026-08-09): the detector's justification — no longer
   * produced or rendered; old transcripts still carry it. */
  reason?: string
  /** The middle representation (metadata, never a standalone memory item).
   * Absent while the live search is still encoding this row — the card shows
   * the shared scan skeleton in its place. */
  rule?: string
  applicability?: string
  /** Source values the encoder stripped as source-local (chipped on the card). */
  stripped?: string[]
  /** The localized form, editable before accepting. Absent while the live
   * search is still decoding this row. */
  content?: string
  /** Content values the decoder bound from the target/task (chipped on the card). */
  bound?: string[]
  detail?: string
  abstractionLevel?: "concrete" | "contextual" | "general"
  /** Preset for the card's landing ScopeControl. */
  suggestedScope?: "personal" | "project" | "session"
  landing?: {
    route: "new" | "reinforces" | "conflicts"
    targetId?: string
    targetContent?: string
    /** Automatic-card CAS for the target snapshot used by Decode. */
    targetVersion?: number
  }
  note?: string
}

/**
 * The Transfer card (Transfer design 2026-08-08): between Step 1 and Step 2 —
 * memories from OUTSIDE this conversation's context worth bringing in. A
 * turn-end source preparation never publishes a card by itself; every prompt
 * runs fresh relevance and current-task materialization first.
 */
export interface MemoryTransferEntry extends TranscriptEntryBase {
  kind: "memory_transfer"
  transferId: string
  openingReviewId?: string
  turn?: number
  /** True while a live cold-start detection is still running (the card
   * renders as a scan skeleton); the matching result entry settles it. */
  pending?: boolean
  suggestions: MemoryTransferSuggestionSnapshot[]
}

/**
 * Streams a live detection into the card: each entry carries the cumulative
 * suggestions materialized so far; `done` marks the final one (the pending
 * scan state clears only then).
 */
export interface MemoryTransferResultEntry extends TranscriptEntryBase {
  kind: "memory_transfer_result"
  transferId: string
  suggestions: MemoryTransferSuggestionSnapshot[]
  done?: boolean
}

/**
 * Settles a Transfer card. "empty" is system-recorded: a VISIBLE live search
 * ran and found nothing — the skeleton settles into one quiet line. A search
 * that finishes empty before its shell becomes visible publishes no card.
 */
export interface MemoryTransferDecisionEntry extends TranscriptEntryBase {
  kind: "memory_transfer_decision"
  transferId: string
  decision: "handled" | "skipped" | "cancelled" | "expired" | "empty"
}

/**
 * Append-only reset marker for returning to Step 1 or Step 2 before the agent
 * starts. The parser clears the selected step and every dependent result.
 */
export interface MemoryPreparationResetEntry extends TranscriptEntryBase {
  kind: "memory_preparation_reset"
  /** Durable opening preparation lineage; absent for ordinary in-chat Review again. */
  openingReviewId?: string
  /** Present after the injected-set preview exists; absent when Step 1 is reopened from Step 2. */
  previewId?: string
  revision: number
  from: "proposals" | "checkup" | "transfer"
  proposalsId?: string
  transferId?: string
  /** Absent when Step 1 is reopened before any checkup exists (mid-transfer). */
  checkupId?: string
}

export type TranscriptEntry =
  | UserPromptEntry
  | SystemInitEntry
  | AccountInfoEntry
  | AssistantTextEntry
  | ToolCallEntry
  | ToolResultEntry
  | ResultEntry
  | StatusEntry
  | ContextWindowUpdatedEntry
  | CompactBoundaryEntry
  | CompactSummaryEntry
  | ContextClearedEntry
  | InterruptedEntry
  | MemoryCandidatesEntry
  | MemoryTraceEntry
  | MemoryPreviewEntry
  | MemoryPreviewDecisionEntry
  | MemoryInterruptEntry
  | MemoryInterruptResolutionEntry
  | MemoryPreviewRelevanceEntry
  | MemoryPreviewUpdateEntry
  | MemoryProposalsEntry
  | MemoryProposalsResultEntry
  | MemoryProposalsDecisionEntry
  | MemoryCheckupEntry
  | MemoryCheckupResultEntry
  | MemoryCheckupDecisionEntry
  | MemoryTransferEntry
  | MemoryTransferResultEntry
  | MemoryTransferDecisionEntry
  | MemoryPreparationResetEntry

export interface HydratedToolCallBase<TKind extends string, TInput, TResult> {
  id: string
  messageId?: string
  hidden?: boolean
  kind: "tool"
  toolKind: TKind
  toolName: string
  toolId: string
  input: TInput
  result?: TResult
  rawResult?: unknown
  isError?: boolean
  timestamp: string
}

export interface AskUserQuestionToolResult {
  answers: AskUserQuestionAnswerMap
  discarded?: boolean
}

export interface ExitPlanModeToolResult {
  confirmed?: boolean
  clearContext?: boolean
  message?: string
  discarded?: boolean
}

export type HydratedAskUserQuestionToolCall =
  HydratedToolCallBase<"ask_user_question", AskUserQuestionToolCall["input"], AskUserQuestionToolResult>

export type HydratedExitPlanModeToolCall =
  HydratedToolCallBase<"exit_plan_mode", ExitPlanModeToolCall["input"], ExitPlanModeToolResult>

export type HydratedTodoWriteToolCall =
  HydratedToolCallBase<"todo_write", TodoWriteToolCall["input"], unknown>

export type HydratedSkillToolCall =
  HydratedToolCallBase<"skill", SkillToolCall["input"], unknown>

export type HydratedGlobToolCall =
  HydratedToolCallBase<"glob", GlobToolCall["input"], unknown>

export type HydratedGrepToolCall =
  HydratedToolCallBase<"grep", GrepToolCall["input"], unknown>

export type HydratedBashToolCall =
  HydratedToolCallBase<"bash", BashToolCall["input"], unknown>

export type HydratedWebSearchToolCall =
  HydratedToolCallBase<"web_search", WebSearchToolCall["input"], unknown>

export interface ReadFileTextBlock {
  type: "text"
  text: string
}

export interface ReadFileImageBlock {
  type: "image"
  data: string
  mimeType?: string
}

export interface ReadFileToolResult {
  content: string
  blocks?: Array<ReadFileTextBlock | ReadFileImageBlock>
}

export type HydratedReadFileToolCall =
  HydratedToolCallBase<"read_file", ReadFileToolCall["input"], ReadFileToolResult | string>

export type HydratedWriteFileToolCall =
  HydratedToolCallBase<"write_file", WriteFileToolCall["input"], unknown>

export type HydratedEditFileToolCall =
  HydratedToolCallBase<"edit_file", EditFileToolCall["input"], unknown>

export type HydratedDeleteFileToolCall =
  HydratedToolCallBase<"delete_file", DeleteFileToolCall["input"], unknown>

export type HydratedSubagentTaskToolCall =
  HydratedToolCallBase<"subagent_task", SubagentTaskToolCall["input"], unknown>

export type HydratedMcpGenericToolCall =
  HydratedToolCallBase<"mcp_generic", McpGenericToolCall["input"], unknown>

export type HydratedUnknownToolCall =
  HydratedToolCallBase<"unknown_tool", UnknownToolCall["input"], unknown>

export type HydratedToolCall =
  | HydratedAskUserQuestionToolCall
  | HydratedExitPlanModeToolCall
  | HydratedTodoWriteToolCall
  | HydratedSkillToolCall
  | HydratedGlobToolCall
  | HydratedGrepToolCall
  | HydratedBashToolCall
  | HydratedWebSearchToolCall
  | HydratedReadFileToolCall
  | HydratedWriteFileToolCall
  | HydratedEditFileToolCall
  | HydratedDeleteFileToolCall
  | HydratedSubagentTaskToolCall
  | HydratedMcpGenericToolCall
  | HydratedUnknownToolCall

export type HydratedTranscriptMessage =
  | ({ kind: "user_prompt"; content: string; attachments?: ChatAttachment[]; steered?: boolean; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "system_init"; model: string; tools: string[]; agents: string[]; slashCommands: string[]; mcpServers: McpServerInfo[]; provider: AgentProvider; id: string; messageId?: string; timestamp: string; hidden?: boolean; debugRaw?: string })
  | ({ kind: "account_info"; accountInfo: AccountInfo; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "assistant_text"; text: string; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "result"; success: boolean; cancelled?: boolean; result: string; durationMs: number; costUsd?: number; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "status"; status: string; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "context_window_updated"; usage: ContextWindowUsageSnapshot; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "compact_boundary"; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "compact_summary"; summary: string; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "context_cleared"; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "interrupted"; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "memory_candidates"; candidates: MemoryCandidateSnapshot[]; turn?: number; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "memory_trace"; labels: MemoryTraceEntry["labels"]; status?: MemoryTraceEntry["status"]; errorClass?: string; dropped?: number; summary?: string; turn?: number; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "memory_preview"; previewId: string; task?: string; memories: Array<{ id: string; content: string; scope: string }>; transferredIds?: string[]; attention?: PreviewAttention; attentions?: PreviewAttention[]; relevant?: Array<{ id: string; why: string }>; expectedUses?: ExpectedMemoryUse[]; relevancePending?: boolean; attentionIds?: string[]; refreshing?: boolean; refreshVersion?: number; turn?: number; decision?: MemoryPreviewDecision | "expired"; decisionAuto?: boolean; decisionSelectedIds?: string[]; decisionExpectedUses?: ExpectedMemoryUse[]; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "memory_proposals"; proposalsId: string; openingReviewId?: string; candidates: MemoryCandidateSnapshot[]; turn?: number; pending?: boolean; decision?: MemoryProposalsDecisionEntry["decision"]; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "memory_interrupt"; interruptId: string; memoryId: string; quote?: string; prompt: string; workingSet: Array<{ id: string; cited: boolean }>; turn?: number; resolution?: { correction?: string; action?: "content_fixed" | "usage_correction" | "removed_only"; selectedIds: string[]; enforced?: boolean }; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "memory_checkup"; checkupId: string; openingReviewId?: string; turn?: number; pending?: boolean; waiting?: boolean; suggestions?: MemoryCheckupSuggestionSnapshot[]; failedKinds?: MemoryCheckupKind[]; decision?: MemoryCheckupDecisionEntry["decision"]; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "memory_transfer"; transferId: string; openingReviewId?: string; suggestions: MemoryTransferSuggestionSnapshot[]; turn?: number; pending?: boolean; decision?: MemoryTransferDecisionEntry["decision"]; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ kind: "unknown"; json: string; id: string; messageId?: string; timestamp: string; hidden?: boolean })
  | ({ id: string; messageId?: string; hidden?: boolean } & HydratedToolCall)

export interface ChatRuntime {
  chatId: string
  projectId: string
  localPath: string
  title: string
  status: ChatActivityStatus
  isDraining: boolean
  provider: AgentProvider | null
  planMode: boolean
  sessionToken: string | null
  /**
   * The in-flight assistant reply, accumulated from engine text deltas while
   * the turn runs. Presentation-only: never persisted — the transcript gets
   * the final assistant_text entry and this resets to null in the same
   * broadcast, so a snapshot never shows both.
   */
  streamingText: string | null
}

export interface ChatHistorySnapshot {
  hasOlder: boolean
  olderCursor: string | null
  recentLimit: number
}

export interface ChatSnapshot {
  runtime: ChatRuntime
  queuedMessages: QueuedChatMessage[]
  messages: TranscriptEntry[]
  /** Compact, full-history input for the Memory Record. Unlike `messages`,
   * this is not clipped to the recent-chat window. */
  memoryRecordMessages?: TranscriptEntry[]
  history: ChatHistorySnapshot
  availableProviders: ProviderCatalogEntry[]
}

export interface ChatHistoryPage {
  messages: TranscriptEntry[]
  hasOlder: boolean
  olderCursor: string | null
}

export interface AppSnapshot {
  sidebar: SidebarData
  chat?: ChatSnapshot | null
}

export interface PendingToolSnapshot {
  toolUseId: string
  toolKind: "ask_user_question" | "exit_plan_mode"
}
