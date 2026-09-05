import { appendFile, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises"
import { existsSync, readFileSync as readFileSyncImmediate } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { getDataDir, LOG_PREFIX } from "../shared/branding"
import type { AgentProvider, ChatHistoryPage, ChatHistorySnapshot, QueuedChatMessage, TranscriptEntry } from "../shared/types"
import { STORE_VERSION } from "../shared/types"
import {
  type ChatEvent,
  type ProjectEvent,
  type QueuedMessageEvent,
  type SnapshotFile,
  type StoreEvent,
  type StoreState,
  type TurnEvent,
  cloneTranscriptEntries,
  createEmptyState,
} from "./events"
import { resolveLocalPath } from "./paths"

const COMPACTION_THRESHOLD_BYTES = 2 * 1024 * 1024
const STALE_EMPTY_CHAT_MAX_AGE_MS = 30 * 60 * 1000
const SIDEBAR_PROJECT_ORDER_FILE = "sidebar-order.json"

function normalizeSidebarProjectOrder(value: unknown) {
  if (!Array.isArray(value)) {
    return []
  }

  const seen = new Set<string>()
  const projectIds: string[] = []
  for (const entry of value) {
    if (typeof entry !== "string") continue
    const projectId = entry.trim()
    if (!projectId || seen.has(projectId)) continue
    seen.add(projectId)
    projectIds.push(projectId)
  }

  return projectIds
}

function isSendToStartingProfilingEnabled() {
  return process.env.MEMOSYNC_PROFILE_SEND_TO_STARTING === "1"
}

function logSendToStartingProfile(stage: string, details?: Record<string, unknown>) {
  if (!isSendToStartingProfilingEnabled()) {
    return
  }

  console.log("[memosync/send->starting][server]", JSON.stringify({
    stage,
    ...details,
  }))
}

interface LegacyTranscriptStats {
  hasLegacyData: boolean
  sources: Array<"snapshot" | "messages_log">
  chatCount: number
  entryCount: number
}

interface TranscriptPageResult {
  entries: TranscriptEntry[]
  hasOlder: boolean
  olderCursor: string | null
}

interface ParsedReplayEvent {
  event: StoreEvent
  sourceIndex: number
  lineIndex: number
}

function getReplayEventPriority(event: StoreEvent) {
  switch (event.type) {
    case "project_opened":
    case "project_sidebar_renamed":
    case "project_removed":
      return 0
    case "chat_created":
      return 1
    case "chat_renamed":
    case "chat_provider_set":
    case "chat_plan_mode_set":
      return 2
    case "message_appended":
      return 3
    case "queued_message_enqueued":
    case "queued_message_removed":
      return 4
    case "turn_started":
      return 5
    case "session_token_set":
      return 6
    case "pending_fork_session_token_set":
      return 6
    case "turn_cancelled":
      return 7
    case "turn_finished":
    case "turn_failed":
      return 8
    case "chat_read_state_set":
      return 9
    case "chat_deleted":
    case "chat_archived":
    case "chat_unarchived":
      return 10
  }
}

function encodeHistoryCursor(index: number) {
  return `idx:${index}`
}

function decodeCursor(cursor: string) {
  if (cursor.startsWith("idx:")) {
    const value = Number.parseInt(cursor.slice("idx:".length), 10)
    if (!Number.isInteger(value) || value < 0) {
      throw new Error("Invalid history cursor")
    }
    return value
  }

  throw new Error("Invalid history cursor")
}

function getHistorySnapshot(page: TranscriptPageResult, recentLimit: number): ChatHistorySnapshot {
  return {
    hasOlder: page.hasOlder,
    olderCursor: page.olderCursor,
    recentLimit,
  }
}

function getForkedChatTitle(title: string) {
  const trimmed = title.trim()
  if (!trimmed) return "Fork: New Chat"
  return trimmed.startsWith("Fork: ") ? trimmed : `Fork: ${trimmed}`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value)
}

function isValidTranscriptEntry(value: unknown): value is TranscriptEntry {
  return isObject(value)
    && isString(value._id)
    && isFiniteNumber(value.createdAt)
    && isString(value.kind)
}

function isValidQueuedChatMessage(value: unknown): value is QueuedChatMessage {
  return isObject(value)
    && isString(value.id)
    && isString(value.content)
    && Array.isArray(value.attachments)
    && isFiniteNumber(value.createdAt)
    && (value.provider === undefined || value.provider === "claude" || value.provider === "codex")
    && (value.model === undefined || isString(value.model))
    && (value.planMode === undefined || typeof value.planMode === "boolean")
}

function isValidStoreEvent(event: unknown): event is StoreEvent {
  if (
    !isObject(event)
    || event.v !== STORE_VERSION
    || !isString(event.type)
    || !isFiniteNumber(event.timestamp)
  ) return false

  const hasChatId = () => isString(event.chatId)
  switch (event.type) {
    case "project_opened":
      return isString(event.projectId) && isString(event.localPath) && isString(event.title)
    case "project_sidebar_renamed":
      return isString(event.projectId) && isNullableString(event.title)
    case "project_removed":
      return isString(event.projectId)
    case "chat_created":
      return hasChatId() && isString(event.projectId) && isString(event.title)
    case "chat_renamed":
      return hasChatId() && isString(event.title)
    case "chat_deleted":
    case "chat_archived":
    case "chat_unarchived":
    case "turn_started":
    case "turn_finished":
    case "turn_cancelled":
      return hasChatId()
    case "chat_provider_set":
      return hasChatId() && (event.provider === "claude" || event.provider === "codex")
    case "chat_plan_mode_set":
      return hasChatId() && typeof event.planMode === "boolean"
    case "chat_read_state_set":
      return hasChatId() && typeof event.unread === "boolean"
    case "message_appended":
      return hasChatId() && isValidTranscriptEntry(event.entry)
    case "queued_message_enqueued":
      return hasChatId() && isValidQueuedChatMessage(event.message)
    case "queued_message_removed":
      return hasChatId() && isString(event.queuedMessageId)
    case "turn_failed":
      return hasChatId() && isString(event.error)
    case "session_token_set":
      return hasChatId() && isNullableString(event.sessionToken)
    case "pending_fork_session_token_set":
      return hasChatId() && isNullableString(event.pendingForkSessionToken)
    default:
      return false
  }
}

function assertValidSnapshot(parsed: unknown): asserts parsed is SnapshotFile {
  if (!isObject(parsed) || parsed.v !== STORE_VERSION) {
    throw new Error(`Unsupported store version: ${isObject(parsed) ? String(parsed.v) : "missing"}`)
  }
  if (!isFiniteNumber(parsed.generatedAt) || !Array.isArray(parsed.projects) || !Array.isArray(parsed.chats)) {
    throw new Error("Snapshot is missing generatedAt, projects, or chats")
  }
  for (const project of parsed.projects) {
    if (
      !isObject(project)
      || typeof project.id !== "string"
      || typeof project.localPath !== "string"
      || typeof project.title !== "string"
      || !isFiniteNumber(project.createdAt)
      || !isFiniteNumber(project.updatedAt)
    ) {
      throw new Error("Snapshot contains an invalid project")
    }
  }
  for (const chat of parsed.chats) {
    if (
      !isObject(chat)
      || typeof chat.id !== "string"
      || typeof chat.projectId !== "string"
      || typeof chat.title !== "string"
      || !isFiniteNumber(chat.createdAt)
      || !isFiniteNumber(chat.updatedAt)
    ) {
      throw new Error("Snapshot contains an invalid chat")
    }
  }
  if (parsed.sidebarProjectOrder !== undefined && (
    !Array.isArray(parsed.sidebarProjectOrder)
    || parsed.sidebarProjectOrder.some((id) => typeof id !== "string")
  )) {
    throw new Error("Snapshot contains an invalid sidebar project order")
  }
  if (parsed.queuedMessages !== undefined && (
    !Array.isArray(parsed.queuedMessages)
    || parsed.queuedMessages.some((collection) => (
      !isObject(collection)
      || typeof collection.chatId !== "string"
      || !Array.isArray(collection.entries)
      || collection.entries.some((entry) => !isValidQueuedChatMessage(entry))
    )))) {
    throw new Error("Snapshot contains invalid queuedMessages")
  }
  if (parsed.messages !== undefined && (
    !Array.isArray(parsed.messages)
    || parsed.messages.some((collection) => (
      !isObject(collection)
      || typeof collection.chatId !== "string"
      || !Array.isArray(collection.entries)
      || collection.entries.some((entry) => !isValidTranscriptEntry(entry))
    )))) {
    throw new Error("Snapshot contains invalid messages")
  }
}

export class EventStore {
  readonly dataDir: string
  readonly state: StoreState = createEmptyState()
  private writeChain = Promise.resolve()
  private readonly snapshotPath: string
  private readonly snapshotBackupPath: string
  private readonly projectsLogPath: string
  private readonly chatsLogPath: string
  private readonly messagesLogPath: string
  private readonly queuedMessagesLogPath: string
  private readonly turnsLogPath: string
  private readonly transcriptsDir: string
  private readonly sidebarProjectOrderPath: string
  private legacyMessagesByChatId = new Map<string, TranscriptEntry[]>()
  private legacySidebarProjectOrder: string[] = []
  private sidebarProjectOrder: string[] = []
  private snapshotHasLegacyMessages = false
  private cachedTranscript: { chatId: string; entries: TranscriptEntry[] } | null = null

  constructor(dataDir = getDataDir(homedir())) {
    this.dataDir = dataDir
    this.snapshotPath = path.join(this.dataDir, "snapshot.json")
    this.snapshotBackupPath = `${this.snapshotPath}.bak`
    this.projectsLogPath = path.join(this.dataDir, "projects.jsonl")
    this.chatsLogPath = path.join(this.dataDir, "chats.jsonl")
    this.messagesLogPath = path.join(this.dataDir, "messages.jsonl")
    this.queuedMessagesLogPath = path.join(this.dataDir, "queued-messages.jsonl")
    this.turnsLogPath = path.join(this.dataDir, "turns.jsonl")
    this.transcriptsDir = path.join(this.dataDir, "transcripts")
    this.sidebarProjectOrderPath = path.join(this.dataDir, SIDEBAR_PROJECT_ORDER_FILE)
  }

  async initialize() {
    await mkdir(this.dataDir, { recursive: true })
    await mkdir(this.transcriptsDir, { recursive: true })
    await this.ensureFile(this.projectsLogPath)
    await this.ensureFile(this.chatsLogPath)
    await this.ensureFile(this.messagesLogPath)
    await this.ensureFile(this.queuedMessagesLogPath)
    await this.ensureFile(this.turnsLogPath)
    await this.scrubLegacyMemoryCandidatePayloads()
    await this.loadSnapshot()
    await this.replayLogs()
    await this.loadSidebarProjectOrder()
    if (!(await this.hasLegacyTranscriptData()) && await this.shouldCompact()) {
      await this.compact()
    }
  }

  private async ensureFile(filePath: string) {
    const file = Bun.file(filePath)
    if (!(await file.exists())) {
      await Bun.write(filePath, "")
    }
  }

  private async scrubLegacyMemoryCandidatePayloads() {
    const transcriptFiles = await readdir(this.transcriptsDir, { withFileTypes: true })
    for (const entry of transcriptFiles) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue
      const transcriptPath = path.join(this.transcriptsDir, entry.name)
      const original = await Bun.file(transcriptPath).text()
      let changed = false
      const scrubbed = original.split("\n").map((line) => {
        if (!line.trim()) return line
        try {
          const message = JSON.parse(line) as unknown
          if (!isObject(message) || message.kind !== "memory_candidates" || !Array.isArray(message.candidates)) {
            return line
          }
          if (message.candidates.some((candidate) => !isObject(candidate) || !isString(candidate.id))) {
            return line
          }
          if (message.candidates.every((candidate) => Object.keys(candidate).length === 1)) {
            return line
          }
          changed = true
          return JSON.stringify({
            ...message,
            candidates: message.candidates.map((candidate) => ({ id: candidate.id })),
          })
        } catch {
          return line
        }
      }).join("\n")
      if (changed) await this.writeSnapshotAtomically(transcriptPath, scrubbed)
    }
  }

  private applySnapshot(parsed: SnapshotFile) {
    assertValidSnapshot(parsed)
    for (const project of parsed.projects) {
      this.state.projectsById.set(project.id, { ...project })
      this.state.projectIdsByPath.set(project.localPath, project.id)
    }
    for (const chat of parsed.chats) {
      this.state.chatsById.set(chat.id, {
        ...chat,
        unread: chat.unread ?? false,
        pendingForkSessionToken: chat.pendingForkSessionToken ?? null,
      })
    }
    this.legacySidebarProjectOrder = normalizeSidebarProjectOrder(parsed.sidebarProjectOrder)
    if (parsed.queuedMessages?.length) {
      for (const queuedSet of parsed.queuedMessages) {
        this.state.queuedMessagesByChatId.set(queuedSet.chatId, queuedSet.entries.map((entry) => ({
          ...entry,
          attachments: [...entry.attachments],
        })))
      }
    }
    if (parsed.messages?.length) {
      this.snapshotHasLegacyMessages = true
      for (const messageSet of parsed.messages) {
        this.legacyMessagesByChatId.set(messageSet.chatId, cloneTranscriptEntries(messageSet.entries))
      }
    }
  }

  private async tryLoadSnapshot(filePath: string) {
    const file = Bun.file(filePath)
    if (!(await file.exists())) return false
    try {
      const text = await file.text()
      if (!text.trim()) return false
      const parsed = JSON.parse(text) as unknown
      assertValidSnapshot(parsed)
      this.applySnapshot(parsed)
      return true
    } catch (error) {
      this.resetState()
      this.clearLegacyTranscriptState()
      console.warn(`${LOG_PREFIX} Failed to load ${path.basename(filePath)}, preserving event logs:`, error)
      return false
    }
  }

  private async loadSnapshot() {
    if (await this.tryLoadSnapshot(this.snapshotPath)) return
    if (await this.tryLoadSnapshot(this.snapshotBackupPath)) {
      console.warn(`${LOG_PREFIX} Recovered local history from ${path.basename(this.snapshotBackupPath)}`)
    }
  }

  private resetState() {
    this.state.projectsById.clear()
    this.state.projectIdsByPath.clear()
    this.state.chatsById.clear()
    this.state.queuedMessagesByChatId.clear()
    this.sidebarProjectOrder = []
    this.legacySidebarProjectOrder = []
    this.cachedTranscript = null
  }

  private clearLegacyTranscriptState() {
    this.legacyMessagesByChatId.clear()
    this.snapshotHasLegacyMessages = false
  }

  private async loadSidebarProjectOrder() {
    const file = Bun.file(this.sidebarProjectOrderPath)
    if (await file.exists()) {
      try {
        const text = await file.text()
        if (!text.trim()) {
          this.sidebarProjectOrder = []
          return
        }
        this.sidebarProjectOrder = normalizeSidebarProjectOrder(JSON.parse(text))
      } catch (error) {
        console.warn(`${LOG_PREFIX} Failed to load ${SIDEBAR_PROJECT_ORDER_FILE}, ignoring saved order:`, error)
        this.sidebarProjectOrder = []
      }
      return
    }

    const legacySidebarProjectOrder = await this.loadLegacySidebarProjectOrder()
    this.sidebarProjectOrder = legacySidebarProjectOrder
    if (legacySidebarProjectOrder.length > 0) {
      await this.writeSidebarProjectOrderFile(legacySidebarProjectOrder)
    }
  }

  private async loadLegacySidebarProjectOrder() {
    const fromProjectsLog = await this.readLegacySidebarProjectOrderFromProjectsLog()
    if (fromProjectsLog.length > 0) {
      return fromProjectsLog
    }
    return [...this.legacySidebarProjectOrder]
  }

  private async readLegacySidebarProjectOrderFromProjectsLog() {
    const file = Bun.file(this.projectsLogPath)
    if (!(await file.exists())) return []

    const text = await file.text()
    if (!text.trim()) return []

    const lines = text.split("\n")
    let lastNonEmpty = -1
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index].trim()) {
        lastNonEmpty = index
        break
      }
    }

    let projectIds: string[] = []
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim()
      if (!line) continue
      try {
        const event = JSON.parse(line) as {
          v?: number
          type?: string
          projectIds?: unknown
        }
        if (event.v !== STORE_VERSION || event.type !== "sidebar_project_order_set") {
          continue
        }
        projectIds = normalizeSidebarProjectOrder(event.projectIds)
      } catch (error) {
        if (index === lastNonEmpty) {
          console.warn(`${LOG_PREFIX} Ignoring corrupt trailing line in ${path.basename(this.projectsLogPath)} while migrating sidebar order`)
          return projectIds
        }
        console.warn(`${LOG_PREFIX} Failed to migrate sidebar order from ${path.basename(this.projectsLogPath)}:`, error)
        return []
      }
    }

    return projectIds
  }

  private async writeSidebarProjectOrderFile(projectIds: string[]) {
    await mkdir(this.dataDir, { recursive: true })
    await writeFile(this.sidebarProjectOrderPath, `${JSON.stringify(projectIds, null, 2)}\n`, "utf8")
  }

  private async replayLogs() {
    const replayEvents = [
      ...await this.loadReplayEvents(this.projectsLogPath, 0),
      ...await this.loadReplayEvents(this.chatsLogPath, 1),
      ...await this.loadReplayEvents(this.messagesLogPath, 2),
      ...await this.loadReplayEvents(this.queuedMessagesLogPath, 3),
      ...await this.loadReplayEvents(this.turnsLogPath, 4),
    ]
    const orderedEvents = replayEvents.sort((left, right) => (
        left.event.timestamp - right.event.timestamp
        || getReplayEventPriority(left.event) - getReplayEventPriority(right.event)
        || left.sourceIndex - right.sourceIndex
        || left.lineIndex - right.lineIndex
      ))

    for (const { event, sourceIndex, lineIndex } of orderedEvents) {
      try {
        this.applyEvent(event)
      } catch (error) {
        console.warn(
          `${LOG_PREFIX} Ignoring invalid ${String(event.type)} event from log ${sourceIndex + 1}, line ${lineIndex + 1}:`,
          error,
        )
      }
    }
  }

  private async loadReplayEvents(filePath: string, sourceIndex: number): Promise<ParsedReplayEvent[]> {
    const file = Bun.file(filePath)
    if (!(await file.exists())) return []
    const text = await file.text()
    if (!text.trim()) return []

    const parsedEvents: ParsedReplayEvent[] = []
    const lines = text.split("\n")
    let lastNonEmpty = -1
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index].trim()) {
        lastNonEmpty = index
        break
      }
    }

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim()
      if (!line) continue
      try {
        const event = JSON.parse(line) as Partial<StoreEvent>
        if (event.v !== STORE_VERSION) {
          console.warn(`${LOG_PREFIX} Ignoring incompatible event in ${path.basename(filePath)} at line ${index + 1}`)
          continue
        }
        if ((event as { type?: unknown }).type === "sidebar_project_order_set") {
          continue
        }
        if (!isValidStoreEvent(event)) {
          console.warn(`${LOG_PREFIX} Ignoring invalid event in ${path.basename(filePath)} at line ${index + 1}`)
          continue
        }
        parsedEvents.push({
          event,
          sourceIndex,
          lineIndex: index,
        })
      } catch (error) {
        if (index === lastNonEmpty) {
          console.warn(`${LOG_PREFIX} Ignoring corrupt trailing line in ${path.basename(filePath)}`)
          return parsedEvents
        }
        console.warn(`${LOG_PREFIX} Ignoring corrupt event in ${path.basename(filePath)} at line ${index + 1}:`, error)
        continue
      }
    }

    return parsedEvents
  }

  private applyEvent(event: StoreEvent) {
    switch (event.type) {
      case "project_opened": {
        const localPath = resolveLocalPath(event.localPath)
        const project = {
          id: event.projectId,
          localPath,
          title: event.title,
          createdAt: event.timestamp,
          updatedAt: event.timestamp,
        }
        this.state.projectsById.set(project.id, project)
        this.state.projectIdsByPath.set(localPath, project.id)
        break
      }
      case "project_removed": {
        const project = this.state.projectsById.get(event.projectId)
        if (!project) break
        project.deletedAt = event.timestamp
        project.updatedAt = event.timestamp
        this.state.projectIdsByPath.delete(project.localPath)
        break
      }
      case "project_sidebar_renamed": {
        const project = this.state.projectsById.get(event.projectId)
        if (!project) break
        if (event.title) {
          project.sidebarTitle = event.title
        } else {
          delete project.sidebarTitle
        }
        project.updatedAt = event.timestamp
        break
      }
      case "chat_created": {
      const chat = {
          id: event.chatId,
          projectId: event.projectId,
          title: event.title,
          createdAt: event.timestamp,
          updatedAt: event.timestamp,
          unread: false,
          provider: null,
          planMode: false,
          sessionToken: null,
          pendingForkSessionToken: null,
          hasMessages: false,
          lastTurnOutcome: null,
        }
        this.state.chatsById.set(chat.id, chat)
        break
      }
      case "chat_renamed": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.title = event.title
        chat.updatedAt = event.timestamp
        break
      }
      case "chat_deleted": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.deletedAt = event.timestamp
        chat.updatedAt = event.timestamp
        this.state.queuedMessagesByChatId.delete(event.chatId)
        break
      }
      case "chat_archived": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.archivedAt = event.timestamp
        chat.updatedAt = event.timestamp
        break
      }
      case "chat_unarchived": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        delete chat.archivedAt
        chat.updatedAt = event.timestamp
        break
      }
      case "chat_provider_set": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.provider = event.provider
        chat.updatedAt = event.timestamp
        break
      }
      case "chat_plan_mode_set": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.planMode = event.planMode
        chat.updatedAt = event.timestamp
        break
      }
      case "chat_read_state_set": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.unread = event.unread
        chat.updatedAt = event.timestamp
        break
      }
      case "message_appended": {
        this.applyMessageMetadata(event.chatId, event.entry)
        const existing = this.legacyMessagesByChatId.get(event.chatId) ?? []
        existing.push({ ...event.entry })
        this.legacyMessagesByChatId.set(event.chatId, existing)
        break
      }
      case "queued_message_enqueued": {
        const existing = this.state.queuedMessagesByChatId.get(event.chatId) ?? []
        // Idempotent by id: compact() writes the snapshot before it truncates
        // the logs, so a crash in that window replays an already-snapshotted
        // enqueue and would otherwise push a duplicate queued message (BUG WS-4).
        if (!existing.some((entry) => entry.id === event.message.id)) {
          existing.push({
            ...event.message,
            attachments: [...event.message.attachments],
          })
        }
        this.state.queuedMessagesByChatId.set(event.chatId, existing)
        const chat = this.state.chatsById.get(event.chatId)
        if (chat) {
          chat.updatedAt = event.timestamp
        }
        break
      }
      case "queued_message_removed": {
        const existing = this.state.queuedMessagesByChatId.get(event.chatId) ?? []
        const next = existing.filter((entry) => entry.id !== event.queuedMessageId)
        if (next.length > 0) {
          this.state.queuedMessagesByChatId.set(event.chatId, next)
        } else {
          this.state.queuedMessagesByChatId.delete(event.chatId)
        }
        const chat = this.state.chatsById.get(event.chatId)
        if (chat) {
          chat.updatedAt = event.timestamp
        }
        break
      }
      case "turn_started": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.updatedAt = event.timestamp
        break
      }
      case "turn_finished": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.updatedAt = event.timestamp
        chat.unread = true
        chat.lastTurnOutcome = "success"
        break
      }
      case "turn_failed": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.updatedAt = event.timestamp
        chat.unread = true
        chat.lastTurnOutcome = "failed"
        break
      }
      case "turn_cancelled": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.updatedAt = event.timestamp
        chat.lastTurnOutcome = "cancelled"
        break
      }
      case "session_token_set": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.sessionToken = event.sessionToken
        chat.updatedAt = event.timestamp
        break
      }
      case "pending_fork_session_token_set": {
        const chat = this.state.chatsById.get(event.chatId)
        if (!chat) break
        chat.pendingForkSessionToken = event.pendingForkSessionToken
        chat.updatedAt = event.timestamp
        break
      }
    }
  }

  private applyMessageMetadata(chatId: string, entry: TranscriptEntry) {
    const chat = this.state.chatsById.get(chatId)
    if (!chat) return
    chat.hasMessages = true
    if (entry.kind === "user_prompt") {
      chat.lastMessageAt = entry.createdAt
    }
    chat.updatedAt = Math.max(chat.updatedAt, entry.createdAt)
  }

  /**
   * Serialize a write task on the single write chain. The chain itself NEVER
   * stays rejected: each task runs after the previous one SETTLES (success or
   * failure), and a task's own error propagates only to that task's caller.
   *
   * Previously every write did `writeChain = writeChain.then(task)` with no
   * rejection handler — so one failed appendFile (disk full, permissions, a
   * flaky storage volume) permanently poisoned the chain: every later write's
   * `.then` callback silently never ran, neither writing to disk nor updating
   * the in-memory state, until the process restarted (BUG WS-1).
   */
  private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const result = this.writeChain.then(task, task)
    this.writeChain = result.then(() => {}, () => {})
    return result
  }

  private append<TEvent extends StoreEvent>(filePath: string, event: TEvent) {
    const payload = `${JSON.stringify(event)}\n`
    return this.enqueueWrite(async () => {
      await appendFile(filePath, payload, "utf8")
      this.applyEvent(event)
    })
  }

  private transcriptPath(chatId: string) {
    return path.join(this.transcriptsDir, `${chatId}.jsonl`)
  }

  private loadTranscriptFromDisk(chatId: string) {
    const transcriptPath = this.transcriptPath(chatId)
    if (!existsSync(transcriptPath)) {
      return []
    }

    const text = readFileSyncImmediate(transcriptPath, "utf8")
    if (!text.trim()) return []

    // Tolerate a corrupt trailing line the same way the event logs do
    // (loadReplayEvents): a process killed mid-append (deploy/OOM/power loss)
    // can leave a half-written last JSONL line. Without this, one bad byte made
    // the whole chat unloadable AND crashed the subscribe/broadcast path for
    // other sockets (BUG WS-2). A parse failure that is NOT the last line is a
    // real corruption we still surface loudly.
    const entries: TranscriptEntry[] = []
    const lines = text.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim()
      if (!line) continue
      try {
        entries.push(JSON.parse(line) as TranscriptEntry)
      } catch (error) {
        const isLastContentfulLine = lines.slice(i + 1).every((rest) => rest.trim() === "")
        if (isLastContentfulLine) {
          console.warn(`${LOG_PREFIX} dropped corrupt trailing line in transcript ${chatId}.jsonl`)
          break
        }
        throw error
      }
    }
    return entries
  }

  async openProject(localPath: string, title?: string) {
    const normalized = resolveLocalPath(localPath)
    const existingId = this.state.projectIdsByPath.get(normalized)
    if (existingId) {
      const existing = this.state.projectsById.get(existingId)
      if (existing && !existing.deletedAt) {
        return existing
      }
    }

    const hiddenProject = [...this.state.projectsById.values()]
      .find((project) => project.localPath === normalized && project.deletedAt)
    const projectId = hiddenProject?.id ?? crypto.randomUUID()
    const event: ProjectEvent = {
      v: STORE_VERSION,
      type: "project_opened",
      timestamp: Date.now(),
      projectId,
      localPath: normalized,
      title: title?.trim() || path.basename(normalized) || normalized,
    }
    await this.append(this.projectsLogPath, event)
    return this.state.projectsById.get(projectId)!
  }

  async removeProject(projectId: string) {
    const project = this.getProject(projectId)
    if (!project) {
      throw new Error("Project not found")
    }

    const event: ProjectEvent = {
      v: STORE_VERSION,
      type: "project_removed",
      timestamp: Date.now(),
      projectId,
    }
    await this.append(this.projectsLogPath, event)
  }

  async renameProjectSidebarTitle(projectId: string, title: string) {
    const trimmed = title.trim()
    const project = this.getProject(projectId)
    if (!project) {
      throw new Error("Project not found")
    }
    const nextTitle = trimmed || null
    if ((project.sidebarTitle ?? null) === nextTitle) return

    const event: ProjectEvent = {
      v: STORE_VERSION,
      type: "project_sidebar_renamed",
      timestamp: Date.now(),
      projectId,
      title: nextTitle,
    }
    await this.append(this.projectsLogPath, event)
  }

  async setSidebarProjectOrder(projectIds: string[]) {
    const validProjectIds = projectIds.filter((projectId) => {
      const project = this.state.projectsById.get(projectId)
      return Boolean(project && !project.deletedAt)
    })

    const uniqueProjectIds = [...new Set(validProjectIds)]
    const current = this.sidebarProjectOrder
    if (
      uniqueProjectIds.length === current.length
      && uniqueProjectIds.every((projectId, index) => current[index] === projectId)
    ) {
      return
    }

    return this.enqueueWrite(async () => {
      await this.writeSidebarProjectOrderFile(uniqueProjectIds)
      this.sidebarProjectOrder = [...uniqueProjectIds]
    })
  }

  async createChat(projectId: string) {
    const project = this.state.projectsById.get(projectId)
    if (!project || project.deletedAt) {
      throw new Error("Project not found")
    }
    const chatId = crypto.randomUUID()
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_created",
      timestamp: Date.now(),
      chatId,
      projectId,
      title: "New Chat",
    }
    await this.append(this.chatsLogPath, event)
    return this.state.chatsById.get(chatId)!
  }

  async forkChat(sourceChatId: string) {
    const sourceChat = this.requireChat(sourceChatId)
    const sourceSessionToken = sourceChat.sessionToken ?? sourceChat.pendingForkSessionToken ?? null
    if (!sourceChat.provider || !sourceSessionToken) {
      throw new Error("Chat cannot be forked")
    }

    const chatId = crypto.randomUUID()
    const createdAt = Date.now()
    const createEvent: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_created",
      timestamp: createdAt,
      chatId,
      projectId: sourceChat.projectId,
      title: getForkedChatTitle(sourceChat.title),
    }
    await this.append(this.chatsLogPath, createEvent)
    await this.setChatProvider(chatId, sourceChat.provider)
    await this.setPlanMode(chatId, sourceChat.planMode)
    await this.setPendingForkSessionToken(chatId, sourceSessionToken)

    const sourceEntries = this.getMessages(sourceChatId)
    if (sourceEntries.length > 0) {
      const transcriptPath = this.transcriptPath(chatId)
      const payload = sourceEntries.map((entry) => JSON.stringify(entry)).join("\n")
      await this.enqueueWrite(async () => {
        await mkdir(this.transcriptsDir, { recursive: true })
        // Atomic write (tmp + rename) so a fork interrupted mid-write can never
        // leave a half-written transcript that later fails to load (BUG WS-2).
        const tmpPath = `${transcriptPath}.tmp`
        await writeFile(tmpPath, `${payload}\n`, "utf8")
        await rename(tmpPath, transcriptPath)
        const chat = this.state.chatsById.get(chatId)
        if (chat) {
          chat.hasMessages = true
          chat.updatedAt = Math.max(chat.updatedAt, createdAt)
        }
        if (this.cachedTranscript?.chatId === chatId) {
          this.cachedTranscript = { chatId, entries: cloneTranscriptEntries(sourceEntries) }
        }
      })
    }

    return this.state.chatsById.get(chatId)!
  }

  async renameChat(chatId: string, title: string) {
    const trimmed = title.trim()
    if (!trimmed) return
    const chat = this.requireChat(chatId)
    if (chat.title === trimmed) return
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_renamed",
      timestamp: Date.now(),
      chatId,
      title: trimmed,
    }
    await this.append(this.chatsLogPath, event)
  }

  async deleteChat(chatId: string) {
    this.requireChat(chatId)
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_deleted",
      timestamp: Date.now(),
      chatId,
    }
    await this.append(this.chatsLogPath, event)
  }

  async archiveChat(chatId: string) {
    this.requireChat(chatId)
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_archived",
      timestamp: Date.now(),
      chatId,
    }
    await this.append(this.chatsLogPath, event)
  }

  async unarchiveChat(chatId: string) {
    this.requireChat(chatId)
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_unarchived",
      timestamp: Date.now(),
      chatId,
    }
    await this.append(this.chatsLogPath, event)
  }

  async pruneStaleEmptyChats(args?: {
    now?: number
    maxAgeMs?: number
    activeChatIds?: Iterable<string>
    protectedChatIds?: Iterable<string>
  }) {
    const now = args?.now ?? Date.now()
    const maxAgeMs = args?.maxAgeMs ?? STALE_EMPTY_CHAT_MAX_AGE_MS
    const protectedChatIds = new Set([
      ...(args?.activeChatIds ?? []),
      ...(args?.protectedChatIds ?? []),
    ])
    const prunedChatIds: string[] = []

    for (const chat of this.state.chatsById.values()) {
      if (chat.deletedAt || chat.archivedAt || protectedChatIds.has(chat.id)) continue
      if (now - chat.createdAt < maxAgeMs) continue
      if (chat.hasMessages) continue
      if (this.getMessages(chat.id).length > 0) {
        chat.hasMessages = true
        continue
      }

      const event: ChatEvent = {
        v: STORE_VERSION,
        type: "chat_deleted",
        timestamp: now,
        chatId: chat.id,
      }
      await this.append(this.chatsLogPath, event)

      const transcriptPath = this.transcriptPath(chat.id)
      await rm(transcriptPath, { force: true })
      if (this.cachedTranscript?.chatId === chat.id) {
        this.cachedTranscript = null
      }

      prunedChatIds.push(chat.id)
    }

    return prunedChatIds
  }

  async setChatProvider(chatId: string, provider: AgentProvider) {
    const chat = this.requireChat(chatId)
    if (chat.provider === provider) return
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_provider_set",
      timestamp: Date.now(),
      chatId,
      provider,
    }
    await this.append(this.chatsLogPath, event)
  }

  async setPlanMode(chatId: string, planMode: boolean) {
    const chat = this.requireChat(chatId)
    if (chat.planMode === planMode) return
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_plan_mode_set",
      timestamp: Date.now(),
      chatId,
      planMode,
    }
    await this.append(this.chatsLogPath, event)
  }

  async setChatReadState(chatId: string, unread: boolean) {
    const chat = this.requireChat(chatId)
    if (chat.unread === unread) return
    const event: ChatEvent = {
      v: STORE_VERSION,
      type: "chat_read_state_set",
      timestamp: Date.now(),
      chatId,
      unread,
    }
    await this.append(this.chatsLogPath, event)
  }

  async appendMessage(
    chatId: string,
    entry: TranscriptEntry,
    options?: { shouldAppend?: () => boolean },
  ) {
    this.requireChat(chatId)
    const payload = `${JSON.stringify(entry)}\n`
    const transcriptPath = this.transcriptPath(chatId)
    const queuedAt = performance.now()
    return this.enqueueWrite(async () => {
      // Some memory-review entries are snapshots of mutable Memory state. Let
      // their caller revalidate at the actual serialized write boundary, after
      // all older transcript work has drained but before anything is durable.
      if (options?.shouldAppend && !options.shouldAppend()) return false
      const startedAt = performance.now()
      const queueDelayMs = Number((startedAt - queuedAt).toFixed(1))
      await mkdir(this.transcriptsDir, { recursive: true })
      const beforeAppendAt = performance.now()
      await appendFile(transcriptPath, payload, "utf8")
      const afterAppendAt = performance.now()
      this.applyMessageMetadata(chatId, entry)
      if (this.cachedTranscript?.chatId === chatId) {
        this.cachedTranscript.entries.push({ ...entry })
      }
      logSendToStartingProfile("event_store.append_message", {
        chatId,
        entryId: entry._id,
        kind: entry.kind,
        payloadBytes: payload.length,
        queueDelayMs,
        appendMs: Number((afterAppendAt - beforeAppendAt).toFixed(1)),
        totalMs: Number((afterAppendAt - queuedAt).toFixed(1)),
      })
      return true
    })
  }

  async enqueueMessage(chatId: string, message: Omit<QueuedChatMessage, "id" | "createdAt"> & Partial<Pick<QueuedChatMessage, "id" | "createdAt">>) {
    this.requireChat(chatId)
    const queuedMessage: QueuedChatMessage = {
      id: message.id ?? crypto.randomUUID(),
      content: message.content,
      attachments: [...(message.attachments ?? [])],
      createdAt: message.createdAt ?? Date.now(),
      provider: message.provider,
      model: message.model,
      modelOptions: message.modelOptions,
      planMode: message.planMode,
    }
    const event: QueuedMessageEvent = {
      v: STORE_VERSION,
      type: "queued_message_enqueued",
      timestamp: queuedMessage.createdAt,
      chatId,
      message: queuedMessage,
    }
    await this.append(this.queuedMessagesLogPath, event)
    return queuedMessage
  }

  async removeQueuedMessage(chatId: string, queuedMessageId: string) {
    this.requireChat(chatId)
    const existing = this.getQueuedMessages(chatId)
    if (!existing.some((entry) => entry.id === queuedMessageId)) {
      throw new Error("Queued message not found")
    }
    const event: QueuedMessageEvent = {
      v: STORE_VERSION,
      type: "queued_message_removed",
      timestamp: Date.now(),
      chatId,
      queuedMessageId,
    }
    await this.append(this.queuedMessagesLogPath, event)
  }

  async recordTurnStarted(chatId: string) {
    this.requireChat(chatId)
    const event: TurnEvent = {
      v: STORE_VERSION,
      type: "turn_started",
      timestamp: Date.now(),
      chatId,
    }
    await this.append(this.turnsLogPath, event)
  }

  async recordTurnFinished(chatId: string) {
    this.requireChat(chatId)
    const event: TurnEvent = {
      v: STORE_VERSION,
      type: "turn_finished",
      timestamp: Date.now(),
      chatId,
    }
    await this.append(this.turnsLogPath, event)
  }

  async recordTurnFailed(chatId: string, error: string) {
    this.requireChat(chatId)
    const event: TurnEvent = {
      v: STORE_VERSION,
      type: "turn_failed",
      timestamp: Date.now(),
      chatId,
      error,
    }
    await this.append(this.turnsLogPath, event)
  }

  async recordTurnCancelled(chatId: string) {
    this.requireChat(chatId)
    const event: TurnEvent = {
      v: STORE_VERSION,
      type: "turn_cancelled",
      timestamp: Date.now(),
      chatId,
    }
    await this.append(this.turnsLogPath, event)
  }

  async setSessionToken(chatId: string, sessionToken: string | null) {
    const chat = this.requireChat(chatId)
    if (chat.sessionToken === sessionToken) return
    const event: TurnEvent = {
      v: STORE_VERSION,
      type: "session_token_set",
      timestamp: Date.now(),
      chatId,
      sessionToken,
    }
    await this.append(this.turnsLogPath, event)
  }

  async setPendingForkSessionToken(chatId: string, pendingForkSessionToken: string | null) {
    const chat = this.requireChat(chatId)
    if ((chat.pendingForkSessionToken ?? null) === pendingForkSessionToken) return
    const event: TurnEvent = {
      v: STORE_VERSION,
      type: "pending_fork_session_token_set",
      timestamp: Date.now(),
      chatId,
      pendingForkSessionToken,
    }
    await this.append(this.turnsLogPath, event)
  }

  getProject(projectId: string) {
    const project = this.state.projectsById.get(projectId)
    if (!project || project.deletedAt) return null
    return project
  }

  requireChat(chatId: string) {
    const chat = this.state.chatsById.get(chatId)
    if (!chat || chat.deletedAt) {
      throw new Error("Chat not found")
    }
    return chat
  }

  getChat(chatId: string) {
    const chat = this.state.chatsById.get(chatId)
    if (!chat || chat.deletedAt) return null
    return chat
  }

  getSidebarProjectOrder() {
    return [...this.sidebarProjectOrder]
  }

  private getMessagesPageFromEntries(entries: TranscriptEntry[], limit: number, beforeIndex?: number): TranscriptPageResult {
    if (entries.length === 0) {
      return { entries: [], hasOlder: false, olderCursor: null }
    }

    const endIndex = beforeIndex === undefined ? entries.length : Math.max(0, Math.min(beforeIndex, entries.length))
    const startIndex = Math.max(0, endIndex - limit)
    return {
      entries: cloneTranscriptEntries(entries.slice(startIndex, endIndex)),
      hasOlder: startIndex > 0,
      olderCursor: startIndex > 0 ? encodeHistoryCursor(startIndex) : null,
    }
  }

  getMessages(chatId: string) {
    if (this.cachedTranscript?.chatId === chatId) {
      return cloneTranscriptEntries(this.cachedTranscript.entries)
    }

    const legacyEntries = this.legacyMessagesByChatId.get(chatId)
    if (legacyEntries) {
      this.cachedTranscript = { chatId, entries: cloneTranscriptEntries(legacyEntries) }
      return cloneTranscriptEntries(this.cachedTranscript.entries)
    }

    const entries = this.loadTranscriptFromDisk(chatId)
    this.cachedTranscript = { chatId, entries }
    return cloneTranscriptEntries(entries)
  }

  getQueuedMessages(chatId: string) {
    const entries = this.state.queuedMessagesByChatId.get(chatId) ?? []
    return entries.map((entry) => ({
      ...entry,
      attachments: [...entry.attachments],
    }))
  }

  getQueuedMessage(chatId: string, queuedMessageId: string) {
    return this.getQueuedMessages(chatId).find((entry) => entry.id === queuedMessageId) ?? null
  }

  /** Chat ids that have at least one persisted queued message (order not significant). */
  getChatIdsWithQueuedMessages(): string[] {
    const ids: string[] = []
    for (const [chatId, entries] of this.state.queuedMessagesByChatId) {
      if (entries.length > 0) ids.push(chatId)
    }
    return ids
  }

  getRecentMessagesPage(chatId: string, limit: number): ChatHistoryPage {
    if (limit <= 0) {
      return { messages: [], hasOlder: false, olderCursor: null }
    }

    const entries = this.getMessages(chatId)
    const page = this.getMessagesPageFromEntries(entries, limit)

    return {
      messages: page.entries,
      hasOlder: page.hasOlder,
      olderCursor: page.olderCursor,
    }
  }

  getMessagesPageBefore(chatId: string, beforeCursor: string, limit: number): ChatHistoryPage {
    if (limit <= 0) {
      return { messages: [], hasOlder: false, olderCursor: null }
    }

    const beforeIndex = decodeCursor(beforeCursor)
    const entries = this.getMessages(chatId)
    const page = this.getMessagesPageFromEntries(entries, limit, beforeIndex)

    return {
      messages: page.entries,
      hasOlder: page.hasOlder,
      olderCursor: page.olderCursor,
    }
  }

  getRecentChatHistory(chatId: string, recentLimit: number) {
    const page = this.getRecentMessagesPage(chatId, recentLimit)
    return {
      messages: page.messages,
      history: getHistorySnapshot({
        entries: page.messages,
        hasOlder: page.hasOlder,
        olderCursor: page.olderCursor,
      }, recentLimit),
    }
  }

  listProjects() {
    return [...this.state.projectsById.values()].filter((project) => !project.deletedAt)
  }

  /** Every non-deleted chat (archived included — their titles still label things). */
  listChats() {
    return [...this.state.chatsById.values()].filter((chat) => !chat.deletedAt)
  }

  /**
   * Durable study evidence authority. Deleted chats stay hidden from every UI
   * query, but their transcript lineage remains available for crash recovery.
   */
  listStudyTranscriptChats() {
    return [...this.state.chatsById.values()]
  }

  listChatsByProject(projectId: string) {
    return [...this.state.chatsById.values()]
      .filter((chat) => chat.projectId === projectId && !chat.deletedAt && !chat.archivedAt)
      .sort((a, b) => (b.lastMessageAt ?? b.updatedAt) - (a.lastMessageAt ?? a.updatedAt))
  }

  getChatCount(projectId: string) {
    return this.listChatsByProject(projectId).length
  }

  async getLegacyTranscriptStats(): Promise<LegacyTranscriptStats> {
    const messagesLogSize = await Bun.file(this.messagesLogPath).size
    const sources: LegacyTranscriptStats["sources"] = []
    if (this.snapshotHasLegacyMessages) {
      sources.push("snapshot")
    }
    if (messagesLogSize > 0) {
      sources.push("messages_log")
    }

    let entryCount = 0
    for (const entries of this.legacyMessagesByChatId.values()) {
      entryCount += entries.length
    }

    return {
      hasLegacyData: sources.length > 0 || this.legacyMessagesByChatId.size > 0,
      sources,
      chatCount: this.legacyMessagesByChatId.size,
      entryCount,
    }
  }

  async hasLegacyTranscriptData() {
    return (await this.getLegacyTranscriptStats()).hasLegacyData
  }

  private createSnapshot(): SnapshotFile {
    return {
      v: STORE_VERSION,
      generatedAt: Date.now(),
      projects: this.listProjects().map((project) => ({ ...project })),
      // A deleted chat can still contain a participant prompt whose transcript
      // append committed immediately before telemetry failed. Preserve the
      // tombstoned lineage across compaction for deterministic study repair.
      chats: [...this.state.chatsById.values()].map((chat) => ({ ...chat })),
      queuedMessages: [...this.state.queuedMessagesByChatId.entries()]
        .map(([chatId, entries]) => ({
          chatId,
          entries: entries.map((entry) => ({
            ...entry,
            attachments: [...entry.attachments],
          })),
        })),
    }
  }

  async compact() {
    return this.enqueueWrite(async () => {
      // Snapshot creation and log truncation must observe the same point in
      // the serialized write stream. Otherwise a concurrent append can land
      // after createSnapshot() but before truncation and disappear on restart.
      const snapshot = this.createSnapshot()
      const payload = `${JSON.stringify(snapshot, null, 2)}\n`
      await this.writeSnapshotAtomically(this.snapshotPath, payload)
      await this.writeSnapshotAtomically(this.snapshotBackupPath, payload)
      await Promise.all([
        Bun.write(this.projectsLogPath, ""),
        Bun.write(this.chatsLogPath, ""),
        Bun.write(this.messagesLogPath, ""),
        Bun.write(this.queuedMessagesLogPath, ""),
        Bun.write(this.turnsLogPath, ""),
      ])
    })
  }

  private async writeSnapshotAtomically(filePath: string, payload: string) {
    const tempPath = `${filePath}.tmp`
    await writeFile(tempPath, payload, "utf8")
    await rename(tempPath, filePath)
  }

  async migrateLegacyTranscripts(onProgress?: (message: string) => void) {
    const stats = await this.getLegacyTranscriptStats()
    if (!stats.hasLegacyData) return false

    const sourceSummary = stats.sources.map((source) => source === "messages_log" ? "messages.jsonl" : "snapshot.json").join(", ")
    onProgress?.(`${LOG_PREFIX} transcript migration detected: ${stats.chatCount} chats, ${stats.entryCount} entries from ${sourceSummary}`)

    const messageSets = [...this.legacyMessagesByChatId.entries()]
    onProgress?.(`${LOG_PREFIX} transcript migration: writing ${messageSets.length} per-chat transcript files`)

    await mkdir(this.transcriptsDir, { recursive: true })
    const logEveryChat = messageSets.length <= 10
    for (let index = 0; index < messageSets.length; index += 1) {
      const [chatId, entries] = messageSets[index]
      const transcriptPath = this.transcriptPath(chatId)
      const tempPath = `${transcriptPath}.tmp`
      const payload = entries.map((entry) => JSON.stringify(entry)).join("\n")
      await writeFile(tempPath, payload ? `${payload}\n` : "", "utf8")
      await rename(tempPath, transcriptPath)
      if (logEveryChat || (index + 1) % 25 === 0 || index === messageSets.length - 1) {
        onProgress?.(`${LOG_PREFIX} transcript migration: ${index + 1}/${messageSets.length} chats`)
      }
    }

    this.clearLegacyTranscriptState()
    await this.compact()
    this.cachedTranscript = null
    onProgress?.(`${LOG_PREFIX} transcript migration complete`)
    return true
  }

  private async shouldCompact() {
    const sizes = await Promise.all([
      Bun.file(this.projectsLogPath).size,
      Bun.file(this.chatsLogPath).size,
      Bun.file(this.messagesLogPath).size,
      Bun.file(this.queuedMessagesLogPath).size,
      Bun.file(this.turnsLogPath).size,
    ])
    return sizes.reduce((total, size) => total + size, 0) >= COMPACTION_THRESHOLD_BYTES
  }
}
