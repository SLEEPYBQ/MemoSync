import type {
  ComponentPropsWithoutRef,
  DragEvent,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
} from "react"
import { cn } from "../../lib/utils"

function stopActivation(event: MouseEvent<HTMLDivElement> | FormEvent<HTMLDivElement> | DragEvent<HTMLDivElement>) {
  event.preventDefault()
  event.stopPropagation()
}

function stopKeyboardActivation(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== "Enter" && event.key !== " ") return
  event.preventDefault()
  event.stopPropagation()
}

/**
 * A Guide panel must remain a real scroll surface even when its actions are
 * only being demonstrated. CSS `pointer-events-none` cannot express that: it
 * removes the scrollbar's wheel/trackpad hit target together with the
 * controls. Keep pointer input enabled here and suppress only activation
 * events in read-only lessons.
 */
export function GuidePanelSurface({
  readOnly = false,
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<"div"> & { readOnly?: boolean }) {
  return (
    <div
      {...props}
      data-guide-panel="true"
      data-guide-read-only={readOnly ? "true" : "false"}
      className={cn("touch-pan-y", readOnly && "select-none", className)}
      onClickCapture={readOnly ? stopActivation : props.onClickCapture}
      onContextMenuCapture={readOnly ? stopActivation : props.onContextMenuCapture}
      onDragStartCapture={readOnly ? stopActivation : props.onDragStartCapture}
      onSubmitCapture={readOnly ? stopActivation : props.onSubmitCapture}
      onKeyDownCapture={readOnly ? stopKeyboardActivation : props.onKeyDownCapture}
    >
      {children}
    </div>
  )
}
