import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { Keyboard } from "lucide-react"
import { useMemo, useState } from "react"
import type { KeybindingAction } from "../../../shared/types"
import { t, useI18n } from "../../i18n"
import { formatBindingParts, KEYBINDING_ACTION_LABELS, preferredBinding } from "../../lib/keybindings"
import { cn } from "../../lib/utils"
import { buildKeyUsage, getKeyboardRows, SHORTCUT_CATEGORY_BY_ACTION, type KeyboardKey, type ShortcutCategory } from "./shortcutKeyboardModel"

const categoryStyles: Record<ShortcutCategory, { key: string; active: string; dot: string }> = {
  panels: {
    key: "bg-sky-500/12 border-sky-500/35 text-sky-700 dark:bg-sky-400/14 dark:border-sky-400/30 dark:text-sky-200",
    active: "bg-sky-500/25 border-sky-500/60 dark:bg-sky-400/30 dark:border-sky-400/60",
    dot: "bg-sky-500 dark:bg-sky-300",
  },
  terminal: {
    key: "bg-emerald-500/12 border-emerald-500/35 text-emerald-700 dark:bg-emerald-400/14 dark:border-emerald-400/30 dark:text-emerald-200",
    active: "bg-emerald-500/25 border-emerald-500/60 dark:bg-emerald-400/30 dark:border-emerald-400/60",
    dot: "bg-emerald-500 dark:bg-emerald-300",
  },
  workspace: {
    key: "bg-violet-500/12 border-violet-500/35 text-violet-700 dark:bg-violet-400/14 dark:border-violet-400/30 dark:text-violet-200",
    active: "bg-violet-500/25 border-violet-500/60 dark:bg-violet-400/30 dark:border-violet-400/60",
    dot: "bg-violet-500 dark:bg-violet-300",
  },
}

export function ShortcutCategoryDot({ action }: { action: KeybindingAction }) {
  useI18n()
  const category = SHORTCUT_CATEGORY_BY_ACTION[action]
  return category ? <span aria-hidden className={cn("inline-block size-1.5 shrink-0 rounded-full", categoryStyles[category].dot)} /> : null
}

interface ShortcutKeyboardProps {
  bindings: Record<KeybindingAction, string[]>
  actions: KeybindingAction[]
  apple: boolean
  activeCodes: string[]
  pressedCodes: Set<string>
  onHoverKey: (code: string | null) => void
  onPickAction: (action: KeybindingAction) => void
  focusedAction: KeybindingAction | null
}

export function ShortcutKeyboard({ bindings, actions, apple, activeCodes, pressedCodes, onHoverKey, onPickAction, focusedAction }: ShortcutKeyboardProps) {
  useI18n()
  const reduced = useReducedMotion()
  const [hovered, setHovered] = useState<string | null>(null)
  const rows = useMemo(() => getKeyboardRows(apple), [apple])
  const usage = useMemo(() => buildKeyUsage(bindings, actions), [bindings, actions])
  const previewActions = hovered
    ? [...new Set((usage.get(hovered) ?? []).map((item) => item.action))]
    : focusedAction ? [focusedAction] : []
  const footerKey = previewActions.join(",") || "idle"

  const setHover = (code: string | null) => {
    setHovered(code)
    onHoverKey(code)
  }

  function renderKey(item: KeyboardKey, stacked = false) {
    const items = usage.get(item.code) ?? []
    const keyActions = [...new Set(items.map((entry) => entry.action))]
    const category = keyActions[0] ? SHORTCUT_CATEGORY_BY_ACTION[keyActions[0]] : undefined
    const pressed = pressedCodes.has(item.code)
    const activeIndex = activeCodes.indexOf(item.code)
    const active = activeIndex >= 0
    const common = cn(
      "relative flex min-w-0 items-center justify-center rounded-md border text-[11px] tabular-nums transition-colors duration-150 @xl:text-xs",
      stacked ? "h-[calc((100%-2px)/2)]" : "h-8 @xl:h-9",
      category ? categoryStyles[category].key : "border-black/[0.08] bg-background/70 text-muted-foreground/70 dark:border-white/[0.07] dark:bg-white/[0.04]",
      active && (category ? categoryStyles[category].active : "border-foreground/25 bg-foreground/10 text-foreground"),
      !pressed && "shadow-[0_1px_0_rgb(0_0_0/0.06)] dark:shadow-[0_1px_0_rgb(0_0_0/0.4)]",
    )
    const animate = reduced ? {} : { y: pressed ? 1.5 : active ? 1 : 0, scale: pressed ? 0.97 : 1 }
    const transition = { type: "spring" as const, stiffness: 500, damping: 28, delay: pressed ? 0 : Math.max(activeIndex, 0) * 0.045 }
    const style = stacked ? undefined : { flex: `${item.width} 1 0%` }
    if (!category) return <motion.span key={item.code} aria-hidden className={common} style={style} animate={animate} transition={transition}>{item.label}</motion.span>
    return (
      <motion.button
        key={item.code}
        type="button"
        aria-label={`${item.label} — ${keyActions.map((action) => KEYBINDING_ACTION_LABELS[action]).join(", ")}`}
        className={cn(common, "outline-none focus-visible:ring-2 focus-visible:ring-focus/40 focus-visible:!outline-2 focus-visible:!outline-solid focus-visible:!outline-focus/60")}
        style={style}
        animate={animate}
        transition={transition}
        whileHover={reduced ? undefined : { y: -1.5, scale: 1.05 }}
        whileTap={reduced ? undefined : { y: 1, scale: 0.97 }}
        onMouseEnter={() => setHover(item.code)}
        onMouseLeave={() => setHover(null)}
        onFocus={() => setHover(item.code)}
        onBlur={() => setHover(null)}
        onClick={() => onPickAction(keyActions[0]!)}
      >
        <span className={cn(keyActions.length && !stacked && "-translate-y-0.5")}>{item.label}</span>
        <span className="absolute bottom-1 flex items-center gap-0.5" aria-hidden>
          {keyActions.slice(0, 2).map((action) => (
            <motion.span key={action} initial={reduced ? false : { scale: 0 }} animate={reduced ? {} : { scale: 1 }}
              transition={{ duration: 0.18, delay: 0.18 }} className={cn("size-[3px] rounded-full", categoryStyles[SHORTCUT_CATEGORY_BY_ACTION[action]!].dot)} />
          ))}
        </span>
      </motion.button>
    )
  }

  return (
    <section className="mb-7 hidden overflow-hidden rounded-xl border border-border/70 bg-muted/40 dark:bg-card @md:block">
      <div className="flex items-start justify-between gap-4 px-5 pb-4 pt-5">
        <div>
          <h2 className="text-[15px] font-medium text-foreground">{t("settings:shortcutOverview")}</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">{t("settings:shortcutOverviewHint")}</p>
        </div>
        <span className="rounded-md border border-border/80 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">QWERTY</span>
      </div>
      <div className="px-5 pb-4">
        <div className="mx-auto max-w-[640px] rounded-2xl border border-black/[0.08] bg-black/[0.03] p-[10px] shadow-[0_3px_0_rgb(0_0_0/0.09)] dark:border-white/[0.06] dark:bg-black/25 dark:shadow-[0_3px_0_rgb(0_0_0/0.35)]">
          <div className="space-y-[5px]">
            {rows.map((row, index) => (
              <motion.div key={index} className="flex gap-[5px]"
                initial={reduced ? false : { opacity: 0, y: 6 }} animate={reduced ? {} : { opacity: 1, y: 0 }}
                transition={{ type: "spring", stiffness: 420, damping: 32, mass: 0.7, delay: index * 0.035 }}>
                {row.map((item) => item.code === "Spacer"
                  ? <span key={item.code} aria-hidden style={{ flex: `${item.width} 1 0%` }} />
                  : item.code === "ArrowStack"
                    ? <span key={item.code} className="flex h-8 min-w-0 flex-col gap-0.5 @xl:h-9" style={{ flex: `${item.width} 1 0%` }}>
                        {renderKey({ code: "ArrowUp", label: "↑", width: 1 }, true)}
                        {renderKey({ code: "ArrowDown", label: "↓", width: 1 }, true)}
                      </span>
                    : renderKey(item))}
              </motion.div>
            ))}
          </div>
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
          {(["panels", "terminal", "workspace"] as const).map((category) => (
            <span key={category} className="inline-flex items-center gap-2"><span className={cn("size-2 rounded-full", categoryStyles[category].dot)} />
              {category === "panels" ? t("settings:shortcutCategoryPanels") : category === "terminal" ? t("settings:shortcutCategoryTerminal") : t("settings:shortcutCategoryWorkspace")}
            </span>
          ))}
        </div>
      </div>
      <div className="flex min-h-14 items-center gap-3 border-t border-border/70 px-5 py-2 text-xs text-muted-foreground">
        <Keyboard size={16} aria-hidden className="shrink-0" />
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={footerKey} className="flex min-w-0 items-center gap-x-4 overflow-x-auto whitespace-nowrap"
            initial={reduced ? false : { opacity: 0, y: 4 }} animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }} transition={{ duration: reduced ? 0 : 0.12 }}>
            {previewActions.length ? previewActions.map((action) => {
              const candidates = hovered ? (usage.get(hovered) ?? []).filter((entry) => entry.action === action).map((entry) => entry.binding) : bindings[action]
              const binding = preferredBinding(candidates, apple)
              return <span key={action} className="inline-flex items-center gap-1.5">
                <ShortcutCategoryDot action={action} /><span className="text-foreground/80">{KEYBINDING_ACTION_LABELS[action]}</span>
                {binding ? <span className="inline-flex gap-0.5">{formatBindingParts(binding, apple).map((part, index) => <kbd key={`${part}-${index}`} className="rounded bg-black/[0.05] px-1 py-0.5 font-sans text-[10px] dark:bg-white/[0.08]">{part}</kbd>)}{action === "jumpToSidebarChat" ? <kbd className="rounded bg-black/[0.05] px-1 py-0.5 font-sans text-[10px] dark:bg-white/[0.08]">1–9</kbd> : null}</span> : null}
              </span>
            }) : t("settings:shortcutHoverHint")}
          </motion.div>
        </AnimatePresence>
      </div>
    </section>
  )
}
