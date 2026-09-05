import { describe, expect, test } from 'bun:test';
import type { LlmJsonCaller } from './deepseek';
import { createUsePlanService } from './use-plan';

describe('createUsePlanService', () => {
  test('returns one validated expected use for every selected memory', async () => {
    const call: LlmJsonCaller = async () => ({
      uses: [
        { id: 'M-02', expectedUse: 'Reply in Chinese throughout the task.' },
        { id: 'M-99', expectedUse: 'hallucinated' },
        { id: 'M-02', expectedUse: 'duplicate' },
      ],
    });
    const service = createUsePlanService({ callJson: call });

    const uses = await service.plan({
      task: 'Build a support chatbot',
      memories: [
        { id: 'M-01', content: 'Use snow and dim gray', hasDetail: true },
        { id: 'M-02', content: 'Always reply in Chinese' },
      ],
    });

    expect(uses).toEqual([
      { id: 'M-01', expectedUse: 'Load the detailed memory, then apply it while completing this task.' },
      { id: 'M-02', expectedUse: 'Reply in Chinese throughout the task.' },
    ]);
  });

  test('falls back deterministically when the planner fails', async () => {
    const service = createUsePlanService({ callJson: async () => { throw new Error('offline'); } });
    expect(await service.plan({
      task: 'task',
      memories: [{ id: 'M-01', content: 'Keep responses concise' }],
    })).toEqual([{ id: 'M-01', expectedUse: 'Apply this memory while completing the task.' }]);
  });
});
