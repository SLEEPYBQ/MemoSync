import type { Event } from '@opencode-ai/sdk/v2/client'

/** Own cancellation here: the SDK's SSE reader discards reader.cancel()'s
 * rejected promise on Bun 1.4, turning normal shutdown into an unhandled error. */
export async function* readOpencodeEvents(url: string, directory: string, authorization: string, signal: AbortSignal): AsyncGenerator<Event> {
  const endpoint = new URL('/event', url)
  endpoint.searchParams.set('directory', directory)
  const response = await fetch(endpoint, { headers: { Authorization: authorization }, signal })
  if (!response.ok || !response.body) throw new Error('OpenCode event stream unavailable')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      // The server emits SSE records. Normalize CRLF only after the complete
      // separator arrives, including when CR and LF cross network chunks.
      let separator: RegExpExecArray | null
      while ((separator = /\r?\n\r?\n/.exec(pending))) {
        const block = pending.slice(0, separator.index)
        pending = pending.slice(separator.index + separator[0].length)
        const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
        if (data) yield JSON.parse(data) as Event
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
