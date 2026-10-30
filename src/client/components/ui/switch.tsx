import { cn } from "../../lib/utils"

interface SwitchProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  className?: string
  "aria-label"?: string
}

/**
 * A binary on/off control. Settings used an "Off | On" segmented control for
 * these, which read like a choice between two modes rather than a toggle.
 */
export function Switch({ checked, onCheckedChange, disabled, className, ...props }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={props["aria-label"]}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "group relative inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent",
        // Opacity too, so a switch disabled by another setting dims as its knob
        // slides off rather than before.
        "transition-[background-color,opacity] duration-300 ease-out",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-muted-foreground/30",
        className,
      )}
    >
      {/* The thumb is the track's contrast colour: white in light mode. In
          dark mode "on" is the light primary track, so the thumb goes dark
          there and light when off, keeping it visible on the dark track.

          Pressing stretches the thumb toward the side it will travel to, as
          an iOS switch does: the press is answered on pointer-down, before
          the click commits. Width rather than scaleX, which would flatten
          the round ends; the thumb is 20px inside a fixed track, so nothing
          else reflows. Checked, it moves left by the stretch so its right
          edge stays put. Reduced motion drops the stretch and the slide;
          the track's colour still says which way it went. */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none block h-5 w-5 rounded-full bg-primary-foreground shadow-sm",
          // The slide takes 350ms so the travel reads; the stretch stays at 150ms
          // because it answers the press and has to feel immediate.
          "[transition:translate_350ms_ease-out,width_150ms_ease-out]",
          "motion-safe:group-enabled:group-active:w-6 motion-reduce:transition-none",
          checked
            ? "translate-x-4 motion-safe:group-enabled:group-active:translate-x-3"
            : "translate-x-0 dark:bg-foreground/85",
        )}
      />
    </button>
  )
}
