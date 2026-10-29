import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentCoordinator } from './agent';
import { EventStore } from './event-store';
import { MemoryService } from './memory';
import { createCaptureService } from './memory/capture';
import { createCheckupService } from './memory/checkup';
import { createTransferService } from './memory/transfer';
import { createTransferDetectService } from './memory/transfer-detect';
import { resolveConditionPolicy } from './experiment/condition';
import type { HarnessEvent, HarnessTurn } from './harness-types';
import type { MemoryBranchInput, MemoryBranchAskOptions } from './memory/branch-runtime';
import type { CodexAppServerManager } from './codex-app-server';
import type { TranscriptEntry } from '../shared/types';

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

async function setup(options: { blockPreparation?: boolean; workingFailsOnce?: boolean; invalidAuditReplies?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'memosync-agent-branches-'));
  const store = new EventStore(join(directory, 'events'));
  await store.initialize();
  const project = await store.openProject(directory, 'Payment test');
  const chat = await store.createChat(project.id);
  await store.setSessionToken(chat.id, 'main-session');
  const memory = new MemoryService({ dbPath: ':memory:', dataDir: join(directory, 'memory') });
  const item = memory.store.create({ content: 'Store money as integer cents', type: 'constraint', scope: 'project', projectId: project.id }, { actor: 'user' });
  const sidecarCalls: string[] = [];
  const callJson = async () => { sidecarCalls.push('called'); throw new Error('Unexpected sidecar'); };
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
  } as unknown as CodexAppServerManager;
  const coordinator = new AgentCoordinator({
    store, memory, codexManager, onStateChange: () => {}, policy: { ...resolveConditionPolicy('memosync'), studyMode: false },
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
          if (purpose === 'candidate') return { candidates: [] };
          if (purpose === 'transfer') return count === 1 ? { suggestions: [] } : { upsert: {}, remove: {} };
          if (purpose === 'changes') return count === 1 ? { conflicts: [], redundancy: [], staleness: [] } : { upsert: {}, remove: {} };
          if (purpose === 'working-memory') {
            if (options.workingFailsOnce && count === 1) throw new Error('Working-memory provider unavailable');
            return { selected: [{ id: item.id, why: 'Charging the order', expectedUse: 'Represent the charge amount as integer cents.' }], reply: 'Kept the enforced money rule for this charge.' };
          }
          if (purpose === 'audit') {
            if (count <= (options.invalidAuditReplies ?? 0)) return { labels: [{ id: item.id, label: 'not_applicable', note: 'Missing opportunity described here, but no required missing field.' }] };
            return { labels: [{ id: item.id, label: 'violated', note: 'Decimal dollars were sent as cents', quote: 'amount=12.5', toolId: 'charge-tool', cause: 'not_followed', impact: 'none' }] };
          }
          throw new Error(`Unexpected memory branch ${purpose}`);
        },
      };
    },
  });
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
    emit: (value: HarnessEvent) => queues.at(-1)!.push(value),
    close: () => { queues.forEach((queue) => queue.close()); memory.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

describe('AgentCoordinator persistent Codex memory branches', () => {
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
      expect(h.calls.slice(0, 3).map((call) => call.purpose)).toEqual(['candidate', 'transfer', 'changes']);
      expect(h.calls.filter((call) => call.purpose === 'changes')).toHaveLength(3);
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
      await until(() => h.calls.length === 3);
      await h.coordinator.cancel(h.chat.id);
      expect(h.disposed.sort()).toEqual(['candidate', 'changes', 'transfer']);
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
      expect(h.mainTurns[0]!.onDynamicToolCall).toBeUndefined();
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
