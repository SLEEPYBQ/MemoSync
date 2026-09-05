// Shared fork-query runner: fork a just-finished Claude session (forkSession)
// and ask ONE out-of-band question on top of the trajectory the server
// already paid for. Measured in-container: a forked resume's API leg runs
// ~40% faster than a cold prompt of the same length — DeepSeek's server-side
// prefix cache hits under the anthropic-compat surface even though the
// anthropic-shaped usage fields read 0. The fork sees the FULL trajectory
// (tool calls included) and nothing it does enters the main session.
//
// Every consumer (trace audit, capture extraction, checkup prewarm) follows
// the same contract: null on ANY failure, so callers fall back to their
// sidecar path; this helper must never take the turn loop down.
import { query } from "@anthropic-ai/claude-agent-sdk"

export interface ForkQueryInput {
  /** The just-finished Claude session's resume token. */
  sessionToken: string
  /** The project workspace the session ran in (resume needs the same cwd). */
  localPath: string
  /** The out-of-band question; must demand strict JSON. */
  prompt: string
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 90_000

/** Strip an optional ```json fence some models wrap around JSON output. */
function unfence(text: string): string {
  const m = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(text.trim())
  return m ? m[1] : text
}

export async function runForkQuery(input: ForkQueryInput): Promise<Record<string, unknown> | null> {
  if (!input.sessionToken || !input.prompt.trim()) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    let text = ""
    const q = query({
      prompt: input.prompt,
      options: {
        cwd: input.localPath,
        resume: input.sessionToken,
        forkSession: true,
        maxTurns: 1,
        allowedTools: [],
        abortController: controller,
        env: (() => {
          const { CLAUDECODE: _c, ...env } = process.env
          return env
        })(),
      },
    })
    for await (const m of q) {
      const mm = m as { type?: string; subtype?: string; result?: string }
      if (mm.type === "result") {
        if (mm.subtype === "success" && typeof mm.result === "string") text = mm.result
        break
      }
    }
    if (!text.trim()) return null
    const parsed = JSON.parse(unfence(text)) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
