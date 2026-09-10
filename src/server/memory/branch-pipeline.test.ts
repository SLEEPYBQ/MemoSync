import { describe, expect, it } from 'bun:test';
import { MemoryBranchPipeline, type PreparationStage } from './branch-pipeline';
import type { MemoryBranch, MemoryBranchAskOptions } from './branch-runtime';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
  const calls: Array<{ stage: PreparationStage; prompt: string; options?: MemoryBranchAskOptions; reply: ReturnType<typeof deferred<Record<string, unknown>>> }> = [];
  const created: PreparationStage[] = [];
  const disposed: PreparationStage[] = [];
  const pipeline = new MemoryBranchPipeline({
    createBranch(stage): MemoryBranch {
      created.push(stage);
      return {
        id: `child-${stage}`, mode: 'fork', sessionToken: `session-${stage}`,
        ask(prompt, options) {
          const reply = deferred<Record<string, unknown>>();
          calls.push({ stage, prompt, options, reply });
          // Deliberately ignores AbortSignal: the pipeline must not expose
          // late output from a transport that has not noticed cancellation.
          return reply.promise;
        },
        dispose() { disposed.push(stage); },
      };
    },
    requests: {
      candidate: { prompt: 'extract and route C', dependencyKey: 'C-before' },
      transfer: { prompt: 'encode and localize T', dependencyKey: 'T-before' },
      changes: { prompt: 'review changes M', dependencyKey: 'M-before' },
    },
  });
  return { pipeline, calls, created, disposed };
}

async function flush() { await Promise.resolve(); await Promise.resolve(); }

describe('MemoryBranchPipeline', () => {
  it('repairs a memory-store-shaped response once in the same transfer conversation', async () => {
    const h = harness();
    h.calls[0]!.reply.resolve({ candidates: [] });
    h.calls[1]!.reply.resolve({ suggestions: [] });
    h.calls[2]!.reply.resolve({ conflicts: [], redundancy: [], staleness: [] });
    await h.pipeline.result('transfer');
    const result = h.pipeline.continue('transfer', { review: 'Candidate review', changes: {}, dependencyKey: 'after' });
    await flush();
    h.calls[3]!.reply.resolve({ upsert: { 'M-02': { content: 'Use Bun' } }, remove: {} });
    for (let i = 0; i < 12 && h.calls.length < 5; i++) await flush();
    expect(h.calls[4]!.stage).toBe('transfer');
    expect(h.calls[4]!.prompt).toContain('Correct only the response schema');
    expect(h.calls[3]!.options?.budget).toEqual({ maxTurns: 3, maxToolCalls: 1 });
    expect(h.calls[4]!.options?.budget).toEqual({ maxTurns: 2, maxToolCalls: 0 });
    h.calls[4]!.reply.resolve({ upsert: {}, remove: {} });
    expect(await result).toEqual({ raw: { suggestions: [] }, dependencyKey: 'after' });
    expect(h.created).toEqual(['candidate', 'transfer', 'changes']);
    h.pipeline.dispose();
  });

  it('fails after one unsuccessful schema repair instead of treating it as empty suggestions', async () => {
    const h = harness();
    h.calls[0]!.reply.resolve({ candidates: [] });
    h.calls[1]!.reply.resolve({ suggestions: [] });
    h.calls[2]!.reply.resolve({ conflicts: [], redundancy: [], staleness: [] });
    await h.pipeline.result('transfer');
    const result = h.pipeline.continue('transfer', { review: 'Candidate review', changes: {}, dependencyKey: 'after' });
    await flush();
    h.calls[3]!.reply.resolve({ upsert: { 'M-02': {} }, remove: {} });
    for (let i = 0; i < 12 && h.calls.length < 5; i++) await flush();
    h.calls[4]!.reply.resolve({ upsert: { 'M-02': {} }, remove: {} });
    await expect(result).rejects.toThrow('proposal collection');
    expect(h.calls).toHaveLength(5);
    h.pipeline.dispose();
  });
  it('starts C, T, M together and allows T/M to finish while C awaits review', async () => {
    const h = harness();
    expect(h.calls.map((call) => call.stage)).toEqual(['candidate', 'transfer', 'changes']);
    h.calls[1]!.reply.resolve({ suggestions: [] });
    h.calls[2]!.reply.resolve({ conflicts: [], redundancy: [], staleness: [] });
    expect(await h.pipeline.result('transfer')).toEqual({ raw: { suggestions: [] }, dependencyKey: 'T-before' });
    expect((await h.pipeline.result('changes')).dependencyKey).toBe('M-before');
    h.calls[0]!.reply.resolve({ candidates: [] });
    await h.pipeline.result('candidate');
    h.pipeline.dispose();
    expect(h.disposed).toEqual(['candidate', 'transfer', 'changes']);
  });

  it('sends C decisions to original T/M conversations, then T decisions to the same M conversation in order', async () => {
    const h = harness();
    h.calls[0]!.reply.resolve({ candidates: [] });
    h.calls[1]!.reply.resolve({ suggestions: [{ proposalId: 'T:M-1', sourceId: 'M-1', sourceVersion: 1 }] });
    h.calls[2]!.reply.resolve({ conflicts: [], redundancy: [], staleness: [] });
    await Promise.all(['candidate', 'transfer', 'changes'].map((stage) => h.pipeline.result(stage as PreparationStage)));
    const afterCandidateT = h.pipeline.continue('transfer', { review: 'Candidate review', changes: { accepted: ['M-2'] }, dependencyKey: 'T-after-C' });
    const afterCandidateM = h.pipeline.continue('changes', { review: 'Candidate review', changes: { accepted: ['M-2'] }, dependencyKey: 'M-after-C' });
    const afterTransferM = h.pipeline.continue('changes', { review: 'Transfer review', changes: { accepted: ['M-3'] }, dependencyKey: 'M-after-T' });
    await flush();
    expect(h.calls.slice(3).map((call) => call.stage)).toEqual(['transfer', 'changes']);
    h.calls[3]!.reply.resolve({ remove: { suggestions: ['T:M-1'] }, upsert: {} });
    h.calls[4]!.reply.resolve({ upsert: { conflicts: [{ memoryId: 'M-2', otherMemoryId: 'M-3', reason: 'Opposite constraints' }] }, remove: {} });
    expect((await afterCandidateT).raw).toEqual({ suggestions: [] });
    await afterCandidateM;
    await flush();
    expect(h.calls[5]!.stage).toBe('changes');
    expect(h.calls[5]!.prompt).toContain('Transfer review');
    h.calls[5]!.reply.resolve({ remove: { conflicts: ['conflicts:M-2:M-3'] }, upsert: {} });
    expect(await afterTransferM).toEqual({ raw: { conflicts: [], redundancy: [], staleness: [] }, dependencyKey: 'M-after-T' });
    expect(h.created).toEqual(['candidate', 'transfer', 'changes']);
    h.pipeline.dispose();
  });

  it('retains an early downstream rejection and never starts a fresh branch to conceal it', async () => {
    const h = harness();
    const error = new Error('Transfer transport failed');
    h.calls[1]!.reply.reject(error);
    await flush();
    h.calls[0]!.reply.resolve({ candidates: [] });
    await h.pipeline.result('candidate');
    await expect(h.pipeline.result('transfer')).rejects.toThrow('Transfer transport failed');
    await expect(h.pipeline.continue('transfer', { review: 'Candidate review', changes: {}, dependencyKey: 'new' })).rejects.toThrow('Transfer transport failed');
    expect(h.calls.filter((call) => call.stage === 'transfer')).toHaveLength(1);
    h.calls[2]!.reply.resolve({ conflicts: [], redundancy: [], staleness: [] });
    await h.pipeline.result('changes');
    h.pipeline.dispose();
  });

  it('cancellation rejects pending results and prevents queued reviewer followups even if transport ignores abort', async () => {
    const h = harness();
    const continued = h.pipeline.continue('changes', { review: 'Candidate review', changes: {}, dependencyKey: 'new' });
    h.pipeline.dispose();
    expect(h.calls.every((call) => call.options?.signal?.aborted)).toBe(true);
    for (const call of h.calls) call.reply.resolve({ conflicts: [], redundancy: [], staleness: [] });
    await expect(h.pipeline.result('candidate')).rejects.toThrow();
    await expect(continued).rejects.toThrow();
    expect(h.calls).toHaveLength(3);
    h.pipeline.dispose();
    expect(h.disposed).toHaveLength(3);
  });
});
