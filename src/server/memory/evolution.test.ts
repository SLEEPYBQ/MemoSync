import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryService } from './index';
import { TraceCorrectionError } from './MemoryStore';
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

  function tracedTurns(id: string, count: number) {
    for (let turn = 1; turn <= count; turn++) {
      memory.store.recordTraceLabel(id, 'violated', { actor: 'agent', sessionId: 'chat', turn });
    }
  }

  it('archives only a revision whose captured streak was corrected, without a dismissal', async () => {
    const target = activeMemory('Synthetic original rule');
    tracedTurns(target.id, 4);
    const svc = createRevisionService({ memory, callJson: stubCaller([{ action: 'revise', content: 'Synthetic revised rule' }]).call });
    const [proposal] = await svc.scanAndPropose({ sessionId: 'chat', labels: [{ id: target.id, label: 'violated' }] });
    expect(proposal).toBeDefined();
    expect(memory.store.getKv<{ targetId: string; traceSeqs: number[] }>(`revision_trace_evidence:${proposal!.id}`)).toEqual({
      targetId: target.id, traceSeqs: memory.store.recentTraceEvidence(target.id, 3).map(row => row.seq),
    });
    expect(memory.store.recordTraceCorrection(target.id, { sessionId: 'chat', turn: 1, label: 'operational' }).invalidatedIds).toBeUndefined();
    expect(memory.store.getById(proposal!.id)?.status).toBe('candidate');
    const correction = memory.store.recordTraceCorrection(target.id, { sessionId: 'chat', turn: 3, label: 'not_applicable' });
    expect(correction.invalidatedIds).toEqual([proposal!.id]);
    expect(memory.store.getById(proposal!.id)?.status).toBe('archived');
    expect(memory.store.getEvents(proposal!.id).at(-1)).toMatchObject({
      kind: 'status', actor: 'system', changes: { status: { before: 'candidate', after: 'archived' } },
    });
    expect(memory.store.hasOpenRevision(target.id)).toBe(false);
    expect(memory.store.listOpenRevisions('RenderX')).toEqual([]);
    expect(memory.store.getById(target.id)?.status).toBe('active');
    expect(memory.db.query('SELECT 1 FROM dismissed_candidate_fingerprints WHERE memory_id = ?').get(proposal!.id)).toBeNull();
    expect(memory.store.recordTraceCorrection(target.id, { sessionId: 'chat', turn: 3, label: 'not_applicable' }).changed).toBe(false);
    memory.store.recordTraceCorrection(target.id, { sessionId: 'chat', turn: 3, label: null });
    expect(memory.store.getById(proposal!.id)?.status).toBe('archived');
  });

  it('drops a pending automatic draft when an evidenced verdict is corrected during the LLM await', async () => {
    const target = activeMemory('Synthetic original rule');
    tracedTurns(target.id, 3);
    let release!: (result: Record<string, unknown>) => void;
    let started!: () => void;
    const called = new Promise<void>(resolve => { started = resolve; });
    const call: LlmJsonCaller = async () => {
      started();
      return await new Promise(resolve => { release = resolve; });
    };
    const svc = createRevisionService({ memory, callJson: call });
    const pending = svc.scanAndPropose({ sessionId: 'chat', labels: [{ id: target.id, label: 'violated' }] });
    await called;
    memory.store.recordTraceCorrection(target.id, { sessionId: 'chat', turn: 2, label: 'operational' });
    release({ action: 'revise', content: 'Stale synthetic replacement' });
    expect(await pending).toEqual([]);
    expect(memory.store.list({ status: 'candidate' })).toEqual([]);
    expect(memory.store.hasOpenRevision(target.id)).toBe(false);
  });

  it('uses captured evidence rather than the legacy three-trace fallback for a custom streak', async () => {
    const target = activeMemory('Synthetic custom-streak rule');
    tracedTurns(target.id, 3);
    const svc = createRevisionService({ memory, streak: 2, callJson: stubCaller([{ action: 'revise', content: 'Synthetic custom-streak revision' }]).call });
    const [proposal] = await svc.scanAndPropose({ sessionId: 'chat', labels: [{ id: target.id, label: 'violated' }] });
    expect(memory.store.getKv<{ traceSeqs: number[] }>(`revision_trace_evidence:${proposal!.id}`)?.traceSeqs).toHaveLength(2);
    memory.store.recordTraceCorrection(target.id, { sessionId: 'chat', turn: 1, label: 'operational' });
    expect(memory.store.getById(proposal!.id)?.status).toBe('candidate');
    memory.store.recordTraceCorrection(target.id, { sessionId: 'chat', turn: 2, label: 'operational' });
    expect(memory.store.getById(proposal!.id)?.status).toBe('archived');
  });

  it('retires a pending revision if a captured trace is missing when another is corrected', async () => {
    const target = activeMemory('Synthetic missing-trace rule');
    tracedTurns(target.id, 3);
    const svc = createRevisionService({ memory, callJson: stubCaller([{ action: 'revise', content: 'Synthetic missing-trace draft' }]).call });
    const [proposal] = await svc.scanAndPropose({ sessionId: 'chat', labels: [{ id: target.id, label: 'violated' }] });
    const evidence = memory.store.getKv<{ traceSeqs: number[] }>(`revision_trace_evidence:${proposal!.id}`)!;
    memory.db.query('DELETE FROM memory_events WHERE seq = ?').run(evidence.traceSeqs[0]!);
    expect(memory.store.recordTraceCorrection(target.id, { sessionId: 'chat', turn: 2, label: 'operational' }).invalidatedIds).toEqual([proposal!.id]);
    expect(memory.store.getById(proposal!.id)?.status).toBe('archived');
  });

  it('leaves an explicit user draft and an accepted automatic revision untouched', async () => {
    const manualTarget = activeMemory('Synthetic manual original');
    tracedTurns(manualTarget.id, 3);
    const manualSvc = createRevisionService({ memory, callJson: stubCaller([{ action: 'revise', content: 'Synthetic manual draft' }]).call });
    const manual = await manualSvc.draftFor(manualTarget.id, { sessionId: 'chat', turn: 3 });
    expect(manual).not.toBeNull();
    memory.store.recordTraceCorrection(manualTarget.id, { sessionId: 'chat', turn: 2, label: 'operational' });
    expect(memory.store.getById(manual!.id)?.status).toBe('candidate');

    const autoTarget = activeMemory('Synthetic automatic original');
    tracedTurns(autoTarget.id, 3);
    const autoSvc = createRevisionService({ memory, callJson: stubCaller([{ action: 'revise', content: 'Synthetic accepted revision' }]).call });
    const [automatic] = await autoSvc.scanAndPropose({ sessionId: 'chat', labels: [{ id: autoTarget.id, label: 'violated' }] });
    memory.store.acceptRevision(automatic!.id, { actor: 'user' });
    try {
      memory.store.recordTraceCorrection(autoTarget.id, { sessionId: 'chat', turn: 2, label: 'operational' });
      throw new Error('Expected correction to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(TraceCorrectionError);
      expect((error as TraceCorrectionError).status).toBe(409);
      expect((error as TraceCorrectionError).message).toBe('Only active memories can receive audit corrections');
    }
    expect(memory.store.getById(automatic!.id)?.status).toBe('active');
  });

  it('invalidates only qualifying legacy system revisions, not manual, capture, merge, or mixed-evidence drafts', () => {
    const target = activeMemory('Legacy target');
    const other = activeMemory('Other merge target');
    tracedTurns(target.id, 3);
    const make = (content: string, actor: 'system' | 'user' | 'agent', evidenceClass: 'inferred' | 'user_corrected', targets: string[]) => {
      const candidate = memory.store.create({ content, scope: 'project', projectId: 'RenderX', type: 'constraint', status: 'candidate', evidenceClass }, { actor });
      for (const id of targets) memory.store.addRelation(candidate.id, id, 'revises');
      return candidate;
    };
    const legacy = make('Legacy automatic draft', 'system', 'inferred', [target.id]);
    const manual = make('Manual draft', 'user', 'user_corrected', [target.id]);
    const capture = make('Capture draft', 'agent', 'inferred', [target.id]);
    const merge = make('Merge draft', 'system', 'inferred', [target.id, other.id]);
    expect(memory.store.recordTraceCorrection(target.id, { sessionId: 'chat', turn: 2, label: 'operational' }).invalidatedIds).toEqual([legacy.id]);
    expect(memory.store.getById(legacy.id)?.status).toBe('archived');
    for (const item of [manual, capture, merge]) expect(memory.store.getById(item.id)?.status).toBe('candidate');

    const mixed = activeMemory('Mixed evidence target');
    memory.store.recordTraceLabel(mixed.id, 'violated', { actor: 'agent', sessionId: 'chat', turn: 1 });
    memory.store.recordTraceLabel(mixed.id, 'operational', { actor: 'agent', sessionId: 'chat', turn: 2 });
    memory.store.recordTraceLabel(mixed.id, 'violated', { actor: 'agent', sessionId: 'chat', turn: 3 });
    const unrelated = make('Mixed evidence draft', 'system', 'inferred', [mixed.id]);
    memory.store.recordTraceCorrection(mixed.id, { sessionId: 'chat', turn: 3, label: 'operational' });
    expect(memory.store.getById(unrelated.id)?.status).toBe('candidate');
  });

  it.each(['discard', 'erase'] as const)('removes stored trace evidence when a candidate is %sed', action => {
    const target = activeMemory('Synthetic cleanup target');
    tracedTurns(target.id, 3);
    const traceEvidence = memory.store.recentTraceEvidence(target.id).map(row => row.seq);
    const proposal = memory.store.createRevisionProposal({ content: 'Synthetic cleanup proposal', scope: 'project', projectId: 'RenderX',
      type: 'constraint', evidenceClass: 'inferred' }, target.id, { actor: 'system' }, { traceEvidence });
    expect(proposal).not.toBeNull();
    expect(memory.store.getKv(`revision_trace_evidence:${proposal!.id}`)).not.toBeNull();
    if (action === 'discard') memory.store.discardCandidate(proposal!.id);
    else memory.store.eraseCandidate(proposal!.id);
    expect(memory.store.getKv(`revision_trace_evidence:${proposal!.id}`)).toBeNull();
  });

  it('rolls back a correction if retiring its stale revision fails', async () => {
    const target = activeMemory('Synthetic atomic target');
    tracedTurns(target.id, 3);
    const svc = createRevisionService({ memory, callJson: stubCaller([{ action: 'revise', content: 'Synthetic atomic draft' }]).call });
    const [proposal] = await svc.scanAndPropose({ sessionId: 'chat', labels: [{ id: target.id, label: 'violated' }] });
    memory.db.exec(`CREATE TRIGGER fail_revision_retirement BEFORE UPDATE OF status ON memories
      WHEN OLD.id = '${proposal!.id}' AND NEW.status = 'archived'
      BEGIN SELECT RAISE(ABORT, 'synthetic retirement failure'); END`);
    expect(() => memory.store.recordTraceCorrection(target.id, { sessionId: 'chat', turn: 2, label: 'operational' }))
      .toThrow('synthetic retirement failure');
    expect(memory.store.getById(proposal!.id)?.status).toBe('candidate');
    expect(memory.store.getEvents(target.id).filter(event => event.kind === 'trace_correction')).toEqual([]);
    expect(memory.store.recentTraceLabels(target.id)).toEqual(['violated', 'violated', 'violated']);
  });

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
