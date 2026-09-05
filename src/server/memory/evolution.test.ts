import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryService } from './index';
import { createRevisionService } from './evolution';
import type { DeepSeekJsonRequest, LlmJsonCaller } from './deepseek';

function stubCaller(responses: Array<Record<string, unknown>>): { call: LlmJsonCaller; calls: DeepSeekJsonRequest[] } {
  const calls: DeepSeekJsonRequest[] = [];
  const call: LlmJsonCaller = async (req) => {
    calls.push(req);
    const next = responses[calls.length - 1];
    if (!next) throw new Error(`stubCaller: no response queued for call #${calls.length}`);
    return next;
  };
  return { call, calls };
}

let dir: string;
let memory: MemoryService;

describe('revision service (DG4 propose-fixes drafting)', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memv2-revision-'));
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
  });
  afterEach(() => {
    memory.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function activeMemory(content: string) {
    return memory.store.create(
      { content, scope: 'project', projectId: 'RenderX', type: 'constraint' },
      { actor: 'user' },
    );
  }

  function traceTimes(id: string, label: 'violated' | 'injected_without_effect' | 'operational', times: number) {
    for (let i = 0; i < times; i++) {
      memory.store.recordTraceLabel(id, label, { actor: 'agent', turn: i + 1 });
    }
  }

  it('drafts a revision candidate after K consecutive violated traces, with evidence provenance', async () => {
    const target = activeMemory('Run tests with `npm test`');
    traceTimes(target.id, 'violated', 3);
    const revisedContent = `${Array.from({ length: 101 }, (_, index) => `revision${index + 1}`).join(' ')}.`;
    const { call, calls } = stubCaller([
      { action: 'revise', content: revisedContent, detail: 'The repo moved to bun.', reason: 'violated 3x' },
    ]);
    const svc = createRevisionService({ memory, callJson: call, streak: 3 });

    const created = await svc.scanAndPropose({
      sessionId: 's1',
      turn: 7,
      labels: [{ id: target.id, label: 'violated' }],
    });

    expect(created).toHaveLength(1);
    const proposal = created[0]!;
    expect(proposal.status).toBe('candidate');
    expect(proposal.content).toBe(revisedContent);
    expect(proposal.scope).toBe('project');
    expect(proposal.projectId).toBe('RenderX');
    expect(proposal.evidenceClass).toBe('inferred');
    expect(memory.store.revisionTargetOf(proposal.id)?.id).toBe(target.id);
    // The drafting prompt carried the drift evidence.
    expect(calls[0]!.user).toContain('VIOLATED');
    expect(calls[0]!.system).toContain('at most 100 words');
    expect(calls[0]!.system).toContain('semantically complete');
    expect(calls[0]!.system).not.toContain('160 chars');
    // The original stays active until the user decides.
    expect(memory.store.getById(target.id)!.status).toBe('active');
  });

  it('draftFor preserves a complete provider response when it overruns the word target', async () => {
    const target = activeMemory('Run tests with `npm test`');
    const revisedContent = `${Array.from({ length: 101 }, (_, index) => `audit${index + 1}`).join(' ')}.`;
    const { call } = stubCaller([
      { action: 'revise', content: revisedContent, reason: 'The user flagged the old rule.' },
    ]);
    const svc = createRevisionService({ memory, callJson: call });

    const proposal = await svc.draftFor(target.id, { sessionId: 's1', turn: 8 });

    expect(proposal).not.toBeNull();
    expect(proposal!.content).toBe(revisedContent);
    expect(memory.store.revisionTargetOf(proposal!.id)?.id).toBe(target.id);
  });

  it('drops a draft whose target the user edited while the LLM was writing it (CAS)', async () => {
    const target = activeMemory('BROKEN_OLD_RULE');
    traceTimes(target.id, 'violated', 3);
    const call: Parameters<typeof createRevisionService>[0]['callJson'] = async () => {
      // The user fixes the rule mid-draft — the LLM's replacement is stale.
      memory.store.update(target.id, { content: 'USER_ALREADY_FIXED_RULE' }, { actor: 'user' });
      return { action: 'revise', content: 'Stale replacement written against the old text', reason: 'violated 3x' };
    };
    const svc = createRevisionService({ memory, callJson: call, streak: 3 });

    const created = await svc.scanAndPropose({
      sessionId: 's1',
      labels: [{ id: target.id, label: 'violated' }],
    });

    expect(created).toHaveLength(0);
    expect(memory.store.hasOpenRevision(target.id)).toBe(false);
    expect(memory.store.getById(target.id)!.content).toBe('USER_ALREADY_FIXED_RULE');
  });

  it('does not draft below the streak, on mixed verdicts, on inert streaks, or when a revision is already open', async () => {
    const below = activeMemory('below streak');
    traceTimes(below.id, 'violated', 2);
    const mixed = activeMemory('mixed verdicts');
    memory.store.recordTraceLabel(mixed.id, 'violated', { actor: 'agent', turn: 1 });
    memory.store.recordTraceLabel(mixed.id, 'injected_without_effect', { actor: 'agent', turn: 2 });
    memory.store.recordTraceLabel(mixed.id, 'violated', { actor: 'agent', turn: 3 });
    // A without-effect streak never drafts: no drift evidence to write a
    // replacement from (live-testing produced echo proposals) — that memory
    // belongs to the stale surface, not the revision lane.
    const inert = activeMemory('inert streak');
    traceTimes(inert.id, 'injected_without_effect', 3);
    const open = activeMemory('already has a proposal');
    traceTimes(open.id, 'violated', 3);
    const existing = memory.store.create(
      { content: 'pending revision', scope: 'project', projectId: 'RenderX', type: 'constraint', status: 'candidate' },
      { actor: 'system' },
    );
    memory.store.addRelation(existing.id, open.id, 'revises');

    const { call, calls } = stubCaller([]);
    const svc = createRevisionService({ memory, callJson: call, streak: 3 });
    const created = await svc.scanAndPropose({
      sessionId: 's1',
      labels: [
        { id: below.id, label: 'violated' },
        { id: mixed.id, label: 'violated' },
        { id: inert.id, label: 'injected_without_effect' },
        { id: open.id, label: 'violated' },
      ],
    });

    expect(created).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('a retire verdict drafts NOTHING — the memory keeps its id, history, and active status', async () => {
    const target = activeMemory('Fully obsolete rule');
    traceTimes(target.id, 'violated', 3);
    const { call } = stubCaller([
      { action: 'retire', content: 'Fully obsolete rule', reason: 'no longer applies' },
    ]);
    const svc = createRevisionService({ memory, callJson: call, streak: 3 });

    const created = await svc.scanAndPropose({
      sessionId: 's1',
      labels: [{ id: target.id, label: 'violated' }],
    });

    expect(created).toHaveLength(0);
    expect(memory.store.hasOpenRevision(target.id)).toBe(false);
    expect(memory.store.getById(target.id)!.status).toBe('active');
    // No orphan candidate was written either.
    expect(memory.store.list({ status: 'candidate' })).toHaveLength(0);
  });

  it('drops an echo proposal (drafted revision identical to the original text)', async () => {
    const target = activeMemory('Run tests with `bun test`');
    traceTimes(target.id, 'violated', 3);
    const { call } = stubCaller([
      { action: 'revise', content: '  Run tests with `bun test`  ', reason: 'no real change' },
    ]);
    const svc = createRevisionService({ memory, callJson: call, streak: 3 });
    const created = await svc.scanAndPropose({
      sessionId: 's1',
      labels: [{ id: target.id, label: 'violated' }],
    });
    expect(created).toHaveLength(0);
    expect(memory.store.hasOpenRevision(target.id)).toBe(false);
  });

  it('an operational verdict this turn never triggers a draft, and a failed draft is swallowed', async () => {
    const fine = activeMemory('healthy memory');
    traceTimes(fine.id, 'operational', 3);
    const broken = activeMemory('draft will fail');
    traceTimes(broken.id, 'violated', 3);
    const svc = createRevisionService({
      memory,
      callJson: async () => {
        throw new Error('LLM down');
      },
      streak: 3,
    });

    const created = await svc.scanAndPropose({
      sessionId: 's1',
      labels: [
        { id: fine.id, label: 'operational' },
        { id: broken.id, label: 'violated' },
      ],
    });
    expect(created).toHaveLength(0);
    expect(memory.store.hasOpenRevision(broken.id)).toBe(false);
  });
});
