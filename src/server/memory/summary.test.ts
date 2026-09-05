import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryService } from './index';
import { createSummaryService } from './summary';
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

describe('auto-arm summary service (baseline B1)', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memv2-summary-'));
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
  });
  afterEach(() => {
    memory.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('get: empty store → empty non-stale summary; items without a stored projection → stale', () => {
    const svc = createSummaryService({ memory, callJson: stubCaller([]).call });
    expect(svc.get('P1')).toEqual({ text: '', updatedAt: '', stale: false });
    memory.store.create(
      { content: 'Prefers bun', scope: 'project', projectId: 'P1', type: 'preference' },
      { actor: 'agent' },
    );
    expect(svc.get('P1').stale).toBe(true);
  });

  it('chat asks the panel model for complete memory content of at most 100 words', async () => {
    const { call, calls } = stubCaller([{
      intent: 'inspect',
      reply: 'Nothing is remembered yet.',
      operations: [],
    }]);
    const svc = createSummaryService({ memory, callJson: call });

    await svc.chat('What do you remember?', { projectId: 'P1' });

    expect(calls[0]!.system).toContain('at most 100 words');
    expect(calls[0]!.system).toContain('semantically complete');
    expect(calls[0]!.system).not.toContain('160 chars');
  });

  it('chat durably records the exact panel request before classification and does not call the model if that write fails', async () => {
    let calls = 0;
    memory.close();
    memory = new MemoryService({
      dbPath: ':memory:',
      dataDir: dir,
      logger: {
        event: (event) => {
          if (event.type === 'study.participant_prompt') throw new Error('SQLite unavailable');
        },
      },
    });
    const svc = createSummaryService({
      memory,
      callJson: async () => {
        calls += 1;
        return { intent: 'inspect', reply: 'unused', operations: [] };
      },
    });

    await expect(svc.chat('What do you remember?', {
      projectId: 'P1',
      sessionId: 'chat-1',
      eventId: 'prompt:auto-summary:request-1',
    })).rejects.toThrow('SQLite unavailable');
    expect(calls).toBe(0);
  });

  it('chat preserves complete add and edit content when the panel model overruns the word target', async () => {
    const existing = memory.store.create(
      { content: 'Old package-manager rule', scope: 'project', projectId: 'P1', type: 'constraint' },
      { actor: 'agent' },
    );
    const editedContent = `${Array.from({ length: 101 }, (_, index) => `edit${index + 1}`).join(' ')}.`;
    const addedContent = `${Array.from({ length: 101 }, (_, index) => `add${index + 1}`).join(' ')}.`;
    const { call } = stubCaller([
      {
        intent: 'update',
        reply: 'Updated both memories.',
        operations: [
          { action: 'edit', id: existing.id, content: editedContent },
          { action: 'add', content: addedContent, type: 'fact' },
        ],
      },
      { summary: 'Updated project memory.' },
    ]);
    const svc = createSummaryService({ memory, callJson: call });

    const result = await svc.chat('Update both memories.', { projectId: 'P1' });

    expect(result.applied).toBe(2);
    expect(memory.store.getById(existing.id)!.content).toBe(editedContent);
    expect(memory.autoProjectMemories('P1').map(({ content }) => content)).toContain(addedContent);
  });

  it('refresh: generates and stores prose while staleness tracks item versions', async () => {
    memory.store.create({ content: 'Prefers bun over npm', scope: 'personal', type: 'preference' }, { actor: 'agent' });
    const item = memory.store.create(
      { content: 'Deploys go through staging', scope: 'project', projectId: 'P1', type: 'constraint' },
      { actor: 'agent' },
    );
    memory.store.create(
      { content: 'The car flow uses a multi-step checkout', scope: 'project', projectId: 'P2', type: 'fact' },
      { actor: 'agent' },
    );
    memory.store.create(
      { content: 'Cancellation requires confirmation', scope: 'session', sessionId: 'other-chat', type: 'constraint' },
      { actor: 'agent' },
    );
    const { call, calls } = stubCaller([{ summary: '## Overview\nYou deploy via staging.' }]);
    const svc = createSummaryService({ memory, callJson: call });

    const s = await svc.refresh('P1');
    expect(s.text).toContain('staging');
    expect(s.stale).toBe(false);
    expect(calls[0]!.user).toContain('Deploys go through staging');
    expect(calls[0]!.user).not.toContain('The car flow uses a multi-step checkout');
    expect(calls[0]!.user).not.toContain('Cancellation requires confirmation');
    expect(svc.get('P1').stale).toBe(false);
    expect(svc.get('P2')).toEqual({ text: '', updatedAt: '', stale: true });

    // A content edit bumps the version → the stored projection reads stale again.
    memory.store.update(item.id, { content: 'Deploys go through staging, always' }, { actor: 'user' });
    expect(svc.get('P1').stale).toBe(true);
  });

  it('refresh: derives and stores an independent summary for each Auto Project Copy', async () => {
    memory.store.create(
      { content: 'Apartment listings use compact cards', scope: 'project', projectId: 'apartment', type: 'fact' },
      { actor: 'agent' },
    );
    memory.store.create(
      { content: 'Car checkout uses a progress stepper', scope: 'project', projectId: 'car', type: 'fact' },
      { actor: 'agent' },
    );
    const { call, calls } = stubCaller([
      { summary: 'Apartment memory.' },
      { summary: 'Car memory.' },
    ]);
    const svc = createSummaryService({ memory, callJson: call });

    await svc.refresh('apartment');
    await svc.refresh('car');

    expect(calls[0]!.user).toContain('Apartment listings use compact cards');
    expect(calls[0]!.user).not.toContain('Car checkout uses a progress stepper');
    expect(calls[1]!.user).toContain('Car checkout uses a progress stepper');
    expect(calls[1]!.user).not.toContain('Apartment listings use compact cards');
    expect(svc.get('apartment')).toMatchObject({ text: 'Apartment memory.', stale: false });
    expect(svc.get('car')).toMatchObject({ text: 'Car memory.', stale: false });
  });

  it('chat: applies add/edit/forget operations, logs decisions, regenerates the summary', async () => {
    const events: Array<Record<string, unknown>> = [];
    memory.close();
    memory = new MemoryService({
      dbPath: ':memory:',
      dataDir: dir,
      logger: { event: (e) => void events.push(e as unknown as Record<string, unknown>) },
    });
    const existing = memory.store.create(
      { content: 'Prefers npm', scope: 'project', projectId: 'apartment', type: 'preference' },
      { actor: 'agent' },
    );
    const toForget = memory.store.create(
      { content: 'Uses port 3000', scope: 'project', projectId: 'apartment', type: 'fact' },
      { actor: 'agent' },
    );

    const { call } = stubCaller([
      {
        intent: 'update',
        reply: 'Updated: bun instead of npm, forgot the port note, and noted the SSH key.',
        operations: [
          { action: 'edit', id: existing.id, content: 'Prefers bun over npm' },
          { action: 'forget', id: toForget.id },
          { action: 'add', content: 'SSH deploy key lives at ~/.ssh/id_ed25519_server', type: 'fact', scope: 'project' },
        ],
      },
      { summary: '## Overview\nYou prefer bun and keep your deploy key at ~/.ssh.' },
    ]);
    const svc = createSummaryService({ memory, callJson: call });

    const r = await svc.chat('actually I use bun now, forget the port thing, and remember my ssh key is at ~/.ssh/id_ed25519_server', {
      projectId: 'apartment',
      sessionId: 'chat-1',
    });

    expect(r.applied).toBe(3);
    expect(r.reply).toContain('bun');
    expect(memory.store.getById(existing.id)!.content).toBe('Prefers bun over npm');
    expect(memory.store.getById(toForget.id)!.status).toBe('archived');
    const added = memory.store.list({ status: 'active' }).find((m) => m.content.includes('id_ed25519_server'))!;
    expect(added).toBeDefined();
    // Panel-confirmed adds go straight ACTIVE — the conversation IS the
    // confirmation in this arm (no review lane exists).
    expect(added.status).toBe('active');
    expect(added.scope).toBe('project');
    expect(added.projectId).toBe('apartment');
    expect(added.evidenceClass).toBe('user_stated');
    expect(r.summary.text).toContain('bun');
    const decisions = events.filter((e) => e.type === 'memory.decision').map((e) => `${e.action}:${e.via}`);
    expect(decisions).toEqual(['edit:summary_chat', 'archive:summary_chat', 'create:summary_chat']);
    const request = events.find((e) => e.type === 'study.participant_prompt')!;
    const control = events.find((e) => e.type === 'memory.control_request')!;
    const requestEventId = String(request.eventId);
    expect(request).toMatchObject({
      eventId: requestEventId,
      sessionId: 'chat-1',
      surface: 'auto_summary_chat',
      action: 'submit',
      projectId: 'apartment',
      content: 'actually I use bun now, forget the port thing, and remember my ssh key is at ~/.ssh/id_ed25519_server',
    });
    expect(control).toMatchObject({
      eventId: `control:auto-summary:${requestEventId}`,
      sessionId: 'chat-1',
      via: 'auto_summary_chat',
      requestedAction: 'update_memory',
      causalRequestId: requestEventId,
      applied: 3,
    });
  });

  it('chat: counts one participant control request even when no memory operation lands', async () => {
    const events: Array<Record<string, unknown>> = [];
    memory.close();
    memory = new MemoryService({
      dbPath: ':memory:',
      dataDir: dir,
      logger: { event: (e) => void events.push(e as unknown as Record<string, unknown>) },
    });
    const { call } = stubCaller([{
      intent: 'update',
      reply: 'I could not find that memory to change.',
      operations: [],
    }]);
    const svc = createSummaryService({ memory, callJson: call });

    await svc.chat('Please change the remembered package manager to bun.', { projectId: 'apartment', sessionId: 'chat-1' });

    expect(events.find((event) => event.type === 'study.participant_prompt')).toMatchObject({
      sessionId: 'chat-1',
      surface: 'auto_summary_chat',
      action: 'submit',
      content: 'Please change the remembered package manager to bun.',
    });
    expect(events.find((event) => event.type === 'memory.control_request')).toMatchObject({
      sessionId: 'chat-1',
      via: 'auto_summary_chat',
      requestedAction: 'update_memory',
      applied: 0,
    });
  });

  it('chat: does not count an inspection question as Auto control', async () => {
    const events: Array<Record<string, unknown>> = [];
    memory.close();
    memory = new MemoryService({
      dbPath: ':memory:',
      dataDir: dir,
      logger: { event: (e) => void events.push(e as unknown as Record<string, unknown>) },
    });
    const { call } = stubCaller([{
      intent: 'inspect',
      reply: 'There is no saved memory yet.',
      operations: [],
    }]);
    const svc = createSummaryService({ memory, callJson: call });

    await svc.chat('What do you remember about me?', { projectId: 'apartment', sessionId: 'chat-1' });

    expect(events.filter((event) => event.type === 'memory.control_request')).toEqual([]);
  });

  it('chat: does not turn an inspection prompt into Control when the model emits a stray operation', async () => {
    const events: Array<Record<string, unknown>> = [];
    memory.close();
    memory = new MemoryService({
      dbPath: ':memory:',
      dataDir: dir,
      logger: { event: (e) => void events.push(e as unknown as Record<string, unknown>) },
    });
    const existing = memory.store.create(
      { content: 'Prefers npm', scope: 'project', projectId: 'apartment', type: 'preference' },
      { actor: 'agent' },
    );
    const { call } = stubCaller([
      {
        intent: 'inspect',
        reply: 'You prefer npm.',
        operations: [{ action: 'forget', id: existing.id }],
      },
      { summary: 'You prefer npm.' },
    ]);
    const svc = createSummaryService({ memory, callJson: call });

    const result = await svc.chat('What do you remember about package managers?', { projectId: 'apartment', sessionId: 'chat-1' });

    expect(result.applied).toBe(0);
    expect(memory.store.getById(existing.id)?.status).toBe('active');
    expect(events.filter((event) => event.type === 'memory.decision')).toEqual([]);
    expect(events.filter((event) => event.type === 'memory.control_request')).toEqual([]);
  });

  it('chat: hallucinated ids and malformed ops are skipped; a fresh stored projection avoids regeneration', async () => {
    memory.store.create(
      { content: 'Prefers bun', scope: 'project', projectId: 'P1', type: 'preference' },
      { actor: 'agent' },
    );
    const { call: refreshCall } = stubCaller([{ summary: 'You prefer bun.' }]);
    const svcSeed = createSummaryService({ memory, callJson: refreshCall });
    await svcSeed.refresh('P1');

    const { call, calls } = stubCaller([
      {
        reply: 'You prefer bun over npm.',
        operations: [
          { action: 'forget', id: 'M-999' }, // hallucinated
          { action: 'explode' }, // unknown
        ],
      },
    ]);
    const svc = createSummaryService({ memory, callJson: call });
    const r = await svc.chat('what do you remember about package managers?', { projectId: 'P1' });
    expect(r.applied).toBe(0);
    expect(r.summary.text).toBe('You prefer bun.');
    expect(calls).toHaveLength(1); // chat only — no regeneration call
  });
});
