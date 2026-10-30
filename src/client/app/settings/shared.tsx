import { translateUiText } from "../../i18n/uiText"
import { t, useI18n } from "../../i18n"
import type { ButtonHTMLAttributes, KeyboardEvent, ReactNode } from "react"
import { Loader2 } from "lucide-react"
import type { ChatBrowserNotificationPreference } from "../../../shared/types"
import { Select, SelectContent, SelectGroup, SelectTrigger, SelectValue } from "../../components/ui/select"
import { cn } from "../../lib/utils"
import type { SettingsRowDef } from "./registry"

/** Shared row layout + tiny helpers for the settings sections. */

/*
 * Controls are visible objects, the way Codex and macOS settings draw them: a
 * quiet filled surface (no border) that sits on the card, one height (h-8),
 * one radius (rounded-lg) and one text size for every select, field, button
 * and segmented control. Plain-text accessories read as loose words on the
 * row's edge; a filled control anchors it.
 */
const SETTINGS_FOCUS_CLASS =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-0"

/** The fill every control shares, tuned to sit one step above the card in both themes. */
export const SETTINGS_CONTROL_FILL_CLASS =
  "bg-black/[0.045] hover:bg-black/[0.07] dark:bg-white/[0.07] dark:hover:bg-white/[0.10]"

const SETTINGS_SELECT_TRIGGER_CLASS = cn(
  "h-8 w-auto min-w-[8.5rem] max-w-full justify-between gap-2 rounded-lg border-0 px-2.5 text-[13px] text-foreground shadow-none",
  "data-[state=open]:bg-black/[0.08] dark:data-[state=open]:bg-white/[0.13]",
  "focus:ring-0 focus:ring-offset-0 [&>svg]:h-3.5 [&>svg]:w-3.5 [&>svg]:opacity-60",
  SETTINGS_CONTROL_FILL_CLASS,
  SETTINGS_FOCUS_CLASS,
)

/**
 * Text fields. They sit beside the row text once the column is wide and drop
 * under it when it isn't (container queries against the settings column, not
 * the viewport: with the app sidebar open the column can be narrow).
 */
const SETTINGS_INPUT_BASE_CLASS = cn(
  "h-8 rounded-lg border-0 px-2.5 py-0 text-[13px] text-foreground shadow-none placeholder:text-muted-foreground/60",
  SETTINGS_CONTROL_FILL_CLASS,
  SETTINGS_FOCUS_CLASS,
)
export const SETTINGS_CONTROL_CLASS = cn(SETTINGS_INPUT_BASE_CLASS, "w-full @2xl:w-64")
export const SETTINGS_NUMBER_INPUT_CLASS = cn(
  SETTINGS_INPUT_BASE_CLASS,
  "hide-number-steppers w-24 text-right font-mono tabular-nums",
)

/**
 * A select whose trigger is a row accessory. The panel lines up with the
 * trigger's right edge, where the trigger sits, instead of hanging off its
 * left into the row text.
 */
export function SettingsSelect({
  value,
  onValueChange,
  disabled,
  children,
  open,
  onOpenChange,
  "aria-label": ariaLabel,
  className,
}: {
  value: string
  onValueChange: (value: string) => void
  disabled?: boolean
  /** Controlled open state, for a row that opens the picker from anywhere on it. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** The SelectItems. */
  children: ReactNode
  "aria-label"?: string
  className?: string
}) {
  useI18n()
  return (
    <Select
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      open={open}
      onOpenChange={onOpenChange}
    >
      <SelectTrigger aria-label={ariaLabel} className={cn(SETTINGS_SELECT_TRIGGER_CLASS, className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        <SelectGroup>{children}</SelectGroup>
      </SelectContent>
    </Select>
  )
}

/**
 * A row's action ("Check for updates", "Edit models"): a small filled button.
 * `prominent` is for the one action a row is asking you to take, like
 * installing an available update.
 */
export function SettingsActionButton({
  children,
  className,
  icon,
  prominent = false,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon?: ReactNode; prominent?: boolean }) {
  useI18n()
  return (
    <button
      type={type}
      className={cn(
        "inline-flex h-8 min-w-0 max-w-full cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-[13px] font-medium",
        "touch-manipulation transition-[background-color,color,opacity,scale] duration-150 ease-out active:scale-[0.98]",
        "disabled:cursor-default disabled:opacity-50 disabled:active:scale-100 [&_svg]:size-3.5 [&_svg]:shrink-0",
        prominent ? "bg-primary text-primary-foreground hover:bg-primary/90" : cn("text-foreground", SETTINGS_CONTROL_FILL_CLASS),
        SETTINGS_FOCUS_CLASS,
        className,
      )}
      {...props}
    >
      {icon}
      {/* A narrow row gives the action half the width; a long label ("Update
          to 0.77.1-dev") ellipsizes instead of spilling over the title. */}
      <span className="truncate">{children}</span>
    </button>
  )
}

/** Inset for text that sits on the page above a card (group headings): aligned with the card's edge. */
export const SETTINGS_INSET_X_CLASS = "px-1"

/**
 * The card rows sit in, with a hairline between rows. overflow-hidden keeps
 * the palette's jump highlight inside the corners.
 */
export const SETTINGS_LIST_CARD_CLASS =
  "divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-muted/40 dark:bg-card"

/** Inline text actions inside a row description ("View tracked events", "Reset to …"). */
export const SETTINGS_INLINE_ACTION_CLASS =
  "font-medium text-foreground underline underline-offset-2 transition-colors hover:text-foreground/70"

export function getKeybindingsSubtitle(filePathDisplay: string) {
  return t("settings:editGlobalAppShortcutsStoredInValue0", { v0: filePathDisplay })
}

export function shouldPreviewChatSoundChange(previousValue: string, nextValue: string) {
  return previousValue !== nextValue
}

/**
 * A browser notification setting only sticks once the permission prompt was
 * granted; otherwise it falls back to "never" so the picker never claims an
 * option the browser will silently ignore.
 */
export function resolveChatBrowserNotificationPreferenceAfterPermission(
  requestedPreference: ChatBrowserNotificationPreference,
  permission: NotificationPermission | "unsupported",
): ChatBrowserNotificationPreference {
  if (requestedPreference === "never") return "never"
  return permission === "granted" ? requestedPreference : "never"
}

export function handleSettingsInputKeyDown(event: KeyboardEvent<HTMLInputElement>, commit: () => void) {
  if (event.key !== "Enter") return
  commit()
  event.currentTarget.blur()
}

/** Errors and warnings shown above or inside a section. */
export function SettingsNotice({
  tone = "error",
  children,
  className,
}: {
  tone?: "error" | "warning" | "info" | "success"
  children: ReactNode
  className?: string
}) {
  useI18n()
  return (
    <div
      role={tone === "error" ? "alert" : undefined}
      className={cn(
        "whitespace-pre-wrap break-words rounded-lg border px-3.5 py-2.5 text-[13px] leading-5",
        tone === "error"
          ? "border-destructive/20 bg-destructive/5 text-destructive"
          : tone === "info"
            ? "border-info/25 bg-info/8 text-info-foreground"
            : tone === "success"
              ? "border-success/20 bg-success/5 text-success-foreground"
              : "border-border bg-card/40 text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  )
}

export function SettingsErrorBanner({ message }: { message: string }) {
  useI18n()
  return <SettingsNotice className="mb-6">{translateUiText(message)}</SettingsNotice>
}

/** Loading and empty states: the same card everywhere, with an optional spinner. */
export function SettingsPlaceholder({
  loading = false,
  children,
  className,
}: {
  loading?: boolean
  children: ReactNode
  className?: string
}) {
  useI18n()
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-xl border border-border/70 bg-muted/40 px-4 py-6 text-[13px] text-muted-foreground dark:bg-card",
        className,
      )}
    >
      {loading ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : null}
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/** Small pill for states and tags ("Current", "Prerelease", plan names). */
export function SettingsBadge({ children, className }: { children: ReactNode; className?: string }) {
  useI18n()
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-md bg-black/[0.05] px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground dark:bg-white/[0.08]",
        className,
      )}
    >
      {children}
    </span>
  )
}

/**
 * The heading every titled block in settings uses (row groups, Skills'
 * "Installed"). Styled like the sidebar's section labels (SectionHeader in
 * ThreadSections): quiet chrome you scan past, not a second title.
 */
export function SettingsGroupHeading({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  useI18n()
  return (
    <div className={cn("flex min-h-8 items-end justify-between gap-3 pb-2", SETTINGS_INSET_X_CLASS)}>
      <h3 className="text-[13px] font-medium text-muted-foreground">{children}</h3>
      {trailing}
    </div>
  )
}

/**
 * A titled card of rows. The divider lines come from the group, so a row that
 * renders conditionally (the custom editor template) never leaves a double or
 * missing border behind.
 */
export function SettingsGroup({
  title,
  trailing,
  children,
  className,
}: {
  title?: ReactNode
  /** Extra controls on the heading's right (Skills' spinner and filter). */
  trailing?: ReactNode
  children: ReactNode
  className?: string
}) {
  useI18n()
  return (
    <section className={className}>
      {title ? <SettingsGroupHeading trailing={trailing}>{title}</SettingsGroupHeading> : null}
      <div className={SETTINGS_LIST_CARD_CLASS}>{children}</div>
    </section>
  )
}

/** Stacks groups with one rhythm across every section. */
export function SettingsGroups({ children }: { children: ReactNode }) {
  useI18n()
  return <div className="space-y-7">{children}</div>
}

/**
 * An input with the hint line under it ("1000–100000 lines (default)"). Its
 * row takes `wideControl`: with the hint the field is two lines tall, too tall
 * to sit on the title's line, so while the column is narrow it goes under the
 * description, left-aligned. No gap: the h-9 field already leaves air under
 * its text.
 */
export function SettingsField({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  useI18n()
  return (
    <div className="flex w-full min-w-0 flex-col items-stretch @2xl:w-auto @2xl:items-end">
      {children}
      {hint ? <div className="text-left text-xs text-muted-foreground/80 @2xl:text-right">{hint}</div> : null}
    </div>
  )
}

type SettingsRowProps = {
  children: ReactNode
  alignStart?: boolean
  /** Indents a row that only exists because of the row above it. */
  nested?: boolean
  /**
   * For controls too wide to share a line with the title (text fields, the
   * provider pickers): below the breakpoint they get their own full-width
   * line under the description. See SettingsRow for both layouts.
   */
  wideControl?: boolean
  disabled?: boolean
  /** A logo before the title (the provider rows). Spaced like the Accounts rows so their names line up. */
  icon?: ReactNode
  /**
   * Overrides `def.description` when the rendered description is dynamic JSX.
   * `null` shows no subtitle; the def's description still feeds palette search.
   */
  description?: ReactNode
} & (
  | {
      /** Registry def: provides the anchor id (palette jump target) + title/description. */
      def: SettingsRowDef
      title?: string
    }
  | {
      def?: undefined
      title: string
    }
)

export function SettingsRow({
  def,
  title,
  description,
  icon,
  children,
  alignStart = false,
  nested = false,
  wideControl = false,
  disabled = false,
}: SettingsRowProps) {
  useI18n()
  const resolvedDescription = description === undefined ? def?.description : description
  const hasDescription = Boolean(resolvedDescription)
  /*
   * Two layouts on one grid, switched at the column's @2xl breakpoint.
   *
   * Wide: text on the left, control on the right, centred on the text.
   *
   *   Title        [control]
   *   Description  [control]
   *
   * Narrow: beside the text, the control squeezed the description into a
   * thin column of two-word lines. Instead a small control shares the title's
   * line and the description takes the full width under both. A wide control
   * has no room on that line, so it gets its own full-width line last.
   *
   *   Title   [control]        Title
   *   Description.........     Description.........
   *                            [wide control.......]
   *
   * Spacing is margins, not gap, so an empty description row adds nothing.
   */
  return (
    <div
      id={def?.id}
      data-settings-row={def ? "" : undefined}
      aria-disabled={disabled || undefined}
      className={cn("scroll-mt-4 px-4", disabled && "opacity-50")}
    >
      <div className={cn("grid min-h-[52px] grid-cols-[minmax(0,1fr)_auto] content-center gap-x-4 py-3 @2xl:gap-x-10", nested && "pl-6")}>
        <div
          className="col-[1] row-[1] flex min-w-0 items-center gap-3 self-center text-[13.5px] font-medium leading-5 text-foreground @2xl:max-w-xl"
        >
          {icon}
          <span className="min-w-0">{title ?? def?.title}</span>
        </div>
        {hasDescription ? (
          <div className="col-[1/-1] row-[2] mt-0.5 text-[12.5px] leading-[18px] text-muted-foreground @2xl:col-[1] @2xl:max-w-xl">
            {resolvedDescription}
          </div>
        ) : null}
        <div
          className={cn(
            "flex min-w-0 items-center self-center",
            wideControl
              ? "col-[1/-1] row-[3] mt-2 justify-start @2xl:col-[2] @2xl:mt-0 @2xl:justify-end"
              // The control is h-8 but the title line is h-5: the negative
              // margin lets it centre on the title without pushing the
              // description down.
              : "col-[2] row-[1] -my-1.5 max-w-[50cqw] justify-end @2xl:my-0",
            hasDescription ? "@2xl:row-[1/3]" : "@2xl:row-[1]",
            alignStart && "@2xl:self-start",
          )}
        >
          {children}
        </div>
      </div>
    </div>
  )
}

export interface SettingsSegmentOption<T extends string> {
  value: T
  label: ReactNode
  icon?: ReactNode
}

/**
 * Two to four mutually exclusive choices shown at once (theme, Enter while
 * running). Same fill, height and radius as the other controls; the chosen
 * segment lifts onto the background like a macOS segmented control.
 */
export function SettingsSegmented<T extends string>({
  value,
  onValueChange,
  options,
  disabled,
  "aria-label": ariaLabel,
}: {
  value: T
  onValueChange: (value: T) => void
  options: readonly SettingsSegmentOption<T>[]
  disabled?: boolean
  "aria-label"?: string
}) {
  useI18n()
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-0.5 rounded-lg p-0.5",
        "bg-black/[0.045] dark:bg-white/[0.07]",
        disabled && "pointer-events-none opacity-50",
      )}
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => { if (!active) onValueChange(option.value) }}
            className={cn(
              "inline-flex h-7 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-[13px] transition-colors",
              "[&_svg]:size-3.5 [&_svg]:shrink-0",
              active
                ? "bg-background font-medium text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.08)] dark:bg-white/[0.14] dark:shadow-none"
                : "text-muted-foreground hover:text-foreground",
              SETTINGS_FOCUS_CLASS,
            )}
          >
            {option.icon}
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
