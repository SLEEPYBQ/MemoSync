// SQLite handle for the memory layer, on Bun's built-in `bun:sqlite`
// (no native dependency, unlike MemoSync's better-sqlite3). Only the two
// memory tables live here — conversation/session persistence is Kanna's domain
// (its JSONL event store), so we deliberately do NOT port MemoSync's
// sessions/messages/repositories tables.
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** The full memory schema (idempotent — every statement uses IF NOT EXISTS). */
export const MEMORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,     -- SHORT form (one-liner)
  detail TEXT,               -- DETAILED form, loaded on demand
  abstraction_level TEXT NOT NULL DEFAULT 'contextual',  -- 'concrete' | 'contextual' | 'general'
  sensitive INTEGER NOT NULL DEFAULT 0,  -- flagged by the capture privacy gate
  scope TEXT NOT NULL,       -- 'personal' | 'project' | 'session'
  type TEXT NOT NULL,        -- 'constraint' | 'preference' | 'lesson' | 'fact'
  status TEXT NOT NULL DEFAULT 'active',
  project_id TEXT,
  session_id TEXT,
  topic TEXT,
  provenance_session_id TEXT,
  provenance_turn INTEGER,
  usage_count INTEGER NOT NULL DEFAULT 0,
  reinforced_count INTEGER NOT NULL DEFAULT 0,  -- re-observations (necessity gate 'reinforce')
  evidence_class TEXT,       -- 'user_stated'|'user_corrected'|'inferred'|'agent_proposed'
  version INTEGER NOT NULL DEFAULT 1,  -- content version: bumps on content-bearing edits (injection delta anchor)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,  -- 'conflicts_with' | 'generalized_from' | 'similar_to' | 'derived_from' | 'revises'
  FOREIGN KEY (source_id) REFERENCES memories(id),
  FOREIGN KEY (target_id) REFERENCES memories(id)
);

-- Small key-value side table for memory-layer state that is not an item:
-- currently the capture policy memo (self-evolution M2) and its refresh
-- watermark. Values are JSON.
CREATE TABLE IF NOT EXISTS memory_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Auto baseline cross-project initialization. The target project receives one
-- exact snapshot and then evolves independently; a durable receipt makes an
-- empty source and a process retry distinguishable from "not copied yet".
CREATE TABLE IF NOT EXISTS auto_project_copy_receipts (
  transition_key TEXT PRIMARY KEY,
  source_task_id TEXT NOT NULL,
  target_task_id TEXT NOT NULL,
  source_project_id TEXT NOT NULL,
  target_project_id TEXT NOT NULL UNIQUE,
  source_representation_hash TEXT NOT NULL,
  target_representation_hash TEXT NOT NULL,
  copied_at TEXT NOT NULL
);

-- Clone provenance is deliberately separate from the rendered representation:
-- copied items get new questionnaire identities/version histories, while this
-- table retains the exact source identity/version/content hash for audit.
CREATE TABLE IF NOT EXISTS auto_project_copy_lineage (
  transition_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  target_memory_id TEXT NOT NULL UNIQUE,
  source_memory_id TEXT NOT NULL,
  source_version INTEGER NOT NULL,
  source_content_hash TEXT NOT NULL,
  PRIMARY KEY (transition_key, ordinal),
  FOREIGN KEY (transition_key) REFERENCES auto_project_copy_receipts(transition_key),
  FOREIGN KEY (target_memory_id) REFERENCES memories(id),
  FOREIGN KEY (source_memory_id) REFERENCES memories(id)
);

-- Append-only per-item version/usage log (SPEC §3, option 乙). Never UPDATE or
-- DELETE rows here; rollback appends a 'revert' event instead of rewriting.
CREATE TABLE IF NOT EXISTS memory_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,        -- 'create'|'edit'|'rescope'|'promote'|'status'|'revert'|'use'
  actor TEXT NOT NULL,       -- 'user' | 'agent' | 'system'
  session_id TEXT,
  turn INTEGER,
  changes TEXT,              -- JSON {field: {before, after}} for change kinds
  snapshot TEXT,             -- JSON full post-change snapshot (rollback target)
  meta TEXT                  -- JSON extras (use: {via, detailLoaded}; revert: {toSeq})
);

-- Per-session exclusion set (REDESIGN D7 — replaces the bring-in pins).
-- Default = NO row = everything active injects; the row lists the ids the
-- user muted for this session (restorable, Board/panel-controlled). The old
-- session_pins table may linger in pre-redesign DBs, unused.
CREATE TABLE IF NOT EXISTS session_exclusions (
  session_id TEXT PRIMARY KEY,
  ids TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Privacy-safe negative feedback for rejected review cards. Every dismissal
-- records a normalized content fingerprint (exact-repeat suppression + id-reuse
-- guard). SENSITIVE candidates are additionally hard-deleted on dismissal (text
-- and events erased); non-sensitive ones keep their text under status
-- 'discarded' so the necessity gate can learn from them as negative examples
-- (self-evolution M1) and the study has "extracted but not stored" material.
CREATE TABLE IF NOT EXISTS dismissed_candidate_fingerprints (
  memory_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  dismissed_at TEXT NOT NULL,
  sensitive INTEGER NOT NULL DEFAULT 0  -- immutable privacy evidence for this dismissal
);
CREATE INDEX IF NOT EXISTS idx_dismissed_candidate_fingerprint
  ON dismissed_candidate_fingerprints(fingerprint);

CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope);
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id);
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
CREATE INDEX IF NOT EXISTS idx_memory_events_memory ON memory_events(memory_id, seq);
`;

/**
 * Apply the schema to an open database (idempotent), migrating pre-upgrade
 * databases forward: CREATE IF NOT EXISTS covers new tables, and missing
 * columns on `memories` are added with their defaults.
 */
export function applySchema(db: Database): void {
  db.exec(MEMORY_SCHEMA);
  const columns = new Set(
    (db.query(`PRAGMA table_info(memories)`).all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!columns.has('detail')) db.exec(`ALTER TABLE memories ADD COLUMN detail TEXT`);
  if (!columns.has('abstraction_level')) {
    db.exec(`ALTER TABLE memories ADD COLUMN abstraction_level TEXT NOT NULL DEFAULT 'contextual'`);
  }
  if (!columns.has('sensitive')) {
    db.exec(`ALTER TABLE memories ADD COLUMN sensitive INTEGER NOT NULL DEFAULT 0`);
  }
  if (!columns.has('reinforced_count')) {
    db.exec(`ALTER TABLE memories ADD COLUMN reinforced_count INTEGER NOT NULL DEFAULT 0`);
  }
  if (!columns.has('evidence_class')) {
    db.exec(`ALTER TABLE memories ADD COLUMN evidence_class TEXT`);
  }
  if (!columns.has('version')) {
    db.exec(`ALTER TABLE memories ADD COLUMN version INTEGER NOT NULL DEFAULT 1`);
  }

  const dismissalColumns = new Set(
    (db.query(`PRAGMA table_info(dismissed_candidate_fingerprints)`).all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!dismissalColumns.has('sensitive')) {
    db.exec(`ALTER TABLE dismissed_candidate_fingerprints ADD COLUMN sensitive INTEGER NOT NULL DEFAULT 0`);
  }
  // Before this column existed, sensitive dismissals were identifiable by a
  // retained sensitive row, a fingerprint attached to an impossible
  // non-discarded state, or a hard-erased row that left only its fingerprint.
  // Preserve that evidence so mutable item/history fields cannot downgrade the
  // original privacy decision.
  db.exec(`UPDATE dismissed_candidate_fingerprints
              SET sensitive = 1
            WHERE sensitive = 0
              AND (
                NOT EXISTS (
                  SELECT 1 FROM memories m
                   WHERE m.id = dismissed_candidate_fingerprints.memory_id
                )
                OR EXISTS (
                  SELECT 1 FROM memories m
                   WHERE m.id = dismissed_candidate_fingerprints.memory_id
                     AND (m.sensitive = 1 OR m.status != 'discarded')
                )
              )`);
}

/**
 * Open (creating if needed) a memory database at `dbPath`, enable foreign
 * keys, and apply the schema. DELETE journaling is deliberate: rejected
 * candidate text must not remain in a WAL when an external reader holds a
 * snapshot. Pass ':memory:' for an ephemeral DB.
 */
export function openMemoryDb(dbPath: string): Database {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.exec('PRAGMA journal_mode = DELETE');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA secure_delete = ON');
  applySchema(db);
  return db;
}
