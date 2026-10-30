import { formatNumber, getLocale } from "../i18n"
import type { ContextWindowUsageSnapshot, TranscriptEntry } from "../../shared/types"

export interface ContextWindowSnapshot extends ContextWindowUsageSnapshot {
  remainingTokens: number | null
  usedPercentage: number | null
  remainingPercentage: number | null
  updatedAt: string
}

function withDerivedMetrics(
  usage: ContextWindowUsageSnapshot,
  updatedAt: string,
  compactsAutomatically: boolean,
): ContextWindowSnapshot {
  const maxTokens = typeof usage.maxTokens === "number" && Number.isFinite(usage.maxTokens)
    ? usage.maxTokens
    : null
  const usedPercentage = maxTokens && maxTokens > 0
    ? Math.min(100, (usage.usedTokens / maxTokens) * 100)
    : null
  const remainingTokens = maxTokens !== null
    ? Math.max(0, Math.round(maxTokens - usage.usedTokens))
    : null
  const remainingPercentage = usedPercentage !== null
    ? Math.max(0, 100 - usedPercentage)
    : null

  return {
    ...usage,
    compactsAutomatically: usage.compactsAutomatically || compactsAutomatically,
    maxTokens: maxTokens ?? undefined,
    remainingTokens,
    usedPercentage,
    remainingPercentage,
    updatedAt,
  }
}

export function deriveLatestContextWindowSnapshot(
  entries: ReadonlyArray<TranscriptEntry>,
): ContextWindowSnapshot | null {
  const compactsAutomatically = entries.some((entry) =>
    entry.kind === "compact_boundary"
    || entry.kind === "compact_summary"
    || entry.kind === "context_cleared"
  )

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (!entry) continue

    // A boundary invalidates every usage sample before it. Until the engine
    // emits a post-compaction sample, hiding the meter is more accurate than
    // continuing to show the nearly-full pre-compaction window.
    if (
      entry.kind === "compact_boundary"
      || entry.kind === "compact_summary"
      || entry.kind === "context_cleared"
    ) {
      return null
    }

    if (entry.kind !== "context_window_updated" || entry.usage.usedTokens <= 0) {
      continue
    }

    return withDerivedMetrics(entry.usage, new Date(entry.createdAt).toISOString(), compactsAutomatically)
  }

  return null
}

export function overrideContextWindowMaxTokens(
  snapshot: ContextWindowSnapshot | null,
  maxTokens: number | null,
): ContextWindowSnapshot | null {
  if (!snapshot || maxTokens === null || !Number.isFinite(maxTokens) || maxTokens <= 0) {
    return snapshot
  }

  return withDerivedMetrics(
    {
      ...snapshot,
      maxTokens,
    },
    snapshot.updatedAt,
    snapshot.compactsAutomatically,
  )
}

export function formatContextWindowTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "0"
  if (getLocale() === "zh-CN") return formatNumber(value, { notation: "compact", maximumFractionDigits: 1 })
  if (value < 1_000) return formatNumber(Math.round(value), { useGrouping: false })
  if (value < 10_000) return `${formatNumber(value / 1_000, { maximumFractionDigits: 1 })}k`
  if (value < 1_000_000) return `${formatNumber(Math.round(value / 1_000))}k`
  return `${formatNumber(value / 1_000_000, { maximumFractionDigits: 1 })}m`
}
