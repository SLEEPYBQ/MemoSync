import { ChevronRight } from "lucide-react"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { getLocale, t, useI18n } from "../../i18n"
import { mergeToolMemoryUses } from "../../lib/toolMemoryUses"
import { cn } from "../../lib/utils"
import { AnimatedShinyText } from "../ui/animated-shiny-text"
import type { HydratedTranscriptMessage } from "../../../shared/types"
import { useToolMemoryUses } from "./render-context"
import { getToolCallTitle, ToolCallMessage } from "./ToolCallMessage"
import { ToolMemoryChips } from "./ToolMemoryChips"
import type { ProcessedToolCall } from "./types"

const TOOL_CATEGORIES = {
  read_file: "toolGroupread",
  edit_file: "toolGroupedit",
  write_file: "toolGroupwrite",
  delete_file: "toolGroupdelete",
  bash: "toolGroupcommand",
  grep: "toolGroupsearch",
  glob: "toolGroupsearch",
  subagent_task: "toolGroupagent",
  web_search: "toolGroupwebsearch",
  skill: "toolGroupskill",
  todo_write: "toolGrouptodo",
  other: "toolGroupother",
} as const

/** Stays this long before showing a clock: most steps are over before it would mean anything. */
const SHOW_ELAPSED_AFTER_SECONDS = 3

function toolCategory(toolKind: string) {
  return TOOL_CATEGORIES[toolKind as keyof typeof TOOL_CATEGORIES] ?? TOOL_CATEGORIES.other
}

/** Reading one file five times is still one file read. */
function countKey(tool: ProcessedToolCall) {
  const path = (tool.input as { filePath?: unknown }).filePath
  return typeof path === "string" ? path : tool.toolId
}

/** "Read 3 files, ran 2 commands", in the order the agent got to them. */
export function summarizeToolGroup(tools: ProcessedToolCall[]): string {
  const seen = new Map<ReturnType<typeof toolCategory>, Set<string>>()
  for (const tool of tools) {
    const category = toolCategory(tool.toolKind)
    const keys = seen.get(category) ?? new Set<string>()
    keys.add(countKey(tool))
    seen.set(category, keys)
  }
  const chinese = getLocale() === "zh-CN"
  const parts = [...seen].map(([category, keys]) => t(`chat:${category}`, { count: keys.size }))
  return parts.map((part, index) => (index > 0 && !chinese ? part.charAt(0).toLowerCase() + part.slice(1) : part)).join(chinese ? "，" : ", ")
}

function useElapsedSeconds(since: string | undefined, running: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])
  if (!running || !since) return 0
  return Math.max(0, Math.floor((now - Date.parse(since)) / 1000))
}

function formatElapsed(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
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
  const tools = messages as ProcessedToolCall[]
  const memoryUses = useToolMemoryUses()
  const toolIds = useMemo(() => tools.map((tool) => tool.toolId), [tools])
  const uses = useMemo(() => mergeToolMemoryUses(memoryUses, toolIds), [memoryUses, toolIds])

  const finished = tools.filter((tool) => tool.result !== undefined)
  const current = isLoading ? tools.find((tool) => tool.result === undefined) : undefined
  const failed = tools.filter((tool) => tool.isError).length
  const summary = useMemo(() => summarizeToolGroup(current ? finished : tools), [tools, finished.length, Boolean(current), getLocale()])
  const elapsed = useElapsedSeconds(current?.timestamp, Boolean(current))

  // Long runs scroll in place. A live one follows the newest step, unless you scrolled away.
  // An opened step needs its room, so the limit lifts while one is open.
  const [openSteps, setOpenSteps] = useState(0)
  const stepsRef = useRef<HTMLDivElement>(null)
  const pinnedToEnd = useRef(true)
  const live = Boolean(current)
  useLayoutEffect(() => {
    const steps = stepsRef.current
    if (steps && live && pinnedToEnd.current) steps.scrollTop = steps.scrollHeight
  }, [expanded, live, tools.length])

  return (
    <div className="w-full" data-tool-group-ids={JSON.stringify(toolIds)}>
      <div className="flex min-h-6 items-center gap-2 text-[13px]">
        <button
          type="button"
          onClick={() => onExpandedChange(!expanded)}
          data-tool-group-toggle=""
          aria-expanded={expanded}
          className="group/tools flex min-w-0 cursor-pointer items-center gap-1.5 text-left"
        >
          <span className="flex size-5 shrink-0 items-center justify-center">
            <ChevronRight className={cn("size-4 text-muted-icon transition-transform duration-200", expanded && "rotate-90")} />
          </span>
          <span className="min-w-0 truncate text-muted-foreground transition-colors group-hover/tools:text-foreground">
            {summary}
            {current ? (
              <>
                {summary ? <span aria-hidden className="mx-1.5 opacity-50">·</span> : null}
                <AnimatedShinyText animate className="inline">{getToolCallTitle(current, localPath)}</AnimatedShinyText>
              </>
            ) : null}
          </span>
        </button>
        {elapsed >= SHOW_ELAPSED_AFTER_SECONDS ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground/80">{formatElapsed(elapsed)}</span> : null}
        {failed > 0 ? <span className="shrink-0 text-xs text-destructive">{t("chat:toolGroupFailed", { count: failed })}</span> : null}
        {uses.length > 0 ? (
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            {t("chat:toolGroupUsedMemory")}
            <ToolMemoryChips uses={uses} />
          </span>
        ) : null}
      </div>
      {expanded ? (
        <div
          ref={stepsRef}
          onScroll={(event) => {
            const steps = event.currentTarget
            pinnedToEnd.current = steps.scrollHeight - steps.scrollTop - steps.clientHeight < 8
          }}
          className={cn("mt-0.5 flex flex-col overscroll-contain", openSteps === 0 && "max-h-[min(20rem,50dvh)] overflow-y-auto")}
        >
          {tools.map((tool) => (
            <ToolCallMessage
              key={tool.id}
              message={tool}
              isLoading={isLoading}
              localPath={localPath}
              onExpandedChange={(open) => setOpenSteps((count) => Math.max(0, count + (open ? 1 : -1)))}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}
