// MemoryService — the engine-agnostic facade the rest of the server calls.
// Bundles the SQLite store, the Markdown projection, and retrieval so the
// per-engine adapters (Claude / Codex) and HTTP routes have a single entry point.
import type { Database } from 'bun:sqlite';
import { openMemoryDb } from './db';
import { MemoryStore } from './MemoryStore';
import { MemoryFile } from './MemoryFile';
import { looksLikeSecret } from './secrets';
import type { ActorMeta, MemoryItem } from './types';
import { NoopExperimentLogger, type ExperimentLogger } from '../experiment/logger';

function normalizeContent(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

export interface MemoryServiceOptions {
  /** SQLite path, or ':memory:' for tests. */
  dbPath: string;
  /** Directory root for the human-readable Markdown projection. */
  dataDir: string;
  /** Structured experiment logger (defaults to a no-op). */
  logger?: Pick<ExperimentLogger, 'event'>;
}

export interface AutoProjectCloneProvenance {
  transitionKey: string;
  sourceTaskId: string;
  sourceProjectId: string;
  cloneOf: {
    memoryId: string;
    version: number;
    contentHash: string;
  };
}


export class MemoryService {
  readonly db: Database;
  readonly store: MemoryStore;
  readonly file: MemoryFile;
  readonly logger: Pick<ExperimentLogger, 'event'>;

  constructor(opts: MemoryServiceOptions) {
    this.db = openMemoryDb(opts.dbPath);
    this.store = new MemoryStore(this.db);
    this.file = new MemoryFile(opts.dataDir);
    this.logger = opts.logger ?? NoopExperimentLogger;
    // The Markdown files are a generated EXPORT of SQLite state (read-only for
    // the user); a startup rebuild simply refreshes them.
    this.rebuildProjections();
  }

  /**
   * Memories that LANDED via a transfer accept during the current turn of a
   * chat — new derived items and reinforce-merged targets alike. The preview
   * receipt badges these so an accepted transfer never looks like it
   * vanished (it may have merged into an existing memory). In-memory only;
   * cleared when the chat's next turn starts its transfer stage.
   */
  private readonly transferLandings = new Map<string, Set<string>>()

  noteTransferLanding(chatId: string, memoryId: string): void {
    const existing = this.transferLandings.get(chatId)
    if (existing) existing.add(memoryId)
    else this.transferLandings.set(chatId, new Set([memoryId]))
  }

  getTransferLandings(chatId: string): string[] {
    return [...(this.transferLandings.get(chatId) ?? [])]
  }

  clearTransferLandings(chatId: string): void {
    this.transferLandings.delete(chatId)
  }

  /**
   * The active memory set to inject for a session (REDESIGN D7): everything
   * active in scope — personal + this project's project memories + this
   * session's session memories — MINUS the session's exclusion set. There is
   * no bring-in curation gate anymore: the default is all-in (control needs
   * no zero-evidence decision at session start), and exclusion is the
   * restorable, session-persistent opt-out. This also retires BUG MEMSRV-1:
   * session-scoped actives are excludable like everything else.
   */
  injectedFor(projectId?: string, sessionId?: string): MemoryItem[] {
    const all = [
      ...this.store.list({ scope: 'personal', status: 'active' }),
      ...(projectId ? this.store.list({ scope: 'project', projectId, status: 'active' }) : []),
      ...(sessionId ? this.store.list({ scope: 'session', sessionId, status: 'active' }) : []),
    ];
    if (!sessionId) return all;
    const excluded = new Set(this.store.getSessionExclusions(sessionId));
    return excluded.size === 0 ? all : all.filter((m) => !excluded.has(m.id));
  }

  /**
   * Auto condition treatment: one independently mutable Project Copy, shared
   * by every chat/session in that project. Scope is fixed to Project for this
   * baseline; session exclusions and participant-selected working sets belong
   * to MemoSync and never narrow the copy.
   *
   * An absent project id has no implicit participant-wide fallback. Returning
   * an empty copy is fail-closed and preserves the approved empty first-project
   * starting state until the server supplies the assigned project.
   */
  autoProjectMemories(projectId?: string): MemoryItem[] {
    if (!projectId) return [];
    return this.store.list({ scope: 'project', projectId, status: 'active' });
  }

  /** Audit provenance for a new identity created by Baseline Project Copy. */
  getAutoProjectCloneRef(memoryId: string): AutoProjectCloneProvenance | null {
    const row = this.db.query(`
      SELECT lineage.transition_key,
             lineage.source_memory_id,
             lineage.source_version,
             lineage.source_content_hash,
             receipt.source_task_id,
             receipt.source_project_id
        FROM auto_project_copy_lineage AS lineage
        JOIN auto_project_copy_receipts AS receipt
          ON receipt.transition_key = lineage.transition_key
       WHERE lineage.target_memory_id = ?
    `).get(memoryId) as {
      transition_key: string;
      source_memory_id: string;
      source_version: number;
      source_content_hash: string;
      source_task_id: string;
      source_project_id: string;
    } | null;
    return row
      ? {
          transitionKey: row.transition_key,
          sourceTaskId: row.source_task_id,
          sourceProjectId: row.source_project_id,
          cloneOf: {
            memoryId: row.source_memory_id,
            version: row.source_version,
            contentHash: row.source_content_hash,
          },
        }
      : null;
  }

  /** Re-materialize the Markdown projection for a scope (call after mutations). */
  syncProjection(projectId?: string): boolean {
    try {
      this.writePersonalProjection();
      if (projectId) this.writeProjectProjection(projectId);
      return true;
    } catch (error) {
      console.warn('[memory] Markdown projection is stale but SQLite remains canonical:', error);
      return false;
    }
  }

  /** Rebuild every human-readable projection from canonical SQLite state. */
  rebuildProjections(): boolean {
    try {
      this.writePersonalProjection();
      const projectIds = new Set(
        // Include inactive/rescoped rows and existing projection directories
        // so a restart clears files left stale by a crash between the DB commit
        // and the best-effort Markdown write.
        [...this.store.list()
          .map((item) => item.projectId)
          .filter((id): id is string => Boolean(id)), ...this.file.listProjectedProjects()],
      );
      for (const projectId of projectIds) {
        this.writeProjectProjection(projectId);
      }
      return true;
    } catch (error) {
      console.warn('[memory] Failed to rebuild Markdown projections from SQLite:', error);
      return false;
    }
  }

  // Sensitive text never reaches the Markdown files (nor the .base mirror):
  // the projection is a plaintext artifact that outlives review decisions.
  private writePersonalProjection(): void {
    this.file.writePersonal(
      this.store.list({ scope: 'personal', status: 'active' }).filter((m) => !m.sensitive),
      this.store.list({ scope: 'personal', status: 'candidate' }).filter((m) => !m.sensitive),
    );
  }

  private writeProjectProjection(projectId: string): void {
    this.file.writeProject(
      projectId,
      this.store.list({ scope: 'project', projectId, status: 'active' }).filter((m) => !m.sensitive),
      this.store.list({ scope: 'project', projectId, status: 'candidate' }).filter((m) => !m.sensitive),
    );
  }

  /**
   * Import an EXTERNAL markdown file (an existing CLAUDE.md, .cursorrules…):
   * every bullet line becomes a candidate — the four sync cases collapse to
   * "additions with no anchors". The source file itself is never touched.
   */
  importMarkdown(
    text: string,
    target: { scope: 'personal' } | { scope: 'project'; projectId: string },
    meta: ActorMeta = { actor: 'user' },
  ): { created: string[]; skipped: number } {
    const isPersonal = target.scope === 'personal';
    const projectId = isPersonal ? undefined : target.projectId;
    // Actives AND pending candidates — a retried import must not duplicate
    // the candidates its first attempt already committed.
    const liveByNorm = new Set(
      [
        ...this.store.list({ scope: target.scope, projectId, status: 'active' }),
        ...this.store.list({ scope: target.scope, projectId, status: 'candidate' }),
      ].map((m) => normalizeContent(m.content)),
    );
    const created: string[] = [];
    let skipped = 0;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line.startsWith('- ')) continue;
      // Strip a leading [anchor] if the source mimics our format.
      const content = line.replace(/^- (\[[^\]]*\]\s*)?/, '').trim();
      if (!content) continue;
      if (liveByNorm.has(normalizeContent(content))) {
        skipped += 1;
        continue;
      }
      liveByNorm.add(normalizeContent(content)); // dedupe within the import too
      const item = this.store.create(
        {
          content,
          scope: target.scope,
          projectId,
          type: 'fact',
          status: 'candidate',
          evidenceClass: 'user_stated',
          sensitive: looksLikeSecret(content),
        },
        meta,
      );
      this.logger.event({
        type: 'memory.propose',
        sessionId: meta.sessionId,
        id: item.id,
        memType: item.type,
        scope: item.scope,
        via: 'md_import',
      });
      created.push(item.id);
    }
    if (created.length) {
      if (isPersonal) this.writePersonalProjection();
      else this.writeProjectProjection(projectId!);
    }
    return { created, skipped };
  }

  close(): void {
    this.db.close();
  }
}

export { MemoryStore } from './MemoryStore';
export type { CreateMemoryInput, MemoryFilter } from './MemoryStore';
export { MemoryFile } from './MemoryFile';
export type { ParsedMemory } from './MemoryFile';
export { openMemoryDb, applySchema, MEMORY_SCHEMA } from './db';
export { rankMemories, tokenize } from './retrieval';
export { computeMemoryHash } from './hash';
export { memoryIdNum, compareMemoryId } from './ids';
export type * from './types';
