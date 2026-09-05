// Turn-scoped use planning for the Injected Memory Set. Selection and use
// planning are intentionally separate: another service chooses ids; this one
// explains how the coding agent should apply every selected memory. The same
// ExpectedMemoryUse objects are rendered in the review card and injected into
// Claude, so the UI never promises behavior the prompt did not request.
import type { LlmJsonCaller } from './deepseek';
import type { ExpectedMemoryUse } from '../../shared/types';

export type { ExpectedMemoryUse } from '../../shared/types';

export interface UsePlanInput {
  task: string;
  memories: Array<{ id: string; content: string; hasDetail?: boolean }>;
}

export interface UsePlanService {
  plan(input: UsePlanInput): Promise<ExpectedMemoryUse[]>;
}

const EXPECTED_USE_MAX_LEN = 220;

const USE_PLAN_SYSTEM = `You plan how a coding agent should use each selected memory for one developer task.

For EVERY supplied memory, write one concrete imperative sentence describing how the agent should apply it in this task. Name an observable action, decision, constraint, or output property. Do not merely say the memory is relevant. Do not claim the action already happened. If a memory is marked [+detail], tell the agent to load its detail before relying on it when appropriate.

Return each supplied id exactly once and no other ids. Respond with strict JSON only:
{"uses":[{"id":"M-07","expectedUse":"<one concrete imperative sentence>"}]}`;

function fallbackUse(memory: UsePlanInput['memories'][number]): ExpectedMemoryUse {
  return {
    id: memory.id,
    expectedUse: memory.hasDetail
      ? 'Load the detailed memory, then apply it while completing this task.'
      : 'Apply this memory while completing the task.',
  };
}

export function createUsePlanService(opts: { callJson: LlmJsonCaller }): UsePlanService {
  const { callJson } = opts;
  return {
    async plan(input): Promise<ExpectedMemoryUse[]> {
      if (!input.memories.length) return [];
      const fallback = input.memories.map(fallbackUse);
      try {
        const raw = await callJson({
          system: USE_PLAN_SYSTEM,
          user:
            `Task:\n${input.task.trim() || '(No task text available)'}\n\nSelected memories:\n` +
            input.memories
              .map((memory) => `[${memory.id}] ${memory.content}${memory.hasDetail ? ' [+detail]' : ''}`)
              .join('\n'),
          disableThinking: true,
          maxTokens: Math.max(700, input.memories.length * 180),
          timeoutMs: 15_000,
        });
        const rows = Array.isArray(raw.uses) ? (raw.uses as unknown[]) : [];
        const byId = new Map<string, string>();
        const allowed = new Set(input.memories.map((memory) => memory.id));
        for (const row of rows) {
          if (!row || typeof row !== 'object') continue;
          const record = row as Record<string, unknown>;
          const id = typeof record.id === 'string' ? record.id : '';
          const expectedUse = typeof record.expectedUse === 'string' ? record.expectedUse.trim() : '';
          if (!allowed.has(id) || !expectedUse || byId.has(id)) continue;
          byId.set(id, expectedUse.slice(0, EXPECTED_USE_MAX_LEN));
        }
        return input.memories.map((memory) => ({
          id: memory.id,
          expectedUse: byId.get(memory.id) ?? fallbackUse(memory).expectedUse,
        }));
      } catch {
        return fallback;
      }
    },
  };
}
