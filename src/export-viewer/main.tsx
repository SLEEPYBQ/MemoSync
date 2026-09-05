import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { type LegendListRef } from "@legendapp/list/react"
import { Flower } from "lucide-react"
import "@fontsource-variable/bricolage-grotesque"
import { ChatTranscriptViewport } from "../client/app/ChatPage/ChatTranscriptViewport"
import { getLatestToolIds } from "../client/app/derived"
import { TranscriptRenderOptionsProvider } from "../client/components/messages/render-context"
import { processTranscriptMessages } from "../client/lib/parseTranscript"
import type { AskUserQuestionItem } from "../client/components/messages/types"
import { APP_NAME } from "../shared/branding"
import type { AskUserQuestionAnswerMap, StandaloneTranscriptBundle } from "../shared/types"
import "../index.css"

// The viewer renders whatever theme the bundle RECORDED at export time (an
// exported page is a frozen artifact; the app itself is light-locked, so new
// bundles always record light — this branch keeps old dark exports readable).
function syncThemeMetadata(theme: "light" | "dark") {
  const backgroundColor =
    getComputedStyle(document.body).backgroundColor || getComputedStyle(document.documentElement).backgroundColor
  if (backgroundColor) {
    let tag = document.head.querySelector('meta[name="theme-color"]')
    if (!tag) {
      tag = document.createElement("meta")
      tag.setAttribute("name", "theme-color")
      document.head.appendChild(tag)
    }
    tag.setAttribute("content", backgroundColor)
  }
  document.documentElement.style.colorScheme = theme
}

type ViewerState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; bundle: StandaloneTranscriptBundle }

function StandaloneTranscriptApp() {
  const [state, setState] = useState<ViewerState>({ status: "loading" })
  const [isAtEnd, setIsAtEnd] = useState(true)
  const listRef = useRef<LegendListRef | null>(null)

  useEffect(() => {
    let cancelled = false

    void fetch(new URL("./transcript.json", document.baseURI).toString(), {
      headers: {
        Accept: "application/json",
      },
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Transcript request failed with status ${response.status}`)
        }

        return await response.json() as StandaloneTranscriptBundle
      })
      .then((bundle) => {
        if (cancelled) return
        setState({ status: "ready", bundle })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "Unable to load transcript.",
        })
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (state.status !== "ready") {
      return
    }

    document.title = `${state.bundle.title} | ${APP_NAME}`
    document.documentElement.classList.toggle("dark", state.bundle.theme === "dark")
    document.documentElement.style.colorScheme = state.bundle.theme

    const frameId = window.requestAnimationFrame(() => {
      syncThemeMetadata(state.bundle.theme)
    })

    return () => {
      window.cancelAnimationFrame(frameId)
    }
  }, [state])

  const messages = useMemo(
    () => state.status === "ready" ? processTranscriptMessages(state.bundle.messages) : [],
    [state],
  )
  const latestToolIds = useMemo(() => getLatestToolIds(messages), [messages])

  const noop = useCallback(() => undefined, [])
  const noopPromise = useCallback(() => Promise.resolve(), [])
  const handleAskUserQuestion = useCallback((
    _toolUseId: string,
    _questions: AskUserQuestionItem[],
    _answers: AskUserQuestionAnswerMap,
  ) => Promise.resolve(), [])
  const handleExitPlanMode = useCallback((
    _toolUseId: string,
    _confirmed: boolean,
    _clearContext?: boolean,
    _message?: string,
  ) => Promise.resolve(), [])
  const handleOpenLocalLink = useCallback(() => Promise.resolve(), [])
  const scrollToBottom = useCallback(() => {
    void listRef.current?.scrollToEnd?.({ animated: true })
  }, [])

  if (state.status === "loading") {
    return (
      <div className="flex h-full items-center justify-center bg-background text-sm text-muted-foreground">
        Loading transcript...
      </div>
    )
  }

  if (state.status === "error") {
    return (
      <div className="flex h-full items-center justify-center bg-background px-6">
        <div className="max-w-md rounded-2xl border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-foreground">
          {state.message}
        </div>
      </div>
    )
  }

  return (
    <TranscriptRenderOptionsProvider
      value={{
        readonly: true,
        localLinkMode: "text",
        attachmentMode: state.bundle.attachmentMode,
      }}
    >
      <div className="h-full bg-background">
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
          <header className="flex-shrink-0 border-b border-border px-4">
            <div className="mx-auto flex h-16 w-full items-center gap-2 min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <span className="flex flex-shrink-0 items-center gap-2">
                  <Flower className="h-5 w-5 sm:h-6 sm:w-6 text-logo" />
                  <span className="font-logo text-base uppercase sm:text-lg text-slate-600 dark:text-slate-100">
                    {APP_NAME}
                  </span>
                </span>
                <span className="hidden text-sm text-muted-foreground sm:inline">/</span>
                <span className="truncate text-sm text-muted-foreground">{state.bundle.title}</span>
              </div>
              <div className="flex-1 md:hidden" />
            </div>
          </header>

          <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
          <ChatTranscriptViewport
            activeChatId={state.bundle.chatId}
            listRef={listRef}
            messages={messages}
            queuedMessages={[]}
            transcriptPaddingBottom={120}
            localPath={state.bundle.localPath}
            latestToolIds={latestToolIds}
            isHistoryLoading={false}
            hasOlderHistory={false}
            isProcessing={false}
            canCancel={false}
            runtimeStatus={null}
            isDraining={false}
            commandError={null}
            loadOlderHistory={noopPromise}
            onStopDraining={noop}
            onSteerQueuedMessage={noopPromise}
            onRemoveQueuedMessage={noopPromise}
            onOpenLocalLink={handleOpenLocalLink}
            onAskUserQuestionSubmit={handleAskUserQuestion}
            onExitPlanModeConfirm={handleExitPlanMode}
            showScrollButton={!isAtEnd && messages.length > 0}
            onIsAtEndChange={setIsAtEnd}
            scrollToBottom={scrollToBottom}
            typedEmptyStateText=""
            isEmptyStateTypingComplete
            isPageFileDragActive={false}
            showEmptyState={false}
            headerOffsetPx={20}
          />

          </div>
        </div>
      </div>
    </TranscriptRenderOptionsProvider>
  )
}

const container = document.getElementById("root")

if (!container) {
  throw new Error("Missing #root")
}

createRoot(container).render(
  <StrictMode>
    <StandaloneTranscriptApp />
  </StrictMode>,
)
