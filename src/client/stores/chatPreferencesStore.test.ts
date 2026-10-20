import { afterEach, describe, expect, test } from "bun:test"
import { createJSONStorage } from "zustand/middleware"

class MemoryStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

const chatPreferencesStore = await (async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: new MemoryStorage() },
  })

  try {
    const modulePath = "./chatPreferencesStore.ts?storage-rehydration-regression"
    return await import(modulePath) as typeof import("./chatPreferencesStore")
  } finally {
    if (originalWindow) {
      Object.defineProperty(globalThis, "window", originalWindow)
    } else {
      Reflect.deleteProperty(globalThis, "window")
    }
  }
})()

const {
  migrateChatPreferencesState,
  NEW_CHAT_COMPOSER_ID,
  useChatPreferencesStore,
} = chatPreferencesStore

const INITIAL_STATE = useChatPreferencesStore.getInitialState()

afterEach(() => {
  useChatPreferencesStore.setState(INITIAL_STATE)
})

describe("migrateChatPreferencesState", () => {
  test("preserves isolated Codex provider models across a reload", () => {
    const migrated = migrateChatPreferencesState({
      providerDefaults: { codex: { model: "glm-5.3-flash" } },
      composerState: { provider: "codex", model: "glm-5.3-flash" },
      chatStates: { existing: { provider: "codex", model: "glm-5.3-flash" } },
    })
    expect(migrated.providerDefaults.codex.model).toBe("glm-5.3-flash")
    expect(migrated.legacyComposerState?.model).toBe("glm-5.3-flash")
    expect(migrated.chatStates.existing?.model).toBe("glm-5.3-flash")
  })

  test("migrates versioned Opus preferences to the official Opus alias", () => {
    const migrated = migrateChatPreferencesState({
      defaultProvider: "last_used",
      providerDefaults: {
        claude: {
          model: "claude-opus-4-8",
          modelOptions: { reasoningEffort: "max", contextWindow: "1m" },
          planMode: false,
        },
      },
    })

    expect(migrated.providerDefaults.claude).toEqual({
      model: "opus",
      modelOptions: { reasoningEffort: "max", contextWindow: "1m" },
      planMode: false,
    })
  })

  test("normalizes provider defaults and legacy composer state", () => {
    const migrated = migrateChatPreferencesState({
      defaultProvider: "last_used",
      providerDefaults: {
        claude: {
          model: "opus",
          modelOptions: { reasoningEffort: "low", contextWindow: "1m" },
          planMode: true,
        },
        codex: {
          model: "gpt-5.3-codex",
          modelOptions: { reasoningEffort: "minimal", fastMode: true },
          planMode: false,
        },
      },
      composerState: {
        provider: "claude",
        model: "sonnet",
        modelOptions: { reasoningEffort: "max", contextWindow: "1m" },
        planMode: false,
      },
    })

    expect(migrated).toEqual({
      defaultProvider: "last_used",
      providerDefaults: {
        claude: {
          model: "opus",
          // Legacy "low" tier no longer exists — falls back to the default.
          modelOptions: { reasoningEffort: "high", contextWindow: "1m" },
          planMode: true,
        },
        codex: {
          model: "gpt-5.3-codex",
          modelOptions: { reasoningEffort: "minimal", fastMode: true },
          planMode: false,
        },
        pi: {
          model: "anthropic/claude-sonnet-4-6",
          modelOptions: { reasoningEffort: "medium" },
          planMode: false,
        },
      },
      chatStates: {},
      legacyComposerState: {
        provider: "claude",
        model: "sonnet",
        modelOptions: { reasoningEffort: "high", contextWindow: "1m" },
        planMode: false,
      },
    })
  })

  test("drops unsupported Claude context window selections during migration", () => {
    const migrated = migrateChatPreferencesState({
      defaultProvider: "last_used",
      providerDefaults: {
        claude: {
          model: "haiku",
          modelOptions: { reasoningEffort: "low", contextWindow: "1m" as never },
          planMode: false,
        },
      },
      chatStates: {
        chatA: {
          provider: "claude",
          model: "haiku",
          modelOptions: { reasoningEffort: "high", contextWindow: "200k" as never },
          planMode: false,
        },
      },
    })

    expect(migrated.providerDefaults.claude.modelOptions).toEqual({ reasoningEffort: "high", contextWindow: "1m" })
    expect(migrated.chatStates.chatA).toEqual({
      provider: "claude",
      model: "deepseek-v4-flash",
      modelOptions: { reasoningEffort: "high", contextWindow: "1m" },
      planMode: false,
    })
  })

  test("normalizes legacy Codex aliases without forcing the default model", () => {
    const migrated = migrateChatPreferencesState({
      defaultProvider: "last_used",
      providerDefaults: {
        codex: {
          model: "gpt-5-codex",
          modelOptions: { reasoningEffort: "low", fastMode: true },
          planMode: false,
        },
      },
    })

    expect(migrated.providerDefaults.codex).toEqual({
      model: "gpt-5.3-codex",
      modelOptions: { reasoningEffort: "low", fastMode: true },
      planMode: false,
    })
  })

  test("preserves persisted Codex model choices during migration", () => {
    const migrated = migrateChatPreferencesState({
      defaultProvider: "codex",
      providerDefaults: {
        codex: {
          model: "gpt-5.3-codex-spark",
          modelOptions: { reasoningEffort: "low", fastMode: true },
          planMode: true,
        },
      },
      chatStates: {
        chatA: {
          provider: "codex",
          model: "gpt-5.4",
          modelOptions: { reasoningEffort: "medium", fastMode: false },
          planMode: false,
        },
      },
      legacyComposerState: {
        provider: "codex",
        model: "gpt-5.3-codex",
        modelOptions: { reasoningEffort: "xhigh", fastMode: true },
        planMode: true,
      },
    })

    expect(migrated.providerDefaults.codex).toEqual({
      model: "gpt-5.3-codex-spark",
      modelOptions: { reasoningEffort: "low", fastMode: true },
      planMode: true,
    })
    expect(migrated.chatStates.chatA).toEqual({
      provider: "codex",
      model: "gpt-5.4",
      modelOptions: { reasoningEffort: "medium", fastMode: false },
      planMode: false,
    })
    expect(migrated.legacyComposerState).toEqual({
      provider: "codex",
      model: "gpt-5.3-codex",
      modelOptions: { reasoningEffort: "xhigh", fastMode: true },
      planMode: true,
    })
  })

  test("preserves the older live Codex preference format", () => {
    const migrated = migrateChatPreferencesState({
      liveProvider: "codex",
      livePreferences: {
        codex: { model: "gpt-5.4", effort: "low", planMode: true },
      },
    })
    expect(migrated.legacyComposerState).toEqual({
      provider: "codex",
      model: "gpt-5.4",
      modelOptions: { reasoningEffort: "low", fastMode: false },
      planMode: true,
    })
  })
})

describe("chat preference store", () => {
  test("preserves Codex model choices through storage rehydration", async () => {
    const storage = new MemoryStorage()
    const originalStorage = useChatPreferencesStore.persist.getOptions().storage
    useChatPreferencesStore.persist.setOptions({ storage: createJSONStorage(() => storage) })
    try {
      const store = useChatPreferencesStore.getState()
      store.setProviderDefaultModel("codex", "gpt-5.4")
      store.setComposerState("chat-a", {
        provider: "codex", model: "gpt-5.3-codex-spark",
        modelOptions: { reasoningEffort: "xhigh", fastMode: true }, planMode: true,
      })
      store.setComposerState(NEW_CHAT_COMPOSER_ID, {
        provider: "codex", model: "gpt-5.3-codex",
        modelOptions: { reasoningEffort: "minimal", fastMode: false }, planMode: false,
      })
      const beforeReload = useChatPreferencesStore.getState()
      const saved = storage.getItem("chat-preferences")
      expect(saved).not.toBeNull()
      useChatPreferencesStore.setState(INITIAL_STATE)
      storage.setItem("chat-preferences", saved!)
      await useChatPreferencesStore.persist.rehydrate()

      const rehydrated = useChatPreferencesStore.getState()
      expect(rehydrated.providerDefaults).toEqual(beforeReload.providerDefaults)
      expect(rehydrated.chatStates).toEqual(beforeReload.chatStates)
    } finally {
      useChatPreferencesStore.persist.setOptions({ storage: originalStorage })
    }
  })

  test("starts with gpt-5.5 as the default Codex model", () => {
    expect(INITIAL_STATE.providerDefaults.codex).toEqual({
      model: "gpt-5.5",
      modelOptions: { reasoningEffort: "high", fastMode: false },
      planMode: false,
    })
  })

  test("editing provider defaults does not change existing chat state", () => {
    useChatPreferencesStore.getState().setComposerState("chat-a", {
      provider: "codex",
      model: "gpt-5.3-codex",
      modelOptions: { reasoningEffort: "minimal", fastMode: true },
      planMode: true,
    })

    useChatPreferencesStore.getState().setProviderDefaultModel("codex", "gpt-5.3-codex-spark")
    useChatPreferencesStore.getState().setProviderDefaultModelOptions("codex", {
      reasoningEffort: "low",
      fastMode: false,
    })
    useChatPreferencesStore.getState().setProviderDefaultPlanMode("codex", false)

    expect(useChatPreferencesStore.getState().getComposerState("chat-a")).toEqual({
      provider: "codex",
      model: "gpt-5.3-codex",
      modelOptions: { reasoningEffort: "minimal", fastMode: true },
      planMode: true,
    })
  })

  test("restores isolated composer state by chat id", () => {
    const store = useChatPreferencesStore.getState()

    store.setComposerState("chat-a", {
      provider: "claude",
      model: "claude-sonnet-4-6",
      modelOptions: { reasoningEffort: "low", contextWindow: "1m" },
      planMode: false,
    })
    store.setComposerState("chat-b", {
      provider: "codex",
      model: "gpt-5.3-codex",
      modelOptions: { reasoningEffort: "minimal", fastMode: true },
      planMode: true,
    })
    store.setChatComposerPlanMode("chat-a", true)

    expect(store.getComposerState("chat-a")).toEqual({
      provider: "claude",
      model: "sonnet",
      // "low" is not a DeepSeek tier — normalized to the "high" default.
      modelOptions: { reasoningEffort: "high", contextWindow: "1m" },
      planMode: true,
    })
    expect(store.getComposerState("chat-b")).toEqual({
      provider: "codex",
      model: "gpt-5.3-codex",
      modelOptions: { reasoningEffort: "minimal", fastMode: true },
      planMode: true,
    })
  })

  test("switching Claude chat model clears unsupported context window values", () => {
    const store = useChatPreferencesStore.getState()

    store.setComposerState("chat-a", {
      provider: "claude",
      model: "claude-opus-4-8",
      modelOptions: { reasoningEffort: "high", contextWindow: "200k" },
      planMode: false,
    })
    store.setChatComposerModel("chat-a", "haiku")

    expect(store.getComposerState("chat-a")).toEqual({
      provider: "claude",
      model: "deepseek-v4-flash",
      modelOptions: { reasoningEffort: "high", contextWindow: "1m" },
      planMode: false,
    })
  })

  test("resetChatComposerFromProvider copies provider defaults into the target chat", () => {
    useChatPreferencesStore.setState({
      ...INITIAL_STATE,
      providerDefaults: {
        ...INITIAL_STATE.providerDefaults,
        codex: {
          model: "gpt-5.3-codex",
          modelOptions: { reasoningEffort: "minimal", fastMode: true },
          planMode: true,
        },
      },
    })

    useChatPreferencesStore.getState().resetChatComposerFromProvider("chat-a", "codex")

    expect(useChatPreferencesStore.getState().getComposerState("chat-a")).toEqual({
      provider: "codex",
      model: "gpt-5.3-codex",
      modelOptions: { reasoningEffort: "minimal", fastMode: true },
      planMode: true,
    })
  })

  test("initializeComposerForChat uses explicit provider defaults for new chats", () => {
    useChatPreferencesStore.setState({
      ...INITIAL_STATE,
      defaultProvider: "codex",
      providerDefaults: {
        ...INITIAL_STATE.providerDefaults,
        codex: {
          model: "gpt-5.3-codex-spark",
          modelOptions: { reasoningEffort: "minimal", fastMode: true },
          planMode: true,
        },
      },
    })

    useChatPreferencesStore.getState().initializeComposerForChat("chat-a")

    expect(useChatPreferencesStore.getState().getComposerState("chat-a")).toEqual({
      provider: "codex",
      model: "gpt-5.3-codex-spark",
      modelOptions: { reasoningEffort: "minimal", fastMode: true },
      planMode: true,
    })
  })

  test("last_used falls back to provider defaults when no real last-used state exists", () => {
    useChatPreferencesStore.setState({
      ...INITIAL_STATE,
      defaultProvider: "last_used",
      providerDefaults: {
        ...INITIAL_STATE.providerDefaults,
        claude: {
          model: "claude-opus-4-8",
          modelOptions: { reasoningEffort: "max", contextWindow: "1m" },
          planMode: true,
        },
      },
      legacyComposerState: null,
    })

    useChatPreferencesStore.getState().initializeComposerForChat("chat-a")

    expect(useChatPreferencesStore.getState().getComposerState("chat-a")).toEqual({
      provider: "claude",
      model: "claude-opus-4-8",
      modelOptions: { reasoningEffort: "max", contextWindow: "1m" },
      planMode: true,
    })
  })

  test("syncProviderDefaults refreshes untouched new-chat state after settings hydration", () => {
    const store = useChatPreferencesStore.getState()

    store.initializeComposerForChat(NEW_CHAT_COMPOSER_ID)
    store.syncProviderDefaults("last_used", {
      ...INITIAL_STATE.providerDefaults,
      claude: {
        model: "claude-opus-4-8",
        modelOptions: { reasoningEffort: "max", contextWindow: "1m" },
        planMode: true,
      },
    })

    expect(useChatPreferencesStore.getState().getComposerState(NEW_CHAT_COMPOSER_ID)).toEqual({
      provider: "claude",
      model: "claude-opus-4-8",
      modelOptions: { reasoningEffort: "max", contextWindow: "1m" },
      planMode: true,
    })
  })

  test("syncProviderDefaults refreshes untouched routed chat state after settings hydration", () => {
    const store = useChatPreferencesStore.getState()

    store.initializeComposerForChat("chat-a")
    store.syncProviderDefaults("last_used", {
      ...INITIAL_STATE.providerDefaults,
      claude: {
        model: "claude-opus-4-8",
        modelOptions: { reasoningEffort: "max", contextWindow: "1m" },
        planMode: true,
      },
    })

    expect(useChatPreferencesStore.getState().getComposerState("chat-a")).toEqual({
      provider: "claude",
      model: "claude-opus-4-8",
      modelOptions: { reasoningEffort: "max", contextWindow: "1m" },
      planMode: true,
    })
  })

  test("syncProviderDefaults does not replace a changed new-chat state", () => {
    const store = useChatPreferencesStore.getState()

    store.setComposerState(NEW_CHAT_COMPOSER_ID, {
      provider: "codex",
      model: "gpt-5.5",
      modelOptions: { reasoningEffort: "low", fastMode: true },
      planMode: false,
    })
    store.syncProviderDefaults("last_used", {
      ...INITIAL_STATE.providerDefaults,
      claude: {
        model: "claude-opus-4-8",
        modelOptions: { reasoningEffort: "max", contextWindow: "1m" },
        planMode: true,
      },
    })

    expect(useChatPreferencesStore.getState().getComposerState(NEW_CHAT_COMPOSER_ID)).toEqual({
      provider: "codex",
      model: "gpt-5.5",
      modelOptions: { reasoningEffort: "low", fastMode: true },
      planMode: false,
    })
  })

  test("initializeComposerForChat with last_used copies the provided source state", () => {
    useChatPreferencesStore.setState({
      ...INITIAL_STATE,
      defaultProvider: "last_used",
      chatStates: {
        [NEW_CHAT_COMPOSER_ID]: {
          provider: "codex",
          model: "gpt-5.3-codex",
          modelOptions: { reasoningEffort: "low", fastMode: false },
          planMode: true,
        },
      },
    })

    const sourceState = useChatPreferencesStore.getState().getComposerState(NEW_CHAT_COMPOSER_ID)
    useChatPreferencesStore.getState().initializeComposerForChat("chat-a", { sourceState })

    expect(useChatPreferencesStore.getState().getComposerState("chat-a")).toEqual({
      provider: "codex",
      model: "gpt-5.3-codex",
      modelOptions: { reasoningEffort: "low", fastMode: false },
      planMode: true,
    })
  })
})
