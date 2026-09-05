import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { ArrowLeft, ArrowRight } from "lucide-react"
import { PROVIDERS } from "../../../shared/types"
import { Button } from "../../components/ui/button"
import { ChatInput, type ChatInputHandle } from "../../components/chat-ui/ChatInput"
import { BrowserPanel } from "../../components/chat-ui/BrowserPanel"
import { ChatNavbar } from "../../components/chat-ui/ChatNavbar"
import { FilesPanel } from "../../components/chat-ui/FilesPanel"
import { SessionMemoriesPanel } from "../../components/memory-chat/SessionMemoriesPanel"
import { MemorySummaryPanel } from "../../components/memory-chat/MemorySummaryPanel"
import { StaticMemoryPanel } from "../../components/memory-chat/StaticMemoryPanel"
import { OpenLocalLinkProvider, TurnInterruptContext, type TurnInterruptApi } from "../../components/messages/shared"
import {
  TranscriptChatContextProvider,
  TranscriptRenderOptionsProvider,
  ViolatedCitationsMapProvider,
  type PreviewDemoDecision,
  type PreviewDemoOptions,
} from "../../components/messages/render-context"
import { ProcessingMessage } from "../../components/messages/ProcessingMessage"
import { StreamingAssistantText } from "../../components/messages/StreamingAssistantText"
import { setUiMonitorSuppressed } from "../../lib/memoriesApi"
import { processTranscriptMessages } from "../../lib/parseTranscript"
import { buildViolatedCitationsByMessageId } from "../../lib/violatedCitations"
import { cn } from "../../lib/utils"
import { useRightSidebarStore } from "../../stores/rightSidebarStore"
import { buildResolvedTranscriptRows, ChatTranscriptRow } from "../ChatTranscript"
import { MemoryBoardPage } from "../MemoryBoardPage"
import { MemoryBoardOverlay } from "../study/StudyBoardGate"
import { StudyIndexPage } from "../study/StudyTaskPage"
import { StudySessionStartSurface } from "../study/StudySessionStartSurface"
import { StudyDock } from "../study/StudyDock"
import { ProtectedStudyInstructions } from "../study/ProtectedStudyInstructions"
import { MemoryBoardLauncherProvider, type MemoryBoardLaunchRequest } from "../study/MemoryBoardLauncher"
import { createHeldStudyPrompt, type HeldStudyPrompt } from "../study/studyPromptIntercept"
import { DEMO_MEMORY_ITEMS, GUIDE_DEMO_PROMPT, type GuideScene } from "./guideScenes"
import {
  GUIDE_BROWSER_DEMO_DOCUMENT,
  GUIDE_CHAT_ID,
  GUIDE_PROJECT_ID,
  guideDemoSocket,
  installGuideFetchShim,
  type GuideFetchShimController,
} from "./guideDemoWorkspace"
import { installGuideMemorySandbox } from "./guideMemorySandbox"
import {
  applyGuideLocalTurn,
  createGuideLocalTurnState,
  reduceGuideLocalTurn,
  type GuideLocalTurnAction,
  type GuideLocalTurnState,
} from "./guideLocalTurn"
import { GUIDE_BOARD_CANDIDATE_DEMO, type GuideBoardDemo } from "./guideBoardDemo"
import { resolveGuideCandidateJourneyDecision } from "./guideCandidateJourney"
import { GuidePostSessionJourney, type GuidePostSessionPhase } from "./GuidePostSessionJourney"
import { GuidePanelSurface } from "./GuidePanelSurface"
import { createGuideFlowState, reduceGuideFlow, type GuideFlowEvent } from "./guideFlow"
import {
  createGuideNavigation,
  currentGuideStepId,
  guidePrimaryAction,
  guideSectionProgress,
  reduceGuideNavigation,
  type GuideNavigationEvent,
} from "./guideNavigation"

/**
 * A step's spotlight target inside the demo surface. Single rows are
 * addressed by their entry id (TOUR_ANCHORS); grouped rows (tool runs, the
 * memory review flow) by row kind + occurrence index; sub-elements of a card
 * by a stable data-attribute selector; the side panel and composer directly.
 */
export type TourTarget =
  | { rowId: string }
  | { rowKind: "tool-group" | "memory-changes-review"; nth?: number }
  | { composer: true }
  | { css: string }
  | { panel: true }

export type TourPanel = "memoryRecord" | "autoMemory" | "staticMemory" | "browser" | "files" | "board" | "studySessionSetup" | "studySessions" | "studyBrief" | "studySubmit" | "studyPostSession"

export const GUIDE_CHAPTERS = [
  {
    id: "system_use",
    label: "System use",
    description: "Practice a session chat, the condition interface, Browser, and Files.",
  },
  {
    id: "experiment_workflow",
    label: "Task & submission",
    description: "Review task instructions, Finish, and every post-session form.",
  },
] as const

export type GuideChapter = (typeof GUIDE_CHAPTERS)[number]["id"]

export function GuideChapterHeading({
  chapter,
  currentStep,
  totalSteps,
}: {
  chapter: GuideChapter
  currentStep: number
  totalSteps: number
}) {
  const index = GUIDE_CHAPTERS.findIndex((entry) => entry.id === chapter)
  const current = GUIDE_CHAPTERS[index] ?? GUIDE_CHAPTERS[0]
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex shrink-0 rounded-full bg-muted px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
            Section {index + 1} of {GUIDE_CHAPTERS.length}
          </span>
          <span className="truncate text-sm font-semibold text-foreground">{current.label}</span>
        </div>
        <span className="shrink-0 rounded-full border border-border bg-background px-2.5 py-1 text-[11px] font-medium tabular-nums text-muted-foreground">
          Step {currentStep} of {totalSteps}
        </span>
      </div>
      <p className="text-pretty text-sm leading-relaxed text-muted-foreground">
        {current.description}
      </p>
    </div>
  )
}

export function GuideSectionTabs({
  active,
  onSelect,
}: {
  active: GuideChapter
  onSelect: (chapter: GuideChapter) => void
}) {
  return (
    <div
      role="tablist"
      aria-label="Guide sections"
      className="grid grid-cols-2 gap-1 rounded-xl border border-border bg-muted/35 p-1"
    >
      {GUIDE_CHAPTERS.map((chapter) => {
        const selected = chapter.id === active
        return (
          <button
            key={chapter.id}
            id={"guide-tab-" + chapter.id}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={"guide-panel-" + chapter.id}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(chapter.id)}
            className={cn(
              "rounded-lg px-3 py-2 text-left text-xs font-medium transition-colors",
              selected
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {chapter.label}
          </button>
        )
      })}
    </div>
  )
}

export interface TourStep {
  /** Stable navigation and test identity. Copy edits must not change this value. */
  id: string
  chapter: GuideChapter
  /** True only when all three conditions receive this exact lesson/UI contract. */
  sharedAcrossConditions: boolean
  title: string
  /** Short paragraphs, hand-holding tone. */
  body: ReactNode
  /** The conversation at this step's moment — advances with the clicks. */
  scene: GuideScene
  target?: TourTarget
  /**
   * Transcript rows become clickable on this step. The mounted production
   * controls are routed to Guide-local reducers and the fetch sandbox.
   */
  interactive?: boolean
  /** Real side surface rendered next to the conversation ("board" replaces it). */
  panel?: TourPanel
  /** Permit this one panel step to exercise navigation without unlocking adjacent steps. */
  panelInteractive?: boolean
  /** Injection-preview card demo state while this step is shown. */
  previewDemo?: PreviewDemoOptions
  /** Timed progression (mentor 2026-08-15): show `scene` first, then swap to
   * this one — the "it ran for a moment, then the result landed" beat. */
  reveal?: { afterMs: number; scene: GuideScene }
  /** Arm the per-memory interrupt affordance on this step's chips; the demo
   * interrupt advances to the next step (the recovery card). */
  interruptDemo?: boolean
  /** Show the real interrupt affordance as a read-only illustration. */
  interruptPreview?: boolean
  /** Session-start Board state demonstrated by the real blocking overlay. */
  boardDemo?: GuideBoardDemo
  /** One production post-session surface, hosted by the Guide's local journey. */
  postSessionPhase?: GuidePostSessionPhase
}

export interface GuideManualBoardOverlayProps {
  request: MemoryBoardLaunchRequest
  boardSnapshot: GuideBoardDemo["status"] | null
  onBacklogChanged: () => void
  onDismiss: () => void
}

/** One close boundary for the optional Board. Candidate station progress owns
 * Guide navigation; closing this overlay only returns to the same lesson. */
export function GuideManualBoardOverlay({
  request,
  boardSnapshot,
  onBacklogChanged,
  onDismiss,
}: GuideManualBoardOverlayProps) {
  return (
    <MemoryBoardOverlay
      embedded
      blocking={false}
      taskId="038-S2"
      chatId={request.chatId ?? GUIDE_CHAT_ID}
      status={boardSnapshot ?? undefined}
      focusedReview={request.focusedReview}
      onClose={onDismiss}
      onBacklogChanged={onBacklogChanged}
    />
  )
}

const NO_TOOL_IDS = { AskUserQuestion: null, ExitPlanMode: null, TodoWrite: null }
const CLAUDE_PROVIDERS = PROVIDERS.filter((provider) => provider.id === "claude")

function withFirstPrompt(scene: GuideScene, prompt: string | undefined): GuideScene {
  if (!prompt) return scene
  let replaced = false
  return {
    ...scene,
    entries: scene.entries.map((entry) => {
      if (entry.kind === "memory_preview") return { ...entry, task: prompt }
      if (entry.kind === "memory_interrupt") return { ...entry, prompt }
      if (!replaced && entry.kind === "user_prompt") {
        replaced = true
        return { ...entry, content: prompt }
      }
      return entry
    }),
  }
}

type GuideResumeArgs = Omit<Parameters<TurnInterruptApi["resume"]>[0], "action" | "correction"> & {
  correction: string
}

export function withResumeDecision(scene: GuideScene, resolution: GuideResumeArgs | null): GuideScene {
  if (!resolution) return scene
  return {
    ...scene,
    entries: scene.entries.map((entry) => entry.kind === "memory_interrupt_resolution"
      ? {
          ...entry,
          correction: resolution.correction,
          selectedIds: [...resolution.selectedIds],
          enforced: resolution.enforce,
        }
      : entry),
  }
}

// Panels that are always interactive when mounted. Browser steps opt in
// individually; Board overlays own their local interaction policy.
const INTERACTIVE_PANELS: ReadonlySet<TourPanel> = new Set([
  "memoryRecord",
  "autoMemory",
  "staticMemory",
  "files",
  "studySessionSetup",
])

const CANDIDATE_JOURNEY_STEPS = new Set([
  "memosync.long-term-card",
  "memosync.candidate-summary",
  "memosync.candidate-reopened",
  "memosync.board-library",
])

function targetSelector(target: TourTarget): { selector: string; nth: number } {
  if ("composer" in target) return { selector: '[data-guide-composer="true"]', nth: 0 }
  if ("panel" in target) return { selector: '[data-guide-panel="true"]', nth: 0 }
  if ("css" in target) return { selector: target.css, nth: 0 }
  if ("rowId" in target) return { selector: `[data-guide-row-id="${target.rowId}"]`, nth: 0 }
  return { selector: `[data-guide-row-kind="${target.rowKind}"]`, nth: target.nth ?? 0 }
}

/**
 * Guide-local adapter for the production transcript context. Keeping the demo
 * identity in one place lets Candidate actions exercise the same scope guards
 * as a real chat without ever touching participant state.
 */
export function GuideTranscriptContextProvider({ children }: { children: ReactNode }) {
  return (
    <TranscriptChatContextProvider value={{ chatId: GUIDE_CHAT_ID, projectId: GUIDE_PROJECT_ID }}>
      {children}
    </TranscriptChatContextProvider>
  )
}

export function GuidePrimaryButton({
  label,
  showArrow,
  onClick,
}: {
  label: string
  showArrow: boolean
  onClick: () => void
}) {
  return (
    <Button onClick={onClick} className="gap-1.5">
      {label}
      {showArrow ? <ArrowRight className="h-4 w-4" /> : null}
    </Button>
  )
}

/**
 * The interactive walkthrough: the demo conversation on the left advances
 * with the participant's clicks (no autoplay — each step shows the turn at
 * one real moment, gates open exactly like live usage), the Step-N-of-M
 * panel on the right, and a spotlight that dims everything except the
 * element the current step talks about. Steps can open the real side panels
 * (Memory Record, Browser, Files) and the Memory Board, all rendered by the
 * production components against demo data.
 */
export function GuideTour({
  brandName,
  steps,
  onFinish,
  onSkip,
}: {
  brandName: string
  steps: TourStep[]
  onFinish: () => void
  onSkip?: () => void
}) {
  const [navigation, setNavigation] = useState(() => createGuideNavigation(steps))
  const [flow, setFlow] = useState(createGuideFlowState)
  const areaRef = useRef<HTMLDivElement | null>(null)
  const paneRef = useRef<HTMLDivElement | null>(null)
  const [spot, setSpot] = useState<{ top: number; left: number; width: number; height: number } | null>(null)
  const [demoReady, setDemoReady] = useState(false)
  const memorySandboxRef = useRef<ReturnType<typeof installGuideMemorySandbox> | null>(null)
  const fetchShimRef = useRef<GuideFetchShimController | null>(null)
  const boardFixtureKeyRef = useRef<string | null>(null)
  const [boardSnapshot, setBoardSnapshot] = useState<GuideBoardDemo["status"] | null>(null)
  const [manualBoard, setManualBoard] = useState<MemoryBoardLaunchRequest | null>(null)
  const [resumeDecision, setResumeDecision] = useState<GuideResumeArgs | null>(null)
  const chatInputRef = useRef<ChatInputHandle | null>(null)
  const heldPromptRef = useRef<HeldStudyPrompt | null>(null)
  const [localTurn, setLocalTurn] = useState<{ stepId: string; state: GuideLocalTurnState } | null>(null)

  const dispatchNavigation = useCallback((event: GuideNavigationEvent) => {
    setNavigation((current) => reduceGuideNavigation(current, event, steps))
  }, [steps])
  const dispatchFlow = useCallback((event: GuideFlowEvent) => {
    setFlow((current) => reduceGuideFlow(current, event))
  }, [])
  const activeStepId = currentGuideStepId(navigation, steps)
  const step = steps.find((candidate) => candidate.id === activeStepId)
  const sectionProgress = guideSectionProgress(navigation, steps)
  const sectionSteps = steps.filter((candidate) => candidate.chapter === navigation.activeSection)
  const stepIndex = Math.max(0, sectionSteps.findIndex((candidate) => candidate.id === activeStepId))
  const isLast = sectionProgress.isLast

  // Tour-wide demo plumbing: UI-monitoring beacons stay muted (tour clicks
  // must never count as study monitoring acts). Install the isolated memory
  // store and local HTTP shim before production panels mount.
  useLayoutEffect(() => {
    setUiMonitorSuppressed(true)
    const uninstallMemorySandbox = installGuideMemorySandbox()
    memorySandboxRef.current = uninstallMemorySandbox
    const uninstallShim = installGuideFetchShim()
    fetchShimRef.current = uninstallShim
    const unsubscribeBoard = uninstallShim.subscribeBoard((snapshot) => {
      setBoardSnapshot(snapshot.status)
      uninstallMemorySandbox.setItems(snapshot.items)
      setFlow((current) => reduceGuideFlow(current, {
        type: "board_pending_changed",
        pending: snapshot.status.pending,
      }))
    })
    // A repeated tutorial always begins at Browser Home, never at a persisted
    // address from a previous guide attempt.
    useRightSidebarStore.getState().navigateBrowser(GUIDE_PROJECT_ID, "")
    setDemoReady(true)
    return () => {
      uninstallShim()
      unsubscribeBoard()
      uninstallMemorySandbox()
      memorySandboxRef.current = null
      fetchShimRef.current = null
      heldPromptRef.current?.abandon()
      heldPromptRef.current = null
      setUiMonitorSuppressed(false)
    }
  }, [])

  // A blocking Board lesson needs two server-like states: unresolved rows,
  // then the exact same production overlay after the collection is clear.
  // Only the isolated Guide store changes; the real participant snapshot is
  // kept aside and restored when the tutorial unmounts.
  useEffect(() => {
    if (!demoReady) return
    if (step?.boardDemo) {
      if (boardFixtureKeyRef.current !== step.id) {
        boardFixtureKeyRef.current = step.id
        fetchShimRef.current?.setBoardDemo(step.boardDemo)
      }
      if (step.id === "memosync.opening-board") {
        dispatchFlow({ type: "board_review_opened", pending: step.boardDemo.status.pending })
      }
    } else if (
      step?.id === "memosync.long-term-card"
      && boardFixtureKeyRef.current !== "memosync.current-long-term-review"
    ) {
      boardFixtureKeyRef.current = "memosync.current-long-term-review"
      fetchShimRef.current?.setBoardDemo(GUIDE_BOARD_CANDIDATE_DEMO)
    } else if (step?.id && CANDIDATE_JOURNEY_STEPS.has(step.id)) {
      // Candidate actions are canonical store mutations. Preserve them through
      // the settled summary, Review again, and the one Board projection.
    } else {
      memorySandboxRef.current?.setItems(DEMO_MEMORY_ITEMS)
    }
  }, [demoReady, dispatchFlow, step?.boardDemo, step?.id])

  // Timed reveal: the base scene renders first; after the delay the step's
  // reveal scene replaces it (used by the Transfer step's run-then-finish beat).
  const [revealed, setRevealed] = useState(false)
  useEffect(() => {
    setRevealed(false)
    setManualBoard(null)
    if (!step?.reveal) return
    const timer = window.setTimeout(() => setRevealed(true), step.reveal.afterMs)
    return () => window.clearTimeout(timer)
  }, [step?.id, step])
  useEffect(() => {
    if (step?.id !== "system.first-prompt") return
    chatInputRef.current?.restoreText(GUIDE_DEMO_PROMPT)
  }, [step?.id])
  useEffect(() => {
    if (step?.id === "memosync.audit") dispatchFlow({ type: "turn_audited" })
  }, [dispatchFlow, step?.id])
  const baseScriptedScene = revealed && step?.reveal ? step.reveal.scene : step?.scene
  const scriptedScene = baseScriptedScene
    ? withResumeDecision(
        withFirstPrompt(baseScriptedScene, flow.firstPrompt?.text),
        resumeDecision,
      )
    : undefined
  const activeScene = scriptedScene && step && localTurn?.stepId === step.id
    ? applyGuideLocalTurn(scriptedScene, localTurn.state)
    : scriptedScene

  const applyLocalTurnAction = useCallback((action: GuideLocalTurnAction) => {
    setLocalTurn((current) => ({
      stepId: step?.id ?? "",
      state: reduceGuideLocalTurn(
        current && current.stepId === step?.id ? current.state : createGuideLocalTurnState(),
        action,
      ),
    }))
  }, [step?.id])

  const handlePreviewDemoDecision = useCallback((decision: PreviewDemoDecision) => {
    applyLocalTurnAction({
      type: "preview_decision",
      ...decision,
      createdAt: Date.now(),
    })
    if (decision.decision === "dismiss" && decision.prompt) {
      chatInputRef.current?.restoreText(decision.prompt)
      return
    }
    dispatchFlow({ type: "working_memory_confirmed" })
    dispatchNavigation({ type: "go_to_step", id: "memosync.streaming" })
  }, [applyLocalTurnAction, dispatchFlow, dispatchNavigation])

  const handleProposalsDecision = useCallback((proposalsId: string, decision: "reviewed" | "skipped") => {
    const decisionStep = step?.id === "memosync.long-term-card" || step?.id === "memosync.candidate-reopened"
      ? step.id
      : null
    if (decisionStep) {
      const resolution = resolveGuideCandidateJourneyDecision(decisionStep)
      applyLocalTurnAction({ type: "proposals_decision", proposalsId, decision, createdAt: Date.now() })
      dispatchNavigation({ type: "go_to_step", id: resolution.targetStepId })
      return
    }
    applyLocalTurnAction({ type: "proposals_decision", proposalsId, decision, createdAt: Date.now() })
    dispatchNavigation({
      type: "go_to_step",
      id: step?.id === "memosync.candidate-reopened"
        ? "memosync.board-library"
        : "memosync.candidate-summary",
    })
  }, [applyLocalTurnAction, dispatchNavigation, step?.id])

  const handleMemoryPreparationReopen = useCallback((from: "proposals" | "checkup" | "transfer") => {
    if (from !== "proposals") return
    dispatchNavigation({ type: "go_to_step", id: "memosync.candidate-reopened" })
  }, [dispatchNavigation])

  const handleTransferDecision = useCallback((transferId: string, decision: "handled" | "skipped") => {
    applyLocalTurnAction({ type: "transfer_decision", transferId, decision, createdAt: Date.now() })
    dispatchNavigation({ type: "go_to_step", id: "memosync.checkup" })
  }, [applyLocalTurnAction, dispatchNavigation])

  const handleCheckupDecision = useCallback((checkupId: string, decision: "handled" | "skipped") => {
    applyLocalTurnAction({ type: "checkup_decision", checkupId, decision, createdAt: Date.now() })
    dispatchFlow({ type: "long_term_review_completed" })
    dispatchNavigation({ type: "go_to_step", id: "memosync.working-memory-ask" })
  }, [applyLocalTurnAction, dispatchFlow, dispatchNavigation])

  // Interrupt demo: chips get their real stop entry; "stopping" simply walks
  // the tour forward to the recovery-card step.
  const interruptApi = useMemo<TurnInterruptApi | null>(() => {
    if (step?.interruptPreview) {
      return {
        active: true,
        readOnly: true,
        interrupt: () => undefined,
        resume: async () => {},
      }
    }
    if (step?.interruptDemo) {
      return {
        active: true,
        interrupt: () => {
          dispatchFlow({ type: "memory_interrupted" })
          dispatchFlow({ type: "recovery_opened" })
          dispatchNavigation({ type: "go_to_step", id: "memosync.recovery" })
        },
        resume: async () => {},
      }
    }
    if (step?.id === "memosync.recovery") {
      return {
        active: false,
        interrupt: () => undefined,
        resume: async (args) => {
          const correction = args.correction?.trim()
          if (!correction) return
          setResumeDecision({
            interruptId: args.interruptId,
            correction,
            selectedIds: [...args.selectedIds],
            enforce: args.enforce,
          })
          dispatchFlow({ type: "turn_resumed" })
          dispatchNavigation({ type: "go_to_step", id: "memosync.resumed" })
        },
      }
    }
    return null
  }, [dispatchFlow, dispatchNavigation, step?.id, step?.interruptDemo, step?.interruptPreview])

  const hydrated = useMemo(() => processTranscriptMessages(activeScene?.entries ?? []), [activeScene])
  const rows = useMemo(
    () => buildResolvedTranscriptRows(hydrated, { isLoading: false, latestToolIds: NO_TOOL_IDS }),
    [hydrated]
  )
  // Violated verdicts fold onto the reply's inline [M-NN] chips, exactly like
  // the live transcript — the violated-audit step depends on this.
  const violatedMap = useMemo(() => buildViolatedCitationsByMessageId(hydrated), [hydrated])

  const renderOptions = useMemo(() => ({
    readonly: false,
    localLinkMode: "text" as const,
    previewDemo: step?.previewDemo
      ? { ...step.previewDemo, onDecision: handlePreviewDemoDecision }
      : undefined,
  }), [handlePreviewDemoDecision, step?.previewDemo])

  // While a scene shows the assistant mid-work, the real composer shows its
  // stop square — the same control the step teaches.
  const composerCanCancel = Boolean(activeScene?.statusLabel)
  const handleLocalSubmit = useCallback(async (content: string) => {
    if (step?.id === "system.first-prompt") {
      const openingBoardExists = steps.some((candidate) => candidate.id === "memosync.opening-board")
      dispatchFlow({ type: "first_prompt_sent", prompt: content })
      if (openingBoardExists) {
        const held = createHeldStudyPrompt({
          content,
          dispatch: async () => undefined,
        })
        heldPromptRef.current = held
        dispatchNavigation({ type: "go_to_step", id: "memosync.opening-board" })
        await held.promise
        return
      }
      dispatchNavigation({ type: "next" })
      return
    }
    if (
      step?.id === "memosync.working-memory"
      && localTurn?.stepId === step.id
      && localTurn.state.restoredPrompt !== null
    ) {
      setLocalTurn(null)
      return
    }
    applyLocalTurnAction({
      type: "submit",
      content,
      steered: composerCanCancel,
      createdAt: Date.now(),
    })
  }, [applyLocalTurnAction, composerCanCancel, dispatchFlow, dispatchNavigation, localTurn, step?.id, steps])
  const handleLocalCancel = useCallback(() => {
    if (!composerCanCancel) return
    applyLocalTurnAction({ type: "stop", createdAt: Date.now() })
  }, [applyLocalTurnAction, composerCanCancel])
  const noop = useCallback(() => {}, [])
  const handleOpenMemoryBoard = useCallback((request: MemoryBoardLaunchRequest) => {
    setManualBoard(request)
  }, [])
  const handleBoardBacklogChanged = useCallback(() => {
    const snapshot = fetchShimRef.current?.getBoardDemo()
    if (!snapshot) return
    setBoardSnapshot(snapshot.status)
    dispatchFlow({ type: "board_pending_changed", pending: snapshot.status.pending })
  }, [dispatchFlow])
  const handleEnterAfterBoard = useCallback(async () => {
    const snapshot = fetchShimRef.current?.getBoardDemo()
    if (!snapshot || snapshot.status.pending.total !== 0) return
    dispatchFlow({ type: "board_pending_changed", pending: snapshot.status.pending })
    dispatchFlow({ type: "board_review_completed" })
    await heldPromptRef.current?.release()
    heldPromptRef.current = null
    dispatchNavigation({ type: "go_to_step", id: "memosync.long-term-card" })
  }, [dispatchFlow, dispatchNavigation])
  const handleStartGuideChat = useCallback(() => {
    dispatchFlow({ type: "new_chat" })
    dispatchNavigation({ type: "go_to_step", id: "system.empty-chat" })
  }, [dispatchFlow, dispatchNavigation])
  const handleOpenGuideBrowser = useCallback(() => {
    dispatchNavigation({ type: "go_to_step", id: "shared.browser-home" })
  }, [dispatchNavigation])

  const rowsInteractive = step?.interactive === true
  const panelInteractive = step?.panel !== undefined && (
    INTERACTIVE_PANELS.has(step.panel) || step.panelInteractive === true
  )

  // Measure the target inside the demo area; keep the hole glued to it
  // through scrolls and resizes. The overlay lives at the area level so it
  // can highlight the transcript, the side panel, or the composer alike.
  const measure = useCallback(() => {
    const area = areaRef.current
    const target = step?.target
    if (!area || !target) {
      setSpot(null)
      return
    }
    const { selector, nth } = targetSelector(target)
    const node = area.querySelectorAll<HTMLElement>(selector)[nth]
    if (!node) {
      setSpot(null)
      return
    }
    const areaRect = area.getBoundingClientRect()
    const rect = node.getBoundingClientRect()
    setSpot({
      top: rect.top - areaRect.top,
      left: rect.left - areaRect.left,
      width: rect.width,
      height: rect.height,
    })
  }, [step])

  useEffect(() => {
    const area = areaRef.current
    const pane = paneRef.current
    if (!area) return
    const target = step?.target
    if (target) {
      const { selector, nth } = targetSelector(target)
      const node = area.querySelectorAll<HTMLElement>(selector)[nth]
      node?.scrollIntoView({ block: "center", behavior: "smooth" })
    } else if (pane) {
      // No spotlight: follow the conversation like the live app does.
      pane.scrollTo({ top: pane.scrollHeight, behavior: "smooth" })
    }
    // After the smooth scroll settles; cheap enough to run twice.
    const timer = window.setTimeout(measure, 350)
    measure()
    const handle = () => measure()
    pane?.addEventListener("scroll", handle, { passive: true })
    window.addEventListener("resize", handle)
    return () => {
      window.clearTimeout(timer)
      pane?.removeEventListener("scroll", handle)
      window.removeEventListener("resize", handle)
    }
  }, [demoReady, measure, step])

  const sidePanel =
    step?.panel === "memoryRecord" ? (
      <SessionMemoriesPanel
        chatId={GUIDE_CHAT_ID}
        messages={hydrated}
        streamingText={activeScene?.streamingText ?? null}
        exposureInitiator="system"
      />
    ) : step?.panel === "autoMemory" ? (
      <MemorySummaryPanel chatId={GUIDE_CHAT_ID} projectId={GUIDE_PROJECT_ID} exposureInitiator="system" onClose={noop} />
    ) : step?.panel === "staticMemory" ? (
      <StaticMemoryPanel chatId={GUIDE_CHAT_ID} projectId={GUIDE_PROJECT_ID} exposureInitiator="system" onClose={noop} />
    ) : step?.panel === "browser" ? (
      <BrowserPanel
        projectId={GUIDE_PROJECT_ID}
        socket={guideDemoSocket}
        onClose={noop}
        onRunQuickAction={noop}
        previewDocument={GUIDE_BROWSER_DEMO_DOCUMENT}
      />
    ) : step?.panel === "files" ? (
      <FilesPanel projectId={GUIDE_PROJECT_ID} />
    ) : null

  if (!demoReady) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-background text-sm text-muted-foreground">
        Preparing tutorial…
      </div>
    )
  }

  if (!step) {
    return (
      <div className="fixed inset-0 z-50 grid place-items-center bg-background px-6 text-center">
        <div>
          <p className="text-sm text-muted-foreground">This Guide section has no available steps.</p>
          <Button className="mt-4" onClick={onFinish}>Close Guide</Button>
        </div>
      </div>
    )
  }

  const boundaryAction = guidePrimaryAction(navigation, steps)
  const primaryLabel = boundaryAction === "advance"
    ? "Next"
    : boundaryAction === "switch_to_task"
      ? "Continue to Task & submission"
      : "Start using " + brandName
  const handlePrimary = () => {
    if (boundaryAction === "advance") {
      dispatchNavigation({ type: "next" })
      return
    }
    if (boundaryAction === "switch_to_task") {
      dispatchNavigation({ type: "complete_section", section: "system_use" })
      dispatchNavigation({ type: "switch_section", section: "experiment_workflow" })
      return
    }
    onFinish()
  }

  return (
    <div className="fixed inset-0 z-50 flex bg-background">
      {/* Demo area: transcript + optional real side panel, one spotlight. */}
      <div ref={areaRef} className="relative flex min-w-0 flex-1 overflow-hidden border-r border-border">
        <MemoryBoardLauncherProvider onOpenMemoryBoard={handleOpenMemoryBoard}>
        <TranscriptRenderOptionsProvider value={renderOptions}>
          <GuideTranscriptContextProvider>
            <OpenLocalLinkProvider onOpenLocalLink={noop}>
              <TurnInterruptContext.Provider value={interruptApi}>
              <ViolatedCitationsMapProvider value={violatedMap}>
                {step?.panel === "board" ? (
                  <GuidePanelSurface
                    readOnly={!panelInteractive}
                    className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto"
                  >
                    <MemoryBoardPage />
                  </GuidePanelSurface>
                ) : step?.panel === "studySessionSetup" ? (
                  <GuidePanelSurface
                    readOnly={false}
                    className="min-w-0 flex-1 overflow-y-auto"
                  >
                    <div className="mx-auto max-w-[680px] px-6 py-10">
                      <StudySessionStartSurface
                        sessionTitle="Apartment rentals · Session 2"
                        projectTitle="Apartment rentals"
                        projectSlug="apartment"
                        continuesExistingWork
                        onStart={handleStartGuideChat}
                      />
                    </div>
                  </GuidePanelSurface>
                ) : step?.panel === "studySessions" ? (
                  // The real session-list page over shimmed study progress:
                  // one completed, one active, two locked — the serial gate
                  // the contract step is describing.
                  <GuidePanelSurface
                    readOnly
                    className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto"
                  >
                    <StudyIndexPage embedded />
                  </GuidePanelSurface>
                ) : step?.panel === "studyBrief" ? (
                  // The real protected-instructions surface with a demo brief:
                  // participants read the task HERE, own-words warning included.
                  <GuidePanelSurface
                    readOnly
                    className="min-w-0 flex-1 overflow-y-auto"
                  >
                    <div className="mx-auto max-w-[640px] px-6 py-10">
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Session brief</p>
                      <h1 className="mt-1 text-2xl font-semibold text-foreground">Apartment rentals · Session 2</h1>
                      <ProtectedStudyInstructions surface="task_page">
                        <div className="mt-4 space-y-3 text-sm leading-relaxed text-foreground">
                          <p>Continue the apartment rentals application from Session 1.</p>
                          <p>
                            Add a booking flow: pick dates on a listing, review the price summary,
                            and confirm the booking.
                          </p>
                          <p>Keep the existing browsing and search features working.</p>
                        </div>
                      </ProtectedStudyInstructions>
                    </div>
                  </GuidePanelSurface>
                ) : step?.panel === "studySubmit" ? (
                  // The real study bar (demo data): the bright Finish button
                  // sits exactly where it lives during a session.
                  <GuidePanelSurface
                    readOnly
                    className="flex h-full min-w-0 flex-1 flex-col"
                  >
                    <StudyDock demo />
                    <div className="grid flex-1 place-items-center px-8 text-center text-sm text-muted-foreground">
                      During a session, the conversation fills this space. The study bar above
                      stays put, so Finish this session is always one click away.
                    </div>
                  </GuidePanelSurface>
                ) : step?.panel === "studyPostSession" && step.postSessionPhase ? (
                  <GuidePanelSurface
                    readOnly={!panelInteractive}
                    className="h-full min-w-0 flex-1 overflow-y-auto bg-background"
                  >
                    <GuidePostSessionJourney phase={step.postSessionPhase} />
                  </GuidePanelSurface>
                ) : (
                  <>
                    <div className="relative h-full min-w-0 flex-1">
                      <ChatNavbar
                        sidebarCollapsed={false}
                        onOpenSidebar={noop}
                        onExpandSidebar={noop}
                        onNewChat={noop}
                        localPath="/home/user/web-shop"
                        rightPanel={
                          step?.panel === "browser"
                            ? "browser"
                            : step?.panel === "files"
                              ? "files"
                              : step?.panel === "memoryRecord" || step?.panel === "autoMemory" || step?.panel === "staticMemory"
                                ? "memory"
                                : "hidden"
                        }
                        onToggleBrowserPanel={handleOpenGuideBrowser}
                        onToggleFilesPanel={noop}
                        onToggleGitPanel={noop}
                        onToggleMemoryPanel={noop}
                        memoryChatId={GUIDE_CHAT_ID}
                        memoryProjectId={GUIDE_PROJECT_ID}
                        branchName="main"
                        gitStatus="ready"
                      />
                      <div
                        ref={paneRef}
                        data-transcript-list
                        className="relative h-full min-w-0 overflow-y-auto px-6 pb-10 pt-14"
                      >
                      {rows.map((row) => (
                        <div
                          key={row.id}
                          className={cn(
                            "mx-auto w-full max-w-[780px] pb-5",
                            !rowsInteractive && "pointer-events-none select-none"
                          )}
                          data-guide-row-id={row.id}
                          data-transcript-row-id={row.id}
                          data-guide-row-kind={row.kind === "single" ? undefined : row.kind}
                        >
                          <ChatTranscriptRow
                            row={row}
                            toolGroupExpanded={row.kind === "tool-group" ? true : undefined}
                            onToolGroupExpandedChange={noop}
                            onAskUserQuestionSubmit={noop}
                            onExitPlanModeConfirm={noop}
                            onMemoryPreviewRespond={noop}
                            onMemoryProposalsRespond={handleProposalsDecision}
                            onMemoryCheckupRespond={handleCheckupDecision}
                            onMemoryTransferRespond={handleTransferDecision}
                            onMemoryPreparationReopen={handleMemoryPreparationReopen}
                          />
                        </div>
                      ))}
                      {/* The live footer, frozen at this scene's moment. */}
                      {activeScene?.streamingText || activeScene?.statusLabel ? (
                        <div className={cn(
                          "mx-auto w-full max-w-[780px]",
                          !step?.interruptDemo && "pointer-events-none select-none",
                        )}>
                          {activeScene.streamingText ? <StreamingAssistantText text={activeScene.streamingText} /> : null}
                          {activeScene.statusLabel ? <ProcessingMessage status={activeScene.statusLabel} /> : null}
                        </div>
                      ) : null}
                      {/* The real composer: Send before a run, Stop while one is active. */}
                      <div className="mx-auto mt-6 w-full max-w-[820px]" data-guide-composer="true">
                        <ChatInput
                          ref={chatInputRef}
                          onSubmit={handleLocalSubmit}
                          onCancel={handleLocalCancel}
                          disabled={false}
                          canCancel={composerCanCancel}
                          chatId={GUIDE_CHAT_ID}
                          projectId={null}
                          activeProvider="claude"
                          availableProviders={CLAUDE_PROVIDERS}
                          contextWindowSnapshot={null}
                          previousPrompt={null}
                          slashCommands={[]}
                        />
                      </div>
                      </div>
                    </div>
                    {sidePanel ? (
                      <GuidePanelSurface
                        readOnly={!panelInteractive}
                        className={cn(
                          "h-full shrink-0 border-l border-border bg-background",
                          step?.panel === "memoryRecord" ? "w-[340px]" : "w-[460px]",
                        )}
                      >
                        {sidePanel}
                      </GuidePanelSurface>
                    ) : null}
                  </>
                )}
                {step?.id === "memosync.opening-board" && step.boardDemo ? (
                  <div data-guide-panel="true" className="absolute inset-0 z-50">
                  <MemoryBoardOverlay
                    embedded
                    blocking
                    taskId="038-S2"
                    chatId={GUIDE_CHAT_ID}
                    status={boardSnapshot ?? step.boardDemo.status}
                    pendingPrompt={flow.firstPrompt?.text ?? undefined}
                    onEnterSession={() => void handleEnterAfterBoard()}
                    onBacklogChanged={handleBoardBacklogChanged}
                  />
                  </div>
                ) : null}
                {manualBoard ? (
                  <GuideManualBoardOverlay
                    request={manualBoard}
                    boardSnapshot={boardSnapshot}
                    onBacklogChanged={handleBoardBacklogChanged}
                    onDismiss={() => setManualBoard(null)}
                  />
                ) : null}
                {/* Spotlight: a ringed hole whose shadow dims the rest. */}
                {spot ? (
                  <div
                    aria-hidden
                    className="pointer-events-none absolute z-10 rounded-2xl ring-4 ring-background transition-all duration-300"
                    style={{
                      top: spot.top - 8,
                      left: spot.left - 8,
                      width: spot.width + 16,
                      height: spot.height + 16,
                      boxShadow: "0 0 0 200vmax rgba(15, 23, 42, 0.45)",
                    }}
                  />
                ) : null}
              </ViolatedCitationsMapProvider>
              </TurnInterruptContext.Provider>
            </OpenLocalLinkProvider>
          </GuideTranscriptContextProvider>
        </TranscriptRenderOptionsProvider>
        </MemoryBoardLauncherProvider>
      </div>

      {/* Step panel */}
      <div className="flex w-[400px] shrink-0 flex-col bg-background">
        <div className="flex-1 overflow-y-auto px-8 pt-10">
          <GuideSectionTabs
            active={navigation.activeSection}
            onSelect={(section) => dispatchNavigation({ type: "switch_section", section })}
          />
          <div
            id={"guide-panel-" + navigation.activeSection}
            role="tabpanel"
            aria-labelledby={"guide-tab-" + navigation.activeSection}
            className="pt-6"
          >
          <GuideChapterHeading
            chapter={step.chapter}
            currentStep={sectionProgress.current}
            totalSteps={sectionProgress.total}
          />
          <h2 className="mt-3 text-2xl font-semibold leading-snug text-foreground">{step.title}</h2>
          <div className="mt-4 space-y-3 text-[15px] leading-relaxed text-foreground/90">{step.body}</div>
          {step.interactive || step.panelInteractive ? (
            <p className="mt-4 rounded-lg border border-border bg-muted/40 px-3 py-2 text-[13px] text-muted-foreground">
              This part of the demo is live and local. Try it here if you want, or press Next to continue.
            </p>
          ) : null}
          </div>
        </div>
        <div className="px-8 pb-8">
          <div className="mb-4 flex items-center gap-1.5">
            {sectionSteps.map((candidate, index) => (
              <span
                key={candidate.id}
                className={cn(
                  "h-1 flex-1 rounded-full transition-colors",
                  index <= stepIndex ? "bg-red-400" : "bg-border",
                )}
              />
            ))}
          </div>
          <div className="flex items-center justify-between gap-3">
            <Button
              variant="outline"
              disabled={sectionProgress.isFirst}
              onClick={() => dispatchNavigation({ type: "back" })}
              className="gap-1.5"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </Button>
            {onSkip ? (
              <button type="button" onClick={onSkip} className="text-xs text-muted-foreground hover:text-foreground">
                Skip tutorial
              </button>
            ) : <span />}
            <GuidePrimaryButton
              label={primaryLabel}
              showArrow={!(isLast && navigation.activeSection === "experiment_workflow")}
              onClick={handlePrimary}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
