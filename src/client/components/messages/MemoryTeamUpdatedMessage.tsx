import { Users } from "lucide-react"
import type { HydratedTranscriptMessage } from "../../../shared/types"
import { t, useI18n } from "../../i18n"
import { useMemoryBoardLauncher } from "../../app/memory/MemoryBoardLauncher"
import { useTranscriptChatContext, useTranscriptRenderOptions } from "./render-context"
import { MemoryCitationChip } from "./shared"

export function MemoryTeamUpdatedMessage({ message }: { message: Extract<HydratedTranscriptMessage, { kind: "memory_team_updated" }> }) {
  useI18n()
  const launcher = useMemoryBoardLauncher()
  const { chatId } = useTranscriptChatContext()
  const { readonly, previewDemo } = useTranscriptRenderOptions()
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
