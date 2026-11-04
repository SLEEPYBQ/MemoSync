import { NATIVE_MEMORY_POLICY, type NativeImportCommitInput, type NativeImportDryRunInput } from '../../shared/native-memory';
import { NATIVE_DISCOVERY_LIMITS, NativeMemoryError } from './native-discovery';
import type { NativeMemoryImportService } from './native-import';

const ok = (data: unknown) => Response.json({ data });
const fail = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status });
async function body(req: Request): Promise<Record<string, unknown>> {
  // These requests contain IDs and decisions, never source text. Bound the
  // actual stream too; Content-Length alone is not authoritative.
  const reader = req.body?.getReader();
  if (!reader) throw new NativeMemoryError(400, 'BAD_REQUEST', 'A JSON body is required');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 32 * 1024) { await reader.cancel(); throw new NativeMemoryError(413, 'BODY_TOO_LARGE', 'Import requests are limited to 32 KiB'); }
      chunks.push(chunk.value);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected object');
    return parsed;
  } catch (error) {
    if (error instanceof NativeMemoryError) throw error;
    throw new NativeMemoryError(400, 'BAD_REQUEST', 'A valid JSON object is required');
  } finally { reader.releaseLock(); }
}

/** Handled before /api/memories/:id. No endpoint accepts a path or raw file. */
export async function handleNativeMemoryRequest(req: Request, url: URL, service?: NativeMemoryImportService): Promise<Response | null> {
  const path = url.pathname;
  if (!/^\/api\/memories\/(sources|imports)(?:\/|$)/.test(path)) return null;
  if (!service) return fail(503, 'NATIVE_MEMORY_UNAVAILABLE', 'Native memory discovery is unavailable');
  try {
    if (path === '/api/memories/sources') {
      if (req.method !== 'GET') return fail(405, 'METHOD_NOT_ALLOWED', 'use GET');
      return ok({ roots: service.discovery.allowedRoots(), limits: NATIVE_DISCOVERY_LIMITS, policy: NATIVE_MEMORY_POLICY });
    }
    if (path === '/api/memories/sources/discover') {
      if (req.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', 'use POST');
      const input = await body(req);
      return ok(service.discover(input.rootIds as string[]));
    }
    if (path === '/api/memories/imports') {
      if (req.method !== 'GET') return fail(405, 'METHOD_NOT_ALLOWED', 'use GET');
      return ok(service.listOperations(url.searchParams.get('rootId') ?? undefined));
    }
    if (path === '/api/memories/imports/dry-run') {
      if (req.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', 'use POST');
      return ok(await service.dryRun(await body(req) as unknown as NativeImportDryRunInput));
    }
    const match = path.match(/^\/api\/memories\/imports\/([A-Za-z0-9_-]{1,128})(?:\/(commit|rollback))?$/);
    if (match) {
      const id = match[1]!;
      if (!match[2]) {
        if (req.method !== 'GET') return fail(405, 'METHOD_NOT_ALLOWED', 'use GET');
        const operation = service.getOperation(id);
        return operation ? ok(operation) : fail(404, 'OPERATION_NOT_FOUND', 'Import operation not found');
      }
      if (req.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', 'use POST');
      const input = await body(req);
      return match[2] === 'commit' ? ok(service.commit(id, input as unknown as NativeImportCommitInput)) : ok(service.rollback(id, input.approved === true));
    }
    return fail(404, 'NOT_FOUND', 'Unknown native memory route');
  } catch (error) {
    if (error instanceof NativeMemoryError) return fail(error.status, error.code, error.message);
    // Never serialize filesystem errors, model output, or source text.
    return fail(500, 'INTERNAL_ERROR', 'Native memory operation failed');
  }
}
