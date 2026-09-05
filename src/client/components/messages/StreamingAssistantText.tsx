import { memo } from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { CurrentTurnMemoryCitationProvider, markdownComponentsWithLinks } from "./shared"
import { urlTransform } from "./TextMessage"
import { useThrottledValue } from "../../hooks/useThrottledValue"
import { linkifyMemoryCitations } from "../../lib/memoryCitations"

interface Props {
  text: string
}

// The reply while it is still being written (ChatRuntime.streamingText).
// Same prose pipeline as the final TextMessage so the moment the transcript
// entry replaces this preview nothing visually shifts. Deltas can arrive
// ~50/s and every render reparses the whole accumulated markdown, so the
// text is throttled to ~10 repaints/s (trailing edge — the last delta
// always lands; the final transcript entry then swaps in exactly).
export const StreamingAssistantText = memo(function StreamingAssistantText({ text }: Props) {
  const throttledText = useThrottledValue(text, 100)
  return (
    <div className="pb-5">
      <div className="text-pretty prose prose-sm dark:prose-invert px-0.5 w-full max-w-full space-y-4">
        <CurrentTurnMemoryCitationProvider>
          <Markdown remarkPlugins={[remarkGfm]} urlTransform={urlTransform} components={markdownComponentsWithLinks}>{linkifyMemoryCitations(throttledText)}</Markdown>
        </CurrentTurnMemoryCitationProvider>
      </div>
    </div>
  )
})
