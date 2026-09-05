// The right-sidebar Memory Record (redesign 2026-08-10): the monitoring
// column of the memory loop re-presented along time. The old Controls tab is
// gone — its exclusion toggles duplicated the injection gate, and the record
// is monitoring-only by design: control actions live at the gates or in the
// shared Memory Board; the record shows what happened and jumps back to where
// it happened.
import { BrainCircuit, LibraryBig, X } from "lucide-react"
import type { HydratedTranscriptMessage } from "../../../shared/types"
import { Button } from "../ui/button"
import { MemoryRecordRail } from "./MemoryRecordRail"
import { useMemoryBoardLauncher } from "../../app/study/MemoryBoardLauncher"
import { useSurfaceExposure, type StudySurfaceExposureInitiator } from "../../app/study/surfaceExposure"
import { TranscriptChatContextProvider } from "../messages/render-context"
import { recordUiMonitor } from "../../lib/memoriesApi"
import { memorySidebarOpenMonitoring } from "../../app/study/memorySidebarMonitoring"
import { useEffect } from "react"

interface Props {
  chatId: string
  projectId?: string
  /** The chat's hydrated transcript — the record derives everything from it. */
  messages?: HydratedTranscriptMessage[]
  /** In-flight Claude text used for the live Reported Memory Use row. */
  streamingText?: string | null
  isTurnActive?: boolean
  exposureInitiator: StudySurfaceExposureInitiator
  onClose?: () => void
}

export function SessionMemoriesPanel({ chatId, projectId, messages, streamingText, isTurnActive, exposureInitiator, onClose }: Props) {
  useSurfaceExposure({
    active: true,
    surface: "memory_record",
    chatId,
    initiator: exposureInitiator,
  })
  useEffect(() => {
    const monitoring = memorySidebarOpenMonitoring(exposureInitiator, "timeline", chatId)
    if (monitoring) recordUiMonitor(monitoring.surface, monitoring)
  }, [chatId, exposureInitiator])
  const boardLauncher = useMemoryBoardLauncher()
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="border-b border-border px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <BrainCircuit className="size-4 shrink-0 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">Memory Record</span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-7 shrink-0 gap-1.5 px-2 text-xs"
              disabled={!boardLauncher.available}
              onClick={() => boardLauncher.openMemoryBoard({ source: "memory_record", chatId })}
              data-go-to-memory-board="true"
              data-memory-board-source="memory_record"
            >
              <LibraryBig className="size-3.5" />
              Go to Memory Board
            </Button>
            {onClose ? (
              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onClose} title="Close">
                <X className="size-4" />
              </Button>
            ) : null}
          </div>
        </div>
      </div>
      <TranscriptChatContextProvider value={{ chatId, projectId }}>
        <MemoryRecordRail chatId={chatId} messages={messages ?? []} streamingText={streamingText} isTurnActive={isTurnActive} />
      </TranscriptChatContextProvider>
    </div>
  )
}
