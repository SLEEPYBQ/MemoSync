import { describe, it, expect } from 'bun:test';
import { createRelevanceService } from './relevance';
import type { LlmJsonCaller } from './deepseek';
import type { MemoryItem } from './types';

function mem(id: string, content: string, over: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id,
    content,
    scope: 'project',
    type: 'fact',
    status: 'active',
    createdAt: '',
    updatedAt: '',
    usageCount: 0,
    reinforcedCount: 0,
    version: 1,
    citedInCurrentSession: 0,
    abstractionLevel: 'contextual',
    sensitive: false,
    ...over,
  };
}

const INDEX = [
  mem('M-01', 'SSH deploy key lives at ~/.ssh/id_ed25519_server'),
  mem('M-02', 'Use pnpm, never npm'),
  mem('M-03', 'Dev server runs on port 3210'),
];

describe('relevance sidecar (REDESIGN D6 — a prediction, never a fact)', () => {
  it('returns validated hints for injected ids only; hallucinated ids and dupes are dropped', async () => {
    const call: LlmJsonCaller = async () => ({
      relevant: [
        { id: 'M-01', why: 'deploying needs the SSH key path' },
        { id: 'M-99', why: 'hallucinated — not on the receipt' },
        { id: 'M-01', why: 'duplicate' },
        { id: 'M-03', why: 'server port for the sync target' },
      ],
    });
    const svc = createRelevanceService({ callJson: call });
    const out = await svc.assess('sync the build to the prod server', INDEX);
    expect(out.map((r) => r.id)).toEqual(['M-01', 'M-03']);
    expect(out[0]!.why).toContain('SSH key');
  });

  it('caps at 5 and clamps long why-clauses', async () => {
    const many = Array.from({ length: 8 }, (_, i) => mem(`M-1${i}`, `fact ${i} alpha beta`));
    const call: LlmJsonCaller = async () => ({
      relevant: many.map((m) => ({ id: m.id, why: 'x'.repeat(200) })),
    });
    const svc = createRelevanceService({ callJson: call });
    const out = await svc.assess('task', many);
    expect(out).toHaveLength(5);
    expect(out[0]!.why.length).toBeLessThanOrEqual(80);
  });

  it('degrades to [] on LLM failure, malformed output, empty index, or empty task', async () => {
    const failing: LlmJsonCaller = async () => {
      throw new Error('DeepSeek down');
    };
    expect(await createRelevanceService({ callJson: failing }).assess('task', INDEX)).toEqual([]);

    const malformed: LlmJsonCaller = async () => ({ nope: true });
    expect(await createRelevanceService({ callJson: malformed }).assess('task', INDEX)).toEqual([]);

    const never: LlmJsonCaller = async () => {
      throw new Error('must not be called');
    };
    expect(await createRelevanceService({ callJson: never }).assess('task', [])).toEqual([]);
    expect(await createRelevanceService({ callJson: never }).assess('   ', INDEX)).toEqual([]);
  });
});

describe('one-call fast path (relevance + expectedUse, 2026-08-08)', () => {
  const items = [
    { id: 'M-01', scope: 'personal', type: 'constraint', content: 'Use bun', usageCount: 0 },
    { id: 'M-02', scope: 'project', type: 'fact', content: 'API needs tests', detail: 'long form', usageCount: 0 },
    { id: 'M-03', scope: 'session', type: 'fact', content: 'Carryover item', usageCount: 0 },
  ] as never[];

  it('passes expectedUse through and always returns must-include ids', async () => {
    const svc = createRelevanceService({
      callJson: async (req) => {
        expect(req.user).toContain('MUST-INCLUDE ids: M-03');
        expect(req.user).toContain('[+detail]');
        return {
          relevant: [
            { id: 'M-01', why: 'bun rule applies', expectedUse: 'Run every script with bun, not npm.' },
          ],
        };
      },
    });
    const out = await svc.assess('write a script', items, { mustInclude: ['M-03'] });
    expect(out.map((r) => r.id)).toEqual(['M-01', 'M-03']);
    expect(out[0]!.expectedUse).toBe('Run every script with bun, not npm.');
    // Dropped carryover rides along without an expectedUse (Use Planner tops it up).
    expect(out[1]!.expectedUse).toBeUndefined();
  });

  it('failure still returns the carryovers so they stay selected', async () => {
    const svc = createRelevanceService({
      callJson: async () => {
        throw new Error('timeout');
      },
    });
    const out = await svc.assess('task', items, { mustInclude: ['M-03'] });
    expect(out).toEqual([{ id: 'M-03', why: '' }]);
  });
});

it('recent-context digest rides the prompt before the task (option C, 2026-08-08)', async () => {
  const svc = createRelevanceService({
    callJson: async (req) => {
      expect(req.user).toContain('Recent conversation (earlier turns');
      expect(req.user.indexOf('previous turn about deploys')).toBeLessThan(req.user.indexOf('Task:'));
      return { relevant: [] };
    },
  });
  const out = await svc.assess(
    'next task',
    [{ id: 'M-01', scope: 'personal', type: 'fact', content: 'x', usageCount: 0 }] as never[],
    { recentContext: 'User: previous turn about deploys\nAssistant: done' },
  );
  expect(out).toEqual([]);
});
