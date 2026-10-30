import type { ReactElement } from "react"
import type { ApiProtocol } from "../../../shared/model-access"
import { t } from "../../i18n"
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip"

export const CONNECTION_FIELD_CLASS =
  "h-9 min-w-0 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
export const MODEL_ACCESS_DIALOG_CLASS = "model-access-ui @container w-[calc(100%-2rem)] max-w-2xl"
export const MODEL_ACCESS_FOCUS_CLASS =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
export function protocolLabel(protocol: ApiProtocol) {
  return t(
    protocol === "anthropic-messages"
      ? "modelAccess:protocolAnthropic"
      : protocol === "openai-responses"
        ? "modelAccess:protocolResponses"
        : "modelAccess:protocolChat",
  )
}
export function Hint({ children, text }: { children: ReactElement; text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent className="max-w-sm break-all">{text}</TooltipContent>
    </Tooltip>
  )
}
