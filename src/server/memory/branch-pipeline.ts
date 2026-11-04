import type { MemoryBranch, MemoryBranchBudget } from './branch-runtime';
import { memoryStageSchema, memoryStageDeltaSchema } from './branch-schemas';
import { buildMemoryBranchReviewPrompt, memoryBranchDeltaContract, MemoryBranchResultError, mergeMemoryBranchUpdate } from './branch-stages';

export type PreparationStage = 'candidate' | 'transfer' | 'changes';
export interface BranchRequest {
  prompt: string; dependencyKey: string; schema?: Record<string, unknown>; deltaSchema?: Record<string, unknown>; constraints?: string;
  /** Exact host view, including policy; only used within this preparation. */
  viewKey?: string;
  skip?: { raw: Record<string, unknown>; reason: string };
}
export interface PreparedBranchResult { raw: Record<string, unknown>; dependencyKey: string }

/** Eligible conversations start together; empty stages never create a child.
 * Review messages extend the original conversations; only their validated JSON
 * state reaches the coordinator. */
export class MemoryBranchPipeline {
  private readonly branches: Partial<Record<PreparationStage, MemoryBranch>> = {};
  private readonly createBranch: (stage: PreparationStage) => MemoryBranch;
  private readonly onStage?: (stage: PreparationStage, outcome: 'skipped' | 'reused', reason: string) => void;
  private readonly results: Record<PreparationStage, Promise<PreparedBranchResult>>;
  private readonly controller = new AbortController();
  private readonly requests: Record<PreparationStage, BranchRequest>;

  constructor(input: {
    createBranch: (stage: PreparationStage) => MemoryBranch;
    requests: Record<PreparationStage, BranchRequest>;
    onStage?: (stage: PreparationStage, outcome: 'skipped' | 'reused', reason: string) => void;
  }) {
    this.requests = { ...input.requests };
    this.createBranch = input.createBranch;
    this.onStage = input.onStage;
    this.results = Object.fromEntries(
      (['candidate', 'transfer', 'changes'] as const).map(stage => {
        const request = input.requests[stage];
        if (request.skip) this.onStage?.(stage, 'skipped', request.skip.reason);
        const result = (request.skip ? Promise.resolve(request.skip.raw) : this.ask(stage, request.prompt, request))
          .then(raw => ({ raw, dependencyKey: request.dependencyKey }));
        // A downstream failure may precede its review gate by minutes.
        // Retain rejection for its consumer without an unhandled rejection.
        void result.catch(() => {});
        return [stage, result];
      }),
    ) as Record<PreparationStage, Promise<PreparedBranchResult>>;
  }

  result(stage: PreparationStage): Promise<PreparedBranchResult> { return this.results[stage]; }

  private async ask(stage: PreparationStage, prompt: string, request: BranchRequest, schema = request.schema ?? memoryStageSchema(stage), budget?: Partial<MemoryBranchBudget>): Promise<Record<string, unknown>> {
    prompt = [prompt, request.constraints].filter(Boolean).join('\n\n');
    const signal = this.controller.signal;
    signal.throwIfAborted();
    let rejectAbort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(signal.reason ?? new Error('Memory preparation cancelled'));
      signal.addEventListener('abort', rejectAbort, { once: true });
    });
    try {
      const branch = this.branches[stage] ??= this.createBranch(stage);
      const raw = await Promise.race([branch.ask(prompt, { signal, schema, budget }), cancelled]);
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
    request?: BranchRequest;
  }): Promise<PreparedBranchResult> {
    const before = this.requests[stage];
    const request = input.request ?? { ...before, dependencyKey: input.dependencyKey };
    // Reserve the new view synchronously, so concurrent continuations compare
    // against the preceding queued update, not a completed older snapshot.
    this.requests[stage] = request;
    const unchanged = input.request !== undefined && JSON.stringify(before) === JSON.stringify(request);
    const result = this.results[stage].then(async previous => {
      this.controller.signal.throwIfAborted();
      if (request.skip) {
        this.onStage?.(stage, 'skipped', request.skip.reason);
        return { raw: request.skip.raw, dependencyKey: request.dependencyKey };
      }
      if (unchanged) {
        this.onStage?.(stage, 'reused', 'dependencies-unchanged');
        return previous;
      }
      if (before.skip) {
        const raw = await this.ask(stage, request.prompt, request);
        return { raw, dependencyKey: request.dependencyKey };
      }
      const update = await this.ask(stage, [buildMemoryBranchReviewPrompt({
        decision: input.review, updatedStore: input.changes, stage,
      }), ...(request.prompt !== before.prompt ? [`Current task and analysis inputs:\n${request.prompt}`] : [])].join('\n\n'), request,
      request.deltaSchema ?? memoryStageDeltaSchema(stage), { maxTurns: 3, maxToolCalls: 1 });
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
        ].join('\n\n'), request, request.deltaSchema ?? memoryStageDeltaSchema(stage), { maxTurns: 2, maxToolCalls: 0 });
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
