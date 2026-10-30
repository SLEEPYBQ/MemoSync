import { afterEach, describe, expect, mock, test } from "bun:test"
import { createElement, type ReactNode } from "react"
import { renderToStaticMarkup as renderStatic } from "react-dom/server"
import { GitPanel, MergePreviewSummary, canIgnoreDiffFile, canIgnoreDiffFolder, getPrimaryCommitActionPrefix, shouldLoadDiffPatchNow } from "./GitPanel"
import { i18n } from "../../i18n"
import { localizeUiResult } from "../../i18n/uiText"
import { withUiTextFields } from "../../../shared/ui-copy"
import type { ChatMergePreviewResult } from "../../../shared/types"
import { TooltipProvider } from "../ui/tooltip"
import { ThemeProvider } from "../../hooks/useTheme"

function renderToStaticMarkup(element: ReactNode) {
  return renderStatic(createElement(ThemeProvider, null, element))
}

afterEach(() => { void i18n.changeLanguage("en") })

describe("GitPanel", () => {
  test("loads missing patches for expanded rows", () => {
    expect(shouldLoadDiffPatchNow({
      isCollapsed: false,
      hasPreviewAttachment: false,
      patch: undefined,
      patchError: undefined,
      isPatchLoading: false,
    })).toBe(true)
  })

  test("does not load patches for collapsed rows", () => {
    expect(shouldLoadDiffPatchNow({
      isCollapsed: true,
      hasPreviewAttachment: false,
      patch: undefined,
      patchError: undefined,
      isPatchLoading: false,
    })).toBe(false)
  })

  test("does not load patches for preview attachments", () => {
    expect(shouldLoadDiffPatchNow({
      isCollapsed: false,
      hasPreviewAttachment: true,
      patch: undefined,
      patchError: undefined,
      isPatchLoading: false,
    })).toBe(false)
  })

  test("does not load patches when patch content, loading state, or errors already exist", () => {
    expect(shouldLoadDiffPatchNow({
      isCollapsed: false,
      hasPreviewAttachment: false,
      patch: "diff --git a/app.ts b/app.ts",
      patchError: undefined,
      isPatchLoading: false,
    })).toBe(false)

    expect(shouldLoadDiffPatchNow({
      isCollapsed: false,
      hasPreviewAttachment: false,
      patch: undefined,
      patchError: "Failed to load patch",
      isPatchLoading: false,
    })).toBe(false)

    expect(shouldLoadDiffPatchNow({
      isCollapsed: false,
      hasPreviewAttachment: false,
      patch: undefined,
      patchError: undefined,
      isPatchLoading: true,
    })).toBe(false)
  })

  test("defaults to history when there are no changes", () => {
    const markup = renderToStaticMarkup(createElement(
      TooltipProvider,
      null,
      createElement(GitPanel, {
        projectId: "project-1",
        diffs: {
          status: "ready",
          branchName: "main",
          defaultBranchName: "main",
          files: [],
          branchHistory: {
            entries: [{
              sha: "abc123",
              summary: "Initial commit",
              description: "Set up the project",
              authorName: "Kanna",
              authoredAt: new Date(Date.now() - 60_000).toISOString(),
              tags: ["v1.0.0"],
              githubUrl: "https://github.com/acme/repo/commit/abc123",
            }],
          },
        },
        diffRenderMode: "unified",
        wrapLines: false,
        onOpenInFinder: () => {},
        onDiscardFile: () => {},
        onIgnoreFile: () => {},
        onIgnoreFolder: () => {},
        onCopyFilePath: () => {},
        onCopyRelativePath: () => {},
        onLoadPatch: async () => "",
        onListBranches: async () => ({ recent: [], local: [], remote: [], pullRequests: [], pullRequestsStatus: "unavailable" }),
        onCheckoutBranch: async () => {},
        onCreateBranch: async () => {},
        onGenerateCommitMessage: async () => ({ subject: "", body: "" }),
        onCommit: async () => null,
        onSyncWithRemote: async () => null,
        onDiffRenderModeChange: () => {},
        onWrapLinesChange: () => {},
        onClose: () => {},
      })
    ))

    expect(markup).toContain("History")
    expect(markup).toContain("Initial commit")
    expect(markup).toContain("main")
    expect(markup).not.toContain("No file changes.")
  })

  test("defaults to changes when there are file changes", () => {
    const onClose = mock(() => {})
    const markup = renderToStaticMarkup(createElement(
      TooltipProvider,
      null,
      createElement(GitPanel, {
        projectId: "project-1",
        diffs: {
          status: "ready",
          branchName: "main",
          defaultBranchName: "main",
          behindCount: 3,
          hasOriginRemote: true,
          hasUpstream: true,
          originRepoSlug: "acme/repo",
          files: [{
            path: "src/app.ts",
            changeType: "modified",
            isUntracked: false,
            additions: 1,
            deletions: 1,
            patchDigest: "digest-1",
          }],
          branchHistory: { entries: [] },
        },
        diffRenderMode: "unified",
        wrapLines: false,
        onOpenInFinder: () => {},
        onDiscardFile: () => {},
        onIgnoreFile: () => {},
        onIgnoreFolder: () => {},
        onCopyFilePath: () => {},
        onCopyRelativePath: () => {},
        onLoadPatch: async () => "",
        onListBranches: async () => ({ recent: [], local: [], remote: [], pullRequests: [], pullRequestsStatus: "unavailable" }),
        onCheckoutBranch: async () => {},
        onCreateBranch: async () => {},
        onGenerateCommitMessage: async () => ({ subject: "", body: "" }),
        onCommit: async () => null,
        onSyncWithRemote: async () => null,
        onDiffRenderModeChange: () => {},
        onWrapLinesChange: () => {},
        onClose,
      })
    ))

    expect(markup).toContain("src/app.ts")
    expect(markup).toContain("Open branch switcher")
    expect(markup).toContain("Pull")
    expect(markup).toContain("3")
    expect(markup).toContain("Generate &amp; push to")
    expect(markup).toContain("Generate commit message")
    expect(markup).not.toContain("Publish Branch")
  })

  for (const language of ["en", "zh-CN"] as const) {
    test(`labels every idle and in-flight commit action in ${language}`, async () => {
      await i18n.changeLanguage(language)
      const idle = {
        hasSummary: false,
        isGenerating: false,
        isCommitting: false,
        isGeneratedCommitInFlight: false,
        commitModeInFlight: null,
        primaryCommitMode: "commit_and_push",
      } as const
      const cases: [Partial<Parameters<typeof getPrimaryCommitActionPrefix>[0]>, string, string][] = [
        [{}, "Generate & push to", "生成提交信息并推送到"],
        [{ primaryCommitMode: "commit_only" }, "Generate & commit to", "生成提交信息并提交到"],
        [{ hasSummary: true }, "Commit & push to", "提交并推送到"],
        [{ hasSummary: true, primaryCommitMode: "commit_only" }, "Commit to", "提交到"],
        [{ isGenerating: true }, "Generating...", "正在生成…"],
        // In-flight mode wins even if the next action's mode has changed.
        [{ hasSummary: true, isCommitting: true, commitModeInFlight: "commit_only" }, "Committing...", "正在提交…"],
        [{ hasSummary: true, isCommitting: true, commitModeInFlight: "commit_and_push", primaryCommitMode: "commit_only" }, "Committing & Pushing...", "正在提交并推送…"],
        [{ hasSummary: true, isCommitting: true, isGeneratedCommitInFlight: true, commitModeInFlight: "commit_only" }, "Committing...", "正在提交…"],
        [{ hasSummary: true, isCommitting: true, isGeneratedCommitInFlight: true, commitModeInFlight: "commit_and_push" }, "Pushing...", "正在推送…"],
      ]
      for (const [state, english, chinese] of cases) {
        expect(getPrimaryCommitActionPrefix({ ...idle, ...state })).toBe(language === "en" ? english : chinese)
      }
    })
  }

  const mergePreviews: [ChatMergePreviewResult["status"], string, string, string?][] = [
    ["mergeable", "2 commits from feature/test will merge into main.", "将从 feature/test 向 main 合并 2 个提交。"],
    ["mergeable", "1 commit from feature/test will merge into main.", "将从 feature/test 向 main 合并 1 个提交。"],
    ["conflicts", "2 commits from feature/test would merge into main, but conflicts are expected.", "将从 feature/test 向 main 合并 2 个提交，但预计会产生冲突。"],
    ["conflicts", "1 commit from feature/test would merge into main, but conflicts are expected.", "将从 feature/test 向 main 合并 1 个提交，但预计会产生冲突。"],
    ["mergeable", "1 commit from feature/test will merge into the current branch.", "将从 feature/test 向 当前分支 合并 1 个提交。", "1 commit from feature/test will merge into current branch."],
    ["up_to_date", "main is already up to date with feature/test.", "main 已与 feature/test 保持同步。"],
    ["error", "Could not preview this merge.", "无法预览此合并。"],
    ["error", "Merge preview unavailable.", "合并预览不可用。"],
  ]

  for (const [status, message, chinese, english = message] of mergePreviews) {
    test(`renders ${status} preview copy in both languages: ${message}`, async () => {
      const preview: ChatMergePreviewResult = {
        currentBranchName: "main",
        targetBranchName: "feature/test",
        targetDisplayName: "feature/test",
        status,
        commitCount: message.startsWith("1 ") ? 1 : 2,
        hasConflicts: status === "conflicts",
        message,
        detail: "CONFLICT in src/New Chat.ts: check Git output",
      }
      // Exercise the same metadata + localizer path as a WebSocket ack.
      await i18n.changeLanguage("zh-CN")
      const received = localizeUiResult(withUiTextFields(preview))
      expect(received.message).toBe(chinese)
      const render = (value: ChatMergePreviewResult) => renderToStaticMarkup(createElement(MergePreviewSummary, { preview: value }))
      expect(render(received)).toContain(chinese)
      // Older servers and direct callbacks may supply only the English copy.
      expect(render(preview)).toContain(chinese)
      expect(render(received)).toContain(preview.detail!)
      expect(preview.message).toBe(message)
      // A preview already received in Chinese must re-render after switching.
      await i18n.changeLanguage("en")
      expect(render(received)).toContain(english)
      expect(render(preview)).toContain(english)
      await i18n.changeLanguage("zh-CN")
      expect(render(received)).toContain(chinese)
    })
  }

  test("renders the branch switcher affordance", () => {
    const onClose = mock(() => {})
    const markup = renderToStaticMarkup(createElement(
      TooltipProvider,
      null,
      createElement(GitPanel, {
        projectId: "project-1",
        diffs: { status: "unknown", files: [], branchHistory: { entries: [] } },
        diffRenderMode: "unified",
        wrapLines: false,
        onOpenInFinder: () => {},
        onDiscardFile: () => {},
        onIgnoreFile: () => {},
        onIgnoreFolder: () => {},
        onCopyFilePath: () => {},
        onCopyRelativePath: () => {},
        onLoadPatch: async () => "",
        onListBranches: async () => ({ recent: [], local: [], remote: [], pullRequests: [], pullRequestsStatus: "unavailable" }),
        onCheckoutBranch: async () => {},
        onCreateBranch: async () => {},
        onGenerateCommitMessage: async () => ({ subject: "", body: "" }),
        onCommit: async () => null,
        onSyncWithRemote: async () => null,
        onDiffRenderModeChange: () => {},
        onWrapLinesChange: () => {},
        onClose,
      })
    ))

    expect(markup).toContain("Open branch switcher")
  })

  test("does not show a detached-head branch control before git is initialized", () => {
    const markup = renderToStaticMarkup(createElement(
      TooltipProvider,
      null,
      createElement(GitPanel, {
        projectId: "project-1",
        diffs: { status: "no_repo", files: [], branchHistory: { entries: [] } },
        diffRenderMode: "unified",
        wrapLines: false,
        onOpenInFinder: () => {},
        onDiscardFile: () => {},
        onIgnoreFile: () => {},
        onIgnoreFolder: () => {},
        onCopyFilePath: () => {},
        onCopyRelativePath: () => {},
        onLoadPatch: async () => "",
        onListBranches: async () => ({ recent: [], local: [], remote: [], pullRequests: [], pullRequestsStatus: "unavailable" }),
        onCheckoutBranch: async () => {},
        onCreateBranch: async () => {},
        onGenerateCommitMessage: async () => ({ subject: "", body: "" }),
        onCommit: async () => null,
        onSyncWithRemote: async () => null,
        onDiffRenderModeChange: () => {},
        onWrapLinesChange: () => {},
        onClose: () => {},
        onInitializeGit: async () => null,
      }),
    ))

    expect(markup).toContain("Init Git")
    expect(markup).not.toContain("Detached HEAD")
    expect(markup).not.toContain("Open branch switcher")
  })

  test("shows no publish CTA for a repo without a remote (local-only git)", () => {
    const markup = renderToStaticMarkup(createElement(
      TooltipProvider,
      null,
      createElement(GitPanel, {
        projectId: "project-1",
        diffs: {
          status: "ready",
          branchName: "feature/local-only",
          defaultBranchName: "main",
          hasUpstream: false,
          files: [],
          branchHistory: { entries: [] },
        },
        diffRenderMode: "unified",
        wrapLines: false,
        onOpenInFinder: () => {},
        onDiscardFile: () => {},
        onIgnoreFile: () => {},
        onIgnoreFolder: () => {},
        onCopyFilePath: () => {},
        onCopyRelativePath: () => {},
        onLoadPatch: async () => "",
        onListBranches: async () => ({ recent: [], local: [], remote: [], pullRequests: [], pullRequestsStatus: "unavailable" }),
        onCheckoutBranch: async () => {},
        onCreateBranch: async () => {},
        onGenerateCommitMessage: async () => ({ subject: "", body: "" }),
        onCommit: async () => null,
        onSyncWithRemote: async () => null,
        onDiffRenderModeChange: () => {},
        onWrapLinesChange: () => {},
        onClose: () => {},
      })
    ))

    expect(markup).not.toContain("Push to GitHub")
    expect(markup).not.toContain("PR")
  })

  test("shows open pr for a published non-default branch", () => {
    const markup = renderToStaticMarkup(createElement(
      TooltipProvider,
      null,
      createElement(GitPanel, {
        projectId: "project-1",
        diffs: {
          status: "ready",
          branchName: "feature/branch-switcher",
          defaultBranchName: "main",
          hasOriginRemote: true,
          hasUpstream: true,
          originRepoSlug: "acme/repo",
          files: [],
          branchHistory: { entries: [] },
        },
        diffRenderMode: "unified",
        wrapLines: false,
        onOpenInFinder: () => {},
        onDiscardFile: () => {},
        onIgnoreFile: () => {},
        onIgnoreFolder: () => {},
        onCopyFilePath: () => {},
        onCopyRelativePath: () => {},
        onLoadPatch: async () => "",
        onListBranches: async () => ({ recent: [], local: [], remote: [], pullRequests: [], pullRequestsStatus: "unavailable" }),
        onCheckoutBranch: async () => {},
        onCreateBranch: async () => {},
        onGenerateCommitMessage: async () => ({ subject: "", body: "" }),
        onCommit: async () => null,
        onSyncWithRemote: async () => null,
        onDiffRenderModeChange: () => {},
        onWrapLinesChange: () => {},
        onClose: () => {},
      })
    ))

    expect(markup).toContain("Fetch")
    expect(markup).toContain("PR")
  })

  test("ignores only untracked files", () => {
    expect(canIgnoreDiffFile({
      path: "tmp.log",
      changeType: "added",
      isUntracked: true,
      additions: 0,
      deletions: 0,
      patchDigest: "digest-2",
    })).toBe(true)

    expect(canIgnoreDiffFile({
      path: "src/app.ts",
      changeType: "modified",
      isUntracked: false,
      additions: 0,
      deletions: 0,
      patchDigest: "digest-3",
    })).toBe(false)
  })

  test("ignores folders only for untracked files with a parent directory", () => {
    expect(canIgnoreDiffFolder({
      path: "tmp/cache/output.log",
      changeType: "added",
      isUntracked: true,
      additions: 0,
      deletions: 0,
      patchDigest: "digest-4",
    })).toBe(true)

    expect(canIgnoreDiffFolder({
      path: "scratch.log",
      changeType: "added",
      isUntracked: true,
      additions: 0,
      deletions: 0,
      patchDigest: "digest-5",
    })).toBe(false)

    expect(canIgnoreDiffFolder({
      path: "src/app.ts",
      changeType: "modified",
      isUntracked: false,
      additions: 0,
      deletions: 0,
      patchDigest: "digest-6",
    })).toBe(false)
  })
})
