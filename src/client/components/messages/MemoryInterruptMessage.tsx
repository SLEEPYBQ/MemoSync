// Recovery card: parked inline at the interruption point after a per-memory
// interrupt. The participant writes one turn-local correction; sending it is
// Resume. Working Memory remains visible as lightweight context and can still
// be adjusted before the continuation starts.
import { useMemo, useState } from "react"
import { CircleSlash, CornerDownRight, Loader2, Send, X } from "lucide-react"
import type { HydratedTranscriptMessage } from "../../../shared/types"
import { isImeComposingKeyEvent } from "../../lib/imeKeys"
import { cn } from "../../lib/utils"
import { MemoryCitationChip, useEnsureMemoriesLoaded, useTurnInterrupt } from "./shared"

type MemoryInterruptHydratedMessage = Extract<HydratedTranscriptMessage, { kind: "memory_interrupt" }>

interface Props {
  message: MemoryInterruptHydratedMessage
}

function resolutionReceipt(resolution: NonNullable<MemoryInterruptHydratedMessage["resolution"]>): string {
  if (resolution.action === "content_fixed") return "memory content corrected; resumed with the new version"
  if (resolution.action === "removed_only") return "working memory adjusted; resumed"
  return "correction sent; resumed"
}

export function MemoryInterruptMessage({ message }: Props) {
  useEnsureMemoriesLoaded()
  const interruptApi = useTurnInterrupt()

  const [correction, setCorrection] = useState("")
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set())
  const [enforce, setEnforce] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedIds = useMemo(() => {
    const selected = message.workingSet.map((w) => w.id).filter((id) => !removedIds.has(id))
    if (enforce && !selected.includes(message.memoryId)) {
      selected.push(message.memoryId)
    }
    return selected
  }, [enforce, message.memoryId, message.workingSet, removedIds])

  async function resume() {
    const trimmed = correction.trim()
    if (!interruptApi || !trimmed) return
    setBusy(true)
    setError(null)
    try {
      await interruptApi.resume({
        interruptId: message.interruptId,
        correction: trimmed,
        selectedIds,
        enforce: enforce ? true : undefined,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : "resume failed")
    } finally {
      setBusy(false)
    }
  }

  // Settled: one quiet receipt line, same idiom as the settled gates.
  if (message.resolution) {
    return (
      <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <CircleSlash className="h-3 w-3" />
          <span className="font-medium text-foreground">Interrupted over</span>
          <MemoryCitationChip id={message.memoryId} />
          <span>
            — {resolutionReceipt(message.resolution)}
            {message.resolution.enforced ? "; one-run enforce applied" : ""}
          </span>
        </span>
      </div>
    )
  }

  return (
    <section className="rounded-xl border border-border/70 bg-card p-4 text-xs">
      <div className="flex flex-wrap items-baseline gap-2">
        <CircleSlash className="h-3.5 w-3.5 self-center text-destructive" />
        <span className="text-sm font-medium text-foreground">You stopped this turn over</span>
        <MemoryCitationChip id={message.memoryId} />
      </div>
      {message.quote ? (
        <p className="mt-2 leading-relaxed text-muted-foreground">
          <CornerDownRight className="mr-1 inline h-3 w-3" />
          You stopped here: <span className="text-foreground/80">“{message.quote}”</span>
        </p>
      ) : null}

      <label htmlFor={`memory-recovery-${message.interruptId}`} className="mt-3 block font-medium text-foreground">
        Describe the problem or correction
      </label>
      <p className="mt-0.5 text-muted-foreground">
        This instruction applies to the resumed run. Sending continues from where the assistant stopped.
      </p>
      <form
        className="relative mt-2 rounded-xl border border-border/70 bg-background"
        onSubmit={(event) => {
          event.preventDefault()
          void resume()
        }}
      >
        <textarea
          id={`memory-recovery-${message.interruptId}`}
          value={correction}
          onChange={(event) => setCorrection(event.target.value)}
          onKeyDown={(event) => {
            if (isImeComposingKeyEvent(event.nativeEvent)) return
            if (event.key !== "Enter" || event.shiftKey) return
            event.preventDefault()
            if (correction.trim() && !busy) void resume()
          }}
          rows={2}
          placeholder="What went wrong, or what should the assistant do differently?"
          className="block min-h-16 w-full resize-y bg-transparent px-3 py-2 pb-9 pr-11 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
        />
        <div className="absolute inset-x-2 bottom-2 flex items-center gap-2">
          <label className="inline-flex min-w-0 cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={enforce}
              onChange={(event) => setEnforce(event.target.checked)}
              className="h-3.5 w-3.5 accent-current"
            />
            <span>Enforce for this resumed run <span className="text-muted-foreground/70">· one run only</span></span>
          </label>
          <button
            type="submit"
            aria-label="Send and resume"
            title="Send and resume"
            disabled={busy || !correction.trim()}
            className="ml-auto inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-600 text-white transition-colors hover:bg-slate-700 disabled:opacity-50 dark:bg-white dark:text-slate-900 dark:hover:bg-white/90"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          </button>
        </div>
      </form>

      <div className="mt-4">
        <p className="font-medium text-muted-foreground">Working Memory</p>
        <p className="mt-0.5 text-muted-foreground/80">Adjust the context carried into the resumed run.</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {message.workingSet.map((item, index) => {
            const isFlagged = item.id === message.memoryId
            const enforceLocked = enforce && isFlagged
            const removed = removedIds.has(item.id) && !enforceLocked
            return (
              <div key={item.id} className={cn("inline-flex items-center gap-1 rounded-md px-1 py-0.5", removed && "opacity-40")}>
                <MemoryCitationChip id={item.id} />
                {item.cited ? (
                  <span className="text-[10px] text-muted-foreground/70">
                    cited #{index + 1}
                  </span>
                ) : null}
                {isFlagged ? (
                  <span className="text-[10px] text-destructive">
                    flagged
                  </span>
                ) : null}
                <button
                  type="button"
                  disabled={enforceLocked}
                  onClick={() =>
                    setRemovedIds((prev) => {
                      if (enforceLocked) return prev
                      const next = new Set(prev)
                      if (next.has(item.id)) next.delete(item.id)
                      else next.add(item.id)
                      return next
                    })
                  }
                  title={enforceLocked ? "Enforced for this resumed run" : removed ? "Put it back for the resume" : "Remove from the resumed turn"}
                  aria-label={enforceLocked ? `Memory ${item.id} is enforced for this resumed run` : removed ? `Put ${item.id} back for the resume` : `Remove ${item.id} from the resumed turn`}
                  className="ml-auto rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )
          })}
        </div>
      </div>
      {error ? <p className="mt-2 text-destructive">{error}</p> : null}
    </section>
  )
}
