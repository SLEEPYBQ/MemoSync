import { translateUiText } from "../../i18n/uiText"
import { t, useI18n } from "../../i18n"
import { MEMORY_CARD } from "../memory/MemorySurface"
// Recovery card: parked inline at the interruption point after a per-memory
// interrupt. The user writes one turn-local correction; sending it is
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
  if (resolution.action === "content_fixed") return t("memory:memoryContentCorrectedResumedWithTheNewVersion")
  if (resolution.action === "removed_only") return t("memory:workingMemoryAdjustedResumed")
  return t("memory:correctionSentResumed")
}

export function MemoryInterruptMessage({ message }: Props) {
  useI18n()
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
      setError(err instanceof Error ? err.message : t("memory:resumeFailed"))
    } finally {
      setBusy(false)
    }
  }

  // Settled: one quiet receipt line, same idiom as the settled gates.
  if (message.resolution) {
    return (
      <div className="memory-ui memory-card @container min-w-0 rounded-xl border border-border bg-card p-3 text-sm leading-relaxed text-muted-foreground">
        <span className="flex flex-wrap items-center gap-1.5">
          <CircleSlash className="h-3 w-3" />
          <span className="shrink-0 font-semibold text-foreground">{t("memory:interruptedOver")}</span>
          <MemoryCitationChip id={message.memoryId} />
          <span className="basis-full @lg:basis-auto">
            — {resolutionReceipt(message.resolution)}
            {message.resolution.enforced ? t("memory:oneRunEnforceApplied") : ""}
          </span>
        </span>
      </div>
    )
  }

  return (
    <section className={MEMORY_CARD}>
      <div className="flex flex-wrap items-baseline gap-2">
        <CircleSlash className="h-4 w-4 self-center text-muted-foreground" />
        <span className="text-sm font-semibold text-foreground">{t("memory:youStoppedThisTurnOver")}</span>
        <MemoryCitationChip id={message.memoryId} />
      </div>
      {message.quote ? (
        <p className="mt-2 leading-relaxed text-muted-foreground">
          <CornerDownRight className="mr-1 inline h-3 w-3" />
          {t("memory:youStoppedHere")}<span className="text-foreground/80">“{message.quote}”</span>
        </p>
      ) : null}

      <label htmlFor={`memory-recovery-${message.interruptId}`} className="mt-3 block font-medium text-foreground">
        {t("memory:describeTheProblemOrCorrection")}</label>
      <p className="mt-0.5 text-muted-foreground">
        {t("memory:thisInstructionAppliesToTheResumedRunSendingContinuesFrom")}</p>
      <form
        className="relative mt-2 rounded-lg border border-border/70 bg-background"
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
          placeholder={t("memory:whatWentWrongOrWhatShouldTheAssistantDoDifferently")}
          className="block min-h-16 w-full resize-y bg-transparent px-3 py-2 pb-9 pr-11 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
        />
        <div className="absolute inset-x-2 bottom-2 flex items-center gap-2">
          <label className="inline-flex min-w-0 cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={enforce}
              onChange={(event) => setEnforce(event.target.checked)}
              className="h-3.5 w-3.5 accent-current"
            />
            <span>{t("memory:enforceForThisResumedRun")}<span className="text-muted-foreground/70">{t("memory:oneRunOnly")}</span></span>
          </label>
          <button
            type="submit"
            aria-label={t("memory:sendAndResume")}
            title={t("memory:sendAndResume")}
            disabled={busy || !correction.trim()}
            className="ml-auto inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          </button>
        </div>
      </form>

      <div className="mt-4">
        <p className="font-medium text-muted-foreground">{t("common:workingMemory")}</p>
        <p className="mt-0.5 text-muted-foreground/80">{t("memory:adjustTheContextCarriedIntoTheResumedRun")}</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {message.workingSet.map((item, index) => {
            const isFlagged = item.id === message.memoryId
            const enforceLocked = enforce && isFlagged
            const removed = removedIds.has(item.id) && !enforceLocked
            return (
              <div key={item.id} className={cn("inline-flex items-center gap-1 rounded-md px-1 py-0.5", removed && "opacity-40")}>
                <MemoryCitationChip id={item.id} />
                {item.cited ? (
                  <span className="text-[11px] text-muted-foreground/70">
                    {t("memory:cited")}{index + 1}
                  </span>
                ) : null}
                {isFlagged ? (
                  <span className="text-[11px] text-destructive">
                    {t("memory:flagged")}</span>
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
                  title={enforceLocked ? t("memory:enforcedForThisResumedRun") : removed ? t("memory:putItBackForTheResume") : t("memory:removeFromTheResumedTurn")}
                  aria-label={enforceLocked ? t("memory:memoryValue0IsEnforcedForThisResumedRun", { v0: item.id }) : removed ? t("memory:putValue0BackForTheResume", { v0: item.id }) : t("memory:removeValue0FromTheResumedTurn", { v0: item.id })}
                  className="ml-auto rounded p-0.5 text-destructive transition-colors hover:bg-muted hover:text-destructive disabled:cursor-not-allowed disabled:opacity-35"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )
          })}
        </div>
      </div>
      {error ? <p className="mt-2 text-destructive">{translateUiText(error)}</p> : null}
    </section>
  )
}
