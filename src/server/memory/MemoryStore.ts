import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { computeMemoryHash } from './hash';
import type {
  AbstractionLevel,
  ActorMeta,
  EvidenceClass,
  MemoryEvent,
  MemoryEventKind,
  MemoryItem,
  MemoryItemSnapshot,
  MemoryRelation,
  MemoryRelationType,
  MemoryScope,
  MemoryStatus,
  MemoryTraceLabel,
  MemoryType,
} from './types';

/** Values SQLite can bind (subset of bun:sqlite's SQLQueryBindings). */
type Bind = string | number | bigint | boolean | null | Uint8Array;

export interface CreateMemoryInput {
  content: string;
  detail?: string;
  abstractionLevel?: AbstractionLevel;
  sensitive?: boolean;
  scope: MemoryScope;
  type: MemoryType;
  status?: MemoryStatus;
  expiresAt?: string | null;
  projectId?: string;
  sessionId?: string;
  topic?: string;
  provenanceSessionId?: string;
  provenanceTurn?: number;
  evidenceClass?: EvidenceClass;
  /** Optional explicit id (e.g. seeding). Otherwise auto-generated. */
  id?: string;
}

export interface MemoryFilter {
  scope?: MemoryScope;
  projectId?: string;
  sessionId?: string;
  status?: MemoryStatus;
}

/** Extra context recorded on a 'use' event. */
export interface UseMeta extends ActorMeta {
  /** How the memory was used, e.g. 'citation'. */
  via?: string;
  /** Whether the agent loaded the detailed form (vs short form only). */
  detailLoaded?: boolean;
}

interface MemoryRow {
  id: string;
  content: string;
  detail: string | null;
  abstraction_level: string;
  sensitive: number;
  scope: string;
  type: string;
  status: string;
  expires_at: string | null;
  project_id: string | null;
  session_id: string | null;
  topic: string | null;
  provenance_session_id: string | null;
  provenance_turn: number | null;
  usage_count: number;
  reinforced_count: number;
  evidence_class: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

interface MemoryEventRow {
  seq: number;
  memory_id: string;
  ts: string;
  kind: string;
  actor: string;
  session_id: string | null;
  turn: number | null;
  changes: string | null;
  snapshot: string | null;
  meta: string | null;
}

export class TraceCorrectionError extends Error {
  constructor(public status: 400 | 409, message: string) { super(message); }
}

type TraceCorrectionMeta = { label?: MemoryTraceLabel; auditLabel?: MemoryTraceLabel; note?: string; withdrawn?: boolean; cited?: boolean };

/** Maps MemoryItem patch keys to their DB column names. */
const UPDATABLE_COLUMNS: Record<string, string> = {
  content: 'content',
  detail: 'detail',
  abstractionLevel: 'abstraction_level',
  sensitive: 'sensitive',
  scope: 'scope',
  type: 'type',
  status: 'status',
  expiresAt: 'expires_at',
  projectId: 'project_id',
  sessionId: 'session_id',
  topic: 'topic',
  provenanceSessionId: 'provenance_session_id',
  provenanceTurn: 'provenance_turn',
  evidenceClass: 'evidence_class',
};

/** The fields a version snapshot captures — what rollback restores. */
const VERSIONED_FIELDS = [
  'content',
  'detail',
  'scope',
  'type',
  'status',
  'expiresAt',
  'topic',
  'abstractionLevel',
  'projectId',
  'sessionId',
] as const;

/** Reach order for promote-vs-rescope classification. */
const SCOPE_REACH: Record<MemoryScope, number> = { session: 0, project: 1, personal: 2 };

/** Patch keys whose change means "the text/meaning the model acts on moved" — these bump `version`. */
const CONTENT_VERSION_FIELDS = ['content', 'detail', 'scope', 'projectId', 'sessionId', 'type', 'topic', 'abstractionLevel', 'expiresAt'] as const;

type CandidateDecisionTransition = 'ordinary' | 'dismiss' | 'restore';

/**
 * A Candidate dismissal is a domain decision, not another editable status.
 * Routes map this store-owned error to the stable CANDIDATE_DISCARDED response.
 */
export class CandidateDismissalTransitionError extends Error {
  readonly code = 'CANDIDATE_DISCARDED';

  constructor(message = 'A dismissed Candidate is immutable. Restore a non-sensitive Candidate through its review flow.') {
    super(message);
    this.name = 'CandidateDismissalTransitionError';
  }
}

export class RevisionConflictError extends Error {
  readonly code = 'CONFLICT';

  constructor() {
    super('Revision targets changed or their reviewed snapshot is unavailable; review the revision again');
    this.name = 'RevisionConflictError';
  }
}

export class MemoryStore {
  constructor(private db: Database) {}

  /** sha1-based memory-set hash. */
  static computeHash(items: Array<Pick<MemoryItem, 'id' | 'content'>>): string {
    return computeMemoryHash(items);
  }

  create(input: CreateMemoryInput, meta: ActorMeta): MemoryItem {
    return this.db.transaction(() => {
      const id = input.id ?? this.nextId();
      if (this.db.query(
        'SELECT 1 FROM dismissed_candidate_fingerprints WHERE memory_id = ?',
      ).get(id)) {
        throw new Error(`Memory id was already used by a dismissed candidate: ${id}`);
      }
      if (this.db.query('SELECT 1 FROM memory_capture_operations WHERE memory_id = ?').get(id)) {
        throw new Error(`Memory id was already used by a committed operation: ${id}`);
      }
      const now = new Date().toISOString();
      this.db
        .query(
          `INSERT INTO memories
             (id, content, detail, abstraction_level, sensitive, scope, type, status, project_id, session_id, topic,
              provenance_session_id, provenance_turn, usage_count, reinforced_count, evidence_class, expires_at, created_at, updated_at)
           VALUES
             ($id, $content, $detail, $abstraction_level, $sensitive, $scope, $type, $status, $project_id, $session_id, $topic,
              $provenance_session_id, $provenance_turn, $usage_count, $reinforced_count, $evidence_class, $expires_at, $created_at, $updated_at)`,
        )
        .run({
          $id: id,
          $content: input.content,
          $detail: input.detail ?? null,
          $abstraction_level: input.abstractionLevel ?? 'contextual',
          $sensitive: input.sensitive ? 1 : 0,
          $scope: input.scope,
          $type: input.type,
          $status: input.status ?? 'active',
          $project_id: input.projectId ?? null,
          $session_id: input.sessionId ?? null,
          $topic: input.topic ?? null,
          $provenance_session_id: input.provenanceSessionId ?? null,
          $provenance_turn: input.provenanceTurn ?? null,
          $usage_count: 0,
          $reinforced_count: 0,
          $evidence_class: input.evidenceClass ?? null,
          $expires_at: input.expiresAt ?? null,
          $created_at: now,
          $updated_at: now,
        });
      const created = this.getById(id)!;
      this.appendEvent(id, 'create', meta, { snapshot: this.snapshotOf(created) });
      return created;
    })();
  }

  /**
   * Create one transferred memory together with the provenance relation that
   * makes it a valid landing. An optional semantic-conflict relation belongs
   * to the same commit. If any relation write fails, SQLite rolls back the
   * item and its create event instead of leaving an orphan in the pool.
   */
  createDerivedMemory(
    input: CreateMemoryInput,
    sourceId: string,
    meta: ActorMeta,
    opts?: { conflictsWith?: string },
  ): MemoryItem {
    return this.db.transaction(() => {
      const created = this.create(input, meta);
      this.addRelation(created.id, sourceId, 'derived_from');
      if (opts?.conflictsWith) this.addRelation(created.id, opts.conflictsWith, 'conflicts_with');
      return created;
    })() as MemoryItem;
  }

  getById(id: string): MemoryItem | null {
    const row = this.db.query('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | null;
    return row ? this.rowToItem(row) : null;
  }

  list(filter: MemoryFilter = {}): MemoryItem[] {
    const clauses: string[] = [];
    const params: Bind[] = [];
    if (filter.scope) {
      clauses.push('scope = ?');
      params.push(filter.scope);
    }
    if (filter.projectId) {
      clauses.push('project_id = ?');
      params.push(filter.projectId);
    }
    if (filter.sessionId) {
      clauses.push('session_id = ?');
      params.push(filter.sessionId);
    }
    if (filter.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    // Order numerically by the id's numeric suffix so M-99 precedes M-100.
    const rows = this.db
      .query(
        `SELECT * FROM memories${where}
         ORDER BY CAST(SUBSTR(id, INSTR(id, '-') + 1) AS INTEGER), id`,
      )
      .all(...params) as MemoryRow[];
    return rows.map((r) => this.rowToItem(r));
  }

  /**
   * A scope move clears the binding columns the new scope has no use for —
   * a personal memory carries no projectId/sessionId, a project one no
   * sessionId, a session one no projectId. Stale bindings otherwise leak
   * back through provenance displays, later moves, and transfer targeting.
   */
  private normalizeScopePatch(existing: MemoryItem, patch: Partial<MemoryItem>): Partial<MemoryItem> {
    if (!patch.scope || patch.scope === existing.scope) return patch;
    const normalized = { ...patch } as Record<string, unknown>;
    if (patch.scope === 'personal') {
      normalized.projectId = null;
      normalized.sessionId = null;
    } else if (patch.scope === 'project') {
      normalized.sessionId = null;
    } else {
      normalized.projectId = null;
    }
    return normalized as Partial<MemoryItem>;
  }

  private candidateDismissalEvidence(id: string): { sensitive: boolean } | null {
    const row = this.db.query(
      'SELECT sensitive FROM dismissed_candidate_fingerprints WHERE memory_id = ?',
    ).get(id) as { sensitive: number } | null;
    return row ? { sensitive: row.sensitive === 1 } : null;
  }

  private recordCandidateDismissal(existing: MemoryItem): void {
    this.db.query(
      `INSERT INTO dismissed_candidate_fingerprints
         (memory_id, fingerprint, dismissed_at, sensitive, scope, owner_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(memory_id) DO UPDATE SET
         dismissed_at = excluded.dismissed_at,
         sensitive = MAX(dismissed_candidate_fingerprints.sensitive, excluded.sensitive)`,
    ).run(
      existing.id,
      this.candidateFingerprint(existing.content),
      new Date().toISOString(),
      existing.sensitive ? 1 : 0,
      existing.scope,
      existing.scope === 'project' ? existing.projectId ?? null : existing.scope === 'session' ? existing.sessionId ?? null : null,
    );
  }

  private hasDiscardedStatusHistory(id: string): boolean {
    return Boolean(this.db.query(
      `SELECT 1 FROM memory_events
        WHERE memory_id = ?
          AND kind = 'status'
          AND json_extract(changes, '$.status.after') = 'discarded'
        LIMIT 1`,
    ).get(id));
  }

  /**
   * The single status-transition seam for Candidate decisions.
   *
   * - Ordinary mutations may neither enter nor leave a dismissed decision.
   * - Only dismissCandidate may enter discarded.
   * - Only restoreDismissedCandidate may leave it, and never for sensitive data.
   * - A retained sensitive legacy row stays inert even if an older build moved
   *   it through archived: its persisted dismissal record/history still wins.
   */
  private assertCandidateDecisionTransition(
    existing: MemoryItem,
    patch: Partial<MemoryItem>,
    transition: CandidateDecisionTransition,
  ): void {
    const nextStatus = patch.status;
    const dismissalEvidence = this.candidateDismissalEvidence(existing.id);
    if (transition === 'dismiss') {
      if (existing.status !== 'candidate' || nextStatus !== 'discarded') {
        throw new Error(`Only a Candidate can be dismissed (got ${existing.status})`);
      }
      return;
    }
    if (transition === 'restore') {
      if (existing.status !== 'discarded' || nextStatus !== 'candidate') {
        throw new CandidateDismissalTransitionError(
          `Only a soft-dismissed Candidate can be restored (got ${existing.status})`,
        );
      }
      if (existing.sensitive || dismissalEvidence?.sensitive) {
        throw new CandidateDismissalTransitionError('Sensitive candidates cannot be restored after dismissal.');
      }
      if (!dismissalEvidence) {
        throw new CandidateDismissalTransitionError(
          `Dismissed candidate has no recoverable suppression record: ${existing.id}`,
        );
      }
      return;
    }

    if (nextStatus === 'discarded') {
      throw new CandidateDismissalTransitionError(
        'Candidate dismissal must use the dedicated dismissal flow.',
      );
    }
    const protectedDecision = existing.status === 'discarded'
      || dismissalEvidence !== null
      || (existing.sensitive && this.hasDiscardedStatusHistory(existing.id));
    if (protectedDecision) throw new CandidateDismissalTransitionError();
  }

  /** Called inside the same transaction as the status write, including History rollback. */
  private syncMemoryRevocation(existing: MemoryItem, nextStatus: MemoryStatus | undefined): void {
    if (nextStatus === 'archived') {
      this.db.query(`INSERT OR IGNORE INTO memory_revocations
        (memory_id, fingerprint, scope, owner_id, revoked_at) VALUES (?, ?, ?, ?, ?)`)
        .run(existing.id, this.candidateFingerprint(existing.content), existing.scope,
          existing.scope === 'project' ? existing.projectId ?? null : existing.scope === 'session' ? existing.sessionId ?? null : null,
          new Date().toISOString());
    } else if (existing.status === 'archived' && nextStatus === 'active') {
      this.db.query('DELETE FROM memory_revocations WHERE memory_id = ?').run(existing.id);
    }
  }

  private updateWithCandidateDecision(
    id: string,
    patch: Partial<MemoryItem>,
    meta: ActorMeta,
    transition: CandidateDecisionTransition,
    eventKind?: MemoryEventKind,
  ): MemoryItem {
    return this.db.transaction(() => {
      const existing = this.getById(id);
      if (!existing) throw new Error(`Memory not found: ${id}`);
      this.assertCandidateDecisionTransition(existing, patch, transition);
      patch = this.normalizeScopePatch(existing, patch);

    // Only fields that actually differ count as a change; `undefined` means
    // "leave unchanged". A patch that changes nothing is a full no-op (no
    // updated_at bump, no event).
    const sets: string[] = [];
    const params: Record<string, Bind> = { $id: id };
    const changes: Record<string, { before: unknown; after: unknown }> = {};
    for (const [key, column] of Object.entries(UPDATABLE_COLUMNS)) {
      const value = (patch as Record<string, unknown>)[key];
      if (value === undefined) continue;
      const before = (existing as unknown as Record<string, unknown>)[key] ?? null;
      const after = value ?? null;
      if (before === after) continue;
      sets.push(`${column} = $${column}`);
      params[`$${column}`] = after as Bind;
      changes[key] = { before, after };
    }

      if (sets.length === 0) return existing;
      this.syncMemoryRevocation(existing, patch.status);

    sets.push('updated_at = $updated_at');
    params.$updated_at = new Date().toISOString();
    // Content-bearing changes bump the injection version (delta anchor).
    // Status-only transitions (accept/archive) deliberately do not: the text
    // the model would act on is unchanged, and the delta reports lifecycle
    // moves (added/archived) separately from edits (v2→v3).
    if (CONTENT_VERSION_FIELDS.some((f) => f in changes)) {
      sets.push('version = version + 1');
    }
    this.db.query(`UPDATE memories SET ${sets.join(', ')} WHERE id = $id`).run(params);

    const updated = this.getById(id)!;
    this.appendEvent(id, eventKind ?? this.classifyChange(existing, changes), meta, {
      changes,
      snapshot: this.snapshotOf(updated),
    });
      return updated;
    })();
  }

  update(id: string, patch: Partial<MemoryItem>, meta: ActorMeta): MemoryItem {
    return this.updateWithCandidateDecision(id, patch, meta, 'ordinary');
  }

  /** Soft delete: set status to 'archived'. The id is never reused. */
  archive(id: string, meta: ActorMeta): MemoryItem {
    return this.update(id, { status: 'archived' }, meta);
  }

  expireDue(now = new Date().toISOString()): MemoryItem[] {
    return this.db.transaction(() => {
      const rows = this.db.query(`SELECT id FROM memories WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ? ORDER BY id`).all(now) as Array<{ id: string }>;
      return rows.map(({ id }) => this.updateWithCandidateDecision(id, { status: 'archived' }, { actor: 'system' }, 'ordinary', 'expire'));
    })();
  }

  latestEventSeq(): number {
    return (this.db.query('SELECT COALESCE(MAX(seq), 0) AS seq FROM memory_events').get() as { seq: number }).seq;
  }

  expirationsSince(seq: number, projectId?: string, sessionId?: string): { ids: string[]; lastSeq: number } {
    const rows = this.db.query(`SELECT e.seq, e.memory_id FROM memory_events e JOIN memories m ON m.id=e.memory_id
      WHERE e.kind='expire' AND e.seq > ? AND (m.scope='personal' OR (m.scope='project' AND m.project_id=?) OR (m.scope='session' AND m.session_id=?)) ORDER BY e.seq`).all(seq, projectId ?? null, sessionId ?? null) as Array<{ seq: number; memory_id: string }>;
    return { ids: [...new Set(rows.map(row => row.memory_id))], lastSeq: this.latestEventSeq() };
  }

  wasArchivedAt(id: string, seq: number): boolean {
    const row = this.db.query('SELECT snapshot FROM memory_events WHERE memory_id = ? AND seq <= ? AND snapshot IS NOT NULL ORDER BY seq DESC LIMIT 1').get(id, seq) as { snapshot: string } | null;
    return row ? JSON.parse(row.snapshot).status === 'archived' : false;
  }

  /**
   * HARD-remove a pending candidate and every draft artifact. Used for
   * SENSITIVE candidates, where dismissal must erase the text (only the
   * normalized fingerprint survives, for exact-repeat suppression).
   *
   * Accepted trade-off: erasing the events means a sensitive dismissal never
   * counts toward candidateResolutionsSince (the policy-memo trigger runs a
   * touch slow) and never joins the few-shot negative examples — sensitive
   * text must not reach LLM prompts, and that boundary outranks counting
   * accuracy. The usage log is unaffected: routes emits its
   * memory.decision event regardless.
   */
  discardCandidate(id: string): void {
    this.db.transaction(() => {
      const existing = this.getById(id);
      if (!existing) throw new Error(`Memory not found: ${id}`);
      if (existing.status !== 'candidate') throw new Error(`Memory is not a candidate: ${id}`);
      this.recordCandidateDismissal(existing);
      this.db.query('DELETE FROM memory_kv WHERE key = ?').run(`revision_targets:${id}`);
      this.db.query('DELETE FROM memory_kv WHERE key = ?').run(`revision_trace_evidence:${id}`);
      this.db.query('DELETE FROM memory_relations WHERE source_id = ? OR target_id = ?').run(id, id);
      this.db.query('DELETE FROM memory_events WHERE memory_id = ?').run(id);
      this.db.query('DELETE FROM memories WHERE id = ?').run(id);
    })();
  }

  /**
   * Erase a candidate that was never shown to anyone — the rollback half of a
   * two-phase commit (e.g. Localized drafts whose gate card failed to append).
   * Unlike discardCandidate this leaves NO dismissal fingerprint: nobody
   * rejected it, so nothing may teach the gate that they did.
   */
  eraseCandidate(id: string): void {
    this.db.transaction(() => {
      const existing = this.getById(id);
      if (!existing) return;
      if (existing.status !== 'candidate') throw new Error(`Memory is not a candidate: ${id}`);
      this.db.query('DELETE FROM memory_kv WHERE key = ?').run(`revision_targets:${id}`);
      this.db.query('DELETE FROM memory_kv WHERE key = ?').run(`revision_trace_evidence:${id}`);
      this.db.query('DELETE FROM memory_relations WHERE source_id = ? OR target_id = ?').run(id, id);
      this.db.query('DELETE FROM memory_events WHERE memory_id = ?').run(id);
      this.db.query('DELETE FROM memories WHERE id = ?').run(id);
    })();
  }

  dismissCandidate(id: string, meta: ActorMeta): MemoryItem {
    return this.db.transaction(() => {
      const existing = this.getById(id);
      if (!existing) throw new Error(`Memory not found: ${id}`);
      if (existing.status !== 'candidate') throw new Error(`Memory is not a candidate: ${id}`);
      this.recordCandidateDismissal(existing);
      return this.updateWithCandidateDecision(id, { status: 'discarded' }, meta, 'dismiss');
    })();
  }

  /**
   * Apply the user's Dismiss decision using store-owned privacy
   * authority. Mutable Candidate fields are not sufficient for this choice:
   * a legacy row may have been relabelled after an earlier sensitive
   * dismissal, while its durable tombstone still requires secure erasure.
   */
  dismissCandidateByPolicy(id: string, meta: ActorMeta): 'hard_erased' | 'soft_dismissed' {
    return this.db.transaction(() => {
      const existing = this.getById(id);
      if (!existing) throw new Error(`Memory not found: ${id}`);
      if (existing.status !== 'candidate') throw new Error(`Memory is not a candidate: ${id}`);
      const evidence = this.candidateDismissalEvidence(id);
      if (existing.sensitive || evidence?.sensitive) {
        this.discardCandidate(id);
        return 'hard_erased';
      }
      this.dismissCandidate(id, meta);
      return 'soft_dismissed';
    })();
  }

  /**
   * Inverse of a non-sensitive soft dismissal. The Candidate row and its exact
   * repeat-suppression fingerprint move back to the review lane atomically.
   * Sensitive dismissals are hard deletes, so they deliberately fail the
   * not-found guard and no secret is reconstructed here.
   */
  restoreDismissedCandidate(id: string, meta: ActorMeta): MemoryItem {
    return this.db.transaction(() => {
      const existing = this.getById(id);
      if (!existing) throw new Error(`Dismissed candidate is not recoverable: ${id}`);
      const restored = this.updateWithCandidateDecision(id, { status: 'candidate' }, meta, 'restore');
      const lifted = this.db
        .query('DELETE FROM dismissed_candidate_fingerprints WHERE memory_id = ?')
        .run(id);
      if (lifted.changes !== 1) throw new Error(`Failed to lift candidate suppression: ${id}`);
      return restored;
    })() as MemoryItem;
  }

  /** Replace a pending draft while erasing its previous content from version history. */
  replaceCandidateDraft(id: string, patch: Partial<MemoryItem>, meta: ActorMeta): MemoryItem {
    const replaced = this.db.transaction(() => {
      const existing = this.getById(id);
      if (!existing) throw new Error(`Memory not found: ${id}`);
      if (existing.status !== 'candidate') throw new Error(`Memory is not a candidate: ${id}`);
      this.assertCandidateDecisionTransition(existing, patch, 'ordinary');
      patch = this.normalizeScopePatch(existing, patch);

      const sets: string[] = [];
      const params: Record<string, Bind> = { $id: id };
      let expiryChanged = false;
      for (const [key, column] of Object.entries(UPDATABLE_COLUMNS)) {
        if (key === 'status') continue;
        const value = (patch as Record<string, unknown>)[key];
        if (value === undefined) continue;
        const before = (existing as unknown as Record<string, unknown>)[key] ?? null;
        const after = value ?? null;
        if (before === after) continue;
        if (key === 'expiresAt') expiryChanged = true;
        sets.push(`${column} = $${column}`);
        params[`$${column}`] = after as Bind;
      }

      if (sets.length === 0) return existing;
      if (expiryChanged) sets.push('version = version + 1');
      sets.push('updated_at = $updated_at');
      params.$updated_at = new Date().toISOString();
      this.db.query(`UPDATE memories SET ${sets.join(', ')} WHERE id = $id`).run(params);

      const replaced = this.getById(id)!;
      this.db.query('DELETE FROM memory_events WHERE memory_id = ?').run(id);
      this.appendEvent(id, 'create', meta, { snapshot: this.snapshotOf(replaced) });
      return replaced;
    })();
    return replaced;
  }

  acceptReviewedSensitiveCandidate(
    id: string,
    patch: Partial<MemoryItem> & { content: string; detail: string },
    meta: ActorMeta,
  ): { updated: MemoryItem; replaced: MemoryItem[] } {
    return this.db.transaction(() => {
      const existing = this.getById(id);
      if (!existing) throw new Error(`Memory not found: ${id}`);
      if (existing.status !== 'candidate' || !existing.sensitive) {
        throw new Error(`Memory is not a sensitive candidate: ${id}`);
      }
      if (typeof patch.content !== 'string' || typeof patch.detail !== 'string') {
        throw new Error('Reviewed Content and explicit Detail are required');
      }
      const content = patch.content.trim();
      const detail = patch.detail.trim();
      if (!content || content === existing.content.trim()) {
        throw new Error('Reviewed Content must replace the original sensitive text');
      }
      if (patch.sensitive === false) {
        throw new Error('A sensitive candidate cannot be re-labelled during review');
      }

      const { status: _status, ...draftPatch } = patch;
      this.replaceCandidateDraft(
        id,
        { ...draftPatch, content, detail, sensitive: true },
        meta,
      );
      return this.acceptRevision(id, meta);
    })() as { updated: MemoryItem; replaced: MemoryItem[] };
  }

  /** Exact, whitespace/case-normalized rejection check without retaining text. */
  wasCandidateDismissed(content: string, owner?: { scope: MemoryScope; projectId?: string; sessionId?: string }): boolean {
    const fingerprint = this.candidateFingerprint(content);
    if (!owner) return Boolean(this.db.query(
      'SELECT 1 FROM dismissed_candidate_fingerprints WHERE fingerprint = ?',
    ).get(fingerprint));
    const ownerId = owner.scope === 'project' ? owner.projectId ?? null : owner.scope === 'session' ? owner.sessionId ?? null : null;
    return Boolean(this.db.query(`SELECT 1 FROM dismissed_candidate_fingerprints
      WHERE fingerprint = ? AND (scope IS NULL OR (scope = ? AND owner_id IS ?))`)
      .get(fingerprint, owner.scope, ownerId));
  }

  /** Shared negative-decision policy for capture and external Markdown import. */
  wasMemorySuppressed(content: string, owner: { scope: MemoryScope; projectId?: string; sessionId?: string }): boolean {
    if (this.wasCandidateDismissed(content, owner)) return true;
    const fingerprint = this.candidateFingerprint(content);
    const ownerId = owner.scope === 'project' ? owner.projectId ?? null : owner.scope === 'session' ? owner.sessionId ?? null : null;
    if (this.db.query(`SELECT 1 FROM memory_revocations WHERE fingerprint = ? AND scope = ? AND owner_id IS ?`)
      .get(fingerprint, owner.scope, ownerId)) return true;
    // Read compatibility for archived rows written before revocation receipts.
    return this.list({ scope: owner.scope, projectId: owner.projectId, sessionId: owner.sessionId, status: 'archived' })
      .some(item => this.candidateFingerprint(item.content) === fingerprint);
  }

  getCaptureOperation(key: string): { memoryId?: string } | null {
    const row = this.db.query('SELECT memory_id FROM memory_capture_operations WHERE operation_key = ?')
      .get(key) as { memory_id: string | null } | null;
    return row ? (row.memory_id ? { memoryId: row.memory_id } : {}) : null;
  }

  recordCaptureOperation(key: string, turnKey: string, memoryId?: string): void {
    this.db.query(`INSERT INTO memory_capture_operations (operation_key, turn_key, memory_id, committed_at)
      VALUES (?, ?, ?, ?)`).run(key, turnKey, memoryId ?? null, new Date().toISOString());
  }

  wasCapturedThisTurn(turnKey: string, memoryId: string): boolean {
    return Boolean(this.db.query('SELECT 1 FROM memory_capture_operations WHERE turn_key = ? AND memory_id = ?')
      .get(turnKey, memoryId));
  }

  /**
   * The muted-proposals shelf: every dismissal fingerprint, joined back to the
   * discarded row for a human-readable label. Non-sensitive suppression can
   * be lifted; sensitive content stays masked behind an immutable tombstone.
   */
  listMutedProposals(): Array<{
    memoryId: string;
    content: string | null;
    dismissedAt: string;
    canUnmute: boolean;
  }> {
    const rows = this.db
      .query(
        `SELECT f.memory_id AS memory_id,
                f.dismissed_at AS dismissed_at,
                f.sensitive AS sensitive,
                m.content AS content,
                m.status AS status
           FROM dismissed_candidate_fingerprints f
           LEFT JOIN memories m ON m.id = f.memory_id
          ORDER BY f.dismissed_at DESC`,
      )
      .all() as Array<{
        memory_id: string;
        dismissed_at: string;
        sensitive: number;
        content: string | null;
        status: string | null;
      }>;
    return rows.map((r) => ({
      memoryId: r.memory_id,
      content: r.sensitive === 1 ? null : r.content,
      dismissedAt: r.dismissed_at,
      canUnmute: r.sensitive === 0 && (r.status === null || r.status === 'discarded'),
    }));
  }

  /** Lift recoverable non-sensitive suppression so the knowledge may be proposed again. */
  unmuteProposal(memoryId: string): boolean {
    return this.db.transaction(() => {
      const evidence = this.candidateDismissalEvidence(memoryId);
      const existing = this.getById(memoryId);
      if (evidence?.sensitive || existing?.sensitive) {
        throw new CandidateDismissalTransitionError('A sensitive dismissal is permanent and cannot be unmuted.');
      }
      if (evidence && existing && existing.status !== 'discarded') {
        throw new CandidateDismissalTransitionError(
          'Candidate dismissal evidence cannot be lifted from a non-discarded legacy row.',
        );
      }
      const res = this.db
        .query('DELETE FROM dismissed_candidate_fingerprints WHERE memory_id = ?')
        .run(memoryId);
      if (res.changes > 0) {
        // Explicit unmuting starts a new import attempt; turn-local capture
        // identities still suppress replays of already handled turns.
        this.db.query("DELETE FROM memory_capture_operations WHERE turn_key = 'md_import' AND memory_id = ?").run(memoryId);
      }
      return res.changes > 0;
    })();
  }

  /**
   * Record one USE of a memory as a 'use' event. The counter means "shaped
   * N turns": citations and trace-operational labels bump usage_count (hover
   * card, retrieval boost); detail loads live in the event log only.
   * Deliberately not a version — updated_at is untouched and no snapshot is
   * taken.
   */
  recordUse(id: string, meta: UseMeta): void {
    this.db.transaction(() => {
      const isCitation = meta.via !== 'detail_load';
      const res = isCitation
        ? this.db.query(`UPDATE memories SET usage_count = usage_count + 1 WHERE id = ?`).run(id)
        : this.db.query(`UPDATE memories SET usage_count = usage_count WHERE id = ?`).run(id);
      if (res.changes === 0) throw new Error(`Memory not found: ${id}`);
      const extra: Record<string, unknown> = {};
      if (meta.via !== undefined) extra.via = meta.via;
      if (meta.detailLoaded !== undefined) extra.detailLoaded = meta.detailLoaded;
      this.appendEvent(id, 'use', meta, { meta: Object.keys(extra).length ? extra : undefined });
    })();
  }

  /**
   * Record the post-turn trace verdict for one memory as a 'trace' event
   * (meta.label). Missing ids are a no-op — the async pass can race a delete.
   */
  recordTraceLabel(id: string, label: MemoryTraceLabel, meta: ActorMeta & { turn?: number; cited?: boolean }): void {
    const row = this.db.query(`SELECT id FROM memories WHERE id = ?`).get(id);
    if (!row) return;
    this.appendEvent(id, 'trace', meta, { meta: { label, ...(meta.cited !== undefined ? { cited: meta.cited } : {}) } });
  }

  recordTraceCorrection(id: string, input: { sessionId: string; turn: number; label: MemoryTraceLabel | null; note?: string; cited?: boolean }): { auditLabel: MemoryTraceLabel; changed: boolean; note?: string; invalidatedIds?: string[] } {
    return this.db.transaction(() => {
      if (input.label !== null && this.getById(id)?.status !== 'active') {
        throw new TraceCorrectionError(409, 'Only active memories can receive audit corrections');
      }
      const trace = this.db.query(`SELECT meta FROM memory_events WHERE memory_id = ? AND session_id = ? AND turn = ? AND kind = 'trace' ORDER BY seq DESC LIMIT 1`)
        .get(id, input.sessionId, input.turn) as { meta: string | null } | null;
      const traceMeta = trace?.meta ? JSON.parse(trace.meta) as TraceCorrectionMeta : undefined;
      const auditLabel = traceMeta?.label;
      if (!auditLabel) throw new TraceCorrectionError(409, 'No audit verdict exists for this memory and turn');
      if (input.label !== null && (!['operational', 'injected_without_effect', 'violated', 'not_applicable'].includes(input.label) || input.label === auditLabel)) {
        throw new TraceCorrectionError(400, 'Choose a different audit verdict');
      }
      const previous = this.db.query(`SELECT meta FROM memory_events WHERE memory_id = ? AND session_id = ? AND turn = ? AND kind = 'trace_correction' ORDER BY seq DESC LIMIT 1`)
        .get(id, input.sessionId, input.turn) as { meta: string | null } | null;
      const prior = previous?.meta ? JSON.parse(previous.meta) as TraceCorrectionMeta : undefined;
      const note = input.note?.trim().slice(0, 300) || undefined;
      if ((input.label === null && (!prior || prior.withdrawn)) || (input.label !== null && !prior?.withdrawn && prior?.label === input.label && prior.note === note)) {
        return { auditLabel, changed: false, note };
      }
      const cited = traceMeta?.cited ?? input.cited;
      const previousLabel = prior?.label && !prior.withdrawn ? prior.label : auditLabel;
      const nextLabel = input.label ?? auditLabel;
      const usageDelta = cited === false
        ? Number(nextLabel === 'operational') - Number(previousLabel === 'operational')
        : 0;
      if (usageDelta) this.db.query('UPDATE memories SET usage_count = MAX(0, usage_count + ?) WHERE id = ?').run(usageDelta, id);
      this.appendEvent(id, 'trace_correction', { actor: 'user', sessionId: input.sessionId, turn: input.turn }, {
        meta: input.label === null ? { withdrawn: true, ...(usageDelta ? { usageDelta } : {}) } : { label: input.label, auditLabel, ...(note ? { note } : {}), ...(usageDelta ? { usageDelta } : {}) },
      });
      const invalidatedIds = this.invalidateTraceRevisions(id);
      return { auditLabel, changed: true, note, ...(invalidatedIds.length ? { invalidatedIds } : {}) };
    })();
  }

  private traceVerdicts(id?: string, limit?: number): Array<{ id: string; seq: number; label: MemoryTraceLabel; corrected: boolean }> {
    const rows = this.db.query(`SELECT t.seq, t.memory_id, t.meta, c.meta AS correction
      FROM memory_events t LEFT JOIN memory_events c ON c.seq = (
        SELECT MAX(seq) FROM memory_events WHERE memory_id = t.memory_id AND session_id = t.session_id
          AND turn = t.turn AND kind = 'trace_correction'
      ) WHERE t.kind = 'trace' AND (? IS NULL OR t.memory_id = ?)
      ORDER BY t.seq DESC LIMIT ?`).all(id ?? null, id ?? null, limit ?? -1) as Array<{ seq: number; memory_id: string; meta: string | null; correction: string | null }>;
    return rows.flatMap(row => {
      const audit = row.meta ? (JSON.parse(row.meta) as TraceCorrectionMeta).label : undefined;
      const correction = row.correction ? JSON.parse(row.correction) as TraceCorrectionMeta : undefined;
      if (!audit) return [];
      const corrected = Boolean(correction?.label && !correction.withdrawn);
      return [{ id: row.memory_id, seq: row.seq, label: corrected ? correction!.label! : audit, corrected }];
    });
  }

  private invalidateTraceRevisions(targetId: string): string[] {
    const rows = this.db.query(`SELECT c.id FROM memories c JOIN memory_relations r ON r.source_id = c.id
      WHERE r.target_id = ? AND r.relation_type = 'revises' AND c.status = 'candidate'`).all(targetId) as Array<{ id: string }>;
    const verdicts = this.traceVerdicts(targetId);
    const bySeq = new Map(verdicts.map(row => [row.seq, row.label]));
    const invalidated: string[] = [];
    for (const { id } of rows) {
      const evidence = this.getKv<{ targetId: string; traceSeqs: number[] }>(`revision_trace_evidence:${id}`);
      let traceSeqs: number[];
      if (evidence) {
        if (evidence.targetId !== targetId) continue;
        traceSeqs = evidence.traceSeqs;
      } else {
        const candidate = this.getById(id);
        if (candidate?.evidenceClass !== 'inferred' || this.revisionTargetsOf(id).length !== 1) continue;
        const created = this.getEvents(id).find(event => event.kind === 'create');
        if (!created || created.actor !== 'system') continue;
        const traces = verdicts.filter(row => row.seq < created.seq).slice(0, 3);
        if (traces.length !== 3) continue;
        const original = new Map(this.getEvents(targetId).filter(event => event.kind === 'trace')
          .map(event => [event.seq, event.meta?.label]));
        if (!traces.every(row => original.get(row.seq) === 'violated')) continue;
        traceSeqs = traces.map(row => row.seq);
      }
      if (traceSeqs.some(seq => bySeq.get(seq) !== 'violated')) {
        this.archive(id, { actor: 'system' });
        invalidated.push(id);
      }
    }
    return invalidated;
  }

  /** Latest trace verdict per memory (last event wins). */
  latestTraceLabels(): Map<string, MemoryTraceLabel> {
    const labels = new Map<string, MemoryTraceLabel>();
    for (const row of this.traceVerdicts()) if (!labels.has(row.id)) labels.set(row.id, row.label);
    return labels;
  }

  latestTraceCorrections(): Set<string> {
    const seen = new Set<string>();
    const corrected = new Set<string>();
    for (const row of this.traceVerdicts()) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      if (row.corrected) corrected.add(row.id);
    }
    return corrected;
  }

  recentTraceCorrections(id: string, limit = 3): Array<{ id: string; auditLabel: MemoryTraceLabel; userLabel: MemoryTraceLabel; note?: string }> {
    const rows = this.db.query(`SELECT c.meta FROM memory_events c WHERE c.memory_id = ? AND c.kind = 'trace_correction'
      AND c.seq = (SELECT MAX(seq) FROM memory_events WHERE memory_id = c.memory_id AND session_id = c.session_id AND turn = c.turn AND kind = 'trace_correction')
      ORDER BY c.seq DESC`).all(id) as Array<{ meta: string | null }>;
    return rows.flatMap(row => {
      const meta = row.meta ? JSON.parse(row.meta) as TraceCorrectionMeta : undefined;
      return meta?.label && meta.auditLabel && !meta.withdrawn ? [{ id, auditLabel: meta.auditLabel, userLabel: meta.label, ...(meta.note ? { note: meta.note } : {}) }] : [];
    }).slice(0, limit);
  }

  /**
   * Capture candidates the user rejected (status candidate → discarded),
   * newest dismissal first. Feeds the necessity gate as negative examples —
   * "the user already said no to this kind of item". Sensitive candidates are
   * hard-deleted on dismissal, so they can never appear here. An
   * accepted-then-archived memory is a lifecycle end, not a rejection, and is
   * excluded by the before-status check.
   */
  recentlyDismissedCandidates(limit = 8): MemoryItem[] {
    const rows = this.db
      .query(
        `SELECT m.*, MAX(e.seq) AS dismissed_seq
           FROM memory_events e
           JOIN memories m ON m.id = e.memory_id
          WHERE json_extract(e.changes, '$.status.before') = 'candidate'
            AND json_extract(e.changes, '$.status.after') = 'discarded'
            AND m.status = 'discarded'
            AND m.sensitive = 0
          GROUP BY e.memory_id
          ORDER BY dismissed_seq DESC
          LIMIT ?`,
      )
      .all(limit) as MemoryRow[];
    return rows.map((r) => this.rowToItem(r));
  }

  /**
   * Capture candidates the user accepted (status candidate → active), newest
   * first. Feeds the capture/necessity passes as positive few-shot examples —
   * "this is the kind of item the user keeps" (self-evolution M1).
   */
  recentlyAcceptedCandidates(limit = 8): MemoryItem[] {
    const rows = this.db
      .query(
        `SELECT m.*, MAX(e.seq) AS accepted_seq
           FROM memory_events e
           JOIN memories m ON m.id = e.memory_id
          WHERE json_extract(e.changes, '$.status.before') = 'candidate'
            AND json_extract(e.changes, '$.status.after') = 'active'
            AND m.sensitive = 0
          GROUP BY e.memory_id
          ORDER BY accepted_seq DESC
          LIMIT ?`,
      )
      .all(limit) as MemoryRow[];
    return rows.map((r) => this.rowToItem(r));
  }

  /**
   * Record one RE-OBSERVATION of an existing memory (necessity gate verdict
   * 'reinforce'): the conversation restated a fact already stored. Bumps
   * reinforced_count (Fig 6 "reinforced N×") and appends a
   * 'reinforce' event. Not a version — no snapshot, updated_at untouched.
   */
  recordReinforce(id: string, meta: ActorMeta): void {
    this.db.transaction(() => {
      const res = this.db
        .query(`UPDATE memories SET reinforced_count = reinforced_count + 1 WHERE id = ?`)
        .run(id);
      if (res.changes === 0) throw new Error(`Memory not found: ${id}`);
      this.appendEvent(id, 'reinforce', meta);
    })();
  }

  /**
   * Record a Transfer reinforcement together with its source provenance. A
   * reinforcement without derived_from evidence is not a valid Transfer
   * landing, so both writes commit or roll back as one store operation.
   */
  recordDerivedReinforce(id: string, sourceId: string, meta: ActorMeta): void {
    this.db.transaction(() => {
      this.recordReinforce(id, meta);
      this.addRelation(id, sourceId, 'derived_from');
    })();
  }

  /**
   * The memory's most recent trace verdicts, newest first, capped at `limit`.
   * Backs the self-evolution M4 trigger: K consecutive 'violated' or
   * 'injected_without_effect' verdicts mean the stored text and observed
   * behavior have drifted apart.
   */
  recentTraceLabels(id: string, limit = 3): MemoryTraceLabel[] {
    return this.traceVerdicts(id, limit).map(row => row.label);
  }

  recentTraceEvidence(id: string, limit = 3): Array<{ seq: number; label: MemoryTraceLabel }> {
    return this.traceVerdicts(id, limit).map(({ seq, label }) => ({ seq, label }));
  }

  /** True when a PENDING revision candidate already targets `id` (don't re-propose). */
  hasOpenRevision(id: string): boolean {
    return Boolean(
      this.db
        .query(
          `SELECT 1 FROM memory_relations r
             JOIN memories m ON m.id = r.source_id
            WHERE r.target_id = ? AND r.relation_type = 'revises' AND m.status = 'candidate'
            LIMIT 1`,
        )
        .get(id),
    );
  }

  /**
   * Atomically create a REVISION candidate for `targetId`: the open-revision
   * check, the insert, and the 'revises' relation run in ONE transaction, so
   * two concurrent turns can never both draft a replacement for the same
   * memory (the pre-LLM check alone races across the drafting await).
   * Returns null when the target is gone/inactive or already has an open
   * revision — the caller simply drops its draft.
   */
  createRevisionProposal(
    input: CreateMemoryInput,
    targetId: string,
    meta: ActorMeta,
    opts?: {
      /**
       * CAS guard for drafts written across an await: the target's content
       * when the draft was conceived. If the target moved meanwhile (e.g. the
       * user already fixed it by hand), the stale draft is dropped rather
       * than proposed against text it never saw.
       */
      expectedTargetContent?: string;
      traceEvidence?: number[];
    },
  ): MemoryItem | null {
    return this.db.transaction(() => {
      if (opts?.traceEvidence) {
        const ids = new Set(opts.traceEvidence);
        const rows = this.traceVerdicts(targetId).filter(row => ids.has(row.seq));
        if (ids.size !== opts.traceEvidence.length || rows.length !== opts.traceEvidence.length
          || rows.some(row => row.label !== 'violated')) return null;
      }
      const proposal = this.createRevisionCandidate(input, targetId, meta, false, opts)?.item ?? null;
      if (proposal && opts?.traceEvidence) {
        this.setKv(`revision_trace_evidence:${proposal.id}`, { targetId, traceSeqs: opts.traceEvidence });
      }
      return proposal;
    })();
  }

  /** Preserve competing capture updates as target-bound alternatives, not independent facts. */
  createCaptureUpdateProposal(
    input: CreateMemoryInput,
    targetId: string,
    meta: ActorMeta,
    opts?: { expectedTargetContent?: string },
  ): { item: MemoryItem; isRevision: boolean } | null {
    return this.createRevisionCandidate(input, targetId, meta, true, opts);
  }

  private createRevisionCandidate(
    input: CreateMemoryInput,
    targetId: string,
    meta: ActorMeta,
    allowCompeting: boolean,
    opts?: { expectedTargetContent?: string },
  ): { item: MemoryItem; isRevision: boolean } | null {
    return this.db.transaction(() => {
      const target = this.getById(targetId);
      if (!target || target.status !== 'active') return null;
      if (opts?.expectedTargetContent !== undefined && target.content !== opts.expectedTargetContent) return null;
      if (!allowCompeting && this.hasOpenRevision(targetId)) return null;
      const proposal = this.create({ ...input, status: 'candidate' }, meta);
      this.addRelation(proposal.id, targetId, 'revises');
      this.setKv(`revision_targets:${proposal.id}`, [this.revisionSnapshot(target)]);
      return { item: proposal, isRevision: true };
    })();
  }

  /**
   * Atomically accept a REVISION candidate: activate it and archive EVERY
   * memory it revises in ONE transaction (a single-target revision archives
   * one; a MERGE proposal archives both originals). Two separate mutations
   * here left a half-applied state on mid-way failure (both memories active,
   * candidate spent). Returns the activated item plus the archived targets
   * ([] when the candidate is not a revision). Legacy proposals without a
   * reviewed snapshot require re-review rather than guessing what was seen.
   */
  acceptRevision(candidateId: string, meta: ActorMeta, draftPatch?: Partial<MemoryItem>): { updated: MemoryItem; replaced: MemoryItem[] } {
    return this.db.transaction(() => {
      const targets = this.revisionTargetsOf(candidateId);
      const reviewed = this.getKv<ReturnType<MemoryStore['revisionSnapshot']>[]>(`revision_targets:${candidateId}`);
      if (targets.length > 0 || reviewed !== null) {
        if (!Array.isArray(reviewed) || reviewed.length !== targets.length || targets.some((target, index) => {
          const snapshot = this.revisionSnapshot(target);
          return target.status !== 'active'
            || reviewed[index]?.id !== snapshot.id
            || reviewed[index]?.version !== snapshot.version
            || reviewed[index]?.digest !== snapshot.digest;
        })) throw new RevisionConflictError();
      }
      if (draftPatch && Object.keys(draftPatch).length > 0) {
        this.replaceCandidateDraft(candidateId, draftPatch, meta);
      }
      const updated = this.update(candidateId, { status: 'active' }, meta);
      const replaced = targets.map((t) => this.archive(t.id, meta));
      return { updated, replaced };
    })() as { updated: MemoryItem; replaced: MemoryItem[] };
  }

  /**
   * Extend a stale memory's lifecycle (延期): appends a 'renew' event, which
   * resets the expiry window — `listExpired` only looks for freshness events
   * after its boundary. Not a version: content untouched, no snapshot.
   */
  renewMemory(id: string, meta: ActorMeta): MemoryItem {
    const item = this.getById(id);
    if (!item) throw new Error(`Memory not found: ${id}`);
    // Only a LIVE memory has a lifecycle to extend — renewing an archived one
    // (e.g. from a stale card raced by an archive in another tab) would log a
    // "kept" decision for something that no longer exists.
    if (item.status !== 'active') throw new Error(`Only an active memory can be renewed (got ${item.status})`);
    this.appendEvent(id, 'renew', meta);
    return item;
  }

  /**
   * Expired (过期) memories — the paper's "not referenced in three commits"
   * claim, operationalized on sessions: an ACTIVE personal/project memory
   * that already existed before `boundaryTs` (start of the expiry window,
   * typically the start of the 3rd-most-recent prior session with turns) and
   * has produced NO freshness event since. Freshness = any event except the
   * passive per-turn 'trace' verdicts — citations/operational use, reinforce,
   * renew, edits, status changes all count as "the developer or agent touched
   * this". Session-scoped memories never expire (they die with the session),
   * and memories with an open revision proposal are excluded — they already
   * sit in the revision lane.
   */
  listExpired(opts: { boundaryTs: string; projectId?: string }): MemoryItem[] {
    const rows = this.db
      .query(
        `SELECT m.* FROM memories m
          WHERE m.status = 'active'
            AND (m.scope = 'personal'
                 OR (m.scope = 'project' AND ($project_id IS NULL OR m.project_id = $project_id)))
            AND m.created_at < $boundary
            AND NOT EXISTS (
              SELECT 1 FROM memory_events e
               WHERE e.memory_id = m.id AND e.kind != 'trace' AND e.ts >= $boundary)
            AND NOT EXISTS (
              SELECT 1 FROM memory_relations r
                JOIN memories c ON c.id = r.source_id
               WHERE r.target_id = m.id AND r.relation_type = 'revises' AND c.status = 'candidate')
          ORDER BY m.created_at ASC`,
      )
      .all({ $boundary: opts.boundaryTs, $project_id: opts.projectId ?? null }) as MemoryRow[];
    return rows.map((r) => this.rowToItem(r));
  }

  /**
   * Pending revision proposals with their still-active targets, oldest first.
   * Backs the gate's attention surface: a drafted revision the user scrolled
   * past resurfaces once instead of silently sinking.
   */
  listOpenRevisions(projectId?: string): Array<{ proposal: MemoryItem; target: MemoryItem }> {
    const rows = this.db
      .query(
        `SELECT c.id AS proposal_id, t.id AS target_id FROM memories c
           JOIN memory_relations r ON r.source_id = c.id AND r.relation_type = 'revises'
           JOIN memories t ON t.id = r.target_id
          WHERE c.status = 'candidate' AND t.status = 'active'
            AND (t.scope = 'personal'
                 OR (t.scope = 'project' AND ($project_id IS NULL OR t.project_id = $project_id)))
          ORDER BY c.created_at ASC`,
      )
      .all({ $project_id: projectId ?? null }) as Array<{ proposal_id: string; target_id: string }>;
    const pairs: Array<{ proposal: MemoryItem; target: MemoryItem }> = [];
    for (const row of rows) {
      const proposal = this.getById(row.proposal_id);
      const target = this.getById(row.target_id);
      if (proposal && target) pairs.push({ proposal, target });
    }
    return pairs;
  }

  /**
   * Inverse of an AUTO-applied acceptance (delegating/Auto mode): the item
   * returns to the review lane (status → candidate) and, when it was a
   * revision, its archived target comes back to life — one transaction, so a
   * revert can never leave both versions active. History keeps both status
   * events; nothing is erased.
   */
  revertAutoAccept(
    id: string,
    meta: ActorMeta,
  ): { reverted: MemoryItem; restored: MemoryItem | null; restoredAll: MemoryItem[] } {
    return this.db.transaction(() => {
      const existing = this.getById(id);
      if (!existing) throw new Error(`Memory not found: ${id}`);
      if (existing.status !== 'active') throw new Error(`Only an active memory can be reverted (got ${existing.status})`);
      // Authority comes from the latest persisted transition, not the route
      // name or a client-provided flag. Born-active and later-restored items
      // must never be forged back into the Candidate lane.
      const lastStatus = this.db
        .query(
          `SELECT seq AS s,
                  json_extract(changes, '$.status.before') AS before_status,
                  json_extract(changes, '$.status.after') AS after_status
             FROM memory_events
            WHERE memory_id = ? AND kind = 'status'
            ORDER BY seq DESC LIMIT 1`,
        )
        .get(id) as { s: number; before_status: string | null; after_status: string | null } | null;
      if (!lastStatus || lastStatus.before_status !== 'candidate' || lastStatus.after_status !== 'active') {
        throw new Error('Memory was not accepted from a Candidate review and cannot be reverted to Candidate.');
      }

      // The one-click inverse only inverts the ACCEPTANCE. If the item was
      // edited after it went active, a blind revert would throw away the
      // user's newer text — that path belongs to explicit history rollback.
      const editedAfter = this.db
        .query(
          `SELECT 1 FROM memory_events
            WHERE memory_id = ? AND kind IN ('edit', 'rescope', 'promote') AND seq > ? LIMIT 1`,
        )
        .get(id, lastStatus.s);
      if (editedAfter) {
        throw new Error('Memory was edited after the auto-accept — use its history on the Board to roll back.');
      }
      const targets = this.revisionTargetsOf(id);
      if (targets.some(target => target.status === 'archived' && target.expiresAt && Date.parse(target.expiresAt) <= Date.now())) {
        throw new Error('Expiry must be a future date');
      }
      const reverted = this.update(id, { status: 'candidate' }, meta);
      const restored = targets
        .filter((t) => t.status === 'archived')
        .map((t) => this.update(t.id, { status: 'active' }, meta));
      return { reverted, restored: restored[0] ?? null, restoredAll: restored };
    })() as { reverted: MemoryItem; restored: MemoryItem | null; restoredAll: MemoryItem[] };
  }

  /** The memory a REVISION candidate proposes to replace, if any (first of possibly several). */
  revisionTargetOf(candidateId: string): MemoryItem | null {
    return this.revisionTargetsOf(candidateId)[0] ?? null;
  }

  /** ALL memories a revision candidate proposes to replace (a merge proposal has two). */
  revisionTargetsOf(candidateId: string): MemoryItem[] {
    const rows = this.db
      .query(
        `SELECT m.* FROM memories m
           JOIN memory_relations r ON m.id = r.target_id
          WHERE r.source_id = ? AND r.relation_type = 'revises'
          ORDER BY r.id`,
      )
      .all(candidateId) as MemoryRow[];
    return rows.map((r) => this.rowToItem(r));
  }

  /**
   * Atomically create a MERGE proposal: one candidate that revises BOTH
   * originals — accepting it (acceptRevision) activates the merged text and
   * archives the pair. Same guards as createRevisionProposal, applied to each
   * target: active, content unchanged since the draft was conceived (CAS
   * across the LLM await), and no open revision already in flight. Returns
   * null when any guard fails — the caller drops its draft.
   */
  createMergeProposal(
    input: CreateMemoryInput,
    targetIds: [string, string],
    meta: ActorMeta,
    opts?: { expectedContents?: [string, string] },
  ): MemoryItem | null {
    return this.db.transaction(() => {
      if (targetIds[0] === targetIds[1]) return null;
      const targets: MemoryItem[] = [];
      for (let i = 0; i < targetIds.length; i++) {
        const target = this.getById(targetIds[i]!);
        if (!target || target.status !== 'active') return null;
        if (opts?.expectedContents && target.content !== opts.expectedContents[i]) return null;
        if (this.hasOpenRevision(target.id)) return null;
        if (target.scope !== input.scope
          || (input.scope === 'project' && (!input.projectId || target.projectId !== input.projectId))
          || (input.scope === 'session' && (!input.sessionId || target.sessionId !== input.sessionId))) return null;
        targets.push(target);
      }
      const proposal = this.create({ ...input, status: 'candidate' }, meta);
      for (const targetId of targetIds) this.addRelation(proposal.id, targetId, 'revises');
      this.setKv(`revision_targets:${proposal.id}`, targets.map((target) => this.revisionSnapshot(target)));
      return proposal;
    })() as MemoryItem | null;
  }

  private revisionSnapshot(item: MemoryItem) {
    return {
      id: item.id,
      version: item.version,
      digest: createHash('sha256').update(JSON.stringify(this.snapshotOf(item))).digest('hex'),
    };
  }

  /** Read a JSON value from the memory_kv side table (null when absent/corrupt). */
  getKv<T>(key: string): T | null {
    const row = this.db.query('SELECT value FROM memory_kv WHERE key = ?').get(key) as
      | { value: string }
      | null;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  }

  /** Upsert a JSON value into the memory_kv side table. */
  setKv(key: string, value: unknown): void {
    this.db
      .query(
        `INSERT INTO memory_kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), new Date().toISOString());
  }

  /**
   * How many candidate resolutions (accept OR dismiss) happened after event
   * `sinceSeq`, and the newest resolution seq. Drives the policy-memo refresh
   * trigger (M2): regenerate after every N resolutions.
   */
  candidateResolutionsSince(sinceSeq: number): { count: number; maxSeq: number } {
    const row = this.db
      .query(
        `SELECT COUNT(*) AS count, COALESCE(MAX(seq), ?) AS max_seq
           FROM memory_events
          WHERE seq > ?
            AND kind = 'status'
            AND json_extract(changes, '$.status.before') = 'candidate'
            AND json_extract(changes, '$.status.after') IN ('active', 'discarded')`,
      )
      .get(sinceSeq, sinceSeq) as { count: number; max_seq: number };
    return { count: row.count, maxSeq: row.max_seq };
  }

  /** Full append-only history for one memory, oldest first. */
  getEvents(id: string): MemoryEvent[] {
    const rows = this.db
      .query(`SELECT * FROM memory_events WHERE memory_id = ? ORDER BY seq`)
      .all(id) as MemoryEventRow[];
    return rows.map((r) => ({
      seq: r.seq,
      memoryId: r.memory_id,
      ts: r.ts,
      kind: r.kind as MemoryEventKind,
      actor: r.actor as MemoryEvent['actor'],
      sessionId: r.session_id ?? undefined,
      turn: r.turn ?? undefined,
      changes: r.changes ? JSON.parse(r.changes) : undefined,
      snapshot: r.snapshot ? JSON.parse(r.snapshot) : undefined,
      meta: r.meta ? JSON.parse(r.meta) : undefined,
    }));
  }

  /**
   * Roll the memory back to the version captured by event `toSeq` (any change
   * event with a snapshot). History is preserved: the rollback itself is
   * appended as a 'revert' event. usage_count is NOT versioned state and
   * survives. Returns the reverted item.
   */
  rollback(id: string, toSeq: number, meta: ActorMeta): MemoryItem {
    return this.db.transaction(() => {
      const target = this.getEvents(id).find((e) => e.seq === toSeq);
      if (!target) throw new Error(`No event ${toSeq} for memory ${id}`);
      if (!target.snapshot) throw new Error(`Event ${toSeq} (${target.kind}) is not a version — cannot roll back to it`);
      if (target.snapshot.status === 'active' && target.snapshot.expiresAt
        && Date.parse(target.snapshot.expiresAt) <= Date.now()) {
        throw new Error('Expiry must be a future date');
      }

    const existing = this.getById(id);
    if (!existing) throw new Error(`Memory not found: ${id}`);
    this.assertCandidateDecisionTransition(existing, target.snapshot, 'ordinary');

    const patch: Record<string, unknown> = {};
    const changes: Record<string, { before: unknown; after: unknown }> = {};
    for (const field of VERSIONED_FIELDS) {
      const before = (existing as unknown as Record<string, unknown>)[field] ?? null;
      const after = (target.snapshot as unknown as Record<string, unknown>)[field] ?? null;
      if (before === after) continue;
      patch[field] = after;
      changes[field] = { before, after };
    }
      if (Object.keys(patch).length === 0) return existing;
      this.syncMemoryRevocation(existing, target.snapshot.status);

    const sets: string[] = ['updated_at = $updated_at'];
    const params: Record<string, Bind> = { $id: id, $updated_at: new Date().toISOString() };
    for (const [key, value] of Object.entries(patch)) {
      const column = UPDATABLE_COLUMNS[key]!;
      sets.push(`${column} = $${column}`);
      params[`$${column}`] = value as Bind;
    }
    // A rollback rewrites content the model acts on — it is a new version
    // going FORWARD (history is append-only), not a return to an old number.
    if (CONTENT_VERSION_FIELDS.some((f) => f in changes)) {
      sets.push('version = version + 1');
    }
    this.db.query(`UPDATE memories SET ${sets.join(', ')} WHERE id = $id`).run(params);

    const reverted = this.getById(id)!;
    this.appendEvent(id, 'revert', meta, {
      changes,
      snapshot: this.snapshotOf(reverted),
      meta: { toSeq },
    });
      return reverted;
    })();
  }

  /** Replace the session's exclusion set (REDESIGN D7). Empty = nothing muted. */
  setSessionExclusions(sessionId: string, ids: string[]): void {
    this.db
      .query(
        `INSERT INTO session_exclusions (session_id, ids, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET ids = excluded.ids, updated_at = excluded.updated_at`,
      )
      .run(sessionId, JSON.stringify(ids), new Date().toISOString());
  }

  /** The ids muted for this session ([] when nothing is excluded). */
  getSessionExclusions(sessionId: string): string[] {
    const row = this.db.query('SELECT ids FROM session_exclusions WHERE session_id = ?').get(sessionId) as
      | { ids: string }
      | null;
    if (!row) return [];
    try {
      const parsed = JSON.parse(row.ids);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  addRelation(sourceId: string, targetId: string, type: MemoryRelationType): void {
    this.db
      .query(
        `INSERT INTO memory_relations (source_id, target_id, relation_type)
         VALUES (?, ?, ?)`,
      )
      .run(sourceId, targetId, type);
  }

  /** Canonical semantic edges, including endpoint eligibility; excludes usage counters. */
  getViewRelations(ids: readonly string[]): string[][] {
    const selected = new Set(ids);
    const rows = this.db.query(`
      SELECT r.source_id, r.target_id, r.relation_type,
             s.status AS source_status, s.scope AS source_scope,
             s.project_id AS source_project, s.session_id AS source_session,
             t.status AS target_status, t.scope AS target_scope,
             t.project_id AS target_project, t.session_id AS target_session
        FROM memory_relations r
        JOIN memories s ON s.id = r.source_id
        JOIN memories t ON t.id = r.target_id
       ORDER BY r.source_id, r.target_id, r.relation_type
    `).all() as Array<Record<string, string | null>>;
    return [...new Map(rows
      .filter(row => selected.has(row.source_id!) || selected.has(row.target_id!))
      .map(row => {
        const edge = [row.source_id!, row.target_id!, row.relation_type!,
          row.source_status!, row.source_scope!, row.source_project ?? '', row.source_session ?? '',
          row.target_status!, row.target_scope!, row.target_project ?? '', row.target_session ?? ''];
        return [JSON.stringify(edge), edge] as const;
      })).values()];
  }

  getRelations(id: string): MemoryRelation[] {
    const rows = this.db
      .query(`SELECT target_id, relation_type FROM memory_relations WHERE source_id = ?`)
      .all(id) as Array<{ target_id: string; relation_type: string }>;
    return rows.map((r) => ({
      type: r.relation_type as MemoryRelationType,
      targetId: r.target_id,
    }));
  }

  /** Memories that `id` conflicts with (via a 'conflicts_with' relation). */
  getConflicts(id: string): MemoryItem[] {
    const rows = this.db
      .query(
        `SELECT m.* FROM memories m
           JOIN memory_relations r ON m.id = r.target_id
          WHERE r.source_id = ? AND r.relation_type = 'conflicts_with'`,
      )
      .all(id) as MemoryRow[];
    return rows.map((r) => this.rowToItem(r));
  }

  /** Active memories that supersede `id` — the SOURCES of a conflicts_with relation targeting it. */
  getSupersedingItems(id: string): MemoryItem[] {
    const rows = this.db
      .query(
        `SELECT m.* FROM memories m
           JOIN memory_relations r ON m.id = r.source_id
          WHERE r.target_id = ? AND r.relation_type = 'conflicts_with' AND m.status IN ('active', 'candidate')`,
      )
      .all(id) as MemoryRow[];
    return rows.map((r) => this.rowToItem(r));
  }

  /**
   * Active memories that another LIVE memory has flagged as contested — i.e.
   * they are the TARGET of a conflicts_with relation whose SOURCE is still
   * active or a pending candidate. These are the "needs attention" items
   * surfaced after a drift event (SPEC maintenance / A1).
   *
   * - Requiring a live source means dismissing/archiving the superseding item
   *   clears the conflict (no permanent ghost entry).
   * - When `projectId` is omitted (the Board's global view) ALL project-scope
   *   conflicts are included; a bound projectId narrows to that project.
   *   (`project_id = ?` bound to NULL matches nothing in SQL — that was the
   *   bug that hid every project-scope conflict from the Board.)
   */
  listConflicted(projectId?: string): MemoryItem[] {
    const projectClause = projectId
      ? `(m.scope = 'project' AND m.project_id = ?)`
      : `m.scope = 'project'`;
    const params = projectId ? [projectId] : [];
    const rows = this.db
      .query(
        `SELECT DISTINCT m.* FROM memories m
           JOIN memory_relations r ON m.id = r.target_id
           JOIN memories src ON src.id = r.source_id
          WHERE r.relation_type = 'conflicts_with'
            AND m.status = 'active'
            AND src.status IN ('active', 'candidate')
            AND (m.scope = 'personal' OR ${projectClause})`,
      )
      .all(...params) as MemoryRow[];
    return rows.map((r) => this.rowToItem(r));
  }

  /** Which event kind a set of changed fields amounts to (scope > status > edit). */
  private classifyChange(
    before: MemoryItem,
    changes: Record<string, { before: unknown; after: unknown }>,
  ): MemoryEventKind {
    if (changes.scope) {
      const from = SCOPE_REACH[changes.scope.before as MemoryScope] ?? 0;
      const to = SCOPE_REACH[changes.scope.after as MemoryScope] ?? 0;
      return to > from ? 'promote' : 'rescope';
    }
    if (changes.status) return 'status';
    return 'edit';
  }

  private appendEvent(
    memoryId: string,
    kind: MemoryEventKind,
    actorMeta: ActorMeta,
    payload: {
      changes?: Record<string, { before: unknown; after: unknown }>;
      snapshot?: MemoryItemSnapshot;
      meta?: Record<string, unknown>;
    } = {},
  ): void {
    this.db
      .query(
        `INSERT INTO memory_events (memory_id, ts, kind, actor, session_id, turn, changes, snapshot, meta)
         VALUES ($memory_id, $ts, $kind, $actor, $session_id, $turn, $changes, $snapshot, $meta)`,
      )
      .run({
        $memory_id: memoryId,
        $ts: new Date().toISOString(),
        $kind: kind,
        $actor: actorMeta.actor,
        $session_id: actorMeta.sessionId ?? null,
        $turn: actorMeta.turn ?? null,
        $changes: payload.changes ? JSON.stringify(payload.changes) : null,
        $snapshot: payload.snapshot ? JSON.stringify(payload.snapshot) : null,
        $meta: payload.meta ? JSON.stringify(payload.meta) : null,
      });
  }

  private candidateFingerprint(content: string): string {
    const normalized = content.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
    return createHash('sha256').update(normalized).digest('hex');
  }

  private snapshotOf(item: MemoryItem): MemoryItemSnapshot {
    return {
      content: item.content,
      detail: item.detail,
      scope: item.scope,
      type: item.type,
      status: item.status,
      expiresAt: item.expiresAt ?? null,
      topic: item.topic,
      abstractionLevel: item.abstractionLevel,
      projectId: item.projectId,
      sessionId: item.sessionId,
    };
  }

  private nextId(): string {
    const rows = this.db.query(
      `SELECT id FROM memories
       UNION ALL
       SELECT memory_id AS id FROM dismissed_candidate_fingerprints
       UNION ALL
       SELECT memory_id AS id FROM memory_capture_operations WHERE memory_id IS NOT NULL`,
    ).all() as Array<{ id: string }>;
    let max = 0;
    for (const { id } of rows) {
      const m = /^M-(\d+)$/.exec(id);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return `M-${String(max + 1).padStart(2, '0')}`;
  }

  private rowToItem(row: MemoryRow): MemoryItem {
    const evidenceClass = (row.evidence_class ?? undefined) as EvidenceClass | undefined;
    return {
      id: row.id,
      content: row.content,
      detail: row.detail ?? undefined,
      abstractionLevel: row.abstraction_level as AbstractionLevel,
      sensitive: row.sensitive === 1,
      scope: row.scope as MemoryScope,
      type: row.type as MemoryType,
      status: row.status as MemoryStatus,
      expiresAt: row.expires_at ?? null,
      projectId: row.project_id ?? undefined,
      sessionId: row.session_id ?? undefined,
      topic: row.topic ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      provenanceSessionId: row.provenance_session_id ?? undefined,
      provenanceTurn: row.provenance_turn ?? undefined,
      usageCount: row.usage_count,
      reinforcedCount: row.reinforced_count ?? 0,
      evidenceClass,
      version: row.version ?? 1,
      citedInCurrentSession: 0,
    };
  }
}
