import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryService } from './index';
import { buildMemoryToolSpecs, dispatchMemoryTool } from './tools';
import { buildMemoryBlock } from './prompt';
import { extractCitations, recordCitations } from './citations';
import { toCodexDynamicTools } from './codex-adapter';

let dir: string;
let memory: MemoryService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memv2-tools-'));
  memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
});
afterEach(() => {
  memory.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('memory tools (engine-neutral)', () => {
  it('without a capture service: ONLY load_memory_detail — no propose_memory, no search_memory (the injected list is the complete surface)', () => {
    const names = buildMemoryToolSpecs(memory).map((s) => s.name);
    expect(names).not.toContain('propose_memory');
    expect(names).not.toContain('search_memory');
    expect(names).toEqual(['load_memory_detail']);
  });

  it('with a capture service: propose_memory joins the toolset and routes through the gate (REDESIGN D3)', async () => {
    const routed: unknown[] = [];
    const captureStub = {
      capture: async () => {
        throw new Error('not used here');
      },
      captureFromPrompt: async (): Promise<never> => {
        throw new Error('not used here');
      },
      routeProposal: async (raw: unknown) => {
        routed.push(raw);
        const item = memory.store.create(
          { content: 'SSH key at ~/.ssh/id_ed25519_server', scope: 'personal', type: 'fact', status: 'candidate' },
          { actor: 'agent' },
        );
        return {
          created: [item],
          proposed: 1,
          surfaced: 1,
          dropped: 0,
          conflicts: 0,
          reinforced: 0,
          reinforcedIds: [],
          revisions: 0,
          pending: [],
        };
      },
    };
    const specs = buildMemoryToolSpecs(memory, { capture: captureStub });
    expect(specs.map((s) => s.name)).toEqual(['propose_memory', 'load_memory_detail']);
    // Still no search tool — the receipt stays the complete surface.
    expect(specs.map((s) => s.name)).not.toContain('search_memory');
    const propose = specs.find((spec) => spec.name === 'propose_memory')!;
    const contentDescription = (propose.schema.content as unknown as { description?: string }).description;
    expect(contentDescription).toContain('at most 100 words');
    expect(contentDescription).toContain('semantically complete');
    expect(contentDescription).not.toContain('160 chars');

    const r = await dispatchMemoryTool(
      specs,
      'propose_memory',
      { content: 'SSH key at ~/.ssh/id_ed25519_server', scope: 'personal', type: 'fact' },
      { sessionId: 's-tool' },
    );
    expect(routed).toHaveLength(1);
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain('awaits the user');
    expect(r.text).toContain('NOT active yet');
  });

  it('threads the active turn and engine from the tool context into propose_memory routing', async () => {
    const routedContexts: unknown[] = [];
    const captureStub = {
      capture: async () => { throw new Error('not used here'); },
      captureFromPrompt: async (): Promise<never> => { throw new Error('not used here'); },
      routeProposal: async (_raw: unknown, input: unknown) => {
        routedContexts.push(input);
        return {
          created: [], proposed: 1, surfaced: 0, dropped: 1, conflicts: 0,
          reinforced: 0, reinforcedIds: [], revisions: 0, pending: [],
        };
      },
    };
    const specs = buildMemoryToolSpecs(memory, { capture: captureStub });

    await dispatchMemoryTool(
      specs,
      'propose_memory',
      { content: 'Use pnpm in this repo' },
      { projectId: 'P1', sessionId: 'chat-1', turn: 6, engine: 'claude' },
    );

    expect(routedContexts).toEqual([
      { projectId: 'P1', sessionId: 'chat-1', turn: 6, engine: 'claude' },
    ]);
  });

  it('reports a same-turn duplicate without firing the pending Candidate callback', async () => {
    const pending = memory.store.create(
      {
        content: 'Use pnpm for this project',
        scope: 'project',
        projectId: 'P1',
        type: 'constraint',
        status: 'candidate',
        provenanceSessionId: 'chat-1',
      },
      { actor: 'agent', sessionId: 'chat-1' },
    );
    const proposed: unknown[] = [];
    const captureStub = {
      capture: async () => { throw new Error('not used here'); },
      captureFromPrompt: async (): Promise<never> => { throw new Error('not used here'); },
      routeProposal: async () => ({
        created: [], proposed: 1, surfaced: 0, dropped: 1, conflicts: 0,
        reinforced: 0, reinforcedIds: [], revisions: 0, pending: [],
        sameTurnDuplicates: [{ memoryId: pending.id, status: 'candidate' as const }],
      }),
    };
    const specs = buildMemoryToolSpecs(memory, {
      capture: captureStub,
      pendingCandidateTiming: 'next_turn',
      onProposed: (...args) => proposed.push(args),
    });

    const result = await dispatchMemoryTool(
      specs,
      'propose_memory',
      { content: pending.content },
      { sessionId: 'chat-1', turn: 2, engine: 'claude' },
    );

    expect(proposed).toHaveLength(0);
    expect(result.text.toLowerCase()).toContain('already handled earlier this turn');
    expect(result.text).toContain("next turn's Candidate review");
    expect(result.text).not.toContain('previously dismissed');
  });

  it('does not add a next-turn promise to a same-turn duplicate of another chat pending Candidate', async () => {
    const pending = memory.store.create(
      {
        content: 'Use pnpm for this project',
        scope: 'project',
        projectId: 'P1',
        type: 'constraint',
        status: 'candidate',
        provenanceSessionId: 'chat-origin',
      },
      { actor: 'agent', sessionId: 'chat-origin' },
    );
    const captureStub = {
      capture: async () => { throw new Error('not used here'); },
      captureFromPrompt: async (): Promise<never> => { throw new Error('not used here'); },
      routeProposal: async () => ({
        created: [], proposed: 1, surfaced: 0, dropped: 1, conflicts: 0,
        reinforced: 0, reinforcedIds: [], revisions: 0, pending: [],
        sameTurnDuplicates: [{ memoryId: pending.id, status: 'candidate' as const }],
      }),
    };
    const specs = buildMemoryToolSpecs(memory, {
      capture: captureStub,
      pendingCandidateTiming: 'next_turn',
    });

    const result = await dispatchMemoryTool(
      specs,
      'propose_memory',
      { content: pending.content },
      { projectId: 'P1', sessionId: 'chat-current', turn: 3, engine: 'claude' },
    );

    expect(result.text).toContain('Memory Board');
    expect(result.text).toContain('NOT active yet');
    expect(result.text).not.toContain("next turn's Candidate review");
  });

  it('Claude next-turn mode promises the Candidate review when the pending Candidate belongs to this chat', async () => {
    const pending = memory.store.create(
      {
        content: 'Use pnpm for this project',
        scope: 'project',
        projectId: 'P1',
        type: 'constraint',
        status: 'candidate',
        provenanceSessionId: 'chat-1',
      },
      { actor: 'agent', sessionId: 'chat-1' },
    );
    const proposed: unknown[] = [];
    const captureStub = {
      capture: async () => { throw new Error('not used here'); },
      captureFromPrompt: async (): Promise<never> => { throw new Error('not used here'); },
      routeProposal: async () => ({
        created: [], proposed: 0, surfaced: 0, dropped: 1, conflicts: 0,
        reinforced: 0, reinforcedIds: [], revisions: 0, pending: [pending],
      }),
    };
    const specs = buildMemoryToolSpecs(memory, {
      capture: captureStub,
      pendingCandidateTiming: 'next_turn',
      onProposed: (...args) => proposed.push(args),
    });

    const result = await dispatchMemoryTool(specs, 'propose_memory', { content: pending.content }, { sessionId: 'chat-1' });

    expect(proposed).toHaveLength(0);
    expect(result.text).toContain("next turn's Candidate review");
    expect(result.text).toContain('NOT active yet');
    expect(result.text).not.toContain('shown again');
  });

  it('Claude next-turn mode does not promise this chat will show a pending Candidate from another chat', async () => {
    const pending = memory.store.create(
      {
        content: 'Use pnpm for this project',
        scope: 'project',
        projectId: 'P1',
        type: 'constraint',
        status: 'candidate',
        provenanceSessionId: 'chat-origin',
      },
      { actor: 'agent', sessionId: 'chat-origin' },
    );
    const proposed: unknown[] = [];
    const captureStub = {
      capture: async () => { throw new Error('not used here'); },
      captureFromPrompt: async (): Promise<never> => { throw new Error('not used here'); },
      routeProposal: async () => ({
        created: [], proposed: 0, surfaced: 0, dropped: 1, conflicts: 0,
        reinforced: 0, reinforcedIds: [], revisions: 0, pending: [pending],
      }),
    };
    const specs = buildMemoryToolSpecs(memory, {
      capture: captureStub,
      pendingCandidateTiming: 'next_turn',
      onProposed: (...args) => proposed.push(args),
    });

    const result = await dispatchMemoryTool(
      specs,
      'propose_memory',
      { content: pending.content },
      { projectId: 'P1', sessionId: 'chat-current', turn: 3, engine: 'claude' },
    );

    expect(proposed).toHaveLength(0);
    expect(result.text).toContain('still pending');
    expect(result.text).toContain('Memory Board');
    expect(result.text).toContain('NOT active yet');
    expect(result.text).not.toContain("next turn's Candidate review");
    expect(result.text).not.toContain('shown again');
  });

  it('keeps the legacy immediate-resurface callback as the engine-neutral default', async () => {
    const pending = memory.store.create(
      { content: 'Prefer compact functions', scope: 'personal', type: 'preference', status: 'candidate' },
      { actor: 'agent', sessionId: 'chat-legacy' },
    );
    const proposed: unknown[] = [];
    const captureStub = {
      capture: async () => { throw new Error('not used here'); },
      captureFromPrompt: async (): Promise<never> => { throw new Error('not used here'); },
      routeProposal: async () => ({
        created: [], proposed: 0, surfaced: 0, dropped: 1, conflicts: 0,
        reinforced: 0, reinforcedIds: [], revisions: 0, pending: [pending],
      }),
    };
    const specs = buildMemoryToolSpecs(memory, {
      capture: captureStub,
      onProposed: (...args) => proposed.push(args),
    });

    const result = await dispatchMemoryTool(specs, 'propose_memory', { content: pending.content }, { sessionId: 'chat-legacy' });

    expect(proposed).toEqual([[[pending], { resurfaced: true }]]);
    expect(result.text).toContain('shown again');
  });

  it('load_memory_detail returns detailed forms and records detail-loaded uses', async () => {
    const withDetail = memory.store.create(
      {
        content: 'Only run MainTests before pushing',
        detail: 'The full suite takes 40min; MainTests covers the gate in ~19s. CI runs the rest nightly.',
        scope: 'project',
        type: 'constraint',
        projectId: 'RenderX',
      },
      { actor: 'system' },
    );
    const shortOnly = memory.store.create(
      { content: 'Prefer early returns', scope: 'personal', type: 'preference' },
      { actor: 'system' },
    );
    const specs = buildMemoryToolSpecs(memory);
    const r = await dispatchMemoryTool(
      specs,
      'load_memory_detail',
      { ids: [withDetail.id, shortOnly.id] },
      { sessionId: 'sess-1' },
    );
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('MainTests covers the gate');
    expect(r.text).toContain('no additional detail');

    const uses = memory.store.getEvents(withDetail.id).filter((e) => e.kind === 'use');
    expect(uses).toHaveLength(1);
    expect(uses[0].meta?.via).toBe('detail_load');
    expect(uses[0].meta?.detailLoaded).toBe(true);
    expect(uses[0].sessionId).toBe('sess-1');
  });

  it('load_memory_detail ignores unknown/inactive ids and rejects an empty list', async () => {
    const archived = memory.store.create({ content: 'x', scope: 'personal', type: 'fact' }, { actor: 'system' });
    memory.store.archive(archived.id, { actor: 'system' });
    const specs = buildMemoryToolSpecs(memory);
    const r = await dispatchMemoryTool(specs, 'load_memory_detail', { ids: ['M-99', archived.id] }, {});
    expect(r.text).toContain('No matching active memories');
    expect((await dispatchMemoryTool(specs, 'load_memory_detail', { ids: [] }, {})).isError).toBe(true);
  });

  it('dispatch rejects an unknown tool', async () => {
    const r = await dispatchMemoryTool(buildMemoryToolSpecs(memory), 'nope', {}, {});
    expect(r.isError).toBe(true);
  });
});

describe('memory prompt block (memory-as-skills)', () => {
  const mem = (over: Record<string, unknown> = {}) => ({
    id: 'M-01',
    content: 'Use fnm',
    scope: 'personal',
    type: 'preference',
    status: 'active',
    createdAt: '',
    updatedAt: '',
    usageCount: 0,
    citedInCurrentSession: 0,
    abstractionLevel: 'contextual',
    sensitive: false,
    version: 1,
    ...over,
  }) as any;

  it('lists SHORT forms, marks items with loadable detail, and gives skills guidance', () => {
    const block = buildMemoryBlock({
      memories: [
        mem(),
        mem({ id: 'M-02', content: 'Only run MainTests', detail: 'Full suite is 40min...', scope: 'project', type: 'constraint' }),
      ],
    });
    expect(block).toContain('# Memory (MemoSync)');
    expect(block).toContain('[M-01 v1] (personal · preference) Use fnm');
    expect(block).toContain('[M-02 v1] (project · constraint) Only run MainTests [+detail]');
    expect(block).not.toContain('[M-01 v1] (personal · preference) Use fnm [+detail]');
    expect(block).toContain('cite it inline at the point of influence as [M-07]');
    expect(block).toContain('Do not leave an influence uncited');
    expect(block).toContain('load_memory_detail');
    // the injected list is the complete memory surface — no search reaching past it
    expect(block).not.toContain('search_memory');
    // capture is a forced system hook now — the model must not be told to propose
    expect(block).not.toContain('propose_memory');
  });

  it('omits tool guidance when tools disabled', () => {
    const block = buildMemoryBlock({ memories: [], tools: false });
    expect(block).toBe('');
  });
});

describe('citation extraction', () => {
  it('extracts unique [M-NN] ids in first-seen order', () => {
    expect(extractCitations('per [M-07] and [M-01], also [M-07] again')).toEqual(['M-07', 'M-01']);
    expect(extractCitations('no citations here')).toEqual([]);
  });

  it('recordCitations only counts available ids and bumps usage', () => {
    const bumped: string[] = [];
    const counted = recordCitations('use [M-01] not [M-99]', new Set(['M-01']), (id) => bumped.push(id));
    expect(counted).toEqual(['M-01']);
    expect(bumped).toEqual(['M-01']);
  });
});

describe('codex dynamic-tool declarations', () => {
  it('converts specs to function declarations with JSON-schema input', () => {
    const decls = toCodexDynamicTools(buildMemoryToolSpecs(memory));
    expect(decls).toHaveLength(1);
    const load = decls.find((d) => d.name === 'load_memory_detail')!;
    expect(load.type).toBe('function');
    const lschema = load.inputSchema as any;
    expect(lschema.type).toBe('object');
    expect(lschema.properties.ids).toBeDefined();
    expect(lschema.required).toContain('ids');
  });
});
