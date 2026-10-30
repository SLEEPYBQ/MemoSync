import { chatTitle } from "../i18n/uiText"
import { t, useI18n } from "../i18n"
import { BrainCircuit, Loader2, Menu, PanelLeft, Plus, Settings, X } from "lucide-react"
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import type { KeybindingsSnapshot, SidebarChatRow, SidebarData, UpdateSnapshot } from "../../shared/types"
import { BrandIcon, useBrandName } from "../components/BrandMark"
import { ChatRow } from "../components/chat-ui/sidebar/ChatRow"
import { LocalProjectsSection } from "../components/chat-ui/sidebar/LocalProjectsSection"
import { MemoryOffBadge } from "../components/memory/MemorySettingsBanner"
import { Button } from "../components/ui/button"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog"
import { HotkeyTooltip, HotkeyTooltipContent, HotkeyTooltipTrigger } from "../components/ui/tooltip"
import { getLastBoardVisit } from "../lib/boardVisit"
import { formatSidebarAgeLabel } from "../lib/formatters"
import { actionMatchesEvent, getResolvedKeybindings } from "../lib/keybindings"
import { memoriesApi } from "../lib/memoriesApi"
import { getSidebarChatTimestamp } from "../lib/sidebarChats"
import { cn } from "../lib/utils"
import { SIDEBAR_ROW_ACTIVE_CLASS, SIDEBAR_ROW_CLASS } from "../components/chat-ui/sidebar/rowStyles"
import {
  getSidebarJumpTargetIndex,
  getSidebarNumberJumpHint,
  getVisibleSidebarChats,
  isSidebarModifierShortcut,
  shouldShowSidebarNumberJumpHints,
} from "./sidebarNumberJump"
import type { SocketStatus } from "./socket"

const SIDEBAR_WIDTH_STORAGE_KEY = "memosync:sidebar-width"
export const DEFAULT_SIDEBAR_WIDTH = 275
export const MIN_SIDEBAR_WIDTH = 220
export const MAX_SIDEBAR_WIDTH = 520

export function clampSidebarWidth(width: number) {
  if (!Number.isFinite(width)) return DEFAULT_SIDEBAR_WIDTH
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)))
}

function readStoredSidebarWidth() {
  if (typeof window === "undefined") return DEFAULT_SIDEBAR_WIDTH
  const stored = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)
  return stored ? clampSidebarWidth(Number(stored)) : DEFAULT_SIDEBAR_WIDTH
}

function persistSidebarWidth(width: number) {
  if (typeof window === "undefined") return
  window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clampSidebarWidth(width)))
}

interface AppSidebarProps {
  data: SidebarData
  activeChatId: string | null
  connectionStatus: SocketStatus
  ready: boolean
  open: boolean
  collapsed: boolean
  showMobileOpenButton: boolean
  onOpen: () => void
  onClose: () => void
  onCollapse: () => void
  onExpand: () => void
  onCreateChat: (projectId: string) => void
  onForkChat: (chat: SidebarChatRow) => void
  currentProjectId: string | null
  keybindings: KeybindingsSnapshot | null
  onRenameChat: (chat: SidebarChatRow) => void
  onShareChat: (chatId: string) => void
  onArchiveChat: (chat: SidebarChatRow) => void
  onOpenArchivedChat: (chatId: string) => void
  onDeleteChat: (chat: SidebarChatRow) => void
  onOpenAddProjectModal: () => void
  onCopyPath: (localPath: string) => void
  onOpenExternalPath: (action: "open_finder", localPath: string) => void
  onRenameProject: (projectId: string, sidebarTitle: string | undefined, realTitle: string) => void
  onHideProject: (projectId: string) => void
  onReorderProjectGroups: (projectIds: string[]) => void
  updateSnapshot: UpdateSnapshot | null
  onOpenChangelog: () => void
  onOpenMemoryBoard: () => void
}

function AppSidebarImpl({
  data,
  activeChatId,
  connectionStatus,
  ready,
  open,
  collapsed,
  showMobileOpenButton,
  onOpen,
  onClose,
  onCollapse,
  onExpand,
  onCreateChat,
  onForkChat,
  currentProjectId,
  keybindings,
  onRenameChat,
  onShareChat,
  onArchiveChat,
  onOpenArchivedChat,
  onDeleteChat,
  onOpenAddProjectModal,
  onCopyPath,
  onOpenExternalPath,
  onRenameProject,
  onHideProject,
  onReorderProjectGroups,
  updateSnapshot,
  onOpenChangelog,
  onOpenMemoryBoard,
}: AppSidebarProps) {
  useI18n()
  const location = useLocation()
  const navigate = useNavigate()
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const resizeStartRef = useRef<{ pointerX: number; width: number } | null>(null)
  const initializedCollapsedGroupKeysRef = useRef<Set<string>>(new Set())
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set())
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [showNumberJumpHints, setShowNumberJumpHints] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(readStoredSidebarWidth)
  const [isResizingSidebar, setIsResizingSidebar] = useState(false)
  // Collapsed on desktop: resting the pointer on the left edge slides the
  // sidebar out over the page; leaving it slides it back.
  const [peeking, setPeeking] = useState(false)
  const peekTimerRef = useRef<number | null>(null)
  const [archivedProjectId, setArchivedProjectId] = useState<string | null>(null)
  const resolvedKeybindings = useMemo(() => getResolvedKeybindings(keybindings), [keybindings])
  const visibleChats = useMemo(
    () => getVisibleSidebarChats(data.projectGroups, collapsedSections, expandedGroups),
    [collapsedSections, data.projectGroups, expandedGroups]
  )
  const visibleChatsRef = useRef(visibleChats)
  const visibleIndexByChatId = useMemo(
    () => new Map(visibleChats.map((entry) => [entry.chat.chatId, entry.visibleIndex])),
    [visibleChats]
  )

  const projectIdByPath = useMemo(
    () => new Map(data.projectGroups.map((group) => [group.localPath, group.groupKey])),
    [data.projectGroups]
  )

  const activeVisibleCount = visibleChats.length
  const archivedProject = useMemo(
    () => data.projectGroups.find((group) => group.groupKey === archivedProjectId) ?? null,
    [archivedProjectId, data.projectGroups]
  )

  useEffect(() => {
    visibleChatsRef.current = visibleChats
  }, [visibleChats])

  useEffect(() => {
    setCollapsedSections((previous) => {
      const next = new Set<string>()
      const projectKeys = new Set(data.projectGroups.map((group) => group.groupKey))
      const initializedKeys = initializedCollapsedGroupKeysRef.current

      for (const key of previous) {
        if (projectKeys.has(key)) {
          next.add(key)
        }
      }

      initializedCollapsedGroupKeysRef.current = new Set(
        [...initializedKeys].filter((key) => projectKeys.has(key))
      )

      for (const group of data.projectGroups) {
        if (initializedCollapsedGroupKeysRef.current.has(group.groupKey)) continue
        initializedCollapsedGroupKeysRef.current.add(group.groupKey)
        if (group.defaultCollapsed) {
          next.add(group.groupKey)
        }
      }

      if (next.size === previous.size && [...next].every((key) => previous.has(key))) {
        return previous
      }

      return next
    })
  }, [data.projectGroups])

  const toggleSection = useCallback((key: string) => {
    setCollapsedSections((previous) => {
      const next = new Set(previous)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }, [])

  const toggleExpandedGroup = useCallback((key: string) => {
    setExpandedGroups((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const clearPeekTimer = useCallback(() => {
    if (peekTimerRef.current !== null) window.clearTimeout(peekTimerRef.current)
    peekTimerRef.current = null
  }, [])

  const schedulePeek = useCallback((next: boolean, delayMs: number) => {
    clearPeekTimer()
    peekTimerRef.current = window.setTimeout(() => {
      peekTimerRef.current = null
      // A row's menu renders in a portal outside the sidebar; keep the
      // sidebar out while it is open so the menu isn't pulled away.
      if (!next && document.querySelector("[data-radix-popper-content-wrapper] [role='menu']")) {
        schedulePeek(false, 300)
        return
      }
      setPeeking(next)
    }, delayMs)
  }, [clearPeekTimer])

  useEffect(() => {
    if (!collapsed) {
      clearPeekTimer()
      setPeeking(false)
    }
  }, [clearPeekTimer, collapsed])

  useEffect(() => clearPeekTimer, [clearPeekTimer])

  const renderChatRow = useCallback((chat: SidebarChatRow) => {
    const visibleIndex = visibleIndexByChatId.get(chat.chatId)

    return (
      <ChatRow
        key={chat._id}
        chat={chat}
        showFork={true}
        activeChatId={activeChatId}
        nowMs={nowMs}
        shortcutHint={visibleIndex ? getSidebarNumberJumpHint(resolvedKeybindings, visibleIndex) : null}
        showShortcutHint={showNumberJumpHints}
        onSelectChat={(chatId) => {
          navigate(`/chat/${chatId}`)
          onClose()
        }}
        onRenameChat={() => onRenameChat(chat)}
        onShareChat={() => onShareChat(chat.chatId)}
        onOpenInFinder={() => onOpenExternalPath("open_finder", chat.localPath)}
        onForkChat={() => onForkChat(chat)}
        onArchiveChat={() => onArchiveChat(chat)}
        onDeleteChat={() => onDeleteChat(chat)}
      />
    )
  }, [activeChatId, navigate, nowMs, onArchiveChat, onClose, onDeleteChat, onForkChat, onOpenExternalPath, onRenameChat, onShareChat, resolvedKeybindings, showNumberJumpHints, visibleIndexByChatId])

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now())
    }, 30_000)

    return () => window.clearInterval(intervalId)
  }, [])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      setShowNumberJumpHints(shouldShowSidebarNumberJumpHints(resolvedKeybindings, event))

      // An older keybindings file may still give the right sidebar the same
      // keys; the right sidebar keeps them then.
      if (
        actionMatchesEvent(resolvedKeybindings, "toggleLeftSidebar", event) &&
        !actionMatchesEvent(resolvedKeybindings, "toggleRightSidebar", event)
      ) {
        event.preventDefault()
        clearPeekTimer()
        setPeeking(false)
        if (collapsed) onExpand()
        else onCollapse()
        return
      }

      if (isSidebarModifierShortcut(resolvedKeybindings, "createChatInCurrentProject", event)) {
        if (!currentProjectId) {
          return
        }

        event.preventDefault()
        onCreateChat(currentProjectId)
        return
      }

      if (isSidebarModifierShortcut(resolvedKeybindings, "openAddProject", event)) {
        event.preventDefault()
        navigate("/")
        onClose()
        onOpenAddProjectModal()
        return
      }

      const targetIndex = getSidebarJumpTargetIndex(resolvedKeybindings, event)
      if (targetIndex === null) {
        return
      }

      const targetChat = visibleChatsRef.current[targetIndex - 1]?.chat
      if (!targetChat) {
        return
      }

      event.preventDefault()
      navigate(`/chat/${targetChat.chatId}`)
      onClose()
    }

    function handleKeyUp(event: KeyboardEvent) {
      setShowNumberJumpHints(shouldShowSidebarNumberJumpHints(resolvedKeybindings, event))
    }

    function clearHints() {
      setShowNumberJumpHints(false)
    }

    window.addEventListener("keydown", handleKeyDown)
    window.addEventListener("keyup", handleKeyUp)
    window.addEventListener("blur", clearHints)

    return () => {
      window.removeEventListener("keydown", handleKeyDown)
      window.removeEventListener("keyup", handleKeyUp)
      window.removeEventListener("blur", clearHints)
    }
  }, [clearPeekTimer, collapsed, currentProjectId, navigate, onClose, onCollapse, onCreateChat, onExpand, onOpenAddProjectModal, resolvedKeybindings])

  useEffect(() => {
    if (!activeChatId || !scrollContainerRef.current) return

    requestAnimationFrame(() => {
      const container = scrollContainerRef.current
      const activeElement = container?.querySelector(`[data-chat-id="${activeChatId}"]`) as HTMLElement | null
      if (!activeElement || !container) return

      const elementRect = activeElement.getBoundingClientRect()
      const containerRect = container.getBoundingClientRect()

      if (elementRect.top < containerRect.top + 38) {
        const relativeTop = elementRect.top - containerRect.top + container.scrollTop
        container.scrollTo({ top: relativeTop - 38, behavior: "smooth" })
      } else if (elementRect.bottom > containerRect.bottom) {
        const elementCenter = elementRect.top + elementRect.height / 2 - containerRect.top + container.scrollTop
        const containerCenter = container.clientHeight / 2
        container.scrollTo({ top: elementCenter - containerCenter, behavior: "smooth" })
      }
    })
  }, [activeChatId])

  useEffect(() => {
    if (!isResizingSidebar) return

    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"

    function handlePointerMove(event: PointerEvent) {
      const resizeStart = resizeStartRef.current
      if (!resizeStart) return
      setSidebarWidth(clampSidebarWidth(resizeStart.width + event.clientX - resizeStart.pointerX))
    }

    function handlePointerUp() {
      setIsResizingSidebar(false)
      resizeStartRef.current = null
      setSidebarWidth((current) => {
        const next = clampSidebarWidth(current)
        persistSidebarWidth(next)
        return next
      })
    }

    window.addEventListener("pointermove", handlePointerMove)
    window.addEventListener("pointerup", handlePointerUp, { once: true })

    return () => {
      window.removeEventListener("pointermove", handlePointerMove)
      window.removeEventListener("pointerup", handlePointerUp)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
    }
  }, [isResizingSidebar])

  const hasVisibleChats = activeVisibleCount > 0
  const brandName = useBrandName()
  // Red dot on the Memory entry: drift needs attention, or memory changed
  // since the last board visit — the meta-level model is out of date.
  // The count is ambient gist for pending candidates (friction #4): review
  // cards scroll out of the stream, and without a standing number the pile
  // is invisible until the next Board visit.
  const [memoryBadge, setMemoryBadge] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)
  useEffect(() => {

    let disposed = false
    const check = async () => {
      try {
        const [attention, items, candidates] = await Promise.all([
          memoriesApi.needsAttention(),
          memoriesApi.list({ status: "active" }),
          memoriesApi.list({ status: "candidate" }),
        ])
        if (disposed) return
        const prev = getLastBoardVisit()
        const fresh = prev !== null && items.some((m) => Date.parse(m.updatedAt) > prev)
        setMemoryBadge(attention.items.length > 0 || fresh)
        setPendingCount(candidates.length)
      } catch {
        // keep the last state — a missed poll must not flicker the badge
      }
    }
    void check()
    const timer = window.setInterval(check, 60_000)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [location.pathname])
  const isLocalProjectsActive = location.pathname === "/"
  const isSettingsActive = location.pathname.startsWith("/settings")
  const isMemoryActive = location.pathname.startsWith("/memory")
  const isUtilityPageActive = isLocalProjectsActive || isSettingsActive || isMemoryActive
  const isConnecting = connectionStatus === "connecting" || !ready
  const statusLabel = isConnecting ? t("sidebar:connecting") : connectionStatus === "connected" ? t("sidebar:connected") : t("sidebar:disconnected")
  const statusDotClass = connectionStatus === "connected" ? "bg-success" : "bg-amber-500"
  const showUpdateButton = updateSnapshot?.updateAvailable === true
  const showDevBadge = updateSnapshot
    ? updateSnapshot.latestVersion === `${updateSnapshot.currentVersion}-dev`
    : false
  const isUpdating = updateSnapshot?.status === "updating" || updateSnapshot?.status === "restart_pending"

  return (
    <>
      {!open && showMobileOpenButton && (
        <Button
          variant="ghost"
          size="icon"
          className="fixed top-3 left-3 z-50 md:hidden"
          onClick={onOpen}
        >
          <Menu className="h-5 w-5" />
        </Button>
      )}

      {collapsed && isUtilityPageActive && (
        <div className="hidden md:flex fixed left-0 top-0 h-full z-40 items-start pt-4 pl-5 border-l border-border/0">
          <div className="flex items-center gap-1">
            <BrandIcon className="size-6" />
            <Button
              variant="ghost"
              size="icon"
              onClick={onExpand}
              title={t("sidebar:expandSidebar")}
            >
              <PanelLeft className="h-5 w-5" />
            </Button>
          </div>
        </div>
      )}

      {collapsed ? (
        <div
          aria-hidden="true"
          data-sidebar-peek-zone
          className="fixed inset-y-0 left-0 z-40 hidden w-2 md:block"
          onPointerEnter={(event) => {
            if (event.pointerType === "mouse") schedulePeek(true, 120)
          }}
          onPointerLeave={() => {
            if (!peeking) clearPeekTimer()
          }}
        />
      ) : null}

      <div
        data-sidebar="open"
        data-peeking={collapsed && peeking ? "true" : undefined}
        inert={collapsed && !peeking && !open ? true : undefined}
        className={cn(
          "fixed inset-0 z-50 bg-sidebar flex flex-col h-[100dvh] select-none",
          collapsed
            ? cn(
                "md:inset-y-0 md:left-0 md:right-auto md:w-[var(--sidebar-width)] md:border-r md:border-border/70",
                "md:transition-[translate,box-shadow] md:duration-200 md:ease-out",
                peeking
                  ? "md:translate-x-0 md:shadow-[0_12px_40px_rgba(0,0,0,0.14)] dark:md:shadow-[0_12px_40px_rgba(0,0,0,0.5)]"
                  : "md:-translate-x-full"
              )
            : "md:relative md:inset-auto md:w-[var(--sidebar-width)] md:border-r md:border-border/70",
          open ? "flex" : "hidden md:flex"
        )}
        style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
        onPointerEnter={() => {
          if (collapsed) clearPeekTimer()
        }}
        onPointerLeave={(event) => {
          if (collapsed && peeking && event.pointerType === "mouse" && !isResizingSidebar) schedulePeek(false, 280)
        }}
      >
        <div className="px-[5px] h-[47px] border-b grid grid-cols-[40px_minmax(0,1fr)_40px] items-center md:h-12 md:border-b-0 md:pl-4 md:pr-2 md:flex md:justify-between">
          <div className="md:hidden">
            <Button
              variant="ghost"
              size="icon"
              className="size-10 rounded-lg hover:!border-border/0"
              onClick={onClose}
              title={t("sidebar:closeSidebar")}
            >
              <X className="h-5 w-5" />
            </Button>
          </div>
          <div className="flex items-center justify-self-center gap-2 md:justify-self-auto">
            <BrandIcon animated="none" className="h-5 w-5 sm:h-6 sm:w-6 md:h-5 md:w-5" />
            <span className="font-logo text-base uppercase sm:text-md text-section-title">{brandName}</span>
          </div>
          <div className="flex items-center justify-self-end md:justify-self-auto">
            {<Button
              variant="ghost"
              size="icon"
              onClick={() => {
                navigate("/")
                onClose()
              }}
              className="size-10 rounded-lg hover:!border-border/0 md:hidden"
              title={t("sidebar:newProject")}
            >
              <Plus className="h-5 w-5" />
            </Button>}
            {showDevBadge ? (
              <span
                className="mr-1 hidden md:inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-bold tracking-wider text-muted-foreground"
                title={t("sidebar:developmentBuild")}
              >
                {t("sidebar:dev")}</span>
            ) : showUpdateButton ? (
              <Button
                variant="outline"
                size="sm"
                className="hidden md:inline-flex rounded-full !h-auto mr-1 py-0.5 px-2 bg-logo/20 hover:bg-logo text-logo border-logo/20 hover:text-foreground hover:border-logo/20 text-[11px] font-bold tracking-wider"
                onClick={onOpenChangelog}
                disabled={isUpdating}
                title={updateSnapshot?.latestVersion ? t("sidebar:updateToValue0", { v0: updateSnapshot.latestVersion }) : t("sidebar:updateMemoSync")}
              >
                {isUpdating ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
                {t("sidebar:update")}</Button>
            ) : null}
            {<Button
              variant="ghost"
              size="icon"
              onClick={() => {
                navigate("/")
                onClose()
              }}
              className="hidden md:inline-flex size-8 rounded-lg border-0 text-muted-foreground hover:border-0 hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.08]"
              title={t("sidebar:newProject")}
            >
              <Plus className="size-4" />
            </Button>}
            <HotkeyTooltip>
              <HotkeyTooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    clearPeekTimer()
                    setPeeking(false)
                    if (collapsed) onExpand()
                    else onCollapse()
                  }}
                  aria-label={collapsed ? t("sidebar:pinSidebar") : t("sidebar:collapseSidebar")}
                  className="hidden md:inline-flex size-8 rounded-lg border-0 text-muted-foreground hover:border-0 hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.08]"
                >
                  <PanelLeft className="size-4" />
                </Button>
              </HotkeyTooltipTrigger>
              <HotkeyTooltipContent side="bottom" shortcut={resolvedKeybindings.bindings.toggleLeftSidebar}>
                {collapsed ? t("sidebar:pinSidebar") : t("sidebar:collapseSidebar")}
              </HotkeyTooltipContent>
            </HotkeyTooltip>
          </div>
        </div>

        <div
          ref={scrollContainerRef}
          className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden scrollbar-hide"
          style={{
            WebkitOverflowScrolling: "touch",
            touchAction: "pan-y",
          }}
        >
          <div className="px-2 pb-2">
            {!hasVisibleChats && isConnecting ? (
              <div className="space-y-5 px-1 pt-3">
                {[0, 1, 2].map((section) => (
                  <div key={section} className="space-y-2 animate-pulse">
                    <div className="h-4 w-28 rounded bg-muted" />
                    <div className="space-y-1">
                      {[0, 1, 2].map((row) => (
                        <div key={row} className="flex items-center gap-2 rounded-md px-3 py-2">
                          <div className="h-3.5 w-3.5 rounded-full bg-muted" />
                          <div
                            className={cn(
                              "h-3.5 rounded bg-muted",
                              row === 0 ? "w-32" : row === 1 ? "w-40" : "w-28"
                            )}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {!hasVisibleChats && !isConnecting && data.projectGroups.length === 0 ? (
              <p className="text-sm text-slate-400 dark:text-muted-foreground p-2 mt-6 text-center">{t("sidebar:noConversationsYet")}</p>
            ) : null}

            <LocalProjectsSection
              projectGroups={data.projectGroups}
              onReorderGroups={onReorderProjectGroups}
              collapsedSections={collapsedSections}
              expandedGroups={expandedGroups}
              onToggleSection={toggleSection}
              onToggleExpandedGroup={toggleExpandedGroup}
              renderChatRow={renderChatRow}
              onShowArchivedProject={setArchivedProjectId}
              onNewLocalChat={(localPath) => {
                const projectId = projectIdByPath.get(localPath)
                if (projectId) {
                  onCreateChat(projectId)
                }
              }}
              onCopyPath={onCopyPath}
              onOpenExternalPath={onOpenExternalPath}
              onRenameProject={onRenameProject}
              onHideProject={onHideProject}
              isConnected={connectionStatus === "connected"}
            />
          </div>
        </div>

        <div className="space-y-0.5 border-t border-border/60 p-2">
          {(
            <button
              type="button"
              onClick={() => {

                  // Normal product keeps the global route and project lens.
                  navigate(`/memory${currentProjectId ? `?project=${encodeURIComponent(currentProjectId)}` : ""}`)

                onClose()
              }}
              className={cn(SIDEBAR_ROW_CLASS, "w-full px-2.5 text-left", isMemoryActive && SIDEBAR_ROW_ACTIVE_CLASS)}
            >
              <div className="flex w-full items-center gap-2">
                <span className="relative">
                  <BrainCircuit className="h-4 w-4 text-muted-foreground" />
                  {memoryBadge ? (
                    <span
                      title={t("sidebar:memoryChangedSinceYourLastBoardVisitOrNeedsAttention")}
                      className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-red-500"
                    />
                  ) : null}
                </span>
                <span className="text-[13px]">{t("common:memory")}</span>
                <MemoryOffBadge />
                {pendingCount > 0 ? (
                  <span
                    title={t("sidebar:pendingCandidates", { count: pendingCount })}
                    className="ml-auto rounded-full border border-cand-border bg-cand-surface px-1.5 text-[10px] font-medium leading-4 text-cand-fg"
                  >
                    {pendingCount}
                  </span>
                ) : null}
              </div>
            </button>
          )}
            <button
            type="button"
            onClick={() => {
              navigate("/settings/general")
              onClose()
            }}
            className={cn(SIDEBAR_ROW_CLASS, "w-full px-2.5 text-left", isSettingsActive && SIDEBAR_ROW_ACTIVE_CLASS)}
          >
            <div className="flex w-full items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Settings className="h-4 w-4 text-muted-foreground" />
                <span className="text-[13px]">{t("common:settings")}</span>
              </div>
              <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                <span>{statusLabel}</span>
                {isConnecting ? (
                  <Loader2 className="h-2 w-2 animate-spin" />
                ) : (
                  <span className={cn("h-2 w-2 rounded-full", statusDotClass)} />
                )}
              </div>
            </div>
          </button>
        </div>

        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("sidebar:resizeSidebar")}
          tabIndex={0}
          title={t("sidebar:resizeSidebar")}
          className={cn(
            "hidden md:block absolute -right-1 inset-y-0 z-20 w-2 cursor-col-resize",
            "after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] after:-translate-x-1/2 after:bg-transparent after:transition-colors after:duration-150",
            "hover:after:bg-focus/50 hover:after:delay-150 focus-visible:outline-none focus-visible:after:bg-focus/60",
            isResizingSidebar && "after:bg-focus/60"
          )}
          onPointerDown={(event) => {
            event.preventDefault()
            resizeStartRef.current = {
              pointerX: event.clientX,
              width: sidebarWidth,
            }
            setIsResizingSidebar(true)
          }}
          onDoubleClick={() => {
            setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)
            persistSidebarWidth(DEFAULT_SIDEBAR_WIDTH)
          }}
          onKeyDown={(event) => {
            let nextWidth: number | null = null
            if (event.key === "ArrowLeft") nextWidth = sidebarWidth - 16
            else if (event.key === "ArrowRight") nextWidth = sidebarWidth + 16
            else if (event.key === "Home") nextWidth = MIN_SIDEBAR_WIDTH
            else if (event.key === "End") nextWidth = MAX_SIDEBAR_WIDTH
            else if (event.key === "Enter") nextWidth = DEFAULT_SIDEBAR_WIDTH
            if (nextWidth === null) return
            event.preventDefault()
            const clampedWidth = clampSidebarWidth(nextWidth)
            setSidebarWidth(clampedWidth)
            persistSidebarWidth(clampedWidth)
          }}
        />
      </div>

      <Dialog
        open={Boolean(archivedProject)}
        onOpenChange={(dialogOpen) => {
          if (!dialogOpen) setArchivedProjectId(null)
        }}
      >
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>{t("sidebar:archivedChats")}</DialogTitle>
            <DialogDescription>
              {archivedProject?.localPath ?? ""}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-1">
            {archivedProject?.archivedChats?.length ? (
              archivedProject.archivedChats.map((chat) => (
                <button
                  key={chat.chatId}
                  type="button"
                  className="flex w-full items-center justify-between gap-3 rounded-lg border border-border/0 px-3 py-2 text-left transition-colors hover:border-border hover:bg-muted"
                  onClick={() => {
                    onOpenArchivedChat(chat.chatId)
                    setArchivedProjectId(null)
                    onClose()
                  }}
                >
                  <span className="min-w-0 truncate text-sm">{chatTitle(chat)}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatSidebarAgeLabel(getSidebarChatTimestamp(chat), nowMs)}
                  </span>
                </button>
              ))
            ) : (
              <p className="px-1 py-3 text-sm text-muted-foreground">{t("sidebar:noArchivedChats")}</p>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>

      {open ? <div className="fixed inset-0 bg-black/40 z-40 md:hidden" onClick={onClose} /> : null}
    </>
  )
}

export const AppSidebar = memo(AppSidebarImpl)
