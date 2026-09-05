import { memo, type RefObject } from "react"
import { OctagonX, X } from "lucide-react"
import { ChatInput, type ChatInputHandle } from "../../components/chat-ui/ChatInput"
import type { ContextWindowSnapshot } from "../../lib/contextWindow"
import type { AppState } from "../useAppState"

interface ChatInputDockProps {
  inputRef: RefObject<HTMLDivElement | null>
  onLayoutChange: () => void
  chatInputRef: RefObject<ChatInputHandle | null>
  chatInputElementRef: RefObject<HTMLTextAreaElement | null>
  activeChatId: string | null
  previousPrompt: string | null
  hasSelectedProject: boolean
  runtimeStatus: string | null
  canCancel: boolean
  projectId: string | null
  activeProvider: "claude" | "codex" | null
  availableProviders: AppState["availableProviders"]
  contextWindowSnapshot: ContextWindowSnapshot | null
  slashCommands: string[]
  onSubmit: AppState["handleSend"]
  onCancel: () => void
  /** Redesign 2026-08-07 §3: an early stop distinguishes itself from a normal
   * finish — a red strip above the composer invites the correction. */
  showStopBanner?: boolean
  onDismissStopBanner?: () => void
}

export const ChatInputDock = memo(function ChatInputDock({
  inputRef,
  onLayoutChange,
  chatInputRef,
  chatInputElementRef,
  activeChatId,
  previousPrompt,
  hasSelectedProject,
  runtimeStatus,
  canCancel,
  projectId,
  activeProvider,
  availableProviders,
  contextWindowSnapshot,
  slashCommands,
  onSubmit,
  onCancel,
  showStopBanner,
  onDismissStopBanner,
}: ChatInputDockProps) {
  return (
    <div className="absolute bottom-0 left-0 right-0 z-20 pointer-events-none">
      <div className="bg-gradient-to-t from-background via-background pointer-events-auto" ref={inputRef}>
        {showStopBanner ? (
          <div className="mx-auto mb-1.5 flex max-w-[840px] items-center gap-2 rounded-xl border border-red-500/35 bg-red-500/10 px-3 py-1.5 text-xs text-red-700 dark:text-red-300">
            <OctagonX className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1">
              Stopped. What went wrong? Your next message corrects the agent — anything worth remembering is
              caught at Step 1.
            </span>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={onDismissStopBanner}
              className="shrink-0 rounded p-0.5 transition-colors hover:bg-red-500/15"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}
        <ChatInput
          ref={chatInputRef}
          inputElementRef={chatInputElementRef}
          onLayoutChange={onLayoutChange}
          key={activeChatId ?? "new-chat"}
          onSubmit={onSubmit}
          onCancel={onCancel}
          disabled={!hasSelectedProject}
          canCancel={canCancel}
          chatId={activeChatId}
          projectId={projectId}
          activeProvider={activeProvider}
          availableProviders={availableProviders}
          contextWindowSnapshot={contextWindowSnapshot}
          previousPrompt={previousPrompt}
          slashCommands={slashCommands}
        />
      </div>
    </div>
  )
})
