import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react"
import { Button } from "../ui/button"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../ui/hover-card"
import { useMemoryStore } from "../../stores/memoryStore"
import { recordUiMonitor } from "../../lib/memoriesApi"
import { MemoryCardCore } from "../memory/MemoryCardCore"
import { MEMORY_SCOPE_CHIP_CLASSES, isMemoryScope, parseMemoryCitationHref } from "../../lib/memoryCitations"
import {
  AlertTriangle,
  ArrowDownToLine,
  CheckLine,
  ChevronRight,
  ListTodo,
  Map,
  MessageCircleQuestion,
  Pencil,
  Search,
  Sparkles,
  Square,
  SquareX,
  Terminal,
  ToyBrick,
  type LucideIcon,
  File,
  FilePen,
  FilePlusCorner,
  FileX,
  Copy,
  Check,
} from "lucide-react"
import { cn } from "../../lib/utils"
import { parseLocalFileLink } from "../../lib/pathUtils"
import { useMessageViolatedCitations, useTranscriptRenderOptions } from "./render-context"
import { useTranscriptChatContext } from "./render-context"
import { useSurfaceExposure } from "../../app/study/surfaceExposure"

export type OpenLocalLinkTarget = {
  path: string
  line?: number
  column?: number
  clientX?: number
  clientY?: number
  trigger?: "click" | "contextmenu"
}
type OpenLocalLinkHandler = (target: OpenLocalLinkTarget) => void

const defaultOpenLocalLink: OpenLocalLinkHandler = () => {}

const OpenLocalLinkContext = createContext<OpenLocalLinkHandler>(defaultOpenLocalLink)

export function OpenLocalLinkProvider({
  children,
  onOpenLocalLink,
}: {
  children: ReactNode
  onOpenLocalLink?: OpenLocalLinkHandler
}) {
  return (
    <OpenLocalLinkContext.Provider value={onOpenLocalLink ?? defaultOpenLocalLink}>
      {children}
    </OpenLocalLinkContext.Provider>
  )
}

// Tool icon mapping - shared between ToolCallMessage and SystemMessage
export const toolIcons: Record<string, LucideIcon> = {
  Task: ListTodo,
  TaskOutput: ListTodo,
  Bash: Terminal,
  Glob: Search,
  Grep: Search,
  ExitPlanMode: Map,
  Read: File,
  Edit: FilePen,
  Write: FilePlusCorner,
  Delete: FileX,
  NotebookEdit: Pencil,
  WebFetch: ArrowDownToLine,
  TodoWrite: CheckLine,
  WebSearch: Search,
  KillShell: SquareX,
  AskUserQuestion: MessageCircleQuestion,
  Skill: Sparkles,
  EnterPlanMode: Map,
}

export const defaultToolIcon: LucideIcon = ToyBrick

// Get icon for a tool.
export function getToolIcon(toolName: string): LucideIcon {
  if (toolIcons[toolName]) {
    return toolIcons[toolName]
  }
  return defaultToolIcon
}

// Container for meta-style messages (system, tool, result)
export function MetaRow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex gap-3 justify-start items-center", className)}>
      {children}
    </div>
  )
}

// Content row with consistent text styling
export function MetaContent({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center gap-1.5 text-xs", className)}>
      {children}
    </div>
  )
}

// Separator pipe
export function MetaSeparator() {
  return <span className="text-muted-foreground">|</span>
}

// Bold label text
export function MetaLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("font-medium text-foreground/80", className)}>{children}</span>
}

// Muted text
export function MetaText({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>
}

// Expandable row with chevron
interface ExpandableRowProps {
  children: ReactNode
  expandedContent: ReactNode
  defaultExpanded?: boolean
  /** Observe toggles (e.g. monitoring telemetry for pool/trace expansion). */
  onExpandedChange?: (expanded: boolean) => void
}

export function ExpandableRow({ children, expandedContent, defaultExpanded = false, onExpandedChange }: ExpandableRowProps) {
  const [expanded, setExpandedState] = useState(defaultExpanded)
  const setExpanded = (next: boolean) => {
    setExpandedState(next)
    onExpandedChange?.(next)
  }

  return (
    <div className="flex flex-col w-full">

      <button
        onClick={() => setExpanded(!expanded)}
        className={`group/expandable-row cursor-pointer grid grid-cols-[auto_1fr] items-center gap-1 text-sm ${!expanded ? "hover:opacity-60 transition-opacity" : ""}`}
      >
        <div className="grid grid-cols-[auto_1fr] items-center gap-1.5">
          {children}
        </div>
        <ChevronRight
          className={`h-3.5 w-3.5 text-muted-icon translate-y-[0.5px] transition-all duration-200 opacity-0 group-hover/expandable-row:opacity-100 ${expanded ? "rotate-90 opacity-100" : ""}`}
        />
      </button>
      {expanded && expandedContent}
    </div>
  )
}

// Code block for expanded content
export function MetaCodeBlock({ label, children, copyText }: { label: ReactNode; children: ReactNode; copyText?: string }) {
  const [copied, setCopied] = useState(false)
  const textContent = copyText ?? extractText(children)

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(textContent)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [textContent])

  return (
    <div>
      <span className="font-medium text-muted-foreground">{label}</span>
      <div className="relative group/codeblock">
        <pre className="my-1 text-xs font-mono whitespace-no-wrap break-all bg-muted border border-border  rounded-lg p-2 max-h-64 overflow-auto w-full">
          {children}
        </pre>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "absolute top-[4px] right-[4px] z-10 h-6.5 w-6.5 rounded-sm text-muted-foreground opacity-0 group-hover/codeblock:opacity-100 transition-opacity",
            !copied && "hover:text-foreground",
            copied && "hover:!bg-transparent hover:!border-transparent"
          )}
          onClick={handleCopy}
        >
          {copied ? <Check className="h-3.5 w-3.5 text-green-400" /> : <Copy className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  )
}

// Pill/badge for tags
export function MetaPill({ children, icon: Icon, className }: { children: ReactNode; icon?: LucideIcon; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 px-2 py-1 bg-muted border border-border  rounded-full", className)}>
      {Icon && <Icon className="h-3 w-3 text-muted-foreground" />}
      {children}
    </span>
  )
}

// Container with vertical line on the left
export function VerticalLineContainer({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("grid grid-cols-[auto_1fr] gap-2 min-w-0", className)}>
      <div className=" min-w-5 flex flex-col relative items-center justify-center">
        <div className="min-h-full w-[1px] bg-muted-foreground/20" />
      </div>
      <div className="-ml-[1px] min-w-0 overflow-hidden">
        {children}
      </div>
    </div>
  )
}

// Ensure the memory store is populated before a citation/candidate/trace UI
// tries to resolve an id against it. `memoryStore.loadAll()` does not dedupe
// concurrent calls itself, so this hook gates on `status` (effects in the same
// commit run synchronously, so only the first mount actually fetches).
export function useEnsureMemoriesLoaded() {
  const status = useMemoryStore((s) => s.status)
  const loadAll = useMemoryStore((s) => s.loadAll)
  useEffect(() => {
    if (status === "idle") void loadAll()
  }, [status, loadAll])
}

/**
 * Per-memory interrupt plumbing (2026-08-19 C1/C2): ChatPage provides this
 * while its chat can be stopped; every citation chip (reply text, sidebar
 * live row) then carries a stop entry in its hover card, and the recovery
 * card reaches resume() through the same context.
 */
export interface TurnInterruptApi {
  /** True while the current turn is running and can still be stopped. */
  active: boolean
  /** Guide-only illustration: render the affordance without admitting input. */
  readOnly?: boolean
  interrupt: (memoryId: string, quote?: string) => void
  resume: (args: {
    interruptId: string
    /** Required by production recovery; optional only while old Guide scenes are migrated. */
    correction?: string
    /** Read/demo compatibility for the pre-composer recovery model. */
    action?: "content_fixed" | "usage_correction" | "removed_only"
    selectedIds: string[]
    enforce?: boolean
  }) => Promise<void>
}
export const TurnInterruptContext = createContext<TurnInterruptApi | null>(null)
export function useTurnInterrupt() {
  return useContext(TurnInterruptContext)
}

// Interrupt belongs to the in-flight reply, not every historical citation
// mounted under ChatPage's long-lived TurnInterruptContext. The streaming
// reply and the live Memory Record row opt into this narrower scope.
const CurrentTurnMemoryCitationContext = createContext(false)
export function CurrentTurnMemoryCitationProvider({ children }: { children: ReactNode }) {
  return (
    <CurrentTurnMemoryCitationContext.Provider value>
      {children}
    </CurrentTurnMemoryCitationContext.Provider>
  )
}

// Scope-colored [M-NN] citation chip (SPEC §4.10c). Resolves the memory from
// the store; unresolved ids render as a neutral, non-interactive chip (either
// truly unknown, or the store hasn't loaded yet).
export function MemoryCitationChip({ id, children }: { id: string; children?: ReactNode }) {
  useEnsureMemoriesLoaded()
  const { chatId } = useTranscriptChatContext()
  const memory = useMemoryStore((s) => s.items.find((m) => m.id === id))
  const interruptApi = useTurnInterrupt()
  const belongsToCurrentTurn = useContext(CurrentTurnMemoryCitationContext)
  // Two-step confirm inside the hover card (C1: 轻确认防误触).
  const [stopArmed, setStopArmed] = useState(false)
  // The VISIBLE stop button next to the chip (2026-08-19 evening revision):
  // hover-only was undiscoverable. Same two-step confirm, auto-disarm.
  const [inlineArmed, setInlineArmed] = useState(false)
  const [hoverOpen, setHoverOpen] = useState(false)
  useSurfaceExposure({
    active: hoverOpen && Boolean(memory),
    surface: "citation_hover",
    chatId,
    initiator: "participant",
    memoryIds: [id],
    closeReason: "popover",
  })
  const inlineDisarmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(inlineDisarmTimer.current), [])
  const chipRef = useRef<HTMLSpanElement>(null)
  const label = children ?? `[${id}]`
  // The trace judged THIS reply as violating this memory — the chip carries
  // the drift signal in place, no click needed (advisor feedback 2026-07-16).
  const violatedHere = useMessageViolatedCitations()?.has(id) ?? false
  // One citation_hover beacon per chip instance — hover storms are noise.
  const hoverReportedRef = useRef(false)

  if (!memory) {
    return (
      <span
        title={`Stored memory ${id}`}
        data-memory-interrupt-source={belongsToCurrentTurn ? "current-turn" : undefined}
        className={cn(
          "inline-flex shrink-0 items-center whitespace-nowrap rounded-full border border-border bg-muted px-1.5 py-0.5 align-baseline font-mono text-[10px] leading-none text-muted-foreground",
          violatedHere && "shadow-[0_0_0_1.5px_rgb(239_68_68_/_0.7)]",
        )}
      >
        {label}
      </span>
    )
  }

  const scope = isMemoryScope(memory.scope) ? memory.scope : "session"

  const fireInterrupt = () => {
    // The anchor quote: the sentence block the chip sits in.
    const block = chipRef.current?.closest("p, li, td, div")
    interruptApi!.interrupt(id, block?.textContent?.trim().slice(0, 300) || undefined)
  }

  return (
    <>
    <HoverCard
      onOpenChange={(open) => {
        setHoverOpen(open)
        if (open && chatId && !hoverReportedRef.current) {
          hoverReportedRef.current = true
          recordUiMonitor("citation_hover", { ids: [id], sessionId: chatId, interaction: "hover" })
        }
        if (!open) setStopArmed(false)
      }}
    >
      <HoverCardTrigger asChild>
        <span
          ref={chipRef}
          data-memory-interrupt-source={belongsToCurrentTurn ? "current-turn" : undefined}
          className={cn(
            "inline-flex shrink-0 cursor-default items-center whitespace-nowrap rounded-full border px-1.5 py-0.5 align-baseline font-mono text-[10px] leading-none",
            MEMORY_SCOPE_CHIP_CLASSES[scope],
            violatedHere && "shadow-[0_0_0_1.5px_rgb(239_68_68_/_0.7)]",
          )}
        >
          {violatedHere ? <AlertTriangle className="mr-0.5 h-2.5 w-2.5 text-red-600 dark:text-red-400" /> : null}
          {label}
        </span>
      </HoverCardTrigger>
      <HoverCardContent className="w-80 space-y-2 text-xs">
        {violatedHere ? (
          <p className="flex items-center gap-1 font-medium text-red-600 dark:text-red-400">
            <AlertTriangle className="h-3 w-3 shrink-0" /> this reply violated the memory — details in the trace below
          </p>
        ) : null}
        {/* Hover shows the canonical read-only card — the ONE exception is the
            per-memory stop entry while a turn is running (2026-08-19 C1):
            spotting a misuse and stopping happen at the same place. */}
        <MemoryCardCore item={memory} />
        {interruptApi?.active && belongsToCurrentTurn ? (
          <button
            type="button"
            disabled={interruptApi.readOnly}
            onClick={() => {
              if (!stopArmed) {
                setStopArmed(true)
                return
              }
              fireInterrupt()
            }}
            className={cn(
              "w-full rounded-md px-2 py-1.5 text-left text-[11px] font-medium shadow-sm transition-colors",
              interruptApi.readOnly && "cursor-default opacity-70",
              stopArmed
                ? "bg-destructive text-destructive-foreground hover:bg-destructive/85"
                : "border border-destructive/40 text-destructive hover:bg-destructive/10",
            )}
          >
            {stopArmed ? "Confirm — stop the turn over this memory" : "This memory is being misused — stop"}
          </button>
        ) : null}
      </HoverCardContent>
    </HoverCard>
    {interruptApi?.active && belongsToCurrentTurn ? (
      // Visible per-memory stop, right where the chip streams in. Two-step:
      // first press arms (and auto-disarms), second press stops the turn.
      <button
        type="button"
        data-memory-interrupt="visible"
        disabled={interruptApi.readOnly}
        aria-label={interruptApi.readOnly ? "Stop control example" : inlineArmed ? "Confirm: stop the turn over this memory" : "Stop the turn over this memory"}
        title={interruptApi.readOnly ? "Stop control example (read-only)" : inlineArmed ? "Press again to stop the turn over this memory" : "Stop the turn over this memory"}
        onClick={() => {
          if (!inlineArmed) {
            setInlineArmed(true)
            clearTimeout(inlineDisarmTimer.current)
            inlineDisarmTimer.current = setTimeout(() => setInlineArmed(false), 4000)
            return
          }
          clearTimeout(inlineDisarmTimer.current)
          fireInterrupt()
        }}
        className={cn(
          "ml-1 inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-1 align-baseline font-medium text-[10px] leading-none transition-colors",
          interruptApi.readOnly && "cursor-default opacity-70",
          inlineArmed
            ? "border-destructive bg-destructive text-destructive-foreground"
            : "border-destructive/40 text-destructive hover:bg-destructive/10",
        )}
      >
        <Square className="h-2.5 w-2.5 fill-current" />
        {inlineArmed ? "Confirm" : "Stop"}
      </button>
    ) : null}
    </>
  )
}

// Helper function to extract text content from ReactNode
function extractText(node: ReactNode): string {
  if (typeof node === "string") {
    return node
  }
  if (typeof node === "number") {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(extractText).join("")
  }
  if (node && typeof node === "object" && "props" in node) {
    const props = node.props as { children?: ReactNode }
    return extractText(props.children)
  }
  return ""
}

type MarkdownChildNode = ReturnType<typeof Children.toArray>[number]

function withChildClassName(node: MarkdownChildNode, className: string): MarkdownChildNode {
  if (!isValidElement<{ className?: string }>(node)) {
    return node
  }

  return cloneElement(node, {
    className: cn(node.props.className, className),
  })
}

// Markdown component overrides
export const markdownComponents = {
  h1: ({ children }: { children?: ReactNode }) => (
    <h1 className="text-[20px] font-normal leading-tight mt-5 mb-3 first:mt-0 last:mb-0">{children}</h1>
  ),
  h2: ({ children }: { children?: ReactNode }) => (
    <h2 className="text-[18px] font-normal leading-tight mt-5 mb-3 first:mt-0 last:mb-0">{children}</h2>
  ),
  h3: ({ children }: { children?: ReactNode }) => (
    <h3 className="text-[16px] font-normal leading-tight mt-5 mb-3 first:mt-0 last:mb-0">{children}</h3>
  ),
  h4: ({ children }: { children?: ReactNode }) => (
    <h4 className="text-[16px] font-normal leading-tight mt-5 mb-3 first:mt-0 last:mb-0">{children}</h4>
  ),
  h5: ({ children }: { children?: ReactNode }) => (
    <h5 className="text-[16px] font-normal leading-tight mt-5 mb-3 first:mt-0 last:mb-0">{children}</h5>
  ),
  h6: ({ children }: { children?: ReactNode }) => (
    <h6 className="text-[16px] font-normal leading-tight mt-5 mb-3 first:mt-0 last:mb-0">{children}</h6>
  ),

  pre: ({ children, ...props }: ComponentPropsWithoutRef<"pre">) => {
    const [copied, setCopied] = useState(false)
    const textContent = extractText(children)

    const handleCopy = async () => {
      await navigator.clipboard.writeText(textContent)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }

    return (
      <div className="relative overflow-x-auto max-w-full min-w-0 no-code-highlight group/pre">
        <pre className="min-w-0 rounded-xl py-2.5 px-3.5 [.no-pre-highlight_&]:bg-background" {...props}>{children}</pre>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "absolute top-[35px] -translate-y-[50%] -translate-x-[1px] rounded-md right-1.5 h-8 w-8 text-muted-foreground opacity-0 group-hover/pre:opacity-100 transition-opacity",
            !copied && "hover:text-foreground",
            copied && "hover:!bg-transparent hover:!border-transparent"
          )}
          onClick={handleCopy}
        >
          {copied ? <Check className="h-4 w-4 text-green-400" /> : <Copy className="h-4 w-4" />}
        </Button>
      </div>
    )
  },

  code: ({ children, className, ...props }: ComponentPropsWithoutRef<"code">) => {
    const isInline = !className
    if (isInline) {
      return <code className="break-all px-1 bg-border/60 dark:[.no-pre-highlight_&]:bg-background dark:[.text-pretty_&]:bg-neutral [.no-code-highlight_&]:!bg-transparent py-0.5 rounded text-sm whitespace-wrap" {...props}>{children}</code>
    }
    return (
      <code className="block text-xs whitespace-pre" {...props}>
        {children}
      </code>
    )
  },

  table: ({ children, ...props }: ComponentPropsWithoutRef<"table">) => (
    <div className="border border-border  rounded-xl overflow-x-auto">
      <table className="table-auto min-w-full divide-y divide-border bg-background" {...props}>{children}</table>
    </div>
  ),

  tbody: ({ children, ...props }: ComponentPropsWithoutRef<"tbody">) => (
    <tbody className="divide-y divide-border" {...props}>{children}</tbody>
  ),

  th: ({ children, ...props }: ComponentPropsWithoutRef<"th">) => (
    <th className="text-left text-xs uppercase text-muted-foreground tracking-wider p-2 pl-0 first:pl-3 bg-muted dark:bg-card [&_*]:font-semibold" {...props}>{children}</th>
  ),
  td: ({ children, ...props }: ComponentPropsWithoutRef<"td">) => (
    <td className="text-left    p-2 pl-0 first:pl-3 [&_*]:font-normal " {...props}>{children}</td>
  ),

  p: ({ children, ...props }: ComponentPropsWithoutRef<"p">) => (
    <p className="break-words mt-5 mb-3 first:mt-0 last:mb-0" {...props}>{children}</p>
  ),

  blockquote: ({ children, ...props }: ComponentPropsWithoutRef<"blockquote">) => (
    (() => {
      const childNodes = Children.toArray(children)

      const firstChild = childNodes[0]
      if (firstChild !== undefined) {
        childNodes[0] = withChildClassName(firstChild, "mt-0")
      }

      const lastIndex = childNodes.length - 1
      const lastChild = childNodes[lastIndex]
      if (lastChild !== undefined) {
        childNodes[lastIndex] = withChildClassName(lastChild, "mb-0")
      }

      return (
        <blockquote
          className="my-2 mt-5 mb-3 first:mt-0 last:mb-0 border-l-2 border-border/80 pl-2 text-muted-foreground"
          {...props}
        >
          {childNodes}
        </blockquote>
      )
    })()
  ),

  a: ({ children, ...props }: ComponentPropsWithoutRef<"a">) => (
    <a
      className="transition-all underline decoration-2 text-logo decoration-logo/50 hover:text-logo/70 dark:text-logo dark:decoration-logo/70 dark:hover:text-logo/60 dark:hover:decoration-logo/40 "
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    >
      {children}
    </a>
  ),
}

export function createMarkdownComponents(options?: {
  onOpenLocalLink?: OpenLocalLinkHandler
}) {
  return {
    ...markdownComponents,
    a: ({ children, href, onClick, ...props }: ComponentPropsWithoutRef<"a">) => {
      const onOpenLocalLink = options?.onOpenLocalLink ?? useContext(OpenLocalLinkContext)
      const renderOptions = useTranscriptRenderOptions()

      // MemoSync memory citations: [M-NN] tokens are linkified to a private
      // scheme upstream (linkifyMemoryCitations); render them as scope-colored
      // chips with a hover card (SPEC §4.10c).
      const memoryId = parseMemoryCitationHref(href)
      if (memoryId) {
        return <MemoryCitationChip id={memoryId}>{children}</MemoryCitationChip>
      }

      const parsedLocalLink = parseLocalFileLink(href)

      if (parsedLocalLink && renderOptions.localLinkMode === "text") {
        return (
          <span className="transition-all underline decoration-2 text-logo decoration-logo/50">
            {children}
          </span>
        )
      }

      return (
        <a
          className="transition-all underline decoration-2 text-logo decoration-logo/50 hover:text-logo/70 dark:text-logo dark:decoration-logo/70 dark:hover:text-logo/60 dark:hover:decoration-logo/40 "
          href={href}
          target={parsedLocalLink ? undefined : "_blank"}
          rel={parsedLocalLink ? undefined : "noopener noreferrer"}
          onClick={(event) => {
            onClick?.(event)
            if (event.defaultPrevented || !parsedLocalLink || onOpenLocalLink === defaultOpenLocalLink) return
            event.preventDefault()
            onOpenLocalLink({
              ...parsedLocalLink,
              clientX: event.clientX,
              clientY: event.clientY,
              trigger: "click",
            })
          }}
          onContextMenu={(event) => {
            if (!parsedLocalLink || onOpenLocalLink === defaultOpenLocalLink) return
            event.preventDefault()
            onOpenLocalLink({
              ...parsedLocalLink,
              clientX: event.clientX,
              clientY: event.clientY,
              trigger: "contextmenu",
            })
          }}
          {...props}
        >
          {children}
        </a>
      )
    },
  }
}

/**
 * Stable, module-level markdown components for the common (no-options) case.
 * Calling createMarkdownComponents() inline in render returned a NEW `a`
 * component identity every render, so React unmounted+remounted every link
 * (memory citation chips lost their hover card, and citation_hover telemetry
 * re-fired) on each streaming chunk (BUG MSG-10). The `a` component reads the
 * open-local-link handler from context, so one shared instance is correct for
 * every caller that relies on the provider.
 */
export const markdownComponentsWithLinks = createMarkdownComponents()

/**
 * Escape `<`/`>` in the PROSE parts of user-authored text (leaving code spans
 * and fences untouched) before markdown rendering. react-markdown drops raw
 * HTML, so a user's own "Promise<void>", "<App/>", or "#include <stdio.h>" lost
 * the angle-bracket tokens in their own bubble (BUG MSG-13). Inside code the
 * brackets already render verbatim, so those segments are left as-is.
 */
export function escapeAngleBracketsOutsideCode(text: string): string {
  if (!text) return text
  const CODE_SEGMENT = /(```[\s\S]*?```|`[^`\n]*`)/g
  return text
    .split(CODE_SEGMENT)
    .map((segment, index) => (index % 2 === 1 ? segment : segment.replace(/</g, "&lt;").replace(/>/g, "&gt;")))
    .join("")
}

export const markdownWithHeadingsComponents = {
  ...markdownComponents,
}
