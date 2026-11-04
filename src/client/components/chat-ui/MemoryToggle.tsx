import { translateUiText } from "../../i18n/uiText"
import { t, useI18n } from "../../i18n"
import { BrainCircuit, Slash } from "lucide-react"
import { useState } from "react"
import { useInRouterContext, useOutletContext } from "react-router-dom"
import { create } from "zustand"
import type { MemorySettings } from "../../../shared/types"
import type { AppState } from "../../app/useAppState"
import { useAppSettingsStore } from "../../stores/appSettingsStore"
import { InputPopover, PopoverMenuItem } from "./ChatPreferenceControls"

export type MemoryMode = "off" | "review" | "auto"

/** Off is per chat (or global, from Settings); Ask and Auto are how memory runs everywhere. */
export function deriveMemoryMode(memory: MemorySettings, memoryDisabled: boolean): MemoryMode {
  if (!memory.enabled || memoryDisabled) return "off"
  return memory.control === "auto" ? "auto" : "review"
}

export function memorySettingsForMode(mode: Exclude<MemoryMode, "off">): Partial<MemorySettings> {
  // Picking a working mode also turns memory back on if Settings had it off.
  return { enabled: true, control: mode }
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

type MemoryToggleProps = { chatId?: string | null }

export function MemoryToggle(props: MemoryToggleProps) {
  useI18n()
  // The toggle reads chat state from the app's outlet and links to Settings,
  // both of which need the router. ChatInput is also mounted bare in isolated
  // fixtures; there it simply has no memory control.
  return useInRouterContext() ? <RoutedMemoryToggle {...props} /> : null
}

const MEMORY_MODE_LABELS: Record<MemoryMode, () => string> = {
  off: () => t("memory:modeOff"),
  review: () => t("memory:modeReview"),
  auto: () => t("memory:modeAuto"),
}

function RoutedMemoryToggle({ chatId }: MemoryToggleProps) {
  useI18n()
  const app = useOutletContext<AppState | null>()
  const memory = useAppSettingsStore((s) => s.settings?.memory) ?? { control: "review" as const, enabled: true, learn: true }
  const draftDisabled = useDraftMemoryDisabled((s) => s.disabled)
  const setDraftDisabled = useDraftMemoryDisabled((s) => s.setDisabled)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const runtime = app?.runtime && app.runtime.chatId === chatId ? app.runtime : null
  const chatDisabled = chatId ? (runtime?.memoryDisabled ?? false) : draftDisabled
  const mode = deriveMemoryMode(memory, chatDisabled)

  async function setChatDisabled(next: boolean) {
    if (!chatId) {
      setDraftDisabled(next)
      return
    }
    if (next === chatDisabled || !app) return
    setPending(true)
    setError(null)
    try {
      await app.socket.command({ type: "chat.setMemoryDisabled", chatId, disabled: next })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }

  function choose(next: MemoryMode) {
    if (next === "off") {
      void setChatDisabled(true)
      return
    }
    void setChatDisabled(false)
    if (memory.enabled && memory.control === next) return
    setError(null)
    app?.handleWriteAppSettings({ memory: memorySettingsForMode(next) })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
  }

  const options: Array<{ mode: MemoryMode; description: string }> = [
    { mode: "off", description: t("memory:modeOffDescription") },
    { mode: "review", description: t("memory:modeReviewDescription") },
    { mode: "auto", description: t("memory:modeAutoDescription") },
  ]

  return (
    <>
      <InputPopover
        disabled={pending || (Boolean(chatId) && !runtime)}
        align="start"
        triggerClassName="shrink-0"
        trigger={(
          <>
            <MemoryIcon off={mode === "off"} />
            <span>
              <span className="@max-[560px]/composer:hidden">{t("common:memory")} · </span>
              {MEMORY_MODE_LABELS[mode]()}
            </span>
          </>
        )}
      >
        {(close) => options.map((option) => (
          <PopoverMenuItem
            key={option.mode}
            selected={mode === option.mode}
            icon={<MemoryIcon off={option.mode === "off"} />}
            label={MEMORY_MODE_LABELS[option.mode]()}
            description={option.description}
            onClick={() => {
              choose(option.mode)
              close()
            }}
          />
        ))}
      </InputPopover>
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {translateUiText(error)}
        </span>
      ) : null}
    </>
  )
}
