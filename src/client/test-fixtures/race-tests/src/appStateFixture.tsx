import { useState } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { AppDialogProvider } from "../../../components/ui/app-dialog"
import { ThemeProvider } from "../../../hooks/useTheme"
import { useAppState } from "../../../app/useAppState"
import { AppSocket } from "../../../app/socket"

interface ChatSubscription {
  topic: { type: string; chatId?: string }
  listener: (snapshot: unknown) => void
  active: boolean
}

interface HistoryRequest {
  command: { type: string; chatId?: string; beforeCursor?: string }
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

interface AppStateFixtureApi {
  transcriptRevision: () => number
  streamingText: () => string | null
  promptContents: () => string[]
  setChatId: (chatId: string | null) => void
  chatSubscriptionCount: (chatId: string) => number
  emitChat: (chatId: string, subscriptionIndex: number, snapshot: unknown) => void
  historyRequestCount: () => number
  historyRequest: (index: number) => { type: string; chatId?: string; beforeCursor?: string } | undefined
  resolveHistory: (index: number, page: unknown) => void
  rejectHistory: (index: number, reason: string) => void
}

const subscriptions: ChatSubscription[] = []
const historyRequests: HistoryRequest[] = []

const fixtureApi: AppStateFixtureApi = {
  transcriptRevision: () => 0,
  streamingText: () => null,
  promptContents: () => [],
  setChatId: () => {},
  chatSubscriptionCount: (chatId) => subscriptions.filter(
    (subscription) => subscription.topic.type === "chat" && subscription.topic.chatId === chatId
  ).length,
  emitChat: (chatId, subscriptionIndex, snapshot) => {
    const matching = subscriptions.filter(
      (subscription) => subscription.topic.type === "chat" && subscription.topic.chatId === chatId
    )
    matching[subscriptionIndex]?.listener(snapshot)
  },
  historyRequestCount: () => historyRequests.length,
  historyRequest: (index) => {
    const command = historyRequests[index]?.command
    if (!command) return undefined
    return { type: command.type, chatId: command.chatId, beforeCursor: command.beforeCursor }
  },
  resolveHistory: (index, page) => historyRequests[index]?.resolve(page),
  rejectHistory: (index, reason) => historyRequests[index]?.reject(new Error(reason)),
}

Object.assign(AppSocket.prototype, {
  start() {},
  dispose() {},
  onStatus(listener: (status: string) => void) {
    listener("connected")
    return () => {}
  },
  subscribe(topic: { type: string; chatId?: string }, listener: (snapshot: unknown) => void) {
    const subscription = { topic, listener, active: true }
    subscriptions.push(subscription)
    if (topic.type === "sidebar") listener({ projectGroups: [] })
    if (topic.type === "local-projects") {
      listener({
        machine: { id: "local", displayName: "Fixture", platform: "linux" },
        projects: [],
      })
    }
    return () => {
      subscription.active = false
    }
  },
  command(command: { type: string; chatId?: string; beforeCursor?: string }) {
    if (command.type === "settings.readAppSettings") {
      return Promise.resolve({
        browserSettingsMigrated: true,
        theme: "system",
        chatSoundPreference: "never",
        chatSoundId: "ping",
        terminal: { scrollbackLines: 1_000, minColumnWidth: 20 },
        editor: { preset: "vscode", commandTemplate: "" },
        defaultProvider: "claude",
        providerDefaults: {
          claude: {
            model: "claude-sonnet-4-6",
            modelOptions: { reasoningEffort: "high", contextWindow: "1m" },
            planMode: false,
          },
          codex: {
            model: "gpt-5.4-mini",
            modelOptions: { reasoningEffort: "high", fastMode: false },
            planMode: false,
          },
        },
        memoryPreview: { enabled: false, autoProceedWhenEmpty: false },
        warning: null,
        filePathDisplay: "",
      })
    }
    if (command.type !== "chat.loadHistory") return Promise.resolve({})
    return new Promise((resolve, reject) => {
      historyRequests.push({ command, resolve, reject })
    })
  },
})

export function mountAppStateFixture(root: HTMLElement) {
  let lastMessages: unknown
  let transcriptRevision = 0
  function AppStateHost() {
    const [activeChatId, setActiveChatId] = useState<string | null>("chat-a")
    const state = useAppState(activeChatId)
    if (lastMessages !== state.messages) {
      lastMessages = state.messages
      transcriptRevision += 1
    }
    fixtureApi.transcriptRevision = () => transcriptRevision
    fixtureApi.streamingText = () => state.chatSnapshot?.runtime.streamingText ?? null
    fixtureApi.promptContents = () => state.messages
      .filter((message) => message.kind === "user_prompt")
      .map((message) => message.content)
    fixtureApi.setChatId = setActiveChatId
    const renderedState = {
      activeChatId: state.activeChatId,
      snapshotChatId: state.chatSnapshot?.runtime.chatId ?? null,
      transcriptIds: state.messages.map((message) => message.id),
      isHistoryLoading: state.isHistoryLoading,
      hasOlderHistory: state.hasOlderHistory,
      commandError: state.commandError,
    }

    return (
      <main>
        <div data-testid="fixture-ready" />
        <button type="button" data-testid="activate-chat-a" onClick={() => setActiveChatId("chat-a")}>Chat A</button>
        <button type="button" data-testid="activate-chat-b" onClick={() => setActiveChatId("chat-b")}>Chat B</button>
        <button
          type="button"
          data-testid="load-history"
          disabled={!state.hasOlderHistory || state.isHistoryLoading}
          onClick={() => void state.loadOlderHistory()}
        >
          Load history
        </button>
        <output data-testid="app-state">{JSON.stringify(renderedState)}</output>
      </main>
    )
  }

  ;(window as unknown as { __appStateFixture: AppStateFixtureApi }).__appStateFixture = fixtureApi
  createRoot(root).render(
    <MemoryRouter>
      <ThemeProvider>
        <AppDialogProvider>
          <AppStateHost />
        </AppDialogProvider>
      </ThemeProvider>
    </MemoryRouter>
  )
}
