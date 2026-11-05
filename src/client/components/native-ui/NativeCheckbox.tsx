import { useEffect, useRef } from "react"
import { cn } from "../../lib/utils"

interface Props {
  checked: boolean
  indeterminate?: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
  "aria-label": string
  className?: string
}

/** A native checkbox, so tri-state and keyboard behaviour come from the platform. */
export function NativeCheckbox({ checked, indeterminate = false, disabled, onChange, className, ...props }: Props) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate }, [indeterminate])
  return <input ref={ref} type="checkbox" checked={checked} disabled={disabled} aria-label={props["aria-label"]} onChange={event => onChange(event.target.checked)}
    className={cn("size-3.5 shrink-0 cursor-pointer accent-foreground disabled:cursor-not-allowed disabled:opacity-40", className)} />
}
