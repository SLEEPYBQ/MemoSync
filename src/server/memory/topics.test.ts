import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applySchema, openMemoryDb } from './db';
import { MemoryStore } from './MemoryStore';

const actor = { actor: 'user' as const };
const databases: Database[] = [];
const dirs: string[] = [];
function open(path = ':memory:') {
  const db = openMemoryDb(path);
  databases.push(db);
  return { db, store: new MemoryStore(db) };
}
afterEach(() => {
  for (const db of databases.splice(0)) { try { db.close(); } catch {} }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('user memory topics', () => {
  it('reuses normalized names and preserves empty topics across restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'topic-tests-')); dirs.push(dir);
    const path = join(dir, 'memory.sqlite');
    const { db, store } = open(path);
    const topic = store.createTopic('  TeST e\u0301  ');
    expect(store.createTopic('test é').id).toBe(topic.id);
    expect(topic.name).toBe('TeST é');
    expect(() => store.createTopic('  ')).toThrow();
    db.close();
    expect(open(path).store.listTopics()).toEqual([{ ...topic, count: 0 }]);
  });

  it('classifies without changing review, scope, content version or timestamps', () => {
    const { store } = open();
    const candidate = store.create({ content: 'Synthetic test rule', topic: 'legacy', scope: 'project', projectId: 'test-project', type: 'fact', status: 'candidate', sensitive: true }, actor);
    const topic = store.createTopic('Testing');
    const updated = store.assignTopic(candidate.id, topic.id, actor);
    expect(updated).toEqual({ ...candidate, topicId: topic.id, topicName: topic.name });
    expect(store.getEvents(candidate.id).at(-1)).toMatchObject({ kind: 'classify', changes: { userTopic: { before: null, after: 'Testing' } } });
    expect(store.getEvents(candidate.id).at(-1)!.snapshot).toBeUndefined();
    store.assignTopic(candidate.id, topic.id, actor);
    expect(store.getEvents(candidate.id)).toHaveLength(2);
    store.assignTopic(candidate.id, null, actor);
    expect(store.listTopics()[0].count).toBe(0);
  });

  it('renames and deletes associations without deleting memories or changing versions', () => {
    const { store } = open();
    const a = store.create({ content: 'Synthetic rule', scope: 'personal', type: 'fact' }, actor);
    const topic = store.createTopic('First');
    store.assignTopic(a.id, topic.id, actor);
    const other = store.createTopic('Other');
    expect(() => store.renameTopic(topic.id, other.name, actor)).toThrow();
    store.renameTopic(topic.id, 'Renamed', actor);
    expect(store.getById(a.id)).toMatchObject({ topicId: topic.id, topicName: 'Renamed', version: 1 });
    expect(store.deleteTopic(topic.id, actor)).toEqual({ id: topic.id, count: 1 });
    expect(store.getById(a.id)).toEqual(a);
    expect(store.listTopics()).toEqual([other]);
  });

  it('rejects dismissed and missing items and preserves classification on content rollback', () => {
    const { store } = open();
    const a = store.create({ content: 'Synthetic version one', scope: 'personal', type: 'fact' }, actor);
    const seq = store.getEvents(a.id)[0].seq;
    const topic = store.createTopic('Testing');
    store.update(a.id, { content: 'Synthetic version two' }, actor);
    store.assignTopic(a.id, topic.id, actor);
    store.rollback(a.id, seq, actor);
    expect(store.getById(a.id)).toMatchObject({ content: a.content, topicId: topic.id });
    const rejected = store.create({ content: 'Synthetic rejected rule', scope: 'personal', type: 'fact', status: 'candidate' }, actor);
    store.dismissCandidate(rejected.id, actor);
    expect(() => store.assignTopic(rejected.id, topic.id, actor)).toThrow();
    expect(() => store.assignTopic('M-missing', topic.id, actor)).toThrow();
    expect(() => store.assignTopic(a.id, 'missing-topic', actor)).toThrow();
    expect(store.list({ topicId: topic.id, status: 'active', scope: 'personal' }).map(m => m.id)).toEqual([a.id]);
    expect(store.list({ topicId: null }).map(m => m.id)).toContain(rejected.id);
  });

  it('leaves old memories unclassified while retaining legacy topic data', () => {
    const { db, store } = open();
    const a = store.create({ content: 'Synthetic old rule A', topic: '  Testing ', scope: 'personal', type: 'fact' }, actor);
    const b = store.create({ content: 'Synthetic old rule B', topic: 'testing', scope: 'personal', type: 'fact' }, actor);
    const sensitive = store.create({ content: 'Synthetic private draft', topic: 'Private label', sensitive: true, status: 'candidate', scope: 'personal', type: 'fact' }, actor);
    // Recreate the pre-feature layout without reading any real user database.
    db.exec('DROP INDEX IF EXISTS idx_memories_topic; ALTER TABLE memories DROP COLUMN topic_id; DROP TABLE memory_topics;');
    applySchema(db);
    expect(store.listTopics()).toEqual([]);
    expect(store.getById(a.id)).toEqual(a);
    expect(store.getById(b.id)).toEqual(b);
    expect(store.getById(sensitive.id)).toEqual(sensitive);
    applySchema(db);
    expect(store.listTopics()).toEqual([]);
    expect(store.getById(a.id)?.topic).toBe('  Testing ');
    expect(store.getById(a.id)?.topicId).toBeUndefined();
  });
});

it('does not bypass durable dismissal evidence or keep sensitive history after erasure', () => {
  const { db, store } = open();
  const topic = store.createTopic('Synthetic catalog');
  const privateDraft = store.create({ content: 'Synthetic sensitive candidate', sensitive: true, status: 'candidate', scope: 'personal', type: 'fact' }, actor);
  store.assignTopic(privateDraft.id, topic.id, actor);
  store.dismissCandidateByPolicy(privateDraft.id, actor);
  expect(store.getById(privateDraft.id)).toBeNull();
  expect(store.getEvents(privateDraft.id)).toEqual([]);
  expect(store.listTopics()[0].count).toBe(0);
  expect(() => store.assignTopic(privateDraft.id, topic.id, actor)).toThrow();
  const rejected = store.create({ content: 'Synthetic legacy rejection', status: 'candidate', scope: 'personal', type: 'fact' }, actor);
  store.dismissCandidate(rejected.id, actor);
  db.query("UPDATE memories SET status = 'archived' WHERE id = ?").run(rejected.id);
  expect(() => store.assignTopic(rejected.id, topic.id, actor)).toThrow();
  expect(store.getById(rejected.id)?.status).toBe('archived');
});

it('rolls back classification if its history cannot be written', () => {
  const { db, store } = open();
  const item = store.create({ content: 'Synthetic atomic classification', scope: 'personal', type: 'fact' }, actor);
  const topic = store.createTopic('Synthetic catalog');
  db.exec(`CREATE TRIGGER reject_classification BEFORE INSERT ON memory_events
    WHEN NEW.kind = 'classify' BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END;`);
  expect(() => store.assignTopic(item.id, topic.id, actor)).toThrow('synthetic write failure');
  expect(store.getById(item.id)).toEqual(item);
  expect(store.getEvents(item.id)).toHaveLength(1);
  expect(store.getTopic(topic.id)?.count).toBe(0);
});


it('classification and catalog edits do not renew expired memories', () => {
  const { db, store } = open();
  const item = store.create({ content: 'Synthetic stale rule', scope: 'personal', type: 'fact' }, actor);
  db.query("UPDATE memories SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(item.id);
  db.query("UPDATE memory_events SET ts = '2020-01-01T00:00:00.000Z' WHERE memory_id = ?").run(item.id);
  const topic = store.createTopic('Synthetic catalog');
  const expired = () => store.listExpired({ boundaryTs: '2021-01-01T00:00:00.000Z' }).map(m => m.id);
  expect(expired()).toContain(item.id);
  store.assignTopic(item.id, topic.id, actor);
  expect(expired()).toContain(item.id);
  store.renameTopic(topic.id, 'Renamed catalog', actor);
  expect(expired()).toContain(item.id);
  store.deleteTopic(topic.id, actor);
  expect(expired()).toContain(item.id);
});

it('preserves existing assignments while creating and moving nested topics safely', () => {
  const { db, store } = open();
  const root = store.createTopic('Root');
  const item = store.create({ content: 'Synthetic rule', scope: 'personal', type: 'fact' }, actor);
  store.assignTopic(item.id, root.id, actor);
  const child = store.createTopic('Child', root.id);
  expect(child.parentId).toBe(root.id);
  expect(() => store.moveTopic(root.id, child.id, actor)).toThrow();
  expect(() => store.moveTopic(child.id, 'missing', actor)).toThrow();
  expect(store.moveTopic(child.id, null, actor).parentId).toBeNull();
  applySchema(db);
  expect(store.getById(item.id)?.topicId).toBe(root.id);
  expect(store.getTopic(child.id)?.parentId).toBeNull();
});

it('inherits topic for revision candidates while respecting later user changes', () => {
  const { store } = open();
  const topic = store.createTopic('Synthetic category');
  const other = store.createTopic('Other category');
  const original = store.create({ content: 'Synthetic original', scope: 'personal', type: 'fact' }, actor);
  store.assignTopic(original.id, topic.id, actor);
  const revision = store.createRevisionProposal({ content: 'Synthetic revision', scope: 'personal', type: 'fact' }, original.id, { actor: 'agent' })!;
  expect(revision.topicId).toBe(topic.id);
  expect(revision.status).toBe('candidate');
  store.assignTopic(revision.id, other.id, actor);
  expect(store.acceptRevision(revision.id, actor).updated.topicId).toBe(other.id);
});

it('records and safely undoes topic moves without overwriting later changes', () => {
  const { store } = open();
  const root = store.createTopic('Root');
  const other = store.createTopic('Other');
  const child = store.createTopic('Child');
  store.moveTopic(child.id, root.id, actor);
  const first = store.listTopicOperations()[0];
  expect(first).toMatchObject({ kind: 'move', topicId: child.id, actor: 'user' });
  store.moveTopic(child.id, other.id, actor);
  expect(() => store.undoTopicOperation(first.id, actor)).toThrow();
  const latest = store.listTopicOperations()[0];
  store.undoTopicOperation(latest.id, actor);
  expect(store.getTopic(child.id)?.parentId).toBe(root.id);
});
