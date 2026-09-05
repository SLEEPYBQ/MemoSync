import React, { memo, useMemo, useRef } from "react"
import type { AskUserQuestionItem, ProcessedToolCall } from "../components/messages/types"
import type { AskUserQuestionAnswerMap, ChatAttachment, ExpectedMemoryUse, HydratedTranscriptMessage, MemoryPreviewDecision } from "../../shared/types"
import { UserMessage } from "../components/messages/UserMessage"
import { RawJsonMessage } from "../components/messages/RawJsonMessage"
import { SystemMessage } from "../components/messages/SystemMessage"
import { AccountInfoMessage } from "../components/messages/AccountInfoMessage"
import { TextMessage } from "../components/messages/TextMessage"
import { AskUserQuestionMessage } from "../components/messages/AskUserQuestionMessage"
import { ExitPlanModeMessage } from "../components/messages/ExitPlanModeMessage"
import { TodoWriteMessage } from "../components/messages/TodoWriteMessage"
import { ToolCallMessage } from "../components/messages/ToolCallMessage"
import { ResultMessage } from "../components/messages/ResultMessage"
import { InterruptedMessage } from "../components/messages/InterruptedMessage"
import { CompactBoundaryMessage, ContextClearedMessage } from "../components/messages/CompactBoundaryMessage"
import { CompactSummaryMessage } from "../components/messages/CompactSummaryMessage"
import { StatusMessage } from "../components/messages/StatusMessage"
import { CollapsedToolGroup } from "../components/messages/CollapsedToolGroup"
import { MemoryCandidatesMessage } from "../components/messages/MemoryCandidatesMessage"
import { MemoryTraceMessage } from "../components/messages/MemoryTraceMessage"
import { MemoryInterruptMessage } from "../components/messages/MemoryInterruptMessage"
import {
  MemoryChangesReviewFlow,
  type MemoryChangesReviewMessage,
} from "../components/messages/MemoryChangesReviewFlow"
import { MemoryPreviewMessage } from "../components/messages/MemoryPreviewMessage"
import { CHAT_SELECTION_ZONE_ATTRIBUTE } from "./chatFocusPolicy"

const SPECIAL_TOOL_NAMES = new Set(["AskUserQuestion", "ExitPlanMode", "TodoWrite"])

export type TranscriptRenderItem =
  | { type: "single"; message: HydratedTranscriptMessage; index: number }
  | { type: "tool-group"; messages: HydratedTranscriptMessage[]; startIndex: number }
  | { type: "memory-changes-review"; messages: MemoryChangesReviewMessage[]; startIndex: number }

export interface ResolvedSingleTranscriptRow {
  kind: "single"
  id: string
  message: HydratedTranscriptMessage
  index: number
  isLoading: boolean
  localPath?: string
  isFirstSystem: boolean
  isFirstAccount: boolean
  isLatestAskUserQuestion: boolean
  isLatestExitPlanMode: boolean
  isLatestTodoWrite: boolean
  hideResult: boolean
  isFinalStatus: boolean
  /** Undecided memory_preview that newer turn entries have passed by (orphan). */
  isStaleMemoryPreview: boolean
}

/** Persisted assistant chunks can replace the streaming footer before a turn
 * ends. Keep every chunk after the latest prompt live until a terminal result
 * arrives, so its memory citations do not lose the Stop control. */
export function getCurrentTurnAssistantMessageIds(
  messages: HydratedTranscriptMessage[],
  canCancel: boolean,
): Set<string> {
  if (!canCancel) return new Set()

  let promptIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.kind === "user_prompt") {
      promptIndex = index
      break
    }
  }
  if (promptIndex < 0) return new Set()

  const suffix = messages.slice(promptIndex + 1)
  if (suffix.some((message) => message.kind === "result" || message.kind === "interrupted")) {
    return new Set()
  }

  return new Set(
    suffix
      .filter((message) => message.kind === "assistant_text")
      .map((message) => message.id),
  )
}

export interface ResolvedToolGroupTranscriptRow {
  kind: "tool-group"
  id: string
  startIndex: number
  messages: HydratedTranscriptMessage[]
  isLoading: boolean
  localPath?: string
}

export interface ResolvedMemoryChangesReviewTranscriptRow {
  kind: "memory-changes-review"
  id: string
  startIndex: number
  messages: MemoryChangesReviewMessage[]
  isStale: boolean
  canReopenProposals: boolean
  canReopenTransfer: boolean
  canReopenCheckup: boolean
}

export type ResolvedTranscriptRow =
  | ResolvedSingleTranscriptRow
  | ResolvedToolGroupTranscriptRow
  | ResolvedMemoryChangesReviewTranscriptRow

export interface StableResolvedTranscriptRowsState {
  byId: Map<string, ResolvedTranscriptRow>
  result: ResolvedTranscriptRow[]
}

interface TranscriptMessageRenderState {
  isFirstSystem: boolean
  isFirstAccount: boolean
  isLatestTodoWrite: boolean
  hideResult: boolean
  isFinalStatus: boolean
  shouldRender: boolean
}

function isCollapsibleToolCall(message: HydratedTranscriptMessage) {
  if (message.kind !== "tool") return false
  const toolName = (message as ProcessedToolCall).toolName
  return !SPECIAL_TOOL_NAMES.has(toolName)
}

function isMemoryChangesReviewMessage(message: HydratedTranscriptMessage): message is MemoryChangesReviewMessage {
  return message.kind === "memory_proposals" || message.kind === "memory_transfer" || message.kind === "memory_checkup"
}

function getTranscriptMessageRenderState(
  message: HydratedTranscriptMessage,
  {
    isFirstSystem,
    isFirstAccount,
    isLatestTodoWrite,
    hideResult,
    isFinalStatus,
  }: Omit<TranscriptMessageRenderState, "shouldRender">
): TranscriptMessageRenderState {
  let shouldRender = !message.hidden

  if (shouldRender) {
    switch (message.kind) {
      case "system_init":
        shouldRender = isFirstSystem
        break
      case "account_info":
        shouldRender = isFirstAccount
        break
      case "tool":
        shouldRender = message.toolKind !== "todo_write" || isLatestTodoWrite
        break
      case "result":
        shouldRender = !hideResult && (!message.success || message.durationMs > 60000)
        break
      case "context_window_updated":
        shouldRender = false
        break
      case "status":
        // "requesting" is SDK plumbing the user should never see (user
        // decision 2026-08-11): the footer's "Running…" is the one live
        // indicator. Other statuses (e.g. compacting) may still surface
        // while they are the trailing visible entry.
        shouldRender = isFinalStatus && message.status !== "requesting"
        break
      case "memory_candidates":
      case "memory_trace":
      case "memory_preview":
      case "memory_proposals":
      case "memory_transfer":
      case "memory_checkup":
        // Memory UI (step-one gates / candidate review / trace annotation /
        // pre-turn preview): visible by default, same as any other message.
        shouldRender = true
        break
      default:
        shouldRender = true
        break
    }
  }

  return {
    isFirstSystem,
    isFirstAccount,
    isLatestTodoWrite,
    hideResult,
    isFinalStatus,
    shouldRender,
  }
}

/**
 * The latest SDK status ("requesting"/"compacting") still describing the
 * present — i.e. the last VISIBLE transcript entry is a status row. Returns
 * undefined once anything the user can see landed after it.
 */
export function getTrailingSdkStatus(messages: HydratedTranscriptMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index]
    if (!entry || entry.hidden || entry.kind === "context_window_updated") continue
    return entry.kind === "status" ? entry.status : undefined
  }
  return undefined
}

function buildTranscriptMessageRenderStates(
  messages: HydratedTranscriptMessage[],
  latestToolIds: Record<string, string | null>,
  options?: { suppressTrailingStatus?: boolean }
) {
  const firstSystemIndex = messages.findIndex((entry) => entry.kind === "system_init")
  const firstAccountIndex = messages.findIndex((entry) => entry.kind === "account_info")
  // The live status row ("Requesting...") stays up until something the user
  // can actually SEE lands after it — invisible entries (hidden interrupted
  // markers, context_window_updated ticks) used to dethrone it mid-turn,
  // leaving dead air until the reply arrived. When the footer already shows
  // a live indicator, the row is suppressed entirely instead (the footer
  // carries the SDK status label — one signal, not two spinners).
  let lastVisibleIndex = -1
  if (!options?.suppressTrailingStatus) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const entry = messages[index]
      if (!entry || entry.hidden || entry.kind === "context_window_updated") continue
      lastVisibleIndex = index
      break
    }
  }

  return messages.map<TranscriptMessageRenderState>((message, index) => {
    const previousMessage = messages[index - 1]
    const nextMessage = messages[index + 1]
    return getTranscriptMessageRenderState(message, {
      isFirstSystem: firstSystemIndex === index,
      isFirstAccount: firstAccountIndex === index,
      isLatestTodoWrite: message.id === latestToolIds.TodoWrite,
      hideResult: nextMessage?.kind === "context_cleared" || previousMessage?.kind === "context_cleared",
      isFinalStatus: index === lastVisibleIndex,
    })
  })
}

export function buildTranscriptRenderItems(
  messages: HydratedTranscriptMessage[],
  renderStates: TranscriptMessageRenderState[]
): TranscriptRenderItem[] {
  const result: TranscriptRenderItem[] = []
  let index = 0

  while (index < messages.length) {
    const message = messages[index]
    const renderState = renderStates[index]
    if (renderState?.shouldRender && isMemoryChangesReviewMessage(message)) {
      const group: MemoryChangesReviewMessage[] = [message]
      const startIndex = index
      const turn = message.turn
      index += 1

      while (index < messages.length) {
        const nextMessage = messages[index]
        const nextRenderState = renderStates[index]
        if (!nextRenderState?.shouldRender) {
          index += 1
          continue
        }
        if (!isMemoryChangesReviewMessage(nextMessage) || nextMessage.turn !== turn) break
        group.push(nextMessage)
        index += 1
      }

      result.push({ type: "memory-changes-review", messages: group, startIndex })
      continue
    }
    if (renderState?.shouldRender && isCollapsibleToolCall(message)) {
      const group: HydratedTranscriptMessage[] = [message]
      const startIndex = index
      index += 1

      while (index < messages.length) {
        const nextMessage = messages[index]
        const nextRenderState = renderStates[index]
        if (!nextRenderState?.shouldRender) {
          index += 1
          continue
        }
        if (!isCollapsibleToolCall(nextMessage)) break
        group.push(nextMessage)
        index += 1
      }

      if (group.length >= 2) {
        result.push({ type: "tool-group", messages: group, startIndex })
      } else {
        result.push({ type: "single", message, index: startIndex })
      }
      continue
    }

    result.push({ type: "single", message, index })
    index += 1
  }

  return result
}

function getTranscriptRenderItemId(item: TranscriptRenderItem) {
  if (item.type === "single") {
    return item.message.id
  }

  const firstId = item.messages[0]?.id ?? item.startIndex
  return item.type === "tool-group" ? `tool-group:${firstId}` : `memory-changes-review:${firstId}`
}

function sameStringArray(left: string[] | undefined, right: string[] | undefined) {
  if (left === right) return true
  if (!left || !right) return false
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

function sameAttachment(left: ChatAttachment, right: ChatAttachment) {
  return left.id === right.id
    && left.kind === right.kind
    && left.displayName === right.displayName
    && left.absolutePath === right.absolutePath
    && left.relativePath === right.relativePath
    && left.contentUrl === right.contentUrl
    && left.mimeType === right.mimeType
    && left.size === right.size
}

function sameAttachmentArray(left: ChatAttachment[] | undefined, right: ChatAttachment[] | undefined) {
  if (left === right) return true
  if (!left || !right) return false
  if (left.length !== right.length) return false
  return left.every((attachment, index) => sameAttachment(attachment, right[index]!))
}

function sameMessage(left: HydratedTranscriptMessage, right: HydratedTranscriptMessage) {
  if (left === right) return true
  if (left.kind !== right.kind || left.id !== right.id || left.hidden !== right.hidden) return false

  switch (left.kind) {
    case "user_prompt":
      return left.content === (right.kind === "user_prompt" ? right.content : null)
        && right.kind === "user_prompt"
        && left.steered === right.steered
        && sameAttachmentArray(left.attachments, right.attachments)
    case "system_init":
      return right.kind === "system_init"
        && left.provider === right.provider
        && left.model === right.model
        && sameStringArray(left.tools, right.tools)
        && sameStringArray(left.agents, right.agents)
        && sameStringArray(left.slashCommands, right.slashCommands)
        && left.debugRaw === right.debugRaw
    case "account_info":
      return right.kind === "account_info" && JSON.stringify(left.accountInfo) === JSON.stringify(right.accountInfo)
    case "assistant_text":
      return right.kind === "assistant_text" && left.text === right.text
    case "tool":
      return right.kind === "tool"
        && left.toolKind === right.toolKind
        && left.toolName === right.toolName
        && left.toolId === right.toolId
        && left.isError === right.isError
        && JSON.stringify(left.input) === JSON.stringify(right.input)
        && JSON.stringify(left.result) === JSON.stringify(right.result)
        && JSON.stringify(left.rawResult) === JSON.stringify(right.rawResult)
    case "result":
      return right.kind === "result"
        && left.success === right.success
        && left.cancelled === right.cancelled
        && left.result === right.result
        && left.durationMs === right.durationMs
        && left.costUsd === right.costUsd
    case "status":
      return right.kind === "status" && left.status === right.status
    case "compact_summary":
      return right.kind === "compact_summary" && left.summary === right.summary
    case "context_window_updated":
      return right.kind === "context_window_updated" && JSON.stringify(left.usage) === JSON.stringify(right.usage)
    case "compact_boundary":
    case "context_cleared":
    case "interrupted":
      return true
    case "memory_candidates":
      return right.kind === "memory_candidates"
        && left.turn === right.turn
        && JSON.stringify(left.candidates) === JSON.stringify(right.candidates)
    case "memory_trace":
      return right.kind === "memory_trace"
        && left.turn === right.turn
        && JSON.stringify(left.labels) === JSON.stringify(right.labels)
    case "memory_interrupt":
      return right.kind === "memory_interrupt"
        && left.interruptId === right.interruptId
        && JSON.stringify(left.resolution) === JSON.stringify(right.resolution)
    case "memory_preview":
      // The relevance prediction FOLDS INTO this message seconds after it
      // first renders — ignoring it froze the card on its pre-prediction
      // state (the "highlights only after Go on" bug).
      return right.kind === "memory_preview"
        && left.previewId === right.previewId
        && left.decision === right.decision
        && left.decisionAuto === right.decisionAuto
        && left.relevancePending === right.relevancePending
        && left.refreshing === right.refreshing
        && left.refreshVersion === right.refreshVersion
        && left.task === right.task
        && JSON.stringify(left.memories) === JSON.stringify(right.memories)
        && JSON.stringify(left.decisionSelectedIds) === JSON.stringify(right.decisionSelectedIds)
        && JSON.stringify(left.decisionExpectedUses) === JSON.stringify(right.decisionExpectedUses)
        && JSON.stringify(left.relevant) === JSON.stringify(right.relevant)
        && JSON.stringify(left.expectedUses) === JSON.stringify(right.expectedUses)
        && JSON.stringify(left.attention) === JSON.stringify(right.attention)
        && JSON.stringify(left.attentions) === JSON.stringify(right.attentions)
        && JSON.stringify(left.attentionIds) === JSON.stringify(right.attentionIds)
    case "memory_proposals":
      // The decision folds in when the gate settles — the card must re-render.
      return right.kind === "memory_proposals"
        && left.proposalsId === right.proposalsId
        && left.openingReviewId === right.openingReviewId
        && left.pending === right.pending
        && left.decision === right.decision
        && JSON.stringify(left.candidates) === JSON.stringify(right.candidates)
    case "memory_checkup":
      // Result and decision both fold in after first render (skeleton →
      // suggestions → settled) — each fold must break memoization.
      return right.kind === "memory_checkup"
        && left.checkupId === right.checkupId
        && left.openingReviewId === right.openingReviewId
        && left.pending === right.pending
        && left.waiting === right.waiting
        && left.decision === right.decision
        && JSON.stringify(left.suggestions) === JSON.stringify(right.suggestions)
    case "memory_transfer":
      // Result and decision fold in after first render (live-search skeleton
      // → suggestions → settled) — each fold must break memoization.
      return right.kind === "memory_transfer"
        && left.transferId === right.transferId
        && left.openingReviewId === right.openingReviewId
        && left.pending === right.pending
        && left.decision === right.decision
        && JSON.stringify(left.suggestions) === JSON.stringify(right.suggestions)
    case "unknown":
      return right.kind === "unknown" && left.json === right.json
  }
}

function isResolvedTranscriptRowUnchanged(left: ResolvedTranscriptRow, right: ResolvedTranscriptRow) {
  if (left.kind !== right.kind || left.id !== right.id) return false

  if (left.kind === "single" && right.kind === "single") {
    return left.index === right.index
      && left.isLoading === right.isLoading
      && left.localPath === right.localPath
      && left.isFirstSystem === right.isFirstSystem
      && left.isFirstAccount === right.isFirstAccount
      && left.isLatestAskUserQuestion === right.isLatestAskUserQuestion
      && left.isLatestExitPlanMode === right.isLatestExitPlanMode
      && left.isLatestTodoWrite === right.isLatestTodoWrite
      && left.hideResult === right.hideResult
      && left.isFinalStatus === right.isFinalStatus
      && left.isStaleMemoryPreview === right.isStaleMemoryPreview
      && sameMessage(left.message, right.message)
  }

  if (left.kind === "tool-group" && right.kind === "tool-group") {
    return left.startIndex === right.startIndex
      && left.isLoading === right.isLoading
      && left.localPath === right.localPath
      && left.messages.length === right.messages.length
      && left.messages.every((message, index) => sameMessage(message, right.messages[index]!))
  }

  if (left.kind === "memory-changes-review" && right.kind === "memory-changes-review") {
    return left.startIndex === right.startIndex
      && left.isStale === right.isStale
      && left.canReopenProposals === right.canReopenProposals
      && left.canReopenTransfer === right.canReopenTransfer
      && left.canReopenCheckup === right.canReopenCheckup
      && left.messages.length === right.messages.length
      && left.messages.every((message, index) => sameMessage(message, right.messages[index]!))
  }

  return false
}

export function computeStableResolvedTranscriptRows(
  rows: ResolvedTranscriptRow[],
  previous: StableResolvedTranscriptRowsState,
): StableResolvedTranscriptRowsState {
  const nextById = new Map<string, ResolvedTranscriptRow>()
  let anyChanged = rows.length !== previous.byId.size

  const result = rows.map((row, index) => {
    const previousRow = previous.byId.get(row.id)
    const nextRow = previousRow && isResolvedTranscriptRowUnchanged(previousRow, row) ? previousRow : row
    nextById.set(row.id, nextRow)
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true
    }
    return nextRow
  })

  return anyChanged ? { byId: nextById, result } : previous
}

export function useStableResolvedRows(rows: ResolvedTranscriptRow[]) {
  const previousState = useRef<StableResolvedTranscriptRowsState>({
    byId: new Map<string, ResolvedTranscriptRow>(),
    result: [],
  })

  return useMemo(() => {
    const nextState = computeStableResolvedTranscriptRows(rows, previousState.current)
    previousState.current = nextState
    return nextState.result
  }, [rows])
}

interface TranscriptSingleRowProps {
  message: HydratedTranscriptMessage
  index: number
  isLoading: boolean
  localPath?: string
  isFirstSystem: boolean
  isFirstAccount: boolean
  isLatestAskUserQuestion: boolean
  isLatestExitPlanMode: boolean
  isLatestTodoWrite: boolean
  hideResult: boolean
  isFinalStatus: boolean
  isStaleMemoryPreview?: boolean
  isCurrentTurnAssistant?: boolean
  onAskUserQuestionSubmit: (
    toolUseId: string,
    questions: AskUserQuestionItem[],
    answers: AskUserQuestionAnswerMap
  ) => void
  onExitPlanModeConfirm: (toolUseId: string, confirmed: boolean, clearContext?: boolean, message?: string) => void
  onMemoryPreviewRespond?: (previewId: string, decision: MemoryPreviewDecision, memoryIds?: string[], expectedUses?: ExpectedMemoryUse[]) => void
  onMemoryProposalsRespond?: (proposalsId: string, decision: "reviewed" | "skipped") => Promise<void> | void
  onMemoryCheckupRespond?: (checkupId: string, decision: "handled" | "skipped") => Promise<void> | void
  onMemoryTransferRespond?: (transferId: string, decision: "handled" | "skipped") => Promise<void> | void
  onMemoryPreparationReopen?: (from: "proposals" | "checkup" | "transfer", stageId: string) => Promise<void> | void
}

const TranscriptSingleRow = memo(function TranscriptSingleRow({
  message,
  index,
  isLoading,
  localPath,
  isFirstSystem,
  isFirstAccount,
  isLatestAskUserQuestion,
  isLatestExitPlanMode,
  isLatestTodoWrite,
  hideResult,
  isFinalStatus,
  isStaleMemoryPreview,
  isCurrentTurnAssistant,
  onAskUserQuestionSubmit,
  onExitPlanModeConfirm,
  onMemoryPreviewRespond,
  onMemoryProposalsRespond,
  onMemoryCheckupRespond,
  onMemoryTransferRespond,
  onMemoryPreparationReopen,
}: TranscriptSingleRowProps) {
  let rendered: React.ReactNode = null

  if (message.kind === "user_prompt") {
    rendered = <UserMessage key={message.id} content={message.content} attachments={message.attachments} steered={message.steered} />
  } else {
    switch (message.kind) {
      case "unknown":
        rendered = <RawJsonMessage key={message.id} json={message.json} />
        break
      case "system_init":
        rendered = isFirstSystem ? <SystemMessage key={message.id} message={message} rawJson={message.debugRaw} /> : null
        break
      case "account_info":
        rendered = isFirstAccount ? <AccountInfoMessage key={message.id} message={message} /> : null
        break
      case "assistant_text":
        rendered = <TextMessage key={message.id} message={message} isCurrentTurn={isCurrentTurnAssistant} />
        break
      case "tool":
        if (message.toolKind === "ask_user_question") {
          rendered = (
            <AskUserQuestionMessage
              key={message.id}
              message={message}
              onSubmit={onAskUserQuestionSubmit}
              isLatest={isLatestAskUserQuestion}
            />
          )
          break
        }
        if (message.toolKind === "exit_plan_mode") {
          rendered = (
            <ExitPlanModeMessage
              key={message.id}
              message={message}
              onConfirm={onExitPlanModeConfirm}
              isLatest={isLatestExitPlanMode}
            />
          )
          break
        }
        if (message.toolKind === "todo_write") {
          rendered = isLatestTodoWrite ? <TodoWriteMessage key={message.id} message={message} /> : null
          break
        }
        rendered = <ToolCallMessage key={message.id} message={message} isLoading={isLoading} localPath={localPath} />
        break
      case "result":
        rendered = hideResult ? null : <ResultMessage key={message.id} message={message} />
        break
      case "context_window_updated":
        rendered = null
        break
      case "interrupted":
        rendered = <InterruptedMessage key={message.id} message={message} />
        break
      case "compact_boundary":
        rendered = <CompactBoundaryMessage key={message.id} />
        break
      case "context_cleared":
        rendered = <ContextClearedMessage key={message.id} />
        break
      case "compact_summary":
        rendered = <CompactSummaryMessage key={message.id} message={message} />
        break
      case "status":
        rendered = isFinalStatus ? <StatusMessage key={message.id} message={message} /> : null
        break
      case "memory_candidates":
        rendered = <MemoryCandidatesMessage key={message.id} message={message} />
        break
      case "memory_trace":
        rendered = <MemoryTraceMessage key={message.id} message={message} />
        break
      case "memory_interrupt":
        rendered = <MemoryInterruptMessage key={message.id} message={message} />
        break
      case "memory_preview":
        rendered = (
          <MemoryPreviewMessage
            key={message.id}
            message={message}
            stale={isStaleMemoryPreview || !onMemoryPreviewRespond}
            onRespond={onMemoryPreviewRespond ?? (() => {})}
          />
        )
        break
      case "memory_proposals":
      case "memory_transfer":
      case "memory_checkup":
        rendered = (
          <MemoryChangesReviewFlow
            key={message.id}
            messages={[message]}
            stale={isStaleMemoryPreview}
            onMemoryProposalsRespond={onMemoryProposalsRespond}
            onMemoryCheckupRespond={onMemoryCheckupRespond}
            onMemoryTransferRespond={onMemoryTransferRespond}
            onMemoryPreparationReopen={onMemoryPreparationReopen}
          />
        )
        break
    }
  }

  if (!rendered) return null
  return (
    <div
      id={`msg-${message.id}`}
      className="group relative"
      data-index={index}
      {...{ [CHAT_SELECTION_ZONE_ATTRIBUTE]: "" }}
    >
      {rendered}
    </div>
  )
}, (prev, next) => (
  prev.index === next.index
  && prev.isLoading === next.isLoading
  && prev.localPath === next.localPath
  && prev.isFirstSystem === next.isFirstSystem
  && prev.isFirstAccount === next.isFirstAccount
  && prev.isLatestAskUserQuestion === next.isLatestAskUserQuestion
  && prev.isLatestExitPlanMode === next.isLatestExitPlanMode
  && prev.isLatestTodoWrite === next.isLatestTodoWrite
  && prev.hideResult === next.hideResult
  && prev.isFinalStatus === next.isFinalStatus
  && prev.isStaleMemoryPreview === next.isStaleMemoryPreview
  && prev.isCurrentTurnAssistant === next.isCurrentTurnAssistant
  && prev.onAskUserQuestionSubmit === next.onAskUserQuestionSubmit
  && prev.onExitPlanModeConfirm === next.onExitPlanModeConfirm
  && prev.onMemoryPreviewRespond === next.onMemoryPreviewRespond
  && prev.onMemoryProposalsRespond === next.onMemoryProposalsRespond
  && prev.onMemoryCheckupRespond === next.onMemoryCheckupRespond
  && prev.onMemoryTransferRespond === next.onMemoryTransferRespond
  && prev.onMemoryPreparationReopen === next.onMemoryPreparationReopen
  && sameMessage(prev.message, next.message)
))

interface TranscriptToolGroupProps {
  id: string
  startIndex: number
  messages: HydratedTranscriptMessage[]
  isLoading: boolean
  localPath?: string
  expanded: boolean
  onExpandedChange: (groupId: string, next: boolean) => void
}

const TranscriptToolGroup = memo(function TranscriptToolGroup({
  id,
  startIndex,
  messages,
  isLoading,
  localPath,
  expanded,
  onExpandedChange,
}: TranscriptToolGroupProps) {
  return (
    <div
      className="group relative"
      {...{ [CHAT_SELECTION_ZONE_ATTRIBUTE]: "" }}
    >
      <CollapsedToolGroup
        messages={messages}
        isLoading={isLoading}
        localPath={localPath}
        expanded={expanded}
        onExpandedChange={(next) => onExpandedChange(id, next)}
      />
    </div>
  )
}, (prev, next) => (
  prev.id === next.id
  && prev.startIndex === next.startIndex
  && prev.isLoading === next.isLoading
  && prev.localPath === next.localPath
  && prev.expanded === next.expanded
  && prev.onExpandedChange === next.onExpandedChange
  && prev.messages.length === next.messages.length
  && prev.messages.every((message, index) => sameMessage(message, next.messages[index]!))
))

interface TranscriptMemoryChangesReviewProps {
  row: ResolvedMemoryChangesReviewTranscriptRow
  onMemoryProposalsRespond?: ChatTranscriptRowProps["onMemoryProposalsRespond"]
  onMemoryCheckupRespond?: ChatTranscriptRowProps["onMemoryCheckupRespond"]
  onMemoryTransferRespond?: ChatTranscriptRowProps["onMemoryTransferRespond"]
  onMemoryPreparationReopen?: ChatTranscriptRowProps["onMemoryPreparationReopen"]
}

const TranscriptMemoryChangesReview = memo(function TranscriptMemoryChangesReview({
  row,
  onMemoryProposalsRespond,
  onMemoryCheckupRespond,
  onMemoryTransferRespond,
  onMemoryPreparationReopen,
}: TranscriptMemoryChangesReviewProps) {
  return (
    <div className="group relative" {...{ [CHAT_SELECTION_ZONE_ATTRIBUTE]: "" }}>
      <MemoryChangesReviewFlow
        messages={row.messages}
        stale={row.isStale}
        onMemoryProposalsRespond={onMemoryProposalsRespond}
        onMemoryCheckupRespond={onMemoryCheckupRespond}
            onMemoryTransferRespond={onMemoryTransferRespond}
        canReopenProposals={row.canReopenProposals}
        canReopenTransfer={row.canReopenTransfer}
        canReopenCheckup={row.canReopenCheckup}
        onMemoryPreparationReopen={onMemoryPreparationReopen}
      />
    </div>
  )
}, (prev, next) => (
  prev.row === next.row
  && prev.onMemoryProposalsRespond === next.onMemoryProposalsRespond
  && prev.onMemoryCheckupRespond === next.onMemoryCheckupRespond
  && prev.onMemoryTransferRespond === next.onMemoryTransferRespond
  && prev.onMemoryPreparationReopen === next.onMemoryPreparationReopen
))

export function buildResolvedTranscriptRows(
  messages: HydratedTranscriptMessage[],
  {
    isLoading,
    localPath,
    latestToolIds,
    suppressTrailingStatus = false,
  }: {
    isLoading: boolean
    localPath?: string
    latestToolIds: Record<string, string | null>
    /**
     * True while the transcript footer shows its own live indicator — the
     * trailing SDK status row would duplicate it ("Requesting…" above a
     * "Running…" spinner), so the footer becomes the single live signal and
     * carries the SDK status label itself (getTrailingSdkStatus).
     */
    suppressTrailingStatus?: boolean
  }
): ResolvedTranscriptRow[] {
  const renderStates = buildTranscriptMessageRenderStates(messages, latestToolIds, { suppressTrailingStatus })
  const renderItems = buildTranscriptRenderItems(messages, renderStates)
  const rows: ResolvedTranscriptRow[] = []
  const previewReopenableTurns = new Set(
    messages
      .filter(
        (message): message is Extract<HydratedTranscriptMessage, { kind: "memory_preview" }> =>
          message.kind === "memory_preview" && message.decision === undefined && !message.refreshing,
      )
      .map((message) => message.turn),
  )
  const transferReopenableTurns = new Set(
    messages
      .filter(
        (message): message is Extract<HydratedTranscriptMessage, { kind: "memory_transfer" }> =>
          message.kind === "memory_transfer" && message.decision === undefined,
      )
      .map((message) => message.turn),
  )
  const checkupReopenableTurns = new Set(
    messages
      .filter(
        (message): message is Extract<HydratedTranscriptMessage, { kind: "memory_checkup" }> =>
          message.kind === "memory_checkup" && message.decision === undefined && !message.waiting,
      )
      .map((message) => message.turn),
  )

  // A pending preview is only actionable while the turn is actually parked on
  // it — i.e. no newer turn-flow entry exists (covers server-restart orphans).
  let lastTurnFlowIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const kind = messages[i]!.kind
    if (kind === "user_prompt" || kind === "assistant_text" || kind === "result") {
      lastTurnFlowIndex = i
      break
    }
  }

  for (const item of renderItems) {
    if (item.type === "memory-changes-review") {
      rows.push({
        kind: "memory-changes-review",
        id: getTranscriptRenderItemId(item),
        startIndex: item.startIndex,
        messages: item.messages,
        isStale:
          item.messages.some((message) => message.decision === undefined)
          && item.startIndex < lastTurnFlowIndex,
        canReopenProposals: item.messages.some(
          (message) =>
            previewReopenableTurns.has(message.turn)
            || checkupReopenableTurns.has(message.turn)
            || transferReopenableTurns.has(message.turn),
        ),
        // Like Step 1: the Transfer card stays editable while Step 2 is still
        // computing or undecided, not only once the preview is parked.
        canReopenTransfer: item.messages.some(
          (message) => previewReopenableTurns.has(message.turn) || checkupReopenableTurns.has(message.turn),
        ),
        canReopenCheckup: item.messages.some((message) => previewReopenableTurns.has(message.turn)),
      })
      continue
    }
    if (item.type === "tool-group") {
      rows.push({
        kind: "tool-group",
        id: getTranscriptRenderItemId(item),
        startIndex: item.startIndex,
        messages: item.messages,
        isLoading: isLoading && item.messages.some((message) => message.kind === "tool" && message.result === undefined),
        localPath,
      })
      continue
    }

    const renderState = renderStates[item.index]
    if (!renderState) continue
    const row: ResolvedSingleTranscriptRow = {
      kind: "single",
      id: getTranscriptRenderItemId(item),
      message: item.message,
      index: item.index,
      isLoading: item.message.kind === "tool" && item.message.result === undefined && isLoading,
      localPath,
      isFirstSystem: renderState.isFirstSystem,
      isFirstAccount: renderState.isFirstAccount,
      isLatestAskUserQuestion: item.message.id === latestToolIds.AskUserQuestion,
      isLatestExitPlanMode: item.message.id === latestToolIds.ExitPlanMode,
      isLatestTodoWrite: renderState.isLatestTodoWrite,
      hideResult: renderState.hideResult,
      isFinalStatus: renderState.isFinalStatus,
      isStaleMemoryPreview:
        (item.message.kind === "memory_preview" || item.message.kind === "memory_proposals" || item.message.kind === "memory_transfer" || item.message.kind === "memory_checkup")
        && item.message.decision === undefined
        && item.index < lastTurnFlowIndex,
    }

    if (renderState.shouldRender) {
      rows.push(row)
    }
  }

  return rows
}

export interface ChatTranscriptRowProps {
  row: ResolvedTranscriptRow
  isCurrentTurnAssistant?: boolean
  toolGroupExpanded?: boolean
  onToolGroupExpandedChange: (groupId: string, next: boolean) => void
  onAskUserQuestionSubmit: (
    toolUseId: string,
    questions: AskUserQuestionItem[],
    answers: AskUserQuestionAnswerMap
  ) => void
  onExitPlanModeConfirm: (toolUseId: string, confirmed: boolean, clearContext?: boolean, message?: string) => void
  onMemoryPreviewRespond?: (previewId: string, decision: MemoryPreviewDecision, memoryIds?: string[], expectedUses?: ExpectedMemoryUse[]) => void
  onMemoryProposalsRespond?: (proposalsId: string, decision: "reviewed" | "skipped") => Promise<void> | void
  onMemoryCheckupRespond?: (checkupId: string, decision: "handled" | "skipped") => Promise<void> | void
  onMemoryTransferRespond?: (transferId: string, decision: "handled" | "skipped") => Promise<void> | void
  onMemoryPreparationReopen?: (from: "proposals" | "checkup" | "transfer", stageId: string) => Promise<void> | void
}

export const ChatTranscriptRow = memo(function ChatTranscriptRow({
  row,
  isCurrentTurnAssistant,
  toolGroupExpanded,
  onToolGroupExpandedChange,
  onAskUserQuestionSubmit,
  onExitPlanModeConfirm,
  onMemoryPreviewRespond,
  onMemoryProposalsRespond,
  onMemoryCheckupRespond,
  onMemoryTransferRespond,
  onMemoryPreparationReopen,
}: ChatTranscriptRowProps) {
  if (row.kind === "memory-changes-review") {
    return (
      <TranscriptMemoryChangesReview
        row={row}
        onMemoryProposalsRespond={onMemoryProposalsRespond}
        onMemoryCheckupRespond={onMemoryCheckupRespond}
            onMemoryTransferRespond={onMemoryTransferRespond}
        onMemoryPreparationReopen={onMemoryPreparationReopen}
      />
    )
  }

  if (row.kind === "tool-group") {
    return (
      <TranscriptToolGroup
        id={row.id}
        startIndex={row.startIndex}
        messages={row.messages}
        isLoading={row.isLoading}
        localPath={row.localPath}
        expanded={toolGroupExpanded ?? true}
        onExpandedChange={onToolGroupExpandedChange}
      />
    )
  }

  return (
    <TranscriptSingleRow
      message={row.message}
      index={row.index}
      isLoading={row.isLoading}
      localPath={row.localPath}
      isFirstSystem={row.isFirstSystem}
      isFirstAccount={row.isFirstAccount}
      isLatestAskUserQuestion={row.isLatestAskUserQuestion}
      isLatestExitPlanMode={row.isLatestExitPlanMode}
      isLatestTodoWrite={row.isLatestTodoWrite}
      hideResult={row.hideResult}
      isFinalStatus={row.isFinalStatus}
      isStaleMemoryPreview={row.isStaleMemoryPreview}
      isCurrentTurnAssistant={isCurrentTurnAssistant}
      onAskUserQuestionSubmit={onAskUserQuestionSubmit}
      onExitPlanModeConfirm={onExitPlanModeConfirm}
      onMemoryPreviewRespond={onMemoryPreviewRespond}
      onMemoryProposalsRespond={onMemoryProposalsRespond}
      onMemoryCheckupRespond={onMemoryCheckupRespond}
            onMemoryTransferRespond={onMemoryTransferRespond}
      onMemoryPreparationReopen={onMemoryPreparationReopen}
    />
  )
}, areChatTranscriptRowPropsEqual)

// Exported for tests: this comparator is the one actually wired into the
// live transcript (ChatTranscriptViewport renders ChatTranscriptRow); a
// forgotten field here silently freezes rows.
export function areChatTranscriptRowPropsEqual(prev: ChatTranscriptRowProps, next: ChatTranscriptRowProps): boolean {
  if (prev.isCurrentTurnAssistant !== next.isCurrentTurnAssistant) return false
  if (prev.toolGroupExpanded !== next.toolGroupExpanded) return false
  if (prev.onToolGroupExpandedChange !== next.onToolGroupExpandedChange) return false
  if (prev.onAskUserQuestionSubmit !== next.onAskUserQuestionSubmit) return false
  if (prev.onExitPlanModeConfirm !== next.onExitPlanModeConfirm) return false
  if (prev.onMemoryPreviewRespond !== next.onMemoryPreviewRespond) return false
  if (prev.onMemoryProposalsRespond !== next.onMemoryProposalsRespond) return false
  if (prev.onMemoryCheckupRespond !== next.onMemoryCheckupRespond) return false
  if (prev.onMemoryTransferRespond !== next.onMemoryTransferRespond) return false
  if (prev.onMemoryPreparationReopen !== next.onMemoryPreparationReopen) return false
  if (prev.row.kind !== next.row.kind) return false
  if (prev.row.id !== next.row.id) return false

  if (prev.row.kind === "tool-group" && next.row.kind === "tool-group") {
    const previousRow = prev.row
    const nextRow = next.row
    return previousRow.startIndex === nextRow.startIndex
      && previousRow.isLoading === nextRow.isLoading
      && previousRow.localPath === nextRow.localPath
      && previousRow.messages.length === nextRow.messages.length
      && previousRow.messages.every((message, index) => sameMessage(message, nextRow.messages[index]!))
  }

  if (prev.row.kind === "memory-changes-review" && next.row.kind === "memory-changes-review") {
    return prev.row === next.row
  }

  if (prev.row.kind === "single" && next.row.kind === "single") {
    return prev.row.index === next.row.index
      && prev.row.isLoading === next.row.isLoading
      && prev.row.localPath === next.row.localPath
      && prev.row.isFirstSystem === next.row.isFirstSystem
      && prev.row.isFirstAccount === next.row.isFirstAccount
      && prev.row.isLatestAskUserQuestion === next.row.isLatestAskUserQuestion
      && prev.row.isLatestExitPlanMode === next.row.isLatestExitPlanMode
      && prev.row.isLatestTodoWrite === next.row.isLatestTodoWrite
      && prev.row.hideResult === next.row.hideResult
      && prev.row.isFinalStatus === next.row.isFinalStatus
      // A preview card goes stale the moment a later turn starts; the row is
      // otherwise byte-identical, so dropping this field froze the card in
      // its live/actionable look.
      && prev.row.isStaleMemoryPreview === next.row.isStaleMemoryPreview
      && sameMessage(prev.row.message, next.row.message)
  }

  return false
}
