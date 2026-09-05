// Memory domain types — ported from MemoSync (apps/backend/src/types.ts).
// The memory layer is engine-agnostic: these types are shared by the store,
// retrieval, Markdown projection, and the per-engine tool/injection adapters.

export type MemoryScope = 'personal' | 'project' | 'session';
export type MemoryType = 'constraint' | 'preference' | 'lesson' | 'fact';
export type MemoryStatus = 'active' | 'candidate' | 'archived' | 'discarded';
export type MemoryRelationType =
  | 'conflicts_with'
  | 'generalized_from'
  | 'similar_to'
  | 'derived_from'
  // A REVISION candidate proposing to replace its target: accepting the source
  // archives the target (self-evolution M3/M4). Source is always a candidate
  // until resolved.
  | 'revises';

/**
 * Where a memory's claim comes from (self-evolution / Fig 6 confidence input):
 * 'user_stated' = the user said it outright; 'user_corrected' = the user fixed
 * the agent, strongest signal; 'inferred' = deduced from repeated behavior;
 * 'agent_proposed' = the agent noticed it and the user merely accepted.
 */
export type EvidenceClass = 'user_stated' | 'user_corrected' | 'inferred' | 'agent_proposed';


/**
 * How tightly a memory is bound to a specific implementation (SPEC §3):
 * 'concrete' = names specific files/commands/versions; 'contextual' = holds
 * within its project/stack; 'general' = transfers anywhere. Drives the (P2)
 * adaptive-abstraction transfer; until then it is a user-editable label.
 */
export type AbstractionLevel = 'concrete' | 'contextual' | 'general';

/** Who performed a mutation — actor provenance is a core study measurement. */
export type MemoryActor = 'user' | 'agent' | 'system';

/** Attribution threaded into every store mutation (never inferred). */
export interface ActorMeta {
  actor: MemoryActor;
  sessionId?: string;
  turn?: number;
}

export type MemoryEventKind =
  | 'create'
  | 'edit' // content/detail/type/topic/abstraction change
  | 'rescope' // scope change that does not widen reach
  | 'promote' // scope widened: session → project → personal
  | 'status' // candidate→active (accept), candidate→discarded (dismiss), active→archived, …
  | 'revert' // rollback applied (target version in meta.toSeq)
  | 'use' // a citation of this memory by the agent
  | 'trace' // post-turn trace verdict for an injected memory (meta.label)
  | 'reinforce' // the same fact was re-observed in conversation (necessity gate verdict)
  | 'renew'; // the user extended a stale memory's lifecycle (resets the expiry window)

/** Post-turn trace verdict (mirrors trace.ts TraceLabel). */
export type MemoryTraceLabel = 'operational' | 'injected_without_effect' | 'violated' | 'not_applicable';

export interface MemoryRelation {
  type: MemoryRelationType;
  targetId: string;
}

export interface MemoryItem {
  id: string; // e.g. "M-07" — human-readable, stable
  content: string; // the SHORT form: one line, always cheap to inject/show
  detail?: string; // the DETAILED form, loaded on demand ("memory as skills")
  abstractionLevel: AbstractionLevel;
  /** Flagged private/sensitive by the capture privacy gate — needs explicit user confirmation. */
  sensitive: boolean;
  scope: MemoryScope;
  type: MemoryType;
  status: MemoryStatus;
  projectId?: string; // undefined for personal scope
  sessionId?: string; // undefined if not session-scoped
  topic?: string; // e.g. "Testing", "Environment"
  createdAt: string; // ISO
  updatedAt: string;
  provenanceSessionId?: string; // which session created this
  provenanceTurn?: number; // which turn in that session
  usageCount: number; // times cited across all sessions
  /** Times the necessity gate saw the same fact re-observed (Fig 6 "reinforced N×"). */
  reinforcedCount: number;
  /** Where the claim came from — set by the capture pass, user-editable. */
  evidenceClass?: EvidenceClass;
  /**
   * Content version, starting at 1. Bumps ONLY on content-bearing changes
   * (content/detail/scope/type/topic/abstraction) — usage/reinforce never touch
   * it (same discipline as updatedAt). The injection delta cites it
   * ("[M-07] v2→v3") so the model can resolve multi-version context by
   * "same id → highest version wins".
   */
  version: number;
  /** Derived from evidenceClass × reinforcedCount at read time; never stored. */
  /** Latest trace verdict — decorated onto API list responses (health dot). */
  lastTraceLabel?: MemoryTraceLabel;
  /** For REVISION candidates: the memory this proposal would replace (decorated on list reads). */
  revisionOf?: { id: string; content: string };
  citedInCurrentSession: number; // times cited this session
  citedAtSteps?: number[]; // which steps cited it this session
  relations?: MemoryRelation[];
}

export interface ScoredMemory {
  memory: MemoryItem;
  score: number;
}

/** The versioned slice of a memory — what a rollback restores. */
export type MemoryItemSnapshot = Pick<
  MemoryItem,
  'content' | 'detail' | 'scope' | 'type' | 'status' | 'topic' | 'abstractionLevel' | 'projectId' | 'sessionId'
>;

/**
 * One row of the append-only per-item version/usage log (SPEC §3, option 乙).
 * Change events carry a full post-change snapshot (the rollback target);
 * use events carry only meta (e.g. { via: 'citation', detailLoaded: true }).
 */
export interface MemoryEvent {
  seq: number;
  memoryId: string;
  ts: string;
  kind: MemoryEventKind;
  actor: MemoryActor;
  sessionId?: string;
  turn?: number;
  changes?: Record<string, { before: unknown; after: unknown }>;
  snapshot?: MemoryItemSnapshot;
  meta?: Record<string, unknown>;
}
