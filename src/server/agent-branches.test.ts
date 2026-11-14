import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TranscriptEntry } from '../shared/types';
import { AgentCoordinator } from './agent';
import type { PiAgentManager } from './pi-agent';
import type { CodexAppServerManager } from './codex-app-server';
import { EventStore } from './event-store';
import type { HarnessEvent, HarnessTurn } from './harness-types';
import { MemoryService } from './memory';
import { getMemoryConfirmation, recordMemoryConfirmation } from './memory/confirmation';
import type { MemoryBranchAskOptions, MemoryBranchInput } from './memory/branch-runtime';
import { createCaptureService } from './memory/capture';
import { createCheckupService } from './memory/checkup';
import { createTransferService } from './memory/transfer';
import { createTransferDetectService } from './memory/transfer-detect';
import { handleMemoryRequest } from './memory/routes';

type MainTurnRequest = { content: string; developerInstructions?: string; onDynamicToolCall?: (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }> };
type MainSessionRequest = { sessionToken: string | null; pendingForkSessionToken?: string | null; dynamicTools?: Array<{ name: string }> };

class Events implements AsyncIterable<HarnessEvent> {
  private entries: HarnessEvent[] = [];
  private waiting: ((value: IteratorResult<HarnessEvent>) => void) | null = null;
  private ended = false;
  push(value: HarnessEvent) {
    if (this.waiting) { const waiting = this.waiting; this.waiting = null; waiting({ value, done: false }); }
    else this.entries.push(value);
  }
  close() { this.ended = true; this.waiting?.({ done: true, value: undefined }); this.waiting = null; }
  [Symbol.asyncIterator](): AsyncIterator<HarnessEvent> {
    return { next: async () => {
      const value = this.entries.shift();
      if (value) return { value, done: false };
      if (this.ended) return { done: true, value: undefined };
      return new Promise((resolve) => { this.waiting = resolve; });
    } };
  }
}

async function until(condition: () => boolean) {
  const limit = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > limit) throw new Error('Timed out waiting for branch integration');
    await Bun.sleep(5);
  }
}

function entry(value: Record<string, unknown>): TranscriptEntry {
  return { _id: crypto.randomUUID(), createdAt: Date.now(), ...value } as TranscriptEntry;
}

async function setup(options: {
  blockPreparation?: boolean;
  workingFailsOnce?: boolean;
  working?: (prompt: string) => Record<string, unknown> | Promise<Record<string, unknown>>;
  invalidAuditReplies?: number;
  getMemorySettings?: () => { enabled: boolean; learn: boolean; control: "review" | "auto" };
  getMemoryPreviewSettings?: ConstructorParameters<typeof AgentCoordinator>[0]['getMemoryPreviewSettings'];
  productionPreviewDefaults?: boolean;
  routeToolProposal?: boolean;
  candidate?: (prompt: string, options?: MemoryBranchAskOptions) => Promise<Record<string, unknown>>;
  audit?: () => Promise<void>;
  resolveCaptureRuntime?: ConstructorParameters<typeof AgentCoordinator>[0]['resolveCaptureRuntime'];
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'memosync-agent-branches-'));
  const store = new EventStore(join(directory, 'events'));
  await store.initialize();
  const project = await store.openProject(directory, 'Payment test');
  const chat = await store.createChat(project.id);
  await store.setSessionToken(chat.id, 'main-session');
  const memory = new MemoryService({ dbPath: ':memory:', dataDir: join(directory, 'memory') });
  const item = memory.store.create({ content: 'Store money as integer cents', type: 'constraint', scope: 'project', projectId: project.id }, { actor: 'user' });
  const sidecarCalls: string[] = [];
  const callJson = async () => {
    sidecarCalls.push('called');
    if (options.routeToolProposal) return { decisions: [{ index: 0, route: 'new', targetId: null }] };
    throw new Error('Unexpected sidecar');
  };
  const calls: Array<{ purpose: string; prompt: string; options?: MemoryBranchAskOptions }> = [];
  const branches: MemoryBranchInput[] = [];
  const disposed: string[] = [];
  const mainTurns: MainTurnRequest[] = [];
  const mainSessions: MainSessionRequest[] = [];
  const queues: Events[] = [];
  const codexManager = {
    startSession: async (args: MainSessionRequest) => { mainSessions.push(args); return 'main-session'; },
    startTurn: async (args: MainTurnRequest): Promise<HarnessTurn> => {
      mainTurns.push(args);
      const events = new Events();
      queues.push(events);
      return { provider: 'codex', stream: events, interrupt: async () => events.close(), close: () => events.close() };
    },
    stopSession: () => {},
    stopAll: () => {},
  } as unknown as CodexAppServerManager;
  const coordinatorArgs: ConstructorParameters<typeof AgentCoordinator>[0] = {
    store, memory, codexManager,
    resolveCaptureRuntime: options.resolveCaptureRuntime,
    piManager: {
      startTurn: async (args: MainTurnRequest): Promise<HarnessTurn> => {
        mainTurns.push(args);
        const events = new Events(); queues.push(events);
        return { provider: 'pi', stream: events, interrupt: async () => events.close(), close: () => events.close() };
      },
      closeChat: () => {}, dispose: () => {},
    } as unknown as PiAgentManager,
    resolvePiConnection: async () => ({ provider: 'openrouter', baseUrl: 'https://example.test', apiKey: 'test' }),
    onStateChange: () => {},
    getMemorySettings: options.getMemorySettings,
    getMemoryPreviewSettings: options.productionPreviewDefaults ? undefined : options.getMemoryPreviewSettings ?? (() => ({ enabled: true, autoProceedWhenEmpty: true, confirmationMode: 'every_turn' })),
    memoryPreview: true, memoryBranches: true,
    capture: createCaptureService({ memory, callJson }),
    memoryCheckup: createCheckupService({ memory, callJson, listRecentSessions: () => [] }),
    memoryTransferDetect: createTransferDetectService({ memory, callJson, transfer: createTransferService({ callJson }), listRecentSessions: () => [], listProjects: () => [] }),
    generateTitle: async () => ({ title: 'Payment test', usedFallback: true, failureMessage: null }),
    createMemoryBranch: (input) => {
      branches.push(input);
      const purpose = input.purpose!;
      let count = 0;
      return {
        id: `branch-${purpose}`, mode: 'fork', sessionToken: `child-${purpose}`,
        dispose: () => { disposed.push(purpose); },
        ask: async (prompt, askOptions) => {
          calls.push({ purpose, prompt, options: askOptions });
          count += 1;
          if (options.blockPreparation) return new Promise<Record<string, unknown>>(() => {});
          if (purpose === 'candidate') return options.candidate?.(prompt, askOptions) ?? { candidates: [] };
          if (purpose === 'transfer') return count === 1 ? { suggestions: [] } : { upsert: {}, remove: {} };
          if (purpose === 'changes') return count === 1 ? { conflicts: [], redundancy: [], staleness: [] } : { upsert: {}, remove: {} };
          if (purpose === 'working-memory') {
            if (options.working) return options.working(prompt);
            if (options.workingFailsOnce && count === 1) throw new Error('Working-memory provider unavailable');
            return { selected: [{ id: item.id, why: 'Charging the order', expectedUse: 'Represent the charge amount as integer cents.' }], reply: 'Kept the enforced money rule for this charge.' };
          }
          if (purpose === 'audit') {
            await options.audit?.();
            if (count <= (options.invalidAuditReplies ?? 0)) return { labels: [{ id: item.id, label: 'not_applicable', note: 'Missing opportunity described here, but no required missing field.' }] };
            return { labels: [{ id: item.id, label: 'violated', note: 'Decimal dollars were sent as cents', quote: 'amount=12.5', toolId: 'charge-tool', cause: 'not_followed', impact: 'none' }] };
          }
          throw new Error(`Unexpected memory branch ${purpose}`);
        },
      };
    },
  };
  const coordinator = new AgentCoordinator(coordinatorArgs);
  const send = () => coordinator.send({ type: 'chat.send', chatId: chat.id, provider: 'codex', model: 'gpt-5.4', content: 'Charge the test order for 12.50 USD' });
  const start = async () => {
    const expectedTurns = mainTurns.length + 1;
    const preview = store.getMessages(chat.id).filter((message) => message.kind === 'memory_preview').at(-1)!;
    if (preview.kind !== 'memory_preview') throw new Error('Preview missing');
    await coordinator.respondMemoryPreview({ chatId: chat.id, previewId: preview.previewId, decision: 'go_on', memoryIds: [item.id] });
    await until(() => mainTurns.length === expectedTurns);
  };
  return {
    store, memory, item, chat, coordinator, calls, branches, disposed, sidecarCalls, mainTurns, mainSessions, send, start,
    restart: () => new AgentCoordinator(coordinatorArgs),
    emit: (value: HarnessEvent) => queues.at(-1)!.push(value),
    close: () => { queues.forEach((queue) => queue.close()); memory.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function candidateResult(content: string, sensitive = false, scope = 'project') {
  return { proposalId: 'C:1', content, type: 'constraint', scope, abstractionLevel: 'contextual', sensitive, evidenceClass: 'user_stated', route: 'new' };
}

async function finish(h: Awaited<ReturnType<typeof setup>>, session = 'finished-session', isError = false) {
  h.emit({ type: 'session_token', sessionToken: session });
  h.emit({ type: 'transcript', entry: entry({ kind: 'assistant_text', text: 'Finished the task.' }) });
  h.emit({ type: 'transcript', entry: entry({ kind: 'result', subtype: isError ? 'error' : 'success', isError, durationMs: 1, result: 'Finished the task.' }) });
  await until(() => !h.coordinator.activeTurns.has(h.chat.id));
}

describe('Automatic background candidate learning', () => {
  const automatic = () => ({ enabled: true, learn: true, control: 'auto' as const });

  it('recovers queued turns with the original runtime/session and does not repeat terminal jobs', async () => {
    const first = deferred<Record<string, unknown>>();
    let runtime: any;
    let count = 0;
    const h = await setup({ getMemorySettings: automatic,
      resolveCaptureRuntime: async () => runtime,
      candidate: async () => ++count === 1 ? first.promise : { candidates: [] },
    });
    let recovered: AgentCoordinator | undefined;
    try {
      await h.send(); await finish(h, 'parent-one');
      runtime = (h.coordinator as any).sessionRuntimes.get(h.chat.id);
      await h.send(); await finish(h, 'parent-two');
      await h.coordinator.shutdownRuntime();
      expect(h.coordinator.getAutomaticCaptureOutcomes(h.chat.id).map(job => job.status)).toEqual(['running', 'pending']);
      recovered = h.restart(); recovered.recoverAutomaticCaptures();
      await until(() => recovered!.getAutomaticCaptureOutcomes(h.chat.id).every(job => job.status === 'completed'));
      expect(h.branches.filter(branch => branch.purpose === 'candidate').map(branch => branch.parentSessionToken)).toEqual(['parent-one', 'parent-one', 'parent-two']);
      const calls = count;
      recovered.recoverAutomaticCaptures();
      expect(count).toBe(calls);
      expect(recovered.getAutomaticCaptureOutcomes(h.chat.id).map(job => job.turnNumber)).toEqual([1, 2]);
    } finally { first.resolve({ candidates: [] }); await recovered?.shutdownRuntime(); await h.coordinator.shutdownRuntime(); h.close(); }
  });

  it('settles recovered jobs without a model request when the runtime identity changed', async () => {
    const first = deferred<Record<string, unknown>>();
    let runtime: any;
    const h = await setup({ getMemorySettings: automatic, resolveCaptureRuntime: async () => ({ ...runtime, env: { ...runtime.env, CHANGED_PROFILE: 'changed' } }), candidate: () => first.promise });
    let recovered: AgentCoordinator | undefined;
    try {
      await h.send(); await finish(h);
      runtime = (h.coordinator as any).sessionRuntimes.get(h.chat.id);
      await h.coordinator.shutdownRuntime();
      recovered = h.restart(); recovered.recoverAutomaticCaptures();
      await until(() => recovered!.getAutomaticCaptureOutcomes(h.chat.id)[0]?.status === 'skipped');
      expect(recovered.getAutomaticCaptureOutcomes(h.chat.id)[0]?.reason).toBe('runtime-changed');
      expect(h.calls.filter(call => call.purpose === 'candidate')).toHaveLength(1);
    } finally { first.resolve({ candidates: [] }); await recovered?.shutdownRuntime(); await h.coordinator.shutdownRuntime(); h.close(); }
  });

  for (const disable of ['chat', 'global'] as const) {
    it(`cancels active and queued capture when ${disable} memory is disabled`, async () => {
      let enabled = true;
      const first = deferred<Record<string, unknown>>();
      const h = await setup({ getMemorySettings: () => ({ ...automatic(), enabled }), candidate: () => first.promise });
      try {
        await h.send(); await finish(h);
        await h.send(); await finish(h, 'second');
        if (disable === 'chat') await h.coordinator.setMemoryDisabled(h.chat.id, true);
        else { enabled = false; h.coordinator.memorySettingsChanged(); }
        expect(h.calls.find(call => call.purpose === 'candidate')!.options!.signal!.aborted).toBe(true);
        expect(h.coordinator.getAutomaticCaptureOutcomes(h.chat.id).map(job => job.status)).toEqual(['skipped', 'skipped']);
        first.resolve({ candidates: [candidateResult('This disabled result must never land')] });
        await Bun.sleep(10);
        expect(h.calls.filter(call => call.purpose === 'candidate')).toHaveLength(1);
        expect(h.memory.store.list()).toHaveLength(1);
      } finally { first.resolve({ candidates: [] }); await h.coordinator.shutdownRuntime(); h.close(); }
    });
  }

  it('policy changes terminate every queued turn and recovery never revives those outcomes', async () => {
    const first = deferred<Record<string, unknown>>();
    const h = await setup({ getMemorySettings: automatic, candidate: () => first.promise });
    let recovered: AgentCoordinator | undefined;
    try {
      const sendPi = () => h.coordinator.send({ type: 'chat.send', chatId: h.chat.id, provider: 'pi', model: 'pi-model', content: 'Validate the charge' });
      await sendPi(); await finish(h, 'pi-one');
      await sendPi(); await finish(h, 'pi-two');
      await h.coordinator.setExecutionPolicy({ type: 'chat.setExecutionPolicy', chatId: h.chat.id,
        policy: { engine: 'pi', toolGate: 'read-only' }, expectedRevision: 1 });
      expect(h.coordinator.getAutomaticCaptureOutcomes(h.chat.id).map(job => [job.turnNumber, job.status, job.reason]))
        .toEqual([[1, 'skipped', 'execution-policy-changed'], [2, 'skipped', 'execution-policy-changed']]);
      expect(h.calls.find(call => call.purpose === 'candidate')!.options!.signal!.aborted).toBe(true);
      first.resolve({ candidates: [candidateResult('A revoked late result')] });
      await h.coordinator.shutdownRuntime();
      recovered = h.restart(); recovered.recoverAutomaticCaptures();
      expect(recovered.getAutomaticCaptureOutcomes(h.chat.id).every(job => job.status === 'skipped')).toBe(true);
      expect(h.calls.filter(call => call.purpose === 'candidate')).toHaveLength(1);
      expect(h.memory.store.list()).toHaveLength(1);
    } finally { first.resolve({ candidates: [] }); await recovered?.shutdownRuntime(); await h.coordinator.shutdownRuntime(); h.close(); }
  });

  it('a stopped completion awaiting persistence cannot capture or remove its successor', async () => {
    const h = await setup({ getMemorySettings: automatic });
    const entered = deferred<void>(), release = deferred<void>(), settled = deferred<void>();
    const record = h.store.recordTurnFinished.bind(h.store);
    h.store.recordTurnFinished = async chatId => {
      entered.resolve(); await release.promise;
      await record(chatId); settled.resolve();
    };
    try {
      await h.send();
      h.emit({ type: 'transcript', entry: entry({ kind: 'result', subtype: 'success', isError: false, durationMs: 1, result: 'Done' }) });
      await entered.promise;
      await h.coordinator.cancel(h.chat.id, { skipPostTurnMemoryPasses: true });
      await h.send();
      const successor = h.coordinator.activeTurns.get(h.chat.id);
      expect(successor).toBeDefined();
      release.resolve(); await settled.promise;
      await Bun.sleep(10);
      expect(h.coordinator.activeTurns.get(h.chat.id)).toBe(successor);
      expect(h.coordinator.getAutomaticCaptureOutcomes(h.chat.id)).toEqual([]);
      expect(h.calls.filter(call => call.purpose === 'candidate')).toHaveLength(0);
    } finally { release.resolve(); await h.coordinator.cancel(h.chat.id, { skipPostTurnMemoryPasses: true }); await h.coordinator.shutdownRuntime(); h.close(); }
  });

  it('snapshots queued credentials and parent definitions before a later launch mutates them', async () => {
    const first = deferred<Record<string, unknown>>();
    let count = 0;
    const h = await setup({ getMemorySettings: automatic, candidate: () => ++count === 1 ? first.promise : Promise.resolve({ candidates: [] }) });
    try {
      await h.send(); await finish(h, 'parent-one');
      await h.send(); await finish(h, 'parent-two');
      const coordinator = h.coordinator as any;
      const runtime = coordinator.sessionRuntimes.get(h.chat.id);
      const launch = coordinator.parentLaunches.get(h.chat.id);
      const originalModel = launch.turn.model;
      runtime.env.LATER_TURN_CREDENTIAL = 'synthetic-later';
      launch.turn.model = 'later-model';
      launch.session.dynamicTools[0].description = 'later definition';
      first.resolve({ candidates: [] });
      await until(() => h.coordinator.getAutomaticCaptureOutcomes(h.chat.id).every(job => job.status === 'completed'));
      const queued = h.branches.filter(branch => branch.purpose === 'candidate')[1]!;
      expect(queued.runtime!.env.LATER_TURN_CREDENTIAL).toBeUndefined();
      expect(queued.parentLaunch).toMatchObject({ provider: 'codex', turn: { model: originalModel } });
      if (queued.parentLaunch?.provider !== 'codex') throw new Error('Original Codex launch missing');
      expect(queued.parentLaunch.session.dynamicTools![0]!.description).not.toBe('later definition');
    } finally { first.resolve({ candidates: [] }); await h.coordinator.shutdownRuntime(); h.close(); }
  });

  it('forks only C alongside audit, boots the next turn immediately, and uses auto cards only for non-sensitive proposals', async () => {
    const result = deferred<Record<string, unknown>>();
    const audit = deferred<void>();
    const h = await setup({ getMemorySettings: automatic, candidate: () => result.promise, audit: () => audit.promise });
    try {
      await h.send();
      expect(h.calls).toHaveLength(0);
      await finish(h, 'parent-after-first');
      await until(() => h.calls.some(call => call.purpose === 'audit'));
      expect(h.calls.map(call => call.purpose).sort()).toEqual(['audit', 'candidate']);
      expect(h.branches.every(branch => branch.parentSessionToken === 'parent-after-first')).toBe(true);
      const c = h.calls.find(call => call.purpose === 'candidate')!;
      expect(c.prompt).toContain('CANDIDATE EXTRACTION');
      expect(c.prompt).toContain('NEW TASK:\nCharge the test order for 12.50 USD');
      expect(c.options?.schema).toBeDefined();
      expect(c.options?.signal?.aborted).toBe(false);
      await h.send();
      expect(h.mainTurns).toHaveLength(2);
      expect(h.coordinator.pendingPreviews.size).toBe(0);
      result.resolve({ candidates: [candidateResult('Always validate charge amounts before sending'), { ...candidateResult('Personal billing contact is private', true, 'personal'), proposalId: 'C:2' }] });
      // Audit remains unresolved: it cannot hold up capture or its card.
      await until(() => h.store.getMessages(h.chat.id).some(message => message.kind === 'memory_candidates'));
      const learned = h.memory.store.list().find(item => item.content === 'Always validate charge amounts before sending')!;
      const sensitive = h.memory.store.list().find(item => item.content === 'Personal billing contact is private')!;
      expect(learned).toMatchObject({ status: 'active', scope: 'project', projectId: h.chat.projectId, provenanceSessionId: h.chat.id, provenanceTurn: 1 });
      expect(sensitive).toMatchObject({ status: 'candidate', sensitive: true, scope: 'personal', provenanceTurn: 1 });
      expect(h.store.getMessages(h.chat.id).filter(message => message.kind === 'memory_candidates'))
        .toMatchObject([{ turn: 1, candidates: [{ id: learned.id, auto: true }] }]);
      expect(JSON.stringify(h.store.getMessages(h.chat.id))).not.toContain(sensitive.content);
      expect(h.disposed).toContain('candidate');
      expect(h.sidecarCalls).toHaveLength(0);
      audit.resolve();
      await until(() => h.disposed.includes('audit'));
      await h.coordinator.cancel(h.chat.id, { skipPostTurnMemoryPasses: true });
      expect(h.calls.filter(call => call.purpose === 'candidate')).toHaveLength(1);
    } finally { result.resolve({ candidates: [] }); audit.resolve(); await h.coordinator.shutdownRuntime(); h.close(); }
  });

  it('retains every finished turn while busy, with its own session, task and terminal outcome', async () => {
    const first = deferred<Record<string, unknown>>();
    let count = 0;
    const h = await setup({ getMemorySettings: automatic, candidate: async () => ++count === 1 ? first.promise : { candidates: [candidateResult(count === 2 ? 'Check second task amounts' : 'Validate refund inputs before submitting')] } });
    try {
      await h.send();
      await finish(h, 'parent-one');
      await h.send();
      await finish(h, 'parent-two');
      await h.coordinator.send({ type: 'chat.send', chatId: h.chat.id, provider: 'codex', model: 'gpt-5.4', content: 'Validate refunds' });
      await finish(h, 'parent-three');
      expect(count).toBe(1);
      // Starting a fourth task must not change the queued C's parent/task.
      await h.send();
      first.resolve({ candidates: [candidateResult('Validate charge inputs before submitting')] });
      await until(() => h.store.getMessages(h.chat.id).filter(message => message.kind === 'memory_candidates').length === 3);
      expect(count).toBe(3);
      expect(h.coordinator.getAutomaticCaptureOutcomes(h.chat.id).map(job => [job.turnNumber, job.status])).toEqual([[1, 'completed'], [2, 'completed'], [3, 'completed']]);
      expect(h.branches.filter(branch => branch.purpose === 'candidate').map(branch => branch.parentSessionToken)).toEqual(['parent-one', 'parent-two', 'parent-three']);
      expect(h.calls.filter(call => call.purpose === 'candidate')[2]!.prompt).toContain('NEW TASK:\nValidate refunds');
      expect(h.store.getMessages(h.chat.id).filter(message => message.kind === 'memory_candidates').map(message => message.turn)).toEqual([1, 2, 3]);
      expect(h.memory.store.list().find(item => item.content === 'Validate refund inputs before submitting')!.provenanceTurn).toBe(3);
      await h.coordinator.cancel(h.chat.id, { skipPostTurnMemoryPasses: true });
    } finally { first.resolve({ candidates: [] }); await h.coordinator.shutdownRuntime(); h.close(); }
  });

  for (const next of [{ provider: 'pi' as const, model: 'pi-model', token: 'parent-two' }, { provider: 'codex' as const, model: 'gpt-5.3-codex', token: 'parent-two' }, { provider: 'codex' as const, model: 'gpt-5.3-codex', token: 'main-session' }]) {
    it(`keeps the completed Codex launch when the next turn switches to ${next.provider}/${next.model} (token ${next.token})`, async () => {
      const first = deferred<Record<string, unknown>>();
      let count = 0;
      const h = await setup({ getMemorySettings: automatic, candidate: async () => ++count === 1 ? first.promise : { candidates: [] } });
      try {
        await h.send();
        await finish(h, 'parent-one');
        await h.send();
        await finish(h, next.token);
        await h.store.setChatProvider(h.chat.id, next.provider);
        await h.coordinator.send({ type: 'chat.send', chatId: h.chat.id, ...next, content: 'Next task' });
        first.resolve({ candidates: [] });
        await until(() => h.branches.filter(b => b.purpose === 'candidate').length === 2);
        const branch = h.branches.filter(b => b.purpose === 'candidate')[1]!;
        expect(branch.parentSessionToken).toBe(next.token);
        expect(branch.parentLaunch?.provider).toBe('codex');
        expect(branch.parentLaunch?.provider === 'codex' && branch.parentLaunch.turn.model).toBe('gpt-5.4');
        // Exact token provenance also wins for a foreground fork.
        const exact = (h.coordinator as any).newMemoryBranch({ chatId: h.chat.id, provider: 'codex', model: next.model }, 'probe', 'parent-one');
        expect(h.branches.at(-1)!.parentLaunch).toMatchObject({ provider: 'codex', turn: { model: 'gpt-5.4' } });
        exact.dispose();
      } finally { first.resolve({ candidates: [] }); await h.coordinator.shutdownRuntime(); h.close(); }
    });
  }

  it('records Codex tokens at session start and Pi tokens at stream delivery', async () => {
    const h = await setup({ getMemorySettings: automatic });
    try {
      await h.send();
      expect((h.coordinator as any).sessionLaunches.get('codex:main-session')?.provider).toBe('codex');
      await finish(h, 'codex-finished');
      await h.store.setChatProvider(h.chat.id, 'pi');
      await h.coordinator.send({ type: 'chat.send', chatId: h.chat.id, provider: 'pi', model: 'pi-model', content: 'Pi task' });
      await finish(h, 'pi-finished');
      await h.store.setChatProvider(h.chat.id, 'codex');
      await h.send();
      const branch = (h.coordinator as any).newMemoryBranch({ chatId: h.chat.id, provider: 'pi', model: 'other-pi-model' }, 'probe', 'pi-finished');
      expect(h.branches.at(-1)!.parentLaunch?.provider).toBe('pi');
      branch.dispose();
    } finally { await h.coordinator.shutdownRuntime(); h.close(); }
  });

  it('uses C routing and dismissal dedup without creating duplicate memories or sidecar calls', async () => {
    let original: Awaited<ReturnType<typeof setup>>['item'];
    const dismissedText = 'Never store this already dismissed preference';
    const h = await setup({ getMemorySettings: automatic, candidate: async () => ({ candidates: [
      { ...candidateResult(original.content), route: 'reinforces', targetId: original.id, targetVersion: original.version },
      { ...candidateResult(dismissedText), proposalId: 'C:2' },
      { ...candidateResult('A reworded dismissed preference'), proposalId: 'C:3', route: 'reinforces-dismissed' },
    ] }) });
    try {
      original = h.item;
      const dismissed = h.memory.store.create({ content: dismissedText, type: 'preference', scope: 'project', projectId: h.chat.projectId, status: 'candidate' }, { actor: 'user' });
      h.memory.store.dismissCandidate(dismissed.id, { actor: 'user' });
      await h.send();
      await finish(h);
      await until(() => h.disposed.includes('candidate') && h.disposed.includes('audit'));
      expect(h.calls.find(call => call.purpose === 'candidate')!.prompt).toContain(dismissedText);
      expect(h.memory.store.list({ status: 'active' })).toHaveLength(1);
      expect(h.memory.store.list({ status: 'candidate' })).toHaveLength(0);
      expect(h.store.getMessages(h.chat.id).some(message => message.kind === 'memory_candidates')).toBe(false);
      expect(h.sidecarCalls).toHaveLength(0);
    } finally { await h.coordinator.shutdownRuntime(); h.close(); }
  });

  it('rejects stale routing when the store changes during C and learns again on a later turn', async () => {
    const result = deferred<Record<string, unknown>>();
    let count = 0;
    const h = await setup({ getMemorySettings: automatic, candidate: async () => ++count === 1 ? result.promise : { candidates: [candidateResult('New valid observation')] } });
    try {
      await h.send();
      await finish(h);
      h.memory.store.update(h.item.id, { content: 'A new rule the candidate did not see' }, { actor: 'user' });
      result.resolve({ candidates: [candidateResult('Observation from a stale snapshot')] });
      await until(() => h.disposed.includes('candidate') && h.disposed.includes('audit'));
      expect(h.memory.store.list()).toHaveLength(1);
      await h.send();
      await finish(h);
      await until(() => h.store.getMessages(h.chat.id).some(message => message.kind === 'memory_candidates'));
      expect(h.memory.store.list().some(item => item.content === 'Observation from a stale snapshot')).toBe(false);
      expect(h.memory.store.list().find(item => item.content === 'New valid observation')!.status).toBe('active');
      expect(count).toBe(2);
    } finally { result.resolve({ candidates: [] }); await h.coordinator.shutdownRuntime(); h.close(); }
  });

  for (const settings of [
    { enabled: true, learn: false, control: 'auto' as const },
    { enabled: false, learn: true, control: 'auto' as const },
    { enabled: true, learn: true, control: 'review' as const },
  ]) {
    it(`does not launch post-turn C with settings ${JSON.stringify(settings)}`, async () => {
      const h = await setup({ getMemorySettings: () => settings });
      try {
        await h.send();
        if (settings.control === 'review') {
          await until(() => h.store.getMessages(h.chat.id).some(message => message.kind === 'memory_preview_relevance'));
          await h.start();
        }
        const before = h.calls.filter(call => call.purpose === 'candidate').length;
        await finish(h);
        await until(() => h.disposed.includes('audit') || !settings.enabled);
        expect(h.calls.filter(call => call.purpose === 'candidate')).toHaveLength(before);
      } finally { await h.coordinator.shutdownRuntime(); h.close(); }
    });
  }

  for (const outcome of ['cancelled', 'failed', 'memory-disabled'] as const) {
    it(`does not learn from a ${outcome} turn`, async () => {
      const h = await setup({ getMemorySettings: automatic });
      try {
        if (outcome === 'memory-disabled') await h.store.setMemoryDisabled(h.chat.id, true);
        await h.send();
        if (outcome === 'cancelled') await h.coordinator.cancel(h.chat.id);
        else await finish(h, 'finished', outcome === 'failed');
        expect(h.calls.filter(call => call.purpose === 'candidate')).toHaveLength(0);
      } finally { await h.coordinator.shutdownRuntime(); h.close(); }
    });
  }

  for (const stop of ['closeChat', 'shutdownRuntime'] as const) {
    it(`${stop} aborts C, stops queued turns, and prevents late writes even when the transport ignores abort`, async () => {
      const result = deferred<Record<string, unknown>>();
      const h = await setup({ getMemorySettings: automatic, candidate: () => result.promise });
      try {
        await h.send();
        await finish(h);
        await h.send();
        await finish(h, 'second');
        await until(() => h.disposed.filter(purpose => purpose === 'audit').length === 2);
        if (stop === 'closeChat') await h.coordinator.closeChat(h.chat.id);
        else await h.coordinator.shutdownRuntime();
        expect(h.calls.find(call => call.purpose === 'candidate')!.options?.signal?.aborted).toBe(true);
        expect(h.disposed.filter(purpose => purpose === 'candidate')).toHaveLength(1);
        result.resolve({ candidates: [candidateResult('This late proposal must never persist')] });
        await Bun.sleep(10);
        expect(h.calls.filter(call => call.purpose === 'candidate')).toHaveLength(1);
        expect(h.memory.store.list()).toHaveLength(1);
        expect(h.store.getMessages(h.chat.id).some(message => message.kind === 'memory_candidates')).toBe(false);
      } finally { result.resolve({ candidates: [] }); await h.coordinator.shutdownRuntime(); h.close(); }
    });
  }

  it('continues the queued run after a failed analysis without falling back to sidecars', async () => {
    const first = deferred<Record<string, unknown>>();
    let count = 0;
    const h = await setup({ getMemorySettings: automatic, candidate: async () => ++count === 1 ? first.promise : { candidates: [candidateResult('Recover learning on the next completed task')] } });
    try {
      await h.send();
      await finish(h);
      await h.send();
      await finish(h, 'second');
      first.reject(new Error('Provider unavailable'));
      await until(() => h.store.getMessages(h.chat.id).some(message => message.kind === 'memory_candidates'));
      expect(count).toBe(2);
      expect(h.sidecarCalls).toHaveLength(0);
      expect(h.store.getMessages(h.chat.id).filter(message => message.kind === 'memory_candidates')).toMatchObject([{ turn: 2 }]);
    } finally { await h.coordinator.shutdownRuntime(); h.close(); }
  });
});

describe('AgentCoordinator persistent Codex memory branches', () => {
  it('confirms by chat and version, then automatically starts unchanged subsets with exact selection', async () => {
    const selected: string[] = [];
    const h = await setup({ getMemorySettings: () => ({ enabled: true, learn: false, control: 'review' }), productionPreviewDefaults: true,
      working: () => ({ selected: selected.map(id => ({ id, why: 'Relevant', expectedUse: `Apply ${id} to this task.` })) }) });
    try {
      const second = h.memory.store.create({ content: 'Use the synthetic alternate rule.', scope: 'personal', type: 'fact' }, { actor: 'user' });
      const unselected = h.memory.store.create({ content: 'Never select this synthetic rule.', scope: 'personal', type: 'fact' }, { actor: 'user' });
      selected.push(h.item.id, second.id);
      await h.send();
      await until(() => h.store.getMessages(h.chat.id).some(message => message.kind === 'memory_preview_relevance'));
      const preview = h.store.getMessages(h.chat.id).find(message => message.kind === 'memory_preview')!;
      if (preview.kind !== 'memory_preview') throw new Error('Preview missing');
      expect(preview.confirmationMode).toBe('on_change');
      expect(h.mainTurns).toHaveLength(0);
      await h.coordinator.respondMemoryPreview({ chatId: h.chat.id, previewId: preview.previewId, decision: 'go_on', memoryIds: selected });
      await until(() => h.mainTurns.length === 1);
      await finish(h);
      await h.send();
      await until(() => h.mainTurns.length === 2);
      let decision = h.store.getMessages(h.chat.id).filter(message => message.kind === 'memory_preview_decision').at(-1)!;
      expect(decision).toMatchObject({ auto: true, autoReason: 'confirmed' });
      if (decision.kind !== 'memory_preview_decision') throw new Error('Decision missing');
      expect([...decision.selectedIds!].sort()).toEqual([...selected].sort());
      await finish(h, 'second');
      selected.splice(0, selected.length, second.id);
      await h.send();
      await until(() => h.mainTurns.length === 3);
      decision = h.store.getMessages(h.chat.id).filter(message => message.kind === 'memory_preview_decision').at(-1)!;
      expect(decision).toMatchObject({ auto: true, autoReason: 'confirmed', selectedIds: [second.id] });
      expect(h.mainTurns[2]!.developerInstructions).toContain(second.content);
      expect(h.mainTurns[2]!.developerInstructions).not.toContain(h.item.content);
      expect(h.mainTurns[2]!.developerInstructions).not.toContain(unselected.content);
      await finish(h, 'third');
      const auditCalls = () => h.calls.filter(call => call.purpose === 'audit' && call.prompt.includes('INJECTED MEMORY SNAPSHOT:\n'));
      await until(() => auditCalls().length >= 3);
      const auditPrompt = auditCalls().at(-1)!.prompt;
      const auditSnapshot = JSON.parse(auditPrompt.split('INJECTED MEMORY SNAPSHOT:\n')[1]!.split('\n')[0]!);
      expect(auditSnapshot.map((memory: { id: string }) => memory.id)).toEqual([second.id]);
    } finally { await h.coordinator.cancel(h.chat.id, { skipPostTurnMemoryPasses: true }); await h.coordinator.shutdownRuntime(); h.close(); }
  });

  for (const reason of ['first', 'changed', 'removed', 'enforced'] as const) {
    it(`requires review for a selected ${reason} memory`, async () => {
      let chosen = '';
      const h = await setup({ getMemorySettings: () => ({ enabled: true, learn: false, control: 'review' }),
        getMemoryPreviewSettings: () => ({ enabled: true, autoProceedWhenEmpty: true, confirmationMode: 'on_change' }),
        working: () => ({ selected: [{ id: chosen, why: 'Relevant', expectedUse: 'Apply this rule.' }] }) });
      try {
        recordMemoryConfirmation(h.memory.store, h.chat.id, [h.item], []);
        let item = h.item;
        if (reason === 'first') item = h.memory.store.create({ content: 'A new synthetic rule', scope: 'personal', type: 'fact' }, { actor: 'user' });
        if (reason === 'changed') item = h.memory.store.update(item.id, { content: 'Updated synthetic rule' }, { actor: 'user' });
        if (reason === 'removed') recordMemoryConfirmation(h.memory.store, h.chat.id, [], [item.id]);
        if (reason === 'enforced') h.memory.store.setKv(`pay_attention:${h.chat.id}`, [item.id]);
        chosen = item.id;
        await h.send();
        await until(() => h.store.getMessages(h.chat.id).some(message => message.kind === 'memory_preview_relevance'));
        const relevance = h.store.getMessages(h.chat.id).find(message => message.kind === 'memory_preview_relevance')!;
        expect(relevance).toMatchObject({ confirmationReasons: [expect.objectContaining({ id: item.id, reason })] });
        expect(h.coordinator.pendingPreviews.has(h.chat.id)).toBe(true);
        expect(h.mainTurns).toHaveLength(0);
      } finally { await h.coordinator.cancel(h.chat.id, { skipPostTurnMemoryPasses: true }); await h.coordinator.shutdownRuntime(); h.close(); }
    });
  }

  it('without memory marks proposed items removed without confirming them', async () => {
    const h = await setup({ getMemorySettings: () => ({ enabled: true, learn: false, control: 'review' }),
      getMemoryPreviewSettings: () => ({ enabled: true, autoProceedWhenEmpty: true, confirmationMode: 'on_change' }) });
    try {
      await h.send();
      await until(() => h.store.getMessages(h.chat.id).some(message => message.kind === 'memory_preview_relevance'));
      const preview = h.store.getMessages(h.chat.id).find(message => message.kind === 'memory_preview')!;
      if (preview.kind !== 'memory_preview') throw new Error('Preview missing');
      await h.coordinator.respondMemoryPreview({ chatId: h.chat.id, previewId: preview.previewId, decision: 'without_memory' });
      await until(() => h.mainTurns.length === 1);
      await finish(h);
      await h.send();
      await until(() => h.store.getMessages(h.chat.id).filter(message => message.kind === 'memory_preview_relevance').length === 2);
      const relevance = h.store.getMessages(h.chat.id).filter(message => message.kind === 'memory_preview_relevance').at(-1)!;
      expect(relevance).toMatchObject({ confirmationReasons: [{ id: h.item.id, reason: 'removed' }] });
      expect(h.mainTurns).toHaveLength(1);
    } finally { await h.coordinator.cancel(h.chat.id, { skipPostTurnMemoryPasses: true }); await h.coordinator.shutdownRuntime(); h.close(); }
  });

  it('keeps a failed selector parked even when its memory was already confirmed', async () => {
    const h = await setup({ workingFailsOnce: true, getMemorySettings: () => ({ enabled: true, learn: false, control: 'review' }),
      getMemoryPreviewSettings: () => ({ enabled: true, autoProceedWhenEmpty: true, confirmationMode: 'on_change' }) });
    try {
      recordMemoryConfirmation(h.memory.store, h.chat.id, [h.item], []);
      await h.send();
      await until(() => h.store.getMessages(h.chat.id).some(message => message.kind === 'memory_preview_relevance' && message.error));
      expect(h.mainTurns).toHaveLength(0);
      expect(h.coordinator.pendingPreviews.has(h.chat.id)).toBe(true);
      await h.start();
    } finally { await h.coordinator.cancel(h.chat.id, { skipPostTurnMemoryPasses: true }); await h.coordinator.shutdownRuntime(); h.close(); }
  });

  for (const allowEmpty of [true, false]) {
    it(`honors autoProceedWhenEmpty=${allowEmpty} after a successful empty selection`, async () => {
      const h = await setup({ working: () => ({ selected: [] }), getMemorySettings: () => ({ enabled: true, learn: false, control: 'review' }),
        getMemoryPreviewSettings: () => ({ enabled: true, autoProceedWhenEmpty: allowEmpty, confirmationMode: 'on_change' }) });
      try {
        await h.send();
        await until(() => h.store.getMessages(h.chat.id).some(message => message.kind === 'memory_preview_relevance'));
        if (allowEmpty) {
          await until(() => h.mainTurns.length === 1);
          expect(h.store.getMessages(h.chat.id).filter(message => message.kind === 'memory_preview_decision').at(-1))
            .toMatchObject({ auto: true, selectedIds: [] });
          const decision = h.store.getMessages(h.chat.id).filter(message => message.kind === 'memory_preview_decision').at(-1)!;
          if (decision.kind === 'memory_preview_decision') expect(decision.autoReason).toBeUndefined();
        } else {
          expect(h.mainTurns).toHaveLength(0);
          expect(h.coordinator.pendingPreviews.has(h.chat.id)).toBe(true);
        }
      } finally { await h.coordinator.cancel(h.chat.id, { skipPostTurnMemoryPasses: true }); await h.coordinator.shutdownRuntime(); h.close(); }
    });
  }

  it('ignores delayed selection after cancellation', async () => {
    const selection = deferred<Record<string, unknown>>();
    const h = await setup({ working: () => selection.promise, getMemorySettings: () => ({ enabled: true, learn: false, control: 'review' }),
      getMemoryPreviewSettings: () => ({ enabled: true, autoProceedWhenEmpty: true, confirmationMode: 'on_change' }) });
    try {
      recordMemoryConfirmation(h.memory.store, h.chat.id, [h.item], []);
      await h.send();
      await until(() => h.calls.some(call => call.purpose === 'working-memory'));
      await h.coordinator.cancel(h.chat.id, { skipPostTurnMemoryPasses: true });
      selection.resolve({ selected: [{ id: h.item.id, why: 'Relevant', expectedUse: 'Apply the rule.' }] });
      await Bun.sleep(20);
      expect(h.mainTurns).toHaveLength(0);
      expect(h.store.getMessages(h.chat.id).some(message => message.kind === 'memory_preview_decision' && message.auto)).toBe(false);
    } finally { selection.resolve({ selected: [] }); await h.coordinator.shutdownRuntime(); h.close(); }
  });

  it('reports a view edit during delayed selection instead of automatically booting', async () => {
    const selection = deferred<Record<string, unknown>>();
    const h = await setup({ working: () => selection.promise, getMemorySettings: () => ({ enabled: true, learn: false, control: 'review' }),
      getMemoryPreviewSettings: () => ({ enabled: true, autoProceedWhenEmpty: true, confirmationMode: 'on_change' }) });
    try {
      recordMemoryConfirmation(h.memory.store, h.chat.id, [h.item], []);
      await h.send();
      await until(() => h.calls.some(call => call.purpose === 'working-memory'));
      h.memory.store.update(h.item.id, { content: 'Revised while selection is pending' }, { actor: 'user' });
      selection.resolve({ selected: [{ id: h.item.id, why: 'Relevant', expectedUse: 'Apply the rule.' }] });
      await until(() => h.store.getMessages(h.chat.id).some(message => message.kind === 'memory_preview_relevance' && message.error));
      expect(h.coordinator.pendingPreviews.has(h.chat.id)).toBe(true);
      expect(h.mainTurns).toHaveLength(0);
    } finally { selection.resolve({ selected: [] }); await h.coordinator.cancel(h.chat.id, { skipPostTurnMemoryPasses: true }); await h.coordinator.shutdownRuntime(); h.close(); }
  });

  for (const transition of ['archive', 'expire'] as const) {
    it(`auto-starts only remaining confirmed memories when one is ${transition}d during selection`, async () => {
      const selection = deferred<Record<string, unknown>>();
      const h = await setup({ working: () => selection.promise, getMemorySettings: () => ({ enabled: true, learn: false, control: 'review' }),
        getMemoryPreviewSettings: () => ({ enabled: true, autoProceedWhenEmpty: true, confirmationMode: 'on_change' }) });
      try {
        const first = transition === 'expire'
          ? h.memory.store.update(h.item.id, { expiresAt: '2099-01-01T00:00:00.000Z' }, { actor: 'user' })
          : h.item;
        const second = h.memory.store.create({ content: 'Another confirmed synthetic rule', scope: 'personal', type: 'fact' }, { actor: 'user' });
        recordMemoryConfirmation(h.memory.store, h.chat.id, [first, second], []);
        await h.send();
        await until(() => h.calls.some(call => call.purpose === 'working-memory'));
        if (transition === 'expire') h.memory.expireDue('2100-01-01T00:00:00.000Z');
        else h.memory.store.update(first.id, { status: 'archived' }, { actor: 'user' });
        selection.resolve({ selected: [first, second].map(item => ({ id: item.id, why: 'Relevant', expectedUse: 'Apply this rule.' })) });
        await until(() => h.mainTurns.length === 1);
        expect(h.store.getMessages(h.chat.id).filter(message => message.kind === 'memory_preview_decision').at(-1))
          .toMatchObject({ auto: true, autoReason: 'confirmed', selectedIds: [second.id] });
        expect(h.mainTurns[0]!.developerInstructions).toContain(second.content);
        expect(h.mainTurns[0]!.developerInstructions).not.toContain(first.content);
      } finally { selection.resolve({ selected: [] }); await h.coordinator.cancel(h.chat.id, { skipPostTurnMemoryPasses: true }); await h.coordinator.shutdownRuntime(); h.close(); }
    });
  }

  it('retains confirmations across coordinator restart but not another chat', async () => {
    const h = await setup({ getMemorySettings: () => ({ enabled: true, learn: false, control: 'review' }),
      getMemoryPreviewSettings: () => ({ enabled: true, autoProceedWhenEmpty: true, confirmationMode: 'on_change' }) });
    let next: AgentCoordinator | undefined;
    try {
      await h.send();
      await until(() => h.store.getMessages(h.chat.id).some(message => message.kind === 'memory_preview_relevance'));
      await h.start();
      await finish(h);
      await h.coordinator.shutdownRuntime();
      next = h.restart();
      await next.send({ type: 'chat.send', chatId: h.chat.id, provider: 'codex', model: 'gpt-5.4', content: 'Another synthetic task' });
      await until(() => h.mainTurns.length === 2);
      expect(h.store.getMessages(h.chat.id).filter(message => message.kind === 'memory_preview_decision').at(-1))
        .toMatchObject({ auto: true, autoReason: 'confirmed', selectedIds: [h.item.id] });
      await next.cancel(h.chat.id, { skipPostTurnMemoryPasses: true });
      const other = await h.store.createChat(h.chat.projectId);
      await h.store.setSessionToken(other.id, 'other-session');
      await next.send({ type: 'chat.send', chatId: other.id, provider: 'codex', model: 'gpt-5.4', content: 'Another synthetic task' });
      await until(() => h.store.getMessages(other.id).some(message => message.kind === 'memory_preview_relevance'));
      expect(h.store.getMessages(other.id).find(message => message.kind === 'memory_preview_relevance'))
        .toMatchObject({ confirmationReasons: [{ id: h.item.id, reason: 'first' }] });
      expect(next.pendingPreviews.has(other.id)).toBe(true);
      await next.cancel(other.id, { skipPostTurnMemoryPasses: true });
    } finally { await next?.shutdownRuntime(); await h.coordinator.shutdownRuntime(); h.close(); }
  });

  it('never boots a cancelled automatic decision while its append is pending', async () => {
    const h = await setup({ getMemorySettings: () => ({ enabled: true, learn: false, control: 'review' }),
      getMemoryPreviewSettings: () => ({ enabled: true, autoProceedWhenEmpty: true, confirmationMode: 'on_change' }) });
    const entered = deferred<void>(), release = deferred<void>();
    const append = h.store.appendMessage.bind(h.store);
    h.store.appendMessage = async (chatId, message) => {
      if (message.kind === 'memory_preview_decision' && message.auto) { entered.resolve(); await release.promise; }
      return append(chatId, message);
    };
    try {
      recordMemoryConfirmation(h.memory.store, h.chat.id, [h.item], []);
      await h.send();
      await entered.promise;
      await h.coordinator.cancel(h.chat.id, { skipPostTurnMemoryPasses: true });
      release.resolve();
      await Bun.sleep(20);
      expect(h.mainTurns).toHaveLength(0);
    } finally { release.resolve(); await h.coordinator.shutdownRuntime(); h.close(); }
  });

  it('records the approved snapshot version rather than a fresh version after the decision append', async () => {
    const h = await setup({ getMemorySettings: () => ({ enabled: true, learn: false, control: 'review' }),
      getMemoryPreviewSettings: () => ({ enabled: true, autoProceedWhenEmpty: true, confirmationMode: 'on_change' }) });
    const entered = deferred<void>(), release = deferred<void>();
    const append = h.store.appendMessage.bind(h.store);
    h.store.appendMessage = async (chatId, message) => {
      if (message.kind === 'memory_preview_decision') { entered.resolve(); await release.promise; }
      return append(chatId, message);
    };
    try {
      await h.send();
      await until(() => h.store.getMessages(h.chat.id).some(message => message.kind === 'memory_preview_relevance'));
      const preview = h.coordinator.pendingPreviews.get(h.chat.id)!;
      await h.coordinator.respondMemoryPreview({ chatId: h.chat.id, previewId: preview.previewId, decision: 'go_on', memoryIds: [h.item.id] });
      await entered.promise;
      h.memory.store.update(h.item.id, { content: 'Changed while approval was being saved' }, { actor: 'user' });
      release.resolve();
      await until(() => h.store.getMessages(h.chat.id).some(message => message.kind === 'result' && message.isError));
      expect(getMemoryConfirmation(h.memory.store, h.chat.id).confirmedVersions[h.item.id]).toBe(h.item.version);
      expect(h.mainTurns).toHaveLength(0);
    } finally { release.resolve(); await h.coordinator.shutdownRuntime(); h.close(); }
  });

  it('carries expiry through a parked preview without injecting the expired rule', async () => {
    const selected: string[] = [];
    const h = await setup({ working: () => ({ selected: selected.map(id => ({ id, why: 'Relevant', expectedUse: 'Apply the rule.' })) }) });
    try {
      const later = h.memory.store.create({ content: 'Other synthetic rule', scope: 'personal', type: 'fact' }, { actor: 'user' });
      h.memory.store.update(h.item.id, { expiresAt: '2099-01-01T00:00:00.000Z' }, { actor: 'user' });
      selected.push(h.item.id, later.id);
      await h.send();
      await until(() => h.store.getMessages(h.chat.id).some(message => message.kind === 'memory_preview_relevance'));
      const preview = h.store.getMessages(h.chat.id).find(message => message.kind === 'memory_preview')!;
      if (preview.kind !== 'memory_preview') throw new Error('Preview missing');
      h.memory.expireDue('2100-01-01T00:00:00.000Z');
      await h.coordinator.respondMemoryPreview({ chatId: h.chat.id, previewId: preview.previewId, decision: 'go_on', memoryIds: selected });
      await until(() => h.mainTurns.length === 1);
      expect(h.mainTurns[0]!.developerInstructions).toContain(later.content);
      expect(h.mainTurns[0]!.developerInstructions).not.toContain(h.item.content);
    } finally { await h.coordinator.cancel(h.chat.id, { skipPostTurnMemoryPasses: true }); await h.coordinator.shutdownRuntime(); h.close(); }
  });

  it('emits a single scoped receipt after a between-turn sweep', async () => {
    const h = await setup({ getMemorySettings: () => ({ enabled: true, learn: true, control: 'auto' }) });
    try {
      const old = h.memory.store.create({ content: 'Old history', scope: 'personal', type: 'fact', expiresAt: '2020-01-01T00:00:00.000Z' }, { actor: 'user' });
      h.memory.expireDue();
      const now = h.memory.store.create({ content: 'Expires now', scope: 'personal', type: 'fact', expiresAt: '2020-01-01T00:00:00.000Z' }, { actor: 'user' });
      await h.send();
      await finish(h);
      const first = h.store.getMessages(h.chat.id).filter(message => message.kind === 'memory_expired');
      expect(first).toMatchObject([{ ids: [now.id], turn: 1 }]);
      expect(first[0]?.kind === 'memory_expired' && first[0].ids).not.toContain(old.id);
      const next = h.memory.store.create({ content: 'Expires between turns', scope: 'personal', type: 'fact', expiresAt: '2020-01-01T00:00:00.000Z' }, { actor: 'user' });
      h.memory.store.create({ content: 'Other project expiry', scope: 'project', projectId: 'other-project', type: 'fact', expiresAt: '2020-01-01T00:00:00.000Z' }, { actor: 'user' });
      h.memory.store.create({ content: 'Other chat expiry', scope: 'session', sessionId: 'other-chat', type: 'fact', expiresAt: '2020-01-01T00:00:00.000Z' }, { actor: 'user' });
      h.memory.expireDue();
      await h.send();
      await finish(h, 'second');
      const all = h.store.getMessages(h.chat.id).filter(message => message.kind === 'memory_expired');
      expect(all).toMatchObject([{ ids: [now.id] }, { ids: [next.id], turn: 2 }]);
      await h.send();
      await finish(h, 'third');
      expect(h.store.getMessages(h.chat.id).filter(message => message.kind === 'memory_expired')).toHaveLength(2);
    } finally { await h.coordinator.shutdownRuntime(); h.close(); }
  });

  it('emits team updates on turns, including changes first loaded by the Board', async () => {
    const h = await setup({ getMemorySettings: () => ({ enabled: true, learn: true, control: 'auto' }) });
    try {
      const path = h.store.getProject(h.chat.projectId)!.localPath;
      mkdirSync(join(path, '.memosync'));
      const file = join(path, '.memosync', 'team.md');
      writeFileSync(file, '- [T-abcd] Run the synthetic suite\n');
      const url = new URL(`http://localhost/api/memories?projectId=${h.chat.projectId}`);
      await handleMemoryRequest(new Request(url), url, h.memory, { resolveProjectPath: () => path });
      const id = h.memory.team.pendingNotice(h.chat.projectId)!.added[0]!;
      writeFileSync(file, '- [T-abcd] Run the revised synthetic suite\n');
      await h.send();
      await finish(h);
      expect(h.store.getMessages(h.chat.id).filter(message => message.kind === 'memory_team_updated')).toMatchObject([
        { added: [id], changed: [id], removed: [], turn: 1 },
      ]);
      expect(h.memory.team.pendingNotice(h.chat.projectId)).toBeNull();
      writeFileSync(file, '- [T-ef01] Run a different synthetic suite\n');
      await h.send();
      await finish(h, 'second');
      const notices = h.store.getMessages(h.chat.id).filter(message => message.kind === 'memory_team_updated');
      expect(notices).toHaveLength(2);
      expect(notices[1]).toMatchObject({ added: [expect.any(String)], changed: [], removed: [id], turn: 2 });
      await h.send();
      await finish(h, 'third');
      expect(h.store.getMessages(h.chat.id).filter(message => message.kind === 'memory_team_updated')).toHaveLength(2);
    } finally { await h.coordinator.shutdownRuntime(); h.close(); }
  });

  it('shows an expiry receipt before the review-mode preview', async () => {
    const h = await setup({ getMemorySettings: () => ({ enabled: true, learn: true, control: 'review' }) });
    try {
      const due = h.memory.store.create({ content: 'Temporary synthetic rule', scope: 'personal', type: 'fact', expiresAt: '2020-01-01T00:00:00.000Z' }, { actor: 'user' });
      await h.send();
      await until(() => h.store.getMessages(h.chat.id).some(message => message.kind === 'memory_preview'));
      const messages = h.store.getMessages(h.chat.id);
      expect(messages.filter(message => message.kind === 'memory_expired')).toMatchObject([{ ids: [due.id], turn: 1 }]);
      expect(messages.findIndex(message => message.kind === 'memory_expired')).toBeLessThan(messages.findIndex(message => message.kind === 'memory_preview'));
    } finally { await h.coordinator.cancel(h.chat.id, { skipPostTurnMemoryPasses: true }); await h.coordinator.shutdownRuntime(); h.close(); }
  });

  it('retains the first-chat cursor when appending an expiry receipt fails', async () => {
    const h = await setup({ getMemorySettings: () => ({ enabled: true, learn: true, control: 'auto' }) });
    const append = h.store.appendMessage.bind(h.store);
    let fail = true;
    h.store.appendMessage = async (chatId, message) => {
      if (message.kind === 'memory_expired' && fail) {
        fail = false;
        throw new Error('Synthetic receipt failure');
      }
      return append(chatId, message);
    };
    try {
      const due = h.memory.store.create({ content: 'Temporary synthetic rule', scope: 'personal', type: 'fact', expiresAt: '2020-01-01T00:00:00.000Z' }, { actor: 'user' });
      await expect(h.send()).rejects.toThrow('Synthetic receipt failure');
      expect(h.memory.store.getKv<number>(`expiry_seen:${h.chat.id}`)).toBeLessThan(h.memory.store.latestEventSeq());
      await h.send();
      await finish(h);
      expect(h.store.getMessages(h.chat.id).filter(message => message.kind === 'memory_expired')).toMatchObject([{ ids: [due.id], turn: 2 }]);
    } finally { await h.coordinator.shutdownRuntime(); h.close(); }
  });

  it('does not start a cancelled turn when expiry receipt persistence is pending', async () => {
    const h = await setup({ getMemorySettings: () => ({ enabled: true, learn: true, control: 'auto' }) });
    const entered = deferred<void>();
    const release = deferred<void>();
    const append = h.store.appendMessage.bind(h.store);
    h.store.appendMessage = async (chatId, message) => {
      if (message.kind === 'memory_expired') {
        entered.resolve();
        await release.promise;
      }
      return append(chatId, message);
    };
    try {
      h.memory.store.create({ content: 'Temporary synthetic rule', scope: 'personal', type: 'fact', expiresAt: '2020-01-01T00:00:00.000Z' }, { actor: 'user' });
      const sending = h.send();
      await entered.promise;
      await h.coordinator.cancel(h.chat.id, { skipPostTurnMemoryPasses: true });
      release.resolve();
      await sending;
      expect(h.mainTurns).toHaveLength(0);
      expect(h.store.getMessages(h.chat.id).some(message => message.kind === 'interrupted')).toBe(true);
    } finally { release.resolve(); await h.coordinator.shutdownRuntime(); h.close(); }
  });

  it.each(['archive', 'restore'] as const)('starts a parked preview after outside relation endpoint %s', async lifecycle => {
    const h = await setup();
    try {
      const outside = h.memory.store.create({ content: 'Private synthetic outside rule', detail: 'Private synthetic outside detail', type: 'constraint', scope: 'project', projectId: 'P2' }, { actor: 'user' });
      h.memory.store.addRelation(h.item.id, outside.id, 'conflicts_with');
      h.memory.store.addRelation(outside.id, h.item.id, 'conflicts_with');
      if (lifecycle === 'restore') h.memory.store.archive(outside.id, { actor: 'user' });
      await h.send();
      await until(() => h.store.getMessages(h.chat.id).some(message => message.kind === 'memory_preview_relevance'));
      const preview = h.store.getMessages(h.chat.id).find(message => message.kind === 'memory_preview')!;
      if (preview.kind !== 'memory_preview') throw new Error('Preview missing');
      if (lifecycle === 'archive') h.memory.store.archive(outside.id, { actor: 'user' });
      else h.memory.store.update(outside.id, { status: 'active' }, { actor: 'user' });
      await h.coordinator.respondMemoryPreview({ chatId: h.chat.id, previewId: preview.previewId, decision: 'go_on', memoryIds: [h.item.id] });
      await until(() => h.mainTurns.length === 1);
      expect(h.mainTurns[0]!.developerInstructions).toContain(h.item.content);
      expect(h.mainTurns[0]!.developerInstructions).not.toContain(outside.content);
      expect(h.mainTurns[0]!.developerInstructions).not.toContain('Private synthetic outside detail');
      const decision = h.store.getMessages(h.chat.id).find(message => message.kind === 'memory_preview_decision');
      expect(decision).toMatchObject({ selectedIds: [h.item.id] });
    } finally { await h.coordinator.cancel(h.chat.id, { skipPostTurnMemoryPasses: true }); await h.coordinator.shutdownRuntime(); h.close(); }
  });

  it('starts a parked preview with remaining memories after archive, excluding stale selected ids', async () => {
    const selected: string[] = [];
    const h = await setup({ working: () => ({ selected: selected.map(id => ({ id, why: 'Relevant', expectedUse: 'Apply this synthetic rule.' })) }) });
    try {
      const other = h.memory.store.create({ content: 'Validate the synthetic charge', type: 'constraint', scope: 'personal' }, { actor: 'user' });
      h.memory.store.addRelation(h.item.id, other.id, 'conflicts_with');
      h.memory.store.addRelation(other.id, h.item.id, 'conflicts_with');
      selected.push(h.item.id, other.id);
      await h.send();
      await until(() => h.store.getMessages(h.chat.id).some(message => message.kind === 'memory_preview_relevance'));
      const preview = h.store.getMessages(h.chat.id).find(message => message.kind === 'memory_preview')!;
      if (preview.kind !== 'memory_preview') throw new Error('Preview missing');
      h.memory.store.update(h.item.id, { status: 'archived' }, { actor: 'user' });
      await h.coordinator.respondMemoryPreview({ chatId: h.chat.id, previewId: preview.previewId, decision: 'go_on', memoryIds: selected });
      await until(() => h.mainTurns.length === 1);
      expect(h.mainTurns[0]!.developerInstructions).toContain(other.content);
      expect(h.mainTurns[0]!.developerInstructions).not.toContain(h.item.content);
      const decision = h.store.getMessages(h.chat.id).find(message => message.kind === 'memory_preview_decision');
      expect(decision).toMatchObject({ selectedIds: [other.id] });
    } finally { await h.coordinator.cancel(h.chat.id, { skipPostTurnMemoryPasses: true }); await h.coordinator.shutdownRuntime(); h.close(); }
  });

  it('rejects relation changes after a selected memory is archived', async () => {
    const h = await setup();
    try {
      const other = h.memory.store.create({ content: 'Synthetic second rule', type: 'constraint', scope: 'personal' }, { actor: 'user' });
      await h.send();
      await until(() => h.store.getMessages(h.chat.id).some(message => message.kind === 'memory_preview_relevance'));
      const preview = h.store.getMessages(h.chat.id).find(message => message.kind === 'memory_preview')!;
      if (preview.kind !== 'memory_preview') throw new Error('Preview missing');
      h.memory.store.archive(other.id, { actor: 'user' });
      h.memory.store.addRelation(h.item.id, other.id, 'conflicts_with');
      await expect(h.coordinator.respondMemoryPreview({ chatId: h.chat.id, previewId: preview.previewId, decision: 'go_on', memoryIds: [h.item.id] })).rejects.toThrow('changed during review');
      expect(h.mainTurns).toHaveLength(0);
    } finally { await h.coordinator.cancel(h.chat.id, { skipPostTurnMemoryPasses: true }); await h.coordinator.shutdownRuntime(); h.close(); }
  });

  it('still rejects a changed surviving memory after another is archived', async () => {
    const h = await setup();
    try {
      const other = h.memory.store.create({ content: 'Synthetic second rule', type: 'constraint', scope: 'personal' }, { actor: 'user' });
      await h.send();
      await until(() => h.store.getMessages(h.chat.id).some(message => message.kind === 'memory_preview_relevance'));
      const preview = h.store.getMessages(h.chat.id).find(message => message.kind === 'memory_preview')!;
      if (preview.kind !== 'memory_preview') throw new Error('Preview missing');
      h.memory.store.update(other.id, { status: 'archived' }, { actor: 'user' });
      h.memory.store.update(h.item.id, { content: 'Changed during review' }, { actor: 'user' });
      await expect(h.coordinator.respondMemoryPreview({ chatId: h.chat.id, previewId: preview.previewId, decision: 'go_on', memoryIds: [h.item.id] })).rejects.toThrow('changed during review');
      expect(h.mainTurns).toHaveLength(0);
    } finally { await h.coordinator.cancel(h.chat.id, { skipPostTurnMemoryPasses: true }); await h.coordinator.shutdownRuntime(); h.close(); }
  });
  for (const moment of ['before-confirmation', 'during-decision-write'] as const) {
    it(`never boots against a changed semantic view (${moment})`, async () => {
      const h = await setup();
      try {
        const other = h.memory.store.create({ content: 'Validate monetary inputs', type: 'constraint', scope: 'personal' }, { actor: 'user' });
        await h.send();
        await until(() => h.store.getMessages(h.chat.id).some(message => message.kind === 'memory_preview_relevance'));
        const preview = h.store.getMessages(h.chat.id).find(message => message.kind === 'memory_preview')!;
        if (preview.kind !== 'memory_preview') throw new Error('Preview missing');
        const command = { chatId: h.chat.id, previewId: preview.previewId, decision: 'go_on' as const, memoryIds: [h.item.id] };
        if (moment === 'before-confirmation') {
          h.memory.store.addRelation(h.item.id, other.id, 'conflicts_with');
          await expect(h.coordinator.respondMemoryPreview(command)).rejects.toThrow('changed during review');
        } else {
          const append = h.store.appendMessage.bind(h.store);
          h.store.appendMessage = async (chatId, message) => {
            if (message.kind === 'memory_preview_decision') h.memory.store.addRelation(h.item.id, other.id, 'conflicts_with');
            return append(chatId, message);
          };
          await h.coordinator.respondMemoryPreview(command);
          await until(() => h.store.getChat(h.chat.id)?.lastTurnOutcome === 'failed');
          expect(h.store.getMessages(h.chat.id).some(message => message.kind === 'result' && message.isError && message.result.includes('changed after approval'))).toBe(true);
        }
        expect(h.mainTurns).toHaveLength(0);
        expect(h.mainSessions).toHaveLength(0);
      } finally { await h.coordinator.cancel(h.chat.id, { skipPostTurnMemoryPasses: true }); await h.coordinator.shutdownRuntime(); h.close(); }
    });
  }

  it('analyzes approved candidate changes before publishing this turn’s working-memory view', async () => {
    const selected: string[] = [];
    const h = await setup({ candidate: async () => ({ candidates: [candidateResult('Validate charge requests before submitting')] }),
      working: () => ({ selected: selected.map(id => ({ id, why: 'Required for the charge', expectedUse: 'Validate the charge before submitting it.' })) }),
    });
    try {
      selected.push(h.item.id);
      await h.send();
      await until(() => h.coordinator.pendingProposalGates.has(h.chat.id));
      const candidate = h.memory.store.list({ status: 'candidate' })[0]!;
      expect(h.calls.filter(call => call.purpose === 'changes')).toHaveLength(1);
      h.memory.store.acceptRevision(candidate.id, { actor: 'user' });
      selected.push(candidate.id);
      const gate = h.coordinator.pendingProposalGates.get(h.chat.id)!;
      await h.coordinator.respondMemoryProposals({ chatId: h.chat.id, proposalsId: gate.proposalsId, decision: 'reviewed' });
      await until(() => h.store.getMessages(h.chat.id).some(message => message.kind === 'memory_preview_relevance'));
      const changes = h.calls.filter(call => call.purpose === 'changes');
      expect(changes).toHaveLength(2);
      expect(changes[1]!.prompt).toContain(candidate.id);
      expect(changes[1]!.prompt).toContain(candidate.content);
      const preview = h.store.getMessages(h.chat.id).find(message => message.kind === 'memory_preview')!;
      if (preview.kind !== 'memory_preview') throw new Error('Missing preview');
      expect(preview.memories.some(item => item.id === candidate.id)).toBe(true);
      expect(h.mainTurns).toHaveLength(0);
      await h.coordinator.respondMemoryPreview({ chatId: h.chat.id, previewId: preview.previewId, decision: 'go_on', memoryIds: selected });
      await until(() => h.mainTurns.length === 1);
      expect(h.mainTurns[0]!.developerInstructions).toContain(candidate.content);
      expect(h.mainTurns[0]!.developerInstructions).toContain('Validate the charge before submitting it.');
      await h.coordinator.cancel(h.chat.id, { skipPostTurnMemoryPasses: true });
    } finally { await h.coordinator.shutdownRuntime(); h.close(); }
  });

  it('baselines a rule created at the proposals gate before the task changes its file', async () => {
    const h = await setup({ candidate: async () => ({ candidates: [candidateResult('Use src/a.ts for synthetic checks')] }) });
    try {
      const project = h.store.getProject(h.chat.projectId)!.localPath;
      mkdirSync(join(project, 'src'));
      writeFileSync(join(project, 'src', 'a.ts'), 'baseline');
      await h.send();
      await until(() => h.coordinator.pendingProposalGates.has(h.chat.id));
      const candidate = h.memory.store.list({ status: 'candidate' })[0]!;
      const gate = h.coordinator.pendingProposalGates.get(h.chat.id)!;
      await h.coordinator.respondMemoryProposals({ chatId: h.chat.id, proposalsId: gate.proposalsId, decision: 'skipped' });
      await until(() => h.store.getMessages(h.chat.id).some(message => message.kind === 'memory_preview_relevance'));
      await h.start();
      writeFileSync(join(project, 'src', 'a.ts'), 'changed during the task');
      h.memory.fileDrift.syncProject(h.chat.projectId, project);
      expect(h.memory.fileDrift.refsFor([candidate.id]).get(candidate.id)?.[0]?.drift).toBe('changed');
    } finally { await h.coordinator.cancel(h.chat.id, { skipPostTurnMemoryPasses: true }); await h.coordinator.shutdownRuntime(); h.close(); }
  });

  it('baselines a mid-turn tool proposal before the agent changes its file', async () => {
    const h = await setup({ routeToolProposal: true });
    try {
      const project = h.store.getProject(h.chat.projectId)!.localPath;
      writeFileSync(join(project, 'a.ts'), 'baseline');
      await h.send();
      await until(() => h.store.getMessages(h.chat.id).some(message => message.kind === 'memory_preview_relevance'));
      await h.start();
      const result = await h.mainTurns[0]!.onDynamicToolCall!('propose_memory', { content: 'Use a.ts for synthetic checks', scope: 'project', type: 'constraint' });
      expect(result.isError).not.toBe(true);
      const candidate = h.memory.store.list({ status: 'candidate' }).find(item => item.content.includes('a.ts'))!;
      expect(candidate).toBeDefined();
      writeFileSync(join(project, 'a.ts'), 'changed during the task');
      h.memory.fileDrift.syncProject(h.chat.projectId, project);
      expect(h.memory.fileDrift.refsFor([candidate.id]).get(candidate.id)?.[0]?.drift).toBe('changed');
    } finally { await h.coordinator.cancel(h.chat.id, { skipPostTurnMemoryPasses: true }); await h.coordinator.shutdownRuntime(); h.close(); }
  });

  it('accepts a restored memory with its original expected use in a parked preview', async () => {
    const h = await setup();
    try {
      await h.send();
      await until(() => h.store.getMessages(h.chat.id).some(message => message.kind === 'memory_preview_relevance'));
      const preview = h.store.getMessages(h.chat.id).find(message => message.kind === 'memory_preview')!;
      if (preview.kind !== 'memory_preview') throw new Error('Preview missing');
      h.memory.store.update(h.item.id, { status: 'archived' }, { actor: 'user' });
      h.memory.store.update(h.item.id, { status: 'active' }, { actor: 'user' });
      await h.coordinator.respondMemoryPreview({ chatId: h.chat.id, previewId: preview.previewId, decision: 'go_on', memoryIds: [h.item.id] });
      await until(() => h.mainTurns.length === 1);
      expect(h.mainTurns[0]!.developerInstructions).toContain(h.item.content);
      expect(h.mainTurns[0]!.developerInstructions).toContain('Represent the charge amount as integer cents.');
    } finally { await h.coordinator.cancel(h.chat.id, { skipPostTurnMemoryPasses: true }); await h.coordinator.shutdownRuntime(); h.close(); }
  });

  it('switching to auto skips C/T/M/W and clears the previous review planner guidance', async () => {
    let control: "review" | "auto" = "review";
    const h = await setup({ getMemorySettings: () => ({ enabled: true, learn: true, control }) });
    try {
      await h.send();
      await until(() => h.store.getMessages(h.chat.id).some((message) => message.kind === 'memory_preview_relevance'));
      await h.start();
      expect(h.mainTurns[0]!.developerInstructions).toContain('Represent the charge amount as integer cents.');
      await h.coordinator.cancel(h.chat.id, { skipPostTurnMemoryPasses: true });
      const preparationCalls = h.calls.length;
      control = "auto";
      await h.send();
      expect(h.mainTurns).toHaveLength(2);
      expect(h.calls).toHaveLength(preparationCalls);
      expect(h.coordinator.pendingPreviews.size).toBe(0);
      expect(h.mainTurns[1]!.developerInstructions).toContain(h.item.content);
      expect(h.mainTurns[1]!.developerInstructions).not.toContain('Represent the charge amount as integer cents.');
      await h.coordinator.cancel(h.chat.id, { skipPostTurnMemoryPasses: true });
    } finally { h.close(); }
  });

  for (const invalidAuditReplies of [1, 2]) {
    it(`bounds audit schema correction to one zero-read follow-up (${invalidAuditReplies} malformed replies)`, async () => {
      const h = await setup({ invalidAuditReplies });
      try {
        await h.send();
        await until(() => h.store.getMessages(h.chat.id).some((message) => message.kind === 'memory_preview_relevance'));
        await h.start();
        h.emit({ type: 'transcript', entry: entry({ kind: 'assistant_text', text: 'charge amount=12.5' }) });
        h.emit({ type: 'transcript', entry: entry({ kind: 'result', subtype: 'success', isError: false, durationMs: 1, result: 'charge amount=12.5' }) });
        await until(() => h.store.getMessages(h.chat.id).some((message) => message.kind === 'memory_trace' && message.status !== 'pending'));
        const audits = h.calls.filter((call) => call.purpose === 'audit');
        expect(audits).toHaveLength(2);
        expect(audits[1]!.options?.budget).toEqual({ maxTurns: 2, maxToolCalls: 0 });
        expect(audits[1]!.prompt).toContain('not_applicable');
        expect(h.branches.filter((branch) => branch.purpose === 'audit')).toHaveLength(1);
        const trace = h.store.getMessages(h.chat.id).find((message) => message.kind === 'memory_trace' && message.status !== 'pending')!;
        if (trace.kind !== 'memory_trace') throw new Error('Audit missing');
        expect(trace.status).toBe(invalidAuditReplies === 1 ? 'ok' : 'failed');
        if (invalidAuditReplies === 2) expect(trace.labels).toEqual([]);
        expect(h.sidecarCalls).toHaveLength(0);
      } finally { h.close(); }
    });
  }

  it('runs C/T/M/W before the turn and forks A over its uncited tool evidence', async () => {
    const h = await setup();
    try {
      await h.send();
      await until(() => h.store.getMessages(h.chat.id).some((message) => message.kind === 'memory_preview_relevance'));
      expect(h.calls.slice(0, 2).map((call) => call.purpose)).toEqual(['candidate', 'changes']);
      expect(h.calls.filter((call) => call.purpose === 'transfer')).toHaveLength(0);
      expect(h.calls.filter((call) => call.purpose === 'changes')).toHaveLength(1);
      expect(h.mainTurns).toHaveLength(0);
      await h.start();
      expect(h.mainTurns[0]!.developerInstructions).toContain('Represent the charge amount as integer cents.');
      expect(h.mainTurns[0]!.developerInstructions).not.toContain('CANDIDATE EXTRACTION');
      h.emit({ type: 'session_token', sessionToken: 'main-session' });
      h.emit({ type: 'transcript', entry: entry({ kind: 'tool_call', tool: { kind: 'tool', toolKind: 'bash', toolName: 'Bash', toolId: 'charge-tool', input: { command: 'charge amount=12.5' } } }) });
      h.emit({ type: 'transcript', entry: entry({ kind: 'assistant_text', text: 'The charge was submitted.' }) });
      h.emit({ type: 'transcript', entry: entry({ kind: 'result', subtype: 'success', isError: false, durationMs: 1, result: 'The charge was submitted.' }) });
      await until(() => h.store.getMessages(h.chat.id).some((message) => message.kind === 'memory_trace' && message.status === 'ok'));
      const trace = h.store.getMessages(h.chat.id).find((message) => message.kind === 'memory_trace' && message.status === 'ok')!;
      if (trace.kind !== 'memory_trace') throw new Error('Audit missing');
      expect(trace.labels).toEqual([{ id: h.item.id, label: 'violated', note: 'Decimal dollars were sent as cents', quote: 'amount=12.5', toolId: 'charge-tool', cause: 'not_followed', impact: 'none' }]);
      expect(h.calls.find((call) => call.purpose === 'audit')!.prompt).toContain('charge amount=12.5');
      expect(h.branches.every((branch) => branch.parentSessionToken === 'main-session')).toBe(true);
      expect(h.sidecarCalls).toHaveLength(0);
      expect(h.disposed).toContain('audit');
    } finally { h.close(); }
  });

  it('Stop cancels speculative branches without booting the provider or writing late proposals', async () => {
    const h = await setup({ blockPreparation: true });
    try {
      await h.send();
      await until(() => h.calls.length === 2);
      await h.coordinator.cancel(h.chat.id);
      expect(h.disposed.sort()).toEqual(['candidate', 'changes']);
      expect(h.mainTurns).toHaveLength(0);
      expect(h.memory.store.list({ status: 'candidate' })).toHaveLength(0);
      expect(h.sidecarCalls).toHaveLength(0);
    } finally { h.close(); }
  });

  it('a failed W pass stays explicit and a manual selection retries expected use in the same branch', async () => {
    const h = await setup({ workingFailsOnce: true });
    try {
      await h.send();
      await until(() => h.store.getMessages(h.chat.id).some((message) => message.kind === 'memory_preview_relevance' && Boolean(message.error)));
      expect(h.mainTurns).toHaveLength(0);
      const failure = h.store.getMessages(h.chat.id).find((message) => message.kind === 'memory_preview_relevance' && message.error)!;
      if (failure.kind !== 'memory_preview_relevance') throw new Error('Failure state missing');
      const uses = await h.coordinator.planMemoryPreviewUses({ chatId: h.chat.id, previewId: failure.previewId, selectedIds: [h.item.id] });
      expect(uses).toEqual([{ id: h.item.id, expectedUse: 'Represent the charge amount as integer cents.' }]);
      expect(h.branches.filter((branch) => branch.purpose === 'working-memory')).toHaveLength(1);
      expect(h.calls.filter((call) => call.purpose === 'working-memory')).toHaveLength(2);
      await h.start();
      expect(h.mainTurns[0]!.developerInstructions).toContain(uses[0]!.expectedUse);
      await h.coordinator.cancel(h.chat.id, { skipPostTurnMemoryPasses: true });
      expect(h.sidecarCalls).toHaveLength(0);
    } finally { h.close(); }
  });

  it('per-memory interrupt resumes the same Codex session with the enforced item and corrective prompt', async () => {
    const h = await setup();
    try {
      await h.send();
      await until(() => h.store.getMessages(h.chat.id).some((message) => message.kind === 'memory_preview_relevance'));
      await h.start();
      await until(() => h.coordinator.activeTurns.has(h.chat.id));
      await h.coordinator.interruptMemory({ chatId: h.chat.id, memoryId: h.item.id, quote: 'amount=12.5' });
      const interruption = h.store.getMessages(h.chat.id).find((message) => message.kind === 'memory_interrupt')!;
      if (interruption.kind !== 'memory_interrupt') throw new Error('Interrupt missing');
      const branchesBeforeResume = h.branches.length;
      await h.coordinator.resumeInterrupted({ chatId: h.chat.id, interruptId: interruption.interruptId, correction: 'Charge 1250 integer cents.', selectedIds: [h.item.id], enforce: true });
      await until(() => h.mainTurns.length === 2);
      expect(h.mainSessions.map((session) => session.sessionToken)).toEqual(['main-session', 'main-session']);
      expect(h.mainSessions.every((session) => !session.pendingForkSessionToken)).toBe(true);
      expect(h.mainTurns[1]!.developerInstructions).toContain('Charge 1250 integer cents.');
      expect(h.mainTurns[1]!.developerInstructions).toContain(`ENFORCED THIS RUN: [${h.item.id}]`);
      expect(h.branches).toHaveLength(branchesBeforeResume);
      expect(h.store.getMessages(h.chat.id).some((message) => message.kind === 'memory_interrupt_resolution' && message.enforced)).toBe(true);
      await h.coordinator.cancel(h.chat.id, { skipPostTurnMemoryPasses: true });
    } finally { h.close(); }
  });

  it('registers dynamic tools on a memory-free first turn, then only loads confirmed details on an enabled turn', async () => {
    const h = await setup();
    try {
      await h.store.setSessionToken(h.chat.id, null);
      h.memory.store.update(h.item.id, { detail: 'Multiply USD totals by 100 and validate an integer.' }, { actor: 'user' });
      const excluded = h.memory.store.create({ content: 'A separate rule', detail: 'Excluded detail must not be returned.', type: 'fact', scope: 'personal' }, { actor: 'user' });
      await h.send();
      await until(() => h.store.getMessages(h.chat.id).some((message) => message.kind === 'memory_preview_relevance'));
      const preview = h.store.getMessages(h.chat.id).find((message) => message.kind === 'memory_preview')!;
      if (preview.kind !== 'memory_preview') throw new Error('Preview missing');
      await h.coordinator.respondMemoryPreview({ chatId: h.chat.id, previewId: preview.previewId, decision: 'without_memory' });
      await until(() => h.mainTurns.length === 1);
      expect(h.mainSessions[0]!.sessionToken).toBeNull();
      expect(h.mainSessions[0]!.dynamicTools?.map((tool) => tool.name)).toContain('load_memory_detail');
      const disabled = await h.mainTurns[0]!.onDynamicToolCall!('load_memory_detail', { ids: [h.item.id] });
      expect(disabled.isError).toBe(true);
      expect(disabled.text).not.toContain('Multiply USD totals by 100');
      expect(h.mainTurns[0]!.developerInstructions).toBeUndefined();
      h.emit({ type: 'session_token', sessionToken: 'main-session' });
      h.emit({ type: 'transcript', entry: entry({ kind: 'result', subtype: 'success', isError: false, durationMs: 1, result: 'Done without memory.' }) });
      await until(() => h.store.getChat(h.chat.id)?.lastTurnOutcome === 'success' && !h.coordinator.activeTurns.has(h.chat.id));
      await h.send();
      await until(() => h.store.getMessages(h.chat.id).filter((message) => message.kind === 'memory_preview_relevance').length === 2);
      await h.start();
      expect(h.mainSessions[1]!.sessionToken).toBe('main-session');
      const handler = h.mainTurns[1]!.onDynamicToolCall!;
      expect(handler).toBeDefined();
      const loaded = await handler('load_memory_detail', { ids: [h.item.id, excluded.id] });
      expect(loaded.text).toContain('Multiply USD totals by 100');
      expect(loaded.text).not.toContain(excluded.detail!);
      expect(loaded.text).not.toContain(`[${excluded.id}]`);
      expect(h.memory.store.getById(excluded.id)!.usageCount).toBe(0);
      await h.coordinator.setMemoryDisabled(h.chat.id, true);
      expect(await handler('load_memory_detail', { ids: [h.item.id] })).toMatchObject({ isError: true, text: 'Memory access is disabled' });
      await h.coordinator.cancel(h.chat.id, { skipPostTurnMemoryPasses: true });
    } finally { h.close(); }
  });

  it('natural-language W revision continues the same branch and preserves enforced memory', async () => {
    const h = await setup();
    try {
      h.memory.store.setKv(`pay_attention:${h.chat.id}`, [{ id: h.item.id, quote: 'amount=12.5' }]);
      await h.send();
      await until(() => h.store.getMessages(h.chat.id).some((message) => message.kind === 'memory_preview_relevance'));
      const preview = h.store.getMessages(h.chat.id).find((message) => message.kind === 'memory_preview')!;
      if (preview.kind !== 'memory_preview') throw new Error('Preview missing');
      const revised = await h.coordinator.reviseMemoryPreview({ chatId: h.chat.id, previewId: preview.previewId, selectedIds: [h.item.id], instruction: 'Keep only what is needed to charge this order.' });
      expect(revised).toEqual({ selectedIds: [h.item.id], reply: 'Kept the enforced money rule for this charge.' });
      expect(h.branches.filter((branch) => branch.purpose === 'working-memory')).toHaveLength(1);
      const workingCalls = h.calls.filter((call) => call.purpose === 'working-memory');
      expect(workingCalls).toHaveLength(2);
      expect(workingCalls[1]!.prompt).toContain(`MANDATORY ITEMS FOR THIS TURN:\n["${h.item.id}"]`);
      await h.start();
      expect(h.mainTurns[0]!.developerInstructions).toContain(`ENFORCED THIS RUN: [${h.item.id}]`);
      await h.coordinator.cancel(h.chat.id, { skipPostTurnMemoryPasses: true });
    } finally { h.close(); }
  });
});
