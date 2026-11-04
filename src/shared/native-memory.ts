/** Contracts for bounded, read-only native source discovery and reviewed imports.
 * Roots are server-issued IDs; no endpoint accepts arbitrary file paths.
 */
export type NativeMemoryEngine = 'claude' | 'codex' | 'pi' | 'opencode';
export type NativeSourceKind = 'native-memory' | 'project-rule' | 'skill';
export type NativeMemoryOwner = { scope: 'personal'; projectId?: never; sessionId?: never }
  | { scope: 'project'; projectId: string; sessionId?: never };
export interface NativeMemoryRoot {
  id: string;
  label: string;
  path: string;
  /** Explicit read locations represented by this logical selection, including
   * the selected project's corresponding native engine memory directory. */
  locations?: string[];
  owner: NativeMemoryOwner;
}
export interface NativeMemorySource {
  sourceId: string;
  rootId: string;
  engine: NativeMemoryEngine;
  kind: NativeSourceKind;
  locator: string;
  sourceVersion: number;
  sourceHash: string;
  bytes: number;
  owner: NativeMemoryOwner;
  trust: 'agent-generated' | 'imported-unknown';
  screening: 'clear' | 'blocked-sensitive';
  importable: boolean;
}
export const NATIVE_MEMORY_POLICY = {
  defaultOwner: 'memosync-managed',
  discovery: 'read-only-explicit-locations',
  originalFiles: 'never-modified',
  nativeControl: 'No native memory switch is changed. Native-first is observation only; coexistence is a reviewed one-way import, not automatic synchronization.',
  rulesAndSkills: 'Independent native assets; never imported as conversational memory by this API.',
  screening: 'Local bounded heuristics; a clear result is not a guarantee that text contains no sensitive information.',
} as const;
export interface NativeDiscoveryResult {
  sources: NativeMemorySource[];
  truncated: boolean;
  skipped: number;
  policy: typeof NATIVE_MEMORY_POLICY;
}
export interface NativeImportTarget {
  memoryId: string;
  version: number;
  digest: string;
}
export interface NativeImportItem {
  itemKey: string;
  claimHash: string;
  quoteHash: string;
  content: string;
  provenance: { locator: string; sourceHash: string; quote: string; startLine: number; endLine: number };
  owner: NativeMemoryOwner;
  trust: NativeMemorySource['trust'];
  disposition: 'new' | 'exact-match' | 'unchanged' | 'conflict' | 'suppressed';
  reason?: string;
  target?: NativeImportTarget;
}
export interface NativeImportPlan {
  operationId: string;
  source: NativeMemorySource;
  state: 'proposed';
  extraction: 'local' | 'semantic';
  items: NativeImportItem[];
  blockedReason?: 'sensitive-source' | 'independent-asset';
  createdAt: string;
}
export interface NativeImportDryRunInput {
  operationId: string;
  sourceId: string;
  sourceHash: string;
  extraction?: 'local' | 'semantic';
  /** Required before any screened source text is sent to the optional extractor. */
  allowSemanticExtraction?: boolean;
}
export interface NativeImportCommitInput {
  approved: true;
  approvedItemKeys: string[];
  rejectedItemKeys?: string[];
}
export interface NativeImportReceipt {
  operationId: string;
  state: 'committed';
  accepted: Array<{ itemKey: string; memoryId: string; created: boolean; mappingOwned: boolean }>;
  rejected: string[];
}
export interface NativeImportRollback {
  operationId: string;
  state: 'rolled-back';
  archived: string[];
  conflicts: Array<{ memoryId: string; reason: string }>;
}
export interface NativeImportOperation {
  plan: NativeImportPlan;
  receipt?: NativeImportReceipt;
  rollback?: NativeImportRollback;
}
/** Durable history metadata only; source text and proposals require opening the operation. */
export interface NativeImportSummary {
  operationId: string;
  source: NativeMemorySource;
  createdAt: string;
  state: NativeImportPlan['state'] | NativeImportReceipt['state'] | NativeImportRollback['state'];
}
export interface NativeImportHistory {
  /** At most 50 newest operations belonging to currently allowed roots. */
  operations: NativeImportSummary[];
  hasMore: boolean;
}
