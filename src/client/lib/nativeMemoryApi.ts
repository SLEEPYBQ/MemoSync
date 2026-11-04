import type { NativeDiscoveryResult, NativeImportCommitInput, NativeImportDryRunInput, NativeImportHistory, NativeImportOperation, NativeImportReceipt, NativeImportRollback, NativeMemoryRoot } from "../../shared/native-memory"
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

export const nativeMemoryApi = {
  roots: (signal?: AbortSignal) => request<{ roots: NativeMemoryRoot[] }>("sources", undefined, signal),
  discover: (rootIds: string[], signal?: AbortSignal) => request<NativeDiscoveryResult>("sources/discover", { rootIds }, signal),
  preview: (input: NativeImportDryRunInput, signal?: AbortSignal) => request<NativeImportOperation>("imports/dry-run", input, signal),
  operation: (id: string, signal?: AbortSignal) => request<NativeImportOperation>(`imports/${encodeURIComponent(id)}`, undefined, signal),
  commit: (id: string, input: NativeImportCommitInput) => request<NativeImportReceipt>(`imports/${encodeURIComponent(id)}/commit`, input),
  rollback: (id: string) => request<NativeImportRollback>(`imports/${encodeURIComponent(id)}/rollback`, { approved: true }),
  history: (signal?: AbortSignal) => request<NativeImportHistory>("imports", undefined, signal),
}
