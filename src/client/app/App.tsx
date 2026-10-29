import { translateUiText } from "../i18n/uiText"
import { t, useI18n, getLocale } from "../i18n"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom"
import { SDK_CLIENT_APP, SELF_UPDATE_ENABLED } from "../../shared/branding"
import type { AppSettingsSnapshot } from "../../shared/types"
import { BrandIcon, useBrandFavicon, useBrandName } from "../components/BrandMark"
import { StandaloneShareDialog } from "../components/chat-ui/StandaloneShareDialog"
import { AppDialogProvider } from "../components/ui/app-dialog"
import { Button } from "../components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card"
import { Input } from "../components/ui/input"
import { TooltipProvider } from "../components/ui/tooltip"
import { shouldShowChatBrowserNotification, showChatBrowserNotification } from "../lib/chatBrowserNotifications"
import { playChatNotificationSound, shouldPlayChatSound } from "../lib/chatSounds"
import { initializeUsageTelemetryOutbox, stopUsageTelemetryOutbox } from "../lib/usageTelemetry"
import type { ChatSoundPreference } from "../stores/chatSoundPreferencesStore"
import { useChatSoundPreferencesStore } from "../stores/chatSoundPreferencesStore"
import { AppSidebar } from "./AppSidebar"
import { getChatNotificationEvents, getChatSoundBurstCount, getNotificationTitleCount } from "./chatNotifications"
import { ChatPage } from "./ChatPage"
import { LocalProjectsPage } from "./LocalProjectsPage"
import {
  MemoryBoardLauncherProvider,
  reconcileMemoryBoardRequestWithActiveChat,
  resolveMemoryBoardLaunchRequest,
  type MemoryBoardLaunchRequest,
  type ResolvedMemoryBoardLaunchRequest,
} from "./memory/MemoryBoardLauncher"
import { MemoryBoardOverlay } from "./memory/MemoryBoardOverlay"
import { MemoryBoardPage } from "./MemoryBoardPage"
import { SettingsPage } from "./SettingsPage"
import { WS_UNAUTHORIZED_EVENT } from "./socket"
import { useAppState } from "./useAppState"

const VERSION_SEEN_STORAGE_KEY = "memosync:last-seen-version"
const AUTH_STATUS_RETRY_DELAY_MS = 500

interface AuthStatusResponse {
  enabled: boolean
  authenticated: boolean
}

type AppAuthState =
  | { status: "checking" }
  | { status: "ready" }
  | { status: "locked"; error: string | null }

function TelemetryBootstrap() {
  useI18n()
  useLayoutEffect(() => {
    void initializeUsageTelemetryOutbox()
    return stopUsageTelemetryOutbox
  }, [])
  return null
}

export function getAppAuthStateFromStatus(payload: Partial<AuthStatusResponse>): AppAuthState {
  if (!payload.enabled || payload.authenticated) {
    return { status: "ready" }
  }

  return { status: "locked", error: null }
}

export function shouldRetryAuthStatusRequest(responseOk: boolean | null) {
  return responseOk !== true
}

function PasswordScreen({
  error,
  onSubmit,
}: {
  error: string | null
  onSubmit: (password: string) => Promise<void>
}) {
  useI18n()
  const [password, setPassword] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const brandName = useBrandName()

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!password || submitting) return
    setSubmitting(true)
    try {
      await onSubmit(password)
      setPassword("")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-6 py-10">
      <Card className="w-full max-w-md rounded-3xl border border-border bg-card shadow-sm">
        <CardHeader className="flex flex-col p-2 space-y-3 px-6 pt-6 pb-5 pl-[28px]">
          <div className="flex items-center gap-3">
            <BrandIcon className="h-5 w-5" />
            <div>
              <CardTitle className="font-logo text-xl uppercase text-section-title">{brandName}</CardTitle>
            </div>
          </div>
          <CardDescription className="leading-6">
            {t("chat:enterYourPasswordToContinue")}</CardDescription>
        </CardHeader>
        <CardContent className="px-6 pb-6">
          <form className="space-y-4" onSubmit={(event) => void handleSubmit(event)}>
            {error ? (
              <div className="rounded-2xl border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-foreground">
                {translateUiText(error)}
              </div>
            ) : null}
            <Input
              id="memosync-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t("chat:password")}
              disabled={submitting}
              className="h-11 rounded-2xl bg-background"
            />
            <Button
              type="submit"
              disabled={submitting || password.length === 0}
              className="h-11 w-full"
            >
              {submitting ? t("chat:unlocking") : t("chat:unlock")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

function useAppAuthState() {
  useI18n()
  const [state, setState] = useState<AppAuthState>({ status: "checking" })
  const retryTimeoutRef = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    if (retryTimeoutRef.current !== null) {
      window.clearTimeout(retryTimeoutRef.current)
      retryTimeoutRef.current = null
    }

    setState((current) => current.status === "ready" ? current : { status: "checking" })

    let response: Response
    try {
      response = await fetch("/auth/status", {
        method: "GET",
        cache: "no-store",
        headers: {
          Accept: "application/json",
        },
      })
    } catch {
      retryTimeoutRef.current = window.setTimeout(() => {
        void refresh()
      }, AUTH_STATUS_RETRY_DELAY_MS)
      return
    }

    if (shouldRetryAuthStatusRequest(response.ok)) {
      retryTimeoutRef.current = window.setTimeout(() => {
        void refresh()
      }, AUTH_STATUS_RETRY_DELAY_MS)
      return
    }

    const payload = await response.json() as Partial<AuthStatusResponse>
    setState(getAppAuthStateFromStatus(payload))
  }, [])

  useEffect(() => {
    void refresh()
    return () => {
      if (retryTimeoutRef.current !== null) {
        window.clearTimeout(retryTimeoutRef.current)
      }
    }
  }, [refresh])

  // The socket's reconnect probe found the session locked out (rotated
  // password, evicted cookie): return to the password gate instead of
  // letting the app cycle "connecting" forever.
  useEffect(() => {
    const handleUnauthorized = () => setState({ status: "locked", error: null })
    window.addEventListener(WS_UNAUTHORIZED_EVENT, handleUnauthorized)
    return () => window.removeEventListener(WS_UNAUTHORIZED_EVENT, handleUnauthorized)
  }, [])

  const submitPassword = useCallback(async (password: string) => {
    const response = await fetch("/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ password, next: window.location.pathname + window.location.search }),
    })

    if (!response.ok) {
      setState({ status: "locked", error: t("chat:incorrectPasswordTryAgain") })
      return
    }

    await refresh()
  }, [refresh, getLocale()])

  return {
    state,
    submitPassword,
  }
}

export function shouldRedirectToChangelog(pathname: string, currentVersion: string, seenVersion: string | null) {
  return SELF_UPDATE_ENABLED && pathname === "/" && Boolean(currentVersion) && seenVersion !== currentVersion
}

export function shouldPlayChatNotificationSound(
  appSettings: AppSettingsSnapshot | null,
  preference: ChatSoundPreference,
  doc: Pick<Document, "visibilityState" | "hasFocus"> = document
) {
  return Boolean(appSettings) && shouldPlayChatSound(preference, doc)
}

function AppLayout() {
  useI18n()
  const location = useLocation()
  const navigate = useNavigate()
  const params = useParams()
  const state = useAppState(params.chatId ?? null)
  // "" until the condition policy resolves — the title effects below wait for
  // it rather than stamping the MemoSync name onto a baseline arm's tab.
  const brandName = useBrandName()
  useBrandFavicon()
  const [memoryBoardRequest, setMemoryBoardRequest] = useState<ResolvedMemoryBoardLaunchRequest | null>(null)
  useEffect(() => {
    setMemoryBoardRequest((current) => reconcileMemoryBoardRequestWithActiveChat(current, state.activeChatId))
  }, [state.activeChatId])
  const chatSoundPreference = useChatSoundPreferencesStore((store) => store.chatSoundPreference)
  const chatSoundId = useChatSoundPreferencesStore((store) => store.chatSoundId)
  const showMobileOpenButton = location.pathname === "/"
  const currentVersion = SDK_CLIENT_APP.split("/")[1] ?? "unknown"
  const previousSidebarDataRef = useRef<ReturnType<typeof useAppState>["sidebarData"] | null>(null)
  const handleSidebarCreateChat = useCallback((projectId: string) => {
    void state.handleCreateChat(projectId)
  }, [state.handleCreateChat])
  const handleSidebarForkChat = useCallback((chat: Parameters<typeof state.handleForkChat>[0]) => {
    void state.handleForkChat(chat)
  }, [state.handleForkChat])
  const handleSidebarRenameChat = useCallback((chat: Parameters<typeof state.handleRenameChat>[0]) => {
    void state.handleRenameChat(chat)
  }, [state.handleRenameChat])
  const handleSidebarRenameProject = useCallback((projectId: string, sidebarTitle: string | undefined, realTitle: string) => {
    void state.handleRenameProject(projectId, sidebarTitle, realTitle)
  }, [state.handleRenameProject])
  const handleSidebarShareChat = useCallback((chatId: string) => {
    void state.handleShareChat(chatId)
  }, [state.handleShareChat])
  const handleSidebarArchiveChat = useCallback((chat: Parameters<typeof state.handleArchiveChat>[0]) => {
    void state.handleArchiveChat(chat)
  }, [state.handleArchiveChat])
  const handleOpenArchivedChat = useCallback((chatId: string) => {
    void state.handleOpenArchivedChat(chatId)
  }, [state.handleOpenArchivedChat])
  const handleOpenAddProjectModal = useCallback(() => {
    state.openAddProjectModal()
  }, [state])
  const handleSidebarDeleteChat = useCallback((chat: Parameters<typeof state.handleDeleteChat>[0]) => {
    void state.handleDeleteChat(chat)
  }, [state.handleDeleteChat])
  const handleSidebarCopyPath = useCallback((localPath: string) => {
    void state.handleCopyPath(localPath)
  }, [state.handleCopyPath])
  const handleSidebarOpenExternalPath = useCallback((action: "open_finder" | "open_editor", localPath: string) => {
    void state.handleOpenExternalPath(action, localPath)
  }, [state.handleOpenExternalPath])
  const handleSidebarHideProject = useCallback((projectId: string) => {
    void state.handleHideProject(projectId)
  }, [state.handleHideProject])
  const handleSidebarReorderProjectGroups = useCallback((projectIds: string[]) => {
    void state.handleReorderProjectGroups(projectIds)
  }, [state.handleReorderProjectGroups])
  const handleOpenChangelog = useCallback(() => {
    navigate("/settings/changelog")
  }, [navigate])
  const handleOpenMemoryBoard = useCallback((request: MemoryBoardLaunchRequest) => {
    setMemoryBoardRequest(resolveMemoryBoardLaunchRequest(request, state.activeChatId))
  }, [state.activeChatId])
  const handleOpenMemoryBoardFromSidebar = useCallback(() => {
    handleOpenMemoryBoard({ source: "sidebar" })
  }, [handleOpenMemoryBoard])
  const sidebarElement = useMemo(() => (
    <AppSidebar
      data={state.sidebarData}
      activeChatId={state.activeChatId}
      connectionStatus={state.connectionStatus}
      ready={state.sidebarReady}
      open={state.sidebarOpen}
      collapsed={state.sidebarCollapsed}
      showMobileOpenButton={showMobileOpenButton}
      onOpen={state.openSidebar}
      onClose={state.closeSidebar}
      onCollapse={state.collapseSidebar}
      onExpand={state.expandSidebar}
      onCreateChat={handleSidebarCreateChat}
      onForkChat={handleSidebarForkChat}
      currentProjectId={state.activeProjectId}
      keybindings={state.keybindings}
      onRenameChat={handleSidebarRenameChat}
      onShareChat={handleSidebarShareChat}
      onArchiveChat={handleSidebarArchiveChat}
      onOpenArchivedChat={handleOpenArchivedChat}
      onDeleteChat={handleSidebarDeleteChat}
      onOpenAddProjectModal={handleOpenAddProjectModal}
      onCopyPath={handleSidebarCopyPath}
      onOpenExternalPath={handleSidebarOpenExternalPath}
      onRenameProject={handleSidebarRenameProject}
      onHideProject={handleSidebarHideProject}
      onReorderProjectGroups={handleSidebarReorderProjectGroups}
      updateSnapshot={state.updateSnapshot}
      onOpenChangelog={handleOpenChangelog}
      onOpenMemoryBoard={handleOpenMemoryBoardFromSidebar}
    />
  ), [
    handleOpenChangelog,
    handleOpenMemoryBoardFromSidebar,
    handleOpenAddProjectModal,
    handleSidebarCopyPath,
    handleSidebarCreateChat,
    handleSidebarArchiveChat,
    handleSidebarDeleteChat,
    handleOpenArchivedChat,
    handleSidebarForkChat,
    handleSidebarOpenExternalPath,
    handleSidebarRenameProject,
    handleSidebarRenameChat,
    handleSidebarShareChat,
    handleSidebarReorderProjectGroups,
    handleSidebarHideProject,
    showMobileOpenButton,
    state.activeChatId,
    state.activeProjectId,
    state.keybindings,
    state.closeSidebar,
    state.collapseSidebar,
    state.connectionStatus,
    state.editorLabel,
    state.expandSidebar,
    state.openSidebar,
    state.sidebarCollapsed,
    state.sidebarData,
    state.sidebarOpen,
    state.sidebarReady,
    state.updateSnapshot,
  ])

  useEffect(() => {
    if (!SELF_UPDATE_ENABLED) return
    const seenVersion = window.localStorage.getItem(VERSION_SEEN_STORAGE_KEY)
    const shouldRedirect = shouldRedirectToChangelog(location.pathname, currentVersion, seenVersion)
    window.localStorage.setItem(VERSION_SEEN_STORAGE_KEY, currentVersion)
    if (!shouldRedirect) return
    navigate("/settings/changelog", { replace: true })
  }, [currentVersion, location.pathname, navigate])

  useLayoutEffect(() => {
    if (brandName) document.title = brandName
  }, [brandName, location.key])

  useEffect(() => {
    if (!brandName) return

    function handlePageShow() {
      document.title = brandName
    }

    function handlePageHide() {
      document.title = brandName
    }

    window.addEventListener("pageshow", handlePageShow)
    window.addEventListener("pagehide", handlePageHide)
    return () => {
      window.removeEventListener("pageshow", handlePageShow)
      window.removeEventListener("pagehide", handlePageHide)
    }
  }, [brandName])

  useEffect(() => {
    if (!brandName) return
    const notificationCount = getNotificationTitleCount(state.sidebarData)
    document.title = notificationCount > 0 ? `[${notificationCount}] ${brandName}` : brandName
  }, [brandName, state.sidebarData])

  useEffect(() => {
    const events = getChatNotificationEvents(previousSidebarDataRef.current, state.sidebarData)
    const burstCount = getChatSoundBurstCount(previousSidebarDataRef.current, state.sidebarData)
    previousSidebarDataRef.current = state.sidebarData

    if (state.appSettings && shouldShowChatBrowserNotification(state.appSettings.chatBrowserNotificationPreference)) {
      for (const event of events) {
        showChatBrowserNotification({
          ...event,
          message: event.message ?? t("chat:newChatActivity"),
          onClick: () => { window.focus(); navigate(`/chat/${event.chatId}`) },
        })
      }
    }
    if (burstCount <= 0) return
    if (!shouldPlayChatNotificationSound(state.appSettings, chatSoundPreference)) return

    void playChatNotificationSound(chatSoundId, burstCount).catch(() => undefined)
  }, [chatSoundId, chatSoundPreference, navigate, state.appSettings, state.sidebarData])

  return (
    <MemoryBoardLauncherProvider onOpenMemoryBoard={handleOpenMemoryBoard}>
      <div className="flex h-[100dvh] min-h-[100dvh] overflow-hidden">
        {sidebarElement}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {memoryBoardRequest ? (
            <MemoryBoardOverlay
              chatId={memoryBoardRequest.chatId}
              focusedReview={memoryBoardRequest.focusedReview}
              onClose={() => setMemoryBoardRequest(null)}
            />
          ) : null}
          <div className="flex min-h-0 min-w-0 flex-1">
            <Outlet context={state} />
          </div>
        </div>
        <StandaloneShareDialog
          open={Boolean(state.standaloneShareUrl)}
          shareUrl={state.standaloneShareUrl ?? ""}
          onOpenChange={(open) => {
            if (!open) {
              state.handleCloseStandaloneShareDialog()
            }
          }}
          onOpenLink={state.handleOpenStandaloneShareLink}
          onCopyLink={state.handleCopyStandaloneShareLink}
        />
      </div>
    </MemoryBoardLauncherProvider>
  )
}

export function App() {
  useI18n()
  const auth = useAppAuthState()

  if (auth.state.status === "checking") {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background text-sm text-muted-foreground">
        {t("chat:checkingSession")}</div>
    )
  }

  if (auth.state.status === "locked") {
    return <PasswordScreen error={auth.state.error} onSubmit={auth.submitPassword} />
  }

  return (
    <TooltipProvider>
      <AppDialogProvider>
        <TelemetryBootstrap />
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/" element={<LocalProjectsPage />} />
            <Route path="/settings" element={<Navigate to="/settings/general" replace />} />
            <Route path="/settings/:sectionId" element={<SettingsPage />} />
            <Route path="/memory" element={<MemoryBoardPage />} />
            <Route path="/chat/:chatId" element={<ChatPage />} />
          </Route>
        </Routes>
      </AppDialogProvider>
    </TooltipProvider>
  )
}
