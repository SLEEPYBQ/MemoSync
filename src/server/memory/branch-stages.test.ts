import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryService } from './index';
import { createCaptureService } from './capture';
import { createCheckupService } from './checkup';
import { createTransferDetectService } from './transfer-detect';
import { createTransferService } from './transfer';
import {
  buildAuditBranchPrompt,
  buildWorkingMemoryBranchPrompt,
  mergeMemoryBranchUpdate,
  parseAuditBranchResult,
  parseWorkingMemoryBranchResult,
} from './branch-stages';

describe('provider branch stage contracts', () => {
  let directory: string;
  let memory: MemoryService;
  let sidecarCalls: number;
  const forbiddenSidecar = async (): Promise<Record<string, unknown>> => {
    sidecarCalls += 1;
    throw new Error('Memory branch must not call a sidecar');
  };

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'memosync-branch-stages-'));
    memory = new MemoryService({ dbPath: ':memory:', dataDir: directory });
    sidecarCalls = 0;
  });

  afterEach(() => {
    memory.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('persists a resolved C branch as review candidates without routing through another model', async () => {
    const prior = memory.store.create({ content: 'Use npm', type: 'constraint', scope: 'session', sessionId: 'S' }, { actor: 'user' });
    const service = createCaptureService({ memory, callJson: forbiddenSidecar });
    const input = { sessionId: 'S', projectId: 'P', engine: 'codex', turn: 1, userText: 'For this project, always use bun instead of npm.' };
    const request = service.buildBranchPrompt!(input);
    expect(request.prompt).toContain(prior.content);
    const result = await service.captureFromBranch!({ candidates: [{
      proposalId: 'C:1', content: 'Use bun for project scripts', type: 'constraint', scope: 'project',
      abstractionLevel: 'contextual', sensitive: false, route: 'updates', targetId: prior.id, targetVersion: prior.version,
    }] }, input, request.dependencyKey);
    expect(result.created).toHaveLength(1);
    expect(result.created[0]!.status).toBe('candidate');
    expect(memory.store.getById(prior.id)!.status).toBe('active');
    expect(memory.store.getRelations(result.created[0]!.id)).toContainEqual({ type: 'revises', targetId: prior.id });
    expect(sidecarCalls).toBe(0);
  });

  it('rejects stale C analysis before any candidate is persisted', async () => {
    const prior = memory.store.create({ content: 'Use npm', type: 'constraint', scope: 'personal' }, { actor: 'user' });
    const service = createCaptureService({ memory, callJson: forbiddenSidecar });
    const input = { sessionId: 'S', userText: 'Use bun instead.' };
    const request = service.buildBranchPrompt!(input);
    memory.store.update(prior.id, { content: 'Use pnpm' }, { actor: 'user' });
    await expect(service.captureFromBranch!({ candidates: [{
      proposalId: 'C:1', content: 'Use bun', type: 'constraint', scope: 'personal', route: 'updates',
      targetId: prior.id, targetVersion: prior.version,
    }] }, input, request.dependencyKey)).rejects.toThrow('inputs changed');
    expect(memory.store.list({ status: 'candidate' })).toHaveLength(0);
    expect(sidecarCalls).toBe(0);
  });

  it('an in-batch duplicate cannot overwrite the first candidate’s persistence route', async () => {
    const service = createCaptureService({ memory, callJson: forbiddenSidecar });
    const input = { sessionId: 'S', engine: 'codex', turn: 1, userText: 'Use integer cents.' };
    const request = service.buildBranchPrompt!(input);
    const candidate = { content: 'Use integer cents', type: 'constraint', scope: 'session', abstractionLevel: 'contextual', sensitive: false };
    const result = await service.captureFromBranch!({ candidates: [
      { ...candidate, proposalId: 'C:1', route: 'new' },
      { ...candidate, proposalId: 'C:2', route: 'duplicate-in-batch' },
    ] }, input, request.dependencyKey);
    expect(result.created).toHaveLength(1);
    expect(result.dropped).toBe(1);
    expect(sidecarCalls).toBe(0);
  });

  it('materializes T encoding, localization, and target CAS entirely from branch output', async () => {
    const source = memory.store.create({ content: 'On Alpha, check port 3000 before starting the dev server', scope: 'project', projectId: 'other', type: 'lesson' }, { actor: 'user' });
    const service = createTransferDetectService({
      memory, callJson: forbiddenSidecar, transfer: createTransferService({ callJson: forbiddenSidecar }),
      listProjects: () => [{ id: 'other', title: 'Alpha' }, { id: 'P', title: 'Beta' }], listRecentSessions: () => [],
    });
    const context = { projectId: 'P', sessionId: 'S', taskText: 'Start the development server' };
    const request = service.buildTaskBranchPrompt!(context);
    const row = {
      proposalId: `T:${source.id}`, sourceId: source.id, sourceVersion: source.version,
      encoding: { rule: 'Check a port is free before starting a server', portable: true, note: 'Avoid service conflicts', stripped: ['Alpha', '3000', 'invented'] },
      decoding: { content: 'Check that the development port is free', abstractionLevel: 'contextual', suggestedScope: 'project', note: 'Applies to server startup', landing: { route: 'new' } },
    };
    const result = await service.materializeTaskFromBranch!(context, { suggestions: [row] }, request.dependencyKey);
    expect(result!.cards[0]!.sourceContent).toBe(source.content);
    expect(result!.cards[0]!.encoding.stripped).toEqual(['Alpha', '3000']);
    expect(service.landingsStillCurrent(context, result!.targetKey)).toBe(true);
    memory.store.create({ content: 'Use the assigned development port', type: 'constraint', scope: 'project', projectId: 'P' }, { actor: 'user' });
    expect(service.landingsStillCurrent(context, result!.targetKey)).toBe(false);
    expect(await service.materializeTaskFromBranch!(context, { suggestions: [row] }, request.dependencyKey)).toBeNull();
    expect(sidecarCalls).toBe(0);
  });

  it('continues T using a short delta that removes a rejected source and updates only another landing', () => {
    const old = { suggestions: [
      { proposalId: 'T:M-1', sourceId: 'M-1', decoding: { content: 'old one' } },
      { proposalId: 'T:M-2', sourceId: 'M-2', decoding: { content: 'old two' } },
      { proposalId: 'T:M-3', sourceId: 'M-3', decoding: { content: 'unchanged' } },
    ] };
    const next = mergeMemoryBranchUpdate(old, {
      remove: { suggestions: ['T:M-1'] },
      upsert: { suggestions: [{ proposalId: 'T:M-2', sourceId: 'M-2', decoding: { content: 'reviewed adaptation' } }] },
    });
    expect(next.suggestions).toEqual([
      { proposalId: 'T:M-2', sourceId: 'M-2', decoding: { content: 'reviewed adaptation' } },
      old.suggestions[2],
    ]);
    expect(old.suggestions).toHaveLength(3);
    expect(() => mergeMemoryBranchUpdate(old, { upsert: { suggestions: [{ proposalId: 'T:M-2', sourceId: 'M-forged' }] } })).toThrow('identity');
  });

  it('rejects the observed GLM memory-ID-keyed delta and other malformed shapes instead of silently keeping old proposals', () => {
    const previous = { suggestions: [{ proposalId: 'T:M-02', sourceId: 'M-02' }] };
    for (const update of [
      { upsert: { 'M-02': { id: 'M-02', content: 'Changed memory', scope: 'project' } }, remove: {} },
      { upsert: [], remove: {} },
      { upsert: null, remove: {} },
      { upsert: { suggestions: {} }, remove: {} },
      { upsert: { suggestions: null }, remove: { suggestions: [] } },
      { upsert: { suggestions: [] }, remove: { suggestions: null } },
      { upsert: { suggestions: undefined }, remove: {} },
      { upsert: {}, remove: { suggestions: [null] } },
      { upsert: {}, remove: {}, analysis: 'extra key' },
      { upsert: { conflicts: [] }, remove: {} },
      { suggestions: [], unknown: [] },
      {},
    ]) {
      expect(() => mergeMemoryBranchUpdate(previous, update)).toThrow();
    }
    expect(mergeMemoryBranchUpdate(previous, { upsert: {}, remove: {} })).toEqual(previous);
    expect(mergeMemoryBranchUpdate(previous, { suggestions: [] })).toEqual({ suggestions: [] });
    expect(() => mergeMemoryBranchUpdate({ conflicts: [], redundancy: [], staleness: [] }, { conflicts: [] })).toThrow('every original');
  });

  it('rejects unknown removal identities instead of silently retaining the proposal', () => {
    const transfer = { suggestions: [{ proposalId: 'T:M-02', sourceId: 'M-02' }] };
    for (const id of ['M-02', 'T:M-99', ' T:M-02']) {
      expect(() => mergeMemoryBranchUpdate(transfer, { upsert: { suggestions: [] }, remove: { suggestions: [id] } })).toThrow('unknown proposal removal');
    }
    expect(mergeMemoryBranchUpdate(transfer, { upsert: {}, remove: { suggestions: ['T:M-02'] } })).toEqual({ suggestions: [] });
    expect(transfer.suggestions).toHaveLength(1);

    const changes = { conflicts: [{ memoryId: 'M-01', otherMemoryId: 'M-02', reason: 'Opposite rules' }], redundancy: [], staleness: [] };
    expect(() => mergeMemoryBranchUpdate(changes, { upsert: {}, remove: { conflicts: ['conflicts:M-02:M-01'] } })).toThrow('unknown proposal removal');
    expect(() => mergeMemoryBranchUpdate(changes, { upsert: {}, remove: { conflicts: ['redundancy:M-01:M-02'] } })).toThrow('unknown proposal removal');
    expect(mergeMemoryBranchUpdate(changes, { upsert: {}, remove: { conflicts: ['conflicts:M-01:M-02'] } })).toEqual({ conflicts: [], redundancy: [], staleness: [] });
    expect(changes.conflicts).toHaveLength(1);
  });

  it('M judges recent expired items and merges overlapping findings without a sidecar', async () => {
    const a = memory.store.create({ content: 'Use the temporary 2020 test endpoint', scope: 'personal', type: 'constraint' }, { actor: 'user' });
    const b = memory.store.create({ content: 'Only use the production endpoint', scope: 'personal', type: 'constraint' }, { actor: 'user' });
    const service = createCheckupService({ memory, callJson: forbiddenSidecar, listRecentSessions: () => [], now: () => new Date('2026-09-10') });
    const request = service.buildBranchPrompt!({}, 'Run the payment integration');
    const result = await service.primeFromBranchResult!({}, request.dependencyKey, {
      conflicts: [{ memoryId: a.id, otherMemoryId: b.id, reason: 'Different required endpoints' }], redundancy: [],
      staleness: [{ memoryId: a.id, reason: 'The temporary endpoint expired in 2020' }],
    });
    expect(result!.suggestions).toHaveLength(1);
    expect(result!.suggestions[0]!.reason).toContain('expired in 2020');
    expect(service.needsRecompute({})).toBe(false);
    expect(sidecarCalls).toBe(0);
  });

  it('W produces the exact reviewed expected uses and cannot silently omit a mandatory memory', () => {
    const memories = [{ id: 'M-1', content: 'Keep all money as integer cents' }, { id: 'M-2', content: 'Write conventional commits' }];
    const input = { task: 'Charge the test order', memories, mandatoryIds: ['M-1'] };
    expect(buildWorkingMemoryBranchPrompt(input)).toContain('integer cents');
    const valid = { selected: [{ id: 'M-1', why: 'Charging an amount', expectedUse: 'Convert the order total to integer cents before charging.' }] };
    expect(parseWorkingMemoryBranchResult(valid, input)).toEqual({
      relevant: [{ id: 'M-1', why: 'Charging an amount' }],
      expectedUses: [{ id: 'M-1', expectedUse: valid.selected[0]!.expectedUse }],
    });
    expect(() => parseWorkingMemoryBranchResult({ selected: [] }, input)).toThrow('mandatory');
    expect(() => parseWorkingMemoryBranchResult({ selected: [{ id: 'M-forged', why: 'yes', expectedUse: 'Do it' }] }, input)).toThrow('selection');
  });

  it('A preserves a tool-only uncited violation anchor and all four verdicts', () => {
    const usedMemories = ['Store money as integer cents', 'Use USD', 'Generated images are vivid', 'Keep modules small'].map((content) =>
      memory.store.create({ content, type: 'constraint', scope: 'personal' }, { actor: 'user' }));
    const input = {
      usedMemories, assistantText: 'The charge was submitted in USD.',
      executionText: 'payments.create({ amount: 12.5, currency: "usd" })',
    };
    const result = parseAuditBranchResult({ labels: [
      { id: usedMemories[0]!.id, label: 'violated', note: 'Dollar units instead of integer cents', quote: 'amount: 12.5', cause: 'not_followed', impact: 'none' },
      { id: usedMemories[1]!.id, label: 'shaped', note: 'Currency was USD', quote: 'submitted in USD' },
      { id: usedMemories[2]!.id, label: 'not_applicable', note: 'No image operation', missing: 'image generation' },
      { id: usedMemories[3]!.id, label: 'no_visible_effect', note: 'No visible module structure effect' },
    ] }, input);
    expect(result.labels.map((label) => label.label)).toEqual(['violated', 'operational', 'not_applicable', 'injected_without_effect']);
    expect(result.labels[0]!.quote).toBe('amount: 12.5');
    expect(result.labels[0]!.cause).toBe('not_followed');
    expect(result.labels[0]).not.toHaveProperty('cited');
  });

  it('A shows complete alternative verdict schemas using the actual first injected ID', () => {
    const first = memory.store.create({ content: 'Keep deployment credentials isolated', type: 'constraint', scope: 'personal' }, { actor: 'user' });
    const second = memory.store.create({ content: 'Use integer cents', type: 'constraint', scope: 'personal' }, { actor: 'user' });
    const prompt = buildAuditBranchPrompt({ usedMemories: [first, second], assistantText: 'Inspected the payment code.' });
    const examples = prompt.split('\n').filter((line) => line.startsWith('{"labels":')).map((line) => JSON.parse(line) as { labels: Array<Record<string, unknown>>; summary: string });
    expect(examples).toHaveLength(4);
    expect(examples.map((example) => example.labels[0]!.label)).toEqual(['operational', 'injected_without_effect', 'not_applicable', 'violated']);
    for (const example of examples) {
      expect(example.labels).toHaveLength(1);
      expect(example.labels[0]!.id).toBe(first.id);
      expect(Object.keys(example.labels[0]!).sort()).toEqual(['id', 'label', 'note', 'quote', 'toolId', 'cause', 'missing', 'impact'].sort());
      expect(example.labels[0]!.quote).toBeNull();
      expect(example.labels[0]!.toolId).toBeNull();
      expect(typeof example.summary).toBe('string');
    }
    expect(examples[2]!.labels[0]!.missing).toBe('<specific absent object or opportunity>');
    expect(examples[3]!.labels[0]).toMatchObject({ cause: 'not_followed', impact: 'none', missing: null });
    expect(prompt).toContain('missing MUST be a separate non-empty string');
    expect(prompt).toContain('FOUR ALTERNATIVE');
    expect(prompt).not.toContain('M-07');
  });

  it('A still rejects a note-only missing opportunity and accepts the independent required field', () => {
    const item = memory.store.create({ content: 'Use the deployment checklist', type: 'constraint', scope: 'personal' }, { actor: 'user' });
    const input = { usedMemories: [item], assistantText: 'Read the payment source code.' };
    const noteOnly = { id: item.id, label: 'not_applicable', note: 'Missing opportunity: no deployment happened.', quote: null, toolId: null, cause: null, impact: null, missing: null };
    expect(() => parseAuditBranchResult({ labels: [noteOnly], summary: '' }, input)).toThrow('missing opportunity');
    const result = parseAuditBranchResult({ labels: [{ ...noteOnly, missing: 'a deployment operation' }], summary: '' }, input);
    expect(result.labels[0]).toMatchObject({ id: item.id, label: 'not_applicable', missing: 'a deployment operation' });
  });

  it('A reports an incomplete audit as failure instead of inventing no-effect labels', () => {
    const item = memory.store.create({ content: 'Store money as integer cents', type: 'constraint', scope: 'personal' }, { actor: 'user' });
    expect(() => parseAuditBranchResult({ labels: [] }, { usedMemories: [item], assistantText: 'Done' })).toThrow('omitted');
    const result = parseAuditBranchResult({ labels: [{ id: item.id, label: 'violated', note: 'Wrong units', quote: 'fabricated evidence', cause: 'not_followed', impact: 'none' }] }, {
      usedMemories: [item], assistantText: 'Done', executionText: 'amount: 12.5',
    });
    expect(result.labels[0]).not.toHaveProperty('quote');
  });

  it('A validates tool anchors against this turn and rejects forged or mismatched tool IDs', () => {
    const item = memory.store.create({ content: 'Store money as integer cents', type: 'constraint', scope: 'personal' }, { actor: 'user' });
    const input = { usedMemories: [item], assistantText: 'Done', executionTools: [
      { toolId: 'tool-charge', text: 'amount: 12.5' }, { toolId: 'tool-other', text: 'currency: USD' },
    ] };
    const verdict = { id: item.id, label: 'violated', note: 'Wrong amount units', quote: 'amount: 12.5', cause: 'not_followed', impact: 'none' };
    expect(parseAuditBranchResult({ labels: [verdict] }, input).labels[0]!.toolId).toBe('tool-charge');
    expect(parseAuditBranchResult({ labels: [{ ...verdict, toolId: 'tool-charge' }] }, input).labels[0]!.toolId).toBe('tool-charge');
    expect(parseAuditBranchResult({ labels: [{ ...verdict, toolId: 'tool-forged' }] }, input).labels[0]).not.toHaveProperty('toolId');
    expect(parseAuditBranchResult({ labels: [{ ...verdict, toolId: 'tool-other' }] }, input).labels[0]).not.toHaveProperty('toolId');
    const punctuation = parseAuditBranchResult({ labels: [{ ...verdict, quote: '**', toolId: 'tool-charge' }] }, input).labels[0];
    expect(punctuation).not.toHaveProperty('quote');
    expect(punctuation).not.toHaveProperty('toolId');
  });
});
