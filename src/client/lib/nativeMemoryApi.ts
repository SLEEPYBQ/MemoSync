import type {
  NativeImportCommitInput, NativeImportHistory, NativeImportOperation, NativeImportPlanInput, NativeImportReceipt, NativeImportRollback,
  NativeInventoryResult, NativeOverviewInput, NativeOverviewResult, NativeRefineJob, NativeRefineJobInput, NativeRemovedResult, NativeRestoreInput, NativeRestoreResult, NativeUnitSource,
} from "../../shared/native-memory"
import { t } from "../i18n"
import { httpUiError } from "../i18n/uiText"
import { notifyIfUnauthorized } from "./authGuard"

async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/memories/${path}`, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    signal,
  })
  notifyIfUnauthorized(response)
  const payload = await response.json().catch(() => { throw new Error(t("errors:requestFailedValue0", { v0: response.status })) })
  if (!response.ok || payload.error) throw new Error(httpUiError(payload, t("errors:requestFailedValue0", { v0: response.status })))
  return payload.data as T
}

const id = encodeURIComponent

export const nativeMemoryApi = {
  inventory: (signal?: AbortSignal) => request<NativeInventoryResult>("inventory", undefined, signal),
  unitSource: (unitId: string, signal?: AbortSignal) => request<NativeUnitSource>(`units/${id(unitId)}/source`, undefined, signal),
  overview: (input: NativeOverviewInput) => request<NativeOverviewResult>("overview", input),
  refine: (input: NativeRefineJobInput) => request<NativeRefineJob>("refine-jobs", input),
  job: (jobId: string, signal?: AbortSignal) => request<NativeRefineJob>(`refine-jobs/${id(jobId)}`, undefined, signal),
  cancelJob: (jobId: string) => request<NativeRefineJob>(`refine-jobs/${id(jobId)}/cancel`, {}),
  resumeJob: (jobId: string) => request<NativeRefineJob>(`refine-jobs/${id(jobId)}/resume`, {}),
  plan: (input: NativeImportPlanInput) => request<NativeImportOperation>("imports/plan", input),
  operation: (operationId: string, signal?: AbortSignal) => request<NativeImportOperation>(`imports/${id(operationId)}`, undefined, signal),
  commit: (operationId: string, input: NativeImportCommitInput) => request<NativeImportReceipt>(`imports/${id(operationId)}/commit`, input),
  rollback: (operationId: string) => request<NativeImportRollback>(`imports/${id(operationId)}/rollback`, { approved: true }),
  removed: (signal?: AbortSignal) => request<NativeRemovedResult>("imports/removed", undefined, signal),
  restore: (input: NativeRestoreInput) => request<NativeRestoreResult>("imports/removed/restore", input),
  history: (signal?: AbortSignal) => request<NativeImportHistory>("imports", undefined, signal),
}
