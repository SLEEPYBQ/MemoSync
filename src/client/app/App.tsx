import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom"
import { BrandIcon, useBrandFavicon, useBrandName } from "../components/BrandMark"
import { StandaloneShareDialog } from "../components/chat-ui/StandaloneShareDialog"
import { AppDialogProvider } from "../components/ui/app-dialog"
import { Button } from "../components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card"
import { Input } from "../components/ui/input"
import { TooltipProvider } from "../components/ui/tooltip"
import { SDK_CLIENT_APP, SELF_UPDATE_ENABLED } from "../../shared/branding"
import { useChatSoundPreferencesStore } from "../stores/chatSoundPreferencesStore"
import type { ChatSoundPreference } from "../stores/chatSoundPreferencesStore"
import { playChatNotificationSound, shouldPlayChatSound } from "../lib/chatSounds"
import { getChatSoundBurstCount, getNotificationTitleCount } from "./chatNotifications"
import { AppSidebar } from "./AppSidebar"
import { ChatPage } from "./ChatPage"
import { LocalProjectsPage } from "./LocalProjectsPage"
import { SettingsPage } from "./SettingsPage"
import { MemoryBoardPage } from "./MemoryBoardPage"
import { useAppState } from "./useAppState"
import { initializeStudyTelemetryOutbox, stopStudyTelemetryOutbox } from "./study/studyTelemetry"
import { ManualMemoryBoardOverlay } from "./study/StudyBoardGate"
import {
  MemoryBoardLauncherProvider,
  reconcileMemoryBoardRequestWithActiveChat,
  resolveMemoryBoardLaunchRequest,
  type MemoryBoardLaunchRequest,
  type ResolvedMemoryBoardLaunchRequest,
} from "./study/MemoryBoardLauncher"
import { useConditionPolicyLoadFailed, useConditionPolicyResolved } from "../lib/conditionApi"
import { WS_UNAUTHORIZED_EVENT } from "./socket"
import type { AppSettingsSnapshot } from "../../shared/types"

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
  const policy = useConditionPolicyResolved()

  useLayoutEffect(() => {
    if (!policy) {
      stopStudyTelemetryOutbox()
      return
    }
    // The monitoring record stays on in normal deployments: start the durable
    // outbox directly — no onboarding, no participant scoping reset. Events
    // flow to the never-condition-locked logging routes.
    void initializeStudyTelemetryOutbox({
      condition: policy.condition,
      resetForNewParticipant: false,
    })
    return () => stopStudyTelemetryOutbox()
  }, [policy])

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
              <CardTitle className="font-logo text-xl uppercase text-slate-600 dark:text-slate-100">{brandName}</CardTitle>
            </div>
          </div>
          <CardDescription className="leading-6">
            Enter your password to continue.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-6 pb-6">
          <form className="space-y-4" onSubmit={(event) => void handleSubmit(event)}>
            {error ? (
              <div className="rounded-2xl border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-foreground">
                {error}
              </div>
            ) : null}
            <Input
              id="memosync-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Password"
              disabled={submitting}
              className="h-11 rounded-2xl bg-background"
            />
            <Button
              type="submit"
              disabled={submitting || password.length === 0}
              className="h-11 w-full"
            >
              {submitting ? "Unlocking..." : "Unlock"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

function useAppAuthState() {
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
      setState({ status: "locked", error: "Incorrect password. Try again." })
      return
    }

    await refresh()
  }, [refresh])

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
  const location = useLocation()
  const navigate = useNavigate()
  const params = useParams()
  const state = useAppState(params.chatId ?? null)
  // "" until the condition policy resolves — the title effects below wait for
  // it rather than stamping the MemoSync name onto a baseline arm's tab.
  const brandName = useBrandName()
  useBrandFavicon()
  // Study completion is stored in this participant instance's study.sqlite,
  // not browser-local state that a later participant could accidentally reuse.
  const conditionPolicyForGuide = useConditionPolicyResolved()
  const conditionPolicyLoadFailed = useConditionPolicyLoadFailed()
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
    handleOpenMemoryBoard({ source: "study_sidebar" })
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
    const burstCount = getChatSoundBurstCount(previousSidebarDataRef.current, state.sidebarData)
    previousSidebarDataRef.current = state.sidebarData

    if (burstCount <= 0) return
    if (!shouldPlayChatNotificationSound(state.appSettings, chatSoundPreference)) return

    void playChatNotificationSound(chatSoundId, burstCount).catch(() => undefined)
  }, [chatSoundId, chatSoundPreference, state.appSettings, state.sidebarData])

  // Memory surfaces fail closed until the server's feature policy resolves.
  if (conditionPolicyForGuide === null) {
    return (
      <div className="flex h-[100dvh] min-h-[100dvh] items-center justify-center bg-background px-6 text-sm text-muted-foreground">
        {conditionPolicyLoadFailed ? (
          <div className="flex max-w-sm flex-col items-center gap-3 text-center">
            <p>Could not reach the MemoSync server. Retry once it is running.</p>
            <Button variant="outline" onClick={() => window.location.reload()}>Reload</Button>
          </div>
        ) : (
          <p>Loading…</p>
        )}
      </div>
    )
  }

  return (
    <MemoryBoardLauncherProvider onOpenMemoryBoard={handleOpenMemoryBoard}>
      <div className="flex h-[100dvh] min-h-[100dvh] overflow-hidden">
        {sidebarElement}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {memoryBoardRequest ? (
            <ManualMemoryBoardOverlay
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
  const auth = useAppAuthState()

  if (auth.state.status === "checking") {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background text-sm text-muted-foreground">
        Checking session…
      </div>
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
