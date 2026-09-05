// Memory Board — the user's memories as operable objects (SPEC §4.9): a
// candidate-review lane, three scope columns (Personal/Project/Session) with
// drag-to-rescope, free-text search across every lane, and a right-side
// detail panel with per-item history + rollback (§4.11, option 乙). Ported
// (functionality) from MemoSync, re-implemented in Kanna's visual language.
// State via the memoryStore; mutations via memoriesApi.
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { DragEvent } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { AlertTriangle, Archive, ArchiveRestore, ArrowLeft, BrainCircuit, ChevronRight, Loader2, Plus, Search, Trash2, X } from "lucide-react"
import { Button } from "../components/ui/button"
import { Textarea } from "../components/ui/textarea"
import { SegmentedControl } from "../components/ui/segmented-control"
import { cn } from "../lib/utils"
import { useMemoryStore } from "../stores/memoryStore"
import {
  memoriesApi,
  type CreateMemoryBody,
  type MemoryItem,
  type MemoryBoardReviewStatus,
  type MemoryScope,
  type MutedProposal,
} from "../lib/memoriesApi"
import { MemoryCard } from "../components/memory/MemoryCard"
import { MemoryDetailPanel } from "../components/memory/MemoryDetailPanel"
import { MemoryLegendButton } from "../components/memory/MemoryLegend"
import { SCOPES, SCOPE_ICONS, scopeRingClasses } from "../components/memory/ScopeBadge"
import { memoryScopeLabel } from "../lib/memoryCitations"
import { useConditionPolicy } from "../lib/conditionApi"
import { workspaceApi } from "../lib/workspaceApi"
import { recordUiMonitor } from "../lib/memoriesApi"
import { freshnessSince, getLastBoardVisit, markBoardVisit } from "../lib/boardVisit"
import { parseBoardFocus } from "../lib/boardFocus"
import { TransferMemoryDialog, type TransferInitialTarget } from "../components/memory/TransferMemoryDialog"
import { MarkdownSyncCard } from "../components/memory/MarkdownSyncCard"
import { MemoryTransferGate } from "../components/messages/MemoryTransferGate"
import { MemoryCheckupGate } from "../components/messages/MemoryCheckupGate"
import {
  candidateReviewCohortItems,
  extendCandidateReviewCohort,
  FocusedMemoryCandidateStep,
  FocusedMemoryReviewStation,
} from "../components/messages/MemoryChangesReviewFlow"
import { MemoryCandidateReviewStation } from "../components/messages/MemoryProposalsGate"
import { TranscriptChatContextProvider } from "../components/messages/render-context"
import type { FocusedMemoryReviewController } from "./study/MemoryBoardLauncher"

// Manual creation: session memories are agent-created within a session (they
// need a sessionId), so the form only offers Personal / Project.
const CREATE_SCOPES = SCOPES.filter((s) => s !== "session")
// The Session column itself is not a generic drop target: a move must name a
// real chat. A chat-bound Board supplies that exact target as a group below.
const DROP_SCOPES: Extract<MemoryScope, "personal" | "project">[] = ["personal", "project"]

function matchesQuery(item: MemoryItem, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  return (
    item.content.toLowerCase().includes(q) ||
    (item.detail ?? "").toLowerCase().includes(q)
  )
}

export interface MemoryBoardOverlayMode {
  /** Session-start gate: no close until every server-authoritative backlog row is handled. */
  blocking: boolean
  taskId?: string
  chatId?: string
  status?: MemoryBoardReviewStatus
  actionError?: string | null
  submitting?: boolean
  /** Opening review only: the participant-authored message held behind it. */
  pendingPrompt?: string
  /** Active in-chat Long-term review expanded into this same overlay. */
  focusedReview?: FocusedMemoryReviewController
  onClose?: () => void
  /** Blocking variant: called when the participant enters the session. */
  onEnterSession?: () => void
  onBacklogChanged?: () => void
}

export function memoryBoardSectionVisibility(_openingReview: boolean) {
  return {
    pendingBacklog: true,
    candidates: true,
    searchAndCreate: true,
    activeLibrary: true,
    archived: true,
    muted: true,
    markdown: true,
    workingMemory: false,
  }
}

export function openingMemoryBoardCopy(pending: number) {
  return {
    heading: "Long-term Memory Management",
    message: pending > 0
      ? `Your first message is waiting. Handle ${pending} pending long-term ${pending === 1 ? "memory item" : "memory items"} below. After this review, the same message continues and Working Memory is selected separately for this turn.`
      : "Your first message is waiting. Long-term Memory review is complete. Continue with the same message, then select Working Memory separately for this turn.",
    cta: "Continue with this message",
  }
}

export function openingMemoryBoardGateModel({
  pending,
  openingPhase,
  submitting,
}: {
  pending: number | null
  openingPhase?: "dispatch_pending" | "preparing" | "long_term_ready" | "completed"
  submitting: boolean
}) {
  if (pending === null) {
    return {
      message: null,
      showContinue: false,
      continueLabel: null,
    }
  }

  if (openingPhase !== undefined) {
    if (openingPhase === "long_term_ready") {
      return {
        message: "Your first message is waiting. Long-term Memory review is complete. Continue with the same message, then select Working Memory separately for this turn.",
        showContinue: !submitting,
        continueLabel: submitting ? "Continuing…" : "Continue with this message",
      }
    }
    if (openingPhase !== "completed") {
      return {
        message: "Your first message is waiting. Review its Long-term Memory steps below. Working Memory will be selected separately after this review.",
        showContinue: false,
        continueLabel: null,
      }
    }
  }

  const copy = openingMemoryBoardCopy(pending)
  return {
    message: copy.message,
    showContinue: pending === 0,
    continueLabel: pending === 0
      ? (submitting ? "Verifying…" : copy.cta)
      : null,
  }
}

export function deriveBoardReviewStepNumbers(_options: { hasTransfer: boolean }) {
  return { transfer: 2, checkup: 3 }
}

export type MemoryBoardScopeEntry =
  | { kind: "memory"; item: MemoryItem }
  | { kind: "candidate-placeholder"; item: MemoryItem }

/** The three scope columns are a projection of the canonical store. A
 * Candidate occupies its destination as a read-only placeholder; accepting
 * or reverting it changes the same id's projection without a second UI state. */
export function projectMemoryBoardScopes(items: MemoryItem[]): Record<MemoryScope, MemoryBoardScopeEntry[]> {
  const columns: Record<MemoryScope, MemoryBoardScopeEntry[]> = { personal: [], project: [], session: [] }
  for (const item of items) {
    if (item.status === "active") columns[item.scope].push({ kind: "memory", item })
    if (item.status === "candidate") columns[item.scope].push({ kind: "candidate-placeholder", item })
  }
  return columns
}

export function deriveMemoryBoardModel(
  items: MemoryItem[],
  options: { query: string; projectFilter: string | null },
) {
  const visibleInColumns = items.filter((item) => {
    const inProjectLens = !options.projectFilter
      || item.scope !== "project"
      || item.projectId === options.projectFilter
    return inProjectLens && matchesQuery(item, options.query)
  })
  return {
    // Step 1 is an authoritative decision station. Library controls must not
    // hide rows while the server still counts them as blocking.
    candidateStation: items.filter((item) => item.status === "candidate"),
    scopes: projectMemoryBoardScopes(visibleInColumns),
  }
}

export function MemoryBoardPage({ overlay }: { overlay?: MemoryBoardOverlayMode } = {}) {
  const items = useMemoryStore((s) => s.items)
  const status = useMemoryStore((s) => s.status)
  const error = useMemoryStore((s) => s.error)
  const loadAll = useMemoryStore((s) => s.loadAll)
  const upsertLocal = useMemoryStore((s) => s.upsertLocal)
  const removeLocal = useMemoryStore((s) => s.removeLocal)
  const conditionPolicy = useConditionPolicy()
  const openingReview = overlay?.blocking === true
  const hasFocusedReview = Boolean(overlay?.focusedReview)
  const sections = memoryBoardSectionVisibility(openingReview)
  const gateModel = openingMemoryBoardGateModel({
    pending: overlay?.status?.pending.total ?? null,
    openingPhase: overlay?.status?.openingPrompt?.phase,
    submitting: overlay?.submitting ?? false,
  })
  const reviewSteps = deriveBoardReviewStepNumbers({
    hasTransfer: (overlay?.status?.backlog.transfers.length ?? 0) > 0,
  })

  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Conflict maintenance (A1): older memories targeted by conflicts_with.
  const [needsAttention, setNeedsAttention] = useState<
    Array<{ memory: MemoryItem; supersededBy: MemoryItem[] }>
  >([])
  // The one drop zone under the pointer, as a single key (column "col:<scope>"
  // or group "grp:<scope>:<id>"). Set on dragover (which fires continuously,
  // innermost zone wins via stopPropagation) and cleared on drop / drag end —
  // never on dragleave, whose firing on every child-boundary crossing is what
  // makes nested drop zones flicker.
  const [activeDrop, setActiveDrop] = useState<string | null>(null)
  // Drag-across-scope opens the transfer instrument instead of silently rescoping.
  const [transferRequest, setTransferRequest] = useState<{
    item: MemoryItem
    target: TransferInitialTarget
  } | null>(null)
  // Project lens (?project=<id>, set when entering from a project chat): the
  // Board stays the global inventory, but the project section narrows to the
  // current project until the chip is dismissed. Personal/session stay put.
  const [projectFilter, setProjectFilter] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get("project"),
  )
  // Proposals just created by a Save & sync / import: pinged and scrolled to
  // in the review list so the report line has a visible landing (friction #7).
  const [freshCandidates, setFreshCandidates] = useState<{ ids: Set<string>; at: number }>({ ids: new Set(), at: 0 })
  // Meta-model diff: items touched since the previous board visit get pills.
  const [prevVisitAt] = useState<number | null>(() => getLastBoardVisit())
  const telemetryChatId = overlay?.chatId
  useEffect(() => {
    if (overlay || !telemetryChatId) return
    recordUiMonitor("board", { sessionId: telemetryChatId, interaction: "open" })
    const onFocus = () => recordUiMonitor("board_visit", { sessionId: telemetryChatId, interaction: "open" })
    window.addEventListener("focus", onFocus)
    return () => {
      window.removeEventListener("focus", onFocus)
      markBoardVisit(Date.now())
    }
  }, [overlay, telemetryChatId])
  const lastBoardScrollAtRef = useRef(0)
  const hoveredBoardIdsRef = useRef(new Set<string>())
  const recordBoardScroll = useCallback(() => {
    const now = Date.now()
    if (now - lastBoardScrollAtRef.current < 750) return
    lastBoardScrollAtRef.current = now
    if (telemetryChatId) recordUiMonitor("board", { sessionId: telemetryChatId, interaction: "scroll" })
  }, [telemetryChatId])
  const recordBoardHover = useCallback((id: string) => {
    if (hoveredBoardIdsRef.current.has(id)) return
    hoveredBoardIdsRef.current.add(id)
    if (telemetryChatId) recordUiMonitor("board", { sessionId: telemetryChatId, ids: [id], interaction: "hover" })
  }, [telemetryChatId])
  // id → title maps so project/session cards can say WHERE they bind.
  const [originTitles, setOriginTitles] = useState<{
    projects: Record<string, string>
    chats: Record<string, string>
  }>({ projects: {}, chats: {} })
  // chatId → projectId, so session groups can name the project they came from.
  const [chatProjects, setChatProjects] = useState<Record<string, string>>({})
  const [draft, setDraft] = useState<{
    content: string
    detail: string
    scope: MemoryScope
    projectId: string
  }>({
    content: "",
    detail: "",
    scope: "personal",
    projectId: "",
  })

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  const refreshNeedsAttention = useCallback(() => {
    memoriesApi
      .needsAttention()
      .then((r) => {
        setNeedsAttention(r.items)
      })
      .catch(() => {
        setNeedsAttention([])
      })
  }, [])

  const refreshOriginTitles = useCallback(() => {
    Promise.all([workspaceApi.projectTitles(), workspaceApi.chatTitles()])
      .then(([projects, chats]) => setOriginTitles({ projects, chats }))
      .catch(() => {}) // labels are decoration — cards fall back to raw ids
    workspaceApi
      .chatProjectIds()
      .then(setChatProjects)
      .catch(() => {})
  }, [])
  useEffect(() => {
    refreshOriginTitles()
  }, [refreshOriginTitles])

  const originLabelFor = useCallback(
    (item: MemoryItem): string | undefined => {
      if (item.scope === "project" && item.projectId) {
        return originTitles.projects[item.projectId] ?? item.projectId
      }
      if (item.scope === "session" && item.sessionId) {
        return originTitles.chats[item.sessionId] ?? item.sessionId
      }
      return undefined
    },
    [originTitles],
  )
  // Re-check after any item change (an accepted supersede or an archive can
  // resolve a conflict) — cheap read, keyed on the item set.
  useEffect(() => {
    refreshNeedsAttention()
  }, [refreshNeedsAttention, items])

  // Monitoring-act beacon: the drift lane was actually on screen (dedup by set).
  const needsAttentionSeenRef = useRef("")
  useEffect(() => {
    const key = needsAttention.map((n) => n.memory.id).sort().join(",")
    if (!key || key === needsAttentionSeenRef.current) return
    needsAttentionSeenRef.current = key
    if (telemetryChatId) recordUiMonitor("needs_attention_view", { ids: needsAttention.map((n) => n.memory.id), sessionId: telemetryChatId, interaction: "open" })
  }, [needsAttention, telemetryChatId])

  // The Board only loaded on mount, so accepts/captures happening in a chat
  // (another tab, or while this page sat open) left it stale — a conflict
  // "merge" looked like nothing changed. Refresh on window focus and poll
  // lightly while visible.
  useEffect(() => {
    const refresh = () => {
      void loadAll()
      refreshNeedsAttention()
      refreshOriginTitles()
    }
    window.addEventListener("focus", refresh)
    const interval = setInterval(() => {
      if (!document.hidden) refresh()
    }, 10_000)
    return () => {
      window.removeEventListener("focus", refresh)
      clearInterval(interval)
    }
  }, [loadAll, refreshNeedsAttention, refreshOriginTitles])

  // Keep selection valid: if the selected item is archived/removed elsewhere,
  // close the panel instead of pointing at stale data.
  useEffect(() => {
    if (selectedId && !items.some((m) => m.id === selectedId)) setSelectedId(null)
  }, [items, selectedId])

  const inProjectLens = useCallback(
    (m: MemoryItem) => !projectFilter || m.scope !== "project" || m.projectId === projectFilter,
    [projectFilter],
  )
  const boardModel = useMemo(
    () => deriveMemoryBoardModel(items, { query, projectFilter }),
    [items, projectFilter, query],
  )
  const candidates = boardModel.candidateStation
  const [candidateReviewCohortIds, setCandidateReviewCohortIds] = useState<ReadonlySet<string>>(
    () => extendCandidateReviewCohort(new Set(), candidates),
  )
  useEffect(() => {
    setCandidateReviewCohortIds((current) => extendCandidateReviewCohort(current, candidates))
  }, [candidates])
  const candidateReviewItems = useMemo(
    () => candidateReviewCohortItems(items, candidateReviewCohortIds),
    [candidateReviewCohortIds, items],
  )
  // The archived shelf: archiving must not be a one-way door — the items stay
  // visible (collapsed) and restorable, or "archive" is delete with extra steps.
  const archivedItems = useMemo(
    () => items.filter((m) => m.status === "archived" && matchesQuery(m, query) && inProjectLens(m)),
    [items, query, inProjectLens],
  )
  const [showArchived, setShowArchived] = useState(false)
  const [restoringId, setRestoringId] = useState<string | null>(null)
  // Muted proposals (dismissal fingerprints): loaded lazily on expand.
  const [showMuted, setShowMuted] = useState(false)
  const [muted, setMuted] = useState<MutedProposal[] | null>(null)
  const [unmutingId, setUnmutingId] = useState<string | null>(null)
  useEffect(() => {
    if (!showMuted) return
    memoriesApi
      .listMuted()
      .then((r) => setMuted(r.items))
      .catch(() => setMuted([]))
  }, [showMuted])
  const handleUnmute = useCallback(async (memoryId: string) => {
    setUnmutingId(memoryId)
    try {
      await memoriesApi.unmute(memoryId)
      setMuted((current) => current?.filter((m) => m.memoryId !== memoryId) ?? current)
    } catch {
      // already lifted elsewhere — refresh the list
      void memoriesApi.listMuted().then((r) => setMuted(r.items)).catch(() => {})
    } finally {
      setUnmutingId(null)
    }
  }, [])
  const handleRestore = useCallback(async (id: string) => {
    setRestoringId(id)
    try {
      const updated = await memoriesApi.update(id, { status: "active" }, { surface: "board" })
      upsertLocal(updated)
    } catch {
      void loadAll() // raced elsewhere — refetch rather than lie
    } finally {
      setRestoringId(null)
    }
  }, [upsertLocal, loadAll])
  // ?focus=candidates (landing "Review candidates" card) — scroll to the
  // candidate lane and flash it once the list has loaded, then clean the URL.
  const location = useLocation()
  const navigate = useNavigate()
  const candidatesSectionRef = useRef<HTMLElement | null>(null)
  const flashTimerRef = useRef<number | undefined>(undefined)
  const [flashCandidates, setFlashCandidates] = useState(false)
  useEffect(() => {
    if (overlay) return // overlay mode has no route focus params
    if (parseBoardFocus(location.search) !== "candidates") return
    if (status !== "ready") return
    if (candidates.length > 0) {
      candidatesSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
      setFlashCandidates(true)
      // Timer lives in a ref: the navigate() below changes location.search,
      // which re-runs this effect — an effect-cleanup timer would be
      // cancelled right there and the flash would never turn off.
      window.clearTimeout(flashTimerRef.current)
      flashTimerRef.current = window.setTimeout(() => setFlashCandidates(false), 1800)
    }
    navigate("/memory", { replace: true })
  }, [candidates.length, location.search, navigate, status])
  useEffect(() => () => window.clearTimeout(flashTimerRef.current), [])
  const boardItemsByScope = boardModel.scopes
  const selectedItem = useMemo(() => items.find((m) => m.id === selectedId) ?? null, [items, selectedId])

  async function handleCreate() {
    const content = draft.content.trim()
    if (!content) return
    // A project-scoped memory must name a real project or it never injects (MEMUI-1).
    if (draft.scope === "project" && !draft.projectId) return
    setBusy(true)
    try {
      const created = await memoriesApi.create({
        content,
        detail: draft.detail.trim() || undefined,
        scope: draft.scope,
        // Bind to the chosen real project. A project memory with a bogus id
        // (the old hardcoded "default") never injects into any chat (MEMUI-1).
        projectId: draft.scope === "project" ? draft.projectId : undefined,
      }, { surface: "board" })
      upsertLocal(created)
      setDraft({ content: "", detail: "", scope: "personal", projectId: "" })
      setCreating(false)
      setActionError(null)
      overlay?.onBacklogChanged?.()
    } catch (err) {
      // Surface the failure — the Board's direct actions used to swallow every
      // error, so a failed create/accept/dismiss just did nothing (BUG MEMUI-2).
      setActionError(err instanceof Error ? err.message : "Couldn't create the memory.")
    } finally {
      setBusy(false)
    }
  }

  async function acceptCandidate(
    item: MemoryItem,
    reviewedPatch?: Partial<CreateMemoryBody> & { content: string; detail: string; status: "active" },
  ) {
    try {
      const updated = await memoriesApi.update(item.id, reviewedPatch ?? { status: "active" }, { surface: "board" })
      upsertLocal(updated)
      setActionError(null)
      overlay?.onBacklogChanged?.()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't accept the memory.")
      throw err
    }
  }
  async function discard(item: MemoryItem) {
    try {
      await memoriesApi.remove(item.id, { surface: "board" })
      removeLocal(item.id)
      setActionError(null)
      overlay?.onBacklogChanged?.()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't dismiss the memory.")
      throw err
    }
  }
  // Conflict maintenance (A1): archive the older memory in a contested pair.
  async function archiveContested(item: MemoryItem) {
    try {
      const updated = await memoriesApi.update(item.id, { status: "archived" }, { surface: "board" })
      upsertLocal(updated)
      refreshNeedsAttention()
      setActionError(null)
      overlay?.onBacklogChanged?.()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't archive the memory.")
      throw err
    }
  }

  // Project/Session columns read best grouped by what they bind to — a flat
  // mixed list hides "whose memory is this" exactly when several projects
  // (T4) or chats coexist. Personal stays flat (one owner).
  function groupCardsByOrigin(
    scope: MemoryScope,
    list: MemoryItem[],
  ): Array<{ key: string; label: string | null; items: MemoryItem[] }> {
    if (scope === "personal") return list.length > 0 ? [{ key: "personal", label: null, items: list }] : []
    const groups = new Map<string, MemoryItem[]>()
    // A newly created chat is already a valid Session binding even before it
    // owns any Session memory. Keep that empty target visible so a participant
    // can move a Project memory into the current session from the opening Board.
    if (scope === "session" && overlay?.chatId) groups.set(overlay.chatId, [])
    for (const item of list) {
      const key = (scope === "project" ? item.projectId : item.sessionId) ?? "unassigned"
      const bucket = groups.get(key)
      if (bucket) bucket.push(item)
      else groups.set(key, [item])
    }
    return [...groups.entries()].map(([key, items]) => {
      if (key === "unassigned") return { key, label: "unassigned", items }
      if (scope === "project") return { key, label: originTitles.projects[key] ?? key, items }
      // Session groups carry their PROJECT of origin too — a chat title alone
      // doesn't say which project's context the memory belongs to.
      const chatTitle = originTitles.chats[key]
      const chatLabel = key === overlay?.chatId
        ? (chatTitle ? `Current session · ${chatTitle}` : "Current session")
        : (chatTitle ?? key)
      const projectTitle = chatProjects[key] ? originTitles.projects[chatProjects[key]] : undefined
      return { key, label: projectTitle ? `${chatLabel} · ${projectTitle}` : chatLabel, items }
    })
  }

  function renderScopedCard(item: MemoryItem, scope: MemoryScope) {
    return (
      <div key={item.id} onMouseEnter={() => recordBoardHover(item.id)}>
        <MemoryCard
          item={item}
          variant="scoped"
          selected={item.id === selectedId}
          draggable
          onDragStart={(e) => handleDragStart(e, item.id)}
          // Always fires when the drag ends, wherever it lands (or is cancelled)
          // — the reliable clear for a drop released outside every zone.
          onDragEnd={() => setActiveDrop(null)}
          onClick={() => setSelectedId(item.id)}
          // The group header already names the binding; provenance says which
          // chat captured it (session cards: header IS the chat — skip).
          capturedIn={
            scope !== "session" && item.provenanceSessionId
              ? (originTitles.chats[item.provenanceSessionId] ?? undefined)
              : undefined
          }
          freshness={freshnessSince(item, prevVisitAt)}
          footer={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Archive memory"
              className="ml-auto"
              onClick={() => void discard(item).catch(() => {})}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          }
        />
      </div>
    )
  }

  function renderCandidatePlaceholder(item: MemoryItem) {
    return (
      <div
        key={item.id}
        data-memory-candidate-placeholder={item.id}
        className="rounded-2xl border border-dashed border-cand-border bg-cand-surface/35 px-3 py-3"
        onMouseEnter={() => recordBoardHover(item.id)}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-cand-fg">Proposed destination</span>
          <span className="font-mono text-[10px] text-muted-foreground">{item.id}</span>
        </div>
        <p className="mt-1.5 whitespace-pre-wrap text-sm text-foreground">{item.content}</p>
        <p className="mt-2 text-[11px] text-muted-foreground">Review this proposal in Step 1 above.</p>
      </div>
    )
  }

  function handleDragStart(e: DragEvent<HTMLDivElement>, id: string) {
    e.dataTransfer.setData("text/plain", id)
    e.dataTransfer.effectAllowed = "move"
  }
  // One handler for every drop zone: mark this zone active. stopPropagation
  // lets the innermost zone (a group inside a column) own the pointer, so the
  // column and its group never fight over the highlight.
  function handleZoneDragOver(e: DragEvent<HTMLElement>, key: string) {
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = "move"
    if (activeDrop !== key) setActiveDrop(key)
  }
  // A drop onto a target only does something when it actually changes the
  // memory's binding — dropping a Project-A item back on Project A, or a
  // personal item on Personal, is a no-op. A project column drop with no
  // chosen project (projectId undefined) is NOT a no-op: the dialog's picker
  // resolves it.
  function sameBinding(item: MemoryItem, target: TransferInitialTarget): boolean {
    if (target.scope !== item.scope) return false
    if (target.scope === "project") return target.projectId != null && target.projectId === item.projectId
    if (target.scope === "session") return target.sessionId === item.sessionId
    return true // personal → personal
  }
  // Every cross-context move goes through the transfer instrument: the proposal
  // judges as-is / rewrite / context-bound before anything moves. The drop only
  // fixes the DESTINATION; a project-column drop leaves the project unset so the
  // dialog forces an explicit pick (cross-project), while a group drop names it.
  function handleDropTarget(e: DragEvent<HTMLElement>, target: TransferInitialTarget) {
    e.preventDefault()
    e.stopPropagation()
    setActiveDrop(null)
    const id = e.dataTransfer.getData("text/plain")
    const item = items.find((m) => m.id === id)
    if (!item || sameBinding(item, target)) return
    setTransferRequest({ item, target })
  }

  if (!conditionPolicy.boardVisible) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
        The Memory Board is not available in the “{conditionPolicy.condition}” study condition.
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-w-0 flex-1 overflow-y-auto px-6 py-6" onScroll={recordBoardScroll}>
        <div className="mx-auto max-w-5xl">
          <header className="mb-4 flex items-center gap-3">
            {/* The board is a full-page detour with no other exit affordance
                (pilot feedback 2026-08-11): give it an explicit way back.
                Overlay mode has no route to go back to. */}
            {overlay ? null : (
              <Button
                variant="ghost"
                size="sm"
                aria-label="Back"
                className="h-8 w-8 shrink-0 px-0"
                onClick={() => (window.history.length > 1 ? navigate(-1) : navigate("/"))}
              >
                <ArrowLeft className="h-4.5 w-4.5" />
              </Button>
            )}
            <BrainCircuit className="h-6 w-6 text-logo" />
            <div className="flex-1">
              <h1 className="text-lg font-semibold text-foreground">
                Memory Board
              </h1>
              <p className="text-sm text-muted-foreground">
                {openingReview
                  ? "Review long-term memory before the message you just sent starts the Claude turn."
                  : hasFocusedReview
                    ? "Review the live chat suggestions and the same canonical saved memories together. Working Memory remains separate."
                    : "Review proposals and manage your persistent, user-controlled long-term memory. Working Memory remains separate."}
              </p>
            </div>
            {sections.searchAndCreate ? <MemoryLegendButton /> : null}
            {sections.searchAndCreate ? (
              <Button variant="juicy" size="sm" onClick={() => setCreating((v) => !v)}>
                <Plus className="h-4 w-4" /> New memory
              </Button>
            ) : null}
            {overlay && !overlay.blocking && overlay.onClose ? (
              <Button
                variant="ghost"
                size="sm"
                aria-label="Close"
                className="h-8 w-8 shrink-0 px-0"
                onClick={overlay.onClose}
              >
                <X className="h-4.5 w-4.5" />
              </Button>
            ) : null}
          </header>

          {overlay?.blocking && gateModel.message ? (
            // Session-start gate (2026-08-19 E1): every candidate, Transfer,
            // and Checkup row blocks entry. The count comes from the server,
            // never this page's search/project filter.
            <div
              data-opening-memory-board-gate="true"
              className="mb-5 flex flex-wrap items-start justify-between gap-4 px-1"
            >
              <div>
                <p className="max-w-4xl text-[15px] leading-6 text-foreground">{gateModel.message}</p>
                {overlay.actionError ? <p className="mt-1 text-xs text-destructive">{overlay.actionError}</p> : null}
              </div>
              {gateModel.showContinue ? (
                <Button
                  size="sm"
                  disabled={overlay.submitting}
                  onClick={overlay.onEnterSession}
                >
                  {overlay.submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  {gateModel.continueLabel}
                </Button>
              ) : null}
            </div>
          ) : null}

          {status === "loading" && items.length === 0 ? (
            <p className="text-sm text-muted-foreground">Loading memories…</p>
          ) : null}
          {status === "error" ? <p className="text-sm text-destructive">Failed to load memories: {error}</p> : null}
          {actionError ? (
            <div className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              <span>{actionError}</span>
              <button type="button" className="shrink-0 underline underline-offset-2" onClick={() => setActionError(null)}>Dismiss</button>
            </div>
          ) : null}

          <section
            ref={candidatesSectionRef}
            data-board-candidates="true"
            data-memory-board-section="candidates"
            className={cn(
              "mb-6 scroll-mt-4 rounded-lg transition-shadow duration-700",
              flashCandidates && "ring-2 ring-primary/50 ring-offset-8 ring-offset-background",
            )}
          >
            {overlay?.focusedReview ? (
              <FocusedMemoryCandidateStep
                controller={overlay.focusedReview}
                items={items}
                cohortIds={candidateReviewCohortIds}
                onChanged={overlay.onBacklogChanged}
              />
            ) : candidateReviewItems.length > 0 ? (
              <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
                <div className="mb-3 flex flex-wrap items-baseline gap-2">
                  <span className="text-[11px] font-semibold text-muted-foreground">Step 1</span>
                  <h2 className="text-sm font-medium text-foreground">Review New Memory Candidates</h2>
                  <span className="ml-auto text-xs text-muted-foreground">{candidateReviewItems.length} in this review</span>
                </div>
                <MemoryCandidateReviewStation
                  candidates={candidateReviewItems}
                  freshAt={freshCandidates.at || undefined}
                  surface="board"
                  allowRestore
                  onChanged={overlay?.onBacklogChanged}
                />
              </div>
            ) : (
              <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Step 1 · Review New Memory Candidates</span>
                <span className="ml-1">✓ No pending memory candidates.</span>
              </div>
            )}
          </section>

          <section data-memory-board-section="library" className="mb-6">
            {sections.searchAndCreate ? <div className="mb-4 flex flex-wrap items-center gap-2">
              <div className="relative max-w-xs flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search memories…"
                  className="h-9 w-full rounded-lg border border-border bg-background pl-8 pr-3 text-sm text-foreground placeholder:text-muted-foreground"
                />
              </div>
              {projectFilter ? (
                <button
                  type="button"
                  onClick={() => setProjectFilter(null)}
                  title="Showing personal memories plus this project's — click to see every project"
                  className="flex h-9 items-center gap-1.5 rounded-lg border border-border bg-muted/40 px-2.5 text-sm text-foreground transition-colors hover:bg-muted"
                >
                  Project: {originTitles.projects[projectFilter] ?? projectFilter}
                  <X className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              ) : null}
            </div> : null}

            {sections.searchAndCreate && creating ? (
              <div className="mb-4 rounded-2xl border border-border bg-card p-4 shadow-sm">
                <Textarea
                  value={draft.content}
                  onChange={(e) => setDraft((d) => ({ ...d, content: e.target.value }))}
                  placeholder="One concise, actionable memory…"
                  className="mb-3 min-h-20"
                />
                <Textarea
                  value={draft.detail}
                  onChange={(e) => setDraft((d) => ({ ...d, detail: e.target.value }))}
                  placeholder="Detailed form (optional) — loaded on demand by the agent"
                  className="mb-3 min-h-16"
                />
                <div className="flex flex-wrap items-center gap-3">
                  <SegmentedControl<MemoryScope>
                    size="sm"
                    value={draft.scope}
                    onValueChange={(scope) => setDraft((d) => ({ ...d, scope }))}
                    options={CREATE_SCOPES.map((scope) => ({ value: scope, label: memoryScopeLabel(scope), icon: SCOPE_ICONS[scope] }))}
                  />
                  {draft.scope === "project" ? (
                    <select
                      value={draft.projectId}
                      onChange={(e) => setDraft((d) => ({ ...d, projectId: e.target.value }))}
                      className="h-8 rounded-lg border border-border bg-background px-2 text-sm text-foreground"
                    >
                      <option value="">choose project…</option>
                      {Object.entries(originTitles.projects).map(([pid, title]) => (
                        <option key={pid} value={pid}>{title}</option>
                      ))}
                    </select>
                  ) : null}
                  <div className="ml-auto flex items-center gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>Cancel</Button>
                    <Button
                      variant="juicy"
                      size="sm"
                      disabled={busy || !draft.content.trim() || (draft.scope === "project" && !draft.projectId)}
                      onClick={() => void handleCreate()}
                    >
                      Create
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="grid gap-4 md:grid-cols-3">
              {SCOPES.map((scope) => {
                const entries = boardItemsByScope[scope]
                const list = entries.map((entry) => entry.item)
                const groups = groupCardsByOrigin(scope, list)
                const Icon = SCOPE_ICONS[scope]
                const isDropTarget = (DROP_SCOPES as MemoryScope[]).includes(scope)
                return (
                  <section
                    key={scope}
                    className={cn(
                      "flex flex-col gap-3 rounded-2xl p-1 transition-shadow",
                      isDropTarget && activeDrop === `col:${scope}` && cn("ring-2", scopeRingClasses(scope)),
                    )}
                    onDragOver={isDropTarget ? (event) => handleZoneDragOver(event, `col:${scope}`) : undefined}
                    onDrop={isDropTarget ? (event) => handleDropTarget(event, scope === "personal" ? { scope: "personal" } : { scope: "project" }) : undefined}
                  >
                    <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                      <Icon className="h-4 w-4 text-muted-foreground" />
                      {memoryScopeLabel(scope)}
                      <span className="text-muted-foreground">{list.length}</span>
                    </div>
                    {groups.length === 0 ? (
                      <p className="rounded-2xl border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                        {scope === "session"
                          ? "Session memories are captured by the agent inside a chat and stay scoped to that conversation. None yet."
                          : `No ${memoryScopeLabel(scope).toLowerCase()} memories yet.`}
                      </p>
                    ) : groups.map((group) => {
                      const groupTarget: TransferInitialTarget | null =
                        group.key === "unassigned"
                          ? null
                          : scope === "project"
                            ? { scope: "project", projectId: group.key }
                            : scope === "session"
                              ? { scope: "session", sessionId: group.key, sessionLabel: group.label ?? undefined }
                              : null
                      const groupDropKey = `grp:${scope}:${group.key}`
                      return (
                        <div
                          key={group.key}
                          data-memory-session-drop-target={scope === "session" ? group.key : undefined}
                          className={cn(
                            "flex flex-col gap-2 rounded-xl transition-shadow",
                            groupTarget && activeDrop === groupDropKey && cn("p-1 ring-2", scopeRingClasses(scope)),
                          )}
                          onDragOver={groupTarget ? (event) => handleZoneDragOver(event, groupDropKey) : undefined}
                          onDrop={groupTarget ? (event) => handleDropTarget(event, groupTarget) : undefined}
                        >
                          {group.label ? (
                            <p className="px-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{group.label}</p>
                          ) : null}
                          {group.items.length === 0 && scope === "session" ? (
                            <p className="rounded-2xl border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                              Drop a memory here to keep it only for this session.
                            </p>
                          ) : group.items.map((item) => (
                            item.status === "candidate"
                              ? renderCandidatePlaceholder(item)
                              : renderScopedCard(item, scope)
                          ))}
                        </div>
                      )
                    })}
                  </section>
                )
              })}
            </div>
          </section>

          <section data-memory-board-section="transfer" className="mb-6 flex flex-col gap-3">
            {overlay?.focusedReview ? <FocusedMemoryReviewStation controller={overlay.focusedReview} station="transfer" /> : null}
            {sections.pendingBacklog && overlay?.status && overlay.taskId && !(openingReview && overlay.focusedReview)
              ? overlay.status.backlog.transfers.map((gate) => gate.message.kind === "memory_transfer" ? (
                  <TranscriptChatContextProvider key={`transfer-${gate.chatId}-${gate.gateId}`} value={{ chatId: gate.chatId, projectId: gate.projectId }}>
                    <MemoryTransferGate
                      message={gate.message}
                      stepNumber={reviewSteps.transfer}
                      surface="board"
                      requireAllRows
                      boardResolution={{ taskId: overlay.taskId!, chatId: gate.chatId, gateId: gate.gateId }}
                      onRespond={async () => { await overlay.onBacklogChanged?.() }}
                    />
                  </TranscriptChatContextProvider>
                ) : null)
              : null}
            {!overlay?.focusedReview && (overlay?.status?.backlog.transfers.length ?? 0) === 0 ? (
              <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Step 2 · Transfer Suggestions</span>
                <span className="ml-1">✓ No pending Transfer suggestions.</span>
              </div>
            ) : null}
          </section>

          <section data-memory-board-section="checkup" className="mb-6 flex flex-col gap-3">
            {overlay?.focusedReview ? <FocusedMemoryReviewStation controller={overlay.focusedReview} station="checkup" /> : null}
            {sections.pendingBacklog && overlay?.status && overlay.taskId && !(openingReview && overlay.focusedReview)
              ? overlay.status.backlog.checkups.map((gate) => gate.message.kind === "memory_checkup" ? (
                  <TranscriptChatContextProvider key={`checkup-${gate.chatId}-${gate.gateId}`} value={{ chatId: gate.chatId, projectId: gate.projectId }}>
                    <MemoryCheckupGate
                      message={gate.message}
                      stepNumber={reviewSteps.checkup}
                      surface="board"
                      requireAllRows
                      boardResolution={{ taskId: overlay.taskId!, chatId: gate.chatId, gateId: gate.gateId }}
                      onRespond={async () => { await overlay.onBacklogChanged?.() }}
                    />
                  </TranscriptChatContextProvider>
                ) : null)
              : null}
            {!overlay?.focusedReview && (overlay?.status?.backlog.checkups.length ?? 0) === 0 ? (
              <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Step 3 · Review Suggested Changes to Existing Memories</span>
                <span className="ml-1">✓ No pending suggested changes.</span>
              </div>
            ) : null}
          </section>

          {sections.activeLibrary && needsAttention.length > 0 ? (
            <section className="mb-6 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
              <h2 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-foreground">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                Needs attention · <span className="text-muted-foreground">{needsAttention.length} {needsAttention.length === 1 ? "conflict" : "conflicts"} to resolve</span>
              </h2>
              <div className="flex flex-col gap-3">
                {needsAttention.map(({ memory: contested, supersededBy }) => (
                  <div key={contested.id} className="rounded-md border border-border bg-card p-3">
                    <div className="flex items-start justify-between gap-3">
                      <button type="button" className="min-w-0 text-left text-sm text-foreground line-through decoration-muted-foreground/60" onClick={() => setSelectedId(contested.id)}>
                        {contested.content}
                      </button>
                      <Button variant="ghost" size="sm" onClick={() => void archiveContested(contested).catch(() => {})}>
                        <Trash2 className="h-4 w-4" /> Archive older memory
                      </Button>
                    </div>
                    {supersededBy.map((next) => (
                      <p key={next.id} className="mt-1 text-xs text-muted-foreground">superseded by: <span className="text-foreground">{next.content}</span></p>
                    ))}
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {sections.archived && archivedItems.length > 0 ? (
            <section className="mt-8 border-t border-border pt-4">
              <button
                type="button"
                onClick={() => setShowArchived((v) => !v)}
                className="flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <Archive className="h-4 w-4" />
                Archived
                <span className="text-muted-foreground/70">{archivedItems.length}</span>
                <ChevronRight className={cn("h-4 w-4 transition-transform", showArchived && "rotate-90")} />
              </button>
              {showArchived ? (
                <div className="mt-3 flex flex-col gap-1.5">
                  {archivedItems.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center gap-2 rounded-xl border border-border/60 bg-muted/20 px-3 py-1.5 text-sm"
                    >
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{item.id}</span>
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">{item.content}</span>
                      {originLabelFor(item) ? (
                        <span className="hidden shrink-0 text-[11px] text-muted-foreground/70 sm:inline">{originLabelFor(item)}</span>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="shrink-0"
                        disabled={restoringId === item.id}
                        onClick={() => void handleRestore(item.id)}
                      >
                        {restoringId === item.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <ArchiveRestore className="h-3.5 w-3.5" />
                        )}
                        Restore
                      </Button>
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}

          {sections.muted ? <section className={cn("pt-4", archivedItems.length === 0 && "mt-8 border-t border-border")}>
            <button
              type="button"
              onClick={() => setShowMuted((v) => !v)}
              className="flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <X className="h-4 w-4" />
              Muted proposals
              {muted ? <span className="text-muted-foreground/70">{muted.length}</span> : null}
              <ChevronRight className={cn("h-4 w-4 transition-transform", showMuted && "rotate-90")} />
            </button>
            {showMuted ? (
              muted === null ? (
                <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
                </p>
              ) : muted.length === 0 ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  Nothing muted. Dismissing a capture proposal mutes exact re-proposals of it; they'd show up here.
                </p>
              ) : (
                <div className="mt-3 flex flex-col gap-1.5">
                  {muted.map((m) => (
                    <div
                      key={m.memoryId}
                      className="flex items-center gap-2 rounded-xl border border-border/60 bg-muted/20 px-3 py-1.5 text-sm"
                    >
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">
                        {m.content ?? `(content no longer available — ${m.memoryId})`}
                      </span>
                      <span className="hidden shrink-0 text-[11px] text-muted-foreground/70 sm:inline">
                        muted {new Date(m.dismissedAt).toLocaleDateString()}
                      </span>
                      {m.canUnmute ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="shrink-0"
                          disabled={unmutingId === m.memoryId}
                          onClick={() => void handleUnmute(m.memoryId)}
                        >
                          {unmutingId === m.memoryId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                          Unmute
                        </Button>
                      ) : (
                        <span
                          className="shrink-0 text-[11px] font-medium text-muted-foreground"
                          title="Sensitive content was erased and cannot be restored"
                        >
                          Permanently removed
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )
            ) : null}
          </section> : null}

          {/* Markdown sync (DG5, 2026-08-19 I1): kept for expert users, parked
              at the bottom of the board — never competes with the review lanes. */}
          {sections.markdown ? <MarkdownSyncCard
            onSynced={(newIds) => {
              void loadAll()
              refreshNeedsAttention()
              if (newIds?.length) setFreshCandidates({ ids: new Set(newIds), at: Date.now() })
            }}
          /> : null}
        </div>
      </div>

      {transferRequest ? (
        <TransferMemoryDialog
          item={transferRequest.item}
          open
          onOpenChange={(open) => {
            if (!open) setTransferRequest(null)
          }}
          initialTarget={transferRequest.target}
          // A drag reads as "move", not "copy".
          defaultArchiveOriginal
          surface="board"
          onDone={(created) => {
            setTransferRequest(null)
            // Make the landing visible: if the new item lives outside the
            // current project lens, widen the lens; then open its detail so
            // the user sees exactly WHERE it landed.
            if (created.scope === "project" && projectFilter && created.projectId !== projectFilter) {
              setProjectFilter(null)
            }
            setSelectedId(created.id)
          }}
        />
      ) : null}

      {selectedItem ? (
        <aside className="w-[400px] shrink-0 overflow-hidden border-l border-border bg-background">
          <MemoryDetailPanel
            item={selectedItem}
            allItems={items}
            chatId={telemetryChatId}
            onClose={() => setSelectedId(null)}
            onUpdated={upsertLocal}
            onAccept={acceptCandidate}
            onArchive={discard}
            surface="board"
          />
        </aside>
      ) : null}
    </div>
  )
}
