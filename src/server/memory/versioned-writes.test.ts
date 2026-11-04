import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryService } from './index';
import { createCaptureService } from './capture';
import { computeMemoryTurnDelta, planMemoryInjection } from './injection';
import { buildMemoryToolSpecs, dispatchMemoryTool } from './tools';
import type { MemoryItem } from './types';
import type { LlmJsonCaller } from './deepseek';

// Adapted from the research boundary reproductions. All records and Router
// responses are synthetic; these tests exercise real SQLite and memory tools.
let dir: string;
let memory: MemoryService;
let services: MemoryService[];
const meta = { actor: 'user' as const };
const context = { projectId: 'P1', sessionId: 'chat', turn: 1 };
const proposal = { content: 'Use isolated fixtures for protocol tests.', scope: 'project', type: 'constraint' };
const routeNew: LlmJsonCaller = async () => ({ decisions: [{ index: 0, route: 'new', targetId: null }] });
function open(dbPath = join(dir, 'memory.sqlite')) {
  const service = new MemoryService({ dbPath, dataDir: join(dir, `data-${services.length}`) });
  services.push(service);
  return service;
}
function item(content: string, extra: Partial<MemoryItem> = {}) {
  return memory.store.create({ content, scope: 'project', projectId: 'P1', type: 'constraint', ...extra }, meta);
}
function plan(restrictToIds?: string[]) {
  return planMemoryInjection({ memory, projectId: 'P1', chatId: 'chat', restrictToIds });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memory-versioned-'));
  services = [];
  memory = open();
});
afterEach(() => {
  for (const service of services) {
    try { service.close(); } catch { /* A restart test already closed this handle. */ }
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('semantic views and detail grants', () => {
  test('relations alone change the view and delta; use, reinforcement and selection order stay canonical', () => {
    const a = item('Use local fixtures.', { detail: 'No real upstream requests.' });
    const b = item('Keep reports reproducible.');
    const before = plan();
    expect(plan([b.id, a.id, a.id]).block).toBe(before.block);
    memory.store.recordUse(a.id, { actor: 'agent', via: 'citation' });
    memory.store.recordReinforce(a.id, { actor: 'agent' });
    memory.store.recordTraceLabel(a.id, 'operational', { actor: 'system' });
    expect(plan().hash).toBe(before.hash);
    memory.store.addRelation(a.id, b.id, 'conflicts_with');
    const changed = plan();
    expect(changed.hash).not.toBe(before.hash);
    expect(changed.view.versions).toEqual(before.view.versions);
    const delta = computeMemoryTurnDelta({ memory, projectId: 'P1', chatId: 'chat', baseline: before.baseline });
    expect(delta.block).toContain('(view changed)');
    expect(delta.block).toContain(`conflicts with [${b.id}]`);
    expect(delta.block).toContain(`conflicts with [${a.id}]`);
    expect(computeMemoryTurnDelta({ memory, projectId: 'P1', chatId: 'chat', baseline: delta.nextBaseline }).block).toBe('');
    memory.db.query('DELETE FROM memory_relations').run();
    const cleared = computeMemoryTurnDelta({ memory, projectId: 'P1', chatId: 'chat', baseline: delta.nextBaseline });
    expect(cleared.block).toContain('no unresolved conflicts in this view');
    expect(plan().hash).toBe(before.hash);
  });

  test('version-only baselines receive one semantic refresh and then become quiet', () => {
    const a = item('Only use fixtures.');
    const b = item('Keep reports reproducible.');
    const legacy = new Map(plan().bakedMemories.map(record => [record.id, record.version]));
    memory.store.addRelation(a.id, b.id, 'conflicts_with');
    const refreshed = computeMemoryTurnDelta({ memory, projectId: 'P1', chatId: 'chat', baseline: legacy });
    expect(refreshed.block).toContain('conflicts with');
    expect(computeMemoryTurnDelta({ memory, projectId: 'P1', chatId: 'chat', baseline: refreshed.nextBaseline }).block).toBe('');
  });

  test('non-conflict relations and endpoint state also invalidate the view', () => {
    const a = item('Keep independent source records.');
    const b = item('Keep derived records traceable.', { status: 'candidate' });
    const before = plan();
    memory.store.addRelation(b.id, a.id, 'derived_from');
    const linked = plan();
    expect(linked.hash).not.toBe(before.hash);
    expect(computeMemoryTurnDelta({ memory, projectId: 'P1', chatId: 'chat', baseline: before.baseline }).block).toContain('(view changed)');
    memory.store.update(b.id, { status: 'active' }, meta);
    expect(plan().hash).not.toBe(linked.hash);
  });

  test('scope, state, selection and exclusions change view membership', () => {
    const a = item('Project A rule.');
    const b = item('Shared rule.', { scope: 'personal', projectId: undefined });
    const all = plan();
    expect(plan([a.id]).view.revision).not.toBe(all.view.revision);
    memory.store.setSessionExclusions('chat', [a.id]);
    const excluded = plan();
    expect(excluded.view.selectedIds).toEqual([b.id]);
    expect(excluded.hash).not.toBe(all.hash);
    memory.store.setSessionExclusions('chat', []);
    memory.store.update(a.id, { projectId: 'P2' }, meta);
    expect(plan().view.selectedIds).toEqual([b.id]);
    memory.store.archive(b.id, meta);
    expect(plan().view.selectedIds).toEqual([]);
  });

  test('successful details carry the actual version, view and body digest', async () => {
    const a = item('Only use fixtures.', { detail: 'Make a fresh SQLite database.' });
    const admitted = plan([a.id]);
    const result = await dispatchMemoryTool(buildMemoryToolSpecs(memory), 'load_memory_detail',
      { ids: [a.id], expectedVersion: 1, expectedViewRevision: admitted.view.revision },
      { ...context, allowedMemoryIds: [a.id], memoryView: admitted.view });
    expect(result.text).toContain(`[${a.id} v1]`);
    expect(result.text).toContain(a.detail!);
    expect(result.receipts).toEqual([{ memoryId: a.id, version: 1, viewRevision: admitted.view.revision,
      contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
  });

  test('a mid-turn detail edit cannot silently cross versions or override the server grant', async () => {
    const a = item('Only use fixtures.', { detail: 'Revision one.' });
    const admitted = plan([a.id]);
    memory.store.update(a.id, { detail: 'Revision two.' }, meta);
    const result = await dispatchMemoryTool(buildMemoryToolSpecs(memory), 'load_memory_detail',
      { ids: [a.id], expectedVersion: 2 }, { ...context, memoryView: admitted.view, allowedMemoryIds: [a.id] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('VERSION_CHANGED');
    expect(result.text).not.toContain('Revision two.');
    expect(memory.store.getEvents(a.id).filter(event => event.kind === 'use')).toHaveLength(0);
  });

  test('relation changes reject old detail grants even when content versions match', async () => {
    const a = item('Only use fixtures.', { detail: 'Do not call live providers.' });
    const b = item('Use a protocol stub.');
    const admitted = plan();
    memory.store.addRelation(a.id, b.id, 'conflicts_with');
    const result = await dispatchMemoryTool(buildMemoryToolSpecs(memory), 'load_memory_detail', { ids: [a.id] },
      { ...context, memoryView: admitted.view });
    expect(result.text).toContain('VIEW_CHANGED');
    expect(result.text).not.toContain(a.detail!);
    expect(result.receipts).toEqual([]);
  });

  for (const revoke of ['archive', 'exclude', 'rescope', 'deselect', 'wrong-owner'] as const) {
    test(`a ${revoke} change denies details from an earlier grant`, async () => {
      const a = item('Protected rule.', { detail: 'Private detail must not leak.' });
      const admitted = plan();
      if (revoke === 'archive') memory.store.archive(a.id, meta);
      if (revoke === 'exclude') memory.store.setSessionExclusions('chat', [a.id]);
      if (revoke === 'rescope') memory.store.update(a.id, { projectId: 'P2' }, meta);
      const result = await dispatchMemoryTool(buildMemoryToolSpecs(memory), 'load_memory_detail', { ids: [a.id] },
        { ...context, projectId: revoke === 'wrong-owner' ? 'P2' : 'P1', memoryView: admitted.view,
          allowedMemoryIds: revoke === 'deselect' ? [] : [a.id] });
      expect(result.text).not.toContain(a.detail!);
      expect(memory.store.getEvents(a.id).filter(event => event.kind === 'use')).toHaveLength(0);
    });
  }

  test('detail calls without a server grant fail closed despite model-supplied ids or versions', async () => {
    const a = item('Protected rule.', { detail: 'Do not leak this detail.' });
    const admitted = plan();
    const result = await dispatchMemoryTool(buildMemoryToolSpecs(memory), 'load_memory_detail',
      { ids: [a.id], expectedVersion: 1, expectedViewRevision: admitted.view.revision },
      { ...context, allowedMemoryIds: [a.id] });
    expect(result.text).toContain('VIEW_CHANGED');
    expect(result.text).not.toContain(a.detail!);
    expect(result.isError).toBe(true);
  });

  test('detail grants still enforce project and session boundaries', async () => {
    const other = item('Other project.', { projectId: 'P2', detail: 'Other project detail.' });
    const anotherChat = item('Other chat.', { scope: 'session', projectId: undefined, sessionId: 'another', detail: 'Other chat detail.' });
    const result = await dispatchMemoryTool(buildMemoryToolSpecs(memory), 'load_memory_detail',
      { ids: [other.id, anotherChat.id] }, { ...context, allowedMemoryIds: [other.id, anotherChat.id], memoryView: plan().view });
    expect(result.text).not.toContain('Other project detail.');
    expect(result.text).not.toContain('Other chat detail.');
  });
});

describe('durable capture operations', () => {
  for (const engine of ['claude', 'codex', 'pi', 'opencode']) {
    test(`${engine}: concurrent services and restart retries commit and notify only once`, async () => {
      const second = open();
      let release!: () => void;
      const blocked = new Promise<void>(resolve => { release = resolve; });
      let calls = 0;
      const router: LlmJsonCaller = async () => {
        calls++;
        await blocked;
        return { decisions: [{ index: 0, route: 'new', targetId: null }] };
      };
      let notifications = 0;
      const specs = (service: MemoryService) => buildMemoryToolSpecs(service, {
        capture: createCaptureService({ memory: service, callJson: router }),
        onProposed: () => { notifications++; },
      });
      const firstWrite = dispatchMemoryTool(specs(memory), 'propose_memory', proposal, { ...context, engine });
      const secondWrite = dispatchMemoryTool(specs(second), 'propose_memory', proposal, { ...context, engine });
      release();
      await Promise.all([firstWrite, secondWrite]);
      expect(calls).toBe(2); // each service routed before either committed
      expect(memory.store.list({ status: 'candidate' })).toHaveLength(1);
      expect(memory.db.query('SELECT * FROM memory_capture_operations').all()).toHaveLength(1);
      expect(notifications).toBe(1);
      memory.close();
      second.close();
      memory = open();
      const retry = await dispatchMemoryTool(specs(memory), 'propose_memory', proposal, { ...context, engine });
      expect(retry.text).toContain('Already handled earlier this turn');
      expect(calls).toBe(2);
      expect(notifications).toBe(1);
      expect(memory.store.list({ status: 'candidate' })).toHaveLength(1);
    });
  }

  test('automatic acceptance receipts use persisted status, and retry does not notify again', async () => {
    let notifications = 0;
    const specs = buildMemoryToolSpecs(memory, {
      capture: createCaptureService({ memory, callJson: routeNew }),
      onProposed: created => {
        notifications++;
        for (const candidate of created) memory.store.update(candidate.id, { status: 'active' }, { actor: 'system' });
      },
    });
    const result = await dispatchMemoryTool(specs, 'propose_memory', proposal, { ...context, engine: 'pi' });
    expect(result.text).toContain('accepted and active');
    expect(result.text).not.toContain('NOT active yet');
    await dispatchMemoryTool(specs, 'propose_memory', proposal, { ...context, engine: 'pi' });
    expect(notifications).toBe(1);
  });

  test('a lost callback response after auto-acceptance cannot apply or notify twice', async () => {
    let notifications = 0;
    const specs = buildMemoryToolSpecs(memory, {
      capture: createCaptureService({ memory, callJson: routeNew }),
      onProposed: created => {
        notifications++;
        memory.store.update(created[0]!.id, { status: 'active' }, { actor: 'system' });
        throw new Error('synthetic lost callback response');
      },
    });
    await expect(dispatchMemoryTool(specs, 'propose_memory', proposal, context)).rejects.toThrow('synthetic lost callback response');
    const retry = await dispatchMemoryTool(specs, 'propose_memory', proposal, context);
    expect(retry.text).toContain('is active');
    expect(notifications).toBe(1);
    expect(memory.store.list({ status: 'active' })).toHaveLength(1);
  });

  test('committed operation ids are not reused when an unshown candidate is erased', async () => {
    const capture = createCaptureService({ memory, callJson: routeNew });
    const first = await capture.routeProposal(proposal, context);
    const id = first!.created[0]!.id;
    memory.store.eraseCandidate(id);
    const unrelated = item('An unrelated rule.');
    expect(unrelated.id).not.toBe(id);
    expect(() => item('Do not reuse the operation id.', { id })).toThrow('committed operation');
    const retry = await capture.routeProposal(proposal, context);
    expect(retry?.created).toHaveLength(0);
    expect(retry?.sameTurnDuplicates).toEqual([{ memoryId: id }]);
  });

  test('a dismissal during Routing is revalidated in the commit transaction', async () => {
    const pending = item(proposal.content, { status: 'candidate' });
    const capture = createCaptureService({ memory, callJson: async () => {
      memory.store.dismissCandidate(pending.id, meta);
      return { decisions: [{ index: 0, route: 'new', targetId: null }] };
    } });
    const outcome = await capture.routeProposal(proposal, context);
    expect(outcome?.created).toHaveLength(0);
    expect(memory.store.list({ status: 'candidate' })).toHaveLength(0);
  });

  for (const patch of [{ detail: 'Updated detail.' }, { projectId: 'P2' }, { scope: 'personal' as const }]) {
    test(`target CAS covers ${Object.keys(patch)[0]} changes beyond the short text`, async () => {
      const target = item('Old policy.');
      const capture = createCaptureService({ memory, callJson: async () => {
        memory.store.update(target.id, patch, meta);
        return { decisions: [{ index: 0, route: 'updates', targetId: target.id }] };
      } });
      const outcome = await capture.routeProposal(proposal, context);
      expect(outcome?.created).toHaveLength(1);
      expect(memory.store.getRelations(outcome!.created[0]!.id)).toEqual([]);
      expect(memory.store.getById(target.id)?.reinforcedCount).toBe(0);
    });
  }

  test('a session reinforcement target cannot absorb a project proposal or report it already stored', async () => {
    const session = item(proposal.content, { scope: 'session', projectId: undefined, sessionId: context.sessionId });
    let calls = 0;
    const capture = createCaptureService({ memory, callJson: async request => {
      calls++;
      expect(request.user).toContain(`"id": "${session.id}"`);
      expect(request.user).toContain('"scope": "session"');
      expect(request.user).toContain('"sessionId": "chat"');
      expect(request.user).toContain('"scope": "project"');
      expect(request.user).toContain('"projectId": "P1"');
      return { decisions: [{ index: 0, route: 'reinforces', targetId: session.id }] };
    } });
    const notifications: MemoryItem[][] = [];
    const specs = buildMemoryToolSpecs(memory, { capture, onProposed: created => { notifications.push(created); } });
    const result = await dispatchMemoryTool(specs, 'propose_memory', proposal, context);
    expect(result.text).toContain('awaits the user\'s review');
    expect(result.text).not.toContain('Already stored');
    const projects = memory.store.list({ scope: 'project', projectId: 'P1', status: 'candidate' });
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ content: proposal.content, scope: 'project', projectId: 'P1' });
    expect(projects[0]?.sessionId).toBeUndefined();
    expect(memory.store.getById(session.id)).toMatchObject({ scope: 'session', sessionId: 'chat', reinforcedCount: 0 });
    expect(notifications).toEqual([projects]);
    const retry = await dispatchMemoryTool(specs, 'propose_memory', proposal, context);
    expect(retry.text).toContain('Already handled earlier this turn');
    expect(calls).toBe(1);
    expect(notifications).toHaveLength(1);
    expect(memory.store.list({ scope: 'project', projectId: 'P1' })).toHaveLength(1);
  });

  test('scope owners are part of same-turn identity, including project-to-session fallback', async () => {
    const capture = createCaptureService({ memory, callJson: routeNew });
    await capture.routeProposal(proposal, context);
    await capture.routeProposal(proposal, { ...context, projectId: 'P2' });
    const fallback = await capture.routeProposal(proposal, { ...context, projectId: undefined });
    expect(fallback?.created[0]).toMatchObject({ scope: 'session', sessionId: 'chat' });
    expect(memory.store.list({ status: 'candidate' })).toHaveLength(3);
    const retry = await capture.routeProposal({ ...proposal, scope: 'session' }, { ...context, projectId: undefined });
    expect(retry?.sameTurnDuplicates).toHaveLength(1);
  });

  test('failed relation writes roll back the item and operation before a clean retry', async () => {
    const target = item('Competing policy.');
    const capture = createCaptureService({ memory, callJson: async () => ({
      decisions: [{ index: 0, route: 'conflicts', targetId: target.id }],
    }) });
    memory.db.exec(`CREATE TRIGGER fail_relation BEFORE INSERT ON memory_relations
      BEGIN SELECT RAISE(ABORT, 'synthetic relation failure'); END`);
    await expect(capture.routeProposal(proposal, context)).rejects.toThrow('synthetic relation failure');
    expect(memory.store.list({ status: 'candidate' })).toHaveLength(0);
    expect(memory.db.query('SELECT * FROM memory_capture_operations').all()).toHaveLength(0);
    memory.db.exec('DROP TRIGGER fail_relation');
    const retry = await capture.routeProposal(proposal, context);
    expect(retry?.created).toHaveLength(1);
    expect(memory.db.query('SELECT * FROM memory_capture_operations').all()).toHaveLength(1);
  });

  test('reworded same-turn reinforcement is persistent across service recreation', async () => {
    const target = item('Use isolated tests.');
    const router: LlmJsonCaller = async () => ({ decisions: [{ index: 0, route: 'reinforces', targetId: target.id }] });
    await createCaptureService({ memory, callJson: router }).routeProposal(proposal, context);
    const retry = await createCaptureService({ memory, callJson: router }).routeProposal({ ...proposal, content: 'Keep all tests isolated.' }, context);
    expect(retry?.reinforced).toBe(0);
    expect(retry?.sameTurnDuplicates).toHaveLength(1);
    expect(memory.store.getById(target.id)?.reinforcedCount).toBe(1);
  });
});

describe('Markdown negative decisions and compatibility', () => {
  test('Markdown import and capture share scoped dismissal policy', async () => {
    const rejected = item(proposal.content, { status: 'candidate' });
    memory.store.dismissCandidate(rejected.id, meta);
    expect(memory.importMarkdown(`- ${proposal.content}`, { scope: 'project', projectId: 'P1' })).toEqual({ created: [], skipped: 1 });
    const capture = createCaptureService({ memory, callJson: routeNew });
    expect((await capture.routeProposal(proposal, context))?.created).toHaveLength(0);
    expect(memory.importMarkdown(`- ${proposal.content}`, { scope: 'project', projectId: 'P2' }).created).toHaveLength(1);
    expect(memory.importMarkdown(`- ${proposal.content}`, { scope: 'personal' }).created).toHaveLength(1);
  });

  test('archived claims and hard-erased sensitive claims cannot reappear through import', () => {
    const archived = item('Use an expired release process.');
    memory.store.archive(archived.id, meta);
    const sensitive = item('A private policy.', { sensitive: true, status: 'candidate' });
    memory.store.discardCandidate(sensitive.id);
    expect(memory.importMarkdown(`- ${archived.content}\n- ${sensitive.content}`, { scope: 'project', projectId: 'P1' }))
      .toEqual({ created: [], skipped: 2 });
    expect(memory.importMarkdown(`- ${sensitive.content}`, { scope: 'project', projectId: 'P2' }).created).toHaveLength(1);
  });

  test('archive then History rollback permits a proposal without lifting other negative decisions', async () => {
    const target = item(proposal.content);
    const activeSeq = memory.store.getEvents(target.id)[0]!.seq;
    const otherOwner = item(proposal.content, { projectId: 'P2' });
    memory.store.archive(otherOwner.id, meta);
    const otherRevocation = memory.db.query('SELECT * FROM memory_revocations WHERE memory_id = ?').get(otherOwner.id);
    const rejected = item('Keep a rejected fixture policy.', { status: 'candidate' });
    const otherRejection = item(proposal.content, { projectId: 'P3', status: 'candidate' });
    memory.store.dismissCandidate(rejected.id, meta);
    memory.store.dismissCandidate(otherRejection.id, meta);
    const tombstones = memory.db.query('SELECT * FROM dismissed_candidate_fingerprints ORDER BY memory_id').all();
    const owner = { scope: 'project' as const, projectId: 'P1' };
    memory.store.archive(target.id, meta);
    expect(memory.store.wasMemorySuppressed(proposal.content, owner)).toBe(true);

    memory.db.exec(`CREATE TRIGGER fail_history_revert BEFORE INSERT ON memory_events WHEN NEW.kind = 'revert'
      BEGIN SELECT RAISE(ABORT, 'synthetic history failure'); END`);
    expect(() => memory.store.rollback(target.id, activeSeq, meta)).toThrow('synthetic history failure');
    expect(memory.store.getById(target.id)?.status).toBe('archived');
    expect(memory.db.query('SELECT 1 FROM memory_revocations WHERE memory_id = ?').get(target.id)).not.toBeNull();
    memory.db.exec('DROP TRIGGER fail_history_revert');

    expect(memory.store.rollback(target.id, activeSeq, meta).status).toBe('active');
    expect(memory.store.wasMemorySuppressed(proposal.content, owner)).toBe(false);
    expect(memory.db.query('SELECT 1 FROM memory_revocations WHERE memory_id = ?').get(target.id)).toBeNull();
    expect(memory.db.query('SELECT * FROM memory_revocations WHERE memory_id = ?').get(otherOwner.id)).toEqual(otherRevocation);
    expect(memory.db.query('SELECT * FROM dismissed_candidate_fingerprints ORDER BY memory_id').all()).toEqual(tombstones);
    expect(memory.store.wasMemorySuppressed(proposal.content, { ...owner, projectId: 'P2' })).toBe(true);
    expect(memory.store.wasMemorySuppressed(proposal.content, { ...owner, projectId: 'P3' })).toBe(true);
    expect(memory.store.wasMemorySuppressed(rejected.content, owner)).toBe(true);

    let calls = 0;
    const capture = createCaptureService({ memory, callJson: async () => {
      calls++;
      return { decisions: [{ index: 0, route: 'reinforces', targetId: target.id }] };
    } });
    const result = await dispatchMemoryTool(buildMemoryToolSpecs(memory, { capture }), 'propose_memory', proposal, context);
    expect(calls).toBe(1);
    expect(result.text).toContain(`Already stored as [${target.id}]`);
    expect(memory.store.getById(target.id)?.reinforcedCount).toBe(1);
    expect(memory.store.list({ status: 'candidate' })).toHaveLength(0);
  });

  test('an import retry survives restart with one candidate and one operation', () => {
    const first = memory.importMarkdown(`- ${proposal.content}`, { scope: 'project', projectId: 'P1' });
    memory.close();
    memory = open();
    expect(memory.importMarkdown(`- ${proposal.content}`, { scope: 'project', projectId: 'P1' })).toEqual({ created: [], skipped: 1 });
    expect(memory.store.list({ status: 'candidate' }).map(record => record.id)).toEqual(first.created);
  });

  test('explicit unmuting permits a fresh import without duplicating the discarded history', () => {
    const source = `- ${proposal.content}`;
    const first = memory.importMarkdown(source, { scope: 'project', projectId: 'P1' });
    memory.store.dismissCandidate(first.created[0]!, meta);
    expect(memory.importMarkdown(source, { scope: 'project', projectId: 'P1' }).created).toEqual([]);
    expect(memory.store.unmuteProposal(first.created[0]!)).toBe(true);
    const retried = memory.importMarkdown(source, { scope: 'project', projectId: 'P1' });
    expect(retried.created).toHaveLength(1);
    expect(retried.created[0]).not.toBe(first.created[0]);
    expect(memory.store.getById(first.created[0]!)?.status).toBe('discarded');
  });

  test('a failed import rolls back all claims and identities before retry', () => {
    const source = '- First claim.\n- Second claim.';
    memory.db.exec(`CREATE TRIGGER fail_import BEFORE INSERT ON memories WHEN NEW.content = 'Second claim.'
      BEGIN SELECT RAISE(ABORT, 'synthetic import failure'); END`);
    expect(() => memory.importMarkdown(source, { scope: 'personal' })).toThrow('synthetic import failure');
    expect(memory.store.list()).toEqual([]);
    expect(memory.db.query('SELECT * FROM memory_capture_operations').all()).toEqual([]);
    memory.db.exec('DROP TRIGGER fail_import');
    expect(memory.importMarkdown(source, { scope: 'personal' }).created).toHaveLength(2);
  });

  test('old schemas preserve snapshots, trace events and dismissal records on migration', () => {
    const legacyPath = join(dir, 'legacy.sqlite');
    const legacy = new Database(legacyPath);
    legacy.exec(`
      CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT NOT NULL, scope TEXT NOT NULL,
        type TEXT NOT NULL, status TEXT NOT NULL, project_id TEXT, session_id TEXT, topic TEXT,
        provenance_session_id TEXT, provenance_turn INTEGER, usage_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO memories VALUES ('M-09', 'Legacy rule.', 'project', 'constraint', 'discarded', 'P1', NULL, NULL,
        NULL, NULL, 7, '2026-01-01', '2026-01-02');
      CREATE TABLE dismissed_candidate_fingerprints (memory_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, dismissed_at TEXT NOT NULL);
      INSERT INTO dismissed_candidate_fingerprints VALUES ('M-09', 'legacy-fingerprint', '2026-01-02');
      CREATE TABLE memory_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT NOT NULL, ts TEXT NOT NULL,
        kind TEXT NOT NULL, actor TEXT NOT NULL, session_id TEXT, turn INTEGER, changes TEXT, snapshot TEXT, meta TEXT);
      INSERT INTO memory_events VALUES (1, 'M-09', '2026-01-01', 'create', 'user', NULL, NULL, NULL, '{"content":"Legacy rule."}', NULL);
      INSERT INTO memory_events VALUES (2, 'M-09', '2026-01-02', 'trace', 'system', NULL, NULL, NULL, NULL, '{"label":"operational"}');
    `);
    legacy.close();
    const upgraded = open(legacyPath);
    expect(upgraded.store.getById('M-09')).toMatchObject({ version: 1, usageCount: 7, content: 'Legacy rule.' });
    expect(upgraded.store.getEvents('M-09')).toHaveLength(2);
    expect(upgraded.store.getEvents('M-09')[0]?.snapshot?.content).toBe('Legacy rule.');
    expect(upgraded.store.latestTraceLabels().get('M-09')).toBe('operational');
    expect(upgraded.db.query('SELECT scope, owner_id FROM dismissed_candidate_fingerprints').get())
      .toEqual({ scope: 'project', owner_id: 'P1' });
  });
});
