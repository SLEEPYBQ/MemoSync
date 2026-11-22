import { useState } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { AskUserQuestionMessage } from "../../../components/messages/AskUserQuestionMessage"
import { useChatPageSidebarActions } from "../../../app/ChatPage/useChatPageSidebarActions"
import { AppDialogProvider } from "../../../components/ui/app-dialog"
import { ThemeProvider } from "../../../hooks/useTheme"
import type { AppState } from "../../../app/useAppState"

const submissions: Array<{ answers: unknown; resolve: () => void; reject: () => void }> = []
const commands: Array<{ type: string; chatId?: string }> = []
let resolveGenerate: ((value: { subject: string; body: string }) => void) | undefined
const socket = {
  command(command: { type: string; chatId?: string }) {
    commands.push(command)
    if (command.type === "chat.generateCommitMessage") return new Promise(resolve => { resolveGenerate = resolve as typeof resolveGenerate })
    return Promise.resolve({ ok: true, snapshotChanged: true })
  },
}

export function mountQuestionGitFixture(root: HTMLElement) {
  function Fixture() {
    const [chatId, setChatId] = useState("chat-a")
    const actions = useChatPageSidebarActions({
      state: { activeChatId: chatId, socket, isProcessing: false } as unknown as AppState,
      projectId: null,
      showRightSidebar: false,
    })
    return <main>
      <div data-testid="fixture-ready" />
      <AskUserQuestionMessage
        message={{
          toolId: "question", toolKind: "ask_user_question",
          input: { questions: [{ id: "q", question: "Choose", multiSelect: true, options: [{ label: "Option A" }] }] },
        } as never}
        isLatest
        onSubmit={(_id, _questions, answers) => new Promise<void>((resolve, reject) => {
          submissions.push({ answers, resolve, reject: () => reject(new Error("fixture rejected")) })
        })}
      />
      <button data-testid="switch-chat" onClick={() => setChatId("chat-b")}>Switch</button>
      <button data-testid="generate-and-commit" onClick={() => {
        const { handleGenerateCommitMessage, handleCommitDiffs } = actions
        void (async () => {
          const generated = await handleGenerateCommitMessage({ paths: ["fixture.txt"] })
          await handleCommitDiffs({ paths: ["fixture.txt"], summary: generated.subject, description: generated.body, mode: "commit_only" })
        })()
      }}>Generate</button>
    </main>
  }
  Object.assign(window, { __questionGitFixture: {
    answers: () => submissions.map(entry => entry.answers),
    reject: (index: number) => submissions[index]?.reject(),
    resolve: (index: number) => submissions[index]?.resolve(),
    commands: () => commands,
    resolveGenerate: () => resolveGenerate?.({ subject: "fixture", body: "" }),
  } })
  createRoot(root).render(<MemoryRouter><ThemeProvider><AppDialogProvider><Fixture /></AppDialogProvider></ThemeProvider></MemoryRouter>)
}
