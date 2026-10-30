import { CachedMarkdown } from "./CachedMarkdown"
import type { ProcessedTextMessage } from "./types"
import { CurrentTurnMemoryCitationProvider } from "./shared"
import { MessageViolatedCitationsProvider, useViolatedCitationsMap } from "./render-context"
import { linkifyMemoryCitations } from "../../lib/memoryCitations"

export { urlTransform } from "./CachedMarkdown"

interface Props {
  message: ProcessedTextMessage
  isCurrentTurn?: boolean
}

export function TextMessage({ message, isCurrentTurn = false }: Props) {
  // Trace verdicts land after the reply; this reply's violated citations (if
  // any) flow down to its [M-NN] chips so drift shows at the sentence itself.
  const violated = useViolatedCitationsMap()?.get(message.id) ?? null
  const markdown = (
    <div className="text-pretty prose prose-sm dark:prose-invert px-0.5 w-full max-w-full space-y-4">
      <CachedMarkdown memoryLinks>{linkifyMemoryCitations(message.text)}</CachedMarkdown>
    </div>
  )
  const body = isCurrentTurn
    ? <CurrentTurnMemoryCitationProvider>{markdown}</CurrentTurnMemoryCitationProvider>
    : markdown
  return violated ? (
    <MessageViolatedCitationsProvider value={violated}>{body}</MessageViolatedCitationsProvider>
  ) : (
    body
  )
}
