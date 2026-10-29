import { useEffect } from "react"
import { MemoryBoardPage } from "../MemoryBoardPage"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog"
import { recordUiMonitor, type MemoryBoardReviewStatus } from "../../lib/memoriesApi"
import type { FocusedMemoryReviewController } from "./MemoryBoardLauncher"
import { useSurfaceExposure } from "./surfaceExposure"

export function MemoryBoardOverlay({
  embedded = false,
  blocking,
  taskId,
  chatId,
  status,
  actionError,
  submitting = false,
  pendingPrompt,
  focusedReview,
  onClose,
  onEnterSession,
  onBacklogChanged,
}: {
  /** Guide-only containment: fill the mounted demo pane instead of the viewport. */
  embedded?: boolean
  blocking: boolean
  taskId?: string
  chatId?: string
  status?: MemoryBoardReviewStatus
  actionError?: string | null
  submitting?: boolean
  /** Opening flow only: the participant's message waiting behind this review. */
  pendingPrompt?: string
  /** Manual flow only: the active in-chat Long-term review to expand. */
  focusedReview?: FocusedMemoryReviewController
  onClose?: () => void
  onEnterSession?: () => void
  onBacklogChanged?: () => void
}) {
  useSurfaceExposure({
    active: !embedded && Boolean(chatId),
    surface: "memory_board",
    chatId,
    initiator: blocking ? "system" : "participant",
    closeReason: "dialog",
  })
  useEffect(() => {
    if (!blocking && chatId) recordUiMonitor("board", { sessionId: chatId, interaction: "open" })
  }, [blocking, chatId])
  const content = (
    <div className="flex h-full max-h-full w-full min-h-0 flex-col overflow-hidden rounded-2xl bg-background">
      <MemoryBoardPage
        overlay={{
          blocking,
          taskId,
          chatId,
          status,
          actionError,
          submitting,
          pendingPrompt,
          focusedReview,
          onClose,
          onEnterSession,
          onBacklogChanged,
        }}
      />
    </div>
  )
  // Guide containment stays inside its demo pane. Production uses Radix so
  // focus is trapped and the blurred chat/composer is actually inert.
  if (embedded) return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-background/60 p-4 backdrop-blur-md md:p-8"
    >
      <div className="flex h-full max-h-full w-full max-w-5xl min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl">
        {content}
      </div>
    </div>
  )
  const policy = memoryBoardDialogPolicy(blocking)
  return (
    <Dialog open onOpenChange={(open) => {
      if (!open && !blocking) onClose?.()
    }}>
      <DialogContent
        showClose={false}
        size="lg"
        aria-label={policy.ariaLabel}
        overlayClassName="bg-background/60 backdrop-blur-md"
        className="h-[calc(100dvh-2rem)] max-h-[calc(100dvh-2rem)] max-w-5xl overflow-hidden rounded-2xl p-0 md:h-[calc(100dvh-4rem)] md:max-h-[calc(100dvh-4rem)]"
        onEscapeKeyDown={(event) => { if (!policy.dismissOnEscape) event.preventDefault() }}
        onPointerDownOutside={(event) => { if (!policy.dismissOnOutside) event.preventDefault() }}
        onInteractOutside={(event) => { if (!policy.dismissOnOutside) event.preventDefault() }}
      >
        <DialogTitle className="sr-only">{policy.ariaLabel}</DialogTitle>
        <DialogDescription className="sr-only">
          {blocking
            ? "Review pending long-term memory before the waiting message continues."
            : "Review and manage long-term memory."}
        </DialogDescription>
        {content}
      </DialogContent>
    </Dialog>
  )
}

export function memoryBoardDialogPolicy(blocking: boolean) {
  return blocking
    ? { ariaLabel: "Long-term Memory Management", dismissOnEscape: false, dismissOnOutside: false }
    : { ariaLabel: "Memory Board", dismissOnEscape: true, dismissOnOutside: true }
}

