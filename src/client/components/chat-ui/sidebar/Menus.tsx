import { t, useI18n } from "../../../i18n"
import type { ReactNode } from "react"
import { Archive, Copy, EyeOff, FolderOpen, Pencil, Split, Trash2, UserRoundPlus } from "lucide-react"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../../ui/context-menu"

export function ProjectSectionMenu({
  onRename,
  onCopyPath,
  onShowArchived,
  onOpenInFinder,
  onHide,
  children,
}: {
  onRename: () => void
  onCopyPath: () => void
  onShowArchived: () => void
  onOpenInFinder: () => void
  onHide: () => void
  children: ReactNode
}) {
  useI18n()
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={(event) => {
            event.preventDefault()
            onRename()
          }}
        >
          <Pencil className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">{t("sidebar:rename")}</span>
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={(event) => {
            event.stopPropagation()
            onCopyPath()
          }}
        >
          <Copy className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">{t("common:copyPath2")}</span>
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={(event) => {
            event.stopPropagation()
            onShowArchived()
          }}
        >
          <Archive className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">{t("sidebar:showArchived")}</span>
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={(event) => {
            event.stopPropagation()
            onOpenInFinder()
          }}
        >
          <FolderOpen className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">{t("sidebar:showInFinder")}</span>
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={(event) => {
            event.stopPropagation()
            onHide()
          }}
        >
          <EyeOff className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">{t("common:hide")}</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export function ChatRowMenu({
  showFork = true,
  canFork,
  onRename,
  onShare,
  onOpenInFinder,
  onFork,
  onArchive,
  onDelete,
  children,
}: {
  showFork?: boolean
  canFork?: boolean
  onRename: () => void
  onShare: () => void
  onOpenInFinder: () => void
  onFork: () => void
  onArchive: () => void
  onDelete: () => void
  children: ReactNode
}) {
  useI18n()
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={(event) => {
            event.preventDefault()
            onRename()
          }}
        >
          <Pencil className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">{t("sidebar:rename")}</span>
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={(event) => {
            event.preventDefault()
            onShare()
          }}
        >
          <UserRoundPlus className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">{t("sidebar:share")}</span>
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={(event) => {
            event.preventDefault()
            onOpenInFinder()
          }}
        >
          <FolderOpen className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">{t("sidebar:openInFinder")}</span>
        </ContextMenuItem>
        {showFork ? (
          <ContextMenuItem
            disabled={!canFork}
            onSelect={(event) => {
              event.preventDefault()
              if (!canFork) return
              onFork()
            }}
          >
            <Split className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">{t("sidebar:fork")}</span>
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem
          onSelect={(event) => {
            event.preventDefault()
            onArchive()
          }}
        >
          <Archive className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">{t("common:archive")}</span>
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={(event) => {
            event.preventDefault()
            onDelete()
          }}
          className="text-destructive dark:text-red-400 hover:bg-destructive/10 focus:bg-destructive/10 dark:hover:bg-red-500/20 dark:focus:bg-red-500/20"
        >
          <Trash2 className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">{t("common:delete")}</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
