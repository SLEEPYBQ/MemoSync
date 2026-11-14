import { useEffect } from "react"
import { Users } from "lucide-react"
import type { HydratedTranscriptMessage } from "../../../shared/types"
import { t, useI18n } from "../../i18n"
import { useMemoryBoardLauncher } from "../../app/memory/MemoryBoardLauncher"
import { useMemoryStore } from "../../stores/memoryStore"
import { useTranscriptChatContext, useTranscriptRenderOptions } from "./render-context"
import { MemoryCitationChip } from "./shared"

export function MemoryTeamUpdatedMessage({ message }: { message: Extract<HydratedTranscriptMessage, { kind: "memory_team_updated" }> }) {
  useI18n()
  const launcher = useMemoryBoardLauncher()
  const { chatId } = useTranscriptChatContext()
  const { readonly, previewDemo } = useTranscriptRenderOptions()
  const addedIds = message.added.join("\0")
  const changedIds = message.changed.join("\0")
  const removedIds = message.removed.join("\0")
  useEffect(() => {
    if (!readonly && !previewDemo) void useMemoryStore.getState().loadAll()
  }, [message.id, addedIds, changedIds, removedIds, readonly, previewDemo])
  const parts = [
    t("memory:teamUpdated"),
    message.added.length ? t("memory:teamNoticeNew", { count: message.added.length }) : null,
    message.changed.length ? t("memory:teamNoticeChanged", { count: message.changed.length }) : null,
    message.removed.length ? t("memory:teamNoticeRemoved", { count: message.removed.length }) : null,
  ].filter(Boolean)
  const ids = [...new Set([...message.added, ...message.changed, ...message.removed])]
  return <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
    <Users className="h-3 w-3" />
    <span>{parts.join(" · ")}</span>
    {ids.map(id => <MemoryCitationChip key={id} id={id} />)}
    {!readonly && !previewDemo && launcher.available && chatId ? <button type="button" className="underline underline-offset-2 hover:text-foreground"
      onClick={() => launcher.openMemoryBoard({ source: "chat_long_term", chatId, initialLens: "team" })}>{t("memory:teamView")}</button> : null}
  </div>
}
