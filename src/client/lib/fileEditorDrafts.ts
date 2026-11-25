import { isSameOrUnder, remapPathAfterRename } from "./filesWorkbench"
import type { FilePreviewKind } from "./filePreview"

export type LineEnding = "\n" | "\r\n" | "\r"

/** Mixed endings use the first break's style when edited; a file without breaks defaults to LF. */
export function detectLineEnding(text: string): LineEnding {
  const first = text.search(/[\r\n]/)
  if (text[first] === "\r") return text[first + 1] === "\n" ? "\r\n" : "\r"
  return "\n"
}

export interface FileBuffer {
  kind: FilePreviewKind
  status: "loading" | "ready" | "error"
  error?: string
  original: string
  current: string
  lineEnding: LineEnding
  revision: string | null
  incarnation: object
  saving: boolean
  saveError: string | null
  justSaved: boolean
  mdMode: "preview" | "source"
}

interface Snapshot {
  tabs: string[]
  active: string | null
  buffers: Map<string, FileBuffer>
}

type Update<T> = T | ((current: T) => T)
const projects = new Map<string, FileEditorDrafts>()
let guarding = false

function beforeUnload(event: BeforeUnloadEvent) {
  event.preventDefault()
  event.returnValue = ""
}

function needsProtection(buffer: FileBuffer) {
  return buffer.status === "ready" && (buffer.current !== buffer.original || buffer.saving)
}

// The browser cannot infer the workspace volume's case/normalization rules from its own OS.
// Use a conservative comparison for reservations only; keep actual tab and file names exact.
function reservationKey(path: string) {
  return path.normalize("NFD").toUpperCase().normalize("NFC")
}

export function hasUnsavedFileDrafts() {
  return [...projects.values()].some(store => [...store.getSnapshot().buffers.values()].some(needsProtection))
}

export function discardFileDraftsAfterSignOut() {
  for (const store of projects.values()) store.clear()
}

function updateUnloadGuard() {
  if (typeof window === "undefined") return
  const dirty = hasUnsavedFileDrafts()
  if (dirty === guarding) return
  guarding = dirty
  if (dirty) window.addEventListener("beforeunload", beforeUnload)
  else window.removeEventListener("beforeunload", beforeUnload)
}

export class FileEditorDrafts {
  private snapshot: Snapshot = { tabs: [], active: null, buffers: new Map() }
  private listeners = new Set<() => void>()
  private mounts = 0
  private renaming: { fromKey: string; toKey: string } | null = null

  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  mount = () => {
    this.mounts += 1
    return () => {
      this.mounts -= 1
      if (this.mounts === 0) this.publish(this.snapshot)
    }
  }

  private publish(snapshot: Snapshot) {
    if (!this.mounts) {
      const buffers = new Map([...snapshot.buffers].filter(([, buffer]) => needsProtection(buffer)))
      const tabs = snapshot.tabs.filter(path => buffers.has(path))
      snapshot = { buffers, tabs, active: snapshot.active && buffers.has(snapshot.active) ? snapshot.active : tabs[0] ?? null }
    }
    this.snapshot = snapshot
    updateUnloadGuard()
    for (const listener of this.listeners) listener()
  }

  clear() {
    this.publish({ tabs: [], active: null, buffers: new Map() })
  }

  isRenaming(path: string) {
    if (!this.renaming) return false
    const key = reservationKey(path)
    return isSameOrUnder(key, this.renaming.fromKey) || isSameOrUnder(key, this.renaming.toKey)
  }

  async rename(from: string, to: string, move: () => Promise<boolean>) {
    if (this.renaming) return { status: "busy" } as const
    const reservation = { fromKey: reservationKey(from), toKey: reservationKey(to) }
    for (const [path, buffer] of this.snapshot.buffers) {
      const key = reservationKey(path)
      // Even a clean destination tab could be edited while the request is outstanding.
      // The exact source subtree itself follows the rename, including a case-only rename.
      if (!isSameOrUnder(path, from) && isSameOrUnder(key, reservation.toKey)) return { status: "open", path } as const
      if (isSameOrUnder(key, reservation.fromKey) && buffer.saving) return { status: "busy" } as const
    }

    this.renaming = reservation
    try {
      if (!await move()) return { status: "failed" } as const
      // Read the latest state: the user may have typed, switched tabs, or unmounted.
      // Publish once so the unmounted-draft filter always sees matching keys.
      const { tabs, active, buffers } = this.snapshot
      const remap = (path: string) => remapPathAfterRename(path, from, to)
      this.publish({
        tabs: tabs.map(remap),
        active: active && remap(active),
        buffers: new Map([...buffers].map(([path, buffer]) => [remap(path), buffer])),
      })
      return { status: "renamed" } as const
    } finally {
      this.renaming = null
    }
  }

  setTabs = (update: Update<string[]>) => {
    const tabs = typeof update === "function" ? update(this.snapshot.tabs) : update
    if (tabs !== this.snapshot.tabs) this.publish({ ...this.snapshot, tabs })
  }

  setActive = (update: Update<string | null>) => {
    const active = typeof update === "function" ? update(this.snapshot.active) : update
    if (active !== this.snapshot.active) this.publish({ ...this.snapshot, active })
  }

  setBuffers = (update: Update<Map<string, FileBuffer>>) => {
    const buffers = typeof update === "function" ? update(this.snapshot.buffers) : update
    if (buffers !== this.snapshot.buffers) this.publish({ ...this.snapshot, buffers })
  }

  patch = (path: string, incarnation: object, patch: Partial<FileBuffer>) => {
    this.setBuffers(current => {
      const existing = current.get(path)
      if (!existing || existing.incarnation !== incarnation) return current
      const next = new Map(current)
      next.set(path, { ...existing, ...patch })
      return next
    })
  }
}

export function fileEditorDrafts(projectId: string): FileEditorDrafts {
  let store = projects.get(projectId)
  if (!store) {
    store = new FileEditorDrafts()
    projects.set(projectId, store)
  }
  return store
}
