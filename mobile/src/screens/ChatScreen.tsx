import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ActivityIndicator,
  AppState,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Ionicons } from "@expo/vector-icons"
import { colorWithAlpha, radius, spacing, useTheme } from "../theme"
import { MOBILE_TYPOGRAPHY } from "../lib/typography"
import { getSocket, type SocketStatus } from "../lib/socket"
import { useHostStore } from "../lib/hostStore"
import type {
  AskUserQuestionItem,
  AssistantTextEntry,
  ChatActivityStatus,
  ChatAttachment,
  ChatHistoryPage,
  ChatSnapshot,
  InterruptedEntry,
  MemoryPreviewEntry,
  ModelOptions,
  ResultEntry,
  SidebarData,
  ToolCallEntry,
  ToolResultEntry,
  TranscriptEntry,
  UserPromptEntry,
} from "../types"
import type { RootStackParamList } from "../navigation"
import { MarkdownLight } from "../components/MarkdownLight"
import { StatusPill } from "../components/StatusPill"
import { CircleActionButton, ToolbarLabelButton, type ButtonIconName } from "../components/ui/Button"
import { RowPressable } from "../components/ui/RowPressable"
import {
  PendingApprovalCard,
  type PendingApprovalOption,
} from "../features/threads/PendingApprovalCard"
import {
  resolveComposerSendPresentation,
  type FollowUpBehavior,
} from "../features/threads/composerSendPresentation"

type Props = NativeStackScreenProps<RootStackParamList, "Chat">
type Colors = ReturnType<typeof useTheme>["colors"]

function isActiveStatus(status: ChatActivityStatus | undefined): boolean {
  return status === "running" || status === "starting" || status === "previewing_memory" || status === "waiting_for_user"
}

function isRenderable(entry: TranscriptEntry): boolean {
  return (
    !entry.hidden &&
    (entry.kind === "user_prompt" ||
      entry.kind === "assistant_text" ||
      entry.kind === "tool_call" ||
      entry.kind === "memory_preview" ||
      entry.kind === "interrupted" ||
      entry.kind === "result")
  )
}

function isInterruptedEntry(entry: TranscriptEntry): entry is InterruptedEntry {
  return entry.kind === "interrupted"
}

interface ComposerModelSelection {
  provider?: string
  model?: string
  modelOptions?: ModelOptions
}

function modelCommandFields(selection: ComposerModelSelection | null): {
  provider?: string
  model?: string
  modelOptions?: ModelOptions
} {
  return {
    ...(selection?.provider ? { provider: selection.provider } : {}),
    ...(selection?.model ? { model: selection.model } : {}),
    ...(selection?.modelOptions ? { modelOptions: selection.modelOptions } : {}),
  }
}

function commandCatalogModelSelection(snapshot: ChatSnapshot | null): ComposerModelSelection | null {
  const selection = snapshot?.runtime.commandCatalog?.selection
  const provider = snapshot?.runtime.provider ?? null
  if (!selection?.provider || !selection.model?.trim()) return null
  if (provider && selection.provider !== provider) return null
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.modelOptions ? { modelOptions: selection.modelOptions } : {}),
  }
}

function latestSystemInitModelSelection(entries: TranscriptEntry[], provider: string | null): ComposerModelSelection | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as TranscriptEntry & { provider?: unknown; model?: unknown }
    if (entry.kind !== "system_init" || typeof entry.model !== "string" || !entry.model.trim()) continue
    if (typeof entry.provider !== "string" || (provider && entry.provider !== provider)) continue
    return { provider: entry.provider, model: entry.model }
  }
  return null
}

function isAssistantTextEntry(entry: TranscriptEntry): entry is AssistantTextEntry {
  return entry.kind === "assistant_text" && "text" in entry
}

function isMemoryPreviewEntry(entry: TranscriptEntry): entry is MemoryPreviewEntry {
  return entry.kind === "memory_preview" && "previewId" in entry
}

function isMemoryPreviewDecisionEntry(entry: TranscriptEntry): entry is Extract<TranscriptEntry, { kind: "memory_preview_decision" }> {
  return entry.kind === "memory_preview_decision" && "previewId" in entry
}

/** Append live entries without dropping rows that fall out of the host's
 * 200-message sliding subscription window. Existing rows are replaced so hidden
 * corrections/redactions still propagate. */
function mergeTranscriptEntries(first: TranscriptEntry[], second: TranscriptEntry[]): TranscriptEntry[] {
  const merged = [...first]
  const positions = new Map(merged.map((entry, index) => [entry._id, index]))
  for (const entry of second) {
    const existing = positions.get(entry._id)
    if (existing == null) {
      positions.set(entry._id, merged.length)
      merged.push(entry)
    } else {
      merged[existing] = entry
    }
  }
  return merged
}

/** Some providers persist one reply as adjacent assistant fragments. Joining
 * them before markdown parsing matters: a fragment boundary can otherwise fall
 * inside a word, link, or fenced code block and render as corrupted markdown. */
function coalesceAssistantFragments(entries: TranscriptEntry[]): TranscriptEntry[] {
  const coalesced: TranscriptEntry[] = []
  for (const candidate of entries) {
    const previous = coalesced[coalesced.length - 1]
    if (
      isAssistantTextEntry(candidate) &&
      previous &&
      isAssistantTextEntry(previous) &&
      candidate.messageId &&
      previous.messageId === candidate.messageId
    ) {
      coalesced[coalesced.length - 1] = {
        ...previous,
        text: previous.text + candidate.text,
      }
      continue
    }
    coalesced.push(candidate)
  }
  return coalesced
}

function isToolResultEntry(entry: TranscriptEntry): entry is ToolResultEntry {
  return entry.kind === "tool_result" && "toolId" in entry
}

function normalizedToolKind(entry: ToolCallEntry): string {
  if (entry.tool.toolKind) return entry.tool.toolKind
  const name = (entry.tool.toolName ?? "").toLowerCase()
  if (name === "askuserquestion") return "ask_user_question"
  if (name === "exitplanmode") return "exit_plan_mode"
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`).replace(/^_/, "")
}

function toolInputSummary(input: unknown): string {
  if (!input || typeof input !== "object") return ""
  const record = input as Record<string, unknown>
  // Common cases first: file paths and shell commands are what a user glances at.
  for (const key of ["filePath", "file_path", "path", "command", "query", "pattern"]) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) {
      return value.length > 92 ? `${value.slice(0, 91)}…` : value
    }
  }
  try {
    const json = JSON.stringify(input)
    return json.length > 92 ? `${json.slice(0, 91)}…` : json
  } catch {
    return ""
  }
}

function toolInputDetail(input: unknown): string {
  if (input == null) return ""
  if (typeof input === "object" && !Array.isArray(input)) {
    const command = (input as Record<string, unknown>).command
    if (typeof command === "string" && command.trim()) return command
  }
  try {
    return JSON.stringify(input, null, 2)?.slice(0, 4_000) ?? ""
  } catch {
    return String(input).slice(0, 4_000)
  }
}

function toolDisplayName(entry: ToolCallEntry): string {
  const raw = entry.tool.toolName ?? normalizedToolKind(entry) ?? "tool"
  return raw.replace(/^mcp__memory__/, "Memory ").replace(/_/g, " ")
}

function toolIcon(entry: ToolCallEntry): ButtonIconName {
  const kind = normalizedToolKind(entry)
  const name = (entry.tool.toolName ?? "").toLowerCase()
  if (kind === "bash" || name.includes("terminal")) return "terminal-outline"
  if (kind === "read_file" || name === "read") return "document-outline"
  if (kind === "write_file" || name === "write") return "create-outline"
  if (kind === "edit_file" || name === "edit") return "pencil-outline"
  if (kind === "delete_file" || name === "delete") return "trash-bin-outline"
  if (kind === "grep" || name.includes("search")) return "search-outline"
  if (kind === "glob") return "folder-outline"
  if (kind === "web_search" || kind === "webfetch" || name.includes("web")) return "globe-outline"
  if (kind === "todo_write") return "list-outline"
  if (kind === "subagent_task") return "people-outline"
  if (kind === "ask_user_question") return "help-circle-outline"
  if (kind === "exit_plan_mode") return "checkmark-done-outline"
  if (kind === "skill") return "sparkles-outline"
  return "construct-outline"
}

/** The host intentionally returns stable machine codes for model-access
 * preparation failures; translate the common ones instead of exposing kebab-case. */
function describeSendError(error: unknown): string {
  const raw = error instanceof Error ? error.message : ""
  switch (raw) {
    case "account-signed-out":
      return "Sign in to the agent CLI or choose an API connection on the host."
    case "connection-missing":
    case "connection-key-missing":
      return "Choose or configure an API connection in MemoSync settings on the host."
    case "executable-missing":
    case "executable-broken":
    case "executable-incompatible":
      return "Repair the agent CLI installation in MemoSync settings on the host."
    default:
      return raw || "Message could not be sent"
  }
}

function activeStatusLabel(status: ChatActivityStatus | undefined): string {
  switch (status) {
    case "starting":
      return "Starting"
    case "previewing_memory":
      return "Preparing"
    case "waiting_for_user":
      return "Waiting"
    case "running":
      return "Working"
    default:
      return "Idle"
  }
}

function questionKey(question: AskUserQuestionItem): string {
  return question.id || question.question
}

function isExecutionApprovalQuestion(question: AskUserQuestionItem): boolean {
  return question.header?.trim() === "Execution approval"
}

function splitExecutionApprovalQuestion(question: string): { prompt: string; args: string } {
  const newline = question.indexOf("\n")
  if (newline === -1) return { prompt: question, args: "" }
  return { prompt: question.slice(0, newline), args: question.slice(newline + 1) }
}

/** Plan approval changes the next composer mode, but the host only persists
 * that transition when the next turn starts. Keep the mobile override per chat
 * across screen navigation until the authoritative snapshot catches up. */
const planModeOverridesByChat = new Map<string, boolean>()

function sidebarChatIsUnread(data: SidebarData, chatId: string): boolean {
  for (const group of data.projectGroups) {
    const rows = [...group.chats, ...(group.previewChats ?? []), ...(group.olderChats ?? []), ...(group.archivedChats ?? [])]
    if (rows.some((chat) => chat.chatId === chatId && chat.unread)) return true
  }
  return false
}

// -- transcript rows ------------------------------------------------------------

function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function attachmentSource(attachment: ChatAttachment, host: string, port: number, token: string) {
  const path = attachment.contentUrl.startsWith("/") ? attachment.contentUrl : `/${attachment.contentUrl}`
  const uri = /^https?:\/\//i.test(attachment.contentUrl) ? attachment.contentUrl : `http://${host}:${port}${path}`
  return { uri, headers: { Authorization: `Bearer ${token}` } }
}

function UserBubble({ entry }: { entry: UserPromptEntry }) {
  const { colors } = useTheme()
  const credentials = useHostStore((state) => state.credentials)
  const text = entry.participantContent ?? entry.content
  const attachments = entry.attachments ?? []
  const images = attachments.filter((attachment) => attachment.kind === "image" && attachment.contentUrl.startsWith("/"))
  const files = attachments.filter((attachment) => attachment.kind !== "image" || !attachment.contentUrl.startsWith("/"))
  return (
    <View style={styles.userRow}>
      <View style={styles.userContent}>
        {images.length > 0 ? (
          <View style={styles.attachmentImageGrid}>
            {images.map((attachment) => (
              <View key={attachment.id} style={[styles.attachmentImageFrame, { backgroundColor: colors.muted, borderColor: colors.border }]}>
                {credentials ? (
                  <Image
                    source={attachmentSource(attachment, credentials.host, credentials.port, credentials.token)}
                    style={styles.attachmentImage}
                    resizeMode="cover"
                    accessibilityLabel={attachment.displayName}
                  />
                ) : null}
                <Text style={[styles.attachmentCaption, { color: colors.foreground }]} numberOfLines={1}>
                  {attachment.displayName}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
        {files.length > 0 ? (
          <View style={styles.attachmentFileList}>
            {files.map((attachment) => (
              <View key={attachment.id} style={[styles.attachmentFileRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Ionicons name="document-outline" size={15} color={colors.mutedIcon} />
                <View style={styles.attachmentFileText}>
                  <Text style={[styles.attachmentFileName, { color: colors.foreground }]} numberOfLines={1}>{attachment.displayName}</Text>
                  <Text style={[styles.attachmentFileMeta, { color: colors.mutedForeground }]} numberOfLines={1}>
                    {attachment.mimeType} · {formatAttachmentSize(attachment.size)}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        ) : null}
        {text ? (
          <View style={[styles.userBubble, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
            <Text style={[styles.userText, { color: colors.secondaryForeground }]} selectable>
              {text}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  )
}

function AssistantBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  const { colors } = useTheme()
  return (
    <View style={styles.assistantRow}>
      <MarkdownLight text={text} colors={colors} />
      {streaming ? (
        <View style={styles.streamingRow}>
          <ActivityIndicator size="small" color={colors.mutedIcon} />
          <Text style={[styles.streamingText, { color: colors.mutedForeground }]}>Writing</Text>
        </View>
      ) : null}
    </View>
  )
}

function InterruptedRow() {
  const { colors } = useTheme()
  return (
    <View style={styles.interruptedRow}>
      <View style={[styles.interruptedPill, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Ionicons name="stop-circle-outline" size={14} color={colors.mutedIcon} />
        <Text style={[styles.interruptedText, { color: colors.mutedForeground }]}>Interrupted</Text>
      </View>
    </View>
  )
}

function ToolCallRow({ entry }: { entry: ToolCallEntry }) {
  const { colors } = useTheme()
  const [expanded, setExpanded] = useState(false)
  const name = toolDisplayName(entry)
  const summary = toolInputSummary(entry.tool.input)
  const detail = useMemo(() => toolInputDetail(entry.tool.input), [entry.tool.input])
  const icon = toolIcon(entry)

  return (
    <View style={styles.workLogRowWrap}>
      <RowPressable
        accessibilityRole="button"
        accessibilityLabel={`${name}${summary ? `, ${summary}` : ""}`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        interactionColor={colorWithAlpha(colors.foreground, 0.045)}
        interactionOpacity={1}
        style={styles.workLogPressable}
      >
        <View style={styles.workLogRow}>
          <View style={styles.workLogIconSlot}>
            <Ionicons name={icon} size={15} color={colors.mutedIcon} />
          </View>
          <Ionicons
            name={expanded ? "chevron-down" : "chevron-forward"}
            size={12}
            color={colors.mutedIcon}
            style={styles.workLogChevron}
          />
          <Text style={[styles.workLogText, { color: colors.mutedForeground }]} numberOfLines={1}>
            <Text style={{ color: colors.foreground, fontWeight: "500" }}>{name}</Text>
            {summary ? `  ${summary}` : ""}
          </Text>
        </View>
      </RowPressable>
      {expanded && detail ? (
        <View style={[styles.toolDetailFrame, { backgroundColor: colors.sidebar, borderColor: colors.border }]}>
          <ScrollView style={styles.toolDetailScroll} nestedScrollEnabled>
            <Text style={[styles.toolDetail, { color: colors.mutedForeground }]} selectable>
              {detail}
            </Text>
          </ScrollView>
        </View>
      ) : null}
    </View>
  )
}

function ResultRow({ entry }: { entry: ResultEntry }) {
  const { colors } = useTheme()
  if (!entry.isError && entry.subtype !== "error") return null
  return (
    <View style={[styles.resultErrorBox, { backgroundColor: colorWithAlpha(colors.destructive, 0.07), borderColor: colorWithAlpha(colors.destructive, 0.2) }]}>
      <Ionicons name="warning-outline" size={15} color={colors.destructive} />
      <Text style={[styles.resultError, { color: colors.destructive }]} numberOfLines={4}>
        {entry.result || "The turn ended with an error."}
      </Text>
    </View>
  )
}

function MemoryReviewCard({ entry }: { entry: MemoryPreviewEntry }) {
  const count = entry.memories?.length ?? 0
  return (
    <PendingApprovalCard
      eyebrow="Memory review"
      title="Memory review required"
      detail={`MemoSync paused this message while preparing ${count === 1 ? "one memory item" : `${count} memory items`}.`}
      unavailableReason="Review the proposed memory use in MemoSync on the host to continue this turn."
      disabled
      onRespond={() => {}}
      options={[]}
    />
  )
}

function InteractiveToolCard(props: {
  entry: ToolCallEntry
  disabled: boolean
  respondingKey: string | null
  onRespond: (toolUseId: string, option: PendingApprovalOption) => Promise<void>
}) {
  const { entry } = props
  const { colors } = useTheme()
  const [freeformAnswer, setFreeformAnswer] = useState("")
  const kind = normalizedToolKind(entry)
  const toolUseId = entry.tool.toolId ?? entry._id

  if (kind === "exit_plan_mode") {
    const input = (entry.tool.input ?? {}) as { summary?: string; plan?: string }
    const planText = input.plan?.trim() || input.summary?.trim() || "The agent is ready to leave plan mode."
    return (
      <PendingApprovalCard
        eyebrow="Plan approval"
        title="Plan ready for review"
        detail="The agent is waiting for permission to start implementation."
        body={<MarkdownLight text={planText} colors={colors} />}
        disabled={props.disabled}
        respondingKey={props.respondingKey}
        onRespond={(option) => props.onRespond(toolUseId, option)}
        options={[
          {
            key: "decline",
            label: "Keep planning",
            tone: "secondary",
            result: { confirmed: false },
          },
          {
            key: "accept",
            label: "Approve plan",
            tone: "primary",
            result: { confirmed: true },
          },
        ]}
      />
    )
  }

  if (kind === "ask_user_question") {
    const input = (entry.tool.input ?? {}) as { questions?: AskUserQuestionItem[] }
    const questions = Array.isArray(input.questions) ? input.questions : []
    const question = questions.length === 1 ? questions[0] : undefined
    const simpleOptions = question?.options?.filter((option) => option.label?.trim()) ?? []

    if (question && !question.multiSelect && simpleOptions.length > 0 && simpleOptions.length <= 4) {
      const key = questionKey(question)
      const customAnswer = freeformAnswer.trim()
      const executionApproval = isExecutionApprovalQuestion(question)
      const executionParts = executionApproval ? splitExecutionApprovalQuestion(question.question) : null
      return (
        <PendingApprovalCard
          eyebrow="Question"
          title={question.header?.trim() || "The agent needs an answer"}
          body={
            <View style={styles.answerBody}>
              {executionParts ? (
                <>
                  <Text style={[styles.executionApprovalPrompt, { color: colors.foreground }]} selectable>
                    {executionParts.prompt}
                  </Text>
                  {executionParts.args ? (
                    <ScrollView
                      style={[styles.executionArgsScroll, { backgroundColor: colors.sidebar, borderColor: colors.border }]}
                      nestedScrollEnabled
                    >
                      <Text style={[styles.executionArgsText, { color: colors.mutedForeground }]} selectable>
                        {executionParts.args}
                      </Text>
                    </ScrollView>
                  ) : null}
                </>
              ) : (
                <MarkdownLight text={question.question} colors={colors} />
              )}
              <TextInput
                value={freeformAnswer}
                onChangeText={setFreeformAnswer}
                placeholder="Or type another answer"
                placeholderTextColor={colors.mutedIcon}
                multiline
                selectionColor={colors.focus}
                style={[styles.answerInput, { borderColor: colors.input, color: colors.foreground, backgroundColor: colors.background }]}
              />
            </View>
          }
          disabled={props.disabled}
          respondingKey={props.respondingKey}
          onRespond={(option) => props.onRespond(toolUseId, option)}
          options={[
            ...simpleOptions.map((option, index) => ({
              key: `answer-${index}`,
              label: option.label,
              tone: (index === 0 ? "primary" : "secondary") as "primary" | "secondary",
              result: { questions, answers: { [key]: [option.label] } },
            })),
            {
              key: "custom-answer",
              label: "Send custom answer",
              tone: "secondary" as const,
              disabled: !customAnswer,
              result: { questions, answers: { [key]: [customAnswer] } },
            },
          ]}
        />
      )
    }

    if (question && !question.multiSelect && simpleOptions.length === 0) {
      const key = questionKey(question)
      const answer = freeformAnswer.trim()
      return (
        <PendingApprovalCard
          eyebrow="Question"
          title={question.header?.trim() || "The agent needs an answer"}
          body={
            <View style={styles.answerBody}>
              <MarkdownLight text={question.question} colors={colors} />
              <TextInput
                value={freeformAnswer}
                onChangeText={setFreeformAnswer}
                placeholder="Type your answer"
                placeholderTextColor={colors.mutedIcon}
                multiline
                selectionColor={colors.focus}
                style={[styles.answerInput, { borderColor: colors.input, color: colors.foreground, backgroundColor: colors.background }]}
              />
            </View>
          }
          disabled={props.disabled || !answer}
          respondingKey={props.respondingKey}
          onRespond={(option) => props.onRespond(toolUseId, option)}
          options={[
            {
              key: "answer",
              label: "Send answer",
              tone: "primary",
              result: { questions, answers: { [key]: [answer] } },
            },
          ]}
        />
      )
    }

    return (
      <PendingApprovalCard
        eyebrow="Question"
        title="The agent needs input"
        detail="This question has multiple parts or selections. Answer it in MemoSync on the host to continue."
        disabled
        unavailableReason="The compact mobile question UI cannot represent this prompt yet."
        onRespond={(option) => props.onRespond(toolUseId, option)}
        options={[]}
      />
    )
  }

  return <ToolCallRow entry={entry} />
}

function TranscriptRow(props: {
  entry: TranscriptEntry
  pendingToolId: string | null
  pendingMemoryPreviewId: string | null
  interactionDisabled: boolean
  respondingKey: string | null
  onRespond: (toolUseId: string, option: PendingApprovalOption) => Promise<void>
}) {
  const { entry } = props
  if (entry.kind === "user_prompt") return <UserBubble entry={entry as UserPromptEntry} />
  if (entry.kind === "assistant_text") return <AssistantBlock text={(entry as AssistantTextEntry).text} />
  if (isInterruptedEntry(entry)) {
    return (
      <View style={styles.interruptedEntry}>
        {entry.assistantText ? <AssistantBlock text={entry.assistantText} /> : null}
        <InterruptedRow />
      </View>
    )
  }
  if (isMemoryPreviewEntry(entry)) {
    return entry.previewId === props.pendingMemoryPreviewId ? <MemoryReviewCard entry={entry} /> : null
  }
  if (entry.kind === "tool_call") {
    const toolEntry = entry as ToolCallEntry
    const toolId = toolEntry.tool.toolId ?? toolEntry._id
    const interactive = normalizedToolKind(toolEntry) === "ask_user_question" || normalizedToolKind(toolEntry) === "exit_plan_mode"
    if (interactive && props.pendingToolId === toolId) {
      return (
        <InteractiveToolCard
          entry={toolEntry}
          disabled={props.interactionDisabled}
          respondingKey={props.respondingKey}
          onRespond={props.onRespond}
        />
      )
    }
    return <ToolCallRow entry={toolEntry} />
  }
  if (entry.kind === "result") return <ResultRow entry={entry as ResultEntry} />
  return null // status lines and everything else stay quiet on mobile
}

// -- screen ---------------------------------------------------------------------

/**
 * Live chat view. Subscribes `{type:"chat", chatId}`; the host pushes full
 * chat snapshots, and `runtime.streamingText` is replacement-style — each
 * snapshot carries the whole in-progress reply, so it is rendered as-is and
 * never appended to.
 */
export function ChatScreen({ route, navigation }: Props) {
  const { chatId, title } = route.params
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const [snapshot, setSnapshot] = useState<ChatSnapshot | null>(null)
  const [missing, setMissing] = useState(false)
  const [socketStatus, setSocketStatus] = useState<SocketStatus>("disconnected")
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [followUpBehavior, setFollowUpBehavior] = useState<FollowUpBehavior>("queue")
  const [respondingKey, setRespondingKey] = useState<string | null>(null)
  const [sidebarUnread, setSidebarUnread] = useState(false)
  const [foregrounded, setForegrounded] = useState(AppState.currentState === "active")
  const [knownEntries, setKnownEntries] = useState<TranscriptEntry[]>([])
  const [olderEntries, setOlderEntries] = useState<TranscriptEntry[]>([])
  const [historyCursor, setHistoryCursor] = useState<string | null>(null)
  const [hasOlderHistory, setHasOlderHistory] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [planModeOverride, setPlanModeOverrideState] = useState<boolean | null>(() => planModeOverridesByChat.get(chatId) ?? null)
  const setPlanModeOverride = useCallback((value: boolean | null) => {
    if (value == null) planModeOverridesByChat.delete(chatId)
    else planModeOverridesByChat.set(chatId, value)
    setPlanModeOverrideState(value)
  }, [chatId])
  const knownEntriesRef = useRef<TranscriptEntry[]>([])
  const windowUpdatesRef = useRef<Promise<void>>(Promise.resolve())
  const historyInitializedRef = useRef(false)
  const historyGenerationRef = useRef(0)
  const historyLoadingRef = useRef(false)
  const listRef = useRef<FlatList<TranscriptEntry>>(null)
  const atEndRef = useRef(true)

  const transcriptEntries = useMemo(
    () => mergeTranscriptEntries(olderEntries, knownEntries),
    [olderEntries, knownEntries],
  )
  const entries = useMemo(
    () => coalesceAssistantFragments(transcriptEntries.filter(isRenderable)),
    [transcriptEntries],
  )
  const status = snapshot?.runtime.status
  const streamingText = snapshot?.runtime.streamingText ?? null
  const active = isActiveStatus(status)

  useEffect(() => {
    navigation.setOptions({
      // Generated and renamed titles live in the snapshot; the route param is
      // only the list-row label that opened the screen.
      title: snapshot?.runtime.title || title || "Chat",
      headerRight: active
        ? () => <StatusPill label={activeStatusLabel(status)} tone={status === "waiting_for_user" ? "info" : "success"} size="compact" />
        : undefined,
    })
  }, [navigation, snapshot?.runtime.title, title, active, status])

  useEffect(() => {
    const socket = getSocket()
    if (!socket) return
    const offStatus = socket.onStatus(setSocketStatus)
    historyInitializedRef.current = false
    historyGenerationRef.current += 1
    historyLoadingRef.current = false
    knownEntriesRef.current = []
    windowUpdatesRef.current = Promise.resolve()
    // Navigation away must not forget a plan-approval override. Reload the
    // per-chat value instead of clearing it; it is removed only when the host
    // snapshot proves a normal-mode turn caught up.
    setPlanModeOverrideState(planModeOverridesByChat.get(chatId) ?? null)
    setKnownEntries([])
    setOlderEntries([])
    setHistoryCursor(null)
    setHasOlderHistory(false)
    setHistoryError(null)
    const unsubscribe = socket.subscribe<ChatSnapshot | null>(
      { type: "chat", chatId, recentLimit: 200 },
      (value) => {
        if (!value) {
          setMissing(true)
          return
        }
        setSnapshot(value)
        setMissing(false)
        if (!historyInitializedRef.current) {
          historyInitializedRef.current = true
          knownEntriesRef.current = value.messages
          setKnownEntries(value.messages)
          setHistoryCursor(value.history.olderCursor)
          setHasOlderHistory(value.history.hasOlder)
          return
        }

        // Live chat snapshots are sliding windows. If a reconnect jumps ahead
        // by more than that window, fill the missing range backward from the
        // new window until the previous newest row is reached. The user's
        // older-history cursor is deliberately left unchanged.
        const generation = historyGenerationRef.current
        const applyWindow = async () => {
          if (historyGenerationRef.current !== generation) return
          const current = knownEntriesRef.current
          const anchorId = current[current.length - 1]?._id
          let incoming = value.messages
          if (anchorId && value.messages.length > 0 && !value.messages.some((entry) => entry._id === anchorId)) {
            let cursor = value.history.olderCursor
            let bridge: TranscriptEntry[] = []
            let foundAnchor = false
            const visited = new Set<string>()
            while (cursor && !visited.has(cursor)) {
              if (historyGenerationRef.current !== generation) return
              visited.add(cursor)
              const page = await socket.command<ChatHistoryPage>({
                type: "chat.loadHistory",
                chatId,
                beforeCursor: cursor,
                limit: 100,
              })
              if (historyGenerationRef.current !== generation) return
              const anchorIndex = page.messages.findIndex((entry) => entry._id === anchorId)
              bridge = mergeTranscriptEntries(
                anchorIndex >= 0 ? page.messages.slice(anchorIndex + 1) : page.messages,
                bridge,
              )
              if (anchorIndex >= 0) {
                foundAnchor = true
                break
              }
              cursor = page.hasOlder ? page.olderCursor : null
            }
            if (!foundAnchor) throw new Error("Chat history changed while reconnecting; reload the chat")
            incoming = mergeTranscriptEntries(bridge, value.messages)
          }
          if (historyGenerationRef.current !== generation) return
          const merged = mergeTranscriptEntries(knownEntriesRef.current, incoming)
          knownEntriesRef.current = merged
          setKnownEntries(merged)
        }
        windowUpdatesRef.current = windowUpdatesRef.current.then(applyWindow).catch((error) => {
          if (historyGenerationRef.current !== generation) return
          // A failed backfill must not strand the user on a stale transcript.
          // Resynchronize to the latest window; its cursor can still reach all
          // older rows, including the gap, on demand.
          knownEntriesRef.current = value.messages
          setKnownEntries(value.messages)
          setOlderEntries([])
          setHistoryCursor(value.history.olderCursor)
          setHasOlderHistory(value.history.hasOlder)
          setHistoryError(error instanceof Error ? error.message : "Chat history could not be synchronized")
        })
      },
    )
    const unsubscribeSidebar = socket.subscribe<SidebarData>({ type: "sidebar" }, (value) => {
      setSidebarUnread(value ? sidebarChatIsUnread(value, chatId) : false)
    })
    return () => {
      // Invalidate queued/in-flight window backfills as well as the topic
      // subscription; the next page response must not continue paging or write
      // state for a closed chat.
      historyGenerationRef.current += 1
      offStatus()
      unsubscribe()
      unsubscribeSidebar()
    }
  }, [chatId])

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      setForegrounded(state === "active")
    })
    return () => subscription.remove()
  }, [])

  useEffect(() => {
    if (snapshot?.runtime.planMode === false) setPlanModeOverride(null)
  }, [snapshot?.runtime.planMode, setPlanModeOverride])

  // Clear the authoritative sidebar unread flag only while this transcript is
  // visible in the foreground. Unlike transcript length, that flag still changes
  // after the 200-entry live window fills.
  useEffect(() => {
    if (!snapshot || !sidebarUnread || !foregrounded) return
    getSocket()
      ?.command({ type: "chat.markRead", chatId })
      .catch(() => {})
  }, [chatId, snapshot, sidebarUnread, foregrounded])

  const pendingToolId = useMemo(() => {
    const messages = snapshot?.messages ?? []
    const answered = new Set<string>()
    for (const entry of messages) {
      if (isToolResultEntry(entry)) answered.add(entry.toolId)
    }
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const entry = messages[index]
      if (!entry || entry.kind !== "tool_call") continue
      const toolEntry = entry as ToolCallEntry
      const kind = normalizedToolKind(toolEntry)
      if (kind !== "ask_user_question" && kind !== "exit_plan_mode") continue
      const toolId = toolEntry.tool.toolId ?? toolEntry._id
      if (!answered.has(toolId)) return toolId
    }
    return null
  }, [snapshot?.messages])

  const pendingMemoryPreviewId = useMemo(() => {
    const messages = snapshot?.messages ?? []
    const decided = new Set<string>()
    for (const entry of messages) {
      if (isMemoryPreviewDecisionEntry(entry)) decided.add(entry.previewId)
    }
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const entry = messages[index]
      if (entry && isMemoryPreviewEntry(entry) && !decided.has(entry.previewId)) return entry.previewId
    }
    return null
  }, [snapshot?.messages])

  const loadOlderHistory = useCallback(async () => {
    const socket = getSocket()
    if (!socket || !historyCursor || historyLoadingRef.current || !hasOlderHistory) return
    const generation = historyGenerationRef.current
    historyLoadingRef.current = true
    setHistoryLoading(true)
    setHistoryError(null)
    try {
      const page = await socket.command<ChatHistoryPage>({
        type: "chat.loadHistory",
        chatId,
        beforeCursor: historyCursor,
        limit: 100,
      })
      if (historyGenerationRef.current !== generation) return
      setOlderEntries((current) => mergeTranscriptEntries(page.messages, current))
      setHistoryCursor(page.olderCursor)
      setHasOlderHistory(page.hasOlder)
    } catch (error) {
      if (historyGenerationRef.current === generation) {
        setHistoryError(error instanceof Error ? error.message : "Older messages could not be loaded")
      }
    } finally {
      if (historyGenerationRef.current === generation) {
        historyLoadingRef.current = false
        setHistoryLoading(false)
      }
    }
  }, [chatId, hasOlderHistory, historyCursor, historyLoading])

  const composerModelSelection = useMemo(() => {
    // Prefer the host-published command selection: unlike transcript
    // system_init, it carries connection and reasoning options. The transcript
    // fallback keeps a restarted host closer to the chat's last proven model
    // instead of silently reverting to the provider default.
    return commandCatalogModelSelection(snapshot)
      ?? latestSystemInitModelSelection(transcriptEntries, snapshot?.runtime.provider ?? null)
  }, [snapshot, transcriptEntries])

  const sendPresentation = resolveComposerSendPresentation({
    editingQueuedMessage: false,
    running: active,
    canSteer: active,
    followUpBehavior,
    deliveryDeferred: false,
  })

  const send = useCallback(async () => {
    const content = draft.trim()
    const socket = getSocket()
    const planMode = planModeOverride ?? snapshot?.runtime.planMode
    if (!content || !socket || sending || socketStatus !== "connected" || planMode === undefined) return
    setSending(true)
    setSendError(null)
    setDraft("")
    try {
      if (active) {
        // A turn is in flight: queue by default, or steer when the composer
        // follow-up control is in steer mode.
        await socket.command({
          type: "message.enqueue",
          chatId,
          content,
          ...modelCommandFields(composerModelSelection),
          planMode,
          steer: sendPresentation.action === "steer",
        })
      } else {
        await socket.command({
          type: "chat.send",
          chatId,
          content,
          ...modelCommandFields(composerModelSelection),
          planMode,
        })
      }
    } catch (error) {
      // Restore the draft so the user can retry — a message must never vanish —
      // and make the failure visible instead of only logging it to Metro.
      setDraft((current) => (current ? `${content}\n\n${current}` : content))
      setSendError(describeSendError(error))
      console.warn("send failed", error)
    } finally {
      setSending(false)
    }
  }, [draft, active, chatId, sending, socketStatus, sendPresentation.action, snapshot?.runtime.planMode, planModeOverride, composerModelSelection])

  const interrupt = useCallback(() => {
    getSocket()
      ?.command({ type: "chat.cancel", chatId })
      .catch(() => {})
  }, [chatId])

  const dequeue = useCallback(
    (queuedMessageId: string) => {
      getSocket()
        ?.command({ type: "message.dequeue", chatId, queuedMessageId })
        .catch(() => {})
    },
    [chatId],
  )

  const respondTool = useCallback(
    async (toolUseId: string, option: PendingApprovalOption) => {
      const socket = getSocket()
      if (!socket) return
      setRespondingKey(option.key)
      setSendError(null)
      try {
        await socket.command({ type: "chat.respondTool", chatId, toolUseId, result: option.result })
        const toolEntry = (snapshot?.messages ?? []).find((entry): entry is ToolCallEntry => {
          if (entry.kind !== "tool_call") return false
          const candidate = entry as ToolCallEntry
          return (candidate.tool.toolId ?? candidate._id) === toolUseId
        })
        const confirmed = typeof option.result === "object" && option.result !== null && (option.result as { confirmed?: unknown }).confirmed === true
        if (toolEntry && normalizedToolKind(toolEntry) === "exit_plan_mode" && confirmed) {
          // Match the desktop composer: approving a plan means the next user
          // message executes normally until the host reports that transition.
          setPlanModeOverride(false)
        }
      } catch (error) {
        setSendError(describeSendError(error))
      } finally {
        setRespondingKey(null)
      }
    },
    [chatId, snapshot?.messages],
  )

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
    atEndRef.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 96
  }, [])

  const scrollToEndIfPinned = useCallback(() => {
    if (atEndRef.current) listRef.current?.scrollToEnd({ animated: false })
  }, [])

  const queuedMessages = snapshot?.queuedMessages ?? []
  const composerIcon: ButtonIconName =
    sendPresentation.icon === "arrow.up"
      ? "arrow-up"
      : sendPresentation.icon === "tray.and.arrow.up"
        ? "file-tray-outline"
        : sendPresentation.icon === "checkmark"
          ? "checkmark"
          : sendPresentation.icon === "arrow.turn.left.up"
            ? "return-up-back"
            : "list"
  const composerModeLabel = active
    ? sendPresentation.label
    : snapshot?.runtime.memoryDisabled
      ? "Memory off"
      : snapshot?.runtime.provider
        ? String(snapshot.runtime.provider)
        : "MemoSync"

  if (missing) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <Text style={[styles.missingTitle, { color: colors.foreground }]}>Chat not found</Text>
        <Text style={[styles.missingBody, { color: colors.mutedForeground }]}>It may have been deleted or archived on the host.</Text>
      </View>
    )
  }

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.background }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 88 : 0}
    >
      {socketStatus !== "connected" ? (
        <View style={styles.connectionRow}>
          <StatusPill
            label={socketStatus === "connecting" ? "Connecting" : "Connection lost — retrying"}
            tone={socketStatus === "connecting" ? "info" : "warning"}
            size="compact"
          />
        </View>
      ) : null}

      <FlatList
        ref={listRef}
        style={styles.transcriptList}
        data={entries}
        keyExtractor={(item) => item._id}
        renderItem={({ item }) => (
          <TranscriptRow
            entry={item}
            pendingToolId={pendingToolId}
            pendingMemoryPreviewId={pendingMemoryPreviewId}
            interactionDisabled={socketStatus !== "connected"}
            respondingKey={respondingKey}
            onRespond={respondTool}
          />
        )}
        contentContainerStyle={styles.transcriptContent}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        ListHeaderComponent={
          hasOlderHistory || historyError ? (
            <View style={styles.historyHeader}>
              {hasOlderHistory ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Load older messages"
                  disabled={historyLoading || socketStatus !== "connected"}
                  onPress={() => void loadOlderHistory()}
                  style={({ pressed }) => [
                    styles.historyButton,
                    { backgroundColor: colors.secondary, borderColor: colors.border, opacity: historyLoading || socketStatus !== "connected" ? 0.55 : pressed ? 0.82 : 1 },
                  ]}
                >
                  {historyLoading ? <ActivityIndicator size="small" color={colors.mutedForeground} /> : null}
                  <Text style={[styles.historyButtonText, { color: colors.foreground }]}>
                    {historyLoading ? "Loading older messages" : "Load older messages"}
                  </Text>
                </Pressable>
              ) : null}
              {historyError ? <Text style={[styles.historyError, { color: colors.destructive }]}>{historyError}</Text> : null}
            </View>
          ) : null
        }
        onContentSizeChange={scrollToEndIfPinned}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        ListFooterComponent={
          streamingText != null && streamingText.length > 0 ? (
            <AssistantBlock text={streamingText} streaming />
          ) : active ? (
            <View style={styles.thinkingRow}>
              <ActivityIndicator size="small" color={colors.mutedIcon} />
              <Text style={[styles.thinkingText, { color: colors.mutedForeground }]}>
                {status === "starting" ? "Starting…" : status === "previewing_memory" ? "Preparing…" : status === "waiting_for_user" ? "Waiting for input…" : "Working…"}
              </Text>
            </View>
          ) : null
        }
        ListEmptyComponent={
          <View style={styles.emptyTranscript}>
            <View style={[styles.emptyIconWell, { backgroundColor: colors.secondary }]}>
              <Ionicons name="chatbubble-ellipses-outline" size={22} color={colors.mutedIcon} />
            </View>
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>{snapshot ? "No messages yet" : "Loading transcript"}</Text>
            <Text style={[styles.emptyBody, { color: colors.mutedForeground }]}>
              {snapshot ? "Ask a question or give the agent its first task." : "Reading the conversation from your MemoSync host."}
            </Text>
          </View>
        }
      />

      <View style={[styles.composerRegion, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
        {queuedMessages.length > 0 ? (
          <ScrollView
            style={styles.queueScroll}
            nestedScrollEnabled
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.queueList}>
              {queuedMessages.map((message) => (
                <View key={message.id} style={[styles.queueRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <Ionicons name="time-outline" size={15} color={colors.mutedIcon} />
                  <Text style={[styles.queueText, { color: colors.mutedForeground }]} numberOfLines={1}>
                    {message.content}
                  </Text>
                  <Pressable onPress={() => dequeue(message.id)} hitSlop={8}>
                    <Text style={[styles.queueRemove, { color: colors.focus }]}>Remove</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          </ScrollView>
        ) : null}

        {sendError ? (
          <View style={[styles.sendErrorBox, { backgroundColor: colorWithAlpha(colors.destructive, 0.07), borderColor: colorWithAlpha(colors.destructive, 0.2) }]}>
            <Ionicons name="warning-outline" size={15} color={colors.destructive} />
            <Text style={[styles.sendErrorText, { color: colors.destructive }]}>Message not sent: {sendError}</Text>
          </View>
        ) : null}

        <View style={[styles.composerCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <TextInput
            value={draft}
            onChangeText={(value) => {
              setDraft(value)
              if (sendError) setSendError(null)
            }}
            placeholder={active ? "Follow up…" : "Message…"}
            placeholderTextColor={colors.mutedIcon}
            multiline
            textAlignVertical="top"
            selectionColor={colors.focus}
            style={[styles.composerInput, { color: colors.foreground }]}
          />
          <View style={styles.composerToolbar}>
            <ToolbarLabelButton
              label={composerModeLabel}
              icon={active ? composerIcon : snapshot?.runtime.memoryDisabled ? "sparkles-outline" : "chatbubble-outline"}
              selected={active && sendPresentation.action === "steer"}
              onPress={
                active && sendPresentation.offersFollowUpChoice
                  ? () => setFollowUpBehavior((mode) => (mode === "queue" ? "steer" : "queue"))
                  : undefined
              }
            />
            <View style={styles.composerSpacer} />
            {active ? (
              <CircleActionButton
                accessibilityLabel="Stop the running turn"
                icon="stop"
                variant="secondary"
                size={34}
                onPress={interrupt}
                style={styles.stopButton}
              />
            ) : null}
            <CircleActionButton
              accessibilityLabel={sendPresentation.label}
              icon={composerIcon}
              onPress={send}
              disabled={!draft.trim() || !snapshot || socketStatus !== "connected"}
              loading={sending}
              size={38}
            />
          </View>
        </View>
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    padding: spacing.xl,
  },
  missingTitle: {
    ...MOBILE_TYPOGRAPHY.title,
  },
  missingBody: {
    ...MOBILE_TYPOGRAPHY.bodySmall,
    textAlign: "center",
  },
  connectionRow: {
    alignItems: "center",
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  transcriptList: {
    // Constrain the scroll viewport to the space above the composer. Without
    // this, tall interactive cards can extend underneath the composer instead
    // of remaining scrollable into view.
    flex: 1,
  },
  transcriptContent: {
    flexGrow: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
    gap: spacing.md,
  },
  emptyTranscript: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacing.xxl * 2,
    gap: spacing.sm,
  },
  emptyIconWell: {
    width: 46,
    height: 46,
    borderRadius: radius.full,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.xs,
  },
  emptyTitle: {
    ...MOBILE_TYPOGRAPHY.headline,
  },
  emptyBody: {
    ...MOBILE_TYPOGRAPHY.bodySmall,
    maxWidth: 280,
    textAlign: "center",
  },
  historyHeader: {
    alignItems: "center",
    gap: spacing.xs,
    paddingBottom: spacing.xs,
  },
  historyButton: {
    minHeight: 34,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
  },
  historyButtonText: {
    ...MOBILE_TYPOGRAPHY.label,
  },
  historyError: {
    ...MOBILE_TYPOGRAPHY.caption,
    textAlign: "center",
  },
  userRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    paddingLeft: spacing.xxl,
  },
  userContent: {
    maxWidth: "88%",
    alignItems: "flex-end",
    gap: spacing.xs,
  },
  attachmentImageGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: spacing.xs,
  },
  attachmentImageFrame: {
    width: 150,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  attachmentImage: {
    width: 150,
    height: 110,
  },
  attachmentCaption: {
    ...MOBILE_TYPOGRAPHY.caption,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  attachmentFileList: {
    alignSelf: "stretch",
    gap: spacing.xs,
  },
  attachmentFileRow: {
    minHeight: 44,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  attachmentFileText: {
    flexShrink: 1,
    minWidth: 0,
  },
  attachmentFileName: {
    ...MOBILE_TYPOGRAPHY.footnote,
    fontWeight: "600",
  },
  attachmentFileMeta: {
    ...MOBILE_TYPOGRAPHY.caption,
  },
  userBubble: {
    maxWidth: "100%",
    borderRadius: radius.xl,
    borderBottomRightRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md + 1,
    paddingVertical: spacing.sm + 3,
  },
  userText: {
    ...MOBILE_TYPOGRAPHY.bodySmall,
  },
  assistantRow: {
    gap: spacing.xs,
    paddingRight: spacing.xs,
  },
  interruptedEntry: {
    gap: spacing.xs,
  },
  interruptedRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  interruptedPill: {
    minHeight: 30,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
  },
  interruptedText: {
    ...MOBILE_TYPOGRAPHY.label,
    fontStyle: "italic",
  },
  streamingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  streamingText: {
    ...MOBILE_TYPOGRAPHY.caption,
  },
  thinkingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  thinkingText: {
    ...MOBILE_TYPOGRAPHY.label,
  },
  workLogRowWrap: {
    marginVertical: -spacing.xs,
  },
  workLogPressable: {
    borderRadius: radius.base,
    marginHorizontal: -spacing.sm,
  },
  workLogRow: {
    minHeight: 34,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: spacing.sm,
  },
  workLogIconSlot: {
    width: 22,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  workLogChevron: {
    width: 14,
  },
  workLogText: {
    ...MOBILE_TYPOGRAPHY.footnote,
    minWidth: 0,
    flex: 1,
  },
  toolDetailFrame: {
    marginLeft: spacing.xl + spacing.sm,
    marginBottom: spacing.xs,
    borderRadius: radius.base,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  toolDetailScroll: {
    maxHeight: 220,
  },
  toolDetail: {
    ...MOBILE_TYPOGRAPHY.caption,
    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
    padding: spacing.md,
  },
  resultErrorBox: {
    borderRadius: radius.base,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 1,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
  },
  resultError: {
    ...MOBILE_TYPOGRAPHY.footnote,
    flex: 1,
  },
  answerBody: {
    gap: spacing.md,
  },
  executionApprovalPrompt: {
    ...MOBILE_TYPOGRAPHY.bodySmall,
    fontWeight: "600",
  },
  executionArgsScroll: {
    maxHeight: 220,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.base,
  },
  executionArgsText: {
    ...MOBILE_TYPOGRAPHY.caption,
    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
    padding: spacing.md,
  },
  answerInput: {
    minHeight: 72,
    maxHeight: 130,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.base,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: MOBILE_TYPOGRAPHY.bodySmall.fontSize,
    lineHeight: MOBILE_TYPOGRAPHY.bodySmall.lineHeight,
    textAlignVertical: "top",
  },
  composerRegion: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xs,
    gap: spacing.sm,
  },
  queueScroll: {
    // About three rows. Long queues remain reachable through their own scroll
    // view instead of consuming the transcript viewport or pushing Stop and
    // the composer off-screen.
    maxHeight: 128,
    flexGrow: 0,
  },
  queueList: {
    gap: spacing.xs,
  },
  queueRow: {
    minHeight: 38,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  queueText: {
    ...MOBILE_TYPOGRAPHY.label,
    flex: 1,
  },
  queueRemove: {
    ...MOBILE_TYPOGRAPHY.label,
    fontWeight: "500",
  },
  sendErrorBox: {
    borderRadius: radius.base,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  sendErrorText: {
    ...MOBILE_TYPOGRAPHY.label,
    flex: 1,
  },
  composerCard: {
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    shadowColor: "#3f362f",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 1,
  },
  composerInput: {
    minHeight: 48,
    maxHeight: 132,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
    fontSize: MOBILE_TYPOGRAPHY.body.fontSize,
    lineHeight: 22,
  },
  composerToolbar: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingLeft: spacing.sm,
    paddingRight: spacing.sm,
    paddingBottom: spacing.xs,
  },
  composerSpacer: {
    flex: 1,
  },
  stopButton: {
    marginRight: -spacing.xs,
  },
})
