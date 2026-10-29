import { AsyncLocalStorage } from 'node:async_hooks';
import { createMemoryBranch, type MemoryBranchInput } from './branch-runtime';
import type { LlmJsonCaller } from './deepseek';

export interface MemoryReasoningContext { sessionId?: string; projectId?: string }

/** Auxiliary Board actions use the same CLI provider as their conversation.
 * Async-local scope prevents simultaneous chats from borrowing each other's
 * parent session. This adapter performs no direct provider HTTP requests. */
export function createBranchJsonCaller(input: {
  resolve: (context: MemoryReasoningContext) => MemoryBranchInput;
  createBranch?: typeof createMemoryBranch;
}) {
  const contexts = new AsyncLocalStorage<MemoryReasoningContext>();
  const callJson: LlmJsonCaller = async request => {
    const branch = (input.createBranch ?? createMemoryBranch)({
      ...input.resolve(contexts.getStore() ?? {}),
      purpose: 'memory-board',
      timeoutMs: request.timeoutMs,
    });
    try {
      return await branch.ask([
        'Complete this auxiliary MemoSync memory operation in this isolated branch.',
        request.system, request.user,
      ].join('\n\n'), { signal: request.signal });
    } finally { branch.dispose(); }
  };
  return { callJson, run: <T>(context: MemoryReasoningContext, operation: () => T): T => contexts.run(context, operation) };
}

/** Read a clone; the actual route retains ownership of request validation. */
export async function memoryRequestContext(req: Request, url: URL): Promise<MemoryReasoningContext> {
  let body: Record<string, unknown> = {};
  if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') {
    try {
      const parsed = await req.clone().json();
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch { /* route returns the validation error */ }
  }
  const firstString = (...values: unknown[]) => values.find(value => typeof value === 'string' && value.length) as string | undefined;
  return {
    sessionId: firstString(body.chatId, body.sessionId, body.targetSessionId, url.searchParams.get('sessionId')),
    projectId: firstString(body.targetProjectId, body.projectId, url.searchParams.get('projectId')),
  };
}
