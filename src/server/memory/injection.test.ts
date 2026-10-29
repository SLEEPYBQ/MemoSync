import { describe, expect, test, beforeEach, afterEach } from 'bun:test';

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryService } from './index';
import { computeMemoryTurnDelta, normalizeMemorySelection, planMemoryInjection } from './injection';
import { resolveConditionPolicy } from '../experiment/condition';


let dir: string;
let memory: MemoryService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'injection-'));
  memory = new MemoryService({ dbPath: ':memory:', dataDir: join(dir, 'data') });
  memory.store.create({ content: 'Prefers bun over npm', scope: 'personal', type: 'preference' }, { actor: 'system' });
  memory.store.create(
    { content: 'Never push to main', scope: 'project', projectId: 'proj-1', type: 'constraint' },
    { actor: 'system' },
  );
});
afterEach(() => {
  memory.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('planMemoryInjection', () => {
  test('normalizes a client selection against the current chat Visible Memory Pool', () => {
    const currentSession = memory.store.create(
      { content: 'This chat uses a confirmation dialog', scope: 'session', sessionId: 'chat-current', type: 'lesson' },
      { actor: 'system' },
    );
    const excluded = memory.store.create(
      { content: 'Do not show this memory in the current chat', scope: 'session', sessionId: 'chat-current', type: 'fact' },
      { actor: 'system' },
    );
    const otherProject = memory.store.create(
      { content: 'Only applies to another project', scope: 'project', projectId: 'proj-2', type: 'fact' },
      { actor: 'system' },
    );
    const otherSession = memory.store.create(
      { content: 'Only applies to another chat', scope: 'session', sessionId: 'chat-other', type: 'fact' },
      { actor: 'system' },
    );
    const archived = memory.store.create(
      { content: 'No longer active', scope: 'project', projectId: 'proj-1', type: 'fact', status: 'archived' },
      { actor: 'system' },
    );
    memory.store.setSessionExclusions('chat-current', [excluded.id]);

    expect(normalizeMemorySelection({
      memory,
      projectId: 'proj-1',
      chatId: 'chat-current',
      selectedIds: [
        otherProject.id,
        currentSession.id,
        'M-999',
        'M-02',
        excluded.id,
        'M-01',
        currentSession.id,
        otherSession.id,
        archived.id,
      ],
    })).toEqual(['M-01', 'M-02', currentSession.id]);
  });

  test('memosync arm: skills block with versioned ids + tools registered', () => {
    const plan = planMemoryInjection({
      policy: resolveConditionPolicy('memosync'),
      memory,
      projectId: 'proj-1',
    });
    expect(plan.mode).toBe('skills');
    expect(plan.registerTools).toBe(true);
    expect(plan.block).toContain('[M-01 v1]');
    expect(plan.block).toContain('HIGHEST version');
    expect(plan.block).toContain('load_memory_detail');
    expect(plan.block).not.toContain('search_memory');
    expect(plan.injectedMemories.map((m) => m.id)).toEqual(['M-01', 'M-02']);
    expect(plan.bakedMemories.map((m) => m.id)).toEqual(['M-01', 'M-02']);
    expect(plan.hash).toContain('M-01@');
  });

  test('skills: content edits move the hash but NOT the session rebuild key (delta model)', () => {
    const opts = {
      policy: resolveConditionPolicy('memosync'),
      provider: 'claude' as const,
      memory,
      projectId: 'proj-1',
    };
    const before = planMemoryInjection(opts);
    memory.store.update('M-01', { content: 'Prefers pnpm now' }, { actor: 'user' });
    const after = planMemoryInjection(opts);
    expect(after.hash).not.toBe(before.hash); // content fingerprint moves…
    expect(after.sessionRebuildKey).toBe(before.sessionRebuildKey); // …but no rebuild
  });

  test('skills: only confirmed working memories are baked into the main context', () => {
    const plan = planMemoryInjection({
      policy: resolveConditionPolicy('memosync'),
      memory,
      projectId: 'proj-1',
      restrictToIds: ['M-02'],
    });
    expect(plan.injectedMemories.map((m) => m.id)).toEqual(['M-02']);
    expect(plan.bakedMemories.map((m) => m.id)).toEqual(['M-02']);
    expect(plan.block).not.toContain('[M-01 v1]');
    expect(plan.block).toContain('[M-02 v1]');
  });
});

describe('computeMemoryTurnDelta', () => {
  function baselineFromBoot(): Map<string, number> {
    const plan = planMemoryInjection({
      policy: resolveConditionPolicy('memosync'),
      memory,
      projectId: 'proj-1',
    });
    return new Map(plan.bakedMemories.map((m) => [m.id, m.version]));
  }

  test('quiet turn: empty block, baseline unchanged', () => {
    const baseline = baselineFromBoot();
    const delta = computeMemoryTurnDelta({ memory, projectId: 'proj-1', baseline });
    expect(delta.block).toBe('');
    expect([...delta.nextBaseline.entries()]).toEqual([...baseline.entries()]);
    expect(delta.effectiveIds).toEqual(['M-01', 'M-02']);
  });

  test('edit: reports v1→v2 with the new text', () => {
    const baseline = baselineFromBoot();
    memory.store.update('M-01', { content: 'Prefers pnpm now' }, { actor: 'user' });
    const delta = computeMemoryTurnDelta({ memory, projectId: 'proj-1', baseline });
    expect(delta.block).toContain('[M-01 v2] (edited, v1→v2)');
    expect(delta.block).toContain('Prefers pnpm now');
    expect(delta.block).toContain('supersede');
    expect(delta.nextBaseline.get('M-01')).toBe(2);
  });

  test('add + archive: reports both lifecycle moves', () => {
    const baseline = baselineFromBoot();
    memory.store.create(
      { content: 'SSH key lives at ~/.ssh/id_ed25519_server', scope: 'project', projectId: 'proj-1', type: 'fact' },
      { actor: 'agent' },
    );
    memory.store.archive('M-02', { actor: 'user' });
    const delta = computeMemoryTurnDelta({ memory, projectId: 'proj-1', baseline });
    expect(delta.block).toContain('(added) (project · fact) SSH key lives at');
    expect(delta.block).toContain('[M-02] (no longer in the active set)');
    expect(delta.nextBaseline.has('M-02')).toBe(false);
  });

  test('restriction: renders the per-turn ignore line and narrows effectiveIds', () => {
    const baseline = baselineFromBoot();
    const delta = computeMemoryTurnDelta({
      memory,
      projectId: 'proj-1',
      baseline,
      restrictToIds: ['M-02'],
    });
    expect(delta.block).toContain('For this turn only, ignore: [M-01].');
    expect(delta.effectiveIds).toEqual(['M-02']);
    // Unselected memories leave the current baseline and are resent if selected later.
    expect(delta.nextBaseline.has('M-01')).toBe(false);
    const reselected = computeMemoryTurnDelta({ memory, projectId: 'proj-1', baseline: delta.nextBaseline, restrictToIds: ['M-01'] });
    expect(reselected.block).toContain('[M-01');
    expect(reselected.effectiveIds).toEqual(['M-01']);
  });

  test('new conflict rides the added line with a ⚠ mark', () => {
    const baseline = baselineFromBoot();
    const item = memory.store.create(
      { content: 'Use yup schemas for validation', scope: 'project', projectId: 'proj-1', type: 'constraint' },
      { actor: 'agent' },
    );
    memory.store.addRelation(item.id, 'M-02', 'conflicts_with');
    const delta = computeMemoryTurnDelta({ memory, projectId: 'proj-1', baseline });
    expect(delta.block).toContain('⚠ conflicts with [M-02]');
  });
});

// Cross-project condition (study T4): personal-scope memory must follow the
// participant into a NEW project, while the previous project's project-scope
// memory must NOT leak in (scope discipline). Pinned here because the whole
// cross-project measurement rests on this being correct per arm.
describe('cross-project condition policies (T4)', () => {
  test('MemoSync preserves personal memory without leaking another project', () => {
    const memosync = planMemoryInjection({
      policy: resolveConditionPolicy('memosync'),
      memory,
      projectId: 'proj-2-fresh',
    });
    expect(memosync.injectedMemories.map((m) => m.content)).toContain('Prefers bun over npm');
    expect(memosync.injectedMemories.map((m) => m.content)).not.toContain('Never push to main');

  });
});
