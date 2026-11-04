import { FirstRunCallout } from "../../model-access/FirstRunCallout"
import { useModelAccessStore, type AccessModelOptions } from "../../model-access/modelAccess"
import { httpUiError } from "../../i18n/uiText"
import { t, useI18n, getLocale } from "../../i18n"
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react"
import { ArrowUp, Paperclip, Plus } from "lucide-react"
import { hasFileDragTypes } from "../../app/ChatPage/utils"
import {
  type AgentProvider,
  type ChatAttachment,
  type ClaudeContextWindow,
  type ClaudeReasoningEffort,
  type CodexReasoningEffort,
  type PiReasoningEffort,
  type ModelOptions,
  type ProviderCatalogEntry,
  normalizeClaudeContextWindow,
  resolveClaudeContextWindowTokens,
} from "../../../shared/types"
import { Button } from "../ui/button"
import { Textarea } from "../ui/textarea"
import { ScrollArea } from "../ui/scroll-area"
import { resolveComposerEnter } from "../../../shared/submit-mode"
import { useAppSettingsStore } from "../../stores/appSettingsStore"
import { cn, generateUUID } from "../../lib/utils"
import { isImeComposingKeyEvent } from "../../lib/imeKeys"
import { matchSlashCommands, SLASH_POPUP_MAX_HEIGHT_PX, slashPopupMaxHeightPx } from "../../lib/slashCommands"
import { useSlashCommandsStore } from "../../stores/slashCommandsStore"
import { useIsStandalone } from "../../hooks/useIsStandalone"
import { useChatInputStore } from "../../stores/chatInputStore"
import { runRetainedDraftSubmission } from "./chatDraftSubmission"
import { NEW_CHAT_COMPOSER_ID, type ComposerState, useChatPreferencesStore } from "../../stores/chatPreferencesStore"
import { CHAT_INPUT_ATTRIBUTE, focusNextChatInput } from "../../app/chatFocusPolicy"
import { MemoryToggle, useDraftMemoryDisabled } from "./MemoryToggle"
import { ChatPreferenceControls } from "./ChatPreferenceControls"
import { ExecutionPolicyControl } from "./ExecutionPolicyControl"
import type { ChatHarnessSnapshot, NativeExecutionPolicy } from "../../../shared/harness-capabilities"
import { ContextWindowMeter } from "./ContextWindowMeter"
import { AttachmentFileCard, AttachmentImageCard } from "../messages/AttachmentCard"
import { AttachmentPreviewModal } from "../messages/AttachmentPreviewModal"
import { classifyAttachmentPreview } from "../messages/attachmentPreview"
import { overrideContextWindowMaxTokens, type ContextWindowSnapshot } from "../../lib/contextWindow"

export const MAX_FILES_PER_DROP = 50
const MAX_CONCURRENT_UPLOADS = 3

const CLIPBOARD_EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
}

export function willExceedAttachmentLimit(args: {
  currentAttachmentCount: number
  queuedAttachmentCount: number
  incomingAttachmentCount: number
  maxAttachments?: number
}) {
  const maxAttachments = args.maxAttachments ?? MAX_FILES_PER_DROP
  return args.currentAttachmentCount + args.queuedAttachmentCount + args.incomingAttachmentCount > maxAttachments
}

type ClipboardFileItem = Pick<DataTransferItem, "kind" | "type" | "getAsFile">

function hasClipboardTextPayload(clipboardData: DataTransfer | null | undefined) {
  if (!clipboardData) return false
  return clipboardData.types.includes("text/plain") || clipboardData.types.includes("text/html")
}

function getClipboardImageExtension(file: File) {
  return CLIPBOARD_EXTENSION_BY_MIME_TYPE[file.type] ?? "bin"
}

function isGenericClipboardImageName(file: File) {
  const normalized = file.name.trim().toLowerCase()
  if (!normalized) return true

  const expectedExtension = getClipboardImageExtension(file)
  return normalized === `image.${expectedExtension}` || normalized === "image.png"
}

function normalizeClipboardImageFile(file: File, index: number, timestamp: number) {
  if (file.name && !isGenericClipboardImageName(file)) return file

  const extension = getClipboardImageExtension(file)
  const suffix = index === 0 ? "" : `-${index}`
  const fileName = `clipboard-${timestamp}${suffix}.${extension}`
  Object.defineProperty(file, "name", {
    configurable: true,
    value: fileName,
  })
  return file
}

export function getClipboardImageFiles(items: Iterable<ClipboardFileItem>, timestamp: number) {
  const files: File[] = []

  for (const item of items) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue
    const file = item.getAsFile()
    if (!file) continue
    files.push(normalizeClipboardImageFile(file, files.length, timestamp))
  }

  return files
}

export function trimTrailingPastedNewlines(text: string) {
  return text.replace(/(?:\r\n|\r|\n)+$/, "")
}

export function createUploadFormData(file: File) {
  const formData = new FormData()
  formData.append("files", file)
  formData.append("clientFileSizes", String(file.size))
  return formData
}

function replaceTextSelection(args: {
  value: string
  insertedText: string
  selectionStart: number
  selectionEnd: number
}) {
  return `${args.value.slice(0, args.selectionStart)}${args.insertedText}${args.value.slice(args.selectionEnd)}`
}

interface ComposerAttachment extends ChatAttachment {
  status: "uploading" | "uploaded" | "failed"
  previewUrl?: string
}

interface Props {
  onSubmit: (
    value: string,
    options?: { provider?: AgentProvider; model?: string; modelOptions?: ModelOptions; planMode?: boolean; memoryDisabled?: boolean; attachments?: ChatAttachment[]; steer?: boolean }
  ) => Promise<void>
  onLayoutChange?: () => void
  onCancel?: () => void
  onSendOldestQueued?: () => void
  isRunning?: boolean
  disabled: boolean
  canCancel?: boolean
  chatId?: string | null
  /**
   * Persistence key for the TEXT draft, when it should differ from chatId — the
   * landing composer has no chatId yet but must still keep typed text across
   * navigation (BUG LAND-1). Defaults to chatId.
   */
  draftKey?: string | null
  projectId?: string | null
  inputElementRef?: React.Ref<HTMLTextAreaElement>
  activeProvider: AgentProvider | null
  availableProviders: ProviderCatalogEntry[]
  contextWindowSnapshot?: ContextWindowSnapshot | null
  previousPrompt?: string | null
  /** Slash commands/skills the engine reported (system_init) — powers the "/" autocomplete. */
  slashCommands?: string[]
  harness?: ChatHarnessSnapshot
  onExecutionPolicyChange?: (policy: NativeExecutionPolicy, expectedRevision: number) => Promise<unknown>
  onReadHarness?: (engine: AgentProvider) => Promise<ChatHarnessSnapshot>
  /** Extra chips rendered in the preference-controls row (e.g. the landing page's project picker). */
  leadingControls?: React.ReactNode
}

export interface ChatInputHandle {
  enqueueFiles: (files: File[]) => void
  /**
   * Hand a message back to the composer (e.g. a dismissed preview gate
   * cancels the turn — the typed text must not be lost). Fills only when the
   * draft is empty so it never clobbers something the user started typing.
   */
  restoreText: (text: string) => void
}

function withNormalizedContextWindow(
  state: ComposerState,
  model: string
): ComposerState {
  if (state.provider !== "claude") return { ...state, model }
  return {
    ...state,
    model,
    modelOptions: {
      ...state.modelOptions,
      contextWindow: normalizeClaudeContextWindow(model, state.modelOptions.contextWindow),
    },
  }
}

function getEffectiveComposerState(
  composerState: ComposerState,
  activeProvider: AgentProvider | null,
  providerDefaults: ReturnType<typeof useChatPreferencesStore.getState>["providerDefaults"]
): ComposerState {
  if (!activeProvider || composerState.provider === activeProvider) {
    return composerState
  }

  if (activeProvider === "opencode") return {
    provider: "opencode",
    model: providerDefaults.opencode.model,
    modelOptions: {},
    planMode: false,
  }
  if (activeProvider === "pi") return {
    provider: "pi",
    model: providerDefaults.pi.model,
    modelOptions: { ...providerDefaults.pi.modelOptions },
    planMode: false,
  }
  return activeProvider === "claude"
    ? {
      provider: "claude",
      model: providerDefaults.claude.model,
      modelOptions: { ...providerDefaults.claude.modelOptions },
      planMode: composerState.planMode,
    }
    : {
      provider: "codex",
      model: providerDefaults.codex.model,
      modelOptions: { ...providerDefaults.codex.modelOptions },
      planMode: composerState.planMode,
    }
}

const ChatInputInner = forwardRef<ChatInputHandle, Props>(function ChatInput({
  onSubmit,
  onLayoutChange,
  onCancel,
  onSendOldestQueued,
  isRunning = false,
  disabled,
  canCancel,
  chatId,
  draftKey,
  projectId,
  inputElementRef,
  activeProvider,
  availableProviders,
  contextWindowSnapshot = null,
  previousPrompt = null,
  slashCommands = [],
  harness,
  onExecutionPolicyChange,
  onReadHarness,
  leadingControls = null,
}, forwardedRef) {
  useI18n()
  const {
    getDraft,
    setDraft,
    getAttachmentDrafts,
    setAttachmentDrafts,
    clearAttachmentDrafts,
  } = useChatInputStore()
  const {
    providerDefaults,
    getComposerState,
    initializeComposerForChat,
    setChatComposerPlanMode,
    resetChatComposerFromProvider,
  } = useChatPreferencesStore()
  const composerChatId = chatId ?? NEW_CHAT_COMPOSER_ID
  // Text-draft persistence key: chatId for a real chat, or an explicit draftKey
  // for the landing composer (which has no chatId yet) so typed text survives
  // navigation (BUG LAND-1).
  const textDraftKey = draftKey ?? chatId ?? null
  const storedComposerState = useChatPreferencesStore((state) => state.chatStates[composerChatId])
  const composerState = storedComposerState ?? getComposerState(composerChatId)
  const draftRevisionRef = useRef(0)
  const submissionRef = useRef<object | null>(null)
  const [value, setValueState] = useState(() => (textDraftKey ? getDraft(textDraftKey) : ""))
  const valueRef = useRef(value)
  const setValue = useCallback((next: React.SetStateAction<string>) => {
    const updated = typeof next === "function" ? next(valueRef.current) : next
    if (updated === valueRef.current) return
    draftRevisionRef.current += 1
    valueRef.current = updated
    setValueState(updated)
    if (textDraftKey) setDraft(textDraftKey, updated)
  }, [textDraftKey, setDraft])
  // "/" autocomplete over engine-reported commands (closed by Esc until the draft changes).
  const [slashIndex, setSlashIndex] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isStandalone = useIsStandalone()
  const draftMemoryDisabled = useDraftMemoryDisabled((s) => s.disabled)
  const setDraftMemoryDisabled = useDraftMemoryDisabled((s) => s.setDisabled)
  const [attachments, setAttachmentsState] = useState<ComposerAttachment[]>(() => hydrateComposerAttachments(chatId ? getAttachmentDrafts(chatId) : []))
  const attachmentsRef = useRef(attachments)
  const setAttachments = useCallback((next: React.SetStateAction<ComposerAttachment[]>) => {
    draftRevisionRef.current += 1
    const updated = typeof next === "function" ? next(attachmentsRef.current) : next
    attachmentsRef.current = updated
    setAttachmentsState(updated)
    if (chatId) {
      // Pending uploads are edits too, even before they have a persisted file.
      setAttachmentDrafts(chatId, updated
        .filter((attachment) => attachment.status === "uploaded")
        .map(({ previewUrl: _previewUrl, status: _status, ...attachment }) => attachment), true)
    }
  }, [chatId, setAttachmentDrafts])
  const [selectedAttachmentId, setSelectedAttachmentId] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const uploadQueueRef = useRef<File[]>([])
  const activeUploadsRef = useRef(0)
  const uploadGenerationRef = useRef(0)
  const removedAttachmentIdsRef = useRef<Set<string>>(new Set())
  const previousProjectIdRef = useRef<string | null>(projectId ?? null)

  useLayoutEffect(() => {
    valueRef.current = textDraftKey ? getDraft(textDraftKey) : ""
    setValueState(valueRef.current)
    submissionRef.current = null
    return () => {
      draftRevisionRef.current += 1
      submissionRef.current = null
      uploadGenerationRef.current += 1
      uploadQueueRef.current = []
      activeUploadsRef.current = 0
    }
  }, [chatId, textDraftKey, getDraft])

  const providerLocked = activeProvider !== null
  const modelAccess = useModelAccessStore(s => s.snapshot)
  const baseProviderPrefs = getEffectiveComposerState(composerState, activeProvider, providerDefaults)
  const engineAccess = modelAccess?.engines[baseProviderPrefs.provider].setup.access
  const providerPrefs = !baseProviderPrefs.connectionId && engineAccess?.mode === "connection"
    ? { ...baseProviderPrefs, connectionId: engineAccess.connectionId, model: engineAccess.defaultModel ?? modelAccess?.connections.find(c => c.id === engineAccess.connectionId)?.models[0]?.id ?? baseProviderPrefs.model }
    : baseProviderPrefs
  const selectedProvider = providerLocked ? activeProvider : composerState.provider
  const harnessOwner = `${chatId ?? ""}:${selectedProvider}`
  const harnessOwnerRef = useRef(harnessOwner)
  harnessOwnerRef.current = harnessOwner
  const [engineHarness, setEngineHarness] = useState<{ owner: string; snapshot: ChatHarnessSnapshot } | null>(null)
  const matchingHarness = harness?.capabilities.engine === selectedProvider ? harness : engineHarness?.owner === harnessOwner ? engineHarness.snapshot : undefined
  useEffect(() => {
    if (!chatId || !onReadHarness || matchingHarness) return
    let cancelled = false
    void onReadHarness(selectedProvider).then(snapshot => {
      if (!cancelled && harnessOwnerRef.current === harnessOwner && snapshot?.capabilities.engine === selectedProvider) setEngineHarness({ owner: harnessOwner, snapshot })
    }).catch(() => {})
    return () => { cancelled = true }
  }, [chatId, selectedProvider, harnessOwner, matchingHarness, onReadHarness])
  async function changeExecutionPolicy(policy: NativeExecutionPolicy, revision: number) {
    try {
      await onExecutionPolicyChange?.(policy, revision)
    } finally {
      if (onReadHarness && harnessOwnerRef.current === harnessOwner) {
        const snapshot = await onReadHarness(policy.engine).catch(() => null)
        if (snapshot && harnessOwnerRef.current === harnessOwner) setEngineHarness({ owner: harnessOwner, snapshot })
      }
    }
  }
  const providerConfig = availableProviders.find((provider) => provider.id === selectedProvider) ?? availableProviders[0]
  const showPlanMode = providerConfig?.supportsPlanMode ?? false
  const activeContextWindow = useMemo(() => {
    if (providerPrefs.provider !== "claude") {
      return contextWindowSnapshot
    }

    const connectionModel = providerPrefs.connectionId
      ? modelAccess?.connections.find(connection => connection.id === providerPrefs.connectionId)?.models.find(model => model.id === providerPrefs.model)
      : undefined
    if (connectionModel?.contextWindow) return overrideContextWindowMaxTokens(contextWindowSnapshot, connectionModel.contextWindow)
    const model = providerConfig?.models.find(model => model.id === providerPrefs.model && !model.connectionId)
    // Account models report their actual window in the usage snapshot. Only a
    // selectable window needs a temporary override while that change is staged.
    if (!model?.contextWindowOptions?.length || model.contextWindowOptions.length < 2) return contextWindowSnapshot
    const claudeModelOptions = providerPrefs.modelOptions as Extract<ComposerState, { provider: "claude" }>["modelOptions"]
    const selected = model.contextWindowOptions.find(option => option.id === claudeModelOptions.contextWindow) ?? model.contextWindowOptions[0]!
    return overrideContextWindowMaxTokens(contextWindowSnapshot, resolveClaudeContextWindowTokens(selected.id))
  }, [contextWindowSnapshot, modelAccess, providerConfig, providerPrefs.connectionId, providerPrefs.model, providerPrefs.modelOptions, providerPrefs.provider])
  const uploadedAttachments = attachments.filter((attachment) => attachment.status === "uploaded")
  const hasPendingUploads = attachments.some((attachment) => attachment.status === "uploading")
  const hasTextToSend = value.trim().length > 0
  const canSubmit = value.trim().length > 0 || uploadedAttachments.length > 0
  const orderedAttachments = [...attachments].sort((left, right) => {
    if (left.kind === right.kind) return 0
    return left.kind === "image" ? -1 : 1
  })
  const selectedAttachment = attachments.find((attachment) => attachment.id === selectedAttachmentId) ?? null

  const cleanupAttachmentPreview = useCallback((attachment: ComposerAttachment) => {
    if (attachment.previewUrl) {
      URL.revokeObjectURL(attachment.previewUrl)
    }
  }, [])

  const clearAttachments = useCallback((options?: { cleanupPreviews?: boolean }) => {
    const cleanupPreviews = options?.cleanupPreviews ?? true
    uploadGenerationRef.current += 1
    removedAttachmentIdsRef.current.clear()
    setAttachments((current) => {
      if (cleanupPreviews) {
        current.forEach(cleanupAttachmentPreview)
      }
      return []
    })
    uploadQueueRef.current = []
    activeUploadsRef.current = 0
    setSelectedAttachmentId(null)
    setUploadError(null)
  }, [cleanupAttachmentPreview, setAttachments])

  useLayoutEffect(() => useChatInputStore.subscribe((state, previous) => {
    if (textDraftKey && state.drafts[textDraftKey] !== previous.drafts[textDraftKey]) {
      valueRef.current = state.drafts[textDraftKey] ?? ""
      setValueState(valueRef.current)
    }
    if (chatId && previous.attachmentDrafts[chatId] && !state.attachmentDrafts[chatId]) {
      const retained = attachmentsRef.current.filter((attachment) => attachment.status !== "uploaded")
      attachmentsRef.current.filter((attachment) => attachment.status === "uploaded").forEach(cleanupAttachmentPreview)
      attachmentsRef.current = retained
      setAttachmentsState(retained)
      setSelectedAttachmentId(null)
    }
  }), [chatId, textDraftKey, cleanupAttachmentPreview])

  const autoResize = useCallback(() => {
    const element = textareaRef.current
    if (!element) return
    if (element.value.length === 0) {
      element.style.height = ""
      return
    }
    element.style.height = "auto"
    element.style.height = `${element.scrollHeight}px`
  }, [])

  const setTextareaRefs = useCallback((node: HTMLTextAreaElement | null) => {
    textareaRef.current = node

    if (inputElementRef) {
      if (typeof inputElementRef === "function") {
        inputElementRef(node)
      } else {
        inputElementRef.current = node
      }
    }
  }, [inputElementRef])

  useLayoutEffect(() => {
    autoResize()
    onLayoutChange?.()
  }, [autoResize, onLayoutChange, value])

  useEffect(() => {
    const handleResize = () => {
      autoResize()
      onLayoutChange?.()
    }

    window.addEventListener("resize", handleResize)
    return () => window.removeEventListener("resize", handleResize)
  }, [autoResize, onLayoutChange])

  useLayoutEffect(() => {
    onLayoutChange?.()
  }, [attachments.length, onLayoutChange, uploadError])

  useEffect(() => {
    textareaRef.current?.focus()
  }, [chatId])

  useEffect(() => {
    initializeComposerForChat(composerChatId)
  }, [composerChatId, initializeComposerForChat])

  useEffect(() => {
    uploadGenerationRef.current += 1
    uploadQueueRef.current = []
    activeUploadsRef.current = 0
    removedAttachmentIdsRef.current.clear()
    setSelectedAttachmentId(null)
    setUploadError(null)
    attachmentsRef.current.forEach(cleanupAttachmentPreview)
    const hydrated = hydrateComposerAttachments(chatId ? getAttachmentDrafts(chatId) : [])
    attachmentsRef.current = hydrated
    setAttachmentsState(hydrated)
  }, [chatId, cleanupAttachmentPreview, getAttachmentDrafts])

  useEffect(() => {
    const previousProjectId = previousProjectIdRef.current
    previousProjectIdRef.current = projectId ?? null

    if (previousProjectId === null || projectId === previousProjectId) {
      return
    }

    clearAttachments()
    if (chatId) {
      clearAttachmentDrafts(chatId)
    }
  }, [projectId, chatId, clearAttachments, clearAttachmentDrafts])

  useEffect(() => () => {
    attachmentsRef.current.forEach(cleanupAttachmentPreview)
  }, [cleanupAttachmentPreview])

  function updateComposerState(transform: (state: ComposerState) => ComposerState) {
    useChatPreferencesStore.getState().setComposerState(composerChatId, transform(providerPrefs))
  }

  function setReasoningEffort(reasoningEffort: string) {
    updateComposerState((state) => ({
      ...state,
      modelOptions: { ...state.modelOptions, reasoningEffort: reasoningEffort as ClaudeReasoningEffort & CodexReasoningEffort & PiReasoningEffort },
    } as ComposerState))
  }

  function setClaudeContextWindow(contextWindow: ClaudeContextWindow) {
    updateComposerState(
      (state) => state.provider !== "claude"
        ? state
        : withNormalizedContextWindow(
            { ...state, modelOptions: { ...state.modelOptions, contextWindow } },
            state.model
          )
    )
  }

  function setEffectivePlanMode(planMode: boolean) {
    setChatComposerPlanMode(composerChatId, planMode)
  }

  function toggleEffectivePlanMode() {
    setEffectivePlanMode(!providerPrefs.planMode)
  }

  const processUploadQueue = useCallback(() => {
    if (!projectId) return

    while (activeUploadsRef.current < MAX_CONCURRENT_UPLOADS && uploadQueueRef.current.length > 0) {
      const file = uploadQueueRef.current.shift()
      if (!file) break

      activeUploadsRef.current += 1
      const tempId = generateUUID()
      const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined
      const generation = uploadGenerationRef.current

      setAttachments((current) => [...current, {
        id: tempId,
        kind: file.type.startsWith("image/") ? "image" : "file",
        displayName: file.name,
        absolutePath: "",
        relativePath: "",
        contentUrl: "",
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        status: "uploading",
        previewUrl,
      }])

      void (async () => {
        try {
          const formData = createUploadFormData(file)

          const response = await fetch(`/api/projects/${projectId}/uploads`, {
            method: "POST",
            body: formData,
          })

          if (!response.ok) {
            const payload = await response.json().catch(() => ({}))
            throw new Error(httpUiError(payload, t("chat:uploadFailed")))
          }

          const payload = await response.json() as { attachments: ChatAttachment[] }
          const uploaded = payload.attachments[0]
          if (!uploaded) {
            throw new Error(t("chat:uploadFailed"))
          }

          if (generation !== uploadGenerationRef.current) {
            void deleteUploadedAttachment(uploaded)
            if (previewUrl) URL.revokeObjectURL(previewUrl)
            return
          }

          if (removedAttachmentIdsRef.current.has(tempId)) {
            removedAttachmentIdsRef.current.delete(tempId)
            if (previewUrl) URL.revokeObjectURL(previewUrl)
            void deleteUploadedAttachment(uploaded)
            return
          }

          setAttachments((current) => current.map((attachment) => (
            attachment.id !== tempId
              ? attachment
              : {
                  ...attachment,
                  ...uploaded,
                  previewUrl: attachment.previewUrl,
                  status: "uploaded",
                }
          )))
          setUploadError(null)
        } catch (error) {
          if (generation !== uploadGenerationRef.current) {
            if (previewUrl) URL.revokeObjectURL(previewUrl)
            return
          }
          setAttachments((current) => current.map((attachment) => (
            attachment.id === tempId ? { ...attachment, status: "failed" } : attachment
          )))
          setUploadError(error instanceof Error ? error.message : String(error))
        } finally {
          activeUploadsRef.current = Math.max(0, activeUploadsRef.current - 1)
          processUploadQueue()
        }
      })()
    }
  }, [projectId, setAttachments, getLocale()])

  const [isFileDragOver, setIsFileDragOver] = useState(false)
  const composerDragDepthRef = useRef(0)
  const enqueueFiles = useCallback((files: File[]) => {
    if (!projectId) {
      setUploadError(t("chat:openAProjectBeforeUploadingFiles"))
      return
    }

    if (willExceedAttachmentLimit({
      currentAttachmentCount: attachmentsRef.current.length,
      queuedAttachmentCount: uploadQueueRef.current.length,
      incomingAttachmentCount: files.length,
    })) {
      setUploadError(t("chat:youCanUploadUpToValue0FilesAtATime", { v0: MAX_FILES_PER_DROP }))
      return
    }

    uploadQueueRef.current.push(...files)
    setUploadError(null)
    processUploadQueue()
  }, [processUploadQueue, projectId, getLocale()])

  useImperativeHandle(forwardedRef, () => ({
    enqueueFiles,
    restoreText: (text: string) => {
      if (!text) return
      setValue((current) => {
        if (current.trim()) return current
        return text
      })
      textareaRef.current?.focus()
    },
  }), [enqueueFiles, setValue])

  async function handleSubmit(steer?: boolean) {
    if (!canSubmit || hasPendingUploads || submissionRef.current) return

    const submission = {}
    submissionRef.current = submission
    const revision = draftRevisionRef.current
    const ownsDraft = () => submissionRef.current === submission && draftRevisionRef.current === revision
    const persistedRevision = useChatInputStore.getState().getDraftRevision(textDraftKey, chatId ?? null)
    const nextValue = value
    const previousAttachments = attachmentsRef.current
    const attachmentsForSubmit = uploadedAttachments.map(({ previewUrl: _previewUrl, status: _status, ...attachment }) => attachment)
    let modelOptions: AccessModelOptions
    if (providerPrefs.provider === "claude") {
      modelOptions = { claude: { ...providerPrefs.modelOptions } }
    } else if (providerPrefs.provider === "pi") {
      modelOptions = { pi: { ...providerPrefs.modelOptions } }
    } else if (providerPrefs.provider === "opencode") {
      modelOptions = {}
    } else {
      modelOptions = { codex: { ...providerPrefs.modelOptions } }
    }
    if (providerPrefs.connectionId) modelOptions.connectionId = providerPrefs.connectionId
    const submitOptions = {
      steer,
      provider: selectedProvider,
      model: providerPrefs.model,
      modelOptions,
      planMode: showPlanMode ? providerPrefs.planMode : false,
      attachments: attachmentsForSubmit,
      memoryDisabled: chatId ? undefined : draftMemoryDisabled || undefined,
    }
    // Sending may wait for server-side preparation.
    // Keep both local and persisted drafts intact until the *real* send is
    // accepted, so reload/back/send failure cannot erase user input.
    await runRetainedDraftSubmission({
      submit: () => onSubmit(nextValue, submitOptions),
      onAccepted: () => {
        if (submissionRef.current === submission && !ownsDraft()) return
        if (!useChatInputStore.getState().clearSubmittedDraft(persistedRevision)) return
        if (!ownsDraft()) return
        if (!chatId) setDraftMemoryDisabled(false)
        setValue("")
        if (textareaRef.current) textareaRef.current.style.height = "auto"
        clearAttachments({ cleanupPreviews: false })
        previousAttachments.forEach(cleanupAttachmentPreview)
      },
      onRejected: (error) => {
        console.error("[ChatInput] Submit failed:", error)
      },
    })
    if (submissionRef.current === submission) submissionRef.current = null
  }

  // Fresh chats have no system_init yet — fall back to the last list this
  // provider reported anywhere (persisted per provider).
  const cachedSlashCommands = useSlashCommandsStore((state) => state.byProvider[selectedProvider])
  const effectiveSlashCommands = slashCommands.length ? slashCommands : (cachedSlashCommands ?? [])
  const slashMatch = slashDismissed ? null : matchSlashCommands(value, effectiveSlashCommands)
  const activeSlashIndex = slashMatch ? Math.min(slashIndex, slashMatch.matches.length - 1) : 0
  const slashListRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    slashListRef.current?.children[activeSlashIndex]?.scrollIntoView({ block: "nearest" })
  }, [activeSlashIndex])
  // The popup opens upward — cap it to the space above the composer so it
  // never clips off the viewport top (the landing page centers the composer).
  const slashOpen = slashMatch !== null
  const [slashListMaxHeight, setSlashListMaxHeight] = useState(SLASH_POPUP_MAX_HEIGHT_PX)
  useLayoutEffect(() => {
    if (!slashOpen) return
    const anchor = slashListRef.current?.parentElement
    if (!anchor) return
    setSlashListMaxHeight(slashPopupMaxHeightPx(anchor.getBoundingClientRect().top))
  }, [slashOpen])

  function applySlashCommand(command: string) {
    const next = `/${command} `
    setValue(next)
    textareaRef.current?.focus()
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    // Pinyin/IME composition owns its keydowns: Enter picks a candidate (not
    // send — sending mid-composition strands the committed text in the DOM
    // after React clears state), Esc cancels the candidate (not the turn).
    if (isImeComposingKeyEvent(event.nativeEvent)) return

    if (slashMatch) {
      const active = slashMatch.matches[activeSlashIndex]
      // A fully-typed command lets Enter fall through and send the message.
      const exactlyTyped = slashMatch.query === active.toLowerCase()
      if (event.key === "ArrowDown") {
        event.preventDefault()
        setSlashIndex((activeSlashIndex + 1) % slashMatch.matches.length)
        return
      }
      if (event.key === "ArrowUp") {
        event.preventDefault()
        setSlashIndex((activeSlashIndex - 1 + slashMatch.matches.length) % slashMatch.matches.length)
        return
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey && !exactlyTyped)) {
        event.preventDefault()
        applySlashCommand(active)
        return
      }
      if (event.key === "Escape") {
        event.preventDefault()
        setSlashDismissed(true)
        return
      }
    }

    if (event.key === "Tab" && !event.shiftKey) {
      event.preventDefault()
      focusNextChatInput(textareaRef.current, document)
      return
    }

    if (event.key === "Tab" && event.shiftKey && showPlanMode) {
      event.preventDefault()
      toggleEffectivePlanMode()
      return
    }

    if (event.key === "Escape" && canCancel) {
      event.preventDefault()
      onCancel?.()
      return
    }

    if (event.key === "ArrowUp" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && value.length === 0 && previousPrompt) {
      event.preventDefault()
      setValue(previousPrompt)
      return
    }

    const isTouchDevice = "ontouchstart" in window || navigator.maxTouchPoints > 0
    const action = resolveComposerEnter({
      key: event.key, shiftKey: event.shiftKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey,
      nativeEvent: event.nativeEvent, disabled, touch: isTouchDevice, pendingUploads: hasPendingUploads,
      running: isRunning, mode: useAppSettingsStore.getState().settings?.submitWhileRunning ?? "queue",
      text: value, attachmentCount: attachmentsRef.current.length, hasQueuedMessage: Boolean(onSendOldestQueued),
    })
    if (action === "send-oldest-queued") {
      event.preventDefault()
      onSendOldestQueued?.()
    } else if (action !== "none") {
      event.preventDefault()
      void handleSubmit(action === "steer")
    }
  }

  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = getClipboardImageFiles(event.clipboardData.items, Date.now())
    const pastedText = event.clipboardData.getData("text/plain")
    const trimmedText = trimTrailingPastedNewlines(pastedText)
    const shouldTrimTrailingNewlines = pastedText.length > 0 && trimmedText !== pastedText

    if (files.length === 0 && !shouldTrimTrailingNewlines) return

    if (files.length > 0) {
      enqueueFiles(files)
    }

    if (shouldTrimTrailingNewlines) {
      event.preventDefault()
      const textarea = event.currentTarget
      const nextValue = replaceTextSelection({
        value,
        insertedText: trimmedText,
        selectionStart: textarea.selectionStart,
        selectionEnd: textarea.selectionEnd,
      })
      const nextCaretPosition = textarea.selectionStart + trimmedText.length
      setValue(nextValue)
      autoResize()
      requestAnimationFrame(() => {
        textarea.selectionStart = nextCaretPosition
        textarea.selectionEnd = nextCaretPosition
      })
      return
    }

    if (!hasClipboardTextPayload(event.clipboardData)) {
      event.preventDefault()
    }
  }

  function handleAttachmentPreview(attachment: ComposerAttachment) {
    const target = classifyAttachmentPreview(attachment)
    if (target.openInNewTab) {
      if (typeof window !== "undefined") {
        window.open(new URL(attachment.contentUrl, window.location.origin).toString(), "_blank", "noopener,noreferrer")
      }
      return
    }

    setSelectedAttachmentId(attachment.id)
  }

  function removeAttachment(attachment: ComposerAttachment) {
    removedAttachmentIdsRef.current.add(attachment.id)
    setAttachments((current) => {
      const removed = current.find((item) => item.id === attachment.id)
      if (removed) cleanupAttachmentPreview(removed)
      return current.filter((item) => item.id !== attachment.id)
    })
    if (selectedAttachmentId === attachment.id) {
      setSelectedAttachmentId(null)
    }

    if (attachment.status === "uploaded") {
      removedAttachmentIdsRef.current.delete(attachment.id)
      void deleteUploadedAttachment(attachment)
    }
  }

  return (
    <div>
      {!chatId ? <FirstRunCallout /> : null}
      <div className={cn("px-3 pb-3 pt-0", isStandalone && "px-5 pb-5")}>
        <div className="@container/composer relative mx-auto max-w-[800px]">
          {/* One card holds the draft and every control that shapes the turn. */}
          <div
            className="relative z-[1] rounded-2xl bg-card shadow-composer transition-shadow focus-within:shadow-[0_0_0_1px_hsl(var(--foreground)/0.22),0_1px_2px_hsl(var(--foreground)/0.04),0_14px_30px_-14px_hsl(var(--foreground)/0.18)]"
            // Inside a chat the whole page is the drop target; the landing page has only this card.
            {...(chatId ? {} : {
              onDragEnter: (event: React.DragEvent) => {
                if (disabled || !hasFileDragTypes(event.dataTransfer.types)) return
                event.preventDefault()
                composerDragDepthRef.current += 1
                setIsFileDragOver(true)
              },
              onDragOver: (event: React.DragEvent) => {
                if (disabled || !hasFileDragTypes(event.dataTransfer.types)) return
                event.preventDefault()
                event.dataTransfer.dropEffect = "copy"
              },
              onDragLeave: () => {
                composerDragDepthRef.current = Math.max(0, composerDragDepthRef.current - 1)
                if (composerDragDepthRef.current === 0) setIsFileDragOver(false)
              },
              onDrop: (event: React.DragEvent) => {
                if (disabled || !hasFileDragTypes(event.dataTransfer.types)) return
                event.preventDefault()
                composerDragDepthRef.current = 0
                setIsFileDragOver(false)
                const files = [...event.dataTransfer.files]
                if (files.length > 0) enqueueFiles(files)
              },
            })}
          >
            {isFileDragOver ? (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-2xl border border-dashed border-foreground/30 bg-card/90 text-[13px] text-muted-foreground backdrop-blur-sm">
                <Paperclip className="size-4" />
                {t("chat:dropFilesToAttach")}
              </div>
            ) : null}
            {attachments.length > 0 ? (
              <ScrollArea className="overflow-x-auto overflow-y-hidden whitespace-nowrap rounded-t-2xl px-3 pt-1">
                <div className="flex items-end gap-2 pt-2">
                  {orderedAttachments.map((attachment) => (
                    <div
                      key={attachment.id}
                      className={cn("flex shrink-0 flex-col justify-end", attachment.status === "failed" && "text-destructive")}
                    >
                      {attachment.kind === "image" ? (
                        <AttachmentImageCard
                          attachment={attachment}
                          previewUrl={attachment.previewUrl}
                          size="composer"
                          onClick={attachment.status === "uploaded" ? () => handleAttachmentPreview(attachment) : undefined}
                          onRemove={() => removeAttachment(attachment)}
                        />
                      ) : (
                        <AttachmentFileCard
                          attachment={attachment}
                          onClick={attachment.status === "uploaded" ? () => handleAttachmentPreview(attachment) : undefined}
                          onRemove={() => removeAttachment(attachment)}
                        />
                      )}
                    </div>
                  ))}
                </div>
              </ScrollArea>
            ) : null}
            {slashMatch ? (
              <div
                ref={slashListRef}
                style={{ maxHeight: slashListMaxHeight }}
                className="absolute bottom-full left-2 right-2 z-20 mb-2 overflow-y-auto rounded-2xl border border-border bg-background shadow-lg"
              >
                {slashMatch.matches.map((command, i) => (
                  <button
                    key={command}
                    type="button"
                    // pointerdown (not click) so the textarea keeps focus
                    onPointerDown={(event) => {
                      event.preventDefault()
                      applySlashCommand(command)
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-2 text-left text-sm",
                      i === activeSlashIndex ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60",
                    )}
                  >
                    <span className="font-mono">/{command}</span>
                  </button>
                ))}
              </div>
            ) : null}
            <Textarea
              ref={setTextareaRefs}
              placeholder={t("chat:buildSomething")}
              value={value}
              autoFocus
              {...{ [CHAT_INPUT_ATTRIBUTE]: "" }}
              rows={1}
              onChange={(event) => {
                setValue(event.target.value)
                setSlashIndex(0)
                setSlashDismissed(false)
                autoResize()
              }}
              onPaste={handlePaste}
              onKeyDown={handleKeyDown}
              disabled={disabled}
              className="block w-full resize-none border-0 bg-transparent px-4 pb-1 pt-3.5 text-base leading-6 shadow-none outline-none max-h-[240px] min-h-[52px] placeholder:text-muted-foreground/70"
            />
            <div className="flex items-center gap-0.5 px-2 pb-2">
              <label
                aria-label={t("chat:addAttachment")}
                title={t("chat:attachFilesOrDragThemIn")}
                className={cn(
                  "relative flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.08]",
                  disabled && "pointer-events-none opacity-50",
                )}
              >
                <Plus className="size-[18px]" />
                <input
                  type="file"
                  multiple
                  disabled={disabled}
                  aria-label={t("chat:addAttachment")}
                  className="absolute inset-0 cursor-pointer opacity-0"
                  onChange={(event) => {
                    const files = [...(event.target.files ?? [])]
                    if (files.length > 0) {
                      enqueueFiles(files)
                    }
                    event.target.value = ""
                  }}
                />
              </label>
              {/* Stays outside the scrolling chips: the memory state must always be in view. */}
              <MemoryToggle chatId={chatId} />
              <div className="flex min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                <ChatPreferenceControls
                  className="ml-auto w-max md:justify-end"
                  availableProviders={availableProviders}
                  selectedProvider={selectedProvider}
                  providerLocked={providerLocked}
                  showCodexCliRequirementHints
                  model={providerPrefs.model}
                  modelOptions={providerPrefs.modelOptions}
                  onProviderChange={(provider) => {
                    if (providerLocked) return
                    resetChatComposerFromProvider(composerChatId, provider)
                  }}
                  connectionId={providerPrefs.connectionId}
                  onModelChange={(_, model, connectionId) => {
                    updateComposerState(state => ({ ...withNormalizedContextWindow(state, model), connectionId }))
                  }}
                  onModelOptionChange={(change) => {
                    switch (change.type) {
                      case "claudeReasoningEffort":
                        setReasoningEffort(change.effort)
                        break
                      case "codexReasoningEffort":
                        setReasoningEffort(change.effort)
                        break
                      case "piReasoningEffort":
                        setReasoningEffort(change.effort)
                        break
                      case "contextWindow":
                        setClaudeContextWindow(change.contextWindow)
                        break
                      case "fastMode":
                        updateComposerState(
                          (state) => state.provider === "claude"
                            ? state
                            : state.provider === "codex"
                              ? { ...state, modelOptions: { ...state.modelOptions, fastMode: change.fastMode } }
                              : state
                        )
                        break
                    }
                  }}
                  planMode={providerPrefs.planMode}
                  onPlanModeChange={setEffectivePlanMode}
                  includePlanMode={showPlanMode}
                />
                {chatId && matchingHarness && onExecutionPolicyChange ? (
                  <ExecutionPolicyControl chatId={chatId} snapshot={matchingHarness} disabled={disabled} onChange={changeExecutionPolicy} />
                ) : null}
              </div>
              {activeContextWindow ? (
                <div className="flex shrink-0 items-center px-1">
                  <ContextWindowMeter usage={activeContextWindow} />
                </div>
              ) : null}
              <Button
                type="button"
                aria-label={canCancel && !hasTextToSend ? t("common:cancel") : t("common:send")}
                onPointerDown={(event) => {
                  event.preventDefault()
                  if (!disabled && hasTextToSend && !hasPendingUploads) {
                    void handleSubmit()
                  } else if (canCancel) {
                    onCancel?.()
                  } else if (!disabled && canSubmit && !hasPendingUploads) {
                    void handleSubmit()
                  }
                }}
                disabled={disabled || (!canCancel && !canSubmit) || hasPendingUploads}
                size="icon"
                className="ml-1 size-8 shrink-0 cursor-pointer touch-manipulation rounded-full border-0 bg-primary text-primary-foreground hover:bg-primary/85 disabled:bg-foreground/[0.08] disabled:text-muted-foreground disabled:opacity-100"
              >
                {hasTextToSend ? (
                  <ArrowUp className="size-[18px]" />
                ) : canCancel ? (
                  <div className="size-2.5 rounded-[2px] bg-current" />
                ) : (
                  <ArrowUp className="size-[18px]" />
                )}
              </Button>
            </div>
          </div>

          {/* The tray behind the card: where this chat will run. */}
          {leadingControls ? (
            <div className="-mt-3 flex items-center gap-0.5 overflow-x-auto rounded-b-2xl bg-muted px-2 pb-1.5 pt-[18px] shadow-[inset_0_0_0_1px_hsl(var(--border))] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {leadingControls}
            </div>
          ) : null}
        </div>

        {uploadError ? (
          <div className="max-w-[800px] mx-auto mt-2 px-1 text-sm text-destructive">
            {uploadError}
          </div>
        ) : null}
      </div>

      <AttachmentPreviewModal attachment={selectedAttachment} onOpenChange={(open) => !open && setSelectedAttachmentId(null)} />
    </div>
  )
})

export const ChatInput = memo(ChatInputInner)

async function deleteUploadedAttachment(attachment: ChatAttachment) {
  if (!attachment.contentUrl) return
  const deleteUrl = attachment.contentUrl.replace(/\/content$/, "")
  await fetch(deleteUrl, { method: "DELETE" }).catch(() => undefined)
}

function hydrateComposerAttachments(attachments: ChatAttachment[]): ComposerAttachment[] {
  return attachments.map((attachment) => ({
    ...attachment,
    status: "uploaded" as const,
  }))
}
