import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react"
import { ArrowUp, Paperclip } from "lucide-react"
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
import { Button, buttonVariants } from "../ui/button"
import { Textarea } from "../ui/textarea"
import { ScrollArea } from "../ui/scroll-area"
import { cn, generateUUID } from "../../lib/utils"
import { isImeComposingKeyEvent } from "../../lib/imeKeys"
import { matchSlashCommands, SLASH_POPUP_MAX_HEIGHT_PX, slashPopupMaxHeightPx } from "../../lib/slashCommands"
import { useSlashCommandsStore } from "../../stores/slashCommandsStore"
import { useIsStandalone } from "../../hooks/useIsStandalone"
import { useChatInputStore } from "../../stores/chatInputStore"
import { runRetainedDraftSubmission } from "./chatDraftSubmission"
import { NEW_CHAT_COMPOSER_ID, type ComposerState, useChatPreferencesStore } from "../../stores/chatPreferencesStore"
import { CHAT_INPUT_ATTRIBUTE, focusNextChatInput } from "../../app/chatFocusPolicy"
import { ChatPreferenceControls } from "./ChatPreferenceControls"
import { ContextWindowMeter } from "./ContextWindowMeter"
import {
  settleServerOwnedStudyPromptDraft,
  subscribeStudyPromptServerOwnership,
} from "../../app/study/studyPromptIntercept"
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
    options?: { provider?: AgentProvider; model?: string; modelOptions?: ModelOptions; planMode?: boolean; attachments?: ChatAttachment[] }
  ) => Promise<void>
  onLayoutChange?: () => void
  onCancel?: () => void
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
  leadingControls = null,
}, forwardedRef) {
  const {
    getDraft,
    setDraft,
    clearDraft,
    getAttachmentDrafts,
    setAttachmentDrafts,
    clearAttachmentDrafts,
  } = useChatInputStore()
  const {
    providerDefaults,
    getComposerState,
    initializeComposerForChat,
    setChatComposerModel,
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
  const providerPrefs = getEffectiveComposerState(composerState, activeProvider, providerDefaults)
  const selectedProvider = providerLocked ? activeProvider : composerState.provider
  const providerConfig = availableProviders.find((provider) => provider.id === selectedProvider) ?? availableProviders[0]
  const showPlanMode = providerConfig?.supportsPlanMode ?? false
  const activeContextWindow = useMemo(() => {
    if (providerPrefs.provider !== "claude") {
      return contextWindowSnapshot
    }

    const claudeModelOptions = providerPrefs.modelOptions as Extract<ComposerState, { provider: "claude" }>["modelOptions"]
    const stagedMaxTokens = resolveClaudeContextWindowTokens(
      normalizeClaudeContextWindow(providerPrefs.model, claudeModelOptions.contextWindow),
    )
    return overrideContextWindowMaxTokens(contextWindowSnapshot, stagedMaxTokens)
  }, [contextWindowSnapshot, providerPrefs.model, providerPrefs.modelOptions, providerPrefs.provider])
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

  useEffect(() => {
    if (!chatId) return
    return subscribeStudyPromptServerOwnership(chatId, (ownership) => {
      const getCurrent = () => ({
        content: useChatInputStore.getState().getDraft(chatId),
        attachments: attachmentsRef.current.map(
          ({ previewUrl: _previewUrl, status: _status, ...attachment }) => attachment,
        ),
      })
      void settleServerOwnedStudyPromptDraft({
        promptHash: ownership.promptHash,
        getCurrent,
        clear: (matched) => {
          // The helper re-read this exact snapshot after hashing, so a draft
          // typed while the delayed Board response arrived is left untouched.
          setValue((current) => current === matched.content ? "" : current)
          clearDraft(chatId)
          clearAttachments()
          clearAttachmentDrafts(chatId)
          if (textareaRef.current) textareaRef.current.style.height = "auto"
        },
      })
    })
  }, [chatId, clearAttachmentDrafts, clearAttachments, clearDraft, setValue])

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
            throw new Error(typeof payload.error === "string" ? payload.error : "Upload failed")
          }

          const payload = await response.json() as { attachments: ChatAttachment[] }
          const uploaded = payload.attachments[0]
          if (!uploaded) {
            throw new Error("Upload failed")
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
  }, [projectId, setAttachments])

  const enqueueFiles = useCallback((files: File[]) => {
    if (!projectId) {
      setUploadError("Open a project before uploading files.")
      return
    }

    if (willExceedAttachmentLimit({
      currentAttachmentCount: attachmentsRef.current.length,
      queuedAttachmentCount: uploadQueueRef.current.length,
      incomingAttachmentCount: files.length,
    })) {
      setUploadError(`You can upload up to ${MAX_FILES_PER_DROP} files at a time.`)
      return
    }

    uploadQueueRef.current.push(...files)
    setUploadError(null)
    processUploadQueue()
  }, [processUploadQueue, projectId])

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

  async function handleSubmit() {
    if (!canSubmit || hasPendingUploads || submissionRef.current) return

    const submission = {}
    submissionRef.current = submission
    const revision = draftRevisionRef.current
    const ownsDraft = () => submissionRef.current === submission && draftRevisionRef.current === revision
    const persistedRevision = useChatInputStore.getState().getDraftRevision(textDraftKey, chatId ?? null)
    const nextValue = value
    const previousAttachments = attachmentsRef.current
    const attachmentsForSubmit = uploadedAttachments.map(({ previewUrl: _previewUrl, status: _status, ...attachment }) => attachment)
    let modelOptions: ModelOptions
    if (providerPrefs.provider === "claude") {
      modelOptions = { claude: { ...providerPrefs.modelOptions } }
    } else if (providerPrefs.provider === "pi") {
      modelOptions = { pi: { ...providerPrefs.modelOptions } }
    } else {
      modelOptions = { codex: { ...providerPrefs.modelOptions } }
    }
    const submitOptions = {
      provider: selectedProvider,
      model: providerPrefs.model,
      modelOptions,
      planMode: showPlanMode ? providerPrefs.planMode : false,
      attachments: attachmentsForSubmit,
    }
    // The opening Long-term Memory Board may hold this Promise for minutes.
    // Keep both local and persisted drafts intact until the *real* send is
    // accepted, so reload/back/send failure cannot erase participant input.
    await runRetainedDraftSubmission({
      submit: () => onSubmit(nextValue, submitOptions),
      onAccepted: () => {
        if (submissionRef.current === submission && !ownsDraft()) return
        if (!useChatInputStore.getState().clearSubmittedDraft(persistedRevision)) return
        if (!ownsDraft()) return
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
    if (event.key === "Enter" && !event.shiftKey && !isTouchDevice && !disabled && hasTextToSend && !hasPendingUploads) {
      event.preventDefault()
      void handleSubmit()
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
      <div className={cn("px-3 pt-0", isStandalone && "px-5")}>
        <div className="max-w-[840px] mx-auto rounded-[32px]">
          {attachments.length > 0 ? (
            <ScrollArea className="overflow-x-auto overflow-y-hidden whitespace-nowrap px-2 pb-2">
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

          <div className="relative flex items-end max-w-[840px] mx-auto border dark:bg-card/40 backdrop-blur-lg border-border rounded-[29px] pr-1.5">
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
            <label
              aria-label="Add attachment"
              title="Attach files (or drag them in)"
              className={cn(
                buttonVariants({ variant: "ghost", size: "icon" }),
                "relative flex-shrink-0 ml-1.5 mb-1 md:mb-2 h-10 w-10 rounded-full text-muted-foreground hover:text-foreground",
                disabled && "pointer-events-none opacity-50",
              )}
            >
              <Paperclip className="h-5 w-5" />
              <input
                type="file"
                multiple
                disabled={disabled}
                aria-label="Add attachment"
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
            <Textarea
              ref={setTextareaRefs}
              placeholder="Build something..."
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
              className="flex-1 text-base p-3 md:p-4 !pr-2 pl-1 md:pl-1.5 resize-none max-h-[200px] outline-none bg-transparent border-0 shadow-none"
            />
            <Button
              type="button"
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
              className="flex-shrink-0 bg-slate-600 text-white dark:bg-white dark:text-slate-900 rounded-full cursor-pointer h-10 w-10 md:h-11 md:w-11 mb-1 -mr-0.5 md:mr-0 md:mb-1.5 touch-manipulation disabled:bg-white/60 disabled:text-slate-700"
            >
              {hasTextToSend ? (
                <ArrowUp className="h-5 w-5 md:h-6 md:w-6" />
              ) : canCancel ? (
                <div className="w-3 h-3 md:w-4 md:h-4 rounded-xs bg-current" />
              ) : (
                <ArrowUp className="h-5 w-5 md:h-6 md:w-6" />
              )}
            </Button>
          </div>
        </div>

        {uploadError ? (
          <div className="max-w-[840px] mx-auto mt-2 px-1 text-sm text-destructive">
            {uploadError}
          </div>
        ) : null}
      </div>

      <div className={cn("relative py-3 max-w-[840px] mx-auto", isStandalone && "p-5 pt-3")}>
        <div className="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden flex flex-row">
          <div className="min-w-3" />
          {/* One mx-auto group so leading chips and preference chips center TOGETHER — no gap between them. */}
          <div className="mx-auto flex shrink-0 items-center gap-0.5">
          {leadingControls}
          <ChatPreferenceControls
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
            onModelChange={(_, model) => {
              if (providerLocked) {
                updateComposerState((state) => withNormalizedContextWindow(state, model))
                return
              }
              setChatComposerModel(composerChatId, model)
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
          </div>
          {activeContextWindow ? (
            <div className="flex items-center md:hidden mx-[13px]">
              <ContextWindowMeter usage={activeContextWindow} />
            </div>
          ) : null}
          <div className="min-w-3" />
        </div>

        {activeContextWindow ? (
          <div className="absolute right-[29px] top-1/2 translate-x-1/2 -translate-y-1/2 hidden md:block">
            <ContextWindowMeter usage={activeContextWindow} />
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
