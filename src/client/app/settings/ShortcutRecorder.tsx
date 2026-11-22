import { AnimatePresence, motion, useAnimationControls, useReducedMotion } from "motion/react"
import { Plus } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { KeybindingAction } from "../../../shared/types"
import { t, useI18n } from "../../i18n"
import { formatBindingParts } from "../../lib/keybindings"
import { cn } from "../../lib/utils"
import { createShortcutRecordingHandlers } from "./shortcutRecording"
import { SETTINGS_CONTROL_FILL_CLASS } from "./shared"

const spring = { type: "spring" as const, stiffness: 420, damping: 32, mass: 0.7 }

export function ShortcutKeycaps({ binding, apple, modifierOnly = false }: { binding: string; apple: boolean; modifierOnly?: boolean }) {
  useI18n()
  return (
    <span className="inline-flex flex-wrap items-center gap-0.5">
      {formatBindingParts(binding, apple).map((part, index) => (
        <kbd key={`${part}-${index}`} className="inline-flex h-6 min-w-6 items-center justify-center rounded-md bg-black/[0.045] px-1.5 font-sans text-[11px] font-medium text-foreground shadow-[0_1px_0_rgb(0_0_0/0.12)] dark:bg-white/[0.09] dark:shadow-[0_1px_0_rgb(0_0_0/0.45)]">{part}</kbd>
      ))}
      {modifierOnly ? <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded-md bg-black/[0.045] px-1.5 font-sans text-[11px] text-muted-foreground shadow-[0_1px_0_rgb(0_0_0/0.12)] dark:bg-white/[0.09] dark:shadow-[0_1px_0_rgb(0_0_0/0.45)]">1–9</kbd> : null}
    </span>
  )
}

type RecordingIndex = number | "new" | null

interface ShortcutRecorderProps {
  action: KeybindingAction
  label: string
  bindings: string[]
  apple: boolean
  recording: RecordingIndex
  onStartRecording: (index: number | "new") => void
  onStopRecording: () => void
  onCommit: (nextBindings: string[]) => void
  conflictLabel: (chord: string, alias?: string) => string | null
  modifierOnly: boolean
  onRecordingCodesChange?: (codes: Set<string>) => void
}

export function ShortcutRecorder(props: ShortcutRecorderProps) {
  useI18n()
  const { action, label, bindings, apple, recording, onStartRecording, modifierOnly } = props
  const reduced = useReducedMotion()
  const shakeControls = useAnimationControls()
  const [modifiers, setModifiers] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const activeRef = useRef<HTMLButtonElement | null>(null)
  const propsRef = useRef(props)
  propsRef.current = props

  useEffect(() => {
    if (recording === null) {
      setModifiers(null)
      setError(null)
      return
    }
    const stop = () => {
      propsRef.current.onRecordingCodesChange?.(new Set())
      propsRef.current.onStopRecording()
    }
    const commit = (chord: string, alias?: string) => {
      const current = propsRef.current
      const conflict = alias ? current.conflictLabel(chord, alias) : current.conflictLabel(chord)
      if (conflict) {
        setError(t("settings:shortcutInUseBy", { action: conflict }))
        if (!reduced) void shakeControls.start({ x: [0, -4, 4, -3, 3, 0], transition: { duration: 0.28 } })
        return
      }
      if (!current.bindings.includes(chord)) {
        const next = [...current.bindings]
        if (recording === "new") next.push(chord)
        else next[recording] = chord
        current.onCommit(next)
      }
      stop()
    }
    const { keydown, keyup } = createShortcutRecordingHandlers({
      isModifierOnly: () => propsRef.current.modifierOnly,
      commit,
      stop,
      remove: () => {
        if (recording !== "new") propsRef.current.onCommit(propsRef.current.bindings.filter((_, index) => index !== recording))
      },
      setModifiers,
      setCodes: (codes) => propsRef.current.onRecordingCodesChange?.(codes),
      clearError: () => setError(null),
      needsModifier: () => setError(t("settings:shortcutNeedsModifier")),
    })
    const outside = (event: PointerEvent) => {
      if (!activeRef.current?.contains(event.target as Node)) stop()
    }
    window.addEventListener("keydown", keydown, true)
    window.addEventListener("keyup", keyup, true)
    document.addEventListener("pointerdown", outside, true)
    window.addEventListener("blur", stop)
    return () => {
      window.removeEventListener("keydown", keydown, true)
      window.removeEventListener("keyup", keyup, true)
      document.removeEventListener("pointerdown", outside, true)
      window.removeEventListener("blur", stop)
    }
  }, [action, recording, reduced, shakeControls])

  const recordingContent = (
    <motion.span className="relative inline-flex min-h-6 items-center" animate={shakeControls}>
      <motion.span
        className="absolute inset-0 rounded-lg ring-2 ring-focus/50"
        animate={reduced ? { opacity: 1 } : { opacity: [1, 0.45, 1] }}
        transition={reduced ? { duration: 0 } : { duration: 1.4, repeat: Infinity }}
        aria-hidden
      />
      {modifiers ? <ShortcutKeycaps binding={modifiers} apple={apple} /> : <span className="px-1 text-xs text-muted-foreground">{t("settings:pressShortcut")}</span>}
      <span role="status" aria-live="polite" className="sr-only">{t("settings:recordingShortcutFor", { action: label })}</span>
    </motion.span>
  )

  return (
    <div className="flex min-w-0 flex-col items-start gap-1 @2xl:items-end">
      <div className="flex flex-wrap items-center gap-1.5 @2xl:justify-end">
        <AnimatePresence initial={false}>
          {bindings.map((binding, index) => (
            <motion.button
              key={`${index}:${binding}`}
              layout
              ref={recording === index ? activeRef : undefined}
              type="button"
              aria-label={`${label}: ${formatBindingParts(binding, apple).join(" ")}`}
              onClick={() => onStartRecording(index)}
              initial={reduced ? false : { scale: 0.92, opacity: 0.6 }}
              animate={reduced ? { opacity: 1 } : { scale: 1, opacity: 1 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
              transition={reduced ? { duration: 0 } : spring}
              className={cn("relative inline-flex min-h-8 items-center rounded-lg p-1 outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-focus/40 focus-visible:!outline-2 focus-visible:!outline-solid focus-visible:!outline-focus/60", SETTINGS_CONTROL_FILL_CLASS)}
            >
              {recording === index ? recordingContent : <ShortcutKeycaps binding={binding} apple={apple} modifierOnly={modifierOnly} />}
            </motion.button>
          ))}
        </AnimatePresence>
        {!bindings.length && recording !== "new" ? <span className="text-xs text-muted-foreground">{t("settings:shortcutUnassigned")}</span> : null}
        {recording === "new" ? (
          <motion.button ref={activeRef} type="button" className={cn("relative inline-flex min-h-8 items-center rounded-lg p-1", SETTINGS_CONTROL_FILL_CLASS)}>
            {recordingContent}
          </motion.button>
        ) : (
          <button type="button" aria-label={t("settings:addShortcut")} onClick={() => onStartRecording("new")}
            className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors duration-150 hover:bg-black/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus/40 focus-visible:!outline-2 focus-visible:!outline-solid focus-visible:!outline-focus/60 dark:hover:bg-white/[0.08]">
            <Plus size={14} aria-hidden />
          </button>
        )}
      </div>
      <AnimatePresence initial={false}>
        {error && recording !== null ? <motion.p key={error} initial={reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }} role="alert" className="text-xs text-destructive">{error}</motion.p> : null}
      </AnimatePresence>
    </div>
  )
}
