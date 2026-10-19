import { useState, type ComponentProps } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { PROVIDERS } from "../../../../shared/types"
import { AppDialogProvider } from "../../../components/ui/app-dialog"
import { ThemeProvider } from "../../../hooks/useTheme"
import { useChatInputStore } from "../../../stores/chatInputStore"
import { ChatInput } from "../../../components/chat-ui/ChatInput"

interface SubmissionRecord {
  value: string
  options: unknown
  resolve: () => void
  reject: (reason: unknown) => void
}

interface ChatInputFixtureApi {
  setChatId: (chatId: string) => void
  submissions: () => Array<{ value: string; options: unknown }>
  resolveSubmit: (index: number) => void
  rejectSubmit: (index: number, reason: string) => void
  draft: (chatId: string) => string
  attachments: (chatId: string) => unknown[]
}

const submissions: SubmissionRecord[] = []

const fixtureApi: ChatInputFixtureApi = {
  setChatId: () => {},
  submissions: () => submissions.map(({ value, options }) => ({ value, options })),
  resolveSubmit: (index) => submissions[index]?.resolve(),
  rejectSubmit: (index, reason) => submissions[index]?.reject(new Error(reason)),
  draft: (chatId) => useChatInputStore.getState().getDraft(chatId),
  attachments: (chatId) => useChatInputStore.getState().getAttachmentDrafts(chatId),
}

export function mountChatInputFixture(root: HTMLElement) {
  function ChatInputHost() {
    const [chatId, setChatId] = useState("chat-one")
    fixtureApi.setChatId = setChatId
    const onSubmit: ComponentProps<typeof ChatInput>["onSubmit"] = (value, options) =>
      new Promise((resolve, reject) => {
        submissions.push({ value, options, resolve, reject })
      })

    return (
      <main>
        <div data-testid="fixture-ready" />
        <output data-testid="current-chat">{chatId}</output>
        <ChatInput
          key={chatId}
          chatId={chatId}
          projectId="fixture-project"
          onSubmit={onSubmit}
          disabled={false}
          canCancel={false}
          activeProvider={null}
          availableProviders={PROVIDERS}
        />
      </main>
    )
  }

  ;(window as unknown as { __chatInputFixture: ChatInputFixtureApi }).__chatInputFixture = fixtureApi
  createRoot(root).render(
    <MemoryRouter>
      <ThemeProvider>
        <AppDialogProvider>
          <ChatInputHost />
        </AppDialogProvider>
      </ThemeProvider>
    </MemoryRouter>
  )
}
