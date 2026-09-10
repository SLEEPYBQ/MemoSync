import type { MemoryBranch, MemoryBranchBudget } from './branch-runtime';
import { memoryStageSchema, memoryStageDeltaSchema } from './branch-schemas';
import { buildMemoryBranchReviewPrompt, memoryBranchDeltaContract, MemoryBranchResultError, mergeMemoryBranchUpdate } from './branch-stages';

export type PreparationStage = 'candidate' | 'transfer' | 'changes';
export interface BranchRequest { prompt: string; dependencyKey: string }
export interface PreparedBranchResult { raw: Record<string, unknown>; dependencyKey: string }

/** Three conversations start together. Review messages extend the original
 * conversations; only their validated JSON state reaches the coordinator. */
export class MemoryBranchPipeline {
  private readonly branches: Record<PreparationStage, MemoryBranch>;
  private readonly results: Record<PreparationStage, Promise<PreparedBranchResult>>;
  private readonly controller = new AbortController();

  constructor(input: {
    createBranch: (stage: PreparationStage) => MemoryBranch;
    requests: Record<PreparationStage, BranchRequest>;
  }) {
    this.branches = Object.fromEntries(
      (['candidate', 'transfer', 'changes'] as const).map(stage => [stage, input.createBranch(stage)]),
    ) as Record<PreparationStage, MemoryBranch>;
    this.results = Object.fromEntries(
      (['candidate', 'transfer', 'changes'] as const).map(stage => {
        const request = input.requests[stage];
        const result = this.ask(stage, request.prompt)
          .then(raw => ({ raw, dependencyKey: request.dependencyKey }));
        // A downstream failure may precede its review gate by minutes.
        // Retain rejection for its consumer without an unhandled rejection.
        void result.catch(() => {});
        return [stage, result];
      }),
    ) as Record<PreparationStage, Promise<PreparedBranchResult>>;
  }

  result(stage: PreparationStage): Promise<PreparedBranchResult> { return this.results[stage]; }

  private async ask(stage: PreparationStage, prompt: string, schema = memoryStageSchema(stage), budget?: Partial<MemoryBranchBudget>): Promise<Record<string, unknown>> {
    const signal = this.controller.signal;
    signal.throwIfAborted();
    let rejectAbort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(signal.reason ?? new Error('Memory preparation cancelled'));
      signal.addEventListener('abort', rejectAbort, { once: true });
    });
    try {
      const raw = await Promise.race([this.branches[stage].ask(prompt, { signal, schema, budget }), cancelled]);
      signal.throwIfAborted();
      return raw;
    } finally {
      signal.removeEventListener('abort', rejectAbort);
    }
  }

  continue(stage: 'transfer' | 'changes', input: {
    review: string;
    changes: unknown;
    dependencyKey: string;
  }): Promise<PreparedBranchResult> {
    const result = this.results[stage].then(async previous => {
      const update = await this.ask(stage, buildMemoryBranchReviewPrompt({
        decision: input.review, updatedStore: input.changes, stage,
      }), memoryStageDeltaSchema(stage), { maxTurns: 3, maxToolCalls: 1 });
      let raw: Record<string, unknown>;
      try {
        raw = mergeMemoryBranchUpdate(previous.raw, update);
      } catch (error) {
        if (!(error instanceof MemoryBranchResultError)) throw error;
        // One schema-only correction in the same child conversation. Provider
        // failures/cancellation are not retried, and a second invalid shape
        // remains a failed review instead of an empty successful result.
        const repaired = await this.ask(stage, [
          `The previous reply had an invalid proposal format: ${error.message}`,
          'Correct only the response schema using the review decision and analysis already in this conversation. Do not run a new analysis or change the store.',
          memoryBranchDeltaContract(stage),
        ].join('\n\n'), memoryStageDeltaSchema(stage), { maxTurns: 2, maxToolCalls: 0 });
        raw = mergeMemoryBranchUpdate(previous.raw, repaired);
      }
      return { raw, dependencyKey: input.dependencyKey };
    });
    void result.catch(() => {});
    this.results[stage] = result;
    return result;
  }

  dispose(): void {
    if (this.controller.signal.aborted) return;
    this.controller.abort(new Error('Memory preparation cancelled'));
    for (const branch of Object.values(this.branches)) branch.dispose();
  }
}
