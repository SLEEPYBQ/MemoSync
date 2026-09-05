import { LegendList, type LegendListRef } from "@legendapp/list/react"
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowDown, Upload } from "lucide-react"
import { AnimatedShinyText } from "../../components/ui/animated-shiny-text"
import { DrainingIndicator } from "../../components/messages/DrainingIndicator"
import { QueuedUserMessage } from "../../components/messages/QueuedUserMessage"
import { OpenLocalLinkProvider, type OpenLocalLinkTarget, useEnsureMemoriesLoaded } from "../../components/messages/shared"
import { TranscriptChatContextProvider, ViolatedCitationsMapProvider } from "../../components/messages/render-context"
import { buildViolatedCitationsByMessageId, violatedCitationsSignature } from "../../lib/violatedCitations"
import { hasOpenMemoryPreparationStep as hasOpenMemoryPreparationStepIn } from "../../lib/memoryPreparation"
import { MAX_FILES_PER_DROP } from "../../components/chat-ui/ChatInput"
import { ProcessingMessage } from "../../components/messages/ProcessingMessage"
import { StreamingAssistantText } from "../../components/messages/StreamingAssistantText"
import { BrandIcon } from "../../components/BrandMark"
import { ContextMenu, ContextMenuTrigger } from "../../components/ui/context-menu"
import { OpenExternalContextMenuContent } from "../../components/open-external-menu"
import { cn } from "../../lib/utils"
import { shouldOpenLocalFileLinkInEditor } from "../../lib/pathUtils"
import {
  buildResolvedTranscriptRows,
  ChatTranscriptRow,
  getCurrentTurnAssistantMessageIds,
  type ResolvedTranscriptRow,
  useStableResolvedRows,
} from "../ChatTranscript"
import type { AppState } from "../useAppState"
import {
  CHAT_NAVBAR_OFFSET_PX,
  EMPTY_STATE_TEXT,
} from "./utils"
import type { EditorPreset } from "../../../shared/protocol"

interface ChatTranscriptViewportProps {
  activeChatId: string | null
  projectId?: string | null
  listRef: React.RefObject<LegendListRef | null>
  messages: AppState["messages"]
  queuedMessages: AppState["queuedMessages"]
  transcriptPaddingBottom: number
  localPath: string | null | undefined
  latestToolIds: AppState["latestToolIds"]
  isHistoryLoading: boolean
  hasOlderHistory: boolean
  isProcessing: boolean
  canCancel: boolean
  runtimeStatus: string | null
  /** The in-flight assistant reply (ChatRuntime.streamingText). */
  streamingText?: string | null
  isDraining: boolean
  commandError: string | null
  loadOlderHistory: () => Promise<void>
  onStopDraining: () => void
  onSteerQueuedMessage: (queuedMessageId: string) => Promise<void>
  onRemoveQueuedMessage: (queuedMessageId: string) => Promise<void>
  onOpenLocalLink: AppState["handleOpenLocalLink"]
  onAskUserQuestionSubmit: AppState["handleAskUserQuestion"]
  onExitPlanModeConfirm: AppState["handleExitPlanMode"]
  onMemoryPreviewRespond?: AppState["handleMemoryPreviewRespond"]
  onMemoryProposalsRespond?: AppState["handleMemoryProposalsRespond"]
  onMemoryCheckupRespond?: AppState["handleMemoryCheckupRespond"]
  onMemoryTransferRespond?: AppState["handleMemoryTransferRespond"]
  onMemoryPreparationReopen?: AppState["handleMemoryPreparationReopen"]
  showScrollButton: boolean
  onIsAtEndChange: (isAtEnd: boolean) => void
  scrollToBottom: () => void
  typedEmptyStateText: string
  isEmptyStateTypingComplete: boolean
  isPageFileDragActive: boolean
  showEmptyState: boolean
  editorPreset?: EditorPreset
  editorCommandTemplate?: string
  platform?: NodeJS.Platform
  headerOffsetPx?: number
}

export const ChatTranscriptViewport = memo(function ChatTranscriptViewport({
  activeChatId,
  projectId,
  listRef,
  messages,
  queuedMessages,
  transcriptPaddingBottom,
  localPath,
  latestToolIds,
  isHistoryLoading,
  hasOlderHistory,
  isProcessing,
  canCancel,
  runtimeStatus,
  streamingText,
  isDraining,
  commandError,
  loadOlderHistory,
  onStopDraining,
  onSteerQueuedMessage,
  onRemoveQueuedMessage,
  onOpenLocalLink,
  onAskUserQuestionSubmit,
  onExitPlanModeConfirm,
  onMemoryPreviewRespond,
  onMemoryProposalsRespond,
  onMemoryCheckupRespond,
  onMemoryTransferRespond,
  onMemoryPreparationReopen,
  showScrollButton,
  onIsAtEndChange,
  scrollToBottom,
  typedEmptyStateText,
  isEmptyStateTypingComplete,
  isPageFileDragActive,
  showEmptyState,
  editorPreset = "cursor",
  editorCommandTemplate,
  platform = "darwin",
  headerOffsetPx = CHAT_NAVBAR_OFFSET_PX,
}: ChatTranscriptViewportProps) {
  const previousRowCountRef = useRef(0)
  const localLinkMenuTriggerRef = useRef<HTMLSpanElement | null>(null)
  const [toolGroupExpanded, setToolGroupExpanded] = useState<Record<string, boolean>>({})
  const [localLinkMenuTarget, setLocalLinkMenuTarget] = useState<OpenLocalLinkTarget | null>(null)
  const isMac = platform === "darwin"

  useEnsureMemoriesLoaded()

  const hasOpenMemoryPreparationStep = useMemo(
    () => hasOpenMemoryPreparationStepIn(messages),
    [messages],
  )
  // The footer's spinner is the single live indicator while it renders; the
  // trailing SDK status row would duplicate it (a "Requesting…" row above a
  // "Running…" spinner), so it is suppressed and its label moves into the
  // footer below.
  const showsLiveFooter = isProcessing && !hasOpenMemoryPreparationStep
  const rawRows = useMemo(() => buildResolvedTranscriptRows(messages, {
    isLoading: isProcessing,
    localPath: localPath ?? undefined,
    latestToolIds,
    suppressTrailingStatus: showsLiveFooter,
  }), [isProcessing, latestToolIds, localPath, messages, showsLiveFooter])
  const resolvedRows = useStableResolvedRows(rawRows)
  const currentTurnAssistantMessageIds = useMemo(
    () => getCurrentTurnAssistantMessageIds(messages, canCancel),
    [canCancel, messages],
  )
  // One label for the whole working phase: the activity status ("Running…").
  // SDK statuses like "requesting" are hidden entirely (user decision
  // 2026-08-11) — participants should never have to interpret them.
  const footerStatus = runtimeStatus ?? undefined

  // Violated trace verdicts folded onto their replies (drift at the sentence
  // itself). Identity pinned to the fold's signature — verdicts land once per
  // turn, and only then should memoized text rows re-read the context.
  const violatedMap = useMemo(() => buildViolatedCitationsByMessageId(messages), [messages])
  const stableViolatedRef = useRef<{ sig: string; map: Map<string, Set<string>> | null }>({ sig: "", map: null })
  const violatedSig = violatedCitationsSignature(violatedMap)
  if (violatedSig !== stableViolatedRef.current.sig) {
    stableViolatedRef.current = { sig: violatedSig, map: violatedMap }
  }

  useEffect(() => {
    setToolGroupExpanded({})
  }, [activeChatId])

  useEffect(() => {
    const previousRowCount = previousRowCountRef.current
    previousRowCountRef.current = resolvedRows.length

    if (previousRowCount > 0 || resolvedRows.length === 0) {
      return
    }

    onIsAtEndChange(true)
    const frameId = window.requestAnimationFrame(() => {
      void listRef.current?.scrollToEnd?.({ animated: false })
    })
    return () => window.cancelAnimationFrame(frameId)
  }, [listRef, onIsAtEndChange, resolvedRows.length])

  const handleToolGroupExpandedChange = useCallback((groupId: string, next: boolean) => {
    setToolGroupExpanded((current) => (
      current[groupId] === next
        ? current
        : {
            ...current,
            [groupId]: next,
          }
    ))
  }, [])

  const handleScroll = useCallback((event?: unknown) => {
    const currentTarget = (
      typeof event === "object"
      && event !== null
      && "currentTarget" in event
      && event.currentTarget instanceof HTMLElement
    )
      ? event.currentTarget
      : listRef.current?.getScrollableNode?.()

    if (currentTarget instanceof HTMLElement) {
      const distanceFromEnd = currentTarget.scrollHeight - currentTarget.clientHeight - currentTarget.scrollTop
      onIsAtEndChange(distanceFromEnd <= 4)
      return
    }

    const state = listRef.current?.getState?.()
    if (state) {
      onIsAtEndChange(state.isAtEnd)
    }
  }, [listRef, onIsAtEndChange])

  // Depend on WHETHER rows exist, not how many: re-running per row change
  // tears the listener down and rebuilds it behind an rAF, leaving windows
  // where a user scroll goes uncaptured during tool-heavy churn. The boolean
  // still covers the late scroller mount on the empty→first-row transition.
  const hasResolvedRows = resolvedRows.length > 0
  useEffect(() => {
    let cleanup: (() => void) | undefined
    const frameId = window.requestAnimationFrame(() => {
      const scrollNode = listRef.current?.getScrollableNode?.()
      if (!(scrollNode instanceof HTMLElement)) {
        return
      }

      const handleNativeScroll = () => {
        handleScroll({ currentTarget: scrollNode })
      }

      scrollNode.addEventListener("scroll", handleNativeScroll, { passive: true })
      handleNativeScroll()
      cleanup = () => {
        scrollNode.removeEventListener("scroll", handleNativeScroll)
      }
    })

    return () => {
      window.cancelAnimationFrame(frameId)
      cleanup?.()
    }
  }, [activeChatId, handleScroll, listRef, hasResolvedRows])

  const handleStartReached = useCallback(() => {
    if (isHistoryLoading || !hasOlderHistory) {
      return
    }
    void loadOlderHistory()
  }, [hasOlderHistory, isHistoryLoading, loadOlderHistory])

  const openLocalLinkMenu = useCallback((target: OpenLocalLinkTarget) => {
    setLocalLinkMenuTarget(target)
    window.requestAnimationFrame(() => {
      const trigger = localLinkMenuTriggerRef.current
      if (!trigger) return
      const clientX = target.clientX ?? window.innerWidth / 2
      const clientY = target.clientY ?? window.innerHeight / 2
      trigger.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        view: window,
      }))
    })
  }, [])

  const handleOpenLocalLinkClick = useCallback((target: OpenLocalLinkTarget) => {
    if (target.trigger !== "contextmenu" && !shouldOpenLocalFileLinkInEditor(target.path)) {
      void onOpenLocalLink(target, "open_default")
      return
    }

    // Source and text links used to jump straight into Cursor. They now open
    // the non-IDE destination menu (Preview / Finder / Default App), matching
    // the product decision to expose no external-editor entry points.
    openLocalLinkMenu(target)
  }, [onOpenLocalLink, openLocalLinkMenu])

  const renderItem = useCallback(({ item }: { item: ResolvedTranscriptRow }) => (
    <div className="mx-auto w-full max-w-[800px] pb-5" data-transcript-row-id={item.id}>
      <ChatTranscriptRow
        row={item}
        isCurrentTurnAssistant={item.kind === "single" && currentTurnAssistantMessageIds.has(item.message.id)}
        toolGroupExpanded={item.kind === "tool-group" ? (toolGroupExpanded[item.id] ?? true) : undefined}
        onToolGroupExpandedChange={handleToolGroupExpandedChange}
        onAskUserQuestionSubmit={onAskUserQuestionSubmit}
        onExitPlanModeConfirm={onExitPlanModeConfirm}
        onMemoryPreviewRespond={onMemoryPreviewRespond}
        onMemoryProposalsRespond={onMemoryProposalsRespond}
        onMemoryCheckupRespond={onMemoryCheckupRespond}
        onMemoryTransferRespond={onMemoryTransferRespond}
        onMemoryPreparationReopen={onMemoryPreparationReopen}
      />
    </div>
  ), [currentTurnAssistantMessageIds, handleToolGroupExpandedChange, onAskUserQuestionSubmit, onExitPlanModeConfirm, onMemoryPreviewRespond, onMemoryProposalsRespond, onMemoryCheckupRespond, onMemoryTransferRespond, onMemoryPreparationReopen, toolGroupExpanded])

  const listHeader = (
    <div className="mx-auto w-full max-w-[800px]" style={{ paddingTop: `${headerOffsetPx}px` }}>
      {isHistoryLoading ? (
        <div className="flex justify-center pb-4">
          <span className="text-sm translate-y-[-0.5px]">
            <AnimatedShinyText
              animate
              shimmerWidth={Math.max(20, "Loading more messages...".length * 3)}
            >
              Loading more messages...
            </AnimatedShinyText>
          </span>
        </div>
      ) : null}
    </div>
  )

  const listFooter = (
    <div className="mx-auto w-full max-w-[800px]">
      {/* The reply streams here while it is written; the spinner row below it
          keeps signalling "still going" until the final entry lands. */}
      {isProcessing && !hasOpenMemoryPreparationStep && streamingText ? (
        <StreamingAssistantText text={streamingText} />
      ) : null}
      {showsLiveFooter ? <ProcessingMessage status={footerStatus} /> : null}
      {/* "failed" is a persistent outcome (lastTurnOutcome), not a processing
          state — without this row a dead turn just ends in silence. */}
      {!isProcessing && runtimeStatus === "failed" ? <ProcessingMessage status="failed" /> : null}
      {queuedMessages.map((message) => (
        <QueuedUserMessage
          key={message.id}
          message={message}
          onRemove={() => void onRemoveQueuedMessage(message.id)}
          onSendNow={() => void onSteerQueuedMessage(message.id)}
        />
      ))}
      {!isProcessing && isDraining ? (
        <DrainingIndicator onStop={() => void onStopDraining()} />
      ) : null}
      {commandError ? (
        <div className="rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {commandError}
        </div>
      ) : null}
    </div>
  )

  const chatContextValue = useMemo(
    () => ({ chatId: activeChatId ?? undefined, projectId: projectId ?? undefined }),
    [activeChatId, projectId],
  )

  return (
    <TranscriptChatContextProvider value={chatContextValue}>
      <OpenLocalLinkProvider onOpenLocalLink={handleOpenLocalLinkClick}>
        <ViolatedCitationsMapProvider value={stableViolatedRef.current.map}>
        <LegendList<ResolvedTranscriptRow>
          ref={listRef}
          data={resolvedRows}
          extraData={{ toolGroupExpanded, currentTurnAssistantMessageIds }}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          estimatedItemSize={96}
          initialScrollAtEnd
          maintainScrollAtEnd
          maintainScrollAtEndThreshold={0.1}
          maintainVisibleContentPosition
          onScroll={handleScroll}
          onStartReached={handleStartReached}
          onStartReachedThreshold={0.1}
          data-transcript-list=""
          className="h-full flex-1 overflow-x-hidden overscroll-y-contain px-3 scroll-pt-[72px] [scrollbar-gutter:auto]"
          contentContainerStyle={{ paddingBottom: transcriptPaddingBottom + 10 }}
          ListHeaderComponent={listHeader}
          ListFooterComponent={listFooter}
        />
        </ViolatedCitationsMapProvider>
      </OpenLocalLinkProvider>

      <ContextMenu onOpenChange={(open) => {
        if (!open) {
          setLocalLinkMenuTarget(null)
        }
      }}>
        <ContextMenuTrigger asChild>
          <span
            ref={localLinkMenuTriggerRef}
            aria-hidden="true"
            className="pointer-events-none fixed size-px opacity-0"
            style={{
              left: localLinkMenuTarget?.clientX ?? 0,
              top: localLinkMenuTarget?.clientY ?? 0,
            }}
          />
        </ContextMenuTrigger>
        {localLinkMenuTarget ? (
          <OpenExternalContextMenuContent
            isMac={isMac}
            editorPreset={editorPreset}
            editorCommandTemplate={editorCommandTemplate}
            includeFinder
            includePreview
            includeDefault
            includeEditors={false}
            onOpenExternal={(action, editor) => {
              void onOpenLocalLink(localLinkMenuTarget, action, editor)
            }}
          />
        ) : null}
      </ContextMenu>

      {showEmptyState ? (
        <div
          className="pointer-events-none absolute inset-x-4 animate-fade-in"
          style={{
            top: headerOffsetPx,
            bottom: transcriptPaddingBottom,
          }}
        >
          {/* REDESIGN D7: no session-start bring-in gate — every active memory
              is in by default (a zero-evidence moment deserves no forced
              curation decision); the Session memories panel owns the
              restorable per-session exclusions instead. */}
          <div className="mx-auto flex h-full max-w-[800px] items-center justify-center">
              <div className="flex flex-col items-center justify-center gap-4 text-muted-foreground opacity-70">
                <BrandIcon animated="loop" className="memosync-empty-state-flower size-24" />
                <div
                  className="memosync-empty-state-text flex max-w-xs items-center text-center text-base font-normal text-muted-foreground"
                  aria-label={EMPTY_STATE_TEXT}
                >
                  <span className="relative inline-grid place-items-start">
                    <span className="invisible col-start-1 row-start-1 flex items-center whitespace-pre">
                      <span>{EMPTY_STATE_TEXT}</span>
                      <span className="memosync-typewriter-cursor-slot" aria-hidden="true" />
                    </span>
                    <span className="col-start-1 row-start-1 flex items-center whitespace-pre">
                      <span>{typedEmptyStateText}</span>
                      <span className="memosync-typewriter-cursor-slot" aria-hidden="true">
                        <span
                          className="memosync-typewriter-cursor"
                          data-typing-complete={isEmptyStateTypingComplete ? "true" : "false"}
                        />
                      </span>
                    </span>
                  </span>
                </div>
              </div>
          </div>
        </div>
      ) : null}

      {isPageFileDragActive ? (
        <div className="pointer-events-none absolute inset-0 z-30">
          <div className="absolute inset-0 backdrop-blur-sm" />
          <div className="absolute inset-6 ">
            <div className="flex h-full items-center justify-center">
              <div className="flex flex-col items-center justify-center gap-3 text-center">
                <Upload className="mx-auto size-14 text-foreground" strokeWidth={1.75} />
                <div className="text-xl font-medium text-foreground">Drop up to {MAX_FILES_PER_DROP} files</div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div
        style={{ bottom: transcriptPaddingBottom - 20 }}
        className={cn(
          "absolute left-1/2 z-10 -translate-x-1/2 transition-all",
          showScrollButton
            ? "scale-100 duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]"
            : "pointer-events-none scale-60 opacity-0 blur-sm duration-300 ease-out",
        )}
      >
        <button
          onClick={scrollToBottom}
          className="flex aspect-square cursor-pointer items-center gap-1.5 rounded-full border border-border bg-white px-2 text-sm text-primary transition-colors hover:bg-muted hover:text-foreground dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600"
        >
          <ArrowDown className="h-5 w-5" />
        </button>
      </div>
    </TranscriptChatContextProvider>
  )
})

function keyExtractor(item: ResolvedTranscriptRow) {
  return item.id
}
