import { useEffect, useRef, type ClipboardEvent, type DragEvent, type MouseEvent, type ReactNode } from "react"
import { ShieldAlert } from "lucide-react"

export type InstructionGuardSurface = "task_page" | "task_dialog"
export type InstructionGuardAction =
  | "copy"
  | "cut"
  | "contextmenu"
  | "selectstart"
  | "dragstart"
  | "keyboard_copy"
  | "devtools_shortcut"

export function classifyInstructionGuardKey(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): InstructionGuardAction | null {
  const key = event.key.toLocaleLowerCase("en-US")
  if ((event.metaKey || event.ctrlKey) && (key === "c" || key === "x")) return "keyboard_copy"
  if (key === "f12") return "devtools_shortcut"
  if (
    (event.ctrlKey && event.shiftKey && ["i", "j", "c"].includes(key))
    || (event.metaKey && event.altKey && ["i", "j", "c", "u"].includes(key))
  ) return "devtools_shortcut"
  return null
}

function clearSelection(): void {
  try {
    window.getSelection()?.removeAllRanges()
  } catch {
    // Selection APIs can be blocked by embedded browsers; prevention remains.
  }
}

export function ProtectedStudyInstructions(props: {
  surface: InstructionGuardSurface
  children: ReactNode
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const lastRecordedAt = useRef(new Map<InstructionGuardAction, number>())

  const record = (action: InstructionGuardAction) => {
    const now = Date.now()
    if (now - (lastRecordedAt.current.get(action) ?? 0) < 750) return
    lastRecordedAt.current.set(action, now)
    void fetch("/api/study/instruction-guard-event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, surface: props.surface }),
      keepalive: true,
    }).catch(() => undefined)
  }

  useEffect(() => {
    const blockKey = (event: KeyboardEvent) => {
      const action = classifyInstructionGuardKey(event)
      if (!action) return
      event.preventDefault()
      event.stopImmediatePropagation()
      clearSelection()
      record(action)
    }
    const blockSelection = (event: Event) => {
      if (!containerRef.current?.contains(event.target as Node | null)) return
      event.preventDefault()
      clearSelection()
      record("selectstart")
    }
    document.addEventListener("keydown", blockKey, true)
    document.addEventListener("selectstart", blockSelection, true)
    return () => {
      document.removeEventListener("keydown", blockKey, true)
      document.removeEventListener("selectstart", blockSelection, true)
    }
  })

  const block = (
    action: InstructionGuardAction,
    event: ClipboardEvent | MouseEvent | DragEvent,
  ) => {
    event.preventDefault()
    event.stopPropagation()
    clearSelection()
    record(action)
  }

  return (
    <div>
      <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-300/70 bg-amber-50 px-3 py-2.5 text-[13px] leading-relaxed text-amber-950 dark:border-amber-700/70 dark:bg-amber-950/30 dark:text-amber-100">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          Read these instructions, then explain the task to the agent in your own words.
          Do not copy, paste, or closely reproduce the instruction text.
        </p>
      </div>
      <div
        ref={containerRef}
        className="select-none"
        data-study-protected-instructions={props.surface}
        onCopy={(event) => block("copy", event)}
        onCut={(event) => block("cut", event)}
        onContextMenu={(event) => block("contextmenu", event)}
        onDragStart={(event) => block("dragstart", event)}
      >
        {props.children}
      </div>
    </div>
  )
}
