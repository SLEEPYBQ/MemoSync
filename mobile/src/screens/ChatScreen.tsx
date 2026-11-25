import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ActivityIndicator,
  FlatList,
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
import type {
  AskUserQuestionItem,
  AssistantTextEntry,
  ChatActivityStatus,
  ChatSnapshot,
  ResultEntry,
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
      entry.kind === "result")
  )
}

function isAssistantTextEntry(entry: TranscriptEntry): entry is AssistantTextEntry {
  return entry.kind === "assistant_text" && "text" in entry
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

// -- transcript rows ------------------------------------------------------------

function UserBubble({ entry }: { entry: UserPromptEntry }) {
  const { colors } = useTheme()
  const text = entry.participantContent ?? entry.content
  return (
    <View style={styles.userRow}>
      <View style={[styles.userBubble, { backgroundColor: colors.secondary, borderColor: colors.border }]}> 
        <Text style={[styles.userText, { color: colors.secondaryForeground }]} selectable>
          {text}
        </Text>
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
    const planText = input.summary?.trim() || input.plan?.trim() || "The agent is ready to leave plan mode."
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
      // The buttons already carry the answer choices. Keeping the body to the
      // question itself preserves the compact approval-card rhythm from the
      // reference design instead of repeating every option as a bullet.
      const bodyMarkdown = question.question
      return (
        <PendingApprovalCard
          eyebrow="Question"
          title={question.header?.trim() || "The agent needs an answer"}
          body={<MarkdownLight text={bodyMarkdown} colors={colors} />}
          disabled={props.disabled}
          respondingKey={props.respondingKey}
          onRespond={(option) => props.onRespond(toolUseId, option)}
          options={simpleOptions.map((option, index) => ({
            key: `answer-${index}`,
            label: option.label,
            tone: index === 0 ? "primary" : "secondary",
            result: { questions, answers: { [key]: [option.label] } },
          }))}
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
  interactionDisabled: boolean
  respondingKey: string | null
  onRespond: (toolUseId: string, option: PendingApprovalOption) => Promise<void>
}) {
  const { entry } = props
  if (entry.kind === "user_prompt") return <UserBubble entry={entry as UserPromptEntry} />
  if (entry.kind === "assistant_text") return <AssistantBlock text={(entry as AssistantTextEntry).text} />
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
  const listRef = useRef<FlatList<TranscriptEntry>>(null)
  const atEndRef = useRef(true)

  const entries = useMemo(
    () => coalesceAssistantFragments((snapshot?.messages ?? []).filter(isRenderable)),
    [snapshot?.messages],
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
    const unsubscribe = socket.subscribe<ChatSnapshot | null>(
      { type: "chat", chatId, recentLimit: 200 },
      (value) => {
        if (value) {
          setSnapshot(value)
          setMissing(false)
        } else {
          setMissing(true)
        }
      },
    )
    return () => {
      offStatus()
      unsubscribe()
    }
  }, [chatId])

  // Quietly mark the chat read while its transcript is in view.
  const messageCount = snapshot?.messages.length ?? 0
  useEffect(() => {
    if (!snapshot) return
    getSocket()
      ?.command({ type: "chat.markRead", chatId })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire on mount and as the transcript grows
  }, [chatId, messageCount])

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
    if (!content || !socket || sending || socketStatus !== "connected") return
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
          steer: sendPresentation.action === "steer",
        })
      } else {
        await socket.command({ type: "chat.send", chatId, content })
      }
    } catch (error) {
      // Restore the draft so the user can retry — a message must never vanish —
      // and make the failure visible instead of only logging it to Metro.
      setDraft(content)
      setSendError(describeSendError(error))
      console.warn("send failed", error)
    } finally {
      setSending(false)
    }
  }, [draft, active, chatId, sending, socketStatus, sendPresentation.action])

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
      } catch (error) {
        setSendError(describeSendError(error))
      } finally {
        setRespondingKey(null)
      }
    },
    [chatId],
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
            interactionDisabled={socketStatus !== "connected"}
            respondingKey={respondingKey}
            onRespond={respondTool}
          />
        )}
        contentContainerStyle={styles.transcriptContent}
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
              disabled={!draft.trim() || socketStatus !== "connected"}
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
  userRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    paddingLeft: spacing.xxl,
  },
  userBubble: {
    maxWidth: "88%",
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
