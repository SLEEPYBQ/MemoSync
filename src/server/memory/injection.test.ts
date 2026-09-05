import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryService } from './index';
import { computeMemoryTurnDelta, normalizeMemorySelection, planMemoryInjection } from './injection';
import { resolveConditionPolicy } from '../experiment/condition';
import { STATIC_MEMORY_FILENAME } from './static-files';

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
      provider: 'claude',
      memory,
      projectId: 'proj-1',
      workspaceDir: dir,
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
      workspaceDir: dir,
    };
    const before = planMemoryInjection(opts);
    memory.store.update('M-01', { content: 'Prefers pnpm now' }, { actor: 'user' });
    const after = planMemoryInjection(opts);
    expect(after.hash).not.toBe(before.hash); // content fingerprint moves…
    expect(after.sessionRebuildKey).toBe(before.sessionRebuildKey); // …but no rebuild
  });

  test('skills: per-turn restriction filters injectedMemories but never the baked block', () => {
    const plan = planMemoryInjection({
      policy: resolveConditionPolicy('memosync'),
      provider: 'claude',
      memory,
      projectId: 'proj-1',
      workspaceDir: dir,
      restrictToIds: ['M-02'],
    });
    expect(plan.injectedMemories.map((m) => m.id)).toEqual(['M-02']);
    expect(plan.bakedMemories.map((m) => m.id)).toEqual(['M-01', 'M-02']);
    expect(plan.block).toContain('[M-01 v1]'); // full set stays baked
  });

  test('auto arm: plain block, no ids, no tools', () => {
    memory.store.create(
      { content: 'Car project uses dark teal accents', scope: 'project', projectId: 'proj-2', type: 'fact' },
      { actor: 'system' },
    );
    const otherChatMemory = memory.store.create(
      { content: 'The participant corrected the booking flow', scope: 'session', sessionId: 'chat-elsewhere', type: 'lesson' },
      { actor: 'system' },
    );
    memory.store.setSessionExclusions('chat-current', [otherChatMemory.id]);
    const plan = planMemoryInjection({
      policy: resolveConditionPolicy('auto'),
      provider: 'claude',
      memory,
      projectId: 'proj-1',
      chatId: 'chat-current',
      workspaceDir: dir,
      // Auto has no participant-selected Injected Set. A stray restriction
      // from another condition must not narrow its treatment.
      restrictToIds: ['M-01'],
    });
    expect(plan.mode).toBe('plain');
    expect(plan.registerTools).toBe(false);
    expect(plan.block).toContain('- Never push to main');
    expect(plan.block).not.toContain('- Prefers bun over npm');
    expect(plan.block).not.toContain('- Car project uses dark teal accents');
    expect(plan.block).not.toContain('- The participant corrected the booking flow');
    expect(plan.injectedMemories.map((item) => item.id)).toEqual(['M-02']);
    expect(plan.block).not.toContain('[M-');
    expect(plan.block).not.toContain('search_memory');
    expect(plan.block).not.toContain('cite');
  });

  test('Auto shares the complete Project Copy across chats without leaking another project', () => {
    memory.store.create(
      { content: 'Car checkout uses a three-step flow', scope: 'project', projectId: 'proj-2', type: 'fact' },
      { actor: 'system' },
    );
    const common = {
      policy: resolveConditionPolicy('auto'),
      provider: 'claude' as const,
      memory,
      projectId: 'proj-1',
      workspaceDir: dir,
      // Auto focuses the complete current Project Copy. A selection left by a
      // different condition must not narrow it.
      restrictToIds: ['M-01'],
    };

    const sessionOne = planMemoryInjection({ ...common, chatId: 'proj-1-s1-chat' });
    const sessionTwo = planMemoryInjection({ ...common, chatId: 'proj-1-s2-chat' });
    const otherProject = planMemoryInjection({
      ...common,
      projectId: 'proj-2',
      chatId: 'proj-2-s1-chat',
    });

    expect(sessionOne.block).toBe(sessionTwo.block);
    expect(sessionOne.injectedMemories.map((item) => item.content)).toEqual(['Never push to main']);
    expect(sessionOne.block).not.toContain('Car checkout uses a three-step flow');
    expect(sessionOne.block).not.toContain('Prefers bun over npm');
    expect(otherProject.injectedMemories.map((item) => item.content)).toEqual([
      'Car checkout uses a three-step flow',
    ]);
  });

  test('Auto uses the Project Copy only for the Claude study provider', () => {
    memory.store.create(
      { content: 'Car project uses dark teal accents', scope: 'project', projectId: 'proj-2', type: 'fact' },
      { actor: 'system' },
    );
    const excluded = memory.store.create(
      { content: 'This chat uses a confirmation dialog', scope: 'session', sessionId: 'chat-current', type: 'lesson' },
      { actor: 'system' },
    );
    memory.store.setSessionExclusions('chat-current', [excluded.id]);
    const common = {
      policy: resolveConditionPolicy('auto'),
      memory,
      projectId: 'proj-1',
      chatId: 'chat-current',
      workspaceDir: dir,
    };

    const claude = planMemoryInjection({ ...common, provider: 'claude' });
    const codex = planMemoryInjection({ ...common, provider: 'codex' });

    expect(claude.injectedMemories.map((item) => item.content)).toEqual([
      'Never push to main',
    ]);
    expect(codex.injectedMemories.map((item) => item.content)).toEqual([
      'Prefers bun over npm',
      'Never push to main',
    ]);
  });

  test('study Static starts with an empty participant-owned representation instead of SQLite seeds', () => {
    const plan = planMemoryInjection({
      policy: resolveConditionPolicy('static'),
      provider: 'claude',
      memory,
      projectId: 'proj-1',
      workspaceDir: dir,
    });
    expect(plan.mode).toBe('file');
    expect(plan.registerTools).toBe(false);
    expect(existsSync(join(dir, STATIC_MEMORY_FILENAME))).toBe(true);
    expect(readFileSync(join(dir, STATIC_MEMORY_FILENAME), 'utf-8')).not.toContain('Prefers bun over npm');
    expect(readFileSync(join(dir, STATIC_MEMORY_FILENAME), 'utf-8')).not.toContain('Never push to main');
    expect(plan.block).not.toContain('Prefers bun over npm');
    expect(plan.block).not.toContain('Never push to main');
    expect(plan.injectedMemories).toEqual([]);
    expect(plan.staticFiles).toEqual([STATIC_MEMORY_FILENAME]);
    expect(plan.staticPayload?.text).toBe(plan.block);
    expect(plan.staticPayload?.sources).toEqual([
      expect.objectContaining({
        relPath: STATIC_MEMORY_FILENAME,
        injectedContent: expect.not.stringContaining('Prefers bun over npm'),
      }),
    ]);
  });

  test('non-study file injection keeps the legacy seeded scaffold behavior', () => {
    const plan = planMemoryInjection({
      policy: { ...resolveConditionPolicy('static'), studyMode: false },
      provider: 'claude',
      memory,
      projectId: 'proj-1',
      workspaceDir: dir,
    });

    expect(readFileSync(join(dir, STATIC_MEMORY_FILENAME), 'utf-8')).toContain('Prefers bun over npm');
    expect(readFileSync(join(dir, STATIC_MEMORY_FILENAME), 'utf-8')).toContain('Never push to main');
    expect(plan.block).toContain('Prefers bun over npm');
    expect(plan.block).toContain('Never push to main');
  });

  test('study Static focuses every direct Markdown file without truncating or trimming decoded text', () => {
    const rootText = ` \r\n# Memory\r\n- ${'x'.repeat(30_000)}  \r\n\r\n`;
    writeFileSync(join(dir, STATIC_MEMORY_FILENAME), rootText, 'utf8');
    mkdirSync(join(dir, 'memory'));
    for (let index = 0; index < 21; index += 1) {
      writeFileSync(
        join(dir, 'memory', `topic-${String(index).padStart(2, '0')}.md`),
        `  topic ${index}\r\n`,
      );
    }
    mkdirSync(join(dir, 'memory', 'nested'));
    writeFileSync(join(dir, 'memory', 'nested', 'ignored.md'), 'nested');
    writeFileSync(join(dir, 'memory', 'ignored.txt'), 'text');

    const plan = planMemoryInjection({
      policy: resolveConditionPolicy('static'),
      provider: 'claude',
      memory,
      projectId: 'proj-1',
      workspaceDir: dir,
    });

    expect(plan.staticFiles).toHaveLength(22);
    expect(plan.staticFiles.at(-1)).toBe('memory/topic-20.md');
    const rootSource = plan.staticPayload!.sources[0]!;
    expect(rootSource.injectedContent).toBe(rootText);
    expect(plan.block.slice(rootSource.start, rootSource.end)).toBe(rootText);
    expect(rootSource.contentHash).toBe(createHash('sha256').update(rootText, 'utf8').digest('hex'));
    expect(rootSource.truncated).toBe(false);
    expect(plan.block).not.toContain('<!-- truncated:');
    expect(plan.staticPayload!.sources.at(-1)).toMatchObject({
      relPath: 'memory/topic-20.md',
      injectedContent: '  topic 20\r\n',
    });
    expect(plan.staticFiles).not.toContain('memory/nested/ignored.md');
    expect(plan.staticFiles).not.toContain('memory/ignored.txt');
  });

  test('static arm: hash moves when the participant edits the file', () => {
    const opts = {
      policy: resolveConditionPolicy('static'),
      provider: 'claude' as const,
      memory,
      projectId: 'proj-1',
      workspaceDir: dir,
    };
    const before = planMemoryInjection(opts);
    writeFileSync(join(dir, STATIC_MEMORY_FILENAME), '# Memory\n- switched to pnpm\n');
    const after = planMemoryInjection(opts);
    expect(after.hash).not.toBe(before.hash);
    expect(after.block).toContain('switched to pnpm');
  });

  test('skills and plain hashes differ by mode prefix (arm switch forces rebuild)', () => {
    const skills = planMemoryInjection({
      policy: resolveConditionPolicy('memosync'),
      provider: 'claude',
      memory,
      projectId: 'proj-1',
      workspaceDir: dir,
    });
    const plain = planMemoryInjection({
      policy: resolveConditionPolicy('auto'),
      provider: 'claude',
      memory,
      projectId: 'proj-1',
      workspaceDir: dir,
    });
    expect(skills.hash).not.toBe(plain.hash);
  });
});

describe('computeMemoryTurnDelta', () => {
  function baselineFromBoot(): Map<string, number> {
    const plan = planMemoryInjection({
      policy: resolveConditionPolicy('memosync'),
      provider: 'claude',
      memory,
      projectId: 'proj-1',
      workspaceDir: dir,
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
    // Baseline still tracks the full context (the snapshot was not un-baked).
    expect(delta.nextBaseline.has('M-01')).toBe(true);
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
  test('memosync keeps scope discipline while an uninitialized Auto project starts empty', () => {
    const memosync = planMemoryInjection({
      policy: resolveConditionPolicy('memosync'),
      provider: 'claude',
      memory,
      projectId: 'proj-2-fresh',
      workspaceDir: mkdtempSync(join(tmpdir(), 'xproj-memosync-')),
    });
    expect(memosync.injectedMemories.map((m) => m.content)).toContain('Prefers bun over npm');
    expect(memosync.injectedMemories.map((m) => m.content)).not.toContain('Never push to main');

    const auto = planMemoryInjection({
      policy: resolveConditionPolicy('auto'),
      provider: 'claude',
      memory,
      projectId: 'proj-2-fresh',
      workspaceDir: mkdtempSync(join(tmpdir(), 'xproj-auto-')),
    });
    expect(auto.injectedMemories).toEqual([]);
  });

  test('Static does not synthesize a cross-project copy from shared SQLite rows', () => {
    const projectBWorkspace = mkdtempSync(join(tmpdir(), 'xproj-static-B-'));
    try {
      const plan = planMemoryInjection({
        policy: resolveConditionPolicy('static'),
        provider: 'claude',
        memory,
        projectId: 'proj-2-fresh',
        workspaceDir: projectBWorkspace,
      });
      expect(existsSync(join(projectBWorkspace, STATIC_MEMORY_FILENAME))).toBe(true);
      expect(plan.block).not.toContain('Prefers bun over npm');
      expect(plan.block).not.toContain('Never push to main');
    } finally {
      rmSync(projectBWorkspace, { recursive: true, force: true });
    }
  });
});
