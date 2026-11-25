import { useState, type ComponentProps } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { PROVIDERS } from "../../../../shared/types"
import { AppDialogProvider } from "../../../components/ui/app-dialog"
import { TooltipProvider } from "../../../components/ui/tooltip"
import { ThemeProvider } from "../../../hooks/useTheme"
import { useChatInputStore } from "../../../stores/chatInputStore"
import { ChatInput } from "../../../components/chat-ui/ChatInput"
import { AppSocket } from "../../../app/socket"

interface SubmissionRecord {
  value: string
  options: unknown
  resolve: () => void
  reject: (reason: unknown) => void
}

interface ChatInputFixtureApi {
  setChatId: (chatId: string | null) => void
  setProjectId: (projectId: string) => void
  setMounted: (mounted: boolean) => void
  submissions: () => Array<{ value: string; options: unknown }>
  resolveSubmit: (index: number) => void
  rejectSubmit: (index: number, reason: string) => void
  draft: (chatId: string) => string
  attachments: (chatId: string) => unknown[]
  connectDraft: (url: string, draftChatId: string) => void
}

const submissions: SubmissionRecord[] = []
let connectedDraft: { socket: AppSocket; chatId: string } | undefined

const fixtureApi: ChatInputFixtureApi = {
  setChatId: () => {},
  setProjectId: () => {},
  setMounted: () => {},
  submissions: () => submissions.map(({ value, options }) => ({ value, options })),
  resolveSubmit: (index) => submissions[index]?.resolve(),
  rejectSubmit: (index, reason) => submissions[index]?.reject(new Error(reason)),
  draft: (chatId) => useChatInputStore.getState().getDraft(chatId),
  attachments: (chatId) => useChatInputStore.getState().getAttachmentDrafts(chatId),
  connectDraft: (url, chatId) => {
    const socket = new AppSocket(url)
    socket.start()
    connectedDraft = { socket, chatId }
  },
}

export function mountChatInputFixture(root: HTMLElement) {
  function ChatInputHost() {
    const [chatId, setChatId] = useState<string | null>("chat-one")
    const [projectId, setProjectId] = useState("fixture-project")
    const [mounted, setMounted] = useState(true)
    fixtureApi.setChatId = setChatId
    fixtureApi.setProjectId = setProjectId
    fixtureApi.setMounted = setMounted
    const onSubmit: ComponentProps<typeof ChatInput>["onSubmit"] = async (value, options) => {
      if (connectedDraft) {
        await connectedDraft.socket.command({ type: "chat.send", chatId: connectedDraft.chatId, content: value, ...options })
        return
      }
      return new Promise((resolve, reject) => {
        submissions.push({ value, options, resolve, reject })
      })
    }

    return (
      <main>
        <div data-testid="fixture-ready" />
        <output data-testid="current-chat">{chatId}</output>
        {mounted && <ChatInput
          key={chatId ?? "landing"}
          chatId={chatId}
          draftKey={chatId ? undefined : "landing"}
          projectId={projectId}
          onSubmit={onSubmit}
          disabled={false}
          canCancel={false}
          activeProvider={null}
          availableProviders={PROVIDERS}
        />}
      </main>
    )
  }

  ;(window as unknown as { __chatInputFixture: ChatInputFixtureApi }).__chatInputFixture = fixtureApi
  createRoot(root).render(
    <MemoryRouter>
      <ThemeProvider>
        <TooltipProvider>
          <AppDialogProvider>
            <ChatInputHost />
          </AppDialogProvider>
        </TooltipProvider>
      </ThemeProvider>
    </MemoryRouter>
  )
}
