/** Native memory v2: server-issued identities, read-only sources, reviewed writes. */
export type NativeMemoryEngine = "claude" | "codex" | "pi" | "opencode";
export type NativeSourceKind = "native-memory" | "project-rule" | "skill";
export type NativeMemoryOwner =
  | { scope: "personal"; projectId?: never; sessionId?: never }
  | { scope: "project"; projectId: string; sessionId?: never };
export interface NativeMemoryRoot {
  id: string;
  label: string;
  path: string;
  owner: NativeMemoryOwner;
  locations?: string[];
  memoryLocations?: Array<{ engine: NativeMemoryEngine; path: string }>;
}
export const NATIVE_MEMORY_POLICY = {
  defaultOwner: "memosync-managed",
  discovery: "read-only-explicit-locations",
  originalFiles: "never-modified",
  nativeControl: "Reviewed one-way import; no native settings are changed.",
  rulesAndSkills: "Independent assets, never conversational memory.",
  screening:
    "Local credential-block quarantine; personal information requires review.",
} as const;
export type NativeChangeState = "new" | "changed" | "unchanged" | "removed";
export interface NativeProjectScope {
  path: string;
  projectId?: string;
  label: string;
  verifiedBy: "cwd" | "applies_to" | "session-encoder" | "selected-root";
}
export interface NativeMemorySource {
  sourceId: string;
  rootId: string;
  engine: NativeMemoryEngine;
  namespace: string;
  kind: NativeSourceKind;
  locator: string;
  memoryRoot?: string;
  relativePath?: string;
  sourceVersion: number;
  sourceHash: string;
  bytes: number;
  owner: NativeMemoryOwner;
  trust: "agent-generated" | "imported-unknown";
  screening: "clear" | "blocked-sensitive" | "partially-blocked";
  quarantinedBlocks: number;
  importable: boolean;
  metadata?: Record<string, unknown>;
  instructionImports?: Array<{
    path: string;
    base: string;
    trust: "unverified-source-reference";
  }>;
  role: "units" | "navigation" | "evidence" | "correction" | "asset";
  indexedBy?: string[];
  isIndex?: boolean;
}
export interface NativeDiscoverySkippedEntry {
  path: string;
  reason: "symlink" | "unreadable" | "binary" | "unstable";
}
export interface NativeParseAnomaly {
  locator: string;
  code: string;
}
export interface NativeMemoryUnit {
  unitId: string;
  stableLocator: string;
  sourceId: string;
  engine: NativeMemoryEngine;
  namespace: string;
  title: string;
  topic: string;
  kind: NativeSourceKind;
  owner: NativeMemoryOwner;
  scopes: NativeProjectScope[];
  /** No verified path. A path with no MemoSync project yet is still resolved. */
  unresolvedProject: boolean;
  projectLabel: string;
  contentHash: string;
  parserVersion: string;
  lastImportedHash?: string;
  linkedMemoryIds: string[];
  change: NativeChangeState;
  selectedByDefault: boolean;
  startLine: number;
  endLine: number;
  bytes: number;
  estimatedTokens: number;
  metadata: Record<string, unknown>;
  taskRefs: string[];
  evidenceThreadIds: string[];
  correctionSourceIds: string[];
  correctionHash: string;
  screening: NativeMemorySource["screening"];
  quarantinedBlocks: number;
}
export interface NativeNamespace {
  engine: NativeMemoryEngine;
  namespace: string;
  active: boolean | null;
  activeReason: string;
  selectedByDefault: boolean;
}
export interface NativeInventoryGroup {
  engine: NativeMemoryEngine;
  namespace: string;
  projectLabel: string;
  projectIds: string[];
  unitIds: string[];
  counts: Record<NativeChangeState, number>;
  estimatedTokens: number;
}
export interface NativeInventoryInput {
  rootIds?: string[];
}
export interface NativeInventoryResult {
  roots: NativeMemoryRoot[];
  sources: NativeMemorySource[];
  units: NativeMemoryUnit[];
  namespaces: NativeNamespace[];
  groups: NativeInventoryGroup[];
  counts: Record<NativeChangeState, number>;
  estimatedTokens: number;
  anomalies: NativeParseAnomaly[];
  skippedEntries: NativeDiscoverySkippedEntry[];
  policy: typeof NATIVE_MEMORY_POLICY;
}
export interface NativeUnitSource {
  unit: NativeMemoryUnit;
  source: NativeMemorySource;
  text: string;
  corrections: Array<{ sourceId: string; text: string }>;
}
export interface NativeModelSelection {
  provider: NativeMemoryEngine;
  model: string;
  connectionId?: string;
  effort?: string;
}
export interface NativeRefineJobInput {
  unitIds: string[];
  model: NativeModelSelection;
  instruction?: string;
  sample?: number;
}
export interface NativeTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
}
export interface NativeRefinedClaim {
  scope: "personal" | "project";
  content: string;
  quote: string;
}
export interface NativeUnitRefinement {
  unitId: string;
  items: NativeRefinedClaim[];
  needEvidence?: string[];
}
export type NativeBatchState =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
export interface NativeRefineBatch {
  batchId: string;
  unitIds: string[];
  state: NativeBatchState;
  attempts: number;
  droppedQuotes: number;
  usage?: NativeTokenUsage;
  error?: string;
  operationId?: string;
}
export interface NativeRefineJob {
  jobId: string;
  input: NativeRefineJobInput;
  state: "queued" | "running" | "completed" | "failed" | "cancelled";
  batches: NativeRefineBatch[];
  createdAt: string;
  updatedAt: string;
}
export interface NativeOverviewInput {
  unitIds?: string[];
  model: NativeModelSelection;
  instruction?: string;
}
export interface NativeOverviewTopic {
  id: string;
  title: string;
  summary: string;
  unitIds: string[];
  samples: string[];
}
export interface NativeOverviewResult {
  navigationHash: string;
  cached: boolean;
  topics: NativeOverviewTopic[];
  usage?: NativeTokenUsage;
}
export interface NativeImportTarget {
  /** Snapshot owner for safe reviewed moves of importer-owned memories. */
  owner?: NativeMemoryOwner;
  memoryId: string;
  version: number;
  digest: string;
}
export interface NativeImportItem {
  itemKey: string;
  unitId: string;
  content: string;
  claimHash: string;
  quoteHash: string;
  context: string;
  flags?: Array<"personal-info" | "unattributed">;
  /** Verified home, retained even on a personal proposal so review can move it. */
  projectPath?: string;
  projectLabel?: string;
  provenance: {
    locator: string;
    sourceHash: string;
    quote: string;
    startLine: number;
    endLine: number;
  };
  /** A project proposal may await creation of its verified home at commit. */
  owner: NativeMemoryOwner | { scope: "project"; projectId?: undefined };
  trust: NativeMemorySource["trust"];
  disposition:
    | "new"
    | "exact-match"
    | "unchanged"
    | "changed"
    | "conflict"
    | "suppressed";
  reason?: string;
  target?: NativeImportTarget;
}
export interface NativeImportPlanInput {
  operationId: string;
  unitIds: string[];
}
export interface NativeImportPlan {
  operationId: string;
  units: NativeMemoryUnit[];
  state: "proposed";
  extraction: "local" | "refined";
  items: NativeImportItem[];
  droppedQuotes: number;
  createdAt: string;
}
export interface NativeImportCommitInput {
  approved: true;
  approvedItemKeys: string[];
  rejectedItemKeys?: string[];
  scopeOverrides?: Record<string, "personal" | "project">;
}
export interface NativeImportReceipt {
  operationId: string;
  state: "committed";
  accepted: Array<{
    itemKey: string;
    memoryId: string;
    created: boolean;
    updated: boolean;
    mappingOwned: boolean;
  }>;
  rejected: string[];
  createdProjects: Array<{ projectId: string; projectPath: string }>;
}
export interface NativeImportRollback {
  operationId: string;
  state: "rolled-back";
  archived: string[];
  restored: string[];
  conflicts: Array<{ memoryId: string; reason: string }>;
}
export interface NativeImportOperation {
  plan: NativeImportPlan;
  receipt?: NativeImportReceipt;
  rollback?: NativeImportRollback;
}
export interface NativeImportSummary {
  operationId: string;
  unitIds: string[];
  createdAt: string;
  state: "proposed" | "committed" | "rolled-back";
}
export interface NativeImportHistory {
  operations: NativeImportSummary[];
  hasMore: boolean;
}
export interface NativeRemovedItem {
  removalId: string;
  content: string;
  context?: string;
  owner: NativeImportItem["owner"];
  projectPath?: string;
  projectLabel?: string;
  engine: NativeMemoryEngine;
  unitId: string;
  unitTitle: string;
  operationId: string;
  removedAt: string;
  sourceExists: boolean;
  /** Set aside by undoing an import rather than at review; it can only be imported again. */
  undone: boolean;
}
export interface NativeRemovedResult {
  items: NativeRemovedItem[];
}
export interface NativeRestoreInput {
  removalIds: string[];
  mode: "import" | "suggest";
}
export type NativeRestoreResult =
  | { removalIds: string[]; mode: "import"; receipt: NativeImportReceipt }
  | { removalIds: string[]; mode: "suggest" };
export interface NativeRootsResult {
  roots: NativeMemoryRoot[];
  policy: typeof NATIVE_MEMORY_POLICY;
}
export interface NativeRollbackInput {
  approved: true;
}
export interface NativeApiError {
  error: { code: string; message: string };
}

export interface NativeApiSuccess<T> {
  data: T;
}
