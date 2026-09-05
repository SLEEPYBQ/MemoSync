import { describe, expect, it } from 'bun:test';
import { createTraceService } from './trace';
import type { DeepSeekJsonRequest, LlmJsonCaller } from './deepseek';
import type { MemoryItem } from './types';
import type { ExperimentEvent } from '../experiment/logger';

function mem(id: string, content: string, over: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id,
    content,
    scope: 'project',
    type: 'lesson',
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

/** Fake LlmJsonCaller that records calls and returns a canned object. */
function fakeCallJson(result: Record<string, unknown>): { call: LlmJsonCaller; calls: DeepSeekJsonRequest[] } {
  const calls: DeepSeekJsonRequest[] = [];
  const call: LlmJsonCaller = async (req) => {
    calls.push(req);
    return result;
  };
  return { call, calls };
}

/** Fake logger that records emitted events. */
function fakeLogger(): { logger: { event: (e: ExperimentEvent) => void }; events: ExperimentEvent[] } {
  const events: ExperimentEvent[] = [];
  return { logger: { event: (e) => events.push(e) }, events };
}

describe('createTraceService', () => {
  it('short-circuits on empty usedMemories: no LLM call, no log', async () => {
    const { call, calls } = fakeCallJson({ labels: [] });
    const { logger, events } = fakeLogger();
    const service = createTraceService({ callJson: call, logger });

    const outcome = await service.trace({
      sessionId: 's1',
      userText: 'hi',
      assistantText: 'hello',
      usedMemories: [],
    });

    expect(outcome).toEqual({ labels: [] });
    expect(calls).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it('happy path: labels + notes come back from the LLM for each memory', async () => {
    const m1 = mem('M-01', 'always run pytest with -q');
    const m2 = mem('M-02', 'never touch prod db directly');
    const { call, calls } = fakeCallJson({
      labels: [
        { id: 'M-01', label: 'operational', note: 'used the -q flag as instructed' },
        { id: 'M-02', label: 'violated', note: 'response ran a direct prod query' },
      ],
    });
    const service = createTraceService({ callJson: call });

    const outcome = await service.trace({
      sessionId: 's1',
      engine: 'claude',
      turn: 3,
      userText: 'run the tests',
      assistantText: 'ran pytest -q',
      usedMemories: [m1, m2],
    });

    expect(outcome.labels).toEqual([
      { id: 'M-01', label: 'operational', note: 'used the -q flag as instructed' },
      { id: 'M-02', label: 'violated', note: 'response ran a direct prod query' },
    ]);

    // system/user content reaches the LLM caller with the exchange + memory fields.
    expect(calls).toHaveLength(1);
    expect(calls[0].system).toContain('operational');
    expect(calls[0].system).toContain('injected_without_effect');
    expect(calls[0].system).toContain('violated');
    expect(calls[0].system).toContain('summary');
    expect(calls[0].user).toContain('run the tests');
    expect(calls[0].user).toContain('ran pytest -q');
    expect(calls[0].user).toContain('M-01');
    expect(calls[0].user).toContain('always run pytest with -q');
  });

  it('carries the turn summary through: whitespace collapsed, clamped, dropped when blank/missing', async () => {
    const m1 = mem('M-01', 'always run pytest with -q');
    const run = async (summary: unknown) => {
      const { call } = fakeCallJson({
        summary,
        labels: [{ id: 'M-01', label: 'operational', note: 'n' }],
      });
      const service = createTraceService({ callJson: call });
      return service.trace({ sessionId: 's1', userText: 'u', assistantText: 'a', usedMemories: [m1] });
    };

    const good = await run('Ran the tests per [M-01],\n  quietly.');
    expect(good.summary).toBe('Ran the tests per [M-01], quietly.');

    // A citation of a memory NOT in play this turn is unwrapped to plain text
    // — no client may render a clickable reference to it.
    const hallucinated = await run('Ran tests per [M-01] and honored [M-99].');
    expect(hallucinated.summary).toBe('Ran tests per [M-01] and honored M-99.');

    const long = await run('x'.repeat(500));
    expect(long.summary).toHaveLength(200);

    expect((await run('   ')).summary).toBeUndefined();
    expect((await run(undefined)).summary).toBeUndefined();
    expect((await run(42)).summary).toBeUndefined();
  });

  it('unwraps summary citations of memories the SAME pass judged no-effect', async () => {
    const m1 = mem('M-01', 'always run pytest with -q');
    const m2 = mem('M-02', 'prefer bun over npm');
    const { call } = fakeCallJson({
      summary: 'No influence, but [M-01] shaped the answer per [M-02].',
      labels: [
        { id: 'M-01', label: 'injected_without_effect', note: 'inert' },
        { id: 'M-02', label: 'operational', note: 'ok' },
      ],
    });
    const service = createTraceService({ callJson: call });

    const outcome = await service.trace({ sessionId: 's1', userText: 'u', assistantText: 'a', usedMemories: [m1, m2] });
    // The no-effect id renders as plain text — the summary may not claim
    // influence for a memory the labels just called inert.
    expect(outcome.summary).toBe('No influence, but M-01 shaped the answer per [M-02].');
  });

  it('a trailing citation dump loses its de-cited ids instead of leaving them dangling', async () => {
    const m1 = mem('M-01', 'always run pytest with -q');
    const m2 = mem('M-02', 'prefer bun over npm');
    const run = async (summary: string) => {
      const { call } = fakeCallJson({
        summary,
        labels: [
          { id: 'M-01', label: 'violated', note: 'broke it' },
          { id: 'M-02', label: 'injected_without_effect', note: 'inert' },
        ],
      });
      const service = createTraceService({ callJson: call });
      return service.trace({ sessionId: 's1', userText: 'u', assistantText: 'a', usedMemories: [m1, m2] });
    };

    // The no-effect citation in the tail vanishes; the citable one stays.
    expect((await run('Broke the port rule. [M-01] [M-02]')).summary).toBe('Broke the port rule. [M-01]');
    // A tail of ONLY de-cited ids collapses to the sentence itself.
    expect((await run('Broke the port rule per [M-01]. [M-02]')).summary).toBe('Broke the port rule per [M-01].');
    // Prose mentions mid-sentence keep their bare id — only the tail is swept.
    expect((await run('M-02 stayed idle while [M-01] was broken. [M-02]')).summary).toBe(
      'M-02 stayed idle while [M-01] was broken.',
    );
  });

  it('drops a hallucinated id not present in usedMemories', async () => {
    const m1 = mem('M-01', 'always run pytest with -q');
    const { call } = fakeCallJson({
      labels: [
        { id: 'M-01', label: 'operational', note: 'ok' },
        { id: 'M-99', label: 'operational', note: 'hallucinated' },
      ],
    });
    const service = createTraceService({ callJson: call });

    const outcome = await service.trace({
      sessionId: 's1',
      userText: 'u',
      assistantText: 'a',
      usedMemories: [m1],
    });

    expect(outcome.labels).toEqual([{ id: 'M-01', label: 'operational', note: 'ok' }]);
    expect(outcome.labels.find((l) => l.id === 'M-99')).toBeUndefined();
  });

  it('backfills a memory missing from the LLM answer as injected_without_effect', async () => {
    const m1 = mem('M-01', 'a');
    const m2 = mem('M-02', 'b');
    const { call } = fakeCallJson({
      labels: [{ id: 'M-01', label: 'operational', note: 'used it' }],
    });
    const service = createTraceService({ callJson: call });

    const outcome = await service.trace({
      sessionId: 's1',
      userText: 'u',
      assistantText: 'a',
      usedMemories: [m1, m2],
    });

    expect(outcome.labels).toHaveLength(2);
    expect(outcome.labels).toContainEqual({ id: 'M-01', label: 'operational', note: 'used it' });
    expect(outcome.labels).toContainEqual({
      id: 'M-02',
      label: 'injected_without_effect',
      note: 'not labeled by trace model',
    });
  });

  it('coerces an unknown label value to injected_without_effect', async () => {
    const m1 = mem('M-01', 'a');
    const { call } = fakeCallJson({
      labels: [{ id: 'M-01', label: 'sort-of-relevant', note: 'unsure' }],
    });
    const service = createTraceService({ callJson: call });

    const outcome = await service.trace({
      sessionId: 's1',
      userText: 'u',
      assistantText: 'a',
      usedMemories: [m1],
    });

    expect(outcome.labels).toEqual([{ id: 'M-01', label: 'injected_without_effect', note: 'unsure' }]);
  });

  it('every usedMemory appears exactly once, even with duplicate/hallucinated LLM entries', async () => {
    const m1 = mem('M-01', 'a');
    const m2 = mem('M-02', 'b');
    const { call } = fakeCallJson({
      labels: [
        { id: 'M-01', label: 'operational', note: 'first' },
        { id: 'M-01', label: 'violated', note: 'second wins' },
        { id: 'M-77', label: 'operational', note: 'ghost' },
      ],
    });
    const service = createTraceService({ callJson: call });

    const outcome = await service.trace({
      sessionId: 's1',
      userText: 'u',
      assistantText: 'a',
      usedMemories: [m1, m2],
    });

    const ids = outcome.labels.map((l) => l.id);
    expect(ids).toEqual(['M-01', 'M-02']);
    expect(outcome.labels[0]).toEqual({ id: 'M-01', label: 'violated', note: 'second wins' });
  });

  it('emits NO experiment event itself — the caller logs after CAS-validating the verdicts', async () => {
    const m1 = mem('M-01', 'a');
    const m2 = mem('M-02', 'b');
    const { call } = fakeCallJson({
      labels: [{ id: 'M-01', label: 'operational', note: 'x' }],
    });
    const { logger, events } = fakeLogger();
    const service = createTraceService({ callJson: call, logger });

    const outcome = await service.trace({
      sessionId: 's1',
      engine: 'codex',
      turn: 5,
      userText: 'u',
      assistantText: 'a',
      usedMemories: [m1, m2],
    });

    expect(outcome.labels).toHaveLength(2);
    expect(events).toHaveLength(0);
  });

  it('carries a verbatim quote for operational and violated entries', async () => {
    const m1 = mem('M-01', 'always run pytest with -q');
    const m2 = mem('M-02', 'never touch prod db directly');
    const { call } = fakeCallJson({
      labels: [
        { id: 'M-01', label: 'operational', note: 'ran with -q', quote: 'ran pytest -q as requested' },
        { id: 'M-02', label: 'violated', note: 'hit prod', quote: 'querying the production database directly' },
      ],
    });
    const service = createTraceService({ callJson: call });

    const assistantText = [
      'I ran pytest -q as requested.',
      'I also made the mistake of querying the production database directly.',
    ].join(' ');
    const outcome = await service.trace({ sessionId: 's1', userText: 'u', assistantText, usedMemories: [m1, m2] });

    expect(outcome.labels).toEqual([
      { id: 'M-01', label: 'operational', note: 'ran with -q', quote: 'ran pytest -q as requested' },
      { id: 'M-02', label: 'violated', note: 'hit prod', quote: 'querying the production database directly' },
    ]);
  });

  it('drops a quote that is not present verbatim in the assistant response', async () => {
    const m1 = mem('M-01', 'always run pytest with -q');
    const { call } = fakeCallJson({
      labels: [
        {
          id: 'M-01',
          label: 'operational',
          note: 'claims the flag was used',
          quote: 'I ran pytest -q',
        },
      ],
    });
    const service = createTraceService({ callJson: call });

    const outcome = await service.trace({
      sessionId: 's1',
      userText: 'u',
      assistantText: 'The tests completed successfully.',
      usedMemories: [m1],
    });

    expect(outcome.labels).toEqual([
      { id: 'M-01', label: 'operational', note: 'claims the flag was used' },
    ]);
  });

  it('drops a quote on an injected_without_effect entry', async () => {
    const m1 = mem('M-01', 'a');
    const { call } = fakeCallJson({
      labels: [{ id: 'M-01', label: 'injected_without_effect', note: 'unused', quote: 'irrelevant text' }],
    });
    const service = createTraceService({ callJson: call });

    const outcome = await service.trace({ sessionId: 's1', userText: 'u', assistantText: 'a', usedMemories: [m1] });

    expect(outcome.labels).toEqual([{ id: 'M-01', label: 'injected_without_effect', note: 'unused' }]);
  });

  it('asks the model for a verbatim quote', async () => {
    const { call, calls } = fakeCallJson({ labels: [] });
    const service = createTraceService({ callJson: call });

    await service.trace({ sessionId: 's1', userText: 'u', assistantText: 'a', usedMemories: [mem('M-01', 'a')] });

    expect(calls[0].system.toLowerCase()).toContain('quote');
    expect(calls[0].system.toLowerCase()).toContain('verbatim');
  });

  it('propagates errors from callJson', async () => {
    const m1 = mem('M-01', 'a');
    const call: LlmJsonCaller = async () => {
      throw new Error('deepseek boom');
    };
    const service = createTraceService({ callJson: call });

    await expect(
      service.trace({ sessionId: 's1', userText: 'u', assistantText: 'a', usedMemories: [m1] }),
    ).rejects.toThrow('deepseek boom');
  });
});

describe('not_applicable decision-tree contract (2026-08-19)', () => {
  it('keeps a not_applicable verdict that names the missing object, without quote', async () => {
    const { call } = fakeCallJson({
      labels: [
        { id: 'M-01', label: 'not_applicable', note: 'no image work this turn', missing: 'no image in this output', quote: 'hello' },
      ],
    });
    const service = createTraceService({ callJson: call });
    const outcome = await service.trace({
      sessionId: 's1',
      userText: 'refactor the parser',
      assistantText: 'hello world, parser refactored',
      usedMemories: [mem('M-01', 'generated images must use vivid colors')],
    });
    expect(outcome.labels).toEqual([
      { id: 'M-01', label: 'not_applicable', note: 'no image work this turn', missing: 'no image in this output' },
    ]);
  });

  it('downgrades a not_applicable verdict without "missing" to injected_without_effect', async () => {
    const { call } = fakeCallJson({
      labels: [{ id: 'M-01', label: 'not_applicable', note: 'nothing to apply' }],
    });
    const service = createTraceService({ callJson: call });
    const outcome = await service.trace({
      sessionId: 's1',
      userText: 'u',
      assistantText: 'a',
      usedMemories: [mem('M-01', 'images must be vivid')],
    });
    expect(outcome.labels).toEqual([
      { id: 'M-01', label: 'injected_without_effect', note: 'nothing to apply' },
    ]);
  });

  it('impact rides violated entries only; a not_applicable id is not citable in the summary', async () => {
    const { call } = fakeCallJson({
      summary: 'Skipped image work [M-01] but broke the port rule [M-02].',
      labels: [
        { id: 'M-01', label: 'not_applicable', note: 'n', missing: 'no image produced' },
        { id: 'M-02', label: 'violated', note: 'ran on 3000', quote: 'listening on port 3000', cause: 'not_followed', impact: 'none' },
        { id: 'M-03', label: 'operational', note: 'ok', impact: 'negative' },
      ],
    });
    const service = createTraceService({ callJson: call });
    const outcome = await service.trace({
      sessionId: 's1',
      userText: 'start the server',
      assistantText: 'server listening on port 3000',
      usedMemories: [
        mem('M-01', 'images must be vivid'),
        mem('M-02', 'never use port 3000'),
        mem('M-03', 'log startup time'),
      ],
    });
    expect(outcome.labels).toEqual([
      { id: 'M-01', label: 'not_applicable', note: 'n', missing: 'no image produced' },
      { id: 'M-02', label: 'violated', note: 'ran on 3000', quote: 'listening on port 3000', cause: 'not_followed', impact: 'none' },
      { id: 'M-03', label: 'operational', note: 'ok' },
    ]);
    // M-01 de-cited (NA is not citable); M-02 keeps its citation.
    expect(outcome.summary).toBe('Skipped image work M-01 but broke the port rule [M-02].');
  });
});
