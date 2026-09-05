import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type CSSProperties, type DragEvent, type ReactNode, type RefObject } from "react"
import { type LegendListRef } from "@legendapp/list/react"
import type { GroupImperativeHandle } from "react-resizable-panels"
import { useOutletContext } from "react-router-dom"
import type { ChatInputHandle } from "../../components/chat-ui/ChatInput"
import { ChatNavbar } from "../../components/chat-ui/ChatNavbar"
import { BrowserPanel } from "../../components/chat-ui/BrowserPanel"
import { FilesPanel } from "../../components/chat-ui/FilesPanel"
import { useSlashCommandsStore } from "../../stores/slashCommandsStore"
import { GitPanel } from "../../components/chat-ui/GitPanel"
import { SessionMemoriesPanel } from "../../components/memory-chat/SessionMemoriesPanel"
import { TurnInterruptContext, type TurnInterruptApi } from "../../components/messages/shared"
import { submitStudyPrompt } from "../study/studyPromptIntercept"
import { MemorySummaryPanel } from "../../components/memory-chat/MemorySummaryPanel"
import { StaticMemoryPanel } from "../../components/memory-chat/StaticMemoryPanel"
import { useConditionPolicy } from "../../lib/conditionApi"
import { useAppDialog } from "../../components/ui/app-dialog"
import { Card, CardContent } from "../../components/ui/card"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "../../components/ui/resizable"
import { actionMatchesEvent, getResolvedKeybindings } from "../../lib/keybindings"
import { deriveLatestContextWindowSnapshot } from "../../lib/contextWindow"
import { cn } from "../../lib/utils"
import {
  DEFAULT_RIGHT_SIDEBAR_SIZE,
  DEFAULT_RIGHT_SIDEBAR_VISIBILITY_STATE,
  RIGHT_SIDEBAR_MIN_WIDTH_PX,
  useRightSidebarStore,
} from "../../stores/rightSidebarStore"
import { DEFAULT_PROJECT_TERMINAL_LAYOUT, useTerminalLayoutStore } from "../../stores/terminalLayoutStore"
import { useTerminalPreferencesStore } from "../../stores/terminalPreferencesStore"
import { shouldCloseTerminalPane } from "../terminalLayoutResize"
import { TERMINAL_TOGGLE_ANIMATION_DURATION_MS } from "../terminalToggleAnimation"
import { useRightSidebarToggleAnimation } from "../useRightSidebarToggleAnimation"
import { useStickyChatFocus } from "../useStickyChatFocus"
import { useTerminalToggleAnimation } from "../useTerminalToggleAnimation"
import type { AppState } from "../useAppState"
import { getNextMeasuredInputHeight, getTranscriptPaddingBottom } from "../useAppState"
import { ChatInputDock } from "./ChatInputDock"
import { ChatTranscriptViewport } from "./ChatTranscriptViewport"
import { TerminalWorkspaceShell } from "./TerminalWorkspaceShell"
import { useChatPageSidebarActions, EMPTY_DIFF_SNAPSHOT } from "./useChatPageSidebarActions"
import {
  EMPTY_STATE_TEXT,
  EMPTY_STATE_TYPING_INTERVAL_MS,
  hasFileDragTypes,
  sameContextWindowSnapshot,
} from "./utils"

export {
  getIgnoreFolderEntryFromDiffPath,
  hasFileDragTypes,
  shouldAutoFollowTranscriptResize,
} from "./utils"

function useEmptyStateTyping(showEmptyState: boolean, activeChatId: string | null) {
  const [typedEmptyStateText, setTypedEmptyStateText] = useState("")
  const [isEmptyStateTypingComplete, setIsEmptyStateTypingComplete] = useState(false)

  useEffect(() => {
    if (!showEmptyState) return

    setTypedEmptyStateText("")
    setIsEmptyStateTypingComplete(false)

    let characterIndex = 0
    const interval = window.setInterval(() => {
      characterIndex += 1
      setTypedEmptyStateText(EMPTY_STATE_TEXT.slice(0, characterIndex))

      if (characterIndex >= EMPTY_STATE_TEXT.length) {
        window.clearInterval(interval)
        setIsEmptyStateTypingComplete(true)
      }
    }, EMPTY_STATE_TYPING_INTERVAL_MS)

    return () => window.clearInterval(interval)
  }, [showEmptyState, activeChatId])

  return { typedEmptyStateText, isEmptyStateTypingComplete }
}

function usePageFileDrop(args: {
  hasSelectedProject: boolean
  onFilesDropped: (files: File[]) => void
}) {
  const [isPageFileDragActive, setIsPageFileDragActive] = useState(false)
  const pageFileDragDepthRef = useRef(0)

  const hasDraggedFiles = useCallback((event: DragEvent) => hasFileDragTypes(event.dataTransfer?.types ?? []), [])

  const handleTranscriptDragEnter = useCallback((event: DragEvent) => {
    if (!hasDraggedFiles(event) || !args.hasSelectedProject) return
    event.preventDefault()
    pageFileDragDepthRef.current += 1
    setIsPageFileDragActive(true)
  }, [args.hasSelectedProject, hasDraggedFiles])

  const handleTranscriptDragOver = useCallback((event: DragEvent) => {
    if (!hasDraggedFiles(event) || !args.hasSelectedProject) return
    event.preventDefault()
    event.dataTransfer.dropEffect = "copy"
    if (!isPageFileDragActive) {
      setIsPageFileDragActive(true)
    }
  }, [args.hasSelectedProject, hasDraggedFiles, isPageFileDragActive])

  const handleTranscriptDragLeave = useCallback((event: DragEvent) => {
    if (!hasDraggedFiles(event) || !args.hasSelectedProject) return
    event.preventDefault()
    pageFileDragDepthRef.current = Math.max(0, pageFileDragDepthRef.current - 1)
    if (pageFileDragDepthRef.current === 0) {
      setIsPageFileDragActive(false)
    }
  }, [args.hasSelectedProject, hasDraggedFiles])

  const handleTranscriptDrop = useCallback((event: DragEvent) => {
    if (!hasDraggedFiles(event) || !args.hasSelectedProject) return
    event.preventDefault()
    pageFileDragDepthRef.current = 0
    setIsPageFileDragActive(false)
    args.onFilesDropped([...event.dataTransfer.files])
  }, [args, hasDraggedFiles])

  return {
    isPageFileDragActive,
    handleTranscriptDragEnter,
    handleTranscriptDragOver,
    handleTranscriptDragLeave,
    handleTranscriptDrop,
  }
}

function useLayoutWidth(ref: RefObject<HTMLDivElement | null>) {
  const [layoutWidth, setLayoutWidth] = useState(0)

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return

    const updateWidth = () => {
      const nextWidth = element.clientWidth
      setLayoutWidth((current) => (Math.abs(current - nextWidth) < 1 ? current : nextWidth))
    }

    const observer = new ResizeObserver(updateWidth)
    observer.observe(element)
    updateWidth()

    return () => observer.disconnect()
  }, [ref])

  return layoutWidth
}

function useTranscriptPaddingBottom() {
  const inputRef = useRef<HTMLDivElement>(null)
  const [inputHeight, setInputHeight] = useState(148)

  const syncInputHeight = useCallback(() => {
    const element = inputRef.current
    if (!element) return
    const measuredHeight = element.getBoundingClientRect().height
    setInputHeight((current) => getNextMeasuredInputHeight(current, measuredHeight))
  }, [])

  useLayoutEffect(() => {
    const element = inputRef.current
    if (!element) return

    const observer = new ResizeObserver(() => {
      syncInputHeight()
    })
    observer.observe(element)
    syncInputHeight()
    return () => observer.disconnect()
  }, [syncInputHeight])

  return {
    inputRef,
    syncInputHeight,
    transcriptPaddingBottom: getTranscriptPaddingBottom(inputHeight),
  }
}

const MOBILE_RIGHT_SIDEBAR_BREAKPOINT_PX = 768
const RIGHT_SIDEBAR_MIN_WORKSPACE_SIZE_PERCENT = 20
const RIGHT_SIDEBAR_MAX_SIZE_PERCENT = 100 - RIGHT_SIDEBAR_MIN_WORKSPACE_SIZE_PERCENT

export function shouldUseMobileRightSidebarOverlay(viewportWidth: number) {
  return viewportWidth > 0 && viewportWidth < MOBILE_RIGHT_SIDEBAR_BREAKPOINT_PX
}

export function getRightSidebarSizePercent(sizePx: number, layoutWidth: number) {
  if (!Number.isFinite(sizePx) || !Number.isFinite(layoutWidth) || layoutWidth <= 0) {
    return 0
  }

  const minSizePercent = (RIGHT_SIDEBAR_MIN_WIDTH_PX / layoutWidth) * 100
  const requestedSizePercent = (Math.max(RIGHT_SIDEBAR_MIN_WIDTH_PX, sizePx) / layoutWidth) * 100
  return Math.min(RIGHT_SIDEBAR_MAX_SIZE_PERCENT, Math.max(minSizePercent, requestedSizePercent))
}

export function getRightSidebarSizePx(sizePercent: number, layoutWidth: number) {
  if (!Number.isFinite(sizePercent) || !Number.isFinite(layoutWidth) || layoutWidth <= 0) {
    return DEFAULT_RIGHT_SIDEBAR_SIZE
  }

  return Math.max(RIGHT_SIDEBAR_MIN_WIDTH_PX, layoutWidth * (sizePercent / 100))
}

function useMobileRightSidebarOverlayEnabled() {
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window === "undefined" ? 0 : window.innerWidth))

  useEffect(() => {
    if (typeof window === "undefined") return

    const updateViewportWidth = () => setViewportWidth(window.innerWidth)
    updateViewportWidth()
    window.addEventListener("resize", updateViewportWidth)
    return () => window.removeEventListener("resize", updateViewportWidth)
  }, [])

  return shouldUseMobileRightSidebarOverlay(viewportWidth)
}

function useFixedTerminalHeight(args: {
  layoutRootRef: RefObject<HTMLDivElement | null>
  shouldRenderTerminalLayout: boolean
  terminalMainSizes: [number, number]
}) {
  const [fixedTerminalHeight, setFixedTerminalHeight] = useState(0)

  useEffect(() => {
    const element = args.layoutRootRef.current
    if (!element) return

    const updateHeight = () => {
      const containerHeight = element.getBoundingClientRect().height

      if (!args.shouldRenderTerminalLayout) {
        return
      }

      if (containerHeight <= 0) return
      const nextHeight = containerHeight * (args.terminalMainSizes[1] / 100)
      if (nextHeight <= 0) return
      setFixedTerminalHeight((current) => (Math.abs(current - nextHeight) < 1 ? current : nextHeight))
    }

    const observer = new ResizeObserver(updateHeight)
    observer.observe(element)
    updateHeight()

    return () => observer.disconnect()
  }, [args.layoutRootRef, args.shouldRenderTerminalLayout, args.terminalMainSizes])

  return fixedTerminalHeight
}

interface ChatWorkspaceProps {
  chatCard: ReactNode
  projectId: string
  shouldRenderTerminalLayout: boolean
  showTerminalPane: boolean
  terminalLayout: ReturnType<typeof useTerminalLayoutStore.getState>["projects"][string]
  mainPanelGroupRef: RefObject<GroupImperativeHandle | null>
  terminalPanelRef: RefObject<HTMLDivElement | null>
  terminalVisualRef: RefObject<HTMLDivElement | null>
  fixedTerminalHeight: number
  terminalFocusRequestVersion: number
  addTerminal: ReturnType<typeof useTerminalLayoutStore.getState>["addTerminal"]
  socket: AppState["socket"]
  connectionStatus: AppState["connectionStatus"]
  scrollback: number
  minColumnWidth: number
  splitTerminalShortcut?: string[]
  pendingCommandsByTerminalId?: Record<string, string>
  onTerminalCommandSent?: () => void
  onInitialTerminalCommandSent?: (terminalId: string) => void
  onRemoveTerminal: (projectId: string, terminalId: string) => void
  onTerminalLayout: ReturnType<typeof useTerminalLayoutStore.getState>["setTerminalSizes"]
  onLayoutChanged: (layout: Record<string, number>) => void
}

type ChatSidebarContentProps = ComponentProps<typeof GitPanel>

const ChatSidebarContent = memo(function ChatSidebarContent(props: ChatSidebarContentProps) {
  return (
    <GitPanel
      {...props}
      diffs={props.diffs ?? EMPTY_DIFF_SNAPSHOT}
    />
  )
})

export function getTerminalPanelDefaultSizes(showTerminalPane: boolean, mainSizes: [number, number]): [number, number] {
  return showTerminalPane ? mainSizes : [100, 0]
}

interface DesktopSidebarPaneProps {
  showRightSidebar: boolean
  sizePercent: number
  sidebarPanelRef: RefObject<HTMLDivElement | null>
  sidebarVisualRef: RefObject<HTMLDivElement | null>
  content: ReactNode
}

const DesktopSidebarPane = memo(function DesktopSidebarPane({
  showRightSidebar,
  sizePercent,
  sidebarPanelRef,
  sidebarVisualRef,
  content,
}: DesktopSidebarPaneProps) {
  return (
    <ResizablePanel
      id="rightSidebar"
      defaultSize={`${sizePercent}%`}
      className="min-h-0 min-w-0"
      elementRef={sidebarPanelRef}
      groupResizeBehavior="preserve-pixel-size"
    >
      <div
        ref={sidebarVisualRef}
        className="h-full min-h-0 overflow-hidden"
        data-right-sidebar-open={showRightSidebar ? "true" : "false"}
        data-right-sidebar-animated="false"
        data-right-sidebar-visual
        style={{
          "--terminal-toggle-duration": `${TERMINAL_TOGGLE_ANIMATION_DURATION_MS}ms`,
        } as CSSProperties}
      >
        {content}
      </div>
    </ResizablePanel>
  )
})

interface MobileSidebarPaneProps {
  projectId: string | null
  showRightSidebar: boolean
  sidebarVisualRef: RefObject<HTMLDivElement | null>
  onClose: () => void
  content: ReactNode
}

const MobileSidebarPane = memo(function MobileSidebarPane({
  projectId,
  showRightSidebar,
  sidebarVisualRef,
  onClose,
  content,
}: MobileSidebarPaneProps) {
  if (!projectId) {
    return null
  }

  return (
    <div
      className={cn(
        "absolute inset-0 z-40 transition-opacity duration-300 ease-out",
        showRightSidebar ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
      )}
      aria-hidden={showRightSidebar ? undefined : true}
      data-mobile-right-sidebar-overlay
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/45 backdrop-blur-[1px]"
        aria-label="Close changes sidebar"
        onClick={onClose}
      />
      <div
        ref={sidebarVisualRef}
        className={cn(
          "absolute inset-y-0 right-0 flex w-[min(92vw,30rem)] max-w-full min-h-0 flex-col overflow-hidden border-l border-border bg-background shadow-2xl transition-transform duration-300 ease-out",
          "pt-[max(env(safe-area-inset-top),0px)] pb-[max(env(safe-area-inset-bottom),0px)]",
          showRightSidebar ? "translate-x-0" : "translate-x-full",
        )}
        data-right-sidebar-open={showRightSidebar ? "true" : "false"}
        data-right-sidebar-animated="false"
        data-right-sidebar-visual
      >
        {content}
      </div>
    </div>
  )
})

function ChatWorkspace({
  chatCard,
  projectId,
  shouldRenderTerminalLayout,
  showTerminalPane,
  terminalLayout,
  mainPanelGroupRef,
  terminalPanelRef,
  terminalVisualRef,
  fixedTerminalHeight,
  terminalFocusRequestVersion,
  addTerminal,
  socket,
  connectionStatus,
  scrollback,
  minColumnWidth,
  splitTerminalShortcut,
  pendingCommandsByTerminalId,
  onTerminalCommandSent,
  onInitialTerminalCommandSent,
  onRemoveTerminal,
  onTerminalLayout,
  onLayoutChanged,
}: ChatWorkspaceProps) {
  if (!shouldRenderTerminalLayout) {
    return <>{chatCard}</>
  }

  const terminalPanelDefaultSizes = getTerminalPanelDefaultSizes(showTerminalPane, terminalLayout.mainSizes)

  return (
    <ResizablePanelGroup
      key={projectId}
      groupRef={mainPanelGroupRef}
      orientation="vertical"
      className="flex-1 min-h-0"
      onLayoutChanged={onLayoutChanged}
    >
      <ResizablePanel id="chat" defaultSize={`${terminalPanelDefaultSizes[0]}%`} minSize="25%" className="min-h-0">
        {chatCard}
      </ResizablePanel>
      <ResizableHandle
        withHandle
        orientation="vertical"
        disabled={!showTerminalPane}
        className={cn(!showTerminalPane && "pointer-events-none opacity-0")}
      />
      <ResizablePanel
        id="terminal"
        defaultSize={`${terminalPanelDefaultSizes[1]}%`}
        minSize="0%"
        className="min-h-0"
        elementRef={terminalPanelRef}
      >
        <div
          ref={terminalVisualRef}
          className="h-full min-h-0 overflow-hidden relative"
          data-terminal-open={showTerminalPane ? "true" : "false"}
          data-terminal-animated="false"
          data-terminal-visual
          style={{
            "--terminal-toggle-duration": `${TERMINAL_TOGGLE_ANIMATION_DURATION_MS}ms`,
          } as CSSProperties}
        >
          <TerminalWorkspaceShell
            projectId={projectId}
            fixedTerminalHeight={fixedTerminalHeight}
            terminalLayout={terminalLayout}
            addTerminal={addTerminal}
            socket={socket}
            connectionStatus={connectionStatus}
            scrollback={scrollback}
            minColumnWidth={minColumnWidth}
            splitTerminalShortcut={splitTerminalShortcut}
            pendingCommandsByTerminalId={pendingCommandsByTerminalId}
            focusRequestVersion={terminalFocusRequestVersion}
            onTerminalCommandSent={onTerminalCommandSent}
            onInitialTerminalCommandSent={onInitialTerminalCommandSent}
            onRemoveTerminal={onRemoveTerminal}
            onTerminalLayout={onTerminalLayout}
          />
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}

export function ChatPage() {
  const state = useOutletContext<AppState>()
  const dialog = useAppDialog()
  const conditionPolicy = useConditionPolicy()
  const layoutRootRef = useRef<HTMLDivElement>(null)
  const transcriptListRef = useRef<LegendListRef | null>(null)
  const isAtEndRef = useRef(true)
  const showScrollTimeoutRef = useRef<number | null>(null)
  const chatCardRef = useRef<HTMLDivElement>(null)
  const chatInputElementRef = useRef<HTMLTextAreaElement>(null)
  const chatInputRef = useRef<ChatInputHandle | null>(null)
  const { inputRef, syncInputHeight, transcriptPaddingBottom } = useTranscriptPaddingBottom()
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const [pendingTerminalCommands, setPendingTerminalCommands] = useState<Record<string, string>>({})
  const showEmptyState = state.messages.length === 0 && state.runtime?.title === "New Chat"

  // Redesign 2026-08-07 §3: after an early stop (Stop pressed — the latest
  // turn ends on an interrupted entry with no newer turn flow), a red strip
  // above the composer invites the correction. Dismissible; auto-clears on
  // the next turn because the interrupted entry stops being the latest.
  const lastInterruptedId = useMemo(() => {
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const m = state.messages[i]!
      if (m.kind === "user_prompt" || m.kind === "assistant_text" || m.kind === "result") return null
      if (m.kind === "interrupted" && !m.hidden) return m.id
    }
    return null
  }, [state.messages])
  const [dismissedStopBannerId, setDismissedStopBannerId] = useState<string | null>(null)
  const showStopBanner = lastInterruptedId !== null && dismissedStopBannerId !== lastInterruptedId
  const handleDismissStopBanner = useCallback(() => {
    setDismissedStopBannerId(lastInterruptedId)
  }, [lastInterruptedId])

  // The engine reports its slash commands/skills in system_init — the newest
  // one wins (models/settings can change between session boots). Powers the
  // composer's "/" autocomplete; a fresh chat falls back to the per-provider
  // cache inside ChatInput until its first turn boots.
  const rememberSlashCommands = useSlashCommandsStore((s) => s.remember)
  const availableSlashCommands = useMemo(() => {
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const message = state.messages[i]
      if (message.kind === "system_init" && message.slashCommands.length) return message.slashCommands
    }
    return []
  }, [state.messages])
  useEffect(() => {
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const message = state.messages[i]
      if (message.kind === "system_init" && message.slashCommands.length) {
        rememberSlashCommands(message.provider, message.slashCommands)
        return
      }
    }
  }, [state.messages, rememberSlashCommands])
  const projectId = state.activeProjectId
  const projectTerminalLayout = useTerminalLayoutStore((store) => (projectId ? store.projects[projectId] : undefined))
  const terminalLayout = projectTerminalLayout ?? DEFAULT_PROJECT_TERMINAL_LAYOUT
  const projectRightSidebarVisibility = useRightSidebarStore((store) => (projectId ? store.projects[projectId] : undefined))
  const rightSidebarVisibility = projectRightSidebarVisibility ?? DEFAULT_RIGHT_SIDEBAR_VISIBILITY_STATE
  const globalRightSidebarSize = useRightSidebarStore((store) => store.size)
  const addTerminal = useTerminalLayoutStore((store) => store.addTerminal)
  const removeTerminal = useTerminalLayoutStore((store) => store.removeTerminal)
  const toggleVisibility = useTerminalLayoutStore((store) => store.toggleVisibility)
  const resetMainSizes = useTerminalLayoutStore((store) => store.resetMainSizes)
  const setMainSizes = useTerminalLayoutStore((store) => store.setMainSizes)
  const setTerminalSizes = useTerminalLayoutStore((store) => store.setTerminalSizes)
  const toggleRightPanel = useRightSidebarStore((store) => store.togglePanel)
  const hideRightPanel = useRightSidebarStore((store) => store.hidePanel)
  const setRightSidebarSize = useRightSidebarStore((store) => store.setSize)
  const scrollback = useTerminalPreferencesStore((store) => store.scrollbackLines)
  const minColumnWidth = useTerminalPreferencesStore((store) => store.minColumnWidth)
  const editorPreset = useTerminalPreferencesStore((store) => store.editorPreset)
  const editorCommandTemplate = useTerminalPreferencesStore((store) => store.editorCommandTemplate)
  const resolvedKeybindings = useMemo(() => getResolvedKeybindings(state.keybindings), [state.keybindings])
  const baseContextWindowSnapshotRef = useRef<ReturnType<typeof deriveLatestContextWindowSnapshot>>(null)
  const contextWindowSnapshot = useMemo(() => {
    const derivedSnapshot = deriveLatestContextWindowSnapshot(state.chatSnapshot?.messages ?? [])
    const previousSnapshot = baseContextWindowSnapshotRef.current
    if (sameContextWindowSnapshot(previousSnapshot, derivedSnapshot)) {
      return previousSnapshot
    }
    baseContextWindowSnapshotRef.current = derivedSnapshot
    return derivedSnapshot
  }, [state.chatSnapshot?.messages])

  const hasTerminals = terminalLayout.terminals.length > 0
  const showTerminalPane = Boolean(projectId && terminalLayout.isVisible && hasTerminals)
  const shouldRenderTerminalLayout = Boolean(projectId && hasTerminals)
  const activeRightPanel = projectId ? rightSidebarVisibility.rightPanel : "hidden"
  const showRightSidebar = Boolean(projectId && activeRightPanel !== "hidden")
  const showGitPanel = Boolean(projectId && activeRightPanel === "git")
  const shouldRenderRightSidebarLayout = Boolean(projectId)
  const isMobileRightSidebarOverlay = useMobileRightSidebarOverlayEnabled()
  const shouldRenderDesktopRightSidebarLayout = shouldRenderRightSidebarLayout && !isMobileRightSidebarOverlay
  const layoutWidth = useLayoutWidth(layoutRootRef)
  const effectiveRightSidebarSize = getRightSidebarSizePercent(
    globalRightSidebarSize ?? DEFAULT_RIGHT_SIDEBAR_SIZE,
    layoutWidth,
  )
  const fixedTerminalHeight = useFixedTerminalHeight({
    layoutRootRef,
    shouldRenderTerminalLayout,
    terminalMainSizes: terminalLayout.mainSizes,
  })

  const {
    isAnimating: isTerminalAnimating,
    mainPanelGroupRef,
    terminalFocusRequestVersion,
    terminalPanelRef,
    terminalVisualRef,
  } = useTerminalToggleAnimation({
    showTerminalPane,
    shouldRenderTerminalLayout,
    projectId,
    terminalLayout,
    chatInputRef: chatInputElementRef,
  })
  const {
    isAnimating: isRightSidebarAnimating,
    panelGroupRef: rightSidebarPanelGroupRef,
    sidebarPanelRef,
    sidebarVisualRef,
  } = useRightSidebarToggleAnimation({
    projectId,
    shouldRenderRightSidebarLayout: shouldRenderDesktopRightSidebarLayout,
    showRightSidebar,
    rightSidebarSizePercent: effectiveRightSidebarSize,
  })

  const {
    diffRenderMode,
    wrapDiffLines,
    setDiffRenderMode,
    setWrapDiffLines,
    scheduleTerminalDiffRefresh,
    handleCopyDiffFilePath,
    handleCopyDiffRelativePath,
    handleLoadDiffPatch,
    handleDiscardDiffFile,
    handleIgnoreDiffFile,
    handleIgnoreDiffFolder,
    handleOpenDiffInFinder,
    handleCommitDiffs,
    handleSyncBranch,
    handleGenerateCommitMessage,
    handleInitializeGit,
    handleListBranches,
    handleCheckoutBranch,
    handlePreviewMergeBranch,
    handleMergeBranch,
    handleCreateBranch,
  } = useChatPageSidebarActions({
    state,
    projectId,
    showRightSidebar: showGitPanel,
  })

  const { typedEmptyStateText, isEmptyStateTypingComplete } = useEmptyStateTyping(showEmptyState, state.activeChatId)

  useStickyChatFocus({
    rootRef: chatCardRef,
    fallbackRef: chatInputElementRef,
    enabled: state.hasSelectedProject,
    canCancel: state.canCancel,
  })

  const enqueueDroppedFiles = useCallback((files: File[]) => {
    if (!state.hasSelectedProject || files.length === 0) {
      return
    }
    chatInputRef.current?.enqueueFiles(files)
  }, [state.hasSelectedProject])

  // Dismissing a preview gate cancels the whole turn — the typed message must
  // not be the casualty: it goes back into the (empty) composer.
  const messagesRef = useRef(state.messages)
  messagesRef.current = state.messages
  const handleMemoryPreviewRespondWithRestore = useCallback<AppState["handleMemoryPreviewRespond"]>(
    async (previewId, decision, memoryIds, expectedUses) => {
      await state.handleMemoryPreviewRespond(previewId, decision, memoryIds, expectedUses)
      if (decision !== "dismiss") return
      const messages = messagesRef.current
      const gateIndex = messages.findIndex((m) => m.kind === "memory_preview" && m.previewId === previewId)
      for (let i = (gateIndex === -1 ? messages.length : gateIndex) - 1; i >= 0; i--) {
        const m = messages[i]
        if (m.kind === "user_prompt") {
          chatInputRef.current?.restoreText(m.content)
          break
        }
      }
    },
    [state.handleMemoryPreviewRespond],
  )

  const {
    isPageFileDragActive,
    handleTranscriptDragEnter,
    handleTranscriptDragOver,
    handleTranscriptDragLeave,
    handleTranscriptDrop,
  } = usePageFileDrop({
    hasSelectedProject: state.hasSelectedProject,
    onFilesDropped: enqueueDroppedFiles,
  })

  const handleToggleEmbeddedTerminal = useCallback(() => {
    if (!projectId) return
    if (hasTerminals) {
      toggleVisibility(projectId)
      return
    }

    addTerminal(projectId)
  }, [addTerminal, hasTerminals, projectId, toggleVisibility])

  const handleTerminalResize = useCallback((layout: Record<string, number>) => {
    if (!projectId || !showTerminalPane || isTerminalAnimating.current) {
      return
    }

    const chatSize = layout.chat
    const terminalSize = layout.terminal
    if (!Number.isFinite(chatSize) || !Number.isFinite(terminalSize)) {
      return
    }

    const containerHeight = layoutRootRef.current?.getBoundingClientRect().height ?? 0
    if (shouldCloseTerminalPane(containerHeight, terminalSize)) {
      resetMainSizes(projectId)
      toggleVisibility(projectId)
      return
    }

    setMainSizes(projectId, [chatSize, terminalSize])
  }, [isTerminalAnimating, projectId, resetMainSizes, setMainSizes, showTerminalPane, toggleVisibility])

  const handleCloseRightSidebar = useCallback(() => {
    if (!projectId) return
    hideRightPanel(projectId)
  }, [hideRightPanel, projectId])

  const handleToggleGitPanel = useCallback(() => {
    if (!projectId) return

    if (activeRightPanel === "git") {
      hideRightPanel(projectId)
      return
    }

    if (state.chatDiffSnapshot?.status === "no_repo") {
      void (async () => {
        const confirmed = await dialog.confirm({
          title: "Initialize Git?",
          description: "Initialize a local git repository in this project?",
          confirmLabel: "Init Git",
          cancelLabel: "Cancel",
        })
        if (!confirmed) return

        const result = await handleInitializeGit()
        if (result?.ok) {
          toggleRightPanel(projectId, "git")
        }
      })()
      return
    }

    toggleRightPanel(projectId, "git")
  }, [activeRightPanel, dialog, handleInitializeGit, hideRightPanel, projectId, state.chatDiffSnapshot?.status, toggleRightPanel])

  const handleToggleBrowserPanel = useCallback(() => {
    if (!projectId) return
    toggleRightPanel(projectId, "browser")
  }, [projectId, toggleRightPanel])

  const handleToggleMemoryPanel = useCallback(() => {
    if (!projectId) return
    toggleRightPanel(projectId, "memory")
  }, [projectId, toggleRightPanel])

  const handleToggleFilesPanel = useCallback(() => {
    if (!projectId) return
    toggleRightPanel(projectId, "files")
  }, [projectId, toggleRightPanel])

  // The session-memories panel shows PER-CHAT state (pins); leaving it open
  // across a chat switch shows the previous chat's "bringing everything"
  // against a new chat still at the bring-in gate (QA BUG-003). Close it on
  // chat change; the user reopens it in the context they mean.
  const memoryPanelChatIdRef = useRef(state.activeChatId)
  useEffect(() => {
    if (memoryPanelChatIdRef.current === state.activeChatId) return
    memoryPanelChatIdRef.current = state.activeChatId
    if (projectId && activeRightPanel === "memory") {
      toggleRightPanel(projectId, "memory")
    }
  }, [state.activeChatId, activeRightPanel, projectId, toggleRightPanel])

  const handleRunQuickAction = useCallback((command: string) => {
    if (!projectId) return
    const terminalId = addTerminal(projectId)
    setPendingTerminalCommands((current) => ({
      ...current,
      [terminalId]: command,
    }))
  }, [addTerminal, projectId])

  const handleInitialTerminalCommandSent = useCallback((terminalId: string) => {
    setPendingTerminalCommands((current) => {
      if (!(terminalId in current)) return current
      const { [terminalId]: _sent, ...rest } = current
      return rest
    })
  }, [])

  const handleCancel = useCallback(() => {
    void state.handleCancel()
  }, [state.handleCancel])

  const handleRemoveTerminal = useCallback((currentProjectId: string, terminalId: string) => {
    void state.socket.command({ type: "terminal.close", terminalId }).catch(() => {})
    removeTerminal(currentProjectId, terminalId)
  }, [removeTerminal, state.socket])

  const clearShowScrollTimeout = useCallback(() => {
    if (showScrollTimeoutRef.current !== null) {
      window.clearTimeout(showScrollTimeoutRef.current)
      showScrollTimeoutRef.current = null
    }
  }, [])

  const onIsAtEndChange = useCallback((isAtEnd: boolean) => {
    if (isAtEndRef.current === isAtEnd) return
    isAtEndRef.current = isAtEnd
    if (isAtEnd) {
      clearShowScrollTimeout()
      setShowScrollToBottom(false)
      return
    }

    clearShowScrollTimeout()
    showScrollTimeoutRef.current = window.setTimeout(() => {
      setShowScrollToBottom(true)
      showScrollTimeoutRef.current = null
    }, 150)
  }, [clearShowScrollTimeout])

  const syncIsAtEndFromList = useCallback(() => {
    const state = transcriptListRef.current?.getState?.()
    if (state) {
      onIsAtEndChange(state.isAtEnd)
    }
  }, [onIsAtEndChange])

  const scrollToTranscriptEnd = useCallback(async (animated = true) => {
    isAtEndRef.current = true
    clearShowScrollTimeout()
    setShowScrollToBottom(false)
    await transcriptListRef.current?.scrollToEnd?.({ animated })
  }, [clearShowScrollTimeout])

  const handleChatSubmit = useCallback(async (
    content: string,
    options?: Parameters<typeof state.handleSend>[1],
  ) => {
    // Opening-Board flow (2026-08-19 E1): the first prompt of an unreviewed
    // study task is captured; the Board modal runs, then the prompt continues
    // on its own. Everything else passes straight through.
    await submitStudyPrompt({
      content,
      attachments: options?.attachments,
      dispatchOptions: {
        provider: options?.provider,
        model: options?.model,
        modelOptions: options?.modelOptions,
        planMode: options?.planMode,
      },
      dispatch: async (openingReviewId) => {
        await scrollToTranscriptEnd(false)
        await state.handleSend(content, { ...options, openingReviewId })
      },
    })
  }, [scrollToTranscriptEnd, state])

  useEffect(() => {
    return () => clearShowScrollTimeout()
  }, [clearShowScrollTimeout])

  useEffect(() => {
    isAtEndRef.current = true
    clearShowScrollTimeout()
    setShowScrollToBottom(false)
  }, [clearShowScrollTimeout, state.activeChatId])

  useEffect(() => {
    function handleGlobalKeydown(event: KeyboardEvent) {
      if (!projectId) return
      if (actionMatchesEvent(resolvedKeybindings, "toggleEmbeddedTerminal", event)) {
        event.preventDefault()
        handleToggleEmbeddedTerminal()
        return
      }

      if (actionMatchesEvent(resolvedKeybindings, "toggleRightSidebar", event)) {
        event.preventDefault()
        handleToggleGitPanel()
        return
      }

      if (actionMatchesEvent(resolvedKeybindings, "openInFinder", event)) {
        event.preventDefault()
        void state.handleOpenExternal("open_finder")
        return
      }

      if (actionMatchesEvent(resolvedKeybindings, "addSplitTerminal", event)) {
        event.preventDefault()
        addTerminal(projectId)
      }
    }

    window.addEventListener("keydown", handleGlobalKeydown)
    return () => window.removeEventListener("keydown", handleGlobalKeydown)
  }, [addTerminal, handleToggleEmbeddedTerminal, handleToggleGitPanel, projectId, resolvedKeybindings, state.handleOpenExternal])

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      syncIsAtEndFromList()
    })
    const timeoutId = window.setTimeout(() => {
      syncIsAtEndFromList()
    }, TERMINAL_TOGGLE_ANIMATION_DURATION_MS)

    return () => {
      window.cancelAnimationFrame(frameId)
      window.clearTimeout(timeoutId)
    }
  }, [shouldRenderTerminalLayout, showTerminalPane, syncIsAtEndFromList])

  useEffect(() => {
    function handleResize() {
      syncIsAtEndFromList()
    }

    window.addEventListener("resize", handleResize)
    return () => window.removeEventListener("resize", handleResize)
  }, [syncIsAtEndFromList])

  useEffect(() => {
    if (!showRightSidebar || !isMobileRightSidebarOverlay) return

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [isMobileRightSidebarOverlay, showRightSidebar])

  useEffect(() => {
    if (!showRightSidebar || !isMobileRightSidebarOverlay) return

    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return
      event.preventDefault()
      handleCloseRightSidebar()
    }

    window.addEventListener("keydown", handleEscape)
    return () => window.removeEventListener("keydown", handleEscape)
  }, [handleCloseRightSidebar, isMobileRightSidebarOverlay, showRightSidebar])

  useEffect(() => {
    if (!isAtEndRef.current) {
      return
    }

    let secondFrame: number | null = null
    const firstFrame = window.requestAnimationFrame(() => {
      void transcriptListRef.current?.scrollToEnd?.({ animated: false })
      secondFrame = window.requestAnimationFrame(() => {
        void transcriptListRef.current?.scrollToEnd?.({ animated: false })
      })
    })

    return () => {
      window.cancelAnimationFrame(firstFrame)
      if (secondFrame !== null) {
        window.cancelAnimationFrame(secondFrame)
      }
    }
  }, [
    state.commandError,
    state.isDraining,
    state.isProcessing,
    state.messages.length,
    state.queuedMessages.length,
    state.runtimeStatus,
  ])

  useLayoutEffect(() => {
    if (!showRightSidebar || isMobileRightSidebarOverlay || layoutWidth <= 0 || isRightSidebarAnimating.current) {
      return
    }

    const clampedRightSidebarSize = getRightSidebarSizePercent(globalRightSidebarSize, layoutWidth)
    const currentLayout = rightSidebarPanelGroupRef.current?.getLayout()
    if (!currentLayout) return
    if (Math.abs((currentLayout.rightSidebar ?? 0) - clampedRightSidebarSize) < 0.1) {
      return
    }

    rightSidebarPanelGroupRef.current?.setLayout({
      workspace: 100 - clampedRightSidebarSize,
      rightSidebar: clampedRightSidebarSize,
    })
  }, [
    globalRightSidebarSize,
    isRightSidebarAnimating,
    layoutWidth,
    rightSidebarPanelGroupRef,
    showRightSidebar,
    isMobileRightSidebarOverlay,
  ])

  const chatCard = (
    <Card
      ref={chatCardRef}
      className="bg-background h-full flex flex-col overflow-hidden border-0 rounded-none relative"
      onDragEnter={handleTranscriptDragEnter}
      onDragOver={handleTranscriptDragOver}
      onDragLeave={handleTranscriptDragLeave}
      onDrop={handleTranscriptDrop}
    >
      <CardContent className="flex flex-1 min-h-0 flex-col overflow-hidden p-0 relative">
        <ChatNavbar
          sidebarCollapsed={state.sidebarCollapsed}
          onOpenSidebar={state.openSidebar}
          onExpandSidebar={state.expandSidebar}
          onNewChat={state.handleCompose}
          memoryChatId={state.activeChatId ?? undefined}
          memoryProjectId={projectId ?? undefined}
          localPath={state.navbarLocalPath}
          embeddedTerminalVisible={showTerminalPane}
          onToggleEmbeddedTerminal={projectId ? handleToggleEmbeddedTerminal : undefined}
          rightPanel={activeRightPanel}
          onToggleGitPanel={projectId ? handleToggleGitPanel : undefined}
          onToggleBrowserPanel={projectId ? handleToggleBrowserPanel : undefined}
          onToggleMemoryPanel={projectId ? handleToggleMemoryPanel : undefined}
          onToggleFilesPanel={projectId ? handleToggleFilesPanel : undefined}
          terminalShortcut={resolvedKeybindings.bindings.toggleEmbeddedTerminal}
          rightSidebarShortcut={resolvedKeybindings.bindings.toggleRightSidebar}
          branchName={state.chatDiffSnapshot?.branchName}
          hasGitRepo={state.chatDiffSnapshot?.status !== "no_repo"}
          gitStatus={state.chatDiffSnapshot?.status}
        />
        <ChatTranscriptViewport
          activeChatId={state.activeChatId}
          projectId={projectId}
          listRef={transcriptListRef}
          messages={state.messages}
          queuedMessages={state.queuedMessages}
          transcriptPaddingBottom={transcriptPaddingBottom}
          localPath={state.runtime?.localPath}
          latestToolIds={state.latestToolIds}
          isHistoryLoading={state.isHistoryLoading}
          hasOlderHistory={state.hasOlderHistory}
          isProcessing={state.isProcessing}
          canCancel={state.canCancel}
          runtimeStatus={state.runtimeStatus}
          streamingText={state.runtime?.streamingText ?? null}
          isDraining={state.isDraining}
          commandError={state.commandError}
          loadOlderHistory={state.loadOlderHistory}
          onStopDraining={state.handleStopDraining}
          onSteerQueuedMessage={state.handleSteerQueuedMessage}
          onRemoveQueuedMessage={state.handleRemoveQueuedMessage}
          onOpenLocalLink={state.handleOpenLocalLink}
          editorPreset={editorPreset}
          editorCommandTemplate={editorCommandTemplate}
          platform={state.localProjects?.machine.platform}
          onAskUserQuestionSubmit={state.handleAskUserQuestion}
          onExitPlanModeConfirm={state.handleExitPlanMode}
          onMemoryPreviewRespond={handleMemoryPreviewRespondWithRestore}
          onMemoryProposalsRespond={state.handleMemoryProposalsRespond}
          onMemoryCheckupRespond={state.handleMemoryCheckupRespond}
          onMemoryTransferRespond={state.handleMemoryTransferRespond}
          onMemoryPreparationReopen={state.handleMemoryPreparationReopen}
          showScrollButton={showScrollToBottom && state.messages.length > 0}
          onIsAtEndChange={onIsAtEndChange}
          scrollToBottom={() => scrollToTranscriptEnd(true)}
          typedEmptyStateText={typedEmptyStateText}
          isEmptyStateTypingComplete={isEmptyStateTypingComplete}
          isPageFileDragActive={isPageFileDragActive}
          showEmptyState={showEmptyState}
        />
      </CardContent>

      <ChatInputDock
        inputRef={inputRef}
        onLayoutChange={syncInputHeight}
        chatInputRef={chatInputRef}
        chatInputElementRef={chatInputElementRef}
        activeChatId={state.activeChatId}
        previousPrompt={state.previousPrompt}
        hasSelectedProject={state.hasSelectedProject}
        runtimeStatus={state.runtimeStatus}
        canCancel={state.canCancel}
        projectId={projectId}
        activeProvider={state.runtime?.provider ?? null}
        availableProviders={state.availableProviders}
        contextWindowSnapshot={contextWindowSnapshot}
        slashCommands={availableSlashCommands}
        onSubmit={handleChatSubmit}
        onCancel={handleCancel}
        showStopBanner={showStopBanner}
        onDismissStopBanner={handleDismissStopBanner}
      />
    </Card>
  )

  const workspace = projectId ? (
    <ChatWorkspace
      chatCard={chatCard}
      projectId={projectId}
      shouldRenderTerminalLayout={shouldRenderTerminalLayout}
      showTerminalPane={showTerminalPane}
      terminalLayout={terminalLayout}
      mainPanelGroupRef={mainPanelGroupRef}
      terminalPanelRef={terminalPanelRef}
      terminalVisualRef={terminalVisualRef}
      fixedTerminalHeight={fixedTerminalHeight}
      terminalFocusRequestVersion={terminalFocusRequestVersion}
      addTerminal={addTerminal}
      socket={state.socket}
      connectionStatus={state.connectionStatus}
      scrollback={scrollback}
      minColumnWidth={minColumnWidth}
      splitTerminalShortcut={resolvedKeybindings.bindings.addSplitTerminal}
      pendingCommandsByTerminalId={pendingTerminalCommands}
      onTerminalCommandSent={scheduleTerminalDiffRefresh}
      onInitialTerminalCommandSent={handleInitialTerminalCommandSent}
      onRemoveTerminal={handleRemoveTerminal}
      onTerminalLayout={setTerminalSizes}
      onLayoutChanged={handleTerminalResize}
    />
  ) : (
    chatCard
  )

  const gitPanelContentProps = useMemo<ComponentProps<typeof ChatSidebarContent> | null>(() => {
    if (!projectId) {
      return null
    }

    return {
      projectId,
      diffs: state.chatDiffSnapshot ?? EMPTY_DIFF_SNAPSHOT,
      diffRenderMode,
      wrapLines: wrapDiffLines,
      onOpenInFinder: handleOpenDiffInFinder,
      onDiscardFile: handleDiscardDiffFile,
      onIgnoreFile: handleIgnoreDiffFile,
      onIgnoreFolder: handleIgnoreDiffFolder,
      onCopyFilePath: handleCopyDiffFilePath,
      onCopyRelativePath: handleCopyDiffRelativePath,
      onLoadPatch: handleLoadDiffPatch,
      onListBranches: handleListBranches,
      onPreviewMergeBranch: handlePreviewMergeBranch,
      onMergeBranch: handleMergeBranch,
      onCheckoutBranch: handleCheckoutBranch,
      onCreateBranch: handleCreateBranch,
      onGenerateCommitMessage: handleGenerateCommitMessage,
      onInitializeGit: handleInitializeGit,
      onCommit: handleCommitDiffs,
      onSyncWithRemote: handleSyncBranch,
      onDiffRenderModeChange: setDiffRenderMode,
      onWrapLinesChange: setWrapDiffLines,
      onClose: handleCloseRightSidebar,
    }
  }, [
    diffRenderMode,
    handleCheckoutBranch,
    handleCloseRightSidebar,
    handleCommitDiffs,
    handleCopyDiffFilePath,
    handleCopyDiffRelativePath,
    handleCreateBranch,
    handleDiscardDiffFile,
    handleGenerateCommitMessage,
    handleIgnoreDiffFile,
    handleIgnoreDiffFolder,
    handleInitializeGit,
    handleListBranches,
    handleLoadDiffPatch,
    handleMergeBranch,
    handleOpenDiffInFinder,
    handlePreviewMergeBranch,
    handleSyncBranch,
    projectId,
    setDiffRenderMode,
    setWrapDiffLines,
    state.chatDiffSnapshot,
    wrapDiffLines,
  ])
  // The "memory" slot is condition-aware (the study arms differ exactly in
  // their memory surface): memosync = per-item session panel; auto = the
  // living summary (B1); static = the shared MEMORY.md document (B2).
  const memoryPanelContent =
    projectId && state.activeChatId
      ? conditionPolicy.condition === "auto"
        ? <MemorySummaryPanel chatId={state.activeChatId} projectId={projectId} exposureInitiator={rightSidebarVisibility.openInitiator} onClose={handleCloseRightSidebar} />
        : conditionPolicy.condition === "static"
          ? <StaticMemoryPanel chatId={state.activeChatId} projectId={projectId} exposureInitiator={rightSidebarVisibility.openInitiator} onClose={handleCloseRightSidebar} />
          : <SessionMemoriesPanel
              chatId={state.activeChatId}
              projectId={projectId}
              messages={state.memoryRecordMessages}
              streamingText={state.runtime?.streamingText ?? null}
              isTurnActive={state.canCancel}
              exposureInitiator={rightSidebarVisibility.openInitiator}
              onClose={handleCloseRightSidebar}
            />
      : null
  const rightPanelContent = activeRightPanel === "browser" && projectId
    ? <BrowserPanel key={projectId} projectId={projectId} socket={state.socket} onClose={handleCloseRightSidebar} onRunQuickAction={handleRunQuickAction} />
    : activeRightPanel === "memory" && projectId && state.activeChatId
      ? memoryPanelContent
      : activeRightPanel === "files" && projectId
        ? <FilesPanel key={projectId} projectId={projectId} chatId={state.activeChatId ?? undefined} onClose={handleCloseRightSidebar} />
        : gitPanelContentProps
          ? <ChatSidebarContent {...gitPanelContentProps} />
          : null

  // Per-memory interrupt plumbing (2026-08-19 C1/C2): every citation chip
  // under this provider (reply text + sidebar live row) carries a stop entry
  // while the turn is cancellable, and the recovery card resumes through it.
  const turnInterruptApi = useMemo<TurnInterruptApi | null>(() => {
    const chatId = state.activeChatId
    if (!chatId) return null
    return {
      active: state.canCancel,
      interrupt: (memoryId: string, quote?: string) => {
        void state.socket.command({ type: "chat.interruptMemory", chatId, memoryId, quote }).catch(() => {})
      },
      resume: async (args) => {
        const correction = args.correction?.trim()
        if (!correction) throw new Error("A correction is required to resume")
        await state.socket.command({
          type: "chat.resumeInterrupted",
          chatId,
          interruptId: args.interruptId,
          correction,
          selectedIds: args.selectedIds,
          enforce: args.enforce,
        })
      },
    }
  }, [state.activeChatId, state.canCancel, state.socket])

  return (
    <TurnInterruptContext.Provider value={turnInterruptApi}>
    <div ref={layoutRootRef} className="flex-1 flex flex-col min-w-0 relative">
      {shouldRenderDesktopRightSidebarLayout && projectId ? (
        <ResizablePanelGroup
          key={`${projectId}-right-sidebar`}
          groupRef={rightSidebarPanelGroupRef}
          orientation="horizontal"
          className="flex-1 min-h-0"
          onLayoutChange={(layout) => {
            if (!showRightSidebar || isRightSidebarAnimating.current) {
              return
            }

            const clampedRightSidebarSize = getRightSidebarSizePercent(
              getRightSidebarSizePx(layout.rightSidebar, layoutWidth),
              layoutWidth,
            )
            if (Math.abs(clampedRightSidebarSize - layout.rightSidebar) < 0.1) {
              return
            }

            rightSidebarPanelGroupRef.current?.setLayout({
              workspace: 100 - clampedRightSidebarSize,
              rightSidebar: clampedRightSidebarSize,
            })
          }}
          onLayoutChanged={(layout) => {
            // Ignore the callback the panel group fires on MOUNT, before the
            // layout width has been measured (layoutWidth still 0). At that
            // point getRightSidebarSizePx falls back to the hardcoded default,
            // so persisting it overwrote the user's saved width on every refresh
            // (BUG PANEL-1). Genuine drags happen after the width is measured.
            if (!showRightSidebar || isRightSidebarAnimating.current || layoutWidth <= 0) {
              return
            }

            setRightSidebarSize(getRightSidebarSizePx(layout.rightSidebar, layoutWidth))
          }}
        >
          <ResizablePanel
            id="workspace"
            defaultSize={`${100 - effectiveRightSidebarSize}%`}
            minSize="20%"
            className="min-h-0 min-w-0"
            groupResizeBehavior="preserve-relative-size"
          >
            {workspace}
          </ResizablePanel>
          <ResizableHandle
            withHandle={false}
            orientation="horizontal"
            disabled={!showRightSidebar}
            className={cn(!showRightSidebar && "pointer-events-none opacity-0")}
          />
          <DesktopSidebarPane
            showRightSidebar={showRightSidebar}
            sizePercent={effectiveRightSidebarSize}
            sidebarPanelRef={sidebarPanelRef}
            sidebarVisualRef={sidebarVisualRef}
            content={rightPanelContent}
          />
        </ResizablePanelGroup>
      ) : (
        workspace
      )}
      {isMobileRightSidebarOverlay ? (
        <MobileSidebarPane
          projectId={projectId}
          showRightSidebar={showRightSidebar}
          sidebarVisualRef={sidebarVisualRef}
          onClose={handleCloseRightSidebar}
          content={rightPanelContent}
        />
      ) : null}
    </div>
    </TurnInterruptContext.Provider>
  )
}
