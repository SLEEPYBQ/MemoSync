import { describe, expect, test } from "bun:test"
import { i18n } from "../i18n"
import { createDefaultProviderDefaults, migrateChatPreferencesState, useChatPreferencesStore } from "../stores/chatPreferencesStore"
import { connectionGroups, validateConnection, connectionTestMessage, engineProblemMessage } from "./modelAccess"
import type { ApiConnectionInput, EngineStatus } from "../../shared/model-access"

const valid: ApiConnectionInput = { name: "Local", endpoints: [{ protocol: "openai-chat", baseUrl: "http://localhost:11434/v1" }], models: [{ id: "local-model", contextWindow: 32768 }] }
describe("connection validation", () => {
  test("requires a name, endpoint and model", () => {
    expect(validateConnection(valid)).toBeNull()
    expect(validateConnection({ ...valid, name: " " })).toBe("name")
    expect(validateConnection({ ...valid, endpoints: [] })).toBe("endpoints")
    expect(validateConnection({ ...valid, models: [] })).toBe("models")
    expect(validateConnection({ ...valid, models: [{ id: " " }] })).toBe("models")
  })
  test("rejects unsafe or malformed URLs, duplicate protocols and model ids, invalid context windows", () => {
    for (const baseUrl of ["invalid", "ftp://localhost", "https://user:secret@example.com", "https://example.com/?key=secret"]) {
      expect(validateConnection({ ...valid, endpoints: [{ protocol: "openai-chat", baseUrl }] })).toBe("url")
    }
    expect(validateConnection({ ...valid, endpoints: [valid.endpoints[0], valid.endpoints[0]] })).toBe("duplicateProtocol")
    expect(validateConnection({ ...valid, models: [{ id: "a" }, { id: "a" }] })).toBe("duplicateModel")
    for (const contextWindow of [0, -1, 1.5, NaN]) expect(validateConnection({ ...valid, models: [{ id: "m", contextWindow }] })).toBe("context")
  })
})
test("picker groups by compatible connection and keeps identical model ids distinct", () => {
  const base = { name: "First", id: "one", ...valid, keySource: "none" as const }
  const groups = connectionGroups("pi", [base, { ...base, id: "two", name: "Second" }, { ...base, id: "wrong", endpoints: [{ protocol: "anthropic-messages" as const, baseUrl: "https://example.com" }] }])
  expect(groups.map(g => g.connection.id)).toEqual(["one", "two"])
  expect(groups[0].models[0].id).toBe(groups[1].models[0].id)
})
test("all stable engine and test failure codes have localized, distinct messages", async () => {
  const problems = ["executable-missing", "executable-incompatible", "executable-broken", "connection-missing", "connection-key-missing", "connection-protocol-unsupported", "account-signed-out"] as const
  const english = problems.map(problem => engineProblemMessage({ ready: false, problem } as EngineStatus))
  expect(english).toEqual(["Executable not found.", "Executable is incompatible.", "Executable could not run.", "Choose an API connection.", "This connection needs an API key.", "This connection does not support the engine’s native protocol.", "Sign in with the agent’s CLI, then refresh."])
  const codes = ["unauthorized", "not-found", "network", "model-unavailable", "unknown", "future-code"]
  const messages = codes.map(errorCode => connectionTestMessage({ ok: false, protocol: "openai-chat", errorCode }))
  expect(messages).toEqual(["Authentication failed. Check the key and authentication header.", "Endpoint not found. Check the base URL and protocol.", "Could not reach the endpoint.", "The selected model is unavailable.", "Connection test failed.", "Connection test failed."])
  expect(connectionTestMessage({ ok: true, protocol: "openai-chat", latencyMs: 12 })).toContain("12")
  try {
    await i18n.changeLanguage("zh-CN")
    for (const problem of problems) expect(engineProblemMessage({ ready: false, problem } as EngineStatus)).toMatch(/[\u4e00-\u9fff]/)
    for (const errorCode of codes) expect(connectionTestMessage({ ok: false, protocol: "openai-chat", errorCode })).toMatch(/[\u4e00-\u9fff]/)
  } finally { await i18n.changeLanguage("en") }
})

test("connection identity and custom model survive edits, new-chat cloning and persisted hydration for every engine", () => {
  for (const provider of ["claude", "codex", "pi"] as const) {
    const defaults = createDefaultProviderDefaults()
    const state = { provider, connectionId: "chosen-connection", model: "my/custom-model", modelOptions: defaults[provider].modelOptions, planMode: false } as import("../stores/chatPreferencesStore").ComposerState
    const store = useChatPreferencesStore.getState()
    store.setComposerState("source", state)
    store.setChatComposerModelOptions("source", { reasoningEffort: "high" })
    store.setChatComposerPlanMode("source", true)
    store.setChatComposerModel("source", "second/custom-model")
    expect(store.getComposerState("source")).toMatchObject({ connectionId: "chosen-connection", model: "second/custom-model" })
    const hydrated = migrateChatPreferencesState({ chatStates: { source: store.getComposerState("source") } })
    expect(hydrated.chatStates.source).toMatchObject({ connectionId: "chosen-connection", model: "second/custom-model" })
    store.initializeComposerForChat(`child-${provider}`, { sourceState: store.getComposerState("source") })
    expect(store.getComposerState(`child-${provider}`)).toMatchObject({ connectionId: "chosen-connection", model: "second/custom-model" })
    store.resetChatComposerFromProvider("source", provider)
    expect(store.getComposerState("source").connectionId).toBeUndefined()
  }
  useChatPreferencesStore.setState({ chatStates: {} })
})

test("Claude and Codex model pickers include Chat fallback connections", () => {
  const connection = { ...valid, id: "chat-only", keySource: "none" as const }
  for (const engine of ["claude", "codex"] as const) expect(connectionGroups(engine, [connection]).map(g => g.connection.id)).toEqual(["chat-only"])
})
