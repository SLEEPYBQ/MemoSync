import type { AppSocket } from "../app/socket"
import { create } from "zustand"
import type { ApiConnection, ApiConnectionInput, ConnectionTestResult, EngineId, EngineStatus, ModelAccessSnapshot } from "../../shared/model-access"
import { compatibleEndpointForEngine } from "../../shared/model-access"
import type { ModelOptions } from "../../shared/types"
import { t } from "../i18n"

// T2 adds this optional wire field. Keep the client compatible without changing
// the shared contract owned by the runtime task.
export type AccessModelOptions = ModelOptions & { connectionId?: string }
export const useModelAccessStore = create<{ snapshot: ModelAccessSnapshot | null; setSnapshot: (snapshot: ModelAccessSnapshot | null) => void }>((set) => ({
  snapshot: null,
  setSnapshot: (snapshot) => set({ snapshot }),
}))

export function connectionGroups(engine: EngineId, connections: ApiConnection[]) {
  return connections.filter(connection => compatibleEndpointForEngine(engine, connection)).map(connection => ({ connection, models: connection.models }))
}

export function incompatibleConnectionMessage(engine: EngineId) {
  return t(engine === "claude" ? "modelAccess:needsAnthropic" : engine === "codex" ? "modelAccess:needsResponses" : "modelAccess:needsOpenAI")
}

export function engineProblemMessage(status: EngineStatus) {
  if (status.ready) return t("modelAccess:ready")
  const messages = {
    "executable-missing": "modelAccess:executableMissing",
    "executable-incompatible": "modelAccess:executableIncompatible",
    "executable-broken": "modelAccess:executableBroken",
    "connection-missing": "modelAccess:connectionMissing",
    "connection-key-missing": "modelAccess:keyMissing",
    "connection-protocol-unsupported": "modelAccess:protocolUnsupported",
    "account-signed-out": "modelAccess:signedOut",
  } as const
  return t(status.problem ? messages[status.problem] : "modelAccess:unknownStatus")
}

export function connectionTestMessage(result: ConnectionTestResult) {
  if (result.ok) return result.latencyMs === undefined ? t("modelAccess:testSuccessNoLatency") : t("modelAccess:testSuccess", { latency: result.latencyMs })
  const messages: Record<string, "modelAccess:unauthorized" | "modelAccess:notFound" | "modelAccess:network" | "modelAccess:modelUnavailable" | "modelAccess:testUnknown"> = {
    unauthorized: "modelAccess:unauthorized", "not-found": "modelAccess:notFound", network: "modelAccess:network", "model-unavailable": "modelAccess:modelUnavailable",
  }
  return t(messages[result.errorCode ?? ""] ?? "modelAccess:testUnknown")
}

export function validateConnection(input: ApiConnectionInput) {
  if (!input.name.trim()) return "name"
  if (!input.endpoints.length) return "endpoints"
  for (const endpoint of input.endpoints) {
    try {
      const url = new URL(endpoint.baseUrl)
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return "url"
    } catch { return "url" }
  }
  if (new Set(input.endpoints.map(e => e.protocol)).size !== input.endpoints.length) return "duplicateProtocol"
  if (!input.models.length || input.models.some(m => !m.id.trim())) return "models"
  if (new Set(input.models.map(m => m.id.trim())).size !== input.models.length) return "duplicateModel"
  if (input.models.some(m => m.contextWindow !== undefined && (!Number.isSafeInteger(m.contextWindow) || m.contextWindow <= 0))) return "context"
  return null
}

export function validationMessage(error: NonNullable<ReturnType<typeof validateConnection>>) {
  const keys = { name: "validationName", endpoints: "validationEndpoints", models: "validationModels", url: "validationUrl", duplicateProtocol: "validationDuplicateProtocol", duplicateModel: "validationDuplicateModel", context: "validationContext" } as const
  return t(`modelAccess:${keys[error]}`)
}

/** One live subscription owned by the app, also used by mounted fake-socket tests. */
export function subscribeModelAccess(socket: Pick<AppSocket, "subscribe">) {
  const setSnapshot = useModelAccessStore.getState().setSnapshot
  setSnapshot(null)
  const unsubscribe = socket.subscribe<ModelAccessSnapshot>({ type: "model-access" }, setSnapshot)
  return () => { unsubscribe(); setSnapshot(null) }
}
