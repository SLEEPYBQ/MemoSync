import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeepSeekJsonRequest, LlmJsonCaller } from './deepseek';
import { MemoryService } from './index';
import { createTransferDetectService, TRANSFER_DECLINED_PREFIX } from './transfer-detect';
import { createTransferService, type TransferService } from './transfer';

let dir: string;
let memory: MemoryService;

const PROJECTS = [
  { id: 'P1', title: 'Current Project' },
  { id: 'P2', title: 'Alpha Shop' },
];

interface ServiceOptions {
  detector?: Record<string, unknown> | ((request: DeepSeekJsonRequest) => Record<string, unknown>);
  sessions?: Array<{ id: string; startedAt: string }>;
  encode?: Record<string, unknown>;
  decode?: Record<string, unknown> | ((request: DeepSeekJsonRequest) => Record<string, unknown>);
  transfer?: TransferService;
}

function makeService(options: ServiceOptions = {}) {
  const detectorCalls: DeepSeekJsonRequest[] = [];
  const transferCalls: DeepSeekJsonRequest[] = [];
  const callJson: LlmJsonCaller = async (request) => {
    detectorCalls.push(request);
    return typeof options.detector === 'function'
      ? options.detector(request)
      : (options.detector ?? { suggestions: [] });
  };
  const transfer = options.transfer ?? createTransferService({
    callJson: async (request) => {
      transferCalls.push(request);
      if (request.system.includes('ENCODE step')) {
        return options.encode ?? { rule: 'portable rule', applicability: 'matching work', portable: true, note: '' };
      }
      return typeof options.decode === 'function'
        ? options.decode(request)
        : (options.decode ?? {
            content: 'localized for this task',
            abstractionLevel: 'contextual',
            suggestedScope: 'project',
            landingRoute: 'new',
            note: '',
          });
    },
  });
  return {
    service: createTransferDetectService({
      memory,
      callJson,
      transfer,
      listRecentSessions: () => options.sessions ?? [],
      listProjects: () => PROJECTS,
    }),
    detectorCalls,
    transferCalls,
  };
}

function foreign(content = 'Vite dev server needs --host in Docker') {
  return memory.store.create(
    { content, scope: 'project', projectId: 'P2', type: 'lesson' },
    { actor: 'system' },
  );
}

describe('automatic Transfer: prepared source rules -> task-local landing', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memv2-transfer-detect-'));
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
  });

  afterEach(() => {
    memory.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('prepares only other conversations and other projects, never the current visible context', async () => {
    const currentSession = memory.store.create(
      { content: 'Current chat fact', scope: 'session', sessionId: 'chat-1', type: 'fact' },
      { actor: 'system' },
    );
    const currentProject = memory.store.create(
      { content: 'Current project rule', scope: 'project', projectId: 'P1', type: 'constraint' },
      { actor: 'system' },
    );
    const otherSession = memory.store.create(
      { content: 'Flaky checkout test', scope: 'session', sessionId: 'chat-2', type: 'fact' },
      { actor: 'system' },
    );
    const otherProject = foreign();
    const { service, transferCalls } = makeService({ sessions: [{ id: 'chat-2', startedAt: '2026-01-01' }] });

    await service.prepareSources({ projectId: 'P1', sessionId: 'chat-1', projectTitle: 'Current Project' });
    const prompt = service.buildTaskForkPrompt({
      projectId: 'P1',
      sessionId: 'chat-1',
      projectTitle: 'Current Project',
      taskText: 'dockerize checkout',
    })!;

    expect(transferCalls.filter((call) => call.system.includes('ENCODE step'))).toHaveLength(2);
    expect(prompt).toContain(otherSession.id);
    expect(prompt).toContain(otherProject.id);
    expect(prompt).not.toContain(currentSession.id);
    expect(prompt).not.toContain(currentProject.id);
    expect(prompt).not.toContain('WIDENING');
  });

  it('same source version/profile encodes once, including after usage and reinforcement changes', async () => {
    const source = foreign();
    const { service, transferCalls } = makeService();
    const ctx = { projectId: 'P1', sessionId: 'chat-1' };

    await service.prepareSources(ctx);
    memory.store.recordUse(source.id, { actor: 'agent', via: 'citation' });
    memory.store.recordReinforce(source.id, { actor: 'agent' });
    await service.prepareSources(ctx);

    expect(memory.store.getById(source.id)!.version).toBe(1);
    expect(transferCalls.filter((call) => call.system.includes('ENCODE step'))).toHaveLength(1);
  });

  it('re-encodes when the source content version changes', async () => {
    const source = foreign();
    const { service, transferCalls } = makeService();
    const ctx = { projectId: 'P1' };
    await service.prepareSources(ctx);

    memory.store.update(source.id, { content: 'Vite needs an explicit host binding in containers' }, { actor: 'user' });
    await service.prepareSources(ctx);

    expect(memory.store.getById(source.id)!.version).toBe(2);
    expect(transferCalls.filter((call) => call.system.includes('ENCODE step'))).toHaveLength(2);
  });

  it('shares concurrent preparation for the same source/profile', async () => {
    foreign();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let encodeCalls = 0;
    const transfer: TransferService = {
      encode: async () => {
        encodeCalls += 1;
        await blocked;
        return { rule: 'portable rule', portable: true, note: '' };
      },
      decode: async () => { throw new Error('unused'); },
      propose: async () => { throw new Error('unused'); },
    };
    const { service } = makeService({ transfer });

    const first = service.prepareSources({ projectId: 'P1' });
    const second = service.prepareSources({ projectId: 'P1' });
    await Promise.resolve();
    expect(encodeCalls).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(encodeCalls).toBe(1);
  });

  it('bounds source Encode concurrency at four while preparing a full shelf', async () => {
    for (let index = 0; index < 5; index += 1) foreign(`portable source ${index}`);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let active = 0;
    let peak = 0;
    const transfer: TransferService = {
      encode: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await blocked;
        active -= 1;
        return { rule: 'portable rule', portable: true, note: '' };
      },
      decode: async () => { throw new Error('unused'); },
      propose: async () => { throw new Error('unused'); },
    };
    const { service } = makeService({ transfer });

    const preparation = service.prepareSources({ projectId: 'P1' });
    for (let attempt = 0; attempt < 20 && active < 4; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(active).toBe(4);
    expect(peak).toBe(4);
    release();
    await preparation;
    expect(peak).toBe(4);
  });

  it('re-runs relevance for every prompt and never reuses an old card', async () => {
    const source = foreign();
    const { service, detectorCalls, transferCalls } = makeService({
      detector: (request) => ({
        suggestions: request.user.includes('dockerize') ? [{ memoryId: source.id }] : [],
      }),
    });
    const base = { projectId: 'P1', sessionId: 'chat-1', projectTitle: 'Current Project' };
    await service.prepareSources(base);

    const first = await service.runTask({ ...base, taskText: 'dockerize the app', recentContext: 'prior turn' });
    const second = await service.runTask({ ...base, taskText: 'write a poem', recentContext: 'prior turn' });

    expect(first.cards).toHaveLength(1);
    expect(second.cards).toHaveLength(0);
    expect(detectorCalls).toHaveLength(2);
    expect(detectorCalls[0]!.user).toContain('dockerize the app');
    expect(detectorCalls[1]!.user).toContain('write a poem');
    expect(transferCalls.filter((call) => call.system.includes('ENCODE step'))).toHaveLength(1);
    expect(transferCalls.filter((call) => call.system.includes('DECODE step'))).toHaveLength(1);
  });

  it('portable:false rules never reach relevance or Decode', async () => {
    foreign('The flaky test is test/checkout.spec.ts');
    const { service, detectorCalls, transferCalls } = makeService({
      encode: { rule: 'source-only pointer', portable: false, note: '' },
    });
    const ctx = { projectId: 'P1', taskText: 'fix checkout' };
    await service.prepareSources(ctx);

    expect(service.buildTaskForkPrompt(ctx)).toBeNull();
    expect((await service.runTask(ctx)).cards).toHaveLength(0);
    expect(detectorCalls).toHaveLength(0);
    expect(transferCalls.filter((call) => call.system.includes('DECODE step'))).toHaveLength(0);
  });

  it('validates, deduplicates, and caps relevance picks at three before Decode', async () => {
    const sources = [foreign('rule one'), foreign('rule two'), foreign('rule three'), foreign('rule four')];
    const { service, transferCalls } = makeService({
      detector: {
        suggestions: [
          ...sources.map((source) => ({ memoryId: source.id })),
          { memoryId: sources[0]!.id },
          { memoryId: 'M-999' },
        ],
      },
    });
    const ctx = { projectId: 'P1', taskText: 'use all matching rules' };
    await service.prepareSources(ctx);

    const result = await service.runTask(ctx);

    expect(result.cards).toHaveLength(3);
    expect(transferCalls.filter((call) => call.system.includes('DECODE step'))).toHaveLength(3);
  });

  it('invalid fork output returns null so the caller can fall back; valid output uses current task for Decode', async () => {
    const source = foreign();
    const { service, transferCalls } = makeService();
    const ctx = { projectId: 'P1', taskText: 'dockerize now', recentContext: 'earlier architecture discussion' };
    await service.prepareSources(ctx);

    expect(await service.materializeTaskFromFork(ctx, { unrelated: true })).toBeNull();
    const result = await service.materializeTaskFromFork(ctx, { suggestions: [{ memoryId: source.id }] });

    expect(result?.cards).toHaveLength(1);
    const decode = transferCalls.find((call) => call.system.includes('DECODE step'))!;
    expect(decode.user).toContain('dockerize now');
    expect(decode.user).toContain('earlier architecture discussion');
  });

  it('Candidate target-pool mutation refreshes only Decode/landing, not relevance', async () => {
    const source = foreign();
    const { service, detectorCalls, transferCalls } = makeService({
      detector: { suggestions: [{ memoryId: source.id }] },
      decode: (request) => ({
        content: request.user.includes('accepted candidate') ? 'landing after candidate' : 'landing before candidate',
        abstractionLevel: 'contextual',
        suggestedScope: 'project',
        landingRoute: 'new',
        note: '',
      }),
    });
    const ctx = { projectId: 'P1', sessionId: 'chat-1', taskText: 'dockerize it' };
    await service.prepareSources(ctx);
    const before = await service.runTask(ctx);
    memory.store.create(
      { content: 'accepted candidate', scope: 'project', projectId: 'P1', type: 'constraint' },
      { actor: 'user' },
    );

    const refreshed = await service.refreshLandingsIfTargetChanged(ctx, before);

    expect(before.cards[0]!.decoding.content).toBe('landing before candidate');
    expect(refreshed.cards[0]!.decoding.content).toBe('landing after candidate');
    expect(detectorCalls).toHaveLength(1);
    expect(transferCalls.filter((call) => call.system.includes('DECODE step'))).toHaveLength(2);
  });

  it('keeps an other-session source selected when a target-project Candidate changes only the landing pool', async () => {
    const source = memory.store.create(
      { content: 'Flaky checkout tests need isolated fixtures', scope: 'session', sessionId: 'chat-2', type: 'lesson' },
      { actor: 'system' },
    );
    memory.store.create(
      { content: 'The source conversation uses Playwright', scope: 'session', sessionId: 'chat-2', type: 'fact' },
      { actor: 'system' },
    );
    const { service, transferCalls } = makeService({
      sessions: [{ id: 'chat-2', startedAt: '2026-01-01' }],
      detector: { suggestions: [{ memoryId: source.id }] },
    });
    const ctx = { projectId: 'P1', sessionId: 'chat-1', projectTitle: 'Current Project', taskText: 'fix checkout' };
    await service.prepareSources(ctx);
    const before = await service.runTask(ctx);

    memory.store.create(
      { content: 'accepted target-project Candidate', scope: 'project', projectId: 'P1', type: 'constraint' },
      { actor: 'user' },
    );
    await service.prepareSources(ctx);
    const refreshed = await service.refreshLandingsIfTargetChanged(ctx, before);

    expect(refreshed.cards.map((card) => card.sourceId)).toEqual([source.id]);
    expect(transferCalls.filter((call) => call.system.includes('ENCODE step'))).toHaveLength(2);
    expect(transferCalls.filter((call) => call.system.includes('DECODE step'))).toHaveLength(2);
  });

  it('re-encodes other-session rules when their source-session representative changes', async () => {
    memory.store.create(
      { content: 'Flaky checkout tests need isolated fixtures', scope: 'session', sessionId: 'chat-2', type: 'lesson' },
      { actor: 'system' },
    );
    const representative = memory.store.create(
      { content: 'The source conversation uses Playwright', scope: 'session', sessionId: 'chat-2', type: 'fact' },
      { actor: 'system' },
    );
    const { service, transferCalls } = makeService({
      sessions: [{ id: 'chat-2', startedAt: '2026-01-01' }],
    });
    const ctx = { projectId: 'P1', sessionId: 'chat-1', projectTitle: 'Current Project' };
    await service.prepareSources(ctx);

    memory.store.update(
      representative.id,
      { content: 'The source conversation uses Vitest and Playwright' },
      { actor: 'user' },
    );
    await service.prepareSources(ctx);

    expect(transferCalls.filter((call) => call.system.includes('ENCODE step'))).toHaveLength(4);
  });

  it('retains the relevance selection so a Candidate-triggered refresh can retry a failed Decode', async () => {
    const source = foreign();
    let decodeCalls = 0;
    const transfer: TransferService = {
      encode: async () => ({ rule: 'portable rule', portable: true, note: '' }),
      decode: async () => {
        decodeCalls += 1;
        if (decodeCalls === 1) throw new Error('transient decode failure');
        return {
          content: 'landing after retry',
          abstractionLevel: 'contextual',
          suggestedScope: 'project',
          landing: { route: 'new' },
          note: '',
        };
      },
      propose: async () => { throw new Error('unused'); },
    };
    const { service } = makeService({ detector: { suggestions: [{ memoryId: source.id }] }, transfer });
    const ctx = { projectId: 'P1', taskText: 'dockerize it' };
    await service.prepareSources(ctx);
    const failed = await service.runTask(ctx);
    expect(failed.cards).toHaveLength(0);

    memory.store.create(
      { content: 'accepted candidate', scope: 'project', projectId: 'P1', type: 'fact' },
      { actor: 'user' },
    );
    const retried = await service.refreshLandingsIfTargetChanged(ctx, failed);

    expect(retried.cards[0]!.decoding.content).toBe('landing after retry');
    expect(decodeCalls).toBe(2);
  });

  it('drops a source that changes during Decode before any completed row is published', async () => {
    const source = foreign();
    let releaseDecode!: () => void;
    const decodeBlocked = new Promise<void>((resolve) => { releaseDecode = resolve; });
    let decodeStarted!: () => void;
    const started = new Promise<void>((resolve) => { decodeStarted = resolve; });
    const transfer: TransferService = {
      encode: async () => ({ rule: 'portable rule', portable: true, note: '' }),
      decode: async () => {
        decodeStarted();
        await decodeBlocked;
        return {
          content: 'stale landing must never publish',
          abstractionLevel: 'contextual',
          suggestedScope: 'project',
          landing: { route: 'new' },
          note: '',
        };
      },
      propose: async () => { throw new Error('unused'); },
    };
    const { service } = makeService({ detector: { suggestions: [{ memoryId: source.id }] }, transfer });
    const ctx = { projectId: 'P1', taskText: 'dockerize it' };
    await service.prepareSources(ctx);
    const progress: Array<{ decoding?: { content: string } }> = [];
    const run = service.runTask(ctx, {
      onProgress: (rows) => progress.push(...rows),
    });
    await started;

    memory.store.update(source.id, { content: 'source changed during Decode' }, { actor: 'user' });
    releaseDecode();
    const result = await run;

    expect(result.cards).toHaveLength(0);
    expect(progress.some((row) => row.decoding?.content === 'stale landing must never publish')).toBe(false);
  });

  it('does not refresh landing when Candidate review leaves the active target pool unchanged', async () => {
    const source = foreign();
    const { service, detectorCalls, transferCalls } = makeService({
      detector: { suggestions: [{ memoryId: source.id }] },
    });
    const ctx = { projectId: 'P1', taskText: 'dockerize it' };
    await service.prepareSources(ctx);
    const before = await service.runTask(ctx);
    memory.store.create(
      { content: 'still pending', scope: 'project', projectId: 'P1', type: 'fact', status: 'candidate' },
      { actor: 'agent' },
    );

    const same = await service.refreshLandingsIfTargetChanged(ctx, before);

    expect(same).toBe(before);
    expect(detectorCalls).toHaveLength(1);
    expect(transferCalls.filter((call) => call.system.includes('DECODE step'))).toHaveLength(1);
  });

  it('a destination decline suppresses relevance without discarding the prepared source rule', async () => {
    const source = foreign();
    const { service, transferCalls } = makeService();
    await service.prepareSources({ projectId: 'P1' });
    memory.store.setKv(`${TRANSFER_DECLINED_PREFIX}${source.id}:P1`, 'declined');

    expect(service.buildTaskForkPrompt({ projectId: 'P1', taskText: 'dockerize' })).toBeNull();
    expect(transferCalls.filter((call) => call.system.includes('ENCODE step'))).toHaveLength(1);
  });
});
