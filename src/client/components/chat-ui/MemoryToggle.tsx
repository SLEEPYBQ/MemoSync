import { BrainCircuit, Slash } from "lucide-react"
import { useState } from "react"
import { useInRouterContext, useNavigate, useOutletContext } from "react-router-dom"
import { create } from "zustand"
import type { MemorySettings } from "../../../shared/types"
import type { AppState } from "../../app/useAppState"
import { cn } from "../../lib/utils"
import { useAppSettingsStore } from "../../stores/appSettingsStore"
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip"

export function deriveMemoryToggleState(
  memory: MemorySettings,
  memoryDisabled: boolean,
) {
  const off = !memory.enabled || memoryDisabled
  const tooltip = !memory.enabled
    ? "Memory is turned off in Settings"
    : memoryDisabled
      ? "This chat doesn't use or learn memories. Click to turn memory back on."
      : "Memory on — click to turn it off for this chat"
  return {
    off,
    label: off ? "Memory off" : null,
    action: memory.enabled ? ("toggle" as const) : ("settings" as const),
    tooltip: tooltip + (memory.enabled && !memory.learn ? " Learning is paused in Settings" : ""),
  }
}

// One choice for the next new chat, shared by every new-chat composer (landing
// and project pages); existing chats use the server snapshot.
export const useDraftMemoryDisabled = create<{
  disabled: boolean
  setDisabled: (disabled: boolean) => void
}>((set) => ({
  disabled: false,
  setDisabled: (disabled) => set({ disabled }),
}))

export function MemoryIcon({ off = false }: { off?: boolean }) {
  return (
    <span className="relative inline-flex h-3.5 w-3.5 shrink-0" aria-hidden="true">
      <BrainCircuit className="h-3.5 w-3.5" />
      {off ? <Slash className="absolute inset-0 h-3.5 w-3.5" strokeWidth={2.5} /> : null}
    </span>
  )
}

export function MemoryOffRowIcon() {
  return (
    <span className="inline-flex shrink-0 text-muted-foreground/60" title="Memory off for this chat">
      <MemoryIcon off />
    </span>
  )
}

type MemoryToggleProps = { chatId?: string | null }

export function MemoryToggle(props: MemoryToggleProps) {
  // The toggle reads chat state from the app's outlet and links to Settings,
  // both of which need the router. ChatInput is also mounted bare in isolated
  // fixtures; there it simply has no memory control.
  return useInRouterContext() ? <RoutedMemoryToggle {...props} /> : null
}

function RoutedMemoryToggle({ chatId }: MemoryToggleProps) {
  const app = useOutletContext<AppState | null>()
  const navigate = useNavigate()
  const memory = useAppSettingsStore((s) => s.settings?.memory) ?? { enabled: true, learn: true }
  const draftDisabled = useDraftMemoryDisabled((s) => s.disabled)
  const setDraftDisabled = useDraftMemoryDisabled((s) => s.setDisabled)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const runtime = app?.runtime && app.runtime.chatId === chatId ? app.runtime : null
  const disabled = chatId ? (runtime?.memoryDisabled ?? false) : draftDisabled
  const state = deriveMemoryToggleState(memory, disabled)

  async function toggle() {
    if (state.action === "settings") {
      navigate("/settings/memory#memoryEnabled")
      return
    }
    if (!chatId) {
      setDraftDisabled(!disabled)
      return
    }
    if (!app) return
    setPending(true)
    setError(null)
    try {
      await app.socket.command({ type: "chat.setMemoryDisabled", chatId, disabled: !disabled })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={state.label ?? "Memory on"}
            aria-pressed={!state.off}
            disabled={pending || (Boolean(chatId) && !runtime && state.action !== "settings")}
            className={cn(
              "flex items-center gap-1.5 px-2 py-1 text-sm rounded-md transition-colors cursor-pointer hover:bg-muted/50 disabled:opacity-50 [&>span]:whitespace-nowrap",
              // Off changes what the agent does, so it reads as a state to notice, not a preference.
              state.off ? "text-cand-fg" : "text-muted-foreground",
            )}
            onClick={() => {
              void toggle()
            }}
          >
            <MemoryIcon off={state.off} />
            {state.label ? <span>{state.label}</span> : null}
          </button>
        </TooltipTrigger>
        <TooltipContent>{state.tooltip}</TooltipContent>
      </Tooltip>
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </>
  )
}
