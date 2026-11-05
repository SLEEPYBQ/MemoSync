import {
  NATIVE_MEMORY_POLICY,
  type NativeImportCommitInput,
  type NativeImportPlanInput,
  type NativeInventoryInput,
  type NativeOverviewInput,
  type NativeRefineJobInput,
  type NativeRestoreInput,
} from "../../shared/native-memory";
import { NativeMemoryError } from "./native-discovery";
import type { NativeMemoryImportService } from "./native-import";
const ok = (data: unknown) => Response.json({ data });
const fail = (status: number, code: string, message: string) =>
  Response.json({ error: { code, message } }, { status });
async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const value = await req.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw 0;
    return value;
  } catch {
    throw new NativeMemoryError(
      400,
      "BAD_REQUEST",
      "A JSON object is required",
    );
  }
}
/** Uses the existing {data}/{error} envelope. IDs only; no arbitrary filesystem paths. */
export async function handleNativeMemoryRequest(
  req: Request,
  url: URL,
  service?: NativeMemoryImportService,
): Promise<Response | null> {
  const path = url.pathname;
  if (
    !/^\/api\/memories\/(sources|inventory|units|overview|refine-jobs|imports)(?:\/|$)/.test(
      path,
    )
  )
    return null;
  if (!service)
    return fail(
      503,
      "NATIVE_MEMORY_UNAVAILABLE",
      "Native memory service unavailable",
    );
  try {
    if (path === "/api/memories/sources" && req.method === "GET")
      return ok({
        roots: service.discovery.allowedRoots(),
        policy: NATIVE_MEMORY_POLICY,
      });
    if (path === "/api/memories/inventory" && req.method === "GET")
      return ok(service.inventory.read());
    if (path === "/api/memories/inventory" && req.method === "POST")
      return ok(
        service.inventory.read((await body(req)) as NativeInventoryInput),
      );
    const unit = path.match(/^\/api\/memories\/units\/([a-f0-9]+)\/source$/);
    if (unit && req.method === "GET")
      return ok(service.inventory.get(unit[1]!));
    if (path === "/api/memories/overview" && req.method === "POST")
      return ok(
        await service.refinement.overview(
          (await body(req)) as unknown as NativeOverviewInput,
          req.signal,
        ),
      );
    if (path === "/api/memories/refine-jobs" && req.method === "POST")
      return ok(
        service.refinement.create(
          (await body(req)) as unknown as NativeRefineJobInput,
        ),
      );
    const job = path.match(
      /^\/api\/memories\/refine-jobs\/([A-Za-z0-9_-]+)(?:\/(cancel|resume))?$/,
    );
    if (job) {
      if (!job[2] && req.method === "GET")
        return ok(service.refinement.read(job[1]!));
      if (job[2] && req.method === "POST")
        return ok(
          job[2] === "cancel"
            ? service.refinement.cancel(job[1]!)
            : await service.refinement.resume(job[1]!),
        );
      return fail(405, "METHOD_NOT_ALLOWED", "Invalid method");
    }
    if (path === "/api/memories/imports" && req.method === "GET")
      return ok(service.listOperations());
    if (path === "/api/memories/imports/removed")
      return req.method === "GET"
        ? ok(service.listRemoved())
        : fail(405, "METHOD_NOT_ALLOWED", "Invalid method");
    if (path === "/api/memories/imports/removed/restore")
      return req.method === "POST"
        ? ok(
            await service.restoreRemoved(
              (await body(req)) as unknown as NativeRestoreInput,
            ),
          )
        : fail(405, "METHOD_NOT_ALLOWED", "Invalid method");
    if (path === "/api/memories/imports/plan" && req.method === "POST")
      return ok(
        service.plan((await body(req)) as unknown as NativeImportPlanInput),
      );
    const operation = path.match(
      /^\/api\/memories\/imports\/([A-Za-z0-9_-]{1,128})(?:\/(commit|rollback))?$/,
    );
    if (operation) {
      const id = operation[1]!;
      if (!operation[2] && req.method === "GET") {
        const value = service.getOperation(id);
        return value
          ? ok(value)
          : fail(404, "OPERATION_NOT_FOUND", "Import not found");
      }
      if (req.method !== "POST" || !operation[2])
        return fail(405, "METHOD_NOT_ALLOWED", "Invalid method");
      const input = await body(req);
      return ok(
        operation[2] === "commit"
          ? await service.commit(
              id,
              input as unknown as NativeImportCommitInput,
            )
          : service.rollback(id, input.approved === true),
      );
    }
    return fail(404, "NOT_FOUND", "Unknown native memory route");
  } catch (error) {
    if (error instanceof NativeMemoryError)
      return fail(error.status, error.code, error.message);
    return fail(500, "INTERNAL_ERROR", "Native memory operation failed");
  }
}
