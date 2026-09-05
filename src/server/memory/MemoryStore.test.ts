import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySchema, openMemoryDb } from './db';
import { MemoryStore } from './MemoryStore';
import type { MemoryItem } from './types';

function freshStore(): MemoryStore {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applySchema(db);
  return new MemoryStore(db);
}

describe('MemoryStore', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = freshStore();
  });

  it('creates a memory with auto-generated ID', () => {
    const a = store.create({ content: 'Use node via nvm', scope: 'personal', type: 'preference' }, { actor: 'system' });
    expect(a.id).toBe('M-01');
    expect(a.content).toBe('Use node via nvm');
    expect(a.status).toBe('active');
    expect(a.usageCount).toBe(0);
    expect(a.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(a.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const b = store.create({ content: 'Keep commits concise', scope: 'personal', type: 'preference' }, { actor: 'system' });
    expect(b.id).toBe('M-02');
  });

  it('rolls back a create when its audit event cannot be stored', () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applySchema(db);
    db.exec(`
      CREATE TRIGGER reject_memory_events
      BEFORE INSERT ON memory_events
      BEGIN
        SELECT RAISE(ABORT, 'event write failed');
      END;
    `);
    const failingStore = new MemoryStore(db);

    expect(() => failingStore.create(
      { content: 'must be atomic', scope: 'personal', type: 'fact' },
      { actor: 'system' },
    )).toThrow('event write failed');
    expect(failingStore.getById('M-01')).toBeNull();
  });

  it('honors an explicit ID and continues numbering after the max', () => {
    store.create({
      id: 'M-07',
      content: 'Only run MainTests (~19s)',
      scope: 'project',
      type: 'constraint',
      projectId: 'RenderX',
      topic: 'Testing',
    }, { actor: 'system' });
    const next = store.create({ content: 'next one', scope: 'project', type: 'fact', projectId: 'RenderX' }, { actor: 'system' });
    expect(next.id).toBe('M-08');
  });

  it('orders memories numerically by id, including past M-99', () => {
    store.create({ id: 'M-100', content: 'hundred', scope: 'personal', type: 'fact' }, { actor: 'system' });
    store.create({ id: 'M-09', content: 'nine', scope: 'personal', type: 'fact' }, { actor: 'system' });
    store.create({ id: 'M-99', content: 'ninety-nine', scope: 'personal', type: 'fact' }, { actor: 'system' });
    expect(store.list().map((m) => m.id)).toEqual(['M-09', 'M-99', 'M-100']);
  });

  it('retrieves memories by scope', () => {
    store.create({ content: 'p1', scope: 'personal', type: 'preference' }, { actor: 'system' });
    store.create({ content: 'p2', scope: 'personal', type: 'lesson' }, { actor: 'system' });
    store.create({ content: 'proj1', scope: 'project', type: 'constraint', projectId: 'RenderX' }, { actor: 'system' });

    const personal = store.list({ scope: 'personal' });
    expect(personal).toHaveLength(2);
    expect(personal.every((m) => m.scope === 'personal')).toBe(true);

    const project = store.list({ scope: 'project' });
    expect(project).toHaveLength(1);
    expect(project[0].content).toBe('proj1');
  });

  it('retrieves memories by projectId', () => {
    store.create({ content: 'rx', scope: 'project', type: 'fact', projectId: 'RenderX' }, { actor: 'system' });
    store.create({ content: 'pf', scope: 'project', type: 'fact', projectId: 'PixelFlow' }, { actor: 'system' });
    const rx = store.list({ projectId: 'RenderX' });
    expect(rx).toHaveLength(1);
    expect(rx[0].content).toBe('rx');
  });

  it('updates memory content (and preserves createdAt; maps non-content fields)', () => {
    const m = store.create({ content: 'Only run MainTests', scope: 'project', type: 'constraint', projectId: 'RenderX' }, { actor: 'system' });
    const updated = store.update(m.id, { content: 'Only run MainTests (~19s, --runInBand)' }, { actor: 'system' });
    expect(updated.content).toBe('Only run MainTests (~19s, --runInBand)');
    expect(store.getById(m.id)!.content).toBe('Only run MainTests (~19s, --runInBand)');
    expect(updated.createdAt).toBe(m.createdAt);
    expect(updated.updatedAt >= m.updatedAt).toBe(true);

    const withTopic = store.update(m.id, { topic: 'Testing' }, { actor: 'system' });
    expect(withTopic.topic).toBe('Testing');
    expect(withTopic.content).toBe('Only run MainTests (~19s, --runInBand)');
  });

  it('rolls back an update when its audit event cannot be stored', () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applySchema(db);
    const failingStore = new MemoryStore(db);
    const memory = failingStore.create(
      { content: 'original', scope: 'personal', type: 'fact' },
      { actor: 'system' },
    );
    db.exec(`
      CREATE TRIGGER reject_update_events
      BEFORE INSERT ON memory_events
      WHEN NEW.kind = 'edit'
      BEGIN
        SELECT RAISE(ABORT, 'event write failed');
      END;
    `);

    expect(() => failingStore.update(memory.id, { content: 'changed' }, { actor: 'user' }))
      .toThrow('event write failed');
    expect(failingStore.getById(memory.id)?.content).toBe('original');
  });

  it('update() ignores explicitly-undefined fields (undefined = leave unchanged)', () => {
    const m = store.create({
      content: 'keep me',
      scope: 'project',
      type: 'fact',
      projectId: 'RenderX',
      topic: 'Environment',
    }, { actor: 'system' });
    const r1 = store.update(m.id, { topic: undefined }, { actor: 'system' });
    expect(r1.topic).toBe('Environment');
    const r2 = store.update(m.id, { content: undefined }, { actor: 'system' });
    expect(r2.content).toBe('keep me');
  });

  it('update() with an empty patch is a no-op and does not bump updatedAt', () => {
    const m = store.create({ content: 'x', scope: 'personal', type: 'fact' }, { actor: 'system' });
    const after = store.update(m.id, {}, { actor: 'system' });
    expect(after.updatedAt).toBe(m.updatedAt);
    expect(after.content).toBe('x');
  });

  it('soft-deletes (archives) a memory', () => {
    const m = store.create({ content: 'temp', scope: 'session', type: 'lesson', sessionId: 'session-42' }, { actor: 'system' });
    const archived = store.archive(m.id, { actor: 'system' });
    expect(archived.status).toBe('archived');
    expect(store.getById(m.id)).not.toBeNull();
    expect(store.list({ status: 'active' }).map((x) => x.id)).not.toContain(m.id);
  });

  it('permanently discards an unaccepted candidate and its draft history', () => {
    const candidate = store.create(
      { content: 'secret draft', scope: 'personal', type: 'fact', status: 'candidate', sensitive: true },
      { actor: 'agent' },
    );

    store.discardCandidate(candidate.id);

    expect(store.getById(candidate.id)).toBeNull();
    expect(store.getEvents(candidate.id)).toEqual([]);
    expect(store.wasCandidateDismissed('  SECRET   DRAFT  ')).toBe(true);
    expect(store.wasCandidateDismissed('different draft')).toBe(false);
    expect(store.create(
      { content: 'next item', scope: 'personal', type: 'fact', status: 'candidate' },
      { actor: 'agent' },
    ).id).toBe('M-02');
  });

  it('keeps a hard-erased sensitive dismissal suppressed after an unmute attempt', () => {
    const candidate = store.create(
      { content: 'secret exact-repeat candidate', scope: 'personal', type: 'fact', status: 'candidate', sensitive: true },
      { actor: 'agent' },
    );
    store.discardCandidate(candidate.id);

    expect(() => store.unmuteProposal(candidate.id)).toThrow('sensitive dismissal is permanent');
    expect(store.wasCandidateDismissed(candidate.content)).toBe(true);
    expect(store.listMutedProposals()).toEqual([
      expect.objectContaining({ memoryId: candidate.id, content: null, canUnmute: false }),
    ]);
    expect(() => store.create(
      { id: candidate.id, content: candidate.content, scope: 'personal', type: 'fact', status: 'candidate', sensitive: true },
      { actor: 'agent' },
    )).toThrow(`Memory id was already used by a dismissed candidate: ${candidate.id}`);
  });

  it('never reuses a dismissed candidate id supplied explicitly', () => {
    const candidate = store.create(
      { id: 'M-07', content: 'temporary', scope: 'personal', type: 'fact', status: 'candidate' },
      { actor: 'agent' },
    );
    store.discardCandidate(candidate.id);

    expect(() => store.create(
      { id: 'M-07', content: 'replacement', scope: 'personal', type: 'fact', status: 'candidate' },
      { actor: 'agent' },
    )).toThrow('Memory id was already used by a dismissed candidate: M-07');
  });

  it('replaces a candidate draft without retaining the previous sensitive text', () => {
    const candidate = store.create(
      { content: 'deploy key sk-secret', detail: 'email person@example.com', scope: 'personal', type: 'fact', status: 'candidate', sensitive: true },
      { actor: 'agent' },
    );

    const sanitized = store.replaceCandidateDraft(
      candidate.id,
      { content: 'deploy key [REDACTED]', detail: 'email [REDACTED]' },
      { actor: 'user' },
    );

    expect(sanitized.content).toBe('deploy key [REDACTED]');
    const history = store.getEvents(candidate.id);
    expect(history).toHaveLength(1);
    expect(JSON.stringify(history)).not.toContain('sk-secret');
    expect(JSON.stringify(history)).not.toContain('person@example.com');
  });

  it('scrubs replaced and dismissed candidate text from the on-disk database and WAL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memosync-memory-privacy-'));
    const dbPath = join(dir, 'memory.db');
    const db = openMemoryDb(dbPath);
    const diskStore = new MemoryStore(db);
    try {
      const edited = diskStore.create(
        { content: 'physical-secret-one', detail: 'physical-secret-detail', scope: 'personal', type: 'fact', status: 'candidate' },
        { actor: 'agent' },
      );
      diskStore.replaceCandidateDraft(
        edited.id,
        { content: 'sanitized text', detail: 'sanitized detail' },
        { actor: 'user' },
      );
      const dismissed = diskStore.create(
        { content: 'physical-secret-two', scope: 'personal', type: 'fact', status: 'candidate' },
        { actor: 'agent' },
      );
      diskStore.discardCandidate(dismissed.id);
    } finally {
      db.close();
    }

    const diskBytes = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]
      .filter((filePath) => existsSync(filePath))
      .map((filePath) => readFileSync(filePath))
      .map((buffer) => buffer.toString('utf8'))
      .join('\n');
    expect(diskBytes).not.toContain('physical-secret-one');
    expect(diskBytes).not.toContain('physical-secret-detail');
    expect(diskBytes).not.toContain('physical-secret-two');
    rmSync(dir, { recursive: true, force: true });
  });

  it('detects conflict relations and discriminates by relation type', () => {
    const a = store.create({ content: 'Only run MainTests (~19s)', scope: 'project', type: 'constraint', projectId: 'RenderX' }, { actor: 'system' });
    const b = store.create({ content: 'Run full test suite before push', scope: 'project', type: 'constraint', projectId: 'RenderX' }, { actor: 'system' });
    const c = store.create({ content: 'Prefer early returns', scope: 'project', type: 'preference', projectId: 'RenderX' }, { actor: 'system' });

    store.addRelation(a.id, b.id, 'conflicts_with');
    store.addRelation(a.id, c.id, 'similar_to');

    const relations = store.getRelations(a.id);
    expect(relations).toHaveLength(2);
    expect(relations).toContainEqual({ type: 'conflicts_with', targetId: b.id });
    expect(relations).toContainEqual({ type: 'similar_to', targetId: c.id });
    expect(store.getConflicts(a.id).map((m) => m.id)).toEqual([b.id]);
  });

  describe('listConflicted (needs-attention, A1)', () => {
    it('includes project-scope conflicts when NO project filter is given (Board case, bug #1)', () => {
      const stale = store.create({ content: 'bun test', scope: 'project', type: 'constraint', projectId: 'P1' }, { actor: 'user' });
      const fresh = store.create({ content: 'bun test --coverage', scope: 'project', type: 'constraint', projectId: 'P1' }, { actor: 'agent' });
      store.addRelation(fresh.id, stale.id, 'conflicts_with');
      // No project filter (what the Board actually sends) must still surface it.
      expect(store.listConflicted().map((m) => m.id)).toContain(stale.id);
      // With the matching project filter too.
      expect(store.listConflicted('P1').map((m) => m.id)).toContain(stale.id);
      // A different project's conflict is excluded when a filter is given.
      expect(store.listConflicted('OTHER').map((m) => m.id)).not.toContain(stale.id);
    });

    it('drops a stale item once its ONLY superseding source is archived/discarded (bug #3/#5)', () => {
      const stale = store.create({ content: 'old rule', scope: 'personal', type: 'constraint' }, { actor: 'user' });
      const fresh = store.create({ content: 'new rule', scope: 'personal', type: 'constraint', status: 'candidate' }, { actor: 'agent' });
      store.addRelation(fresh.id, stale.id, 'conflicts_with');
      expect(store.listConflicted().map((m) => m.id)).toContain(stale.id);
      // User dismisses (discards) the superseding candidate → conflict resolved.
      store.archive(fresh.id, { actor: 'user' });
      expect(store.listConflicted().map((m) => m.id)).not.toContain(stale.id);
    });

    it('a candidate superseding source counts (so needs-attention shows before the user accepts)', () => {
      const stale = store.create({ content: 'old', scope: 'personal', type: 'fact' }, { actor: 'user' });
      const cand = store.create({ content: 'new', scope: 'personal', type: 'fact', status: 'candidate' }, { actor: 'agent' });
      store.addRelation(cand.id, stale.id, 'conflicts_with');
      expect(store.listConflicted().map((m) => m.id)).toContain(stale.id);
    });
  });

  it('stores detail and abstractionLevel; defaults abstraction to contextual', () => {
    const bare = store.create({ content: 'short form', scope: 'personal', type: 'fact' }, { actor: 'system' });
    expect(bare.abstractionLevel).toBe('contextual');
    expect(bare.detail).toBeUndefined();

    const full = store.create(
      {
        content: 'Use bun test, never jest',
        detail: 'The repo runs on bun:test. Jest is not installed; its mocks are incompatible. CI calls `bun test src/`.',
        abstractionLevel: 'concrete',
        scope: 'project',
        type: 'constraint',
        projectId: 'RenderX',
      },
      { actor: 'agent', sessionId: 'session-1' },
    );
    expect(full.detail).toContain('bun:test');
    expect(full.abstractionLevel).toBe('concrete');
    expect(store.getById(full.id)!.detail).toContain('bun:test');

    const updated = store.update(full.id, { abstractionLevel: 'general', detail: 'rewritten' }, { actor: 'user' });
    expect(updated.abstractionLevel).toBe('general');
    expect(updated.detail).toBe('rewritten');
  });

  it('stores the sensitive flag from capture privacy gating (default false)', () => {
    const plain = store.create({ content: 'x', scope: 'personal', type: 'fact' }, { actor: 'system' });
    expect(plain.sensitive).toBe(false);
    const flagged = store.create(
      { content: 'API key location', scope: 'personal', type: 'fact', sensitive: true, status: 'candidate' },
      { actor: 'agent' },
    );
    expect(flagged.sensitive).toBe(true);
    expect(store.getById(flagged.id)!.sensitive).toBe(true);
  });

  describe('version/usage event log (option 乙)', () => {
    it('logs a create event with actor + session + full snapshot', () => {
      const m = store.create(
        { content: 'x', scope: 'session', type: 'lesson', sessionId: 's-9' },
        { actor: 'agent', sessionId: 's-9', turn: 3 },
      );
      const events = store.getEvents(m.id);
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('create');
      expect(events[0].actor).toBe('agent');
      expect(events[0].sessionId).toBe('s-9');
      expect(events[0].turn).toBe(3);
      expect(events[0].snapshot?.content).toBe('x');
    });

    it('logs edit events with before→after per changed field', () => {
      const m = store.create({ content: 'old', scope: 'personal', type: 'fact' }, { actor: 'user' });
      store.update(m.id, { content: 'new', topic: 'Env' }, { actor: 'user' });
      const events = store.getEvents(m.id);
      expect(events).toHaveLength(2);
      const edit = events[1];
      expect(edit.kind).toBe('edit');
      expect(edit.changes?.content).toEqual({ before: 'old', after: 'new' });
      expect(edit.changes?.topic).toEqual({ before: null, after: 'Env' });
      expect(edit.snapshot?.content).toBe('new');
    });

    it('classifies scope-widening as promote and other scope changes as rescope', () => {
      const m = store.create({ content: 'x', scope: 'session', type: 'fact', sessionId: 's1' }, { actor: 'user' });
      store.update(m.id, { scope: 'project', projectId: 'RenderX' }, { actor: 'user' });
      store.update(m.id, { scope: 'session', sessionId: 's1' }, { actor: 'user' });
      const kinds = store.getEvents(m.id).map((e) => e.kind);
      expect(kinds).toEqual(['create', 'promote', 'rescope']);
    });

    it('classifies status-only changes (accept/archive) as status events', () => {
      const m = store.create({ content: 'x', scope: 'personal', type: 'fact', status: 'candidate' }, { actor: 'agent' });
      store.update(m.id, { status: 'active' }, { actor: 'user' });
      store.archive(m.id, { actor: 'user' });
      const kinds = store.getEvents(m.id).map((e) => e.kind);
      expect(kinds).toEqual(['create', 'status', 'status']);
      const accept = store.getEvents(m.id)[1];
      expect(accept.changes?.status).toEqual({ before: 'candidate', after: 'active' });
    });

    it('recordUse appends use events; only CITATIONS bump usageCount (detail loads do not)', () => {
      const m = store.create({ content: 'x', scope: 'personal', type: 'fact' }, { actor: 'user' });
      store.recordUse(m.id, { actor: 'agent', sessionId: 's2', via: 'citation' });
      store.recordUse(m.id, { actor: 'agent', sessionId: 's2', via: 'detail_load', detailLoaded: true });
      // usage_count means "cited N×" — the hover card's number. Detail loads
      // are recorded in the event log but do not inflate the counter.
      expect(store.getById(m.id)!.usageCount).toBe(1);
      const events = store.getEvents(m.id);
      expect(events.map((e) => e.kind)).toEqual(['create', 'use', 'use']);
      expect(events[1].snapshot).toBeUndefined();
      expect(events[1].meta?.via).toBe('citation');
      expect(events[2].meta?.via).toBe('detail_load');
      expect(events[2].meta?.detailLoaded).toBe(true);
      // a use is not a version: updatedAt untouched
      expect(store.getById(m.id)!.updatedAt).toBe(m.updatedAt);
    });

    it('rolls back usageCount when a use event cannot be stored', () => {
      const db = new Database(':memory:');
      db.exec('PRAGMA foreign_keys = ON');
      applySchema(db);
      const failingStore = new MemoryStore(db);
      const memory = failingStore.create(
        { content: 'atomic usage', scope: 'personal', type: 'fact' },
        { actor: 'system' },
      );
      db.exec(`
        CREATE TRIGGER reject_use_events
        BEFORE INSERT ON memory_events
        WHEN NEW.kind = 'use'
        BEGIN
          SELECT RAISE(ABORT, 'event write failed');
        END;
      `);

      expect(() => failingStore.recordUse(memory.id, { actor: 'agent', via: 'citation' }))
        .toThrow('event write failed');
      expect(failingStore.getById(memory.id)?.usageCount).toBe(0);
    });

    it('rolls back to a prior version and records a revert event (history preserved)', () => {
      const m = store.create({ content: 'v1', scope: 'personal', type: 'fact' }, { actor: 'user' });
      store.update(m.id, { content: 'v2', topic: 'T' }, { actor: 'user' });
      store.recordUse(m.id, { actor: 'agent' });
      store.update(m.id, { content: 'v3' }, { actor: 'agent' });

      const createSeq = store.getEvents(m.id)[0].seq;
      const rolledBack = store.rollback(m.id, createSeq, { actor: 'user' });
      expect(rolledBack.content).toBe('v1');
      expect(rolledBack.topic).toBeUndefined();
      // usage survives rollback (it is history, not versioned state)
      expect(rolledBack.usageCount).toBe(1);

      const events = store.getEvents(m.id);
      expect(events.map((e) => e.kind)).toEqual(['create', 'edit', 'use', 'edit', 'revert']);
      const revert = events.at(-1)!;
      expect(revert.changes?.content).toEqual({ before: 'v3', after: 'v1' });
      expect(revert.meta?.toSeq).toBe(createSeq);
    });

    it('keeps the current version when a revert event cannot be stored', () => {
      const db = new Database(':memory:');
      db.exec('PRAGMA foreign_keys = ON');
      applySchema(db);
      const failingStore = new MemoryStore(db);
      const memory = failingStore.create(
        { content: 'v1', scope: 'personal', type: 'fact' },
        { actor: 'user' },
      );
      const createSeq = failingStore.getEvents(memory.id)[0]!.seq;
      failingStore.update(memory.id, { content: 'v2' }, { actor: 'user' });
      db.exec(`
        CREATE TRIGGER reject_revert_events
        BEFORE INSERT ON memory_events
        WHEN NEW.kind = 'revert'
        BEGIN
          SELECT RAISE(ABORT, 'event write failed');
        END;
      `);

      expect(() => failingStore.rollback(memory.id, createSeq, { actor: 'user' }))
        .toThrow('event write failed');
      expect(failingStore.getById(memory.id)?.content).toBe('v2');
    });

    it('rollback rejects a use event or an unknown seq as a target', () => {
      const m = store.create({ content: 'v1', scope: 'personal', type: 'fact' }, { actor: 'user' });
      store.recordUse(m.id, { actor: 'agent' });
      const useSeq = store.getEvents(m.id)[1].seq;
      expect(() => store.rollback(m.id, useSeq, { actor: 'user' })).toThrow();
      expect(() => store.rollback(m.id, 99999, { actor: 'user' })).toThrow();
    });
  });

  describe('session exclusions (D7 working-set mutes)', () => {
    it('sets, replaces, and reads the muted ids for a session ([] = all in)', () => {
      const a = store.create({ content: 'a', scope: 'personal', type: 'fact' }, { actor: 'system' });
      const b = store.create({ content: 'b', scope: 'personal', type: 'fact' }, { actor: 'system' });
      expect(store.getSessionExclusions('chat-1')).toEqual([]);
      store.setSessionExclusions('chat-1', [a.id, b.id]);
      expect(store.getSessionExclusions('chat-1')).toEqual([a.id, b.id]);
      store.setSessionExclusions('chat-1', [b.id]);
      expect(store.getSessionExclusions('chat-1')).toEqual([b.id]);
      // Clearing restores the all-in default; other sessions are untouched.
      store.setSessionExclusions('chat-1', []);
      expect(store.getSessionExclusions('chat-1')).toEqual([]);
      expect(store.getSessionExclusions('chat-2')).toEqual([]);
    });
  });

  describe('schema migration', () => {
    it('adds new columns to a legacy v1 database and defaults existing rows', () => {
      const db = new Database(':memory:');
      // The pre-upgrade schema: no detail / abstraction_level, no memory_events.
      db.exec(`CREATE TABLE memories (
        id TEXT PRIMARY KEY, content TEXT NOT NULL, scope TEXT NOT NULL, type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', project_id TEXT, session_id TEXT, topic TEXT,
        provenance_session_id TEXT, provenance_turn INTEGER,
        usage_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`);
      db.exec(`INSERT INTO memories (id, content, scope, type, created_at, updated_at)
               VALUES ('M-01', 'legacy row', 'personal', 'fact', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
      applySchema(db);
      const legacyStore = new MemoryStore(db);
      const m = legacyStore.getById('M-01')!;
      expect(m.content).toBe('legacy row');
      expect(m.abstractionLevel).toBe('contextual');
      expect(m.detail).toBeUndefined();
      // the event log works for legacy rows too
      legacyStore.recordUse('M-01', { actor: 'agent' });
      expect(legacyStore.getEvents('M-01').map((e) => e.kind)).toEqual(['use']);
    });

    it('backfills immutable sensitive evidence for retained and hard-erased legacy dismissals', () => {
      const db = new Database(':memory:');
      db.exec(`CREATE TABLE memories (
        id TEXT PRIMARY KEY, content TEXT NOT NULL, sensitive INTEGER NOT NULL DEFAULT 0,
        scope TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
        project_id TEXT, session_id TEXT, topic TEXT, provenance_session_id TEXT,
        provenance_turn INTEGER, usage_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`);
      db.exec(`INSERT INTO memories
        (id, content, sensitive, scope, type, status, created_at, updated_at)
        VALUES
          ('M-retained', 'legacy secret', 1, 'personal', 'fact', 'candidate',
           '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
          ('M-corrupt-state', 'already relabelled secret', 0, 'personal', 'fact', 'candidate',
           '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
      db.exec(`CREATE TABLE dismissed_candidate_fingerprints (
        memory_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, dismissed_at TEXT NOT NULL
      )`);
      db.exec(`INSERT INTO dismissed_candidate_fingerprints VALUES
        ('M-retained', 'retained-fingerprint', '2026-01-01T00:00:00Z'),
        ('M-corrupt-state', 'corrupt-fingerprint', '2026-01-01T00:00:00Z'),
        ('M-hard-erased', 'erased-fingerprint', '2026-01-01T00:00:00Z')`);

      applySchema(db);

      const columns = (db.query(`PRAGMA table_info(dismissed_candidate_fingerprints)`).all() as Array<{ name: string }>)
        .map((column) => column.name);
      const evidence = db.query(
        `SELECT memory_id AS memoryId, sensitive
           FROM dismissed_candidate_fingerprints
          ORDER BY memory_id`,
      ).all() as Array<{ memoryId: string; sensitive: number }>;
      expect(columns).toContain('sensitive');
      expect(evidence).toEqual([
        { memoryId: 'M-corrupt-state', sensitive: 1 },
        { memoryId: 'M-hard-erased', sensitive: 1 },
        { memoryId: 'M-retained', sensitive: 1 },
      ]);
    });
  });

  it('computes correct hash for memory file', () => {
    const items: MemoryItem[] = [
      store.create({ id: 'M-02', content: 'beta', scope: 'personal', type: 'fact' }, { actor: 'system' }),
      store.create({ id: 'M-01', content: 'alpha', scope: 'personal', type: 'fact' }, { actor: 'system' }),
    ];
    const h1 = MemoryStore.computeHash(items);
    expect(h1).toMatch(/^[0-9a-f]{8}$/);
    expect(MemoryStore.computeHash([...items].reverse())).toBe(h1);
    const changed = items.map((m) => (m.id === 'M-01' ? { ...m, content: 'ALPHA' } : m));
    expect(MemoryStore.computeHash(changed)).not.toBe(h1);
    const swapped = items.map((m) => (m.id === 'M-01' ? { ...m, content: 'beta' } : { ...m, content: 'alpha' }));
    expect(MemoryStore.computeHash(swapped)).not.toBe(h1);
    const oneItem = [{ id: 'M-01', content: 'a\nM-02:b' }];
    const twoItems = [
      { id: 'M-01', content: 'a' },
      { id: 'M-02', content: 'b' },
    ];
    expect(MemoryStore.computeHash(oneItem)).not.toBe(MemoryStore.computeHash(twoItems));
  });
});

describe('recentlyDismissedCandidates (capture negative examples)', () => {
  it('returns soft-dismissed (candidate→discarded) items newest-first, capped by limit', () => {
    const store = freshStore();
    const a = store.create({ content: 'User dislikes celery', scope: 'personal', type: 'preference', status: 'candidate' }, { actor: 'agent' });
    const b = store.create({ content: 'Repo uses spaces', scope: 'personal', type: 'fact', status: 'candidate' }, { actor: 'agent' });
    const c = store.create({ content: 'Standup at 10', scope: 'personal', type: 'fact', status: 'candidate' }, { actor: 'agent' });
    store.dismissCandidate(a.id, { actor: 'user' });
    store.dismissCandidate(b.id, { actor: 'user' });
    store.dismissCandidate(c.id, { actor: 'user' });

    const dismissed = store.recentlyDismissedCandidates(2);
    expect(dismissed.map((m) => m.id)).toEqual([c.id, b.id]);
    expect(dismissed[0].content).toBe('Standup at 10');
  });

  it('does NOT count accepted-then-archived, plain-archived, or hard-discarded items', () => {
    const store = freshStore();
    // Accepted: candidate → active → archived (a lifecycle end, not a rejection).
    const accepted = store.create({ content: 'Was accepted once', scope: 'personal', type: 'fact', status: 'candidate' }, { actor: 'agent' });
    store.update(accepted.id, { status: 'active' }, { actor: 'user' });
    store.archive(accepted.id, { actor: 'user' });
    // Born active, then archived — also not a dismissal.
    const active = store.create({ content: 'Born active', scope: 'personal', type: 'fact' }, { actor: 'user' });
    store.archive(active.id, { actor: 'user' });
    // A SENSITIVE dismissal hard-deletes: no text may survive for the gate.
    const secret = store.create({ content: 'token sk-999', scope: 'personal', type: 'fact', status: 'candidate', sensitive: true }, { actor: 'agent' });
    store.discardCandidate(secret.id);
    // A real (non-sensitive) dismissal for contrast.
    const rejected = store.create({ content: 'Rejected candidate', scope: 'personal', type: 'fact', status: 'candidate' }, { actor: 'agent' });
    store.dismissCandidate(rejected.id, { actor: 'user' });

    expect(store.recentlyDismissedCandidates(10).map((m) => m.id)).toEqual([rejected.id]);
  });

  it('dismissCandidate keeps the row (status discarded), writes the fingerprint, and records the event', () => {
    const store = freshStore();
    const cand = store.create({ content: 'Prefers tabs over spaces', scope: 'personal', type: 'preference', status: 'candidate' }, { actor: 'agent' });
    const dismissed = store.dismissCandidate(cand.id, { actor: 'user', sessionId: 's9' });
    expect(dismissed.status).toBe('discarded');
    // Text retained (negative example / study distractor)…
    expect(store.getById(cand.id)?.content).toBe('Prefers tabs over spaces');
    // …fingerprint written (exact-repeat suppression)…
    expect(store.wasCandidateDismissed('  prefers TABS over spaces ')).toBe(true);
    // …and the resolution is an auditable event.
    const statusEvents = store.getEvents(cand.id).filter((e) => e.kind === 'status');
    expect(statusEvents).toHaveLength(1);
    expect(statusEvents[0]!.changes?.status).toEqual({ before: 'candidate', after: 'discarded' });
  });

  it('restores a soft-dismissed Candidate and its suppression fingerprint in one act', () => {
    const store = freshStore();
    const candidate = store.create(
      { content: 'Use the project lint command', scope: 'project', projectId: 'p1', type: 'constraint', status: 'candidate' },
      { actor: 'agent' },
    );
    store.dismissCandidate(candidate.id, { actor: 'user' });

    const restored = store.restoreDismissedCandidate(candidate.id, { actor: 'user', sessionId: 'chat-1' });

    expect(restored.status).toBe('candidate');
    expect(store.wasCandidateDismissed(candidate.content)).toBe(false);
    expect(store.getEvents(candidate.id).filter((event) => event.kind === 'status').at(-1)?.changes?.status)
      .toEqual({ before: 'discarded', after: 'candidate' });
  });

  it('still lets a non-sensitive dismissal lift only its proposal suppression', () => {
    const store = freshStore();
    const candidate = store.create(
      { content: 'Allow this proposal to be suggested again', scope: 'personal', type: 'fact', status: 'candidate' },
      { actor: 'agent' },
    );
    store.dismissCandidate(candidate.id, { actor: 'user' });

    expect(store.unmuteProposal(candidate.id)).toBe(true);
    expect(store.wasCandidateDismissed(candidate.content)).toBe(false);
    expect(store.getById(candidate.id)!.status).toBe('discarded');
  });

  it('does not lift dismissal evidence from a non-discarded legacy row', () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applySchema(db);
    const store = new MemoryStore(db);
    const candidate = store.create(
      { content: 'legacy non-sensitive candidate', scope: 'personal', type: 'fact', status: 'candidate' },
      { actor: 'agent' },
    );
    store.dismissCandidate(candidate.id, { actor: 'user' });
    db.query(`UPDATE memories SET status = 'candidate' WHERE id = ?`).run(candidate.id);

    expect(() => store.unmuteProposal(candidate.id)).toThrow('dismissal evidence cannot be lifted');
    expect(store.wasCandidateDismissed(candidate.content)).toBe(true);
  });

  it('refuses to restore a legacy sensitive discarded row', () => {
    const store = freshStore();
    const candidate = store.create(
      { content: 'sensitive draft', scope: 'personal', type: 'fact', status: 'candidate', sensitive: true },
      { actor: 'agent' },
    );
    store.dismissCandidate(candidate.id, { actor: 'user' });

    expect(() => store.restoreDismissedCandidate(candidate.id, { actor: 'user' })).toThrow('Sensitive candidates cannot be restored');
    expect(store.getById(candidate.id)!.status).toBe('discarded');
    expect(store.wasCandidateDismissed(candidate.content)).toBe(true);
  });

  it('rejects every ordinary store transition out of a legacy sensitive dismissal', () => {
    const store = freshStore();
    const candidate = store.create(
      { content: 'legacy-sensitive-store-transition', scope: 'personal', type: 'fact', status: 'candidate', sensitive: true },
      { actor: 'agent' },
    );
    store.dismissCandidate(candidate.id, { actor: 'user' });

    expect(() => store.archive(candidate.id, { actor: 'user' })).toThrow('dismissed Candidate is immutable');
    expect(() => store.update(candidate.id, { status: 'candidate', sensitive: false }, { actor: 'user' }))
      .toThrow('dismissed Candidate is immutable');
    expect(() => store.acceptRevision(candidate.id, { actor: 'user' })).toThrow('dismissed Candidate is immutable');
    expect(store.getById(candidate.id)).toMatchObject({ status: 'discarded', sensitive: true });
  });

  it('does not let candidate draft replacement erase a legacy sensitive dismissal', () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applySchema(db);
    const store = new MemoryStore(db);
    const candidate = store.create(
      { content: 'legacy-sensitive-rewrite', scope: 'personal', type: 'fact', status: 'candidate', sensitive: true },
      { actor: 'agent' },
    );
    store.dismissCandidate(candidate.id, { actor: 'user' });
    // Reproduce a row already moved by an older build. The public behavior
    // under test starts from this persisted legacy state.
    db.query(`UPDATE memories SET status = 'candidate' WHERE id = ?`).run(candidate.id);

    expect(() => store.replaceCandidateDraft(
      candidate.id,
      { content: 'sanitized rewrite', sensitive: false },
      { actor: 'user' },
    )).toThrow('dismissed Candidate is immutable');
    expect(() => store.acceptReviewedSensitiveCandidate(
      candidate.id,
      { content: 'reviewed sanitized rewrite', detail: '' },
      { actor: 'user' },
    )).toThrow('dismissed Candidate is immutable');
    expect(store.getById(candidate.id)).toMatchObject({
      content: 'legacy-sensitive-rewrite',
      status: 'candidate',
      sensitive: true,
    });
  });

  it('keeps durable sensitive dismissal evidence authoritative after legacy row and history corruption', () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applySchema(db);
    const store = new MemoryStore(db);
    const candidate = store.create(
      { content: 'legacy-sensitive-full-chain', scope: 'personal', type: 'fact', status: 'candidate', sensitive: true },
      { actor: 'agent' },
    );
    store.dismissCandidate(candidate.id, { actor: 'user' });
    // Persist the exact state left by the old bypass after it had already
    // relabelled the row and erased its item history. The dismissal evidence
    // table is the only surviving authority at this point.
    db.query(`UPDATE memories SET status = 'candidate', sensitive = 0 WHERE id = ?`).run(candidate.id);
    db.query(`DELETE FROM memory_events WHERE memory_id = ?`).run(candidate.id);

    expect(() => store.replaceCandidateDraft(
      candidate.id,
      { content: 'attacker rewrite', sensitive: false },
      { actor: 'user' },
    )).toThrow('dismissed Candidate is immutable');
    expect(() => store.unmuteProposal(candidate.id)).toThrow('sensitive dismissal is permanent');
    expect(() => store.update(candidate.id, { status: 'active' }, { actor: 'user' }))
      .toThrow('dismissed Candidate is immutable');
    expect(store.getById(candidate.id)).toMatchObject({
      content: 'legacy-sensitive-full-chain',
      status: 'candidate',
      sensitive: false,
    });
    expect(store.listMutedProposals()).toEqual([
      expect.objectContaining({ memoryId: candidate.id, content: null, canUnmute: false }),
    ]);
    expect(store.wasCandidateDismissed(candidate.content)).toBe(true);
  });

  it('hard-erases a currently sensitive legacy Candidate even when its dismissal fingerprint already exists', () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applySchema(db);
    const store = new MemoryStore(db);
    const candidate = store.create(
      { content: 'legacy-sensitive-redismiss', scope: 'personal', type: 'fact', status: 'candidate', sensitive: true },
      { actor: 'agent' },
    );
    store.dismissCandidate(candidate.id, { actor: 'user' });
    db.query(`UPDATE memories SET status = 'candidate' WHERE id = ?`).run(candidate.id);

    expect(() => store.discardCandidate(candidate.id)).not.toThrow();
    expect(store.getById(candidate.id)).toBeNull();
    expect(store.wasCandidateDismissed(candidate.content)).toBe(true);
    expect(db.query(
      `SELECT sensitive FROM dismissed_candidate_fingerprints WHERE memory_id = ?`,
    ).get(candidate.id)).toEqual({ sensitive: 1 });
  });

  it('does not let history rollback resurrect a legacy sensitive dismissed Candidate', () => {
    const store = freshStore();
    const candidate = store.create(
      { content: 'legacy-sensitive-rollback', scope: 'personal', type: 'fact', status: 'candidate', sensitive: true },
      { actor: 'agent' },
    );
    const candidateSnapshotSeq = store.getEvents(candidate.id)[0]!.seq;
    store.dismissCandidate(candidate.id, { actor: 'user' });

    expect(() => store.rollback(candidate.id, candidateSnapshotSeq, { actor: 'user' }))
      .toThrow('dismissed Candidate is immutable');
    expect(store.getById(candidate.id)).toMatchObject({ status: 'discarded', sensitive: true });
  });

  it('recentlyAcceptedCandidates returns accepted items newest-first (positive examples)', () => {
    const store = freshStore();
    const a = store.create({ content: 'Run tests with bun test', scope: 'personal', type: 'fact', status: 'candidate' }, { actor: 'agent' });
    const b = store.create({ content: 'Keep commits small', scope: 'personal', type: 'preference', status: 'candidate' }, { actor: 'agent' });
    const rejected = store.create({ content: 'Noise item', scope: 'personal', type: 'fact', status: 'candidate' }, { actor: 'agent' });
    store.update(a.id, { status: 'active' }, { actor: 'user' });
    store.update(b.id, { status: 'active' }, { actor: 'user' });
    store.dismissCandidate(rejected.id, { actor: 'user' });

    expect(store.recentlyAcceptedCandidates(10).map((m) => m.id)).toEqual([b.id, a.id]);
  });
})

describe('reinforce + revision plumbing (self-evolution)', () => {
  it('recordReinforce bumps reinforced_count and appends a reinforce event', () => {
    const store = freshStore();
    const m = store.create({ content: 'API routes live under server/routes', scope: 'personal', type: 'fact' }, { actor: 'agent' });
    expect(m.reinforcedCount).toBe(0);
    store.recordReinforce(m.id, { actor: 'agent', sessionId: 's1', turn: 2 });
    const after = store.getById(m.id)!;
    expect(after.reinforcedCount).toBe(1);
    expect(store.getEvents(m.id).some((e) => e.kind === 'reinforce')).toBe(true);
  });

  it('revisionTargetOf/hasOpenRevision resolve a pending revises candidate; recentTraceLabels returns newest-first', () => {
    const store = freshStore();
    const target = store.create({ content: 'Use port 3000 for the dev server', scope: 'personal', type: 'constraint' }, { actor: 'agent' });
    store.recordTraceLabel(target.id, 'violated', { actor: 'agent', turn: 1 });
    store.recordTraceLabel(target.id, 'violated', { actor: 'agent', turn: 2 });
    store.recordTraceLabel(target.id, 'operational', { actor: 'agent', turn: 3 });
    expect(store.recentTraceLabels(target.id, 3)).toEqual(['operational', 'violated', 'violated']);

    expect(store.hasOpenRevision(target.id)).toBe(false);
    const proposal = store.create(
      { content: 'Use port 3001 for the dev server', scope: 'personal', type: 'constraint', status: 'candidate' },
      { actor: 'system' },
    );
    store.addRelation(proposal.id, target.id, 'revises');
    expect(store.hasOpenRevision(target.id)).toBe(true);
    expect(store.revisionTargetOf(proposal.id)?.id).toBe(target.id);
    // Resolving the proposal (accept path archives target; here dismiss) closes it.
    store.dismissCandidate(proposal.id, { actor: 'user' });
    expect(store.hasOpenRevision(target.id)).toBe(false);
  });

  it('createRevisionProposal is atomic: creates once, then refuses while one is open or the target is gone', () => {
    const store = freshStore();
    const target = store.create({ content: 'Use port 3000', scope: 'personal', type: 'constraint' }, { actor: 'user' });
    const input = { content: 'Use port 4000', scope: 'personal' as const, type: 'constraint' as const };

    const first = store.createRevisionProposal(input, target.id, { actor: 'system' });
    expect(first).not.toBeNull();
    expect(first!.status).toBe('candidate');
    expect(store.revisionTargetOf(first!.id)?.id).toBe(target.id);

    // Second concurrent draft for the same target loses (post-await recheck).
    expect(store.createRevisionProposal(input, target.id, { actor: 'system' })).toBeNull();

    // Resolving the open proposal reopens the door; an archived target closes it.
    store.dismissCandidate(first!.id, { actor: 'user' });
    store.archive(target.id, { actor: 'user' });
    expect(store.createRevisionProposal(input, target.id, { actor: 'system' })).toBeNull();
  });

  it('a scope move clears binding columns the new scope has no use for', () => {
    const store = freshStore();
    const m = store.create(
      { content: 'x', scope: 'project', projectId: 'RenderX', type: 'fact' },
      { actor: 'user' },
    );

    const personal = store.update(m.id, { scope: 'personal' }, { actor: 'user' });
    expect(personal.projectId).toBeUndefined();
    expect(personal.sessionId).toBeUndefined();

    const session = store.update(m.id, { scope: 'session', sessionId: 'chat-9' }, { actor: 'user' });
    expect(session.sessionId).toBe('chat-9');
    expect(session.projectId).toBeUndefined();

    const project = store.update(m.id, { scope: 'project', projectId: 'Other' }, { actor: 'user' });
    expect(project.projectId).toBe('Other');
    expect(project.sessionId).toBeUndefined();

    // Candidate drafts normalize the same way.
    const draft = store.create(
      { content: 'y', scope: 'project', projectId: 'RenderX', type: 'fact', status: 'candidate' },
      { actor: 'agent' },
    );
    const rescoped = store.replaceCandidateDraft(draft.id, { scope: 'personal' }, { actor: 'user' });
    expect(rescoped.projectId).toBeUndefined();
  });

  it('createRevisionProposal drops a draft whose target moved past its content snapshot (CAS)', () => {
    const store = freshStore();
    const target = store.create({ content: 'Use port 3000', scope: 'personal', type: 'constraint' }, { actor: 'user' });
    const input = { content: 'Use port 4000', scope: 'personal' as const, type: 'constraint' as const };

    // The user edits the target while a drafter is writing against the old text.
    store.update(target.id, { content: 'Use port 5000 (user fixed it)' }, { actor: 'user' });
    expect(
      store.createRevisionProposal(input, target.id, { actor: 'system' }, { expectedTargetContent: 'Use port 3000' }),
    ).toBeNull();

    // A matching snapshot still proposes.
    expect(
      store.createRevisionProposal(input, target.id, { actor: 'system' }, { expectedTargetContent: 'Use port 5000 (user fixed it)' }),
    ).not.toBeNull();
  });

  it('acceptRevision activates the candidate and archives its target in one act', () => {
    const store = freshStore();
    const target = store.create({ content: 'Use port 3000', scope: 'personal', type: 'constraint' }, { actor: 'user' });
    const proposal = store.createRevisionProposal(
      { content: 'Use port 4000', scope: 'personal', type: 'constraint' },
      target.id,
      { actor: 'system' },
    )!;

    const { updated, replaced } = store.acceptRevision(proposal.id, { actor: 'user' });
    expect(updated.status).toBe('active');
    expect(replaced.map((r) => r.id)).toEqual([target.id]);
    expect(store.getById(target.id)!.status).toBe('archived');
    // The proposal keeps its provenance link to the memory it replaced.
    expect(store.revisionTargetOf(proposal.id)?.id).toBe(target.id);
  });

  it('a MERGE proposal revises BOTH originals; accepting archives the pair (REDESIGN D5)', () => {
    const store = freshStore();
    const a = store.create({ content: 'Use pnpm, never npm, in this repo', scope: 'personal', type: 'constraint' }, { actor: 'user' });
    const b = store.create({ content: 'The user wants pnpm instead of npm', scope: 'personal', type: 'preference' }, { actor: 'agent' });

    const proposal = store.createMergeProposal(
      { content: 'Use pnpm (never npm) for installs and scripts', scope: 'personal', type: 'constraint' },
      [a.id, b.id],
      { actor: 'system' },
      { expectedContents: [a.content, b.content] },
    )!;
    expect(proposal).not.toBeNull();
    expect(store.revisionTargetsOf(proposal.id).map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
    // Both originals now sit behind an open revision (excluded from stale/redundant lanes).
    expect(store.hasOpenRevision(a.id)).toBe(true);
    expect(store.hasOpenRevision(b.id)).toBe(true);

    const { updated, replaced } = store.acceptRevision(proposal.id, { actor: 'user' });
    expect(updated.status).toBe('active');
    expect(replaced.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect(store.getById(a.id)!.status).toBe('archived');
    expect(store.getById(b.id)!.status).toBe('archived');
  });

  it('createMergeProposal CAS: a moved original voids the draft', () => {
    const store = freshStore();
    const a = store.create({ content: 'Use pnpm', scope: 'personal', type: 'constraint' }, { actor: 'user' });
    const b = store.create({ content: 'pnpm preferred', scope: 'personal', type: 'preference' }, { actor: 'agent' });
    store.update(a.id, { content: 'Use bun now' }, { actor: 'user' }); // moved during the draft await
    const proposal = store.createMergeProposal(
      { content: 'merged', scope: 'personal', type: 'constraint' },
      [a.id, b.id],
      { actor: 'system' },
      { expectedContents: ['Use pnpm', 'pnpm preferred'] },
    );
    expect(proposal).toBeNull();
    expect(store.list({ status: 'candidate' })).toHaveLength(0);
  });

  it('memory_kv round-trips values and candidateResolutionsSince counts accepts + dismissals', () => {
    const store = freshStore();
    store.setKv('capture_policy_memo', { memo: 'keep build commands', seq: 0, updatedAt: 'now', author: 'system' });
    expect(store.getKv<{ memo: string }>('capture_policy_memo')?.memo).toBe('keep build commands');

    const base = store.candidateResolutionsSince(0);
    const a = store.create({ content: 'x', scope: 'personal', type: 'fact', status: 'candidate' }, { actor: 'agent' });
    const b = store.create({ content: 'y', scope: 'personal', type: 'fact', status: 'candidate' }, { actor: 'agent' });
    store.update(a.id, { status: 'active' }, { actor: 'user' });
    store.dismissCandidate(b.id, { actor: 'user' });
    const after = store.candidateResolutionsSince(base.maxSeq);
    expect(after.count).toBe(2);
    expect(after.maxSeq).toBeGreaterThan(base.maxSeq);
  });
})

describe('trace label events', () => {
  it('recordTraceLabel appends a trace event and latestTraceLabels returns the last label per memory', () => {
    const store = freshStore();
    const a = store.create({ content: 'a', scope: 'personal', type: 'constraint' }, { actor: 'system' });
    const b = store.create({ content: 'b', scope: 'personal', type: 'fact' }, { actor: 'system' });

    store.recordTraceLabel(a.id, 'violated', { actor: 'agent', sessionId: 's1', turn: 1 });
    store.recordTraceLabel(b.id, 'operational', { actor: 'agent', sessionId: 's1', turn: 1 });
    store.recordTraceLabel(a.id, 'operational', { actor: 'agent', sessionId: 's1', turn: 2 });

    const labels = store.latestTraceLabels();
    expect(labels.get(a.id)).toBe('operational'); // last wins
    expect(labels.get(b.id)).toBe('operational');

    const events = store.getEvents(a.id).filter((e) => e.kind === 'trace');
    expect(events).toHaveLength(2);
    expect(events[0]!.meta).toEqual({ label: 'violated' });
  });

  it('recordTraceLabel on a missing id is a no-op (post-turn pass races deletion)', () => {
    const store = freshStore();
    expect(() => store.recordTraceLabel('M-404', 'operational', { actor: 'agent' })).not.toThrow();
    expect(store.latestTraceLabels().size).toBe(0);
  });
});

describe('expiry (stale=过期) + renew + open revisions', () => {
  it('flags memories untouched since the boundary; use/renew refresh, passive trace does not', async () => {
    const store = freshStore();
    const untouched = store.create({ content: 'u', scope: 'personal', type: 'fact' }, { actor: 'user' });
    const used = store.create({ content: 'c', scope: 'personal', type: 'fact' }, { actor: 'user' });
    const renewed = store.create({ content: 'r', scope: 'personal', type: 'fact' }, { actor: 'user' });
    await Bun.sleep(5);
    const boundary = new Date().toISOString();
    await Bun.sleep(5);
    store.recordUse(used.id, { actor: 'agent', via: 'citation' });
    store.renewMemory(renewed.id, { actor: 'user' });
    // A per-turn trace verdict is passive observation, not a reference.
    store.recordTraceLabel(untouched.id, 'operational', { actor: 'agent', turn: 1 });

    expect(store.listExpired({ boundaryTs: boundary }).map((m) => m.id)).toEqual([untouched.id]);
    expect(store.getEvents(renewed.id).some((e) => e.kind === 'renew')).toBe(true);
  });

  it('never flags: fresh, archived, session-scoped, or revision-targeted memories', async () => {
    const store = freshStore();
    const archived = store.create({ content: 'a', scope: 'personal', type: 'fact' }, { actor: 'user' });
    store.archive(archived.id, { actor: 'user' });
    store.create({ content: 's', scope: 'session', sessionId: 'chat-1', type: 'fact' }, { actor: 'user' });
    const targeted = store.create({ content: 't', scope: 'personal', type: 'fact' }, { actor: 'user' });
    await Bun.sleep(5);
    const boundary = new Date().toISOString();
    await Bun.sleep(5);
    store.createRevisionProposal({ content: 't2', scope: 'personal', type: 'fact' }, targeted.id, { actor: 'system' });
    store.create({ content: 'f', scope: 'personal', type: 'fact' }, { actor: 'user' }); // fresh: created inside the window

    // Only `targeted` predates the boundary without freshness — and its open
    // revision keeps it out of the stale lane. Nothing may be flagged.
    expect(store.listExpired({ boundaryTs: boundary })).toEqual([]);
  });

  it('scopes project memories to the queried project; personal always in scope', async () => {
    const store = freshStore();
    const mine = store.create({ content: 'p', scope: 'project', projectId: 'A', type: 'fact' }, { actor: 'user' });
    const other = store.create({ content: 'q', scope: 'project', projectId: 'B', type: 'fact' }, { actor: 'user' });
    const personal = store.create({ content: 'g', scope: 'personal', type: 'fact' }, { actor: 'user' });
    await Bun.sleep(5);
    const boundary = new Date().toISOString();

    const expired = store.listExpired({ boundaryTs: boundary, projectId: 'A' }).map((m) => m.id);
    expect(expired).toContain(mine.id);
    expect(expired).toContain(personal.id);
    expect(expired).not.toContain(other.id);
  });

  it('listOpenRevisions pairs pending proposals with active targets and respects the project filter', () => {
    const store = freshStore();
    const target = store.create({ content: 'old', scope: 'project', projectId: 'A', type: 'constraint' }, { actor: 'user' });
    const proposal = store.createRevisionProposal(
      { content: 'new', scope: 'project', projectId: 'A', type: 'constraint' },
      target.id,
      { actor: 'system' },
    )!;

    const open = store.listOpenRevisions('A');
    expect(open).toHaveLength(1);
    expect(open[0]!.proposal.id).toBe(proposal.id);
    expect(open[0]!.target.id).toBe(target.id);
    expect(store.listOpenRevisions('B')).toHaveLength(0);

    store.dismissCandidate(proposal.id, { actor: 'user' });
    expect(store.listOpenRevisions('A')).toHaveLength(0);
  });

  it('renewMemory throws on a missing id', () => {
    const store = freshStore();
    expect(() => store.renewMemory('M-404', { actor: 'user' })).toThrow('Memory not found');
  });
});

describe('revertAutoAccept (delegating/Auto mode inverse)', () => {
  it('refuses to turn a born-active memory into a Candidate', () => {
    const store = freshStore();
    const active = store.create({ content: 'Created as saved memory', scope: 'personal', type: 'fact' }, { actor: 'user' });

    expect(() => store.revertAutoAccept(active.id, { actor: 'user' })).toThrow('was not accepted from a Candidate review');
    expect(store.getById(active.id)!.status).toBe('active');
  });

  it('puts an auto-accepted plain candidate back into the review lane', () => {
    const store = freshStore();
    const c = store.create({ content: 'x', scope: 'personal', type: 'fact', status: 'candidate' }, { actor: 'agent' });
    store.update(c.id, { status: 'active' }, { actor: 'system' });

    const { reverted, restored } = store.revertAutoAccept(c.id, { actor: 'user' });
    expect(reverted.status).toBe('candidate');
    expect(restored).toBeNull();
    // Both status transitions are in the event log — nothing is erased.
    const statusEvents = store.getEvents(c.id).filter((e) => e.kind === 'status');
    expect(statusEvents.length).toBeGreaterThanOrEqual(2);
  });

  it('reverting an auto-accepted revision also resurrects its archived target — atomically', () => {
    const store = freshStore();
    const target = store.create({ content: 'port 3000', scope: 'personal', type: 'constraint' }, { actor: 'user' });
    const proposal = store.createRevisionProposal(
      { content: 'port 4000', scope: 'personal', type: 'constraint' },
      target.id,
      { actor: 'system' },
    )!;
    store.acceptRevision(proposal.id, { actor: 'system' });
    expect(store.getById(target.id)!.status).toBe('archived');

    const { reverted, restored } = store.revertAutoAccept(proposal.id, { actor: 'user' });
    expect(reverted.status).toBe('candidate');
    expect(restored?.id).toBe(target.id);
    expect(store.getById(target.id)!.status).toBe('active');
    // The proposal is pending again — the review lane can re-decide it.
    expect(store.hasOpenRevision(target.id)).toBe(true);
  });

  it('refuses to revert a non-active memory', () => {
    const store = freshStore();
    const c = store.create({ content: 'x', scope: 'personal', type: 'fact', status: 'candidate' }, { actor: 'agent' });
    expect(() => store.revertAutoAccept(c.id, { actor: 'user' })).toThrow('Only an active memory');
    expect(() => store.revertAutoAccept('M-404', { actor: 'user' })).toThrow('Memory not found');
  });

  it('refuses the one-click revert once the user edited the item after the auto-accept', () => {
    const store = freshStore();
    const c = store.create({ content: 'auto text', scope: 'personal', type: 'fact', status: 'candidate' }, { actor: 'agent' });
    store.update(c.id, { status: 'active' }, { actor: 'system' });
    store.update(c.id, { content: 'USER_EDIT_AFTER_AUTO' }, { actor: 'user' });

    expect(() => store.revertAutoAccept(c.id, { actor: 'user' })).toThrow('edited after the auto-accept');
    // The user's newer text survives untouched.
    expect(store.getById(c.id)!.content).toBe('USER_EDIT_AFTER_AUTO');
    expect(store.getById(c.id)!.status).toBe('active');
  });
});
