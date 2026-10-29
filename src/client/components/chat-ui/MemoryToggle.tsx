import { translateUiText } from "../../i18n/uiText"
import { t, useI18n } from "../../i18n"
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
    ? t("memory:memoryIsTurnedOffInSettings")
    : memoryDisabled
      ? t("memory:thisChatDoesnTUseOrLearnMemoriesClickTo")
      : t("memory:memoryOnClickToTurnItOffForThisChat")
  return {
    off,
    label: off ? t("common:memoryOff") : null,
    action: memory.enabled ? ("toggle" as const) : ("settings" as const),
    tooltip: tooltip + (memory.enabled && !memory.learn ? t("memory:learningIsPausedInSettings") : ""),
  }
}

// Draft-only state follows the composer's draft key; existing chats use the server snapshot.
const useMemoryDrafts = create<{
  disabled: Record<string, boolean>
  setDisabled: (key: string, disabled: boolean) => void
}>((set) => ({
  disabled: {},
  setDisabled: (key, disabled) => set((state) => ({ disabled: { ...state.disabled, [key]: disabled } })),
}))

export function useDraftMemoryDisabled(draftKey?: string | null): [boolean, (disabled: boolean) => void] {
  useI18n()
  const key = draftKey ?? "new-chat"
  const disabled = useMemoryDrafts((s) => s.disabled[key] ?? false)
  const setDisabled = useMemoryDrafts((s) => s.setDisabled)
  return [disabled, (value) => setDisabled(key, value)]
}

export function MemoryIcon({ off = false }: { off?: boolean }) {
  useI18n()
  return (
    <span className="relative inline-flex h-3.5 w-3.5 shrink-0" aria-hidden="true">
      <BrainCircuit className="h-3.5 w-3.5" />
      {off ? <Slash className="absolute inset-0 h-3.5 w-3.5" strokeWidth={2.5} /> : null}
    </span>
  )
}

export function MemoryOffRowIcon() {
  useI18n()
  return (
    <span className="inline-flex shrink-0 text-muted-foreground/60" title={t("memory:memoryOffForThisChat")}>
      <MemoryIcon off />
    </span>
  )
}

type MemoryToggleProps = { chatId?: string | null; draftKey?: string | null }

export function MemoryToggle(props: MemoryToggleProps) {
  useI18n()
  // The toggle reads chat state from the app's outlet and links to Settings,
  // both of which need the router. ChatInput is also mounted bare in isolated
  // fixtures; there it simply has no memory control.
  return useInRouterContext() ? <RoutedMemoryToggle {...props} /> : null
}

function RoutedMemoryToggle({ chatId, draftKey }: MemoryToggleProps) {
  useI18n()
  const app = useOutletContext<AppState | null>()
  const navigate = useNavigate()
  const memory = useAppSettingsStore((s) => s.settings?.memory) ?? { enabled: true, learn: true }
  const [draftDisabled, setDraftDisabled] = useDraftMemoryDisabled(draftKey)
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
            aria-label={state.label ?? t("common:memoryOn")}
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
          {translateUiText(error)}
        </span>
      ) : null}
    </>
  )
}
