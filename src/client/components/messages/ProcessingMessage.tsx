import { t, useI18n } from "../../i18n"
import { Loader2, X } from "lucide-react"
import { MetaRow, MetaContent } from "./shared"
import { AnimatedShinyText } from "../ui/animated-shiny-text"

// Keyed by ChatActivityStatus (shared/types.ts) — the footer shows only the
// activity status; SDK statuses like "requesting" are never surfaced.
const STATUS_LABELS: Record<string, string> = {
  get starting() { return t("chat:starting") },
  get previewing_memory() { return t("chat:previewingMemories") },
  get running() { return t("chat:running") },
  get waiting_for_user() { return t("chat:waiting") },
  get failed() { return t("chat:failed") },
}

interface ProcessingMessageProps {
  status?: string
}

export function ProcessingMessage({ status }: ProcessingMessageProps) {
  useI18n()
  const label = (status ? STATUS_LABELS[status] : undefined) || "Processing..."
  const isFailed = status === "failed"

  return (
    <MetaRow className="ml-[1px]">
      <MetaContent>
        {isFailed ? (
          <X className="size-4.5 text-red-500 dark:text-red-400" />
        ) : (
          <Loader2 className="size-4.5 animate-spin text-muted-icon" />
        )}
        <AnimatedShinyText className="ml-[1px] text-sm" shimmerWidth={44}>
          {label}
        </AnimatedShinyText>
      </MetaContent>
    </MetaRow>
  )
}
