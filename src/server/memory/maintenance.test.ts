import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmJsonCaller } from './deepseek';
import { MemoryService } from './index';
import { createMaintenanceService } from './maintenance';

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
