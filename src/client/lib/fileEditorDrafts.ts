import type { FilePreviewKind } from "./filePreview"

export interface FileBuffer {
  kind: FilePreviewKind
  status: "loading" | "ready" | "error"
  error?: string
  original: string
  current: string
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

function updateUnloadGuard() {
  if (typeof window === "undefined") return
  const dirty = [...projects.values()].some(store => [...store.getSnapshot().buffers.values()]
    .some(buffer => buffer.status === "ready" && buffer.current !== buffer.original))
  if (dirty === guarding) return
  guarding = dirty
  if (dirty) window.addEventListener("beforeunload", beforeUnload)
  else window.removeEventListener("beforeunload", beforeUnload)
}

export class FileEditorDrafts {
  private snapshot: Snapshot = { tabs: [], active: null, buffers: new Map() }
  private listeners = new Set<() => void>()
  private mounts = 0

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
      const buffers = new Map([...snapshot.buffers].filter(([, buffer]) =>
        buffer.status === "ready" && (buffer.current !== buffer.original || buffer.saving)))
      const tabs = snapshot.tabs.filter(path => buffers.has(path))
      snapshot = { buffers, tabs, active: snapshot.active && buffers.has(snapshot.active) ? snapshot.active : tabs[0] ?? null }
    }
    this.snapshot = snapshot
    updateUnloadGuard()
    for (const listener of this.listeners) listener()
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
