import { translateUiText } from "../../i18n/uiText"
import { t, useI18n, getLocale } from "../../i18n"
import { useCallback, useEffect, useRef, useState } from "react"
import type {
  BranchActionFailure,
  BranchActionSuccess,
  ChatBranchListEntry,
  ChatBranchListResult,
  ChatCheckoutBranchResult,
  ChatCreateBranchResult,
  ChatMergeBranchResult,
  ChatMergePreviewResult,
  ChatSyncResult,
  DiffCommitMode,
  DiffCommitResult,
  GitHubPublishInfo,
  GitHubRepoAvailabilityResult,
} from "../../../shared/types"
import { useAppDialog } from "../../components/ui/app-dialog"
import type { AppState } from "../useAppState"
import {
  DIFF_REFRESH_INTERVAL_MS,
  EMPTY_DIFF_SNAPSHOT,
  getIgnoreFolderEntryFromDiffPath,
  resolveDiffFilePath,
  serializeBranchSelection,
} from "./utils"

export { EMPTY_DIFF_SNAPSHOT }

interface UseChatPageSidebarActionsArgs {
  state: AppState
  projectId: string | null
  showRightSidebar: boolean
}

export function useChatPageSidebarActions({
  state,
  projectId,
  showRightSidebar,
}: UseChatPageSidebarActionsArgs) {
  useI18n()
  const dialog = useAppDialog()
  const [diffRenderMode, setDiffRenderMode] = useState<"unified" | "split">("unified")
  const [wrapDiffLines, setWrapDiffLines] = useState(false)
  const terminalDiffRefreshTimeoutRef = useRef<number | null>(null)
  const wasProcessingRef = useRef(false)
  const lastProjectGitRefreshProjectIdRef = useRef<string | null>(null)
  const activeChatIdRef = useRef<string | null>(state.activeChatId)
  const projectPathRef = useRef<string | null>(state.runtime?.localPath ?? state.navbarLocalPath ?? null)

  useEffect(() => {
    activeChatIdRef.current = state.activeChatId
  }, [state.activeChatId])

  useEffect(() => {
    projectPathRef.current = state.runtime?.localPath ?? state.navbarLocalPath ?? null
  }, [state.navbarLocalPath, state.runtime?.localPath])

  const refreshProjectGitSnapshot = useCallback(() => {
    const chatId = activeChatIdRef.current
    if (!chatId) {
      return
    }
    void state.socket.command({ type: "chat.refreshDiffs", chatId }).catch(() => {})
  }, [state.socket])

  const refreshDiffs = useCallback(() => {
    const chatId = activeChatIdRef.current
    if (!chatId || !showRightSidebar || document.visibilityState !== "visible") {
      return
    }
    void state.socket.command({ type: "chat.refreshDiffs", chatId }).catch(() => {})
  }, [showRightSidebar, state.socket])

  const scheduleTerminalDiffRefresh = useCallback(() => {
    if (!activeChatIdRef.current || !showRightSidebar) {
      return
    }
    if (terminalDiffRefreshTimeoutRef.current !== null) {
      window.clearTimeout(terminalDiffRefreshTimeoutRef.current)
    }
    terminalDiffRefreshTimeoutRef.current = window.setTimeout(() => {
      terminalDiffRefreshTimeoutRef.current = null
      refreshDiffs()
    }, 1_000)
  }, [refreshDiffs, showRightSidebar])

  const handleCopyDiffFilePath = useCallback((filePath: string) => {
    const projectPath = projectPathRef.current
    void state.handleCopyPath(resolveDiffFilePath(projectPath, filePath))
  }, [state.handleCopyPath])

  const handleCopyDiffRelativePath = useCallback((filePath: string) => {
    void state.handleCopyPath(filePath)
  }, [state.handleCopyPath])

  const handleLoadDiffPatch = useCallback(async (filePath: string) => {
    if (!projectId) {
      throw new Error(t("sidebar:projectNotFound"))
    }
    const result = await state.socket.command<{ patch: string }>({
      type: "project.readDiffPatch",
      projectId,
      path: filePath,
    })
    return result.patch
  }, [projectId, state.socket, getLocale()])

  const handleDiscardDiffFile = useCallback((filePath: string) => {
    const chatId = activeChatIdRef.current
    if (!chatId) return

    void (async () => {
      const confirmed = await dialog.confirm({
        title: t("sidebar:discardChanges"),
        description: t("sidebar:discardChangesForValue0ThisCannotBeUndone", { v0: filePath }),
        confirmLabel: t("sidebar:discard"),
        confirmVariant: "destructive",
      })
      if (!confirmed) return

      try {
        await state.socket.command({
          type: "chat.discardDiffFile",
          chatId,
          path: filePath,
        })
      } catch (error) {
        await dialog.alert({
          title: t("sidebar:discardFailed"),
          description: error instanceof Error ? error.message : String(error),
          closeLabel: t("common:ok"),
        })
      }
    })()
  }, [dialog, state.socket, getLocale()])

  const handleIgnoreDiffFile = useCallback((filePath: string) => {
    const chatId = activeChatIdRef.current
    if (!chatId) return

    void (async () => {
      const confirmed = await dialog.confirm({
        title: t("sidebar:ignoreFile"),
        description: t("sidebar:addValue0ToGitignore", { v0: filePath }),
        confirmLabel: t("sidebar:ignore"),
        confirmVariant: "destructive",
      })
      if (!confirmed) return

      try {
        await state.socket.command({
          type: "chat.ignoreDiffFile",
          chatId,
          path: filePath,
        })
      } catch (error) {
        await dialog.alert({
          title: t("sidebar:ignoreFailed"),
          description: error instanceof Error ? error.message : String(error),
          closeLabel: t("common:ok"),
        })
      }
    })()
  }, [dialog, state.socket, getLocale()])

  const handleIgnoreDiffFolder = useCallback((filePath: string) => {
    const chatId = activeChatIdRef.current
    if (!chatId) return

    const initialValue = getIgnoreFolderEntryFromDiffPath(filePath)
    if (!initialValue) return

    void (async () => {
      const ignorePath = await dialog.prompt({
        title: t("sidebar:ignoreFolder"),
        description: t("sidebar:editTheFolderPatternToAddToGitignore"),
        initialValue,
        confirmLabel: t("sidebar:ignore"),
      })
      if (!ignorePath) return

      try {
        await state.socket.command({
          type: "chat.ignoreDiffFile",
          chatId,
          path: ignorePath,
        })
      } catch (error) {
        await dialog.alert({
          title: t("sidebar:ignoreFailed"),
          description: error instanceof Error ? error.message : String(error),
          closeLabel: t("common:ok"),
        })
      }
    })()
  }, [dialog, state.socket, getLocale()])

  const handleOpenDiffInFinder = useCallback((filePath: string) => {
    void state.handleOpenExternalPath("open_finder", filePath)
  }, [state.handleOpenExternalPath])

  const handleCommitDiffs = useCallback(async (args: { paths: string[]; summary: string; description: string; mode: DiffCommitMode }) => {
    const chatId = activeChatIdRef.current
    if (!chatId) {
      return null
    }
    try {
      const result = await state.socket.command<DiffCommitResult>({
        type: "chat.commitDiffs",
        chatId,
        paths: args.paths,
        summary: args.summary,
        description: args.description,
        mode: args.mode,
      })
      if (result.snapshotChanged) {
        refreshDiffs()
      }
      if (!result.ok) {
        await dialog.alert({
          title: translateUiText(result.title),
          description: result.localCommitCreated
            ? `${translateUiText(result.message)}\n\n${translateUiText("A local commit was created, but the push did not complete.")}${result.detail ? `\n\n${result.detail}` : ""}`
            : `${translateUiText(result.message)}${result.detail ? `\n\n${result.detail}` : ""}`,
          closeLabel: t("common:ok"),
        })
      }
      return result
    } catch (error) {
      await dialog.alert({
        title: t("sidebar:commitFailed"),
        description: error instanceof Error ? error.message : String(error),
        closeLabel: t("common:ok"),
      })
      return null
    }
  }, [dialog, refreshDiffs, state.socket, getLocale()])

  const handleSyncBranch = useCallback(async (action: "fetch" | "pull" | "push" | "publish") => {
    const chatId = activeChatIdRef.current
    if (!chatId) {
      return null
    }

    try {
      const result = await state.socket.command<ChatSyncResult>({
        type: "chat.syncBranch",
        chatId,
        action,
      })
      if (result.snapshotChanged) {
        refreshDiffs()
      }
      if (!result.ok) {
        await dialog.alert({
          title: translateUiText(result.title),
          description: `${translateUiText(result.message)}${result.detail ? `\n\n${result.detail}` : ""}`,
          closeLabel: t("common:ok"),
        })
      }
      return result
    } catch (error) {
      await dialog.alert({
        title: t("sidebar:gitSyncFailed"),
        description: error instanceof Error ? error.message : String(error),
        closeLabel: t("common:ok"),
      })
      return null
    }
  }, [dialog, refreshDiffs, state.socket, getLocale()])

  const handleGenerateCommitMessage = useCallback(async (args: { paths: string[] }) => {
    const chatId = activeChatIdRef.current
    if (!chatId) {
      return { subject: "", body: "" }
    }

    try {
      const result = await state.socket.command<{ subject: string; body: string }>({
        type: "chat.generateCommitMessage",
        chatId,
        paths: args.paths,
      })

      return {
        subject: result.subject,
        body: result.body,
      }
    } catch (error) {
      // Every other Git action surfaces failures via dialog.alert; this one
      // silently swallowed them, leaving the user with an empty box and no clue
      // (BUG PANEL-5). Especially likely on the DeepSeek deployment (AGENT-6).
      await dialog.alert({
        title: t("sidebar:couldnTGenerateACommitMessage"),
        description: error instanceof Error ? error.message : String(error),
        closeLabel: t("common:ok"),
      })
      return { subject: "", body: "" }
    }
  }, [dialog, state.socket, getLocale()])

  const handleInitializeGit = useCallback(async () => {
    const chatId = activeChatIdRef.current
    if (!chatId) {
      return null
    }

    try {
      const result = await state.socket.command<BranchActionSuccess | BranchActionFailure>({
        type: "chat.initGit",
        chatId,
      })
      if (result.snapshotChanged) {
        refreshProjectGitSnapshot()
      }
      if (!result.ok) {
        await dialog.alert({
          title: translateUiText(result.title),
          description: `${translateUiText(result.message)}${result.detail ? `\n\n${result.detail}` : ""}`,
          closeLabel: t("common:ok"),
        })
      }
      return result
    } catch (error) {
      await dialog.alert({
        title: t("sidebar:initializeGitFailed"),
        description: error instanceof Error ? error.message : String(error),
        closeLabel: t("common:ok"),
      })
      return null
    }
  }, [dialog, refreshProjectGitSnapshot, state.socket, getLocale()])

  const handleGetGitHubPublishInfo = useCallback(async () => {
    const chatId = activeChatIdRef.current
    if (!chatId) {
      return {
        ghInstalled: false,
        authenticated: false,
        owners: [],
        suggestedRepoName: "my-repo",
      } satisfies GitHubPublishInfo
    }

    return await state.socket.command<GitHubPublishInfo>({
      type: "chat.getGitHubPublishInfo",
      chatId,
    })
  }, [state.socket])

  const handleCheckGitHubRepoAvailability = useCallback(async (args: { owner: string; name: string }) => {
    const chatId = activeChatIdRef.current
    if (!chatId) {
      return {
        available: false,
        message: t("sidebar:noActiveChat"),
      } satisfies GitHubRepoAvailabilityResult
    }

    return await state.socket.command<GitHubRepoAvailabilityResult>({
      type: "chat.checkGitHubRepoAvailability",
      chatId,
      owner: args.owner,
      name: args.name,
    })
  }, [state.socket, getLocale()])

  const handleSetupGitHub = useCallback(async (args: {
    owner: string
    name: string
    visibility: "public" | "private"
    description: string
  }) => {
    const chatId = activeChatIdRef.current
    if (!chatId) {
      return null
    }

    try {
      const result = await state.socket.command<BranchActionSuccess | BranchActionFailure>({
        type: "chat.publishToGitHub",
        chatId,
        owner: args.owner,
        name: args.name,
        visibility: args.visibility,
        description: args.description.trim() || undefined,
      })
      if (result.snapshotChanged) {
        refreshProjectGitSnapshot()
      }
      if (!result.ok) {
        await dialog.alert({
          title: translateUiText(result.title),
          description: `${translateUiText(result.message)}${result.detail ? `\n\n${result.detail}` : ""}`,
          closeLabel: t("common:ok"),
        })
      }
      return result
    } catch (error) {
      await dialog.alert({
        title: t("sidebar:publishFailed"),
        description: error instanceof Error ? error.message : String(error),
        closeLabel: t("common:ok"),
      })
      return null
    }
  }, [dialog, refreshProjectGitSnapshot, state.socket, getLocale()])

  const handleListBranches = useCallback(async () => {
    const chatId = activeChatIdRef.current
    if (!chatId) {
      return {
        recent: [],
        local: [],
        remote: [],
        pullRequests: [],
        pullRequestsStatus: "unavailable",
      } satisfies ChatBranchListResult
    }

    return await state.socket.command<ChatBranchListResult>({
      type: "chat.listBranches",
      chatId,
    })
  }, [state.socket])

  const handleCheckoutBranch = useCallback(async (branch: ChatBranchListEntry) => {
    const chatId = activeChatIdRef.current
    if (!chatId) {
      return
    }

    let bringChanges = false
    if ((state.chatDiffSnapshot?.files.length ?? 0) > 0) {
      const confirmed = await dialog.confirm({
        title: t("sidebar:bringChanges"),
        description: t("sidebar:youHaveUncommittedChangesBringThemToValue0", { v0: branch.name }),
        confirmLabel: t("sidebar:bringChanges2"),
        cancelLabel: t("sidebar:stayHere"),
      })
      if (!confirmed) {
        return
      }
      bringChanges = true
    }

    try {
      const result = await state.socket.command<ChatCheckoutBranchResult>({
        type: "chat.checkoutBranch",
        chatId,
        branch: serializeBranchSelection(branch),
        bringChanges,
      })

      if (result.snapshotChanged) {
        refreshDiffs()
      }
      if (!result.ok && !result.cancelled) {
        await dialog.alert({
          title: translateUiText(result.title),
          description: `${translateUiText(result.message)}${result.detail ? `\n\n${result.detail}` : ""}`,
          closeLabel: t("common:ok"),
        })
      }
    } catch (error) {
      await dialog.alert({
        title: t("sidebar:checkoutFailed"),
        description: error instanceof Error ? error.message : String(error),
        closeLabel: t("common:ok"),
      })
    }
  }, [dialog, refreshDiffs, state.chatDiffSnapshot?.files.length, state.socket, getLocale()])

  const handlePreviewMergeBranch = useCallback(async (branch: ChatBranchListEntry) => {
    const chatId = activeChatIdRef.current
    if (!chatId) {
      return {
        currentBranchName: undefined,
        targetBranchName: branch.name,
        targetDisplayName: branch.displayName,
        status: "error",
        commitCount: 0,
        hasConflicts: false,
        message: t("sidebar:mergePreviewUnavailable"),
      } satisfies ChatMergePreviewResult
    }

    return await state.socket.command<ChatMergePreviewResult>({
      type: "chat.previewMergeBranch",
      chatId,
      branch: serializeBranchSelection(branch),
    })
  }, [state.socket, getLocale()])

  const handleMergeBranch = useCallback(async (branch: ChatBranchListEntry) => {
    const chatId = activeChatIdRef.current
    if (!chatId) {
      return null
    }

    try {
      const result = await state.socket.command<ChatMergeBranchResult>({
        type: "chat.mergeBranch",
        chatId,
        branch: serializeBranchSelection(branch),
      })

      if (result.snapshotChanged) {
        refreshDiffs()
      }
      if (!result.ok) {
        await dialog.alert({
          title: translateUiText(result.title),
          description: `${translateUiText(result.message)}${result.detail ? `\n\n${result.detail}` : ""}`,
          closeLabel: t("common:ok"),
        })
      }
      return result
    } catch (error) {
      await dialog.alert({
        title: t("sidebar:mergeFailed"),
        description: error instanceof Error ? error.message : String(error),
        closeLabel: t("common:ok"),
      })
      return null
    }
  }, [dialog, refreshDiffs, state.socket, getLocale()])

  const handleCreateBranch = useCallback(async () => {
    const chatId = activeChatIdRef.current
    if (!chatId) {
      return
    }

    const name = await dialog.prompt({
      title: t("sidebar:newBranch"),
      description: t("sidebar:enterABranchName"),
      placeholder: "feature/my-branch",
      confirmLabel: t("common:create"),
    })
    if (!name) {
      return
    }

    const branchList = await handleListBranches()
    const currentBranchName = branchList.currentBranchName
    const defaultBranchName = branchList.defaultBranchName

    let baseBranchName = defaultBranchName
    if (defaultBranchName && currentBranchName && defaultBranchName !== currentBranchName) {
      const createFromCurrent = await dialog.confirm({
        title: t("sidebar:branchBase"),
        description: t("sidebar:createValue0FromValue1InsteadOfValue2", { v0: name, v1: currentBranchName, v2: defaultBranchName }),
        confirmLabel: t("sidebar:fromValue0", { v0: currentBranchName }),
        cancelLabel: t("sidebar:fromValue0", { v0: defaultBranchName }),
      })
      baseBranchName = createFromCurrent ? currentBranchName : defaultBranchName
    }

    try {
      const result = await state.socket.command<ChatCreateBranchResult>({
        type: "chat.createBranch",
        chatId,
        name,
        baseBranchName,
      })

      if (result.snapshotChanged) {
        refreshDiffs()
      }
      if (!result.ok) {
        await dialog.alert({
          title: translateUiText(result.title),
          description: `${translateUiText(result.message)}${result.detail ? `\n\n${result.detail}` : ""}`,
          closeLabel: t("common:ok"),
        })
      }
    } catch (error) {
      await dialog.alert({
        title: t("sidebar:createBranchFailed"),
        description: error instanceof Error ? error.message : String(error),
        closeLabel: t("common:ok"),
      })
    }
  }, [dialog, handleListBranches, refreshDiffs, state.socket, getLocale()])

  useEffect(() => {
    if (!projectId || !showRightSidebar) {
      return
    }

    const intervalId = window.setInterval(() => {
      refreshDiffs()
    }, DIFF_REFRESH_INTERVAL_MS)

    return () => window.clearInterval(intervalId)
  }, [projectId, refreshDiffs, showRightSidebar])

  useEffect(() => {
    if (!projectId || !showRightSidebar) {
      return
    }

    refreshDiffs()
  }, [projectId, refreshDiffs, showRightSidebar])

  useEffect(() => {
    if (!projectId || !state.activeChatId) {
      return
    }
    if (lastProjectGitRefreshProjectIdRef.current === projectId) {
      return
    }
    lastProjectGitRefreshProjectIdRef.current = projectId
    refreshProjectGitSnapshot()
  }, [projectId, refreshProjectGitSnapshot, state.activeChatId])

  useEffect(() => {
    if (!projectId || !showRightSidebar) {
      return
    }

    function handleDiffRefresh() {
      if (document.visibilityState !== "visible") return
      refreshDiffs()
    }

    window.addEventListener("focus", handleDiffRefresh)
    document.addEventListener("visibilitychange", handleDiffRefresh)

    return () => {
      window.removeEventListener("focus", handleDiffRefresh)
      document.removeEventListener("visibilitychange", handleDiffRefresh)
    }
  }, [projectId, refreshDiffs, showRightSidebar])

  useEffect(() => {
    if (showRightSidebar && wasProcessingRef.current && !state.isProcessing) {
      refreshDiffs()
    }
    wasProcessingRef.current = state.isProcessing
  }, [refreshDiffs, showRightSidebar, state.isProcessing])

  useEffect(() => {
    return () => {
      if (terminalDiffRefreshTimeoutRef.current !== null) {
        window.clearTimeout(terminalDiffRefreshTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (showRightSidebar) {
      return
    }
    if (terminalDiffRefreshTimeoutRef.current !== null) {
      window.clearTimeout(terminalDiffRefreshTimeoutRef.current)
      terminalDiffRefreshTimeoutRef.current = null
    }
  }, [projectId, showRightSidebar])

  return {
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
    handleGetGitHubPublishInfo,
    handleCheckGitHubRepoAvailability,
    handleSetupGitHub,
    handleListBranches,
    handleCheckoutBranch,
    handlePreviewMergeBranch,
    handleMergeBranch,
    handleCreateBranch,
  }
}
