import { useCallback, useState, useEffect, useRef } from "react"
import { ArrowUp, Folder, Loader2 } from "lucide-react"
import { DEFAULT_NEW_PROJECT_ROOT } from "../../shared/branding"
import type { WorkspaceDirsSnapshot } from "../../server/workspace-dirs"
import { notifyIfUnauthorized } from "../lib/authGuard"
import { Button } from "./ui/button"
import {
  Dialog,
  DialogContent,
  DialogBody,
  DialogTitle,
  DialogFooter,
} from "./ui/dialog"
import { Input } from "./ui/input"
import { SegmentedControl } from "./ui/segmented-control"
import { isImeComposingKeyEvent } from "../lib/imeKeys"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (project: { mode: Tab; localPath: string; title: string }) => void
}

type Tab = "new" | "existing"

function toKebab(str: string): string {
  return str
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

export function NewProjectModal({ open, onOpenChange, onConfirm }: Props) {
  const [tab, setTab] = useState<Tab>("new")
  const [name, setName] = useState("")
  const [existingPath, setExistingPath] = useState("")
  // The picker browses the WORKSPACE machine (where the agent runs) — a bare
  // path field reads like the user's own computer (pilot feedback 2026-08-11).
  const [dirs, setDirs] = useState<WorkspaceDirsSnapshot | null>(null)
  const [dirsLoading, setDirsLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const existingInputRef = useRef<HTMLInputElement>(null)

  const browse = useCallback(async (target?: string) => {
    setDirsLoading(true)
    try {
      const query = target ? `?path=${encodeURIComponent(target)}` : ""
      const res = await fetch(`/api/workspace/dirs${query}`)
      notifyIfUnauthorized(res)
      if (!res.ok) return
      const { data } = (await res.json()) as { data: WorkspaceDirsSnapshot }
      setDirs(data)
    } catch {
      // Browsing is a convenience — typing a path still works.
    } finally {
      setDirsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) {
      setTab("new")
      setName("")
      setExistingPath("")
      setDirs(null)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

  useEffect(() => {
    if (open) {
      setTimeout(() => {
        if (tab === "new") inputRef.current?.focus()
        else existingInputRef.current?.focus()
      }, 0)
      if (tab === "existing" && dirs === null) void browse()
    }
  }, [browse, dirs, tab, open])

  const kebab = toKebab(name)
  const newPath = kebab ? `${DEFAULT_NEW_PROJECT_ROOT}/${kebab}` : ""
  const trimmedExisting = existingPath.trim()

  const canSubmit = tab === "new" ? !!kebab : !!trimmedExisting

  const handleSubmit = () => {
    if (!canSubmit) return
    if (tab === "new") {
      onConfirm({ mode: "new", localPath: newPath, title: name.trim() })
    } else {
      const folderName = trimmedExisting.split("/").pop() || trimmedExisting
      onConfirm({ mode: "existing", localPath: trimmedExisting, title: folderName })
    }
    onOpenChange(false)
  }

  const pickDirectory = (target: string) => {
    setExistingPath(target)
    void browse(target)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogBody className="space-y-4">
          <DialogTitle>Add Project</DialogTitle>

          <SegmentedControl
            value={tab}
            onValueChange={setTab}
            options={[
              { value: "new" as Tab, label: "New Folder" },
              { value: "existing" as Tab, label: "Existing Path" },
            ]}
            className="w-full mb-2"
            optionClassName="flex-1 justify-center"
          />

          {tab === "new" ? (
            <div className="space-y-2">
              <Input
                ref={inputRef}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  // Enter mid-IME-composition commits a pinyin candidate, it must
                  // not submit the half-typed project name (LAND-2).
                  if (isImeComposingKeyEvent(e.nativeEvent)) return
                  if (e.key === "Enter") handleSubmit()
                  if (e.key === "Escape") onOpenChange(false)
                }}
                placeholder="Project name"
              />
              {newPath && (
                <p className="text-xs text-muted-foreground font-mono">
                  {newPath}
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <Input
                ref={existingInputRef}
                type="text"
                value={existingPath}
                onChange={(e) => setExistingPath(e.target.value)}
                onKeyDown={(e) => {
                  if (isImeComposingKeyEvent(e.nativeEvent)) return
                  if (e.key === "Enter") handleSubmit()
                  if (e.key === "Escape") onOpenChange(false)
                }}
                placeholder="~/Projects/my-app"
              />
              <div className="overflow-hidden rounded-lg border border-border">
                <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-2.5 py-1.5">
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                    {dirs?.path ?? "…"}
                  </span>
                  {dirsLoading ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" /> : null}
                </div>
                <div className="max-h-44 overflow-y-auto py-1">
                  {dirs?.parent ? (
                    <button
                      type="button"
                      onClick={() => pickDirectory(dirs.parent!)}
                      className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted"
                    >
                      <ArrowUp className="h-3.5 w-3.5 shrink-0" />
                      ..
                    </button>
                  ) : null}
                  {dirs?.dirs.map((dir) => (
                    <button
                      key={dir.path}
                      type="button"
                      onClick={() => pickDirectory(dir.path)}
                      className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-muted"
                    >
                      <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 truncate">{dir.name}</span>
                    </button>
                  ))}
                  {dirs && dirs.dirs.length === 0 && !dirs.parent ? (
                    <p className="px-2.5 py-1.5 text-xs text-muted-foreground">No folders here yet.</p>
                  ) : null}
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                You are browsing the <strong>workspace machine</strong> (the remote environment where
                the agent runs) — not this computer. The folder will be created if it doesn't exist.
              </p>
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
