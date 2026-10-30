import { t, useI18n, getLocale } from "../../i18n"
import { Loader2, UserRound, X } from "lucide-react"
import type { ProcessedToolCall } from "./types"
import { MetaRow, MetaLabel, ExpandableRow, getToolIcon } from "./shared"
import { useMemo } from "react"
import { stripWorkspacePath } from "../../lib/pathUtils"
import { AnimatedShinyText } from "../ui/animated-shiny-text"
import { formatBashCommandTitle, toTitleCase } from "../../lib/formatters"
import { ToolCallExpandedContent } from "./ToolCallExpandedContent"
export { ReadResultImages } from "./ToolCallExpandedContent"

interface Props {
  message: ProcessedToolCall
  isLoading?: boolean
  localPath?: string | null
}

export function ToolCallMessage({ message, isLoading = false, localPath }: Props) {
  useI18n()
  const hasResult = message.result !== undefined
  const showLoadingState = !hasResult && isLoading

  const name = useMemo(() => {
    if (message.toolKind === "skill") {
      return message.input.skill
    }
    if (message.toolKind === "glob") {
      return t("chat:searchFilesValue0", { v0: message.input.pattern === "**/*" ? t("chat:inAllDirectories") : `matching ${message.input.pattern}` })
    }
    if (message.toolKind === "grep") {
      const pattern = message.input.pattern
      const outputMode = message.input.outputMode
      if (outputMode === "count") {
        return t("chat:countValue0Occurrences", { v0: pattern })
      }
      if (outputMode === "content") {
        return t("chat:findValue0InText", { v0: pattern })
      }
      return t("chat:findValue0InFiles", { v0: pattern })
    }
    if (message.toolKind === "bash") {
      return message.input.description || (message.input.command ? formatBashCommandTitle(message.input.command) : "Bash")
    }
    if (message.toolKind === "web_search") {
      return message.input.query || t("chat:webSearch2")
    }
    if (message.toolKind === "read_file") {
      return t("chat:readValue0", { v0: stripWorkspacePath(message.input.filePath, localPath) })
    }
    if (message.toolKind === "write_file") {
      return t("chat:writeValue0", { v0: stripWorkspacePath(message.input.filePath, localPath) })
    }
    if (message.toolKind === "edit_file") {
      return t("chat:editValue0", { v0: stripWorkspacePath(message.input.filePath, localPath) })
    }
    if (message.toolKind === "delete_file") {
      return t("chat:deleteValue0", { v0: stripWorkspacePath(message.input.filePath, localPath) })
    }
    if (message.toolKind === "mcp_generic") {
      return t("chat:value0FromValue1", { v0: toTitleCase(message.input.tool), v1: toTitleCase(message.input.server) })
    }
    if (message.toolKind === "subagent_task") {
      return message.input.subagentType || message.toolName
    }
    return message.toolName
  }, [message.input, message.toolName, localPath, getLocale()])

  const isAgent = useMemo(() => message.toolKind === "subagent_task", [message.toolKind])
  const description = useMemo(() => {
    if (message.toolKind === "skill") {
      return message.input.skill
    }
  }, [message.input, message.toolKind])


  return (
    <div className="w-full" data-tool-id={message.toolId}>
    <MetaRow className="w-full">
      <ExpandableRow
        expandedContent={
          <ToolCallExpandedContent message={message} />
        }
      >

        <div className={`w-5 h-5 relative flex items-center justify-center`}>
          {(() => {
            if (message.isError) {
              return <X className="size-4 text-destructive" />
            }
            // A running tool spins — the shimmer on the label alone is easy to miss.
            if (showLoadingState) {
              return <Loader2 className="size-4 animate-spin text-muted-icon" />
            }
            if (isAgent) {
              return <UserRound className="size-4 text-muted-icon" />
            }
            const Icon = getToolIcon(message.toolName)

            return <Icon className="size-4 text-muted-icon" />
          })()}
        </div>
        <MetaLabel className="text-left transition-opacity duration-200 truncate">
          <AnimatedShinyText
            animate={showLoadingState}
            shimmerWidth={Math.max(20, ((description || name)?.length ?? 33) * 3)}
          >
            {description || name}
          </AnimatedShinyText>
        </MetaLabel>



      </ExpandableRow>
    </MetaRow>
    </div>
  )
}
