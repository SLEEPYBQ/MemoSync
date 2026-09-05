import { hydrateToolResult } from "../../shared/tools"
import type { HydratedToolCall, HydratedTranscriptMessage, NormalizedToolCall, TranscriptEntry } from "../../shared/types"

function createTimestamp(createdAt: number): string {
  return new Date(createdAt).toISOString()
}

function createBaseMessage(entry: TranscriptEntry) {
  return {
    id: entry._id,
    messageId: entry.messageId,
    timestamp: createTimestamp(entry.createdAt),
    hidden: entry.hidden,
  }
}

function hydrateToolCall(entry: Extract<TranscriptEntry, { kind: "tool_call" }>): HydratedToolCall {
  return {
    id: entry._id,
    messageId: entry.messageId,
    hidden: entry.hidden,
    kind: "tool",
    toolKind: entry.tool.toolKind,
    toolName: entry.tool.toolName,
    toolId: entry.tool.toolId,
    input: entry.tool.input as HydratedToolCall["input"],
    timestamp: createTimestamp(entry.createdAt),
  } as HydratedToolCall
}

function getStructuredToolResultFromDebug(entry: Extract<TranscriptEntry, { kind: "tool_result" }>): unknown {
  if (!entry.debugRaw) return undefined

  try {
    const parsed = JSON.parse(entry.debugRaw) as { tool_use_result?: unknown }
    return parsed.tool_use_result
  } catch {
    return undefined
  }
}

export function processTranscriptMessages(entries: TranscriptEntry[]): HydratedTranscriptMessage[] {
  const pendingToolCalls = new Map<string, { hydrated: HydratedToolCall; normalized: NormalizedToolCall }>()
  const messages: HydratedTranscriptMessage[] = []

  // Memory-preview decisions and relevance predictions are separate
  // append-only entries; fold each into its matching memory_preview message
  // so a preview renders as one card.
  const previewDecisions = new Map<string, { decision: Extract<TranscriptEntry, { kind: "memory_preview_decision" }>["decision"]; auto?: boolean; selectedIds?: string[]; expectedUses?: Array<{ id: string; expectedUse: string }> }>()
  const previewRelevance = new Map<string, { revision: number; relevant: Array<{ id: string; why: string }>; expectedUses?: Array<{ id: string; expectedUse: string }> }>()
  const previewUpdates = new Map<string, Extract<TranscriptEntry, { kind: "memory_preview_update" }>>()
  const previewRefreshing = new Set<string>()
  const previewRefreshVersions = new Map<string, number>()
  // Step-one gates fold the same way: results and decisions ride their parent
  // container so each gate renders as one card.
  const proposalsDecisions = new Map<string, Extract<TranscriptEntry, { kind: "memory_proposals_decision" }>["decision"]>()
  const proposalsResults = new Map<string, Extract<TranscriptEntry, { kind: "memory_proposals_result" }>["candidates"]>()
  const checkupResults = new Map<string, Extract<TranscriptEntry, { kind: "memory_checkup_result" }>["suggestions"]>()
  const checkupFailedKinds = new Map<string, NonNullable<Extract<TranscriptEntry, { kind: "memory_checkup_result" }>["failedKinds"]>>()
  const checkupDecisions = new Map<string, Extract<TranscriptEntry, { kind: "memory_checkup_decision" }>["decision"]>()
  const transferDecisions = new Map<string, Extract<TranscriptEntry, { kind: "memory_transfer_decision" }>["decision"]>()
  // Streaming: result entries are cumulative (each carries everything so
  // far); the last one wins, and only a `done` result clears the scan state.
  const transferResults = new Map<string, Extract<TranscriptEntry, { kind: "memory_transfer_result" }>["suggestions"]>()
  const transferResultsDone = new Set<string>()
  const checkupResetStates = new Map<string, "waiting" | "pending">()
  // Audit skeletons: a pending memory_trace is superseded by the terminal
  // entry for the same turn — only the last entry per turn renders.
  const settledTraceTurns = new Set<number | undefined>()
  const interruptResolutions = new Map<string, { action?: "content_fixed" | "usage_correction" | "removed_only"; correction?: string; selectedIds: string[]; enforced?: boolean }>()
  for (const entry of entries) {
    if (entry.kind === "memory_preview_decision") previewDecisions.set(entry.previewId, { decision: entry.decision, auto: entry.auto, selectedIds: entry.selectedIds, expectedUses: entry.expectedUses })
    if (entry.kind === "memory_interrupt_resolution") {
      interruptResolutions.set(entry.interruptId, { action: entry.action, correction: entry.correction, selectedIds: entry.selectedIds, enforced: entry.enforced })
    }
    if (entry.kind === "memory_preview_relevance") {
      previewRelevance.set(entry.previewId, { revision: entry.revision ?? 0, relevant: entry.relevant, expectedUses: entry.expectedUses })
    }
    if (entry.kind === "memory_preview_update") {
      previewUpdates.set(entry.previewId, entry)
      previewRefreshing.delete(entry.previewId)
      previewRefreshVersions.set(entry.previewId, entry.revision)
    }
    if (entry.kind === "memory_proposals_result") proposalsResults.set(entry.proposalsId, entry.candidates)
    if (entry.kind === "memory_proposals_decision") proposalsDecisions.set(entry.proposalsId, entry.decision)
    if (entry.kind === "memory_checkup_result") {
      checkupResults.set(entry.checkupId, entry.suggestions)
      if (entry.failedKinds?.length) checkupFailedKinds.set(entry.checkupId, entry.failedKinds)
      else checkupFailedKinds.delete(entry.checkupId)
      checkupResetStates.delete(entry.checkupId)
    }
    if (entry.kind === "memory_checkup_decision") checkupDecisions.set(entry.checkupId, entry.decision)
    if (entry.kind === "memory_transfer_decision") transferDecisions.set(entry.transferId, entry.decision)
    if (entry.kind === "memory_transfer_result") {
      transferResults.set(entry.transferId, entry.suggestions)
      if (entry.done) transferResultsDone.add(entry.transferId)
    }
    if (entry.kind === "memory_preparation_reset") {
      if (entry.previewId) {
        previewRefreshing.add(entry.previewId)
        previewRelevance.delete(entry.previewId)
        previewRefreshVersions.set(entry.previewId, entry.revision)
      }
      if (entry.checkupId) {
        checkupResults.delete(entry.checkupId)
        checkupFailedKinds.delete(entry.checkupId)
        checkupDecisions.delete(entry.checkupId)
        // Step 2 waits while an EARLIER stage is being reworked; a direct
        // Step 2 reopen goes straight to the scanning skeleton.
        checkupResetStates.set(entry.checkupId, entry.from === "checkup" ? "pending" : "waiting")
      }
      if ((entry.from === "proposals" || entry.openingReviewId) && entry.proposalsId) {
        proposalsDecisions.delete(entry.proposalsId)
      }
      if ((entry.from === "transfer" || entry.openingReviewId) && entry.transferId) {
        transferDecisions.delete(entry.transferId)
      }
    }
    if (entry.kind === "memory_trace" && entry.status !== "pending") settledTraceTurns.add(entry.turn)
  }

  for (const entry of entries) {
    switch (entry.kind) {
      case "user_prompt":
        messages.push({
          ...createBaseMessage(entry),
          kind: "user_prompt",
          content: entry.content,
          attachments: entry.attachments ?? [],
          steered: entry.steered,
        })
        break
      case "system_init":
        messages.push({
          ...createBaseMessage(entry),
          kind: "system_init",
          provider: entry.provider,
          model: entry.model,
          tools: entry.tools,
          agents: entry.agents,
          slashCommands: entry.slashCommands,
          mcpServers: entry.mcpServers,
          debugRaw: entry.debugRaw,
        })
        break
      case "account_info":
        messages.push({
          ...createBaseMessage(entry),
          kind: "account_info",
          accountInfo: entry.accountInfo,
        })
        break
      case "assistant_text":
        messages.push({
          ...createBaseMessage(entry),
          kind: "assistant_text",
          text: entry.text,
        })
        break
      case "tool_call": {
        const toolCall = hydrateToolCall(entry)
        pendingToolCalls.set(entry.tool.toolId, { hydrated: toolCall, normalized: entry.tool })
        messages.push(toolCall)
        break
      }
      case "tool_result": {
        const pendingCall = pendingToolCalls.get(entry.toolId)
        if (pendingCall) {
          const rawResult = (
            pendingCall.normalized.toolKind === "ask_user_question" ||
            pendingCall.normalized.toolKind === "exit_plan_mode"
          )
            ? getStructuredToolResultFromDebug(entry) ?? entry.content
            : entry.content

          pendingCall.hydrated.result = hydrateToolResult(pendingCall.normalized, rawResult) as never
          pendingCall.hydrated.rawResult = rawResult
          pendingCall.hydrated.isError = entry.isError
        }
        break
      }
      case "result":
        messages.push({
          ...createBaseMessage(entry),
          kind: "result",
          success: !entry.isError,
          cancelled: entry.subtype === "cancelled",
          result: entry.result,
          durationMs: entry.durationMs,
          costUsd: entry.costUsd,
        })
        break
      case "status":
        messages.push({
          ...createBaseMessage(entry),
          kind: "status",
          status: entry.status,
        })
        break
      case "context_window_updated":
        messages.push({
          ...createBaseMessage(entry),
          kind: "context_window_updated",
          usage: entry.usage,
        })
        break
      case "compact_boundary":
        messages.push({
          ...createBaseMessage(entry),
          kind: "compact_boundary",
        })
        break
      case "compact_summary":
        messages.push({
          ...createBaseMessage(entry),
          kind: "compact_summary",
          summary: entry.summary,
        })
        break
      case "context_cleared":
        messages.push({
          ...createBaseMessage(entry),
          kind: "context_cleared",
        })
        break
      case "interrupted":
        messages.push({
          ...createBaseMessage(entry),
          kind: "interrupted",
        })
        break
      case "memory_candidates":
        messages.push({
          ...createBaseMessage(entry),
          kind: "memory_candidates",
          candidates: entry.candidates,
          turn: entry.turn,
        })
        break
      case "memory_trace":
        // Skip a pending skeleton whose terminal entry already landed.
        if (entry.status === "pending" && settledTraceTurns.has(entry.turn)) break
        messages.push({
          ...createBaseMessage(entry),
          kind: "memory_trace",
          labels: entry.labels,
          status: entry.status,
          errorClass: entry.errorClass,
          dropped: entry.dropped,
          summary: entry.summary,
          turn: entry.turn,
        })
        break
      case "memory_preview":
      {
        const update = previewUpdates.get(entry.previewId)
        const refreshVersion = previewRefreshVersions.get(entry.previewId) ?? 0
        const relevance = previewRelevance.get(entry.previewId)
        messages.push({
          ...createBaseMessage(entry),
          kind: "memory_preview",
          previewId: entry.previewId,
          task: entry.task,
          memories: update?.memories ?? entry.memories,
          transferredIds: entry.transferredIds,
          attention: entry.attention,
          attentions: entry.attentions,
          relevant: relevance?.revision === refreshVersion ? relevance.relevant : undefined,
          expectedUses: relevance?.revision === refreshVersion ? relevance.expectedUses : undefined,
          relevancePending: update?.relevancePending ?? entry.relevancePending,
          attentionIds: update?.attentionIds ?? entry.attentionIds,
          refreshing: previewRefreshing.has(entry.previewId),
          refreshVersion,
          turn: entry.turn,
          decision: previewDecisions.get(entry.previewId)?.decision,
          decisionAuto: previewDecisions.get(entry.previewId)?.auto,
          decisionSelectedIds: previewDecisions.get(entry.previewId)?.selectedIds,
          decisionExpectedUses: previewDecisions.get(entry.previewId)?.expectedUses,
        })
        break
      }
      case "memory_proposals":
      {
        const candidates = proposalsResults.get(entry.proposalsId) ?? entry.candidates
        messages.push({
          ...createBaseMessage(entry),
          kind: "memory_proposals",
          proposalsId: entry.proposalsId,
          openingReviewId: entry.openingReviewId,
          candidates,
          pending: entry.pending && !proposalsResults.has(entry.proposalsId),
          turn: entry.turn,
          decision: proposalsDecisions.get(entry.proposalsId),
        })
        break
      }
      case "memory_checkup":
      {
        const resetState = checkupResetStates.get(entry.checkupId)
        messages.push({
          ...createBaseMessage(entry),
          kind: "memory_checkup",
          checkupId: entry.checkupId,
          openingReviewId: entry.openingReviewId,
          turn: entry.turn,
          // Pending only until the result entry lands (skeleton state).
          // A Step-1 reset deliberately parks Step 2 in WAITING. Do not let
          // the parent's historical `pending:true` make it look as if the
          // checkup has already started.
          pending:
            resetState === "pending"
            || (resetState === undefined && entry.pending && !checkupResults.has(entry.checkupId)),
          waiting: resetState === "waiting",
          suggestions: checkupResults.get(entry.checkupId),
          failedKinds: checkupFailedKinds.get(entry.checkupId),
          decision: checkupDecisions.get(entry.checkupId),
        })
        break
      }
      case "memory_transfer":
        messages.push({
          ...createBaseMessage(entry),
          kind: "memory_transfer",
          transferId: entry.transferId,
          openingReviewId: entry.openingReviewId,
          suggestions: transferResults.get(entry.transferId) ?? entry.suggestions,
          turn: entry.turn,
          // Pending until the live search's FINAL result lands — streamed
          // partial results render as rows with the scan still running.
          pending: entry.pending && !transferResultsDone.has(entry.transferId),
          decision: transferDecisions.get(entry.transferId),
        })
        break
      case "memory_interrupt": {
        messages.push({
          ...createBaseMessage(entry),
          kind: "memory_interrupt",
          interruptId: entry.interruptId,
          memoryId: entry.memoryId,
          quote: entry.quote,
          prompt: entry.prompt,
          workingSet: entry.workingSet,
          turn: entry.turn,
          resolution: interruptResolutions.get(entry.interruptId),
        })
        break
      }
      case "memory_interrupt_resolution":
      case "memory_preview_decision":
      case "memory_preview_relevance":
      case "memory_preview_update":
      case "memory_proposals_result":
      case "memory_proposals_decision":
      case "memory_checkup_result":
      case "memory_checkup_decision":
      case "memory_transfer_result":
      case "memory_transfer_decision":
      case "memory_preparation_reset":
        // Folded into the matching parent message above — no row of its own.
        break
      default:
        messages.push({
          ...createBaseMessage(entry),
          kind: "unknown",
          json: JSON.stringify(entry, null, 2),
        })
        break
    }
  }

  return messages
}
