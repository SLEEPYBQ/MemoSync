import { Loader2, UserRound, X } from "lucide-react"
import { useMemo } from "react"
import { getLocale, t, useI18n } from "../../i18n"
import { formatBashCommandTitle, toTitleCase } from "../../lib/formatters"
import { stripWorkspacePath } from "../../lib/pathUtils"
import { cn } from "../../lib/utils"
import { AnimatedShinyText } from "../ui/animated-shiny-text"
import { useToolMemoryUses } from "./render-context"
import { ExpandableRow, getToolIcon, MetaRow } from "./shared"
import { ToolCallExpandedContent } from "./ToolCallExpandedContent"
import { ToolMemoryChips } from "./ToolMemoryChips"
import type { ProcessedToolCall } from "./types"
export { ReadResultImages } from "./ToolCallExpandedContent"

const NO_USES: readonly never[] = []
/** Where a value lands inside a translated sentence, whichever side the words fall on. */
const SLOT = "\u0000"

const FILE_TITLE_KEYS = {
  read_file: "chat:readValue0",
  write_file: "chat:writeValue0",
  edit_file: "chat:editValue0",
  delete_file: "chat:deleteValue0",
} as const

export function getToolCallTitle(message: ProcessedToolCall, localPath?: string | null): string {
  switch (message.toolKind) {
    case "skill":
      return message.input.skill
    case "glob":
      return t("chat:searchFilesValue0", { v0: message.input.pattern === "**/*" ? t("chat:inAllDirectories") : `matching ${message.input.pattern}` })
    case "grep": {
      const { pattern, outputMode } = message.input
      if (outputMode === "count") return t("chat:countValue0Occurrences", { v0: pattern })
      if (outputMode === "content") return t("chat:findValue0InText", { v0: pattern })
      return t("chat:findValue0InFiles", { v0: pattern })
    }
    case "bash":
      return message.input.description || (message.input.command ? formatBashCommandTitle(message.input.command) : "Bash")
    case "web_search":
      return message.input.query || t("chat:webSearch2")
    case "read_file":
    case "write_file":
    case "edit_file":
    case "delete_file":
      return t(FILE_TITLE_KEYS[message.toolKind], { v0: stripWorkspacePath(message.input.filePath, localPath) })
    case "mcp_generic":
      return t("chat:value0FromValue1", { v0: toTitleCase(message.input.tool), v1: toTitleCase(message.input.server) })
    case "subagent_task":
      return message.input.subagentType || message.toolName
    default:
      return message.toolName
  }
}

/** A path keeps its file name when space runs out; the folders give way first. */
function PathTarget({ path }: { path: string }) {
  const slash = path.lastIndexOf("/") + 1
  return (
    <span className="flex min-w-0 font-mono text-[12px]">
      {slash > 0 ? <span className="min-w-0 truncate text-muted-foreground/70">{path.slice(0, slash)}</span> : null}
      <span className="shrink-0 text-foreground/80">{path.slice(slash)}</span>
    </span>
  )
}

function ToolTitle({ message, localPath }: { message: ProcessedToolCall; localPath?: string | null }) {
  if (message.toolKind === "read_file" || message.toolKind === "write_file" || message.toolKind === "edit_file" || message.toolKind === "delete_file") {
    const [before = "", after = ""] = t(FILE_TITLE_KEYS[message.toolKind], { v0: SLOT }).split(SLOT)
    return (
      <span className="flex min-w-0 items-baseline gap-1.5">
        {before.trim() ? <span className="shrink-0">{before.trim()}</span> : null}
        <PathTarget path={stripWorkspacePath(message.input.filePath, localPath)} />
        {after.trim() ? <span className="shrink-0">{after.trim()}</span> : null}
      </span>
    )
  }
  if (message.toolKind === "bash" && !message.input.description && message.input.command) {
    return <span className="block truncate font-mono text-[12px] text-foreground/80">{formatBashCommandTitle(message.input.command)}</span>
  }
  return <span className="block truncate">{getToolCallTitle(message, localPath)}</span>
}

/** Why it failed, without opening it: the first line of what came back. */
function firstErrorLine(result: unknown) {
  const content = result && typeof result === "object" && "content" in result ? (result as { content?: unknown }).content : result
  const text = typeof content === "string" ? content : ""
  return text.split("\n").map((line) => line.trim()).find(Boolean)
}

interface Props {
  message: ProcessedToolCall
  isLoading?: boolean
  localPath?: string | null
  onExpandedChange?: (expanded: boolean) => void
}

export function ToolCallMessage({ message, isLoading = false, localPath, onExpandedChange }: Props) {
  useI18n()
  const running = message.result === undefined && isLoading
  const title = useMemo(() => getToolCallTitle(message, localPath), [message.input, message.toolName, localPath, getLocale()])
  const uses = useToolMemoryUses()?.get(message.toolId) ?? NO_USES
  const Icon = message.toolKind === "subagent_task" ? UserRound : getToolIcon(message.toolName)
  const errorLine = message.isError ? firstErrorLine(message.result) : undefined

  return (
    <div className="w-full" data-tool-id={message.toolId}>
      <MetaRow className="w-full">
        <ExpandableRow fill expandedContent={<ToolCallExpandedContent message={message} />} onExpandedChange={onExpandedChange}>
          <div className="flex size-5 items-center justify-center">
            {message.isError ? (
              <X className="size-3.5 text-destructive" />
            ) : running ? (
              <Loader2 className="size-3.5 animate-spin text-muted-icon" />
            ) : (
              <Icon className="size-3.5 text-muted-icon" />
            )}
          </div>
          <span className={cn("flex min-h-6 min-w-0 items-center gap-2 text-left text-[13px] text-muted-foreground transition-colors group-hover/expandable-row:text-foreground", message.isError && "text-destructive/90")}>
            <span className="min-w-0 flex-1">
              {running ? (
                <AnimatedShinyText animate shimmerWidth={Math.max(20, title.length * 3)} className="block truncate">{title}</AnimatedShinyText>
              ) : (
                <ToolTitle message={message} localPath={localPath} />
              )}
            </span>
            <ToolMemoryChips uses={uses} />
          </span>
        </ExpandableRow>
      </MetaRow>
      {errorLine ? <p className="ml-[26px] truncate pb-1 font-mono text-[11.5px] text-destructive/75">{errorLine}</p> : null}
    </div>
  )
}
