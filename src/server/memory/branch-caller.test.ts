import { describe, expect, it } from 'bun:test';
import { createBranchJsonCaller, memoryRequestContext, type MemoryReasoningContext } from './branch-caller';
import type { MemoryBranchInput } from './branch-runtime';

describe('auxiliary memory branch caller', () => {
  it('isolates overlapping Board operations and resolves each branch against its own provider and parent', async () => {
    const resolved: MemoryReasoningContext[] = [];
    const created: MemoryBranchInput[] = [];
    const prompts: string[] = [];
    const disposed: string[] = [];
    const caller = createBranchJsonCaller({
      resolve(context) {
        resolved.push(context);
        return { provider: context.sessionId === 'A' ? 'claude' : 'codex', parentSessionToken: `parent-${context.sessionId}`, localPath: `/tmp/${context.projectId}`, model: 'test-model' };
      },
      createBranch(input) {
        created.push(input);
        return {
          id: input.parentSessionToken!, mode: 'fork', sessionToken: 'branch-session',
          ask: async (prompt) => { prompts.push(prompt); await Promise.resolve(); return { parent: input.parentSessionToken }; },
          dispose: () => { disposed.push(input.parentSessionToken!); },
        };
      },
    });
    let releaseA!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseA = resolve; });
    const first = caller.run({ sessionId: 'A', projectId: 'P-A' }, async () => {
      await blocked;
      return caller.callJson({ system: 'Analyze source A', user: 'Task A', timeoutMs: 321 });
    });
    const second = caller.run({ sessionId: 'B', projectId: 'P-B' }, async () => {
      await Promise.resolve();
      const result = await caller.callJson({ system: 'Analyze source B', user: 'Task B' });
      releaseA();
      return result;
    });
    expect(await second).toEqual({ parent: 'parent-B' });
    expect(await first).toEqual({ parent: 'parent-A' });
    expect(resolved).toEqual([{ sessionId: 'B', projectId: 'P-B' }, { sessionId: 'A', projectId: 'P-A' }]);
    expect(created.map((input) => [input.provider, input.parentSessionToken, input.localPath])).toEqual([
      ['codex', 'parent-B', '/tmp/P-B'], ['claude', 'parent-A', '/tmp/P-A'],
    ]);
    expect(created[1]!.timeoutMs).toBe(321);
    expect(created.every((input) => input.purpose === 'memory-board')).toBe(true);
    expect(prompts[0]).toContain('Analyze source B\n\nTask B');
    expect(prompts[1]).toContain('Analyze source A\n\nTask A');
    expect(disposed.sort()).toEqual(['parent-A', 'parent-B']);
  });

  it('retains the provider error and disposes the branch, including an aborted caller signal', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Request cancelled'));
    let disposed = 0;
    const caller = createBranchJsonCaller({
      resolve: () => ({ provider: 'claude', parentSessionToken: 'main', localPath: '/tmp/project', model: 'test-model' }),
      createBranch: () => ({
        id: 'private', mode: 'fork', sessionToken: 'child',
        ask: async (_prompt, options) => {
          expect(options?.signal).toBe(controller.signal);
          throw options?.signal?.reason;
        },
        dispose: () => { disposed += 1; },
      }),
    });
    await expect(caller.run({ sessionId: 'A' }, () => caller.callJson({ system: 'check', user: 'memory', signal: controller.signal }))).rejects.toThrow('Request cancelled');
    expect(disposed).toBe(1);
  });

  it('does not retain an earlier request context for operations outside its async scope', async () => {
    const contexts: MemoryReasoningContext[] = [];
    const caller = createBranchJsonCaller({
      resolve: (context) => { contexts.push(context); return { provider: 'codex', parentSessionToken: null, localPath: '/tmp', model: 'test-model' }; },
      createBranch: () => ({ id: 'private', mode: 'empty-history', sessionToken: null, ask: async () => ({}), dispose() {} }),
    });
    await caller.run({ sessionId: 'first' }, () => caller.callJson({ system: 'check', user: 'one' }));
    await caller.callJson({ system: 'check', user: 'two' });
    expect(contexts).toEqual([{ sessionId: 'first' }, {}]);
  });
});

describe('memory request context', () => {
  it('reads a clone and keeps the original body available to route validation', async () => {
    const body = JSON.stringify({ chatId: 'chat-A', sessionId: 'old', projectId: 'source', targetProjectId: 'target' });
    const request = new Request('http://localhost/api/memory?sessionId=query', { method: 'POST', body });
    expect(await memoryRequestContext(request, new URL(request.url))).toEqual({ sessionId: 'chat-A', projectId: 'target' });
    expect(await request.text()).toBe(body);
  });

  it('tolerates malformed, scalar, or wrongly typed bodies and leaves errors to the route', async () => {
    for (const body of ['{broken', 'null', '[]', '17', '{"chatId":42,"projectId":{}}']) {
      const request = new Request('http://localhost/api/memory?sessionId=query-chat&projectId=query-project', { method: 'PATCH', body });
      expect(await memoryRequestContext(request, new URL(request.url))).toEqual({ sessionId: 'query-chat', projectId: 'query-project' });
      expect(await request.text()).toBe(body);
    }
    const request = new Request('http://localhost/api/memory');
    expect(await memoryRequestContext(request, new URL(request.url))).toEqual({ sessionId: undefined, projectId: undefined });
  });
});
