import { translateUiText } from "../i18n/uiText"
import { t, useI18n, getLocale } from "../i18n"
import { MEMORY_CARD } from "../components/memory/MemorySurface"
// Memory Board — the user's memories as operable objects (SPEC §4.9): a
// candidate-review lane, three scope columns (Personal/Project/Session) with
// drag-to-rescope, free-text search across every lane, and a right-side
// detail panel with per-item history + rollback (§4.11, option 乙). Ported
// (functionality) from MemoSync, re-implemented in Kanna's visual language.
// State via the memoryStore; mutations via memoriesApi.
import { AlertTriangle, ArchiveRestore, ArrowLeft, ChevronRight, Clock3, Inbox, Loader2, Plus, Trash2, X } from "lucide-react"
import type { DragEvent } from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { MarkdownSyncCard } from "../components/memory/MarkdownSyncCard"
import { MemoryExplorer, memoryMatchesLens, type MemoryLens } from "../components/memory/MemoryExplorer"
import { MemoryGraphCanvas, memoryGraphLegend } from "../components/memory/MemoryGraphCanvas"
import { buildMemoryGraph } from "../lib/memoryGraph"
import { isPastExpiry } from "../lib/memoryExpiry"
import { driftedFileRefs } from "../lib/memoryFileDrift"
import { MemoryCard } from "../components/memory/MemoryCard"
import { MemoryDetailPanel } from "../components/memory/MemoryDetailPanel"
import { MemoryLegendButton } from "../components/memory/MemoryLegend"
import { NativeMemoryImportDialog } from "../components/memory/NativeMemoryImportDialog"
import { MemorySettingsBanner } from "../components/memory/MemorySettingsBanner"
import { SCOPE_ICONS, scopeRingClasses, SCOPES } from "../components/memory/ScopeBadge"
import { TransferMemoryDialog, type TransferInitialTarget } from "../components/memory/TransferMemoryDialog"
import {
  candidateReviewCohortItems,
  extendCandidateReviewCohort,
  FocusedMemoryCandidateStep,
  FocusedMemoryReviewStation,
} from "../components/messages/MemoryChangesReviewFlow"
import { MemoryCandidateReviewStation } from "../components/messages/MemoryProposalsGate"
import { Button } from "../components/ui/button"
import { SegmentedControl } from "../components/ui/segmented-control"
import { Textarea } from "../components/ui/textarea"
import { parseBoardFocus } from "../lib/boardFocus"
import { freshnessSince, getLastBoardVisit, markBoardVisit } from "../lib/boardVisit"
import {
  memoriesApi,
  recordUiMonitor,
  type CreateMemoryBody,
  type MemoryItem,
  type MemoryScope,
  type MutedProposal,
} from "../lib/memoriesApi"
import { memoryScopeLabel } from "../lib/memoryCitations"
import { cn } from "../lib/utils"
import { workspaceApi } from "../lib/workspaceApi"
import { useMemoryStore } from "../stores/memoryStore"
import type { FocusedMemoryReviewController } from "./memory/MemoryBoardLauncher"

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

type MemoryBoardView = "graph" | "board"
const BOARD_VIEW_STORAGE_KEY = "memosync:memory-view"

function readStoredBoardView(): MemoryBoardView {
  try {
    return window.localStorage.getItem(BOARD_VIEW_STORAGE_KEY) === "board" ? "board" : "graph"
  } catch {
    return "graph"
  }
}

export interface MemoryBoardOverlayMode {
  chatId?: string
  focusedReview?: FocusedMemoryReviewController
  initialLens?: "archived"
  memoryId?: string
  onClose?: () => void
  onChanged?: () => void
}

const SCOPE_DOTS: Record<MemoryScope, string> = {
  personal: "bg-personal",
  project: "bg-project",
  session: "bg-session",
}

export function memoryBoardSectionVisibility() {
  return {
    candidates: true,
    searchAndCreate: true,
    activeLibrary: true,
    archived: true,
    muted: true,
    markdown: true,
    workingMemory: false,
  }
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
  useI18n()
  const items = useMemoryStore((s) => s.items)
  const status = useMemoryStore((s) => s.status)
  const error = useMemoryStore((s) => s.error)
  const loadAll = useMemoryStore((s) => s.loadAll)
  const upsertLocal = useMemoryStore((s) => s.upsertLocal)
  const removeLocal = useMemoryStore((s) => s.removeLocal)
  const hasFocusedReview = Boolean(overlay?.focusedReview)
  const sections = memoryBoardSectionVisibility()
  const [creating, setCreating] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const boardRootRef = useRef<HTMLDivElement>(null)
  const focusedMemoryIdRef = useRef<string | undefined>(undefined)
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
  const [lens, setLens] = useState<MemoryLens>(() => {
    if (overlay?.initialLens === "archived") return { kind: "archived" }
    const project = new URLSearchParams(window.location.search).get("project")
    return project ? { kind: "project", id: project } : { kind: "all" }
  })
  const [view, setView] = useState<MemoryBoardView>(() => (overlay ? "board" : readStoredBoardView())) // Inside a chat you're here to review and drag.
  const [reviewOpen, setReviewOpen] = useState(false)
  const changeView = useCallback((next: MemoryBoardView) => {
    setView(next)
    try {
      window.localStorage.setItem(BOARD_VIEW_STORAGE_KEY, next)
    } catch {
      // A remembered tab is a convenience; the switch still works without it.
    }
  }, [])
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
    void loadAll({ syncFileRefs: true })
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
      void loadAll({ syncFileRefs: true })
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

  useEffect(() => {
    const id = overlay?.memoryId
    if (!id) { focusedMemoryIdRef.current = undefined; return }
    if (focusedMemoryIdRef.current === id || status !== "ready") return
    // The mount refresh may have begun after this render captured its snapshot.
    const current = useMemoryStore.getState()
    if (current.status !== "ready") return
    focusedMemoryIdRef.current = id
    const target = current.items.find((item) => item.id === id)
    setQuery("")
    setView("board")
    setLens({ kind: target?.status === "archived" ? "archived" : "all" })
    setSelectedId(target?.id ?? null)
    setActionError(target ? null : `${id} · ${t("memory:noLongerAvailable")}`)
  }, [overlay?.memoryId, items, status])
  useEffect(() => {
    if (!selectedId || selectedId !== overlay?.memoryId) return
    const row = Array.from(boardRootRef.current?.querySelectorAll<HTMLElement>("[data-memory-board-id]") ?? [])
      .find((element) => element.dataset.memoryBoardId === selectedId)
    row?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [selectedId, overlay?.memoryId, lens, view])

  const boardModel = useMemo(
    () => deriveMemoryBoardModel(items, { query, projectFilter: null }),
    [items, query],
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
    () => items.filter((m) => m.status === "archived" && matchesQuery(m, query)),
    [items, query],
  )
  const [restoringId, setRestoringId] = useState<string | null>(null)
  // Muted proposals (dismissal fingerprints): loaded lazily on expand.
  const showMuted = lens.kind === "muted"
  const [muted, setMuted] = useState<MutedProposal[] | null>(null)
  const [unmutingId, setUnmutingId] = useState<string | null>(null)
  useEffect(() => {
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
  const handleRestore = useCallback(async (item: MemoryItem) => {
    const id = item.id
    setRestoringId(id)
    try {
      const updated = await memoriesApi.update(id, { status: "active", ...(isPastExpiry(item.expiresAt) ? { expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() } : {}) }, { surface: "board" })
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
      setReviewOpen(true)
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
  const boardItemsByScope = useMemo(
    () => deriveMemoryBoardModel(items.filter((item) => memoryMatchesLens(item, lens)), { query, projectFilter: null }).scopes,
    [items, lens, query],
  )
  const graph = useMemo(() => buildMemoryGraph(items, {
    root: t("board:graphRoot"),
    personal: t("common:personal"),
    projects: originTitles.projects,
    chats: originTitles.chats,
    chatProjects,
  }), [items, originTitles, chatProjects])
  const graphHighlight = useMemo(() => {
    if (lens.kind === "all" && !query.trim()) return null
    const lit = new Set<string>()
    if (lens.kind === "project") lit.add(`project:${lens.id}`)
    if (lens.kind === "session") lit.add(`session:${lens.id}`)
    if (lens.kind === "scope" && lens.scope === "personal") lit.add("personal")
    for (const node of graph.nodes) {
      if (lens.kind === "scope" && node.kind === "hub" && node.scope === lens.scope) lit.add(node.id)
      if (!node.item || !memoryMatchesLens(node.item, lens) || !matchesQuery(node.item, query)) continue
      lit.add(node.id)
      if (node.item.scope === "personal") lit.add("personal")
      if (node.item.scope === "project" && node.item.projectId) lit.add(`project:${node.item.projectId}`)
      if (node.item.scope === "session" && node.item.sessionId) lit.add(`session:${node.item.sessionId}`)
    }
    return lit
  }, [graph, lens, query])
  const liveMemoryCount = items.filter((item) => item.status === "active").length
  const relationCount = graph.edges.filter((edge) => edge.kind === "relation").length
  const visibleScopes: MemoryScope[] = lens.kind === "scope"
    ? [lens.scope]
    : lens.kind === "project"
      ? ["project"]
      : lens.kind === "session"
        ? ["session"]
        : SCOPES
  const openReview = useCallback(() => {
    setReviewOpen(true)
    candidatesSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
    setFlashCandidates(true)
    window.clearTimeout(flashTimerRef.current)
    flashTimerRef.current = window.setTimeout(() => setFlashCandidates(false), 1800)
  }, [])
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
      overlay?.onChanged?.()
    } catch (err) {
      // Surface the failure — the Board's direct actions used to swallow every
      // error, so a failed create/accept/dismiss just did nothing (BUG MEMUI-2).
      setActionError(err instanceof Error ? err.message : t("board:couldnTCreateTheMemory"))
    } finally {
      setBusy(false)
    }
  }

  async function acceptCandidate(
    item: MemoryItem,
    reviewedPatch?: Partial<CreateMemoryBody> & { status: "active" },
  ) {
    try {
      const updated = await memoriesApi.update(item.id, reviewedPatch ?? { status: "active" }, { surface: "board" })
      upsertLocal(updated)
      setActionError(null)
      overlay?.onChanged?.()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("board:couldnTAcceptTheMemory"))
      throw err
    }
  }
  async function discard(item: MemoryItem) {
    try {
      await memoriesApi.remove(item.id, { surface: "board" })
      removeLocal(item.id)
      setActionError(null)
      overlay?.onChanged?.()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("board:couldnTDismissTheMemory"))
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
      overlay?.onChanged?.()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("board:couldnTArchiveTheMemory"))
      throw err
    }
  }

  // Project/Session columns read best grouped by what they bind to — a flat
  // mixed list hides "whose memory is this" exactly when several projects
  // or chats coexist. Personal stays flat (one owner).
  function groupCardsByOrigin(
    scope: MemoryScope,
    list: MemoryItem[],
  ): Array<{ key: string; label: string | null; items: MemoryItem[] }> {
    if (scope === "personal") return list.length > 0 ? [{ key: "personal", label: null, items: list }] : []
    const groups = new Map<string, MemoryItem[]>()
    // A newly created chat is already a valid Session binding even before it
    // owns any Session memory. Keep that empty target visible so a user
    // can move a Project memory into the current session from the chat-bound Board.
    if (scope === "session" && overlay?.chatId) groups.set(overlay.chatId, [])
    for (const item of list) {
      const key = (scope === "project" ? item.projectId : item.sessionId) ?? "unassigned"
      const bucket = groups.get(key)
      if (bucket) bucket.push(item)
      else groups.set(key, [item])
    }
    return [...groups.entries()].map(([key, items]) => {
      if (key === "unassigned") return { key, label: t("board:unassigned"), items }
      if (scope === "project") return { key, label: originTitles.projects[key] ?? key, items }
      // Session groups carry their PROJECT of origin too — a chat title alone
      // doesn't say which project's context the memory belongs to.
      const chatTitle = originTitles.chats[key]
      const chatLabel = key === overlay?.chatId
        ? (chatTitle ? t("board:currentSessionValue0", { v0: chatTitle }) : t("board:currentSession"))
        : (chatTitle ?? key)
      const projectTitle = chatProjects[key] ? originTitles.projects[chatProjects[key]] : undefined
      return { key, label: projectTitle ? `${chatLabel} · ${projectTitle}` : chatLabel, items }
    })
  }

  function renderScopedCard(item: MemoryItem, scope: MemoryScope) {
    return (
      <div key={item.id} data-memory-board-id={item.id} onMouseEnter={() => recordBoardHover(item.id)}>
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
              aria-label={t("board:archiveMemory")}
              className="text-muted-foreground hover:text-destructive"
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
        className="rounded-xl border border-dashed border-cand-border bg-cand-surface/35 px-3 py-3"
        onMouseEnter={() => recordBoardHover(item.id)}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold text-cand-fg">{t("board:proposedDestination")}</span>
          <span className="font-mono text-[11px] text-muted-foreground">{item.id}</span>
        </div>
        <p className="mt-1.5 whitespace-pre-wrap text-sm text-foreground">{item.content}</p>
        <p className="mt-2 text-[11px] text-muted-foreground">{t("board:reviewThisProposalInStep1Above")}</p>
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

  return (
    <div ref={boardRootRef} className="memory-ui @container/board relative flex min-h-0 min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto px-3 pb-3 pt-2 @xl/board:px-5 @xl/board:pb-4" onScroll={recordBoardScroll}>
        <div className="mx-auto flex w-full max-w-[1320px] flex-1 flex-col">
          <MemorySettingsBanner />
          <header className={cn("mb-2 flex min-h-8 flex-wrap items-center gap-2", !overlay && "md:group-data-[sidebar-collapsed=true]/app:pl-9 desktop-mac:md:group-data-[sidebar-collapsed=true]/app:pl-[108px]")}>
            {/* The full-page board needs an explicit way back.
                Overlay mode has no route to go back to. */}
            {overlay ? null : (
              <Button
                variant="ghost"
                size="sm"
                aria-label={t("common:back")}
                className="-ml-1 size-8 shrink-0 px-0 text-muted-foreground"
                onClick={() => (window.history.length > 1 ? navigate(-1) : navigate("/"))}
              >
                <ArrowLeft className="size-4" />
              </Button>
            )}
            {/* One line, so the title sits on the same band as the window's top controls. */}
            <div className="flex min-w-0 flex-1 basis-40 items-baseline gap-2.5">
              <h1 className="shrink-0 text-[15px] font-semibold tracking-[-0.01em] text-foreground">
                {t("common:memory")}</h1>
              <p className="min-w-0 truncate text-[13px] text-muted-foreground">
                {hasFocusedReview
                    ? t("board:reviewTheLiveChatSuggestionsAndTheSameCanonicalSaved")
                    : t("board:memoryScreenSubtitle")}
              </p>
            </div>
            {sections.searchAndCreate ? <MemoryLegendButton /> : null}
            {sections.searchAndCreate ? (
              <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
                {t("nativeMemory:entry")}
              </Button>
            ) : null}
            {sections.searchAndCreate ? (
              <Button variant="default" size="sm" onClick={() => setCreating((v) => !v)}>
                <Plus className="size-4" /> {t("board:newMemory")}</Button>
            ) : null}
            {overlay?.onClose ? (
              <Button
                variant="ghost"
                size="sm"
                aria-label={t("common:close")}
                className="size-8 shrink-0 px-0"
                onClick={overlay.onClose}
              >
                <X className="size-4" />
              </Button>
            ) : null}
          </header>

          {status === "loading" && items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("board:loadingMemories")}</p>
          ) : null}
          {status === "error" ? <p className="text-sm text-destructive">{t("board:failedToLoadMemories")}{translateUiText(error)}</p> : null}
          {actionError ? (
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3 rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              <span>{actionError}</span>
              <button type="button" className="shrink-0 underline underline-offset-2" onClick={() => setActionError(null)}>{t("common:dismiss")}</button>
            </div>
          ) : null}

          {/* Nothing pending, nothing shown: the explorer's "To review" row carries the quiet state. */}
          <section
            ref={candidatesSectionRef}
            data-board-candidates="true"
            data-memory-board-section="candidates"
            className={cn(
              "scroll-mt-4 rounded-lg transition-shadow duration-700",
              (overlay?.focusedReview || candidateReviewItems.length > 0) && "mb-3",
              flashCandidates && "ring-2 ring-primary/50 ring-offset-8 ring-offset-background",
            )}
          >
            {overlay?.focusedReview ? (
              <FocusedMemoryCandidateStep
                controller={overlay.focusedReview}
                items={items}
                cohortIds={candidateReviewCohortIds}
                onChanged={overlay.onChanged}
              />
            ) : candidateReviewItems.length > 0 ? (
              <div className={MEMORY_CARD}>
                {/* The map stays in view until you choose to start reviewing. */}
                <button
                  type="button"
                  aria-expanded={reviewOpen}
                  className="flex w-full items-center gap-2 text-left"
                  onClick={() => setReviewOpen((open) => !open)}
                >
                  <Inbox aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <h2 className="text-[13px] font-medium text-foreground">{t("board:reviewNewMemoryCandidates")}</h2>
                  <span className="text-xs text-muted-foreground">{t("memory:inReview", { count: candidateReviewItems.length })}</span>
                  <ChevronRight className={cn("ml-auto size-4 text-muted-foreground transition-transform duration-150", reviewOpen && "rotate-90")} />
                </button>
                {reviewOpen ? (
                  <div className="mt-3">
                    <MemoryCandidateReviewStation
                      candidates={candidateReviewItems}
                      freshAt={freshCandidates.at || undefined}
                      surface="board"
                      allowRestore
                      onChanged={overlay?.onChanged}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>

          {sections.activeLibrary && needsAttention.length > 0 ? (
            <section className="mb-3 rounded-xl border border-cand-border bg-cand-surface dark:bg-cand-surface p-3">
              <h2 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-foreground">
                <AlertTriangle className="h-4 w-4 text-cand-fg dark:text-cand-fg" />
                {t("board:needsAttention")}<span className="text-muted-foreground">{t("board:unresolvedConflicts", { count: needsAttention.length })}</span>
              </h2>
              <div className="flex flex-col gap-3">
                {needsAttention.map(({ memory: contested, supersededBy }) => (
                  <div key={contested.id} className="rounded-lg border border-border/70 bg-background/60 dark:bg-muted/40 p-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <button type="button" className="min-w-0 flex-1 basis-48 text-left text-sm text-foreground line-through decoration-muted-foreground/60" onClick={() => setSelectedId(contested.id)}>
                        {contested.content}
                      </button>
                      <Button variant="ghost" size="sm" className="ml-auto text-destructive hover:text-destructive" onClick={() => void archiveContested(contested).catch(() => {})}>
                        <Trash2 className="h-4 w-4" /> {t("board:archiveOlderMemory")}</Button>
                    </div>
                    {supersededBy.map((next) => (
                      <p key={next.id} className="mt-1 text-xs text-muted-foreground">{t("board:supersededBy")}<span className="text-foreground">{next.content}</span></p>
                    ))}
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {sections.searchAndCreate && creating ? (
              <div className="mb-3 rounded-xl bg-card p-4 shadow-card">
                <Textarea
                  value={draft.content}
                  onChange={(e) => setDraft((d) => ({ ...d, content: e.target.value }))}
                  placeholder={t("board:oneConciseActionableMemory")}
                  className="mb-3 min-h-20"
                />
                <Textarea
                  value={draft.detail}
                  onChange={(e) => setDraft((d) => ({ ...d, detail: e.target.value }))}
                  placeholder={t("board:detailedFormOptionalLoadedOnDemandByTheAgent")}
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
                      <option value="">{t("board:chooseProject")}</option>
                      {Object.entries(originTitles.projects).map(([pid, title]) => (
                        <option key={pid} value={pid}>{title}</option>
                      ))}
                    </select>
                  ) : null}
                  <div className="ml-auto flex items-center gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>{t("common:cancel")}</Button>
                    <Button
                      variant="default"
                      size="sm"
                      disabled={busy || !draft.content.trim() || (draft.scope === "project" && !draft.projectId)}
                      onClick={() => void handleCreate()}
                    >
                      {t("common:create")}</Button>
                  </div>
                </div>
              </div>
            ) : null}


          <section
            data-memory-board-section="library"
            className="mb-1 grid min-h-[560px] flex-1 grid-rows-[auto_minmax(420px,1fr)] overflow-hidden rounded-2xl bg-card shadow-card @3xl/board:grid-cols-[232px_minmax(0,1fr)] @3xl/board:grid-rows-1"
          >
            <div className="flex max-h-56 min-h-0 flex-col border-b border-border @3xl/board:max-h-none @3xl/board:border-b-0 @3xl/board:border-r">
              <MemoryExplorer
                items={items}
                lens={lens}
                onLensChange={setLens}
                query={query}
                onQueryChange={setQuery}
                projectTitles={originTitles.projects}
                chatTitles={originTitles.chats}
                pendingCount={candidates.length}
                archivedCount={archivedItems.length}
                mutedCount={muted?.length ?? null}
                onOpenReview={openReview}
              />
            </div>

            <div className="flex min-h-0 min-w-0 flex-col">
              <div className="flex h-11 shrink-0 items-center gap-3 border-b border-border px-3">
                {lens.kind === "archived" || lens.kind === "muted" || lens.kind === "files" ? (
                  <h2 className="text-[13px] font-medium text-foreground">
                    {lens.kind === "archived" ? t("board:archived") : lens.kind === "muted" ? t("board:mutedProposals") : t("memory:memoryFiles")}
                  </h2>
                ) : (
                  <>
                  {lens.kind === "expiring" ? <h2 className="text-[13px] font-medium text-foreground">{t("memory:expiringSoon")}</h2> : null}
                  {lens.kind === "drift" ? <h2 className="text-[13px] font-medium text-foreground">{t("memory:needsFileCheck")}</h2> : null}
                  <SegmentedControl<MemoryBoardView>
                    size="sm"
                    value={view}
                    onValueChange={changeView}
                    options={[
                      { value: "graph", label: t("board:graphView") },
                      { value: "board", label: t("board:boardView") },
                    ]}
                  />
                  </>
                )}
                <p className="ml-auto truncate text-xs tabular-nums text-muted-foreground">
                  {lens.kind === "archived"
                    ? t("board:memoryCount", { count: archivedItems.length })
                    : lens.kind === "muted" || lens.kind === "files"
                      ? null
                      : view === "graph"
                        ? `${t("board:memoryCount", { count: liveMemoryCount })} · ${t("board:relationCount", { count: relationCount })}`
                        : t("board:memoryCount", { count: liveMemoryCount })}
                </p>
              </div>

              {lens.kind === "archived" ? (
                <div className="min-h-0 flex-1 overflow-y-auto p-3">
                  {archivedItems.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  {archivedItems.map((item) => (
                    <div
                      key={item.id}
                      data-memory-board-id={item.id}
                      className={cn("flex items-center gap-2 rounded-lg border border-border/70 bg-background/60 dark:bg-muted/40 px-3 py-1.5 text-sm", selectedId === item.id && cn("ring-2", scopeRingClasses(item.scope)))}
                    >
                      <button type="button" onClick={() => setSelectedId(item.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left hover:text-foreground">
                        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{item.id}</span>
                        <span className="min-w-0 truncate text-muted-foreground">{item.content}</span>
                      </button>
                      {isPastExpiry(item.expiresAt) ? <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-cand-fg"><Clock3 className="h-3 w-3" />{t("memory:expiredDate", { date: new Date(item.expiresAt!).toLocaleDateString(getLocale()) })}</span> : null}
                      {originLabelFor(item) ? (
                        <span className="hidden shrink-0 text-[11px] text-muted-foreground/70 sm:inline">{originLabelFor(item)}</span>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="shrink-0"
                        disabled={restoringId === item.id}
                        onClick={() => void handleRestore(item)}
                      >
                        {restoringId === item.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <ArchiveRestore className="h-3.5 w-3.5" />
                        )}
                        {isPastExpiry(item.expiresAt) ? t("memory:restoreForSevenDays") : t("common:restore")}</Button>
                    </div>
                  ))}
                </div>
                  ) : <p className="py-12 text-center text-[13px] text-muted-foreground">{t("board:nothingArchived")}</p>}
                </div>
              ) : lens.kind === "muted" ? (
                <div className="min-h-0 flex-1 overflow-y-auto p-3">
                  {muted === null ? (
                <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("common:loading")}</p>
              ) : muted.length === 0 ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  {t("board:nothingMutedDismissingACaptureProposalMutesExactReProposals")}</p>
              ) : (
                <div className="mt-3 flex flex-col gap-1.5">
                  {muted.map((m) => (
                    <div
                      key={m.memoryId}
                      className="flex items-center gap-2 rounded-lg border border-border/70 bg-background/60 dark:bg-muted/40 px-3 py-1.5 text-sm"
                    >
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">
                        {m.content ?? t("board:contentNoLongerAvailableValue0", { v0: m.memoryId })}
                      </span>
                      <span className="hidden shrink-0 text-[11px] text-muted-foreground/70 sm:inline">
                        {t("board:muted")}{new Date(m.dismissedAt).toLocaleDateString(getLocale())}
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
                          {t("board:unmute")}</Button>
                      ) : (
                        <span
                          className="shrink-0 text-[11px] font-medium text-muted-foreground"
                          title={t("board:sensitiveContentWasErasedAndCannotBeRestored")}
                        >
                          {t("board:permanentlyRemoved")}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
                </div>
              ) : lens.kind === "files" ? (
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {/* Markdown sync (DG5, 2026-08-19 I1): kept for expert users, one
                      click away in the explorer, never competing with the map. */}
                  <MarkdownSyncCard
                    embedded
                    onSynced={(newIds) => {
                      void loadAll()
                      refreshNeedsAttention()
                      if (newIds?.length) setFreshCandidates({ ids: new Set(newIds), at: Date.now() })
                    }}
                  />
                </div>
              ) : lens.kind === "drift" && !items.some(item => (item.status === "active" || item.status === "candidate") && driftedFileRefs(item).length > 0) ? (
                <p className="p-3 text-xs text-muted-foreground">{t("memory:nothingToCheck")}</p>
              ) : view === "graph" ? (
                <div className="min-h-0 flex-1">
                  <MemoryGraphCanvas
                    nodes={graph.nodes}
                    edges={graph.edges}
                    highlight={graphHighlight}
                    selectedId={selectedId}
                    onSelectMemory={setSelectedId}
                    onHoverMemory={recordBoardHover}
                    legend={memoryGraphLegend({
                      personal: t("common:personal"),
                      project: t("common:project"),
                      session: t("common:session"),
                      candidate: t("board:toReview"),
                    })}
                    ariaLabel={t("board:graphAriaLabel")}
                    zoomInLabel={t("board:zoomIn")}
                    zoomOutLabel={t("board:zoomOut")}
                    fitLabel={t("board:fitGraph")}
                    emptyHint={liveMemoryCount === 0 && candidates.length === 0 ? t("board:graphEmpty") : undefined}
                  />
                </div>
              ) : (
                <div className="@container/library min-h-0 flex-1 overflow-y-auto p-3">
            <div className={cn("grid items-start gap-3", visibleScopes.length > 1 && "@3xl/library:grid-cols-3")}>
              {visibleScopes.map((scope) => {
                const entries = boardItemsByScope[scope]
                const list = entries.map((entry) => entry.item)
                const groups = groupCardsByOrigin(scope, list)
                const isDropTarget = (DROP_SCOPES as MemoryScope[]).includes(scope)
                return (
                  <section
                    key={scope}
                    className={cn(
                      "flex min-h-40 flex-col gap-2 rounded-xl bg-muted/70 p-2 transition-shadow",
                      isDropTarget && activeDrop === `col:${scope}` && cn("ring-2", scopeRingClasses(scope)),
                    )}
                    onDragOver={isDropTarget ? (event) => handleZoneDragOver(event, `col:${scope}`) : undefined}
                    onDrop={isDropTarget ? (event) => handleDropTarget(event, scope === "personal" ? { scope: "personal" } : { scope: "project" }) : undefined}
                  >
                    <div className="flex h-6 items-center gap-2 px-1 text-[13px] font-medium text-foreground">
                      <span aria-hidden className={cn("size-2 rounded-full", SCOPE_DOTS[scope])} />
                      {memoryScopeLabel(scope)}
                      <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">{list.length}</span>
                    </div>
                    {groups.length === 0 ? (
                      <p className="px-3 py-8 text-center text-xs leading-relaxed text-muted-foreground text-pretty">
                        {scope === "session"
                          ? t("board:sessionMemoriesAreCapturedByTheAgentInsideAChat")
                          : t("board:noValue0MemoriesYet", { v0: memoryScopeLabel(scope).toLowerCase() })}
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
                            <p className="truncate px-1 pt-1 text-[11px] font-medium text-muted-foreground">{group.label}</p>
                          ) : null}
                          {group.items.length === 0 && scope === "session" ? (
                            <p className="px-3 py-6 text-center text-xs text-muted-foreground text-pretty">
                              {t("board:dropAMemoryHereToKeepItOnlyForThis")}</p>
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
                </div>
              )}
            </div>
          </section>

          {overlay?.focusedReview ? (
            <section data-memory-board-section="transfer" className="mt-3 flex flex-col gap-3">
              <FocusedMemoryReviewStation controller={overlay.focusedReview} station="transfer" />
            </section>
          ) : null}

          {overlay?.focusedReview ? (
            <section data-memory-board-section="checkup" className="mt-3 flex flex-col gap-3">
              <FocusedMemoryReviewStation controller={overlay.focusedReview} station="checkup" />
            </section>
          ) : null}
        </div>
      </div>

      <NativeMemoryImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        projectId={lens.kind === "project" ? lens.id : undefined}
        onChanged={async () => { await loadAll(); overlay?.onChanged?.() }}
      />
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
            if (!memoryMatchesLens(created, lens)) setLens({ kind: "all" })
            setSelectedId(created.id)
          }}
        />
      ) : null}

      {selectedItem ? (
        <aside data-memory-detail-id={selectedItem.id} className="absolute inset-0 z-10 min-w-0 overflow-hidden bg-background @3xl/board:static @3xl/board:w-[400px] @3xl/board:shrink-0 @3xl/board:border-l @3xl/board:border-border">
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
