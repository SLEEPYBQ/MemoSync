import { t, useI18n } from "../../i18n"
import { type MouseEvent as ReactMouseEvent } from "react"
import { BrainCircuit, FolderOpen, GitBranch, Globe, Menu, MoreHorizontal, PanelRight, SquarePen, Terminal } from "lucide-react"
import { SidebarRevealButton } from "../BrandMark"
import { Button } from "../ui/button"
import { CardHeader } from "../ui/card"
import { HotkeyTooltip, HotkeyTooltipContent, HotkeyTooltipTrigger } from "../ui/tooltip"
import { cn } from "../../lib/utils"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../ui/context-menu"

function openContextMenuFromButton(event: ReactMouseEvent<HTMLButtonElement>) {
  event.preventDefault()
  event.stopPropagation()
  const rect = event.currentTarget.getBoundingClientRect()
  event.currentTarget.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.bottom,
    view: window,
  }))
}

function NavbarOverflowMenu({
  showOnDesktop,
  onToggleEmbeddedTerminal,
}: {
  showOnDesktop: boolean
  onToggleEmbeddedTerminal?: () => void
}) {
  useI18n()
  if (!onToggleEmbeddedTerminal) return null

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Button
          variant="ghost"
          size="none"
          onClick={openContextMenuFromButton}
          title={t("chat:moreActions")}
          className={cn(
            "border border-border/0 hover:!border-border/0 size-8 justify-center rounded-lg px-0 hover:!bg-transparent",
            showOnDesktop ? "flex" : "flex md:hidden"
          )}
        >
          <MoreHorizontal strokeWidth={2} className="h-4.5" />
        </Button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {onToggleEmbeddedTerminal ? (
          <ContextMenuItem
            onSelect={(event) => {
              event.preventDefault()
              onToggleEmbeddedTerminal()
            }}
          >
            <Terminal strokeWidth={2} className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">{t("chat:toggleTerminal")}</span>
          </ContextMenuItem>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  )
}

interface Props {
  sidebarCollapsed: boolean
  onOpenSidebar: () => void
  onExpandSidebar: () => void
  onNewChat: () => void
  localPath?: string
  embeddedTerminalVisible?: boolean
  onToggleEmbeddedTerminal?: () => void
  rightPanel?: "hidden" | "git" | "browser" | "memory" | "files"
  onToggleGitPanel?: () => void
  onToggleBrowserPanel?: () => void
  onToggleMemoryPanel?: () => void
  onToggleFilesPanel?: () => void
  terminalShortcut?: string[]
  rightSidebarShortcut?: string[]
  branchName?: string
  hasGitRepo?: boolean
  gitStatus?: "unknown" | "ready" | "no_repo"
  /** When set, show the session-memories popover (mid-session pin editing). */
  memoryChatId?: string
  memoryProjectId?: string
}

export function ChatNavbar({
  sidebarCollapsed,
  onOpenSidebar,
  onExpandSidebar,
  onNewChat,
  localPath,
  embeddedTerminalVisible = false,
  onToggleEmbeddedTerminal,
  rightPanel = "hidden",
  onToggleGitPanel,
  onToggleBrowserPanel,
  onToggleMemoryPanel,
  onToggleFilesPanel,
  terminalShortcut,
  rightSidebarShortcut,
  branchName,
  hasGitRepo = true,
  gitStatus = "unknown",
  memoryChatId,
  memoryProjectId,
}: Props) {
  useI18n()
  const branchLabel = !hasGitRepo
    ? t("chat:setupGit")
    : gitStatus === "unknown"
      ? null
      : (branchName ?? t("chat:detachedHEAD"))
  const rightPanelVisible = rightPanel !== "hidden"
  const handleCloseRightPanel =
    rightPanel === "browser"
      ? onToggleBrowserPanel
      : rightPanel === "git"
        ? onToggleGitPanel
        : rightPanel === "memory"
          ? onToggleMemoryPanel
          : rightPanel === "files"
            ? onToggleFilesPanel
            : undefined
  const showBrowserPanelButton = rightPanel !== "browser"
  const showGitPanelButton = rightPanel !== "git"
  const showFilesPanelButton = rightPanel !== "files"

  return (
    <CardHeader
      className={cn(
        "absolute top-0 left-0 right-0 z-10 pl-2 pr-2 py-2 border-border/0 flex items-center justify-center desktop-mac:md:group-data-[sidebar-collapsed=true]/app:pl-[var(--mac-lights-inset)]"
      )}
    >
      {/* Content fades out well below the controls, so nothing reads through them. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-0 h-[68px] bg-gradient-to-b from-background from-65% to-transparent" />
      <div className="relative flex items-center gap-2 w-full">
        <div className="flex h-8 flex-shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden !h-[auto] hover:!border-border/0 hover:!bg-black/[0.05] dark:hover:!bg-white/[0.08]"
            onClick={onOpenSidebar}
          >
            <Menu className="size-4" />
          </Button>
          {sidebarCollapsed ? <SidebarRevealButton onClick={onExpandSidebar} label={t("chat:expandSidebar")} /> : null}
          <Button
            variant="ghost"
            size="icon"
            className="hover:!border-border/0 hover:!bg-black/[0.05] dark:hover:!bg-white/[0.08]"
            onClick={onNewChat}
            title={t("chat:compose")}
          >
            <SquarePen className="size-4" />
          </Button>
        </div>

        <div className="flex-1 min-w-0" />

        {localPath && (onToggleEmbeddedTerminal || onToggleGitPanel || onToggleBrowserPanel) ? (
          <div className="flex items-center gap-0.5 flex-shrink-0">
            {memoryChatId && onToggleMemoryPanel ? (
              <Button
                variant="ghost"
                size="none"
                onClick={onToggleMemoryPanel}
                title={t("chat:sessionMemories")}
                aria-label={t("chat:sessionMemories")}
                className={cn(
                  "border border-border/0 hover:!border-border/0 size-8 justify-center rounded-lg px-0 hover:!bg-transparent",
                  rightPanel === "memory" && "text-foreground",
                )}
              >
                <BrainCircuit strokeWidth={2.25} className="h-4" />
              </Button>
            ) : null}
            {(onToggleEmbeddedTerminal || onToggleGitPanel || onToggleBrowserPanel) ? (
              <div className="flex h-8 items-center gap-0.5">
                <NavbarOverflowMenu
                  showOnDesktop={rightPanelVisible}
                  onToggleEmbeddedTerminal={onToggleEmbeddedTerminal}
                />
                {onToggleEmbeddedTerminal ? (
                <HotkeyTooltip>
                  <HotkeyTooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="none"
                      onClick={onToggleEmbeddedTerminal}
                      title={t("chat:toggleTerminal2")}
                      aria-label={t("chat:toggleTerminal2")}
                      aria-pressed={embeddedTerminalVisible}
                      className={cn(
                        rightPanelVisible ? "hidden" : "hidden md:flex",
                        "border border-border/0 hover:!border-border/0 size-8 justify-center rounded-lg px-0 hover:!bg-transparent",
                        embeddedTerminalVisible && "text-foreground"
                      )}
                    >
                      <Terminal strokeWidth={2} className="h-4" />
                    </Button>
                  </HotkeyTooltipTrigger>
                  <HotkeyTooltipContent side="bottom" shortcut={terminalShortcut} />
                </HotkeyTooltip>
              ) : null}
                {onToggleBrowserPanel && showBrowserPanelButton ? (
                  <Button
                    variant="ghost"
                    size="none"
                    onClick={onToggleBrowserPanel}
                    title={t("chat:browser")}
                    aria-label={t("chat:browser")}
                    className={cn(
                      "border border-border/0 hover:!border-border/0 size-8 justify-center rounded-lg px-0 hover:!bg-transparent"
                    )}
                  >
                    <Globe strokeWidth={2.25} className="h-4" />
                  </Button>
                ) : null}
                {onToggleFilesPanel && showFilesPanelButton ? (
                  <Button
                    variant="ghost"
                    size="none"
                    onClick={onToggleFilesPanel}
                    title={t("chat:files2")}
                    aria-label={t("chat:files2")}
                    className={cn(
                      "border border-border/0 hover:!border-border/0 size-8 justify-center rounded-lg px-0 hover:!bg-transparent"
                    )}
                  >
                    <FolderOpen strokeWidth={2.25} className="h-4" />
                  </Button>
                ) : null}
                {onToggleGitPanel && showGitPanelButton ? (
                  <HotkeyTooltip>
                    <HotkeyTooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="none"
                        onClick={onToggleGitPanel}
                        className={cn(
                          "border flex h-8 flex-row items-center gap-1.5 rounded-lg border-border/0 hover:!border-border/0 hover:!bg-black/[0.05] dark:hover:!bg-white/[0.08]",
                          rightPanelVisible ? "w-[38px] justify-center px-0" : "pl-1.5 pr-2"
                        )}
                      >
                        <GitBranch strokeWidth={2.25} className="h-4" />
                        {branchLabel && !rightPanelVisible ? <div className="text-[13px] max-w-[140px] truncate hidden md:block">{branchLabel}</div> : null}
                      </Button>
                    </HotkeyTooltipTrigger>
                    <HotkeyTooltipContent side="bottom" shortcut={rightSidebarShortcut} />
                  </HotkeyTooltip>
                ) : null}
                {rightPanelVisible && handleCloseRightPanel ? (
                  <Button
                    variant="ghost"
                    size="none"
                    onClick={handleCloseRightPanel}
                    title={t("chat:collapseSidebar")}
                    aria-label={t("chat:collapseSidebar")}
                    className="border border-border/0 hover:!border-border/0 size-8 justify-center rounded-lg px-0 hover:!bg-transparent text-foreground"
                  >
                    <PanelRight strokeWidth={2.25} className="h-4" />
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </CardHeader>
  )
}
