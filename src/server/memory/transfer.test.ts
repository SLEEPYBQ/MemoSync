import { describe, it, expect } from 'bun:test';
import { createTransferService } from './transfer';
import type { MemoryItem } from './types';
import type { DeepSeekJsonRequest } from './deepseek';

function mem(over: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: 'M-14',
    content: 'Lesson: the dev server port 3000 conflicts with the preview proxy, use 3001',
    scope: 'project',
    type: 'lesson',
    status: 'active',
    createdAt: '',
    updatedAt: '',
    usageCount: 0,
    reinforcedCount: 0,
    version: 1,
    citedInCurrentSession: 0,
    abstractionLevel: 'concrete',
    sensitive: false,
    projectId: 'proj-a',
    ...over,
  };
}

const ENCODE_REPLY = {
  rule: 'Avoid dev-server port conflicts by picking a free port',
  applicability: 'Projects running a local dev server',
  portable: true,
  note: 'Port number is source-specific.',
};

const DECODE_REPLY = {
  content: 'Check for dev-server port conflicts before starting; pick a free port',
  abstractionLevel: 'general',
  suggestedScope: 'project',
  landingRoute: 'new',
  note: 'Generalized the underlying lesson.',
};

/** Stub that answers the encode and decode prompts differently and records both. */
function dispatchingStub(replies: { encode?: Record<string, unknown>; decode?: Record<string, unknown> }) {
  const seen: { encode?: DeepSeekJsonRequest; decode?: DeepSeekJsonRequest } = {};
  const callJson = async (req: DeepSeekJsonRequest) => {
    if (req.system.includes('ENCODE step')) {
      seen.encode = req;
      return replies.encode ?? ENCODE_REPLY;
    }
    seen.decode = req;
    return replies.decode ?? DECODE_REPLY;
  };
  return { callJson, seen };
}

describe('transfer encode (source → abstract rule)', () => {
  it('returns the rule, applicability, and portability', async () => {
    const { callJson } = dispatchingStub({});
    const svc = createTransferService({ callJson });
    const out = await svc.encode(mem(), { projectTitle: 'Alpha' });
    expect(out.rule).toContain('port conflicts');
    expect(out.applicability).toContain('dev server');
    expect(out.portable).toBe(true);
    expect(out.note).toContain('source-specific');
  });

  it('feeds the stable source profile into the prompt and excludes volatile evidence counters', async () => {
    const { callJson, seen } = dispatchingStub({});
    const svc = createTransferService({ callJson });
    await svc.encode(mem({ usageCount: 5, reinforcedCount: 2 }), {
      projectTitle: 'Alpha',
      representative: [
        { id: 'M-14', content: 'the memory being transferred — must not appear as profile' },
        { id: 'M-2', content: 'Alpha uses fastify + react' },
      ],
    });
    const user = seen.encode!.user;
    expect(user).toContain('port 3000');
    expect(user).toContain('project "Alpha"');
    expect(user).not.toContain('cited in 5 turn(s)');
    expect(user).not.toContain('re-observed 2 time(s)');
    expect(user).toContain('[M-2] Alpha uses fastify + react');
    expect(user).not.toContain('must not appear as profile');
    expect(seen.encode!.system).not.toContain('wider scope');
  });

  it('keeps only verbatim source substrings in stripped — hallucinated fragments never highlight', async () => {
    const { callJson } = dispatchingStub({
      encode: { ...ENCODE_REPLY, stripped: ['port 3000', 'made-up fragment', '  3001 '] },
    });
    const svc = createTransferService({ callJson });
    const out = await svc.encode(
      mem({ content: 'Dev server port 3000 conflicts with the proxy; use 3001' }),
      {},
    );
    expect(out.stripped).toEqual(['port 3000', '3001']);
  });

  it('falls back to the source text when the model returns no rule; portable defaults true', async () => {
    const { callJson } = dispatchingStub({ encode: { note: 'shrug' } });
    const svc = createTransferService({ callJson });
    const out = await svc.encode(mem(), {});
    expect(out.rule).toBe(mem().content);
    expect(out.portable).toBe(true);
    expect(out.applicability).toBeUndefined();
  });
});

describe('transfer decode (abstract rule → target)', () => {
  const encoding = { rule: 'Prefer pnpm over npm', applicability: 'Node projects' };

  it('localizes the rule and returns the suggested landing scope', async () => {
    const { callJson, seen } = dispatchingStub({
      decode: { ...DECODE_REPLY, content: 'Use pnpm in RenderX', suggestedScope: 'session' },
    });
    const svc = createTransferService({ callJson });
    const out = await svc.decode(encoding, {
      target: { scope: 'project', projectId: 'proj-b', projectTitle: 'RenderX' },
    });
    expect(out.content).toBe('Use pnpm in RenderX');
    expect(out.suggestedScope).toBe('session');
    expect(seen.decode!.user).toContain('Abstract rule: Prefer pnpm over npm');
    expect(seen.decode!.user).toContain('Applies when: Node projects');
    expect(seen.decode!.user).toContain('RenderX');
  });

  it('passes task text and the recent-conversation digest to the prompt when given', async () => {
    const { callJson, seen } = dispatchingStub({});
    const svc = createTransferService({ callJson });
    await svc.decode(encoding, {
      target: { scope: 'project', projectId: 'proj-b' },
      taskText: 'Build the checkout page',
      recentContext: 'User: cart is done\nAssistant: shipped it',
    });
    expect(seen.decode!.user).toContain('Build the checkout page');
    expect(seen.decode!.user).toContain('cart is done');
  });

  it('binds a reinforces landing only to an id in the target short-list (CAS)', async () => {
    const { callJson } = dispatchingStub({
      decode: { ...DECODE_REPLY, landingRoute: 'reinforces', landingTargetId: 'M-20' },
    });
    const svc = createTransferService({ callJson });
    const existing = [{ id: 'M-20', content: 'pnpm is the package manager' }];
    const bound = await svc.decode(encoding, { target: { scope: 'personal', existing } });
    expect(bound.landing).toEqual({ route: 'reinforces', targetId: 'M-20', targetContent: 'pnpm is the package manager' });

    // A hallucinated id (not in the short-list) degrades to a plain "new" landing.
    const halluc = await svc.decode(encoding, {
      target: { scope: 'personal', existing: [{ id: 'M-99', content: 'unrelated' }] },
    });
    expect(halluc.landing).toEqual({ route: 'new' });
  });

  it('snapshots the matched landing target version for automatic Transfer CAS', async () => {
    const { callJson } = dispatchingStub({
      decode: { ...DECODE_REPLY, landingRoute: 'reinforces', landingTargetId: 'M-20' },
    });
    const svc = createTransferService({ callJson });
    const bound = await svc.decode(encoding, {
      target: {
        scope: 'personal',
        existing: [{ id: 'M-20', version: 4, content: 'pnpm is the package manager' }],
      },
    });

    expect(bound.landing).toEqual({
      route: 'reinforces',
      targetId: 'M-20',
      targetContent: 'pnpm is the package manager',
      targetVersion: 4,
    });
  });

  it('keeps only verbatim content substrings in bound', async () => {
    const { callJson } = dispatchingStub({
      decode: { ...DECODE_REPLY, content: 'Use snow #fffafa here', bound: ['#fffafa', 'not present'] },
    });
    const svc = createTransferService({ callJson });
    const out = await svc.decode(encoding, { target: { scope: 'project', projectId: 'p' } });
    expect(out.bound).toEqual(['#fffafa']);
  });

  it('coerces an invalid suggestedScope to the target scope', async () => {
    const { callJson } = dispatchingStub({ decode: { ...DECODE_REPLY, suggestedScope: 'galaxy' } });
    const svc = createTransferService({ callJson });
    const out = await svc.decode(encoding, { target: { scope: 'personal' } });
    expect(out.suggestedScope).toBe('personal');
  });
});

describe('transfer propose (encode → decode chain, Board compat)', () => {
  it('chains the two stages and derives a rewrite verdict from changed content', async () => {
    const { callJson, seen } = dispatchingStub({});
    const svc = createTransferService({ callJson });
    const out = await svc.propose(mem(), { scope: 'personal' }, { projectTitle: 'Alpha' });
    expect(seen.encode).toBeDefined();
    expect(seen.decode).toBeDefined();
    expect(seen.decode!.user).toContain(ENCODE_REPLY.rule); // decode consumed the encoding
    expect(out.verdict).toBe('rewrite');
    expect(out.portable).toBe(ENCODE_REPLY.rule);
    expect(out.applicability).toBe(ENCODE_REPLY.applicability);
    expect(out.content).toBe(DECODE_REPLY.content);
    expect(out.abstractionLevel).toBe('general');
    expect(out.landing.route).toBe('new');
  });

  it('derives as_is when the decoded content equals the source, keeping source detail/level', async () => {
    const source = mem({ content: 'Prefer TypeScript for all new code', abstractionLevel: 'general', detail: 'strict mode too' });
    const { callJson } = dispatchingStub({
      decode: { ...DECODE_REPLY, content: 'Prefer TypeScript for all new code' },
    });
    const svc = createTransferService({ callJson });
    const out = await svc.propose(source, { scope: 'personal' });
    expect(out.verdict).toBe('as_is');
    expect(out.content).toBe('Prefer TypeScript for all new code');
    expect(out.detail).toBe('strict mode too');
    expect(out.abstractionLevel).toBe('general');
  });

  it('derives context_bound from the encoder, still returning a decoded form for "transfer anyway"', async () => {
    const { callJson } = dispatchingStub({
      encode: { ...ENCODE_REPLY, portable: false, note: 'Only meaningful at the source.' },
    });
    const svc = createTransferService({ callJson });
    const out = await svc.propose(mem(), { scope: 'personal' });
    expect(out.verdict).toBe('context_bound');
    expect(out.content).toBe(DECODE_REPLY.content);
  });

  it('feeds the target existing memories to the decode prompt', async () => {
    const { callJson, seen } = dispatchingStub({});
    const svc = createTransferService({ callJson });
    await svc.propose(mem(), { scope: 'personal', existing: [{ id: 'M-30', content: 'existing personal rule' }] });
    expect(seen.decode!.user).toContain('existing personal rule');
    expect(seen.encode!.user).not.toContain('existing personal rule'); // encoder never sees the target
  });

  it('propagates LLM failures (caller decides the fallback)', async () => {
    const svc = createTransferService({
      callJson: async () => {
        throw new Error('deepseek down');
      },
    });
    await expect(svc.propose(mem(), { scope: 'personal' })).rejects.toThrow('deepseek down');
  });
});
