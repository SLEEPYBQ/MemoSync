import { t, useI18n } from "../../../i18n"
import { memo, type MouseEvent as ReactMouseEvent, type ReactNode, useMemo, useSyncExternalStore } from "react"
import { ChevronRight, Loader2, MoreHorizontal, SquarePen } from "lucide-react"
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  type ClientRect,
  type CollisionDetection,
  type DragEndEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core"
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { Button } from "../../ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip"
import type { SidebarChatRow, SidebarProjectGroup } from "../../../../shared/types"
import { APP_NAME } from "../../../../shared/branding"
import { getPathBasename } from "../../../lib/formatters"
import { cn } from "../../../lib/utils"
import { SIDEBAR_ROW_CLASS } from "./rowStyles"
import { ProjectSectionMenu } from "./Menus"

interface Props {
  projectGroups: SidebarProjectGroup[]
  collapsedSections: Set<string>
  expandedGroups: Set<string>
  onToggleSection: (key: string) => void
  onToggleExpandedGroup: (key: string) => void
  renderChatRow: (chat: SidebarChatRow) => ReactNode
  onShowArchivedProject?: (projectId: string) => void
  onNewLocalChat?: (localPath: string) => void
  onCopyPath?: (localPath: string) => void
  onOpenExternalPath?: (action: "open_finder", localPath: string) => void
  onRenameProject?: (projectId: string, sidebarTitle: string | undefined, realTitle: string) => void
  onHideProject?: (projectId: string) => void
  onReorderGroups?: (newOrder: string[]) => void
  isConnected?: boolean
  startingLocalPath?: string | null
}

interface SortableProjectGroupProps {
  group: SidebarProjectGroup
  isReorderEnabled: boolean
  collapsedSections: Set<string>
  expandedGroups: Set<string>
  onToggleSection: (key: string) => void
  onToggleExpandedGroup: (key: string) => void
  renderChatRow: (chat: SidebarChatRow) => ReactNode
  onShowArchivedProject?: (projectId: string) => void
  onNewLocalChat?: (localPath: string) => void
  onCopyPath?: (localPath: string) => void
  onOpenExternalPath?: (action: "open_finder", localPath: string) => void
  onRenameProject?: (projectId: string, sidebarTitle: string | undefined, realTitle: string) => void
  onHideProject?: (projectId: string) => void
  isConnected?: boolean
  startingLocalPath?: string | null
}

const DRAG_REORDER_TRIGGER_OFFSET_PX = 20
const SIDEBAR_REORDER_MEDIA_QUERY = "(min-width: 768px)"

function subscribeToSidebarReorderMediaQuery(onChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => undefined
  }

  const mediaQuery = window.matchMedia(SIDEBAR_REORDER_MEDIA_QUERY)
  mediaQuery.addEventListener("change", onChange)
  return () => mediaQuery.removeEventListener("change", onChange)
}

function getSidebarReorderMediaQuerySnapshot() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return true
  }

  return window.matchMedia(SIDEBAR_REORDER_MEDIA_QUERY).matches
}

function useSidebarReorderEnabled() {
  useI18n()
  return useSyncExternalStore(
    subscribeToSidebarReorderMediaQuery,
    getSidebarReorderMediaQuerySnapshot,
    () => true
  )
}

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

type RectLookup = {
  get(id: UniqueIdentifier): ClientRect | undefined
}

function getRectCenterY(rect: Pick<ClientRect, "top" | "height">) {
  return rect.top + rect.height / 2
}

function EmptyProjectChatButton({
  localPath,
  onNewLocalChat,
  isConnected,
  startingLocalPath,
}: {
  localPath: string
  onNewLocalChat: (localPath: string) => void
  isConnected?: boolean
  startingLocalPath?: string | null
}) {
  useI18n()
  const disabled = !isConnected || startingLocalPath === localPath

  return (
    <button
      type="button"
      disabled={disabled}
      title={!isConnected ? t("sidebar:startValue0ToConnect", { v0: APP_NAME }) : t("sidebar:newChat")}
      className={cn(
        SIDEBAR_ROW_CLASS,
        "group w-full gap-2 pl-7 pr-0.5 text-left cursor-pointer",
        disabled && "cursor-not-allowed opacity-50"
      )}
      onClick={() => onNewLocalChat(localPath)}
    >
      <span className="text-[13px] truncate flex-1 text-muted-foreground">
        {t("sidebar:newChat")}</span>
      <div className="h-7 w-6 mr-[2px] shrink-0" aria-hidden />
    </button>
  )
}

export function getProjectGroupReorderPreviewTargetId({
  activeId,
  groupIds,
  collisionRect,
  droppableRects,
}: {
  activeId: string
  groupIds: string[]
  collisionRect: Pick<ClientRect, "top">
  droppableRects: RectLookup
}) {
  const activeIndex = groupIds.indexOf(activeId)
  if (activeIndex === -1) return null

  const activeRect = droppableRects.get(activeId)
  if (!activeRect) return null

  const previewTriggerY = collisionRect.top + DRAG_REORDER_TRIGGER_OFFSET_PX

  if (collisionRect.top > activeRect.top) {
    for (let index = groupIds.length - 1; index > activeIndex; index--) {
      const rect = droppableRects.get(groupIds[index])
      if (!rect) continue
      if (previewTriggerY >= getRectCenterY(rect)) {
        return groupIds[index]
      }
    }

    return activeId
  }

  if (collisionRect.top < activeRect.top) {
    for (let index = 0; index < activeIndex; index++) {
      const rect = droppableRects.get(groupIds[index])
      if (!rect) continue
      if (previewTriggerY <= getRectCenterY(rect)) {
        return groupIds[index]
      }
    }

    return activeId
  }

  return activeId
}

const SortableProjectGroup = memo(function SortableProjectGroup({
  group,
  isReorderEnabled,
  collapsedSections,
  expandedGroups,
  onToggleSection,
  onToggleExpandedGroup,
  renderChatRow,
  onShowArchivedProject,
  onNewLocalChat,
  onCopyPath,
  onOpenExternalPath,
  onRenameProject,
  onHideProject,
  isConnected,
  startingLocalPath,
}: SortableProjectGroupProps) {
  useI18n()
  const { groupKey, localPath, title } = group
  const isExpanded = expandedGroups.has(groupKey)
  const isEmptyProject = group.chats.length === 0
  const hasMore = group.olderChats.length > 0
  const hasProjectMenu = Boolean(onHideProject && onCopyPath && onOpenExternalPath)

  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: groupKey, disabled: !isReorderEnabled })

  const style = {
    transform: CSS.Translate.toString(transform ? { ...transform, x: 0 } : null),
    transition: isDragging ? undefined : transition,
  }

  const header = (
    <div
      ref={setActivatorNodeRef}
      className={cn(
        "sticky top-0 z-10 relative mt-1 flex h-8 items-center justify-between rounded-lg bg-sidebar px-2 hover:bg-[color-mix(in_srgb,var(--color-foreground)_4%,var(--color-sidebar))]",
        "md:cursor-grab md:active:cursor-grabbing md:select-none md:touch-none",
        isDragging && "cursor-grabbing"
      )}
      onClick={() => onToggleSection(groupKey)}
      {...(isReorderEnabled ? listeners : undefined)}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="relative size-3.5 shrink-0 cursor-pointer">
          <ChevronRight className={`size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-200 ${!collapsedSections.has(groupKey) && 'rotate-90'}`} />
          
          {/* {collapsedSections.has(groupKey) ? (
            <ChevronRight className="translate-y-[1px] size-3.5 shrink-0 text-slate-400 transition-all duration-200" />
          ) : (
            <>
              <FolderOpen className="absolute inset-0 translate-y-[1px] size-3.5 shrink-0 text-slate-400 dark:text-muted-foreground transition-all duration-200 group-hover/section:opacity-0" />
              <ChevronRight className="absolute inset-0 translate-y-[1px] size-3.5 shrink-0 rotate-90 text-slate-400 opacity-0 transition-all duration-200 group-hover/section:opacity-100" />
            </>
          )} */}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="truncate max-w-[180px] whitespace-nowrap text-[13px] font-medium text-foreground/85">
              {title || getPathBasename(localPath)}
            </span>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={4}>
            {localPath}
          </TooltipContent>
        </Tooltip>
      </div>
      {(hasProjectMenu || onNewLocalChat) && (
        <div className="absolute right-2 flex items-center gap-[1px] opacity-100 md:opacity-0 md:group-hover/section:opacity-100">
          {hasProjectMenu ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 !rounded-md border-0 hover:border-0 hover:bg-black/[0.06] dark:hover:bg-white/[0.08]"
                  onClick={openContextMenuFromButton}
                >
                  <MoreHorizontal className="size-3.5 text-slate-500 dark:text-muted-foreground" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={4}>
                {t("sidebar:more")}</TooltipContent>
            </Tooltip>
          ) : null}
          {onNewLocalChat ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    "h-6 w-6 !rounded-md border-0 hover:border-0 hover:bg-black/[0.06] dark:hover:bg-white/[0.08]",
                    (!isConnected || startingLocalPath === localPath) && "opacity-50 cursor-not-allowed"
                  )}
                  disabled={!isConnected || startingLocalPath === localPath}
                  onClick={(event) => {
                    event.stopPropagation()
                    onNewLocalChat(localPath)
                  }}
                >
                  {startingLocalPath === localPath ? (
                    <Loader2 className="size-4 text-slate-500 dark:text-muted-foreground animate-spin" />
                  ) : (
                    <SquarePen className="size-3.5 text-slate-500 dark:text-muted-foreground" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={4}>
                {!isConnected ? t("sidebar:startValue0ToConnect", { v0: APP_NAME }) : t("sidebar:newChat")}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      )}
    </div>
  )

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "group/section",
        isDragging && "opacity-50 shadow-lg z-50 relative"
      )}
      {...(isReorderEnabled ? attributes : undefined)}
    >
      {hasProjectMenu ? (
        <ProjectSectionMenu
          onRename={() => onRenameProject?.(groupKey, group.sidebarTitle, group.realTitle || getPathBasename(localPath))}
          onCopyPath={() => onCopyPath?.(localPath)}
          onShowArchived={() => onShowArchivedProject?.(groupKey)}
          onOpenInFinder={() => onOpenExternalPath?.("open_finder", localPath)}
          onHide={() => onHideProject?.(groupKey)}
        >
          {header}
        </ProjectSectionMenu>
      ) : header}

      {!collapsedSections.has(groupKey) && (isEmptyProject ? Boolean(onNewLocalChat) : group.previewChats.length > 0 || hasMore) && (
        <div className="space-y-px mb-2">
          {isEmptyProject && onNewLocalChat ? (
            <EmptyProjectChatButton
              localPath={localPath}
              onNewLocalChat={onNewLocalChat}
              isConnected={isConnected}
              startingLocalPath={startingLocalPath}
            />
          ) : (
            <>
              {group.previewChats.map(renderChatRow)}
              {hasMore && isExpanded ? (
                <button
                  onClick={() => onToggleExpandedGroup(groupKey)}
                  className="pl-7 py-1 text-[12px] text-muted-foreground hover:text-foreground transition-colors flex flex-row items-center gap-2 justify-center"
                >
                 {t("common:showLess2")}</button>
              ) : null}
              {isExpanded ? group.olderChats.map(renderChatRow) : null}
              {hasMore && !isExpanded ? (
                <button
                  onClick={() => onToggleExpandedGroup(groupKey)}
                  className="pl-7 py-1 text-[12px] text-muted-foreground hover:text-foreground transition-colors flex flex-row items-center gap-1 justify-center"
                >
                 {t("common:showMore2")}</button>
              ) : null}
            </>
          )}
        </div>
      )}
    </div>
  )
})

const LocalProjectsSectionImpl = function LocalProjectsSection({
  projectGroups,
  collapsedSections,
  expandedGroups,
  onToggleSection,
  onToggleExpandedGroup,
  renderChatRow,
  onShowArchivedProject,
  onNewLocalChat,
  onCopyPath,
  onOpenExternalPath,
  onRenameProject,
  onHideProject,
  onReorderGroups,
  isConnected,
  startingLocalPath,
}: Props) {
  useI18n()
  const isReorderEnabled = useSidebarReorderEnabled()
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 2 } }),
    useSensor(KeyboardSensor)
  )

  const groupIds = useMemo(
    () => projectGroups.map((g) => g.groupKey),
    [projectGroups]
  )

  const collisionDetection = useMemo<CollisionDetection>(() => (args) => {
    const overId = getProjectGroupReorderPreviewTargetId({
      activeId: String(args.active.id),
      groupIds,
      collisionRect: args.collisionRect,
      droppableRects: args.droppableRects,
    })

    if (!overId) {
      return closestCenter(args)
    }

    const overContainer = args.droppableContainers.find(
      (container) => container.id === overId
    )

    if (!overContainer) {
      return closestCenter(args)
    }

    return [
      {
        id: overContainer.id,
        data: {
          droppableContainer: overContainer,
          value: 0,
        },
      },
    ]
  }, [groupIds])

  function handleDragEnd(event: DragEndEvent) {
    if (!isReorderEnabled) return

    const { active, over } = event

    if (over && active.id !== over.id && onReorderGroups) {
      const oldIndex = groupIds.indexOf(active.id as string)
      const newIndex = groupIds.indexOf(over.id as string)
      if (oldIndex !== -1 && newIndex !== -1) {
        const newOrder = arrayMove(groupIds, oldIndex, newIndex)
        onReorderGroups(newOrder)
      }
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={groupIds} strategy={verticalListSortingStrategy}>
        {projectGroups.map((group) => (
        <SortableProjectGroup
          key={group.groupKey}
          group={group}
          isReorderEnabled={isReorderEnabled && Boolean(onReorderGroups)}
          collapsedSections={collapsedSections}
          expandedGroups={expandedGroups}
          onToggleSection={onToggleSection}
          onToggleExpandedGroup={onToggleExpandedGroup}
          renderChatRow={renderChatRow}
          onShowArchivedProject={onShowArchivedProject}
          onNewLocalChat={onNewLocalChat}
          onCopyPath={onCopyPath}
          onOpenExternalPath={onOpenExternalPath}
          onRenameProject={onRenameProject}
          onHideProject={onHideProject}
          isConnected={isConnected}
          startingLocalPath={startingLocalPath}
        />
        ))}
      </SortableContext>
    </DndContext>
  )
}

export const LocalProjectsSection = memo(LocalProjectsSectionImpl)
