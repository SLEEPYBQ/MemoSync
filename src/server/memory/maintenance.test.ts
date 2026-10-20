import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmJsonCaller } from './deepseek';
import { MemoryService } from './index';
import { createMaintenanceService } from './maintenance';
import { handleMemoryRequest } from './routes';

let dir: string;
let memory: MemoryService;

function service(opts: { callJson?: LlmJsonCaller } = {}) {
  return createMaintenanceService({ memory, ...opts });
}

describe('maintenance actions used by the chat Checkup', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memv2-maintenance-'));
    memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
  });

  afterEach(() => {
    memory.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('archive and renew validate live state and preserve their memory events', () => {
    const toRenew = memory.store.create(
      { content: 'The release window is still valid', scope: 'personal', type: 'fact' },
      { actor: 'user' },
    );
    const toArchive = memory.store.create(
      { content: 'The old deployment rule conflicts with the current one', scope: 'personal', type: 'fact' },
      { actor: 'user' },
    );
    const svc = service();

    const renewed = svc.renew(toRenew.id, { actor: 'user', sessionId: 'chat-1' });
    expect(renewed.status).toBe('active');
    expect(memory.store.getEvents(toRenew.id).some((event) => event.kind === 'renew')).toBe(true);

    const archived = svc.archive('conflict', toArchive.id, { actor: 'user', sessionId: 'chat-1' });
    expect(archived.status).toBe('archived');
    expect(() => svc.renew(toArchive.id, { actor: 'user' })).toThrow('active');
    expect(() => svc.archive('conflict', toArchive.id, { actor: 'user' })).toThrow('active');
  });

  it('keepBoth records the acknowledgement relation without archiving either memory', () => {
    const a = memory.store.create(
      { content: 'Use pnpm, never npm, in this repo', scope: 'personal', type: 'constraint' },
      { actor: 'user' },
    );
    const b = memory.store.create(
      { content: 'The user wants pnpm instead of npm here', scope: 'personal', type: 'preference' },
      { actor: 'agent' },
    );
    const svc = service();

    svc.keepBoth(a.id, b.id, { actor: 'user', sessionId: 'chat-1' });

    expect(memory.store.getRelations(a.id)).toContainEqual({ type: 'similar_to', targetId: b.id });
    expect(memory.store.getById(a.id)!.status).toBe('active');
    expect(memory.store.getById(b.id)!.status).toBe('active');
  });

  it('merge drafts one reviewable proposal that revises both originals', async () => {
    const a = memory.store.create(
      { content: 'Use pnpm, never npm, in this repo', scope: 'personal', type: 'constraint' },
      { actor: 'user' },
    );
    const b = memory.store.create(
      { content: 'The user wants pnpm instead of npm here', scope: 'personal', type: 'preference' },
      { actor: 'agent' },
    );
    const mergedContent = `${Array.from({ length: 101 }, (_, index) => `merged${index + 1}`).join(' ')}.`;
    const systems: string[] = [];
    const callJson: LlmJsonCaller = async (request) => {
      systems.push(request.system);
      return {
        content: mergedContent,
        detail: 'The user standardized on pnpm; npm previously caused lockfile drift.',
        type: 'constraint',
        topic: 'Tooling',
        abstractionLevel: 'contextual',
      };
    };
    const svc = service({ callJson });

    const proposal = await svc.merge(a.id, b.id, { actor: 'user', sessionId: 'chat-1' });

    expect(proposal).not.toBeNull();
    expect(proposal!.status).toBe('candidate');
    expect(proposal!.content).toBe(mergedContent);
    expect(systems[0]).toContain('at most 100 words');
    expect(systems[0]).toContain('semantically complete');
    expect(systems[0]).not.toContain('160 chars');
    expect(memory.store.revisionTargetsOf(proposal!.id).map((target) => target.id).sort()).toEqual([a.id, b.id].sort());
    expect(memory.store.listOpenRevisions().map((entry) => entry.target.id).sort()).toEqual([a.id, b.id].sort());
    expect(memory.store.getById(a.id)!.status).toBe('active');
    expect(memory.store.getById(b.id)!.status).toBe('active');

    const { replaced } = memory.store.acceptRevision(proposal!.id, { actor: 'user' });
    expect(replaced.map((item) => item.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('merge preserves a shared session and accepts through the ordinary memory PATCH route', async () => {
    const a = memory.store.create(
      { content: 'Use pnpm in chat A', scope: 'session', sessionId: 'chat-A', type: 'constraint' },
      { actor: 'user' },
    );
    const b = memory.store.create(
      { content: 'Prefer pnpm for this work session', scope: 'session', sessionId: 'chat-A', type: 'preference' },
      { actor: 'agent' },
    );
    const mergedContent = Array.from({ length: 101 }, (_, index) => `merged${index + 1}`).join(' ');
    const proposal = await service({
      callJson: async () => ({
        content: mergedContent,
        detail: 'Use pnpm consistently for this session.',
        type: 'constraint',
        abstractionLevel: 'contextual',
      }),
    }).merge(a.id, b.id, { actor: 'user', sessionId: 'chat-A' });

    expect(proposal).not.toBeNull();
    expect(proposal!.sessionId).toBe('chat-A');

    const url = new URL(`http://localhost/api/memories/${proposal!.id}`);
    const response = await handleMemoryRequest(
      new Request(url, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
      }),
      url,
      memory,
    );

    expect(response!.status).toBe(200);
    expect((await response!.json()).data).toMatchObject({ status: 'active', scope: 'session', sessionId: 'chat-A' });
    expect(memory.store.getById(a.id)!.status).toBe('archived');
    expect(memory.store.getById(b.id)!.status).toBe('archived');
  });

  it('rejects a cross-session merge before calling the model or creating a proposal', async () => {
    const a = memory.store.create(
      { content: 'Use pnpm in chat A', scope: 'session', sessionId: 'chat-A', type: 'constraint' },
      { actor: 'user' },
    );
    const b = memory.store.create(
      { content: 'Prefer pnpm in chat B', scope: 'session', sessionId: 'chat-B', type: 'preference' },
      { actor: 'agent' },
    );
    let modelCalls = 0;
    const before = memory.store.list().map((item) => ({ item, events: memory.store.getEvents(item.id) }));

    await expect(service({
      callJson: async () => {
        modelCalls += 1;
        return { content: 'A merged session rule with enough detail.', type: 'constraint' };
      },
    }).merge(a.id, b.id, { actor: 'user', sessionId: 'chat-A' })).rejects.toThrow('same scope and context');

    expect(modelCalls).toBe(0);
    expect(memory.store.list().map((item) => ({ item, events: memory.store.getEvents(item.id) }))).toEqual(before);
    expect(memory.store.list({ status: 'candidate' })).toHaveLength(0);
  });

  it('merge rejects a missing LLM and a raced or archived member', async () => {
    const a = memory.store.create(
      { content: 'Use pnpm, never npm, in this repo', scope: 'personal', type: 'constraint' },
      { actor: 'user' },
    );
    const b = memory.store.create(
      { content: 'The user wants pnpm instead of npm here', scope: 'personal', type: 'preference' },
      { actor: 'agent' },
    );

    await expect(service().merge(a.id, b.id, { actor: 'user' })).rejects.toThrow('not available');

    memory.store.archive(b.id, { actor: 'user' });
    const svc = service({ callJson: async () => ({ content: 'x', type: 'fact' }) });
    await expect(svc.merge(a.id, b.id, { actor: 'user' })).rejects.toThrow('active');
  });
});
