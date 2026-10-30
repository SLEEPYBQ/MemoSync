import { useEffect } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter, Link, Route, Routes } from "react-router-dom"
import { PROVIDERS } from "../../../shared/types"
import type { ModelAccessSnapshot, ConnectionTestResult, EngineId, ExecutableState, EngineStatus } from "../../../shared/model-access"
import type { ClientCommand, SubscriptionTopic } from "../../../shared/protocol"
import type { AppSocket } from "../../app/socket"
import { ProvidersSection } from "../../app/settings/ProvidersSection"
import { ChatInput } from "../../components/chat-ui/ChatInput"
import { TooltipProvider } from "../../components/ui/tooltip"
import { AppDialogProvider } from "../../components/ui/app-dialog"
import { i18n } from "../../i18n"
import { subscribeModelAccess } from "../../model-access/modelAccess"
import { useChatPreferencesStore } from "../../stores/chatPreferencesStore"
import "./fixture.css"

const protocols = ["anthropic-messages", "openai-responses", "openai-chat"] as const
export const fixtureSnapshot: ModelAccessSnapshot = {
  connections: protocols.map((protocol, i) => ({ id: `connection-${i}`, name: ["Anthropic Direct", "Responses Relay", "Local Chat"][i], endpoints: [{ protocol, baseUrl: `http://127.0.0.1:9999/${protocol}` }], keySource: i === 2 ? "none" : "stored", models: [{ id: "shared-model", label: "Shared model", contextWindow: 128000 }, { id: "custom-model", contextWindow: 64000 }] })),
  presets: protocols.map((protocol, i) => ({ id: `preset-${i}`, name: ["Anthropic", "Relay", "Local"][i], kind: ["vendor", "relay", "local"][i] as "vendor" | "relay" | "local", endpoints: [{ protocol, baseUrl: "http://127.0.0.1:9999/v1", ...(i === 0 ? { authHeader: "x-api-key" as const } : {}) }], models: [{ id: "preset-model", contextWindow: 200000 }], keysUrl: "https://example.com/keys", noKey: i === 2 })),
  engines: Object.fromEntries((["claude", "codex", "pi"] as const).map((engine, i) => [engine, { engine, ready: true, setup: { access: engine === "pi" ? { mode: "connection", connectionId: "connection-2", defaultModel: "shared-model" } : { mode: "account" } }, executable: engine === "pi" ? { state: "not-needed" } : { state: "ready", path: `/fixture/bin/${engine}`, version: "9.0.0", source: "path", minimumVersion: "1.0.0" } }])) as ModelAccessSnapshot["engines"],
}
let snapshot = structuredClone(fixtureSnapshot)
let listener: ((snapshot: ModelAccessSnapshot) => void) | undefined
const commands: ClientCommand[] = []
const submissions: unknown[] = []
let testResult: ConnectionTestResult = { ok: true, protocol: "openai-chat", latencyMs: 42 }
let rejectNext = false
let testResolve: ((value: ConnectionTestResult) => void) | null = null
let holdTest = false
const fakeSocket = {
  subscribe(_topic: SubscriptionTopic, callback: (value: ModelAccessSnapshot) => void) { listener = callback; callback(snapshot); return () => { listener = undefined } },
  async command(command: ClientCommand) {
    commands.push(structuredClone(command))
    if (rejectNext) { rejectNext = false; throw new Error("Fixture command rejected") }
    if (command.type === "modelAccess.testConnection") return holdTest ? new Promise(resolve => { testResolve = resolve }) : testResult
    if (command.type === "modelAccess.setEngine") { snapshot.engines[command.engine].setup = command.setup; listener?.(structuredClone(snapshot)) }
    if (command.type === "modelAccess.deleteConnection") { snapshot.connections = snapshot.connections.filter(c => c.id !== command.connectionId); listener?.(structuredClone(snapshot)) }
    if (command.type === "modelAccess.saveConnection") {
      const { apiKey, ...connection } = command.connection
      const previous = snapshot.connections.find(c => c.id === connection.id)
      const saved = { ...connection, id: connection.id ?? `saved-${commands.length}`, keySource: apiKey === null ? "none" as const : apiKey ? "stored" as const : previous?.keySource ?? "none" as const }
      snapshot.connections = [...snapshot.connections.filter(c => c.id !== saved.id), saved]; listener?.(structuredClone(snapshot)); return { connectionId: saved.id }
    }
    return {}
  },
} as unknown as AppSocket

const api = {
  commands: () => commands,
  submissions: () => submissions,
  publish: (next: ModelAccessSnapshot) => { snapshot = structuredClone(next); listener?.(structuredClone(snapshot)) },
  snapshot: () => structuredClone(snapshot),
  reset: () => { snapshot = structuredClone(fixtureSnapshot); commands.length = 0; listener?.(structuredClone(snapshot)) },
  engineState: (state: ExecutableState, mode: "account" | "connection", problem?: EngineStatus["problem"]) => {
    for (const [engine, status] of Object.entries(snapshot.engines)) {
      const id = engine as EngineId
      status.ready = state === "ready" && !problem
      status.executable.state = id === "pi" && state === "ready" ? "not-needed" : state
      status.problem = problem ?? (state === "ready" ? undefined : `executable-${state}` as EngineStatus["problem"])
      status.setup.access = mode === "account" && id !== "pi" ? { mode: "account" } : { mode: "connection", connectionId: `connection-${["claude", "codex", "pi"].indexOf(id)}`, defaultModel: "shared-model" }
    }
    listener?.(structuredClone(snapshot))
  },
  testResult: (value: ConnectionTestResult) => { testResult = value },
  holdTest: (value: boolean) => { holdTest = value },
  resolveTest: () => { testResolve?.(testResult); testResolve = null },
  rejectNext: () => { rejectNext = true },
  language: (value: string) => i18n.changeLanguage(value),
  composer: () => useChatPreferencesStore.getState().getComposerState("__new__"),
  clearComposer: () => { useChatPreferencesStore.setState({ chatStates: {} }) },
}
declare global { interface Window { modelAccessFixture: typeof api } }
window.modelAccessFixture = api

function Fixture() {
  useEffect(() => subscribeModelAccess(fakeSocket), [])
  return <main className="@container mx-auto max-w-[900px] space-y-6 p-4 text-foreground sm:p-8">
    <nav className="flex gap-4 text-sm"><Link to="/settings/providers">Providers</Link><Link to="/">New chat</Link></nav>
    <Routes><Route path="/settings/providers" element={<ProvidersSection state={{ socket: fakeSocket, availableProviders: PROVIDERS, handleWriteAppSettings: async patch => { commands.push({ type: "settings.writeAppSettingsPatch", patch }) } }} />} /><Route path="/" element={<ChatInput onSubmit={async (value, options) => { submissions.push({ value, options }) }} disabled={false} canCancel={false} activeProvider={null} availableProviders={PROVIDERS} draftKey="fixture-new-chat" projectId="fixture-project" />} /></Routes>
  </main>
}
void i18n.changeLanguage("en")
createRoot(document.getElementById("root")!).render(<MemoryRouter initialEntries={["/settings/providers"]}><TooltipProvider><AppDialogProvider><Fixture /></AppDialogProvider></TooltipProvider></MemoryRouter>)
