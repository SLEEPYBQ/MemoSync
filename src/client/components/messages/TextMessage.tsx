import Markdown, { defaultUrlTransform } from "react-markdown"
import remarkGfm from "remark-gfm"
import type { ProcessedTextMessage } from "./types"
import { CurrentTurnMemoryCitationProvider, markdownComponentsWithLinks } from "./shared"
import { MessageViolatedCitationsProvider, useViolatedCitationsMap } from "./render-context"
import { linkifyMemoryCitations, MEMORY_CITATION_SCHEME } from "../../lib/memoryCitations"

interface Props {
  message: ProcessedTextMessage
  isCurrentTurn?: boolean
}

// react-markdown's default urlTransform strips unknown URL schemes (href
// becomes "") — the private memosync-memory: scheme must survive so the `a`
// component can render the scope-colored citation chip instead of a dead link.
export function urlTransform(url: string): string {
  return url.startsWith(MEMORY_CITATION_SCHEME) ? url : defaultUrlTransform(url)
}

export function TextMessage({ message, isCurrentTurn = false }: Props) {
  // Trace verdicts land after the reply; this reply's violated citations (if
  // any) flow down to its [M-NN] chips so drift shows at the sentence itself.
  const violated = useViolatedCitationsMap()?.get(message.id) ?? null
  const markdown = (
    <div className="text-pretty prose prose-sm dark:prose-invert px-0.5 w-full max-w-full space-y-4">
      <Markdown remarkPlugins={[remarkGfm]} urlTransform={urlTransform} components={markdownComponentsWithLinks}>{linkifyMemoryCitations(message.text)}</Markdown>
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
