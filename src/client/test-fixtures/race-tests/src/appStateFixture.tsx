import { useState } from "react"
import { createRoot } from "react-dom/client"
import { Link, MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router-dom"
import { AppDialogProvider } from "../../../components/ui/app-dialog"
import { TooltipProvider } from "../../../components/ui/tooltip"
import { FilesPanel } from "../../../components/chat-ui/FilesPanel"
import { ThemeProvider } from "../../../hooks/useTheme"
import { LocalProjectsPage } from "../../../app/LocalProjectsPage"
import { useAppState } from "../../../app/useAppState"
import { useChatPageSidebarActions } from "../../../app/ChatPage/useChatPageSidebarActions"
import { AppSocket } from "../../../app/socket"
import type { ChatAttachment } from "../../../../shared/types"

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
  createdBranchBases: () => string[]
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
  send: (content: string, draft?: { chatId: string; projectId: string }) => void
  sendFromPath: (content: string) => void
  sendCount: () => number
  sentAttachments: (index: number) => ChatAttachment[]
  acceptedSends: () => number
  resolveSend: (index: number, chatId: string) => void
  rejectSend: (index: number) => void
  location: () => string
  runtimeStatus: () => string | null
  activeProjectId: () => string | null
  projectCount: () => number
  resolveProject: (index: number, projectId: string) => void
  ask: () => Promise<string>
}

const subscriptions: ChatSubscription[] = []
const historyRequests: HistoryRequest[] = []
const sendRequests: Array<{ attachments: ChatAttachment[]; resolve: (value: unknown) => void; reject: (reason: unknown) => void }> = []
let acceptedSends = 0
const projectRequests: Array<{ resolve: (value: unknown) => void }> = []
const landingFixture = new URLSearchParams(window.location.search).get("view") === "landing"
const projectPaths = landingFixture ? ["/fixture/alpha", "/fixture/beta"] : []
const createdBranchBases: string[] = []

const fixtureApi: AppStateFixtureApi = {
  createdBranchBases: () => [...createdBranchBases],
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
  send: () => {},
  sendFromPath: () => {},
  sendCount: () => sendRequests.length,
  sentAttachments: index => sendRequests[index].attachments,
  acceptedSends: () => acceptedSends,
  resolveSend: (index, chatId) => sendRequests[index]?.resolve({ chatId }),
  rejectSend: (index) => sendRequests[index]?.reject(new Error("fixture send failed")),
  location: () => "",
  runtimeStatus: () => null,
  activeProjectId: () => null,
  projectCount: () => projectRequests.length,
  resolveProject: (index, projectId) => projectRequests[index]?.resolve({ projectId }),
  ask: async () => "",
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
    if (topic.type === "sidebar") listener({ projectGroups: projectPaths.map(localPath => ({
      groupKey: localPath.split("/").at(-1), localPath, chats: [],
    })) })
    if (topic.type === "local-projects") {
      listener({
        machine: { id: "local", displayName: "Fixture", platform: "linux" },
        projects: projectPaths.map(localPath => ({ localPath, title: localPath, source: "saved", chatCount: 0 })),
      })
    }
    return () => {
      subscription.active = false
    }
  },
  command(command: { type: string; chatId?: string; beforeCursor?: string; localPath?: string; attachments?: ChatAttachment[]; baseBranchName?: string }) {
    if (command.type === "chat.ensureDraft") {
      const projectId = command.localPath!.split("/").at(-1)
      return Promise.resolve({ chatId: `draft-${projectId}`, projectId })
    }
    if (command.type === "chat.listBranches") return Promise.resolve({ currentBranchName: "feature/current", defaultBranchName: "main" })
    if (command.type === "chat.createBranch") {
      createdBranchBases.push(command.baseBranchName!)
      return Promise.resolve({ ok: true })
    }
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
    if (command.type === "chat.send") return new Promise((resolve, reject) => {
      sendRequests.push({ attachments: command.attachments ?? [], resolve, reject })
    })
    if (command.type === "project.open") return new Promise(resolve => {
      projectRequests.push({ resolve })
    })
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
    const [fixtureChatId, setActiveChatId] = useState<string | null>("chat-a")
    const [showFiles, setShowFiles] = useState(false)
    const location = useLocation()
    const activeChatId = landingFixture ? location.pathname.split("/chat/")[1] ?? null : fixtureChatId
    const state = useAppState(activeChatId)
    const { handleCreateBranch } = useChatPageSidebarActions({ state, projectId: null, showRightSidebar: false })
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
    fixtureApi.send = (content, draft) => { void state.handleSend(content, { draft }).catch(() => {}) }
    fixtureApi.sendFromPath = content => { void state.handleSend(content, { projectLocalPath: "/fixture/project-a" }).catch(() => {}) }
    fixtureApi.location = () => location.pathname
    fixtureApi.runtimeStatus = () => state.runtimeStatus
    fixtureApi.activeProjectId = () => state.activeProjectId
    fixtureApi.ask = async () => {
      try {
        await state.handleAskUserQuestion("fixture", [], {})
        return "resolved"
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    }
    const renderedState = {
      activeChatId: state.activeChatId,
      snapshotChatId: state.chatSnapshot?.runtime.chatId ?? null,
      transcriptIds: state.messages.map((message) => message.id),
      isHistoryLoading: state.isHistoryLoading,
      hasOlderHistory: state.hasOlderHistory,
      commandError: state.commandError,
    }

    if (landingFixture) return <TooltipProvider>
      <div data-testid="fixture-ready" />
      <Routes>
        <Route element={<Outlet context={{ ...state, handleSend: async (...args: Parameters<typeof state.handleSend>) => {
          await state.handleSend(...args)
          acceptedSends++
        } }} />}>
          <Route index element={<LocalProjectsPage />} />
          <Route path="/chat/:chatId" element={<Link to="/">Back to landing</Link>} />
        </Route>
      </Routes>
    </TooltipProvider>

    return (
      <main>
        <div data-testid="fixture-ready" />
        <button onClick={() => setShowFiles(!showFiles)}>Toggle Files</button>
        <button onClick={() => void state.handleSignOut()}>Sign out</button>
        <button onClick={() => void handleCreateBranch()}>Create branch</button>
        {showFiles && <TooltipProvider><FilesPanel projectId="project-a" /></TooltipProvider>}
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
