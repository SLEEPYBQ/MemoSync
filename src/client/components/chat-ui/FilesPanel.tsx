// Files workbench panel: Codex-style code viewing and editing. Open-file tabs
// on top, breadcrumb row beneath, CodeMirror editor with syntax highlighting
// in the main area, and a filterable lazy-loaded file tree on the right.
// Markdown keeps a rendered preview (toggle to source), images/PDF render
// inline, and text files are editable with ⌘S / save-button persistence.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import {
  DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent,
} from "@dnd-kit/core"
import { SortableContext, arrayMove, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import {
  Check, ChevronRight, Copy, ExternalLink, Eye, FilePlus, FolderPlus, FolderTree,
  Loader2, Pencil, RefreshCw, Save, Search, TextSearch, Trash2, X,
} from "lucide-react"
import { Button } from "../ui/button"
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
} from "../ui/context-menu"
import { cn } from "../../lib/utils"
import { classifyFilePreview, type FilePreviewKind } from "../../lib/filePreview"
import { recordStaticMemoryEditEntered } from "../../lib/memoriesApi"
import {
  ancestorDirs, baseName, dirName, filterIndexPaths, isSameOrUnder, nextActiveTab, remapPathAfterRename,
} from "../../lib/filesWorkbench"
import { markdownComponentsWithLinks } from "../messages/shared"
import { CodeEditor } from "./CodeEditor"
import { FileTypeIcon } from "./FileTypeIcon"
import { isStaticMemoryMarkdownPath } from "../../../shared/staticMemoryPath"

interface FilesPanelProps {
  projectId: string
  chatId?: string
  onClose?: () => void
}

interface FileEntry {
  name: string
  kind: "file" | "dir"
  size: number
}

type DirState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; entries: FileEntry[] }

interface FileBuffer {
  kind: FilePreviewKind
  status: "loading" | "ready" | "error"
  error?: string
  /** Last saved content; `current !== original` marks the buffer dirty. */
  original: string
  current: string
  saving: boolean
  saveError: string | null
  justSaved: boolean
  mdMode: "preview" | "source"
  /** Simple elapsed time starts at the first unsaved content change. */
  editStartedAtMs: number | null
  /** Stable across a failed-save retry so one participant edit is counted once. */
  editEventId: string | null
}

interface FileIndex {
  files: string[]
  truncated: boolean
}

interface ContentMatch {
  path: string
  line: number
  text: string
  col: number
}

/** One tab in the strip; drag to reorder (pointer must travel a few px so
 * plain clicks still select the tab). */
function SortableFileTab({
  path,
  isActive,
  dirty,
  onSelect,
  onClose,
}: {
  path: string
  isActive: boolean
  dirty: boolean
  onSelect: () => void
  onClose: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: path })
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "group flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs",
        isActive ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50",
        isDragging && "relative z-10 opacity-80 shadow-sm",
      )}
      onClick={onSelect}
      title={path}
    >
      <FileTypeIcon name={baseName(path)} className="size-3.5" />
      <span className="max-w-40 truncate">{baseName(path)}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        className={cn(
          "flex size-3.5 items-center justify-center rounded hover:bg-border",
          dirty ? "text-foreground" : "text-muted-foreground opacity-0 group-hover:opacity-100",
          isActive && "opacity-100",
        )}
        title={dirty ? "Unsaved changes — close" : "Close"}
      >
        {dirty ? <span className="block size-1.5 rounded-full bg-current" /> : <X className="size-3" />}
      </button>
    </div>
  )
}

/** Inline name input used for create-file / create-folder / rename rows. */
type TreeEdit =
  | { mode: "create-file" | "create-dir"; dir: string }
  | { mode: "rename"; path: string }

function TreeEditInput({
  initial,
  indentPx,
  selectStem = false,
  onCommit,
  onCancel,
}: {
  initial: string
  indentPx: number
  /** Rename: preselect only the stem so the extension survives typing.
   * Create: select everything — the initial is a throwaway placeholder. */
  selectStem?: boolean
  onCommit: (name: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <div className="flex items-center py-0.5 pr-2" style={{ paddingLeft: indentPx }}>
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onFocus={(e) => {
          const dot = selectStem ? e.target.value.lastIndexOf(".") : -1
          e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const name = value.trim()
            if (name) onCommit(name)
            else onCancel()
          }
          if (e.key === "Escape") onCancel()
        }}
        onBlur={onCancel}
        className="h-6 w-full min-w-0 rounded border border-ring bg-background px-1.5 text-[13px] text-foreground outline-none"
      />
    </div>
  )
}

const MAX_INLINE_TEXT_BYTES = 2 * 1024 * 1024
/** Below this panel width the tree and the editor swap instead of sharing. */
const NARROW_PANEL_PX = 560

function contentUrl(projectId: string, relPath: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(relPath)}/content`
}

function fetchFailMessage(err: unknown, fallback: string): string {
  return err instanceof TypeError
    ? "server unreachable — check your connection, then retry"
    : err instanceof Error
      ? err.message
      : fallback
}

export function FilesPanel({ projectId, chatId, onClose }: FilesPanelProps) {
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [tabs, setTabs] = useState<string[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [buffers, setBuffers] = useState<Map<string, FileBuffer>>(new Map())
  const [filter, setFilter] = useState("")
  const [index, setIndex] = useState<FileIndex | null>(null)
  const [indexError, setIndexError] = useState<string | null>(null)
  const [searchMode, setSearchMode] = useState<"files" | "content">("files")
  const [contentResults, setContentResults] = useState<{ results: ContentMatch[]; truncated: boolean } | null>(null)
  const [contentSearching, setContentSearching] = useState(false)
  const [contentError, setContentError] = useState<string | null>(null)
  const [treeEdit, setTreeEdit] = useState<TreeEdit | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<{ path: string; kind: "file" | "dir" } | null>(null)
  const [opError, setOpError] = useState<string | null>(null)
  const [reveal, setReveal] = useState<{ path: string; line: number; nonce: number } | null>(null)
  const [projectTitle, setProjectTitle] = useState<string | null>(null)
  const [isNarrow, setIsNarrow] = useState(false)
  // Narrow mode swaps between tree and editor; wide mode can hide the tree.
  const [narrowShowTree, setNarrowShowTree] = useState(true)
  const [wideShowTree, setWideShowTree] = useState(true)
  const [copied, setCopied] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const updateBuffer = useCallback((path: string, patch: Partial<FileBuffer>) => {
    setBuffers((prev) => {
      const existing = prev.get(path)
      if (!existing) return prev
      const next = new Map(prev)
      next.set(path, { ...existing, ...patch })
      return next
    })
  }, [])

  const updateBufferContent = useCallback((path: string, current: string) => {
    setBuffers((prev) => {
      const existing = prev.get(path)
      if (!existing) return prev
      const tracksStaticMemoryEdit = isStaticMemoryMarkdownPath(path)
      const nextEditEventId = !tracksStaticMemoryEdit || current === existing.original
        ? null
        : (existing.editEventId ?? `control:static-edit:${crypto.randomUUID()}`)
      if (nextEditEventId && existing.editEventId === null) {
        recordStaticMemoryEditEntered(nextEditEventId, chatId, path)
      }
      const next = new Map(prev)
      next.set(path, {
        ...existing,
        current,
        editStartedAtMs: !tracksStaticMemoryEdit || current === existing.original
          ? null
          : (existing.editStartedAtMs ?? Date.now()),
        editEventId: nextEditEventId,
      })
      return next
    })
  }, [chatId])

  const loadDir = useCallback(
    async (rel: string) => {
      setDirs((prev) => ({ ...prev, [rel]: { status: "loading" } }))
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files?dir=${encodeURIComponent(rel)}`)
        if (!res.ok) throw new Error(`listing failed (${res.status})`)
        const { data } = (await res.json()) as { data: { dir: string; entries: FileEntry[] } }
        setDirs((prev) => ({ ...prev, [rel]: { status: "ready", entries: data.entries } }))
      } catch (err) {
        setDirs((prev) => ({
          ...prev,
          [rel]: { status: "error", message: fetchFailMessage(err, "failed to list directory") },
        }))
      }
    },
    [projectId],
  )

  const loadIndex = useCallback(async () => {
    setIndexError(null)
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files/index`)
      if (!res.ok) throw new Error(`index failed (${res.status})`)
      const { data } = (await res.json()) as { data: FileIndex }
      setIndex(data)
    } catch (err) {
      setIndexError(fetchFailMessage(err, "failed to index files"))
    }
  }, [projectId])

  useEffect(() => {
    void loadDir("")
  }, [loadDir])

  // Project title for the breadcrumb root; non-fatal if it fails.
  useEffect(() => {
    let cancelled = false
    fetch("/api/projects")
      .then(async (res) => (res.ok ? ((await res.json()) as { data: Array<{ id: string; title: string }> }) : null))
      .then((body) => {
        if (cancelled || !body) return
        setProjectTitle(body.data.find((p) => p.id === projectId)?.title ?? null)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [projectId])

  // Track the panel's own width — it lives in a resizable pane, so viewport
  // breakpoints don't describe it.
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0
      if (width > 0) setIsNarrow(width < NARROW_PANEL_PX)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Lazily build the quick-open index the first time the filter is used.
  useEffect(() => {
    if (filter && index === null && indexError === null) void loadIndex()
  }, [filter, index, indexError, loadIndex])

  const activeBuffer = active ? (buffers.get(active) ?? null) : null
  const hasDirty = useMemo(
    () => [...buffers.values()].some((b) => b.status === "ready" && b.current !== b.original),
    [buffers],
  )

  // Fall back to the tree when the last tab closes in narrow mode.
  useEffect(() => {
    if (!active) setNarrowShowTree(true)
  }, [active])

  useEffect(() => {
    if (!hasDirty) return
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault()
    }
    window.addEventListener("beforeunload", guard)
    return () => window.removeEventListener("beforeunload", guard)
  }, [hasDirty])

  const openFile = useCallback(
    (path: string) => {
      setTabs((prev) => (prev.includes(path) ? prev : [...prev, path]))
      setActive(path)
      setNarrowShowTree(false)
      // Reveal in tree: expand ancestors and make sure their listings load.
      setExpanded((prev) => {
        const next = new Set(prev)
        for (const dir of ancestorDirs(path)) next.add(dir)
        return next
      })
      setBuffers((prev) => {
        if (prev.has(path)) return prev
        const kind = classifyFilePreview(baseName(path))
        const needsFetch = kind === "text" || kind === "markdown"
        const next = new Map(prev)
        next.set(path, {
          kind,
          status: needsFetch ? "loading" : "ready",
          original: "",
          current: "",
          saving: false,
          saveError: null,
          justSaved: false,
          mdMode: "preview",
          editStartedAtMs: null,
          editEventId: null,
        })
        return next
      })
    },
    [],
  )

  // Ensure ancestor dir listings exist for the active file (reveal-in-tree
  // after quick-open) — separate effect so openFile stays synchronous.
  useEffect(() => {
    if (!active) return
    for (const dir of ancestorDirs(active)) {
      if (!dirs[dir]) void loadDir(dir)
    }
  }, [active, dirs, loadDir])

  // Fetch text/markdown content for buffers that are still loading.
  useEffect(() => {
    const pending = [...buffers.entries()].filter(([, b]) => b.status === "loading")
    if (pending.length === 0) return
    let cancelled = false
    for (const [path] of pending) {
      fetch(contentUrl(projectId, path))
        .then(async (res) => {
          if (!res.ok) throw new Error(`load failed (${res.status})`)
          const length = Number(res.headers.get("content-length"))
          if (Number.isFinite(length) && length > MAX_INLINE_TEXT_BYTES) {
            throw new Error("file too large to open in the editor")
          }
          const text = await res.text()
          if (text.length > MAX_INLINE_TEXT_BYTES) throw new Error("file too large to open in the editor")
          return text
        })
        .then((text) => {
          if (!cancelled) updateBuffer(path, { status: "ready", original: text, current: text })
        })
        .catch((err) => {
          if (!cancelled) updateBuffer(path, { status: "error", error: fetchFailMessage(err, "failed to load file") })
        })
    }
    return () => {
      cancelled = true
    }
  }, [buffers, projectId, updateBuffer])

  const closeTab = useCallback(
    (path: string) => {
      const buffer = buffers.get(path)
      if (buffer && buffer.status === "ready" && buffer.current !== buffer.original) {
        if (!window.confirm(`Discard unsaved changes in ${baseName(path)}?`)) return
      }
      setActive((current) => nextActiveTab(tabs, path, current))
      setTabs((prev) => prev.filter((t) => t !== path))
      setBuffers((prev) => {
        const next = new Map(prev)
        next.delete(path)
        return next
      })
    },
    [buffers, tabs],
  )

  const saveFile = useCallback(
    async (path: string) => {
      const buffer = buffers.get(path)
      if (!buffer || buffer.status !== "ready" || buffer.saving) return
      if (buffer.current === buffer.original) return
      const content = buffer.current
      updateBuffer(path, { saving: true, saveError: null })
      try {
        const headers: Record<string, string> = { "Content-Type": "text/plain;charset=utf-8" }
        if (chatId) headers["X-MemoSync-Session-Id"] = chatId
        if (buffer.editStartedAtMs !== null) {
          headers["X-MemoSync-Edit-Duration-Ms"] = String(Math.max(0, Date.now() - buffer.editStartedAtMs))
        }
        if (buffer.editEventId) headers["X-MemoSync-Event-Id"] = buffer.editEventId
        const res = await fetch(contentUrl(projectId, path), {
          method: "PUT",
          headers,
          body: content,
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null
          throw new Error(body?.error ?? `save failed (${res.status})`)
        }
        updateBuffer(path, {
          saving: false,
          original: content,
          justSaved: true,
          editStartedAtMs: null,
          editEventId: null,
        })
        window.setTimeout(() => updateBuffer(path, { justSaved: false }), 1500)
      } catch (err) {
        updateBuffer(path, { saving: false, saveError: fetchFailMessage(err, "failed to save file") })
      }
    },
    [buffers, chatId, projectId, updateBuffer],
  )

  const refresh = useCallback(() => {
    void loadDir("")
    for (const dir of expanded) void loadDir(dir)
    setIndex(null)
    setIndexError(null)
    setContentResults(null)
  }, [expanded, loadDir])

  // Debounced project-wide content search (search-in-files mode).
  useEffect(() => {
    if (searchMode !== "content") return
    const q = filter.trim()
    if (q.length < 2) {
      setContentResults(null)
      setContentError(null)
      return
    }
    let cancelled = false
    setContentSearching(true)
    const timer = window.setTimeout(() => {
      fetch(`/api/projects/${encodeURIComponent(projectId)}/files/search?q=${encodeURIComponent(q)}`)
        .then(async (res) => {
          if (!res.ok) throw new Error(`search failed (${res.status})`)
          return (await res.json()) as { data: { results: ContentMatch[]; truncated: boolean } }
        })
        .then((body) => {
          if (cancelled) return
          setContentResults(body.data)
          setContentError(null)
        })
        .catch((err) => {
          if (!cancelled) setContentError(fetchFailMessage(err, "search failed"))
        })
        .finally(() => {
          if (!cancelled) setContentSearching(false)
        })
    }, 350)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [filter, searchMode, projectId])

  const openFileAt = useCallback(
    (path: string, line: number) => {
      openFile(path)
      // Line jumps need the source editor — markdown otherwise opens in preview.
      updateBuffer(path, { mdMode: "source" })
      setReveal((prev) => ({ path, line, nonce: (prev?.nonce ?? 0) + 1 }))
    },
    [openFile, updateBuffer],
  )

  const runFileOp = useCallback(
    async (body: { op: "create" | "mkdir" | "rename" | "delete"; path: string; toPath?: string }): Promise<boolean> => {
      setOpError(null)
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files/op`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
          throw new Error(payload?.error?.message ?? `${body.op} failed (${res.status})`)
        }
        return true
      } catch (err) {
        setOpError(fetchFailMessage(err, `${body.op} failed`))
        return false
      }
    },
    [projectId],
  )

  const startTreeEdit = useCallback(
    (edit: TreeEdit) => {
      setFilter("")
      setSearchMode("files")
      if (edit.mode !== "rename" && edit.dir) {
        setExpanded((prev) => {
          const next = new Set(prev)
          next.add(edit.dir)
          for (const anc of ancestorDirs(edit.dir)) next.add(anc)
          return next
        })
        if (!dirs[edit.dir]) void loadDir(edit.dir)
      }
      setTreeEdit(edit)
    },
    [dirs, loadDir],
  )

  // Radix restores focus to the trigger row when a context menu closes, which
  // would immediately blur (and cancel) the inline edit input. Suppress that
  // restore (see onCloseAutoFocus below) and defer entering edit mode until
  // the menu has finished closing.
  const pendingMenuEditRef = useRef(false)
  const startTreeEditAfterMenu = useCallback(
    (edit: TreeEdit) => {
      pendingMenuEditRef.current = true
      window.setTimeout(() => startTreeEdit(edit), 0)
    },
    [startTreeEdit],
  )
  const suppressMenuCloseFocus = useCallback((event: Event) => {
    if (pendingMenuEditRef.current) {
      event.preventDefault()
      pendingMenuEditRef.current = false
    }
  }, [])

  const commitTreeEdit = useCallback(
    async (name: string) => {
      if (!treeEdit) return
      setTreeEdit(null)
      const clean = name.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "")
      if (!clean) return

      if (treeEdit.mode === "rename") {
        const from = treeEdit.path
        const parent = dirName(from)
        const to = clean.includes("/") ? clean : parent ? `${parent}/${clean}` : clean
        if (to === from) return
        const done = await runFileOp({ op: "rename", path: from, toPath: to })
        if (!done) return
        setTabs((prev) => prev.map((t) => remapPathAfterRename(t, from, to)))
        setActive((prev) => (prev ? remapPathAfterRename(prev, from, to) : prev))
        setBuffers((prev) => {
          const next = new Map<string, FileBuffer>()
          for (const [p, b] of prev) next.set(remapPathAfterRename(p, from, to), b)
          return next
        })
        setExpanded((prev) => {
          const next = new Set<string>()
          for (const p of prev) next.add(remapPathAfterRename(p, from, to))
          return next
        })
        void loadDir(parent)
        const toParent = dirName(to)
        if (toParent !== parent) void loadDir(toParent)
        setIndex(null)
        return
      }

      const rel = treeEdit.dir ? `${treeEdit.dir}/${clean}` : clean
      const done = await runFileOp({ op: treeEdit.mode === "create-file" ? "create" : "mkdir", path: rel })
      if (!done) return
      // Reload every level the new path touches (subpaths auto-create dirs).
      void loadDir(treeEdit.dir)
      for (const anc of ancestorDirs(rel)) {
        setExpanded((prev) => new Set(prev).add(anc))
        void loadDir(anc)
      }
      if (treeEdit.mode === "create-file") openFile(rel)
      setIndex(null)
    },
    [treeEdit, runFileOp, loadDir, openFile],
  )

  const deleteEntry = useCallback(
    async (path: string) => {
      setConfirmDelete(null)
      const done = await runFileOp({ op: "delete", path })
      if (!done) return
      setTabs((prev) => prev.filter((t) => !isSameOrUnder(t, path)))
      setActive((prev) => (prev && isSameOrUnder(prev, path) ? null : prev))
      setBuffers((prev) => {
        const next = new Map(prev)
        for (const p of prev.keys()) if (isSameOrUnder(p, path)) next.delete(p)
        return next
      })
      void loadDir(dirName(path))
      setIndex(null)
    },
    [runFileOp, loadDir],
  )

  const toggleDir = useCallback(
    (rel: string) => {
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(rel)) {
          next.delete(rel)
        } else {
          next.add(rel)
        }
        return next
      })
      if (!dirs[rel]) void loadDir(rel)
    },
    [dirs, loadDir],
  )

  // A small travel distance keeps plain clicks selecting tabs; only an actual
  // drag starts reordering.
  const tabDndSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  const handleTabDragEnd = useCallback((event: DragEndEvent) => {
    const { active: dragged, over } = event
    if (!over || dragged.id === over.id) return
    setTabs((prev) => {
      const from = prev.indexOf(String(dragged.id))
      const to = prev.indexOf(String(over.id))
      if (from === -1 || to === -1) return prev
      return arrayMove(prev, from, to)
    })
  }, [])

  const copyActivePath = useCallback(() => {
    if (!active) return
    void navigator.clipboard?.writeText(active).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    })
  }, [active])

  const filterResults = useMemo(
    () => (filter && index ? filterIndexPaths(index.files, filter) : null),
    [filter, index],
  )

  const showTree = isNarrow ? narrowShowTree : wideShowTree
  const showMain = !isNarrow || !narrowShowTree
  const activeIsDirty =
    activeBuffer?.status === "ready" && activeBuffer.current !== activeBuffer.original

  // --- tree rendering -------------------------------------------------------

  const renderDirEntries = (rel: string, depth: number): ReactNode => {
    const state = dirs[rel]
    if (!state || state.status === "loading") {
      return (
        <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground" style={{ paddingLeft: depth * 12 + 8 }}>
          <Loader2 className="size-3 animate-spin" /> loading…
        </div>
      )
    }
    if (state.status === "error") {
      return (
        <div className="flex items-center gap-2 px-2 py-1 text-xs text-destructive" style={{ paddingLeft: depth * 12 + 8 }}>
          <span className="truncate">{state.message}</span>
          <button type="button" className="shrink-0 underline hover:text-foreground" onClick={() => void loadDir(rel)}>
            retry
          </button>
        </div>
      )
    }
    const createRow =
      treeEdit && treeEdit.mode !== "rename" && treeEdit.dir === rel ? (
        <TreeEditInput
          key="__create"
          initial={treeEdit.mode === "create-file" ? "new-file.ts" : "new-folder"}
          indentPx={depth * 12 + 22}
          onCommit={(name) => void commitTreeEdit(name)}
          onCancel={() => setTreeEdit(null)}
        />
      ) : null

    if (state.entries.length === 0) {
      return (
        createRow ?? (
          <div className="px-2 py-1 text-xs text-muted-foreground" style={{ paddingLeft: depth * 12 + 8 }}>
            empty
          </div>
        )
      )
    }

    const rows = state.entries.map((entry) => {
      const path = rel ? `${rel}/${entry.name}` : entry.name
      if (confirmDelete?.path === path) {
        return (
          <div
            key={path}
            className="flex items-center gap-1.5 rounded-md bg-destructive/10 px-2 py-1 text-[12px]"
            style={{ paddingLeft: depth * 12 + 8 }}
          >
            <Trash2 className="size-3.5 shrink-0 text-destructive" />
            <span className="min-w-0 flex-1 truncate text-foreground">
              {confirmDelete.kind === "dir" ? `Delete “${entry.name}” and contents?` : `Delete “${entry.name}”?`}
            </span>
            <button
              type="button"
              onClick={() => void deleteEntry(path)}
              className="shrink-0 rounded bg-destructive px-1.5 py-0.5 text-[11px] font-medium text-white hover:opacity-90"
            >
              Delete
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(null)}
              className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[11px] text-foreground hover:bg-muted"
            >
              Cancel
            </button>
          </div>
        )
      }
      if (treeEdit?.mode === "rename" && treeEdit.path === path) {
        return (
          <TreeEditInput
            key={path}
            initial={entry.name}
            indentPx={depth * 12 + (entry.kind === "dir" ? 8 : 22)}
            selectStem
            onCommit={(name) => void commitTreeEdit(name)}
            onCancel={() => setTreeEdit(null)}
          />
        )
      }
      if (entry.kind === "dir") {
        const isOpen = expanded.has(path)
        return (
          <div key={path}>
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <button
                  type="button"
                  onClick={() => toggleDir(path)}
                  className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-[13px] text-foreground/90 hover:bg-muted/60"
                  style={{ paddingLeft: depth * 12 + 8 }}
                >
                  <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")} />
                  <span className="min-w-0 truncate">{entry.name}</span>
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent onCloseAutoFocus={suppressMenuCloseFocus}>
                <ContextMenuItem onSelect={() => startTreeEditAfterMenu({ mode: "create-file", dir: path })}>
                  <FilePlus className="size-3.5" /> New file
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => startTreeEditAfterMenu({ mode: "create-dir", dir: path })}>
                  <FolderPlus className="size-3.5" /> New folder
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => startTreeEditAfterMenu({ mode: "rename", path })}>
                  <Pencil className="size-3.5" /> Rename
                </ContextMenuItem>
                <ContextMenuItem className="text-destructive hover:text-destructive focus:text-destructive" onSelect={() => setConfirmDelete({ path, kind: "dir" })}>
                  <Trash2 className="size-3.5" /> Delete
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
            {isOpen ? renderDirEntries(path, depth + 1) : null}
          </div>
        )
      }
      return (
        <ContextMenu key={path}>
          <ContextMenuTrigger asChild>
            <button
              type="button"
              onClick={() => openFile(path)}
              className={cn(
                "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] hover:bg-muted/60",
                active === path ? "bg-muted text-foreground" : "text-foreground/90",
              )}
              style={{ paddingLeft: depth * 12 + 8 + 14 }}
            >
              <FileTypeIcon name={entry.name} className="size-3.5" />
              <span className="min-w-0 truncate">{entry.name}</span>
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent onCloseAutoFocus={suppressMenuCloseFocus}>
            <ContextMenuItem onSelect={() => startTreeEditAfterMenu({ mode: "rename", path })}>
              <Pencil className="size-3.5" /> Rename
            </ContextMenuItem>
            <ContextMenuItem className="text-destructive hover:text-destructive focus:text-destructive" onSelect={() => setConfirmDelete({ path, kind: "file" })}>
              <Trash2 className="size-3.5" /> Delete
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )
    })

    return (
      <>
        {createRow}
        {rows}
      </>
    )
  }

  const treePane = (
    <div className={cn("flex min-h-0 flex-col", isNarrow ? "flex-1" : "h-full w-56 border-l border-border")}>
      <div className="flex items-center gap-1 p-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setFilter("")
              if (e.key === "Enter") {
                if (searchMode === "files" && filterResults?.length) openFile(filterResults[0])
                if (searchMode === "content" && contentResults?.results.length) {
                  const first = contentResults.results[0]
                  openFileAt(first.path, first.line)
                }
              }
            }}
            placeholder={searchMode === "files" ? "Filter files…" : "Search in files…"}
            className="h-7 w-full rounded-md border border-border bg-muted/40 pl-7 pr-6 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
          />
          {filter ? (
            <button
              type="button"
              onClick={() => setFilter("")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              title="Clear filter"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className={cn("h-7 w-7 shrink-0", searchMode === "content" && "bg-muted text-foreground")}
          onClick={() => setSearchMode((m) => (m === "files" ? "content" : "files"))}
          title={searchMode === "files" ? "Search file contents" : "Back to file filter"}
        >
          <TextSearch className="size-3.5" />
        </Button>
      </div>
      <div className="flex items-center gap-0.5 px-2 pb-1">
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => startTreeEdit({ mode: "create-file", dir: "" })}
          title="New file"
        >
          <FilePlus className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => startTreeEdit({ mode: "create-dir", dir: "" })}
          title="New folder"
        >
          <FolderPlus className="size-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={refresh} title="Refresh">
          <RefreshCw className="size-3.5" />
        </Button>
        {opError ? (
          <button
            type="button"
            className="ml-1 min-w-0 flex-1 truncate text-left text-[11px] text-destructive hover:underline"
            onClick={() => setOpError(null)}
            title={`${opError} (click to dismiss)`}
          >
            {opError}
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {searchMode === "content" ? (
          filter.trim().length < 2 ? (
            <p className="px-2 py-1 text-xs text-muted-foreground">Type at least 2 characters to search file contents.</p>
          ) : contentError ? (
            <p className="px-2 py-1 text-xs text-destructive">{contentError}</p>
          ) : contentSearching && !contentResults ? (
            <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> searching…
            </div>
          ) : !contentResults || contentResults.results.length === 0 ? (
            <p className="px-2 py-1 text-xs text-muted-foreground">No matches.</p>
          ) : (
            <>
              {contentResults.results.map((match, i) => {
                const prev = contentResults.results[i - 1]
                const isNewFile = !prev || prev.path !== match.path
                return (
                  <div key={`${match.path}:${match.line}:${i}`}>
                    {isNewFile ? (
                      <div className="mt-1 flex items-center gap-1.5 px-2 py-0.5 text-[12px] font-medium text-foreground">
                        <FileTypeIcon name={baseName(match.path)} className="size-3.5" />
                        <span className="truncate">{baseName(match.path)}</span>
                        {dirName(match.path) ? (
                          <span className="min-w-0 truncate text-[11px] font-normal text-muted-foreground">{dirName(match.path)}</span>
                        ) : null}
                      </div>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => openFileAt(match.path, match.line)}
                      className="flex w-full items-baseline gap-2 rounded-md py-0.5 pl-7 pr-2 text-left hover:bg-muted/60"
                    >
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{match.line}</span>
                      <span className="min-w-0 truncate font-mono text-[11px] text-foreground/80">{match.text}</span>
                    </button>
                  </div>
                )
              })}
              {contentResults.truncated ? (
                <p className="px-2 py-1 text-[11px] text-muted-foreground">More matches exist — narrow the search.</p>
              ) : null}
            </>
          )
        ) : filter ? (
          indexError ? (
            <div className="flex items-center gap-2 px-2 py-1 text-xs text-destructive">
              <span className="truncate">{indexError}</span>
              <button type="button" className="shrink-0 underline hover:text-foreground" onClick={() => void loadIndex()}>
                retry
              </button>
            </div>
          ) : filterResults === null ? (
            <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> indexing…
            </div>
          ) : filterResults.length === 0 ? (
            <p className="px-2 py-1 text-xs text-muted-foreground">No matches.</p>
          ) : (
            <>
              {filterResults.map((path) => (
                <button
                  key={path}
                  type="button"
                  onClick={() => openFile(path)}
                  className={cn(
                    "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] hover:bg-muted/60",
                    active === path ? "bg-muted text-foreground" : "text-foreground/90",
                  )}
                >
                  <FileTypeIcon name={baseName(path)} className="size-3.5" />
                  <span className="min-w-0 truncate">{baseName(path)}</span>
                  {dirName(path) ? (
                    <span className="min-w-0 flex-1 truncate text-right text-[11px] text-muted-foreground">
                      {dirName(path)}
                    </span>
                  ) : null}
                </button>
              ))}
              {index?.truncated ? (
                <p className="px-2 py-1 text-[11px] text-muted-foreground">Index truncated — narrow the filter.</p>
              ) : null}
            </>
          )
        ) : (
          renderDirEntries("", 0)
        )}
      </div>
    </div>
  )

  // --- main pane ------------------------------------------------------------

  const mainPane = (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {active && activeBuffer ? (
        activeBuffer.status === "loading" ? (
          <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : activeBuffer.status === "error" ? (
          <div className="flex flex-col items-start gap-2 p-4">
            <p className="text-sm text-muted-foreground">{activeBuffer.error}</p>
            <button
              type="button"
              onClick={() => updateBuffer(active, { status: "loading", error: undefined })}
              className="rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-muted"
            >
              Retry
            </button>
          </div>
        ) : activeBuffer.kind === "markdown" && activeBuffer.mdMode === "preview" ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="prose prose-sm dark:prose-invert max-w-full p-4">
              <Markdown remarkPlugins={[remarkGfm]} components={markdownComponentsWithLinks}>
                {activeBuffer.current}
              </Markdown>
            </div>
          </div>
        ) : activeBuffer.kind === "markdown" || activeBuffer.kind === "text" ? (
          <div className="min-h-0 flex-1">
            <CodeEditor
              key={active}
              fileName={baseName(active)}
              initialValue={activeBuffer.current}
              onChange={(doc) => updateBufferContent(active, doc)}
              onSave={() => void saveFile(active)}
              reveal={reveal && reveal.path === active ? { line: reveal.line, nonce: reveal.nonce } : undefined}
            />
          </div>
        ) : activeBuffer.kind === "pdf" ? (
          <iframe
            src={contentUrl(projectId, active)}
            title={baseName(active)}
            className="h-full w-full flex-1 border-0 bg-background"
          />
        ) : activeBuffer.kind === "image" ? (
          <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto p-4">
            <img
              src={contentUrl(projectId, active)}
              alt={baseName(active)}
              className="max-w-full rounded-lg border border-border"
            />
          </div>
        ) : (
          <p className="p-4 text-sm text-muted-foreground">
            No inline preview for this file type — use “open in new tab” above.
          </p>
        )
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
          <FolderTree className="size-6" />
          <p className="text-sm">Select a file to view</p>
        </div>
      )}
      {activeBuffer?.saveError ? (
        <div className="absolute inset-x-2 bottom-2 flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-background/95 px-3 py-1.5 text-xs text-destructive shadow-sm">
          <span className="truncate">{activeBuffer.saveError}</span>
          <button
            type="button"
            className="shrink-0 underline hover:text-foreground"
            onClick={() => active && updateBuffer(active, { saveError: null })}
          >
            dismiss
          </button>
        </div>
      ) : null}
    </div>
  )

  // --- chrome ---------------------------------------------------------------

  return (
    <div ref={rootRef} className="flex h-full flex-col overflow-hidden">
      {/* Tab strip */}
      {tabs.length > 0 ? (
        <div className="flex items-center gap-1 overflow-x-auto border-b border-border px-1.5 pt-1.5 pb-1 [scrollbar-width:thin]">
          <DndContext sensors={tabDndSensors} collisionDetection={closestCenter} onDragEnd={handleTabDragEnd}>
            <SortableContext items={tabs} strategy={horizontalListSortingStrategy}>
              {tabs.map((path) => {
                const buffer = buffers.get(path)
                return (
                  <SortableFileTab
                    key={path}
                    path={path}
                    isActive={active === path}
                    dirty={buffer?.status === "ready" && buffer.current !== buffer.original}
                    onSelect={() => {
                      setActive(path)
                      setNarrowShowTree(false)
                    }}
                    onClose={() => closeTab(path)}
                  />
                )
              })}
            </SortableContext>
          </DndContext>
        </div>
      ) : null}

      {/* Breadcrumb + actions */}
      <div className="flex h-9 items-center justify-between gap-2 border-b border-border px-2">
        <div className="flex min-w-0 items-center gap-1 font-mono text-xs text-muted-foreground">
          <span className="shrink-0 truncate">{projectTitle ?? "Project"}</span>
          {active
            ? active.split("/").map((part, i, parts) => (
                <span key={`${part}-${i}`} className="flex min-w-0 items-center gap-1">
                  <ChevronRight className="size-3 shrink-0" />
                  <span className={cn("truncate", i === parts.length - 1 && "text-foreground")}>{part}</span>
                </span>
              ))
            : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {activeBuffer?.status === "ready" && activeBuffer.kind === "markdown" ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => active && updateBuffer(active, { mdMode: activeBuffer.mdMode === "preview" ? "source" : "preview" })}
              title={activeBuffer.mdMode === "preview" ? "Edit source" : "Preview"}
            >
              {activeBuffer.mdMode === "preview" ? <Pencil className="size-3.5" /> : <Eye className="size-3.5" />}
            </Button>
          ) : null}
          {activeIsDirty || activeBuffer?.saving || activeBuffer?.justSaved ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              disabled={!!activeBuffer?.saving || !activeIsDirty}
              onClick={() => active && void saveFile(active)}
              title="Save (⌘S)"
            >
              {activeBuffer?.saving ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : activeBuffer?.justSaved ? (
                <Check className="size-3.5 text-green-600" />
              ) : (
                <Save className="size-3.5" />
              )}
            </Button>
          ) : null}
          {active ? (
            <>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={copyActivePath} title="Copy path">
                {copied ? <Check className="size-3.5 text-green-600" /> : <Copy className="size-3.5" />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                title="Open in new tab"
                // Absolute URL via window.open — a relative target=_blank anchor
                // opens a blank popup in PWA standalone (QA_TEST_CHAIN_2 E16).
                onClick={() =>
                  window.open(
                    new URL(contentUrl(projectId, active), window.location.origin).toString(),
                    "_blank",
                    "noopener,noreferrer",
                  )
                }
              >
                <ExternalLink className="size-3.5" />
              </Button>
            </>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className={cn("h-7 w-7", showTree && "bg-muted")}
            onClick={() => (isNarrow ? setNarrowShowTree((v) => !v) : setWideShowTree((v) => !v))}
            title={showTree ? "Hide file tree" : "Show file tree"}
          >
            <FolderTree className="size-3.5" />
          </Button>
          {onClose ? (
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} title="Close">
              <X className="size-4" />
            </Button>
          ) : null}
        </div>
      </div>

      {/* Body */}
      <div className="flex min-h-0 flex-1">
        {showMain ? mainPane : null}
        {isNarrow ? (
          showTree ? treePane : null
        ) : (
          /* Wide mode keeps the tree mounted and animates its width so the
             toggle slides instead of snapping (the editor reflows with it). */
          <div
            className={cn(
              // min-w-0 matters: a flex item's min-width:auto would floor the
              // width at the tree's content size and defeat the w-0 collapse.
              "min-h-0 min-w-0 shrink-0 overflow-hidden transition-[width] duration-200 ease-out",
              wideShowTree ? "w-56" : "w-0",
            )}
          >
            {treePane}
          </div>
        )}
      </div>
    </div>
  )
}
