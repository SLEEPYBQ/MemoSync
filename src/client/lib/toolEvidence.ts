import type { ResolvedTranscriptRow } from "../app/ChatTranscript"
import { normalizeQuoteText } from "./quoteJump"

export const TOOL_EVIDENCE_EVENT = "memosync:reveal-tool-evidence"

export interface ToolEvidenceTarget {
  toolId: string
  chatId?: string
  quote?: string
}

export function findToolEvidenceRowIndex(rows: readonly ResolvedTranscriptRow[], toolId: string): number {
  return rows.findIndex((row) => row.kind === "tool-group"
    ? row.messages.some((message) => message.kind === "tool" && message.toolId === toolId)
    : row.kind === "single" && row.message.kind === "tool" && row.message.toolId === toolId)
}

function transcriptRoot(origin: HTMLElement | null, chatId?: string): HTMLElement | null {
  const local = origin?.closest<HTMLElement>("[data-transcript-list]")
  if (local) return local
  const roots = Array.from(document.querySelectorAll<HTMLElement>("[data-transcript-list]"))
  return roots.find((root) => !chatId || root.dataset.transcriptChatId === chatId) ?? null
}

/**
 * Reveal the containing virtual row, then the group and individual tool. The
 * anchor is a server-validated tool id, so uncited and tool-only violations
 * do not depend on an assistant paragraph being mounted or containing a chip.
 */
export async function revealToolEvidence(target: ToolEvidenceTarget, origin: HTMLElement | null): Promise<HTMLElement | null> {
  const root = transcriptRoot(origin, target.chatId)
  if (!root) return null
  window.dispatchEvent(new CustomEvent<ToolEvidenceTarget>(TOOL_EVIDENCE_EVENT, { detail: target }))
  // LegendList mounts the requested row asynchronously after scrollToIndex.
  for (let frame = 0; frame < 60; frame += 1) {
    if (!root.isConnected) return null
    for (const group of Array.from(root.querySelectorAll<HTMLElement>("[data-tool-group-ids]"))) {
      let ids: unknown
      try { ids = JSON.parse(group.dataset.toolGroupIds ?? "[]") } catch { continue }
      if (!Array.isArray(ids) || !ids.includes(target.toolId)) continue
      group.querySelector<HTMLButtonElement>('button[data-tool-group-toggle][aria-expanded="false"]')?.click()
    }
    const tool = Array.from(root.querySelectorAll<HTMLElement>("[data-tool-id]"))
      .find((element) => element.dataset.toolId === target.toolId)
    if (tool) {
      const closed = tool.querySelector<HTMLButtonElement>('button[data-expandable-toggle][aria-expanded="false"]')
      if (closed) closed.click()
      else {
        const quote = target.quote ? normalizeQuoteText(target.quote) : ""
        return (quote ? Array.from(tool.querySelectorAll<HTMLElement>("pre, p, li, blockquote"))
          .find((element) => normalizeQuoteText(element.textContent ?? "").includes(quote)) : null) ?? tool
      }
    }
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
  }
  return null
}
