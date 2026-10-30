import { t, useI18n } from "../../i18n"
import { Suspense, useEffect } from "react"
import { LazyMemoryBoardPage } from "../lazyPages"
import { PanelLoading } from "../../components/ui/panel-loading"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog"
import { recordUiMonitor } from "../../lib/memoriesApi"
import type { FocusedMemoryReviewController } from "./MemoryBoardLauncher"
import { useSurfaceExposure } from "./surfaceExposure"

export function MemoryBoardOverlay({ chatId, focusedReview, onClose }: {
  chatId: string
  focusedReview?: FocusedMemoryReviewController
  onClose: () => void
}) {
  useI18n()
  useSurfaceExposure({ active: true, surface: "memory_board", chatId, initiator: "user", closeReason: "dialog" })
  useEffect(() => {
    recordUiMonitor("board", { sessionId: chatId, interaction: "open" })
  }, [chatId])
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent
        showClose={false}
        size="lg"
        aria-label={t("common:memoryBoard")}
        overlayClassName="bg-background/60 backdrop-blur-md"
        className="h-[calc(100dvh-2rem)] max-h-[calc(100dvh-2rem)] max-w-5xl overflow-hidden rounded-2xl p-0 md:h-[calc(100dvh-4rem)] md:max-h-[calc(100dvh-4rem)]"
      >
        <DialogTitle className="sr-only">{t("common:memoryBoard")}</DialogTitle>
        <DialogDescription className="sr-only">{t("board:reviewAndManageLongTermMemory")}</DialogDescription>
        <div className="flex h-full max-h-full w-full min-h-0 flex-col overflow-hidden rounded-2xl bg-background">
          <Suspense fallback={<PanelLoading />}><LazyMemoryBoardPage overlay={{ chatId, focusedReview, onClose }} /></Suspense>
        </div>
      </DialogContent>
    </Dialog>
  )
}
