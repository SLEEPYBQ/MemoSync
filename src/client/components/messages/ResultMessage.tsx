import { formatNumber, t, useI18n } from "../../i18n"
import type { ProcessedResultMessage } from "./types"
import { MetaRow, MetaLabel } from "./shared"

interface Props {
  message: ProcessedResultMessage
}

export function ResultMessage({ message }: Props) {
  useI18n()
  const formatDuration = (ms: number) => {
    const format = (value: number, unit: string) => formatNumber(value, { style: "unit", unit, unitDisplay: "narrow" })
    if (ms < 1000) return format(ms, "millisecond")
    const seconds = Math.floor(ms / 1000)
    if (seconds >= 3600) return [format(Math.floor(seconds / 3600), "hour"), seconds % 3600 >= 60 ? format(Math.floor(seconds % 3600 / 60), "minute") : ""].filter(Boolean).join(" ")
    if (seconds >= 60) return [format(Math.floor(seconds / 60), "minute"), seconds % 60 ? format(seconds % 60, "second") : ""].filter(Boolean).join(" ")
    return format(seconds, "second")
  }

  if (!message.success) {
    return (
      <div className="px-4 py-3 mx-2 my-1 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm">
        {message.result || t("chat:anUnknownErrorOccurred")}
      </div>
    )
  }

  return (
    <MetaRow className={`px-0.5 text-xs tracking-wide ${message.durationMs > 60000 ? '' : 'hidden'}`}>
      <div className="w-full h-[1px] bg-border"></div>
      <MetaLabel className="whitespace-nowrap text-[11px] tracking-widest text-muted-foreground/60 uppercase flex-shrink-0">{t("chat:workedFor")}{formatDuration(message.durationMs)}</MetaLabel>
      <div className="w-full h-[1px] bg-border"></div>
    </MetaRow>
  )
}
