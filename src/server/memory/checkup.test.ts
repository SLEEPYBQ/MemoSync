import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryService } from './index';
import { createCheckupService } from './checkup';
import type { DeepSeekJsonRequest, LlmJsonCaller } from './deepseek';

/**
 * A caller that dispatches on the system prompt (the four queries run in
 * parallel — queue order would be nondeterministic). Records every request.
 */
function routedCaller(routes: Array<{ match: string; response: Record<string, unknown> | (() => Record<string, unknown>) }>) {
  const calls: DeepSeekJsonRequest[] = [];
  const call: LlmJsonCaller = async (req) => {
    calls.push(req);
    const route = routes.find((r) => req.system.includes(r.match));
    if (!route) throw new Error(`routedCaller: no route for system prompt: ${req.system.slice(0, 60)}`);
    return typeof route.response === 'function' ? route.response() : route.response;
  };
  return { call, calls };
}

let dir: string;
let memory: MemoryService;

const noSessions = () => [] as Array<{ id: string; startedAt: string }>;

describe('createCheckupService (step-one container 2, redesign 2026-08-07)', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memv2-checkup-'));
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
  });
  afterEach(() => {
    memory.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs the pair queries over the pool, validates ids, and filters already-related pairs', async () => {
    const a = memory.store.create({ content: 'Commit messages in Chinese', scope: 'personal', type: 'constraint' }, { actor: 'system' });
    const b = memory.store.create({ content: 'Commit messages in English', scope: 'personal', type: 'constraint' }, { actor: 'system' });
    const c = memory.store.create({ content: 'Use bun for scripts', scope: 'personal', type: 'constraint' }, { actor: 'system' });
    const d = memory.store.create({ content: 'Scripts run with bun', scope: 'personal', type: 'constraint' }, { actor: 'system' });
    // d/c already acknowledged as "keep both" — must not be re-flagged.
    memory.store.addRelation(c.id, d.id, 'similar_to');

    const { call, calls } = routedCaller([
      {
        match: 'CONTRADICTIONS',
        response: {
          findings: [
            { memoryId: a.id, otherMemoryId: b.id, reason: 'opposite commit-language rules' },
            { memoryId: 'M-99', otherMemoryId: a.id, reason: 'hallucinated id' },
          ],
        },
      },
      {
        match: 'NEAR-DUPLICATES',
        response: { findings: [{ memoryId: c.id, otherMemoryId: d.id, reason: 'same bun rule twice' }] },
      },
    ]);
    const checkup = createCheckupService({ memory, callJson: call, listRecentSessions: noSessions });

    const result = await checkup.run({});
    expect(result.cached).toBe(false);
    // Conflict pair survives; hallucinated id and the related pair are dropped.
    expect(result.suggestions).toEqual([
      { kind: 'conflict', memoryId: a.id, otherMemoryId: b.id, reason: 'opposite commit-language rules' },
    ]);
    // No quiet items and no promotable items → only the two pair queries ran.
    expect(calls).toHaveLength(2);
  });

  it('keeps successful sidecar lanes, reports failed lanes, and never reuses an incomplete result', async () => {
    const a = memory.store.create({ content: 'Use pnpm for scripts', scope: 'personal', type: 'constraint' }, { actor: 'system' });
    const b = memory.store.create({ content: 'Run scripts with pnpm', scope: 'personal', type: 'constraint' }, { actor: 'system' });
    let conflictCalls = 0;
    let redundancyCalls = 0;
    const checkup = createCheckupService({
      memory,
      listRecentSessions: noSessions,
      callJson: async ({ system }) => {
        if (system.includes('CONTRADICTIONS')) {
          conflictCalls += 1;
          throw new Error('conflict lane unavailable');
        }
        if (system.includes('NEAR-DUPLICATES')) {
          redundancyCalls += 1;
          return { findings: [{ memoryId: a.id, otherMemoryId: b.id, reason: 'same pnpm rule twice' }] };
        }
        throw new Error(`unexpected prompt: ${system}`);
      },
    });

    const first = await checkup.run({});
    expect(first).toEqual({
      suggestions: [{ kind: 'redundancy', memoryId: a.id, otherMemoryId: b.id, reason: 'same pnpm rule twice' }],
      cached: false,
      failedKinds: ['conflict'],
    });
    expect(checkup.needsRecompute({})).toBe(true);

    const second = await checkup.run({});
    expect(second.failedKinds).toEqual(['conflict']);
    expect(second.cached).toBe(false);
    expect(conflictCalls).toBe(2);
    expect(redundancyCalls).toBe(2);
  });

  it('treats a malformed lane payload as failed instead of a clean empty result', async () => {
    memory.store.create({ content: 'A stable rule', scope: 'personal', type: 'constraint' }, { actor: 'system' });
    const checkup = createCheckupService({
      memory,
      listRecentSessions: noSessions,
      callJson: async ({ system }) => system.includes('CONTRADICTIONS')
        ? { findings: 'not-an-array' }
        : { findings: [] },
    });

    const result = await checkup.run({});
    expect(result.suggestions).toEqual([]);
    expect(result.failedKinds).toEqual(['conflict']);
    expect(checkup.needsRecompute({})).toBe(true);
  });

  it('treats a findings array as a completed lane even when individual untrusted rows are filtered', async () => {
    const item = memory.store.create({ content: 'A stable rule', scope: 'personal', type: 'constraint' }, { actor: 'system' });
    const checkup = createCheckupService({
      memory,
      listRecentSessions: noSessions,
      callJson: async ({ system }) => system.includes('CONTRADICTIONS')
        ? { findings: [{ memoryId: item.id, otherMemoryId: 'M-999', reason: 'unknown counterpart' }] }
        : { findings: [{ malformed: true }] },
    });

    const result = await checkup.run({});
    expect(result.suggestions).toEqual([]);
    expect(result.failedKinds).toBeUndefined();
    expect(checkup.needsRecompute({})).toBe(false);
  });

  it('the staleness query fires only for its shortlist, with evidence in the prompt', async () => {
    // Session clock entries dated AFTER the items' creation so the quiet
    // window (boundary = 2nd-most-recent session start) opens behind them.
    const sessions = [
      { id: 's-3', startedAt: '2999-01-03T00:00:00.000Z' },
      { id: 's-2', startedAt: '2999-01-02T00:00:00.000Z' },
      { id: 's-1', startedAt: '2999-01-01T00:00:00.000Z' },
    ];
    // Quiet candidate: created long ago, never referenced since the boundary.
    const quiet = memory.store.create(
      { content: 'Staging maintenance window this week', scope: 'project', projectId: 'P1', type: 'fact' },
      { actor: 'system' },
    );

    const { call, calls } = routedCaller([
      { match: 'CONTRADICTIONS', response: { findings: [] } },
      { match: 'NEAR-DUPLICATES', response: { findings: [] } },
      {
        match: 'STOPPED BEING TRUE',
        response: { findings: [{ memoryId: quiet.id, reason: 'time-bound window has passed' }] },
      },
    ]);
    const checkup = createCheckupService({
      memory,
      callJson: call,
      listRecentSessions: () => sessions,
    });

    const result = await checkup.run({ projectId: 'P1', sessionId: 'chat-1' });
    expect(result.suggestions).toEqual([
      { kind: 'staleness', memoryId: quiet.id, reason: 'time-bound window has passed' },
    ]);
    expect(calls).toHaveLength(3); // no promotion query exists anymore
    const stalePrompt = calls.find((c) => c.system.includes('STOPPED BEING TRUE'))!;
    expect(stalePrompt.user).toContain('no reference in the last');
  });

  it('invalidates staleness results when the date changes and the shortlist is non-empty', async () => {
    const sessions = [
      { id: 's-3', startedAt: '2999-01-03T00:00:00.000Z' },
      { id: 's-2', startedAt: '2999-01-02T00:00:00.000Z' },
    ];
    memory.store.create(
      { content: 'Temporary migration window closes this week', scope: 'project', projectId: 'P1', type: 'fact' },
      { actor: 'system' },
    );
    let today = new Date('2026-08-16T12:00:00.000Z');
    const { call } = routedCaller([
      { match: 'CONTRADICTIONS', response: { findings: [] } },
      { match: 'NEAR-DUPLICATES', response: { findings: [] } },
      { match: 'STOPPED BEING TRUE', response: { findings: [] } },
    ]);
    const checkup = createCheckupService({
      memory,
      callJson: call,
      listRecentSessions: () => sessions,
      now: () => today,
    });

    await checkup.run({ projectId: 'P1', sessionId: 'chat-1' });
    expect(checkup.needsRecompute({ projectId: 'P1', sessionId: 'chat-1' })).toBe(false);

    today = new Date('2026-08-17T12:00:00.000Z');

    expect(checkup.needsRecompute({ projectId: 'P1', sessionId: 'chat-1' })).toBe(true);
  });

  it('invalidates a staleness result when Keep refreshes quiet-session evidence', async () => {
    const item = memory.store.create(
      { content: 'Temporary migration window closes this week', scope: 'project', projectId: 'P1', type: 'fact' },
      { actor: 'system' },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const boundary = new Date().toISOString();
    const sessions = [
      { id: 's-3', startedAt: boundary },
      { id: 's-2', startedAt: boundary },
    ];
    const { call } = routedCaller([
      { match: 'CONTRADICTIONS', response: { findings: [] } },
      { match: 'NEAR-DUPLICATES', response: { findings: [] } },
      { match: 'STOPPED BEING TRUE', response: { findings: [] } },
    ]);
    const ctx = { projectId: 'P1', sessionId: 'chat-1' };
    const checkup = createCheckupService({ memory, callJson: call, listRecentSessions: () => sessions });

    await checkup.run(ctx);
    expect(checkup.needsRecompute(ctx)).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 5));
    memory.store.renewMemory(item.id, { actor: 'user' });

    expect(checkup.needsRecompute(ctx)).toBe(true);
  });

  it('reuses pair-check results across dates when there is no staleness shortlist', async () => {
    memory.store.create({ content: 'Use bun for scripts', scope: 'personal', type: 'constraint' }, { actor: 'system' });
    let today = new Date('2026-08-16T12:00:00.000Z');
    let queries = 0;
    const { call } = routedCaller([
      { match: 'CONTRADICTIONS', response: () => ((queries += 1), { findings: [] }) },
      { match: 'NEAR-DUPLICATES', response: () => ((queries += 1), { findings: [] }) },
    ]);
    const checkup = createCheckupService({ memory, callJson: call, listRecentSessions: noSessions, now: () => today });

    await checkup.run({ sessionId: 'chat-1' });
    today = new Date('2026-08-17T12:00:00.000Z');

    expect(checkup.needsRecompute({ sessionId: 'chat-1' })).toBe(false);
    expect((await checkup.run({ sessionId: 'chat-1' })).cached).toBe(true);
    expect(queries).toBe(2);
  });

  it('reuses unchanged library results and invalidates them on a content change', async () => {
    memory.store.create({ content: 'A rule', scope: 'personal', type: 'constraint' }, { actor: 'system' });
    let queries = 0;
    const { call } = routedCaller([
      { match: 'CONTRADICTIONS', response: () => ((queries += 1), { findings: [] }) },
      { match: 'NEAR-DUPLICATES', response: () => ((queries += 1), { findings: [] }) },
    ]);
    const checkup = createCheckupService({ memory, callJson: call, listRecentSessions: noSessions });

    expect(checkup.needsRecompute({})).toBe(true);
    const first = await checkup.run({});
    expect(first.cached).toBe(false);
    expect(queries).toBe(2);

    expect(checkup.needsRecompute({})).toBe(false);
    const second = await checkup.run({});
    expect(second.cached).toBe(true);
    expect(queries).toBe(2); // no new calls

    const item = memory.store.list({})[0]!;
    memory.store.update(item.id, { content: 'A changed rule' }, { actor: 'user' });
    expect(checkup.needsRecompute({})).toBe(true);
    const third = await checkup.run({});
    expect(third.cached).toBe(false);
    expect(queries).toBe(4);
  });

  it('invalidates a reused result when reinforcement changes without a version bump', async () => {
    const item = memory.store.create({ content: 'Use bun for scripts', scope: 'personal', type: 'constraint' }, { actor: 'system' });
    const { call } = routedCaller([
      { match: 'CONTRADICTIONS', response: { findings: [] } },
      { match: 'NEAR-DUPLICATES', response: { findings: [] } },
    ]);
    const checkup = createCheckupService({ memory, callJson: call, listRecentSessions: noSessions });

    await checkup.run({});
    expect(checkup.needsRecompute({})).toBe(false);

    memory.store.recordReinforce(item.id, { actor: 'agent' });

    expect(checkup.needsRecompute({})).toBe(true);
  });

  it('invalidates a reused pair finding when the user acknowledges the pair relation', async () => {
    const a = memory.store.create({ content: 'Use bun for scripts', scope: 'personal', type: 'constraint' }, { actor: 'system' });
    const b = memory.store.create({ content: 'Run scripts with bun', scope: 'personal', type: 'constraint' }, { actor: 'system' });
    let queries = 0;
    const { call } = routedCaller([
      { match: 'CONTRADICTIONS', response: () => ((queries += 1), { findings: [] }) },
      {
        match: 'NEAR-DUPLICATES',
        response: () => ((queries += 1), {
          findings: [{ memoryId: a.id, otherMemoryId: b.id, reason: 'same bun rule twice' }],
        }),
      },
    ]);
    const checkup = createCheckupService({ memory, callJson: call, listRecentSessions: noSessions });

    const first = await checkup.run({});
    expect(first.suggestions).toHaveLength(1);
    expect(checkup.needsRecompute({})).toBe(false);

    memory.store.addRelation(a.id, b.id, 'similar_to');

    expect(checkup.needsRecompute({})).toBe(true);
    const refreshed = await checkup.run({});
    expect(refreshed.cached).toBe(false);
    expect(refreshed.suggestions).toEqual([]);
    expect(queries).toBe(4);
  });

  it('invalidates and suppresses a pair while either memory has a pending revision', async () => {
    const a = memory.store.create({ content: 'Use the old deploy API', scope: 'personal', type: 'constraint' }, { actor: 'system' });
    const b = memory.store.create({ content: 'Use the new deploy API', scope: 'personal', type: 'constraint' }, { actor: 'system' });
    let queries = 0;
    const { call } = routedCaller([
      {
        match: 'CONTRADICTIONS',
        response: () => ((queries += 1), {
          findings: [{ memoryId: a.id, otherMemoryId: b.id, reason: 'opposite deploy APIs' }],
        }),
      },
      { match: 'NEAR-DUPLICATES', response: () => ((queries += 1), { findings: [] }) },
    ]);
    const checkup = createCheckupService({ memory, callJson: call, listRecentSessions: noSessions });

    expect((await checkup.run({})).suggestions).toHaveLength(1);

    const revision = memory.store.create(
      { content: 'Use the reviewed deploy API', scope: 'personal', type: 'constraint', status: 'candidate' },
      { actor: 'agent' },
    );
    memory.store.addRelation(revision.id, a.id, 'revises');

    expect(checkup.needsRecompute({})).toBe(true);
    const refreshed = await checkup.run({});
    expect(refreshed.suggestions).toEqual([]);
    expect(queries).toBe(4);
  });

  it('retries the sidecar against a fresh snapshot when relations change while it is running', async () => {
    const a = memory.store.create({ content: 'Commit messages in Chinese', scope: 'personal', type: 'constraint' }, { actor: 'system' });
    const b = memory.store.create({ content: 'Commit messages in English', scope: 'personal', type: 'constraint' }, { actor: 'system' });
    let queries = 0;
    let releaseFirstBatch!: () => void;
    let markFirstBatchStarted!: () => void;
    const firstBatchReleased = new Promise<void>((resolve) => {
      releaseFirstBatch = resolve;
    });
    const firstBatchStarted = new Promise<void>((resolve) => {
      markFirstBatchStarted = resolve;
    });
    const checkup = createCheckupService({
      memory,
      listRecentSessions: noSessions,
      callJson: async ({ system }) => {
        queries += 1;
        if (queries === 2) markFirstBatchStarted();
        if (queries <= 2) await firstBatchReleased;
        return system.includes('CONTRADICTIONS')
          ? { findings: [{ memoryId: a.id, otherMemoryId: b.id, reason: 'opposite commit languages' }] }
          : { findings: [] };
      },
    });

    const pending = checkup.run({});
    await firstBatchStarted;
    memory.store.addRelation(a.id, b.id, 'similar_to');
    releaseFirstBatch();

    const result = await pending;
    expect(queries).toBe(4);
    expect(result.cached).toBe(false);
    expect(result.suggestions).toEqual([]);
    expect((await checkup.run({})).cached).toBe(true);
    expect(queries).toBe(4);
  });

  it('reuses an unchanged library when the user reopens Step 2', async () => {
    memory.store.create({ content: 'A stable rule', scope: 'personal', type: 'constraint' }, { actor: 'system' });
    let queries = 0;
    const { call } = routedCaller([
      { match: 'CONTRADICTIONS', response: () => ((queries += 1), { findings: [] }) },
      { match: 'NEAR-DUPLICATES', response: () => ((queries += 1), { findings: [] }) },
    ]);
    const checkup = createCheckupService({ memory, callJson: call, listRecentSessions: noSessions });

    await checkup.run({});
    const reopened = await checkup.run({});
    expect(reopened.cached).toBe(true);
    expect(queries).toBe(2);
  });

  it('one row per memory: overlapping findings go through the merge model; dropped ids are restored', async () => {
    const sessions = [
      { id: 's-3', startedAt: '2999-01-03T00:00:00.000Z' },
      { id: 's-2', startedAt: '2999-01-02T00:00:00.000Z' },
    ];
    const both = memory.store.create(
      { content: 'Deploy needs the legacy VPN', scope: 'project', projectId: 'P1', type: 'fact' },
      { actor: 'system' },
    );
    const alsoStale = memory.store.create(
      { content: 'Temp token expires Friday', scope: 'project', projectId: 'P1', type: 'fact' },
      { actor: 'system' },
    );

    const { call } = routedCaller([
      // both.id draws a conflict finding AND a staleness finding → overlap.
      {
        match: 'CONTRADICTIONS',
        response: { findings: [{ memoryId: both.id, otherMemoryId: alsoStale.id, reason: 'VPN rule contradicts the token note' }] },
      },
      { match: 'NEAR-DUPLICATES', response: { findings: [] } },
      {
        match: 'STOPPED BEING TRUE',
        response: {
          findings: [
            { memoryId: both.id, reason: 'not referenced lately' },
            { memoryId: alsoStale.id, reason: 'expired Friday' },
          ],
        },
      },
      // Merge model keeps ONE row for the overlapping id but silently drops alsoStale.
      {
        match: 'consolidate audit findings',
        response: {
          suggestions: [
            { kind: 'staleness', memoryId: both.id, reason: 'evidence points both ways: conflicting and unused — you decide' },
          ],
        },
      },
    ]);
    const checkup = createCheckupService({ memory, callJson: call, listRecentSessions: () => sessions });

    const result = await checkup.run({ projectId: 'P1' });
    const ids = result.suggestions.map((s) => s.memoryId);
    // One row per memory, and the silently-dropped finding was restored.
    expect(ids.sort()).toEqual([both.id, alsoStale.id].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not let the merge model replace a validated pair with an unreviewed pair', async () => {
    const a = memory.store.create({ content: 'Use pnpm for scripts', scope: 'personal', type: 'constraint' }, { actor: 'system' });
    const b = memory.store.create({ content: 'Use yarn for scripts', scope: 'personal', type: 'constraint' }, { actor: 'system' });
    const c = memory.store.create({ content: 'Run scripts with pnpm', scope: 'personal', type: 'constraint' }, { actor: 'system' });
    const revision = memory.store.create(
      { content: 'Use the reviewed package manager', scope: 'personal', type: 'constraint', status: 'candidate' },
      { actor: 'agent' },
    );
    memory.store.addRelation(revision.id, b.id, 'revises');

    const { call } = routedCaller([
      {
        match: 'CONTRADICTIONS',
        response: { findings: [{ memoryId: a.id, otherMemoryId: c.id, reason: 'the pnpm rules disagree' }] },
      },
      {
        match: 'NEAR-DUPLICATES',
        response: { findings: [{ memoryId: a.id, otherMemoryId: c.id, reason: 'the pnpm rules overlap' }] },
      },
      {
        match: 'consolidate audit findings',
        response: {
          suggestions: [
            { kind: 'conflict', memoryId: a.id, otherMemoryId: b.id, reason: 'hallucinated replacement pair' },
          ],
        },
      },
    ]);
    const checkup = createCheckupService({ memory, callJson: call, listRecentSessions: noSessions });

    const result = await checkup.run({});

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toEqual(expect.objectContaining({
      kind: 'conflict',
      memoryId: a.id,
      otherMemoryId: c.id,
    }));
    expect(result.suggestions[0]?.otherMemoryId).not.toBe(b.id);
  });

  it('the merge prompt and validator cannot reintroduce retired promotion suggestions', async () => {
    const a = memory.store.create({ content: 'Use pnpm', scope: 'personal', type: 'constraint' }, { actor: 'system' });
    const b = memory.store.create({ content: 'Use npm', scope: 'personal', type: 'constraint' }, { actor: 'system' });
    const c = memory.store.create({ content: 'Run scripts with pnpm', scope: 'personal', type: 'constraint' }, { actor: 'system' });
    const { call, calls } = routedCaller([
      {
        match: 'CONTRADICTIONS',
        response: { findings: [{ memoryId: a.id, otherMemoryId: b.id, reason: 'opposite package managers' }] },
      },
      {
        match: 'NEAR-DUPLICATES',
        response: { findings: [{ memoryId: a.id, otherMemoryId: c.id, reason: 'same pnpm convention' }] },
      },
      {
        match: 'consolidate audit findings',
        response: {
          suggestions: [{ kind: 'promotion', memoryId: a.id, promoteTo: 'personal', reason: 'make it broader' }],
        },
      },
    ]);
    const checkup = createCheckupService({ memory, callJson: call, listRecentSessions: noSessions });

    const result = await checkup.run({});
    expect(result.suggestions.map((suggestion) => String(suggestion.kind))).not.toContain('promotion');
    expect(result.suggestions[0]?.kind).toBe('conflict');
    const mergeCall = calls.find((request) => request.system.includes('consolidate audit findings'))!;
    expect(mergeCall.system).not.toContain('"promotion"');
    expect(mergeCall.system).not.toContain('promoteTo');
  });
});

describe('fork prewarm (option B, 2026-08-08)', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memv2-checkup-fork-'));
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
  });
  afterEach(() => {
    memory.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('buildForkPrompt carries the library and the staleness shortlist; primeFromForkResult stores a reusable result', async () => {
    const a = memory.store.create({ content: 'Commit in Chinese', scope: 'personal', type: 'constraint' }, { actor: 'system' });
    const b = memory.store.create({ content: 'Commit in English', scope: 'personal', type: 'constraint' }, { actor: 'system' });
    let sidecarCalls = 0;
    const checkup = createCheckupService({
      memory,
      callJson: async () => {
        sidecarCalls += 1;
        return { findings: [] };
      },
      listRecentSessions: () => [],
    });

    const request = checkup.buildForkPrompt!({})!;
    expect(request.prompt).toContain('Commit in Chinese');
    expect(request.prompt).toContain('STALENESS SHORTLIST');
    expect(request.prompt).toContain('(none — return an empty staleness list)');

    const primed = await checkup.primeFromForkResult!({}, request.dependencyKey, {
      conflicts: [{ memoryId: a.id, otherMemoryId: b.id, reason: 'opposite commit-language rules' }],
      redundancy: [],
      staleness: [],
    });
    expect(primed!.suggestions).toEqual([
      { kind: 'conflict', memoryId: a.id, otherMemoryId: b.id, reason: 'opposite commit-language rules' },
    ]);

    // The turn-end result is reusable: the next gate fires zero queries.
    expect(checkup.needsRecompute({})).toBe(false);
    const next = await checkup.run({});
    expect(next.cached).toBe(true);
    expect(next.suggestions).toHaveLength(1);
    expect(sidecarCalls).toBe(0);
  });

  it('garbage fork replies prime nothing', async () => {
    memory.store.create({ content: 'x', scope: 'personal', type: 'fact' }, { actor: 'system' });
    const checkup = createCheckupService({ memory, callJson: async () => ({ findings: [] }), listRecentSessions: () => [] });
    const request = checkup.buildForkPrompt!({})!;
    expect(await checkup.primeFromForkResult!({}, request.dependencyKey, { unrelated: true })).toBeNull();
    expect(checkup.needsRecompute({})).toBe(true);
  });

  it('rejects partial fork replies so missing lanes fall back to sidecar checks', async () => {
    memory.store.create({ content: 'x', scope: 'personal', type: 'fact' }, { actor: 'system' });
    const checkup = createCheckupService({ memory, callJson: async () => ({ findings: [] }), listRecentSessions: () => [] });
    const request = checkup.buildForkPrompt!({})!;

    expect(await checkup.primeFromForkResult!({}, request.dependencyKey, {
      conflicts: [],
    })).toBeNull();
    expect(await checkup.primeFromForkResult!({}, request.dependencyKey, {
      conflicts: [],
      redundancy: [],
    })).toBeNull();
    expect(checkup.needsRecompute({})).toBe(true);
  });

  it('accepts a complete fork reply when all three lanes are explicitly empty', async () => {
    memory.store.create({ content: 'x', scope: 'personal', type: 'fact' }, { actor: 'system' });
    let sidecarCalls = 0;
    const checkup = createCheckupService({
      memory,
      callJson: async () => {
        sidecarCalls += 1;
        return { findings: [] };
      },
      listRecentSessions: () => [],
    });
    const request = checkup.buildForkPrompt!({})!;

    expect(await checkup.primeFromForkResult!({}, request.dependencyKey, {
      conflicts: [],
      redundancy: [],
      staleness: [],
    })).toEqual({ suggestions: [], cached: false });
    expect(checkup.needsRecompute({})).toBe(false);
    expect((await checkup.run({})).cached).toBe(true);
    expect(sidecarCalls).toBe(0);
  });

  it('rejects a fork result when the library changed after its prompt was built', async () => {
    const item = memory.store.create({ content: 'Use the old deploy API', scope: 'personal', type: 'constraint' }, { actor: 'system' });
    const checkup = createCheckupService({ memory, callJson: async () => ({ findings: [] }), listRecentSessions: () => [] });
    const request = checkup.buildForkPrompt!({})!;

    expect(request).toEqual(expect.objectContaining({
      prompt: expect.stringContaining('Use the old deploy API'),
      dependencyKey: expect.any(String),
    }));

    memory.store.update(item.id, { content: 'Use the new deploy API' }, { actor: 'user' });

    const primed = await checkup.primeFromForkResult!({}, request.dependencyKey, {
      conflicts: [],
      redundancy: [],
      staleness: [],
    });
    expect(primed).toBeNull();
    expect(checkup.needsRecompute({})).toBe(true);
  });

  it('rejects a fork result when a pair relation changed after its prompt was built', async () => {
    const a = memory.store.create({ content: 'Use bun for scripts', scope: 'personal', type: 'constraint' }, { actor: 'system' });
    const b = memory.store.create({ content: 'Run scripts with bun', scope: 'personal', type: 'constraint' }, { actor: 'system' });
    const checkup = createCheckupService({ memory, callJson: async () => ({ findings: [] }), listRecentSessions: () => [] });
    const request = checkup.buildForkPrompt!({})!;

    memory.store.addRelation(a.id, b.id, 'similar_to');

    expect(await checkup.primeFromForkResult!({}, request.dependencyKey, {
      conflicts: [],
      redundancy: [{ memoryId: a.id, otherMemoryId: b.id, reason: 'same bun rule twice' }],
      staleness: [],
    })).toBeNull();
    expect(checkup.needsRecompute({})).toBe(true);
  });
});
