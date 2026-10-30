import { t, useI18n, getLocale } from "../../i18n"
import { useMemo } from "react"
import { ChevronRight } from "lucide-react"
import { ToolCallMessage } from "./ToolCallMessage"
import { MetaRow, MetaLabel } from "./shared"
import { AnimatedShinyText } from "../ui/animated-shiny-text"
import type { ProcessedToolCall } from "./types"
import type { HydratedTranscriptMessage } from "../../../shared/types"

const TOOL_CATEGORIES = {
  read_file: "toolGroupread",
  edit_file: "toolGroupedit",
  write_file: "toolGroupwrite",
  delete_file: "toolGroupdelete",
  bash: "toolGroupcommand",
  grep: "toolGroupsearch",
  glob: "toolGroupglob",
  subagent_task: "toolGroupagent",
  web_search: "toolGroupwebsearch",
  skill: "toolGroupskill",
  todo_write: "toolGrouptodo",
  other: "toolGroupother",
} as const

function getToolCategory(toolKind: string) {
  return TOOL_CATEGORIES[toolKind as keyof typeof TOOL_CATEGORIES] ?? TOOL_CATEGORIES.other
}

function getToolGroupLabel(messages: HydratedTranscriptMessage[]): string {
  const counts = new Map<string, { category: ReturnType<typeof getToolCategory>; count: number }>()
  const order: string[] = []

  for (const msg of messages) {
    const toolKind = (msg as ProcessedToolCall).toolKind
    const category = getToolCategory(toolKind)

    const existing = counts.get(category)
    if (existing) {
      existing.count++
    } else {
      counts.set(category, { category, count: 1 })
      order.push(category)
    }
  }

  // Format as "N reads, M writes" in order of first appearance
  return order.map(key => {
    const { category, count } = counts.get(key)!
    return t(`chat:${category}`, { count })
  }).join(getLocale() === "zh-CN" ? "、" : ", ")
}

interface Props {
  messages: HydratedTranscriptMessage[]
  isLoading: boolean
  localPath?: string | null
  expanded: boolean
  onExpandedChange: (next: boolean) => void
}

export function CollapsedToolGroup({ messages, isLoading, localPath, expanded, onExpandedChange }: Props) {
  useI18n()
  const label = useMemo(() => getToolGroupLabel(messages), [messages, getLocale()])

  // Check if any tool in the group is still in progress
  const anyInProgress = messages.some(msg => {
    const processed = msg as ProcessedToolCall
    return processed.result === undefined
  })

  const showLoadingState = anyInProgress && isLoading

  return (
    <div className="w-full" data-tool-group-ids={JSON.stringify(messages.filter((message) => message.kind === "tool").map((message) => message.toolId))}>
    <MetaRow className="w-full">
      <div className="flex flex-col w-full">
        <button
          onClick={() => onExpandedChange(!expanded)}
          data-tool-group-toggle=""
          aria-expanded={expanded}
          className={`group cursor-pointer grid grid-cols-[auto_1fr] items-center gap-1 text-sm ${!expanded && !showLoadingState ? "hover:opacity-60 transition-opacity" : ""}`}
        >
          <div className="grid grid-cols-[auto_1fr] items-center gap-1.5">
            <div className="w-5 h-5 relative flex items-center justify-center">
              <ChevronRight
                className={`h-4.5 w-4.5 text-muted-icon transition-all duration-200 ${expanded ? "rotate-90" : ""}`}
              />
            </div>
            <MetaLabel className="text-left">
              <AnimatedShinyText animate={showLoadingState}>{label}</AnimatedShinyText>
            </MetaLabel>
          </div>
        </button>
        {expanded && (
          <div className="my-4 flex flex-col gap-3">
            {messages.map(msg => (
              <ToolCallMessage
                key={msg.id}
                message={msg as ProcessedToolCall}
                isLoading={isLoading}
                localPath={localPath}
              />
            ))}
            {messages.length > 5 && (
              <button
                onClick={() => onExpandedChange(false)}
                className="cursor-pointer grid grid-cols-[auto_1fr] items-center gap-1 text-xs hover:opacity-80 transition-opacity"
              >
                <div className="grid grid-cols-[auto_1fr] items-center gap-1.5">
                  <div className="w-5 h-5 relative flex items-center justify-center">
                    <ChevronRight className="h-4.5 w-4.5 text-muted-icon -rotate-90" />
                  </div>
                  <MetaLabel className="text-left">{t("chat:collapse")}</MetaLabel>
                </div>
              </button>
            )}
          </div>
        )}
      </div>
    </MetaRow>
    </div>
  )
}
