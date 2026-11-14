import { useEffect } from "react"
import { Clock3 } from "lucide-react"
import type { HydratedTranscriptMessage } from "../../../shared/types"
import { t, useI18n } from "../../i18n"
import { useMemoryBoardLauncher } from "../../app/memory/MemoryBoardLauncher"
import { useMemoryStore } from "../../stores/memoryStore"
import { useTranscriptChatContext, useTranscriptRenderOptions } from "./render-context"
import { MemoryCitationChip } from "./shared"

export function MemoryExpiredMessage({ message }: { message: Extract<HydratedTranscriptMessage, { kind: "memory_expired" }> }) {
  useI18n()
  const launcher = useMemoryBoardLauncher()
  const { chatId } = useTranscriptChatContext()
  const { readonly, previewDemo } = useTranscriptRenderOptions()
  const receiptIds = message.ids.join("\0")
  useEffect(() => {
    if (!readonly && !previewDemo) void useMemoryStore.getState().loadAll()
  }, [message.id, receiptIds, readonly, previewDemo])
  return <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
    <Clock3 className="h-3 w-3" />
    <span>{t("memory:expiredSinceTurn", { count: message.ids.length })}</span>
    {message.ids.map(id => <MemoryCitationChip key={id} id={id} />)}
    {!readonly && !previewDemo && launcher.available && chatId ? <button type="button" className="underline underline-offset-2 hover:text-foreground"
      onClick={() => launcher.openMemoryBoard({ source: "chat_long_term", chatId, initialLens: "archived" })}>{t("memory:viewArchived")}</button> : null}
  </div>
}
