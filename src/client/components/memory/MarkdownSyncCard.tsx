// Memory files (DG5): the Markdown projections are the developer-native view
// of the memory store — one file per scope (personal + each project), shared
// by every session of that project. The files are a generated EXPORT of the
// store, read-only: memories are edited in the app, never through the files.
// Import feeds an external CLAUDE.md / .cursorrules through the candidate lane.
import { useCallback, useEffect, useMemo, useState } from "react"
import Markdown from "react-markdown"
import { FileText, FolderInput, Loader2 } from "lucide-react"
import { memoriesApi } from "../../lib/memoriesApi"
import { workspaceApi } from "../../lib/workspaceApi"
import { Button } from "../ui/button"
import { Textarea } from "../ui/textarea"
import { ExpandableRow } from "../messages/shared"
import { markdownComponents } from "../messages/shared"
import { cn } from "../../lib/utils"

type FileTarget = { scope: "personal" } | { scope: "project"; projectId: string }

interface FileEntry {
  scope: "personal" | "project"
  projectId?: string
  path: string
}

function targetKey(t: FileTarget | FileEntry): string {
  return t.scope === "project" ? `project:${t.projectId}` : "personal"
}

/** The projection's bookkeeping comments (hash/updated/pending marker) are
 * internal — the rendered view hides them. */
function stripProjectionComments(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*<!--.*-->\s*$/.test(line))
    .join("\n")
}

export function MarkdownSyncCard({ onSynced }: { onSynced?: (newCandidateIds?: string[]) => void }) {
  const [files, setFiles] = useState<FileEntry[] | null>(null)
  const [selectedKey, setSelectedKey] = useState<string>("personal")
  const [file, setFile] = useState<{ path: string; content: string } | null>(null)
  const [busy, setBusy] = useState<"import" | null>(null)
  const [lastReport, setLastReport] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [importText, setImportText] = useState("")
  const [importScope, setImportScope] = useState<"personal" | "project">("personal")
  const [projects, setProjects] = useState<Record<string, string>>({})
  const [importProjectId, setImportProjectId] = useState("")

  const selected: FileTarget = useMemo(() => {
    const entry = files?.find((f) => targetKey(f) === selectedKey)
    return entry?.scope === "project" && entry.projectId
      ? { scope: "project", projectId: entry.projectId }
      : { scope: "personal" }
  }, [files, selectedKey])

  const refreshList = useCallback(() => {
    memoriesApi
      .mdStatus()
      .then((r) => setFiles(r.files))
      .catch(() => setFiles(null))
  }, [])

  const loadFile = useCallback((target: FileTarget) => {
    memoriesApi
      .mdFile(target)
      .then((r) => {
        setFile({ path: r.path, content: r.content })
      })
      .catch(() => setFile(null))
  }, [])

  useEffect(() => {
    refreshList()
    workspaceApi
      .projectTitles()
      .then(setProjects)
      .catch(() => {})
  }, [refreshList])

  useEffect(() => {
    loadFile(selected)
  }, [loadFile, selected])

  if (!files) return null
  const selectedEntry = files.find((f) => targetKey(f) === selectedKey)

  async function handleImport() {
    if (!importText.trim()) return
    setBusy("import")
    setError(null)
    try {
      const result = await memoriesApi.mdImport(
        importText,
        importScope,
        importScope === "project" ? importProjectId : undefined,
      )
      setLastReport(
        `import: ${result.created.length} candidate${result.created.length === 1 ? "" : "s"} created, ${result.skipped} skipped`,
      )
      setImportText("")
      refreshList()
      loadFile(selected)
      onSynced?.(result.created)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed")
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="mb-6 rounded-lg border border-border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">Memory files</span>
        <span className="text-[11px] text-muted-foreground">generated export — edit memories in the app</span>
      </div>

      {/* One file per scope: Personal plus every project — all sessions of a
          project share that project's file. */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {files.map((f) => {
          const key = targetKey(f)
          const label = f.scope === "personal" ? "Personal" : (projects[f.projectId ?? ""] ?? f.projectId)
          return (
            <button
              key={key}
              type="button"
              onClick={() => setSelectedKey(key)}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                key === selectedKey
                  ? "border-foreground/30 bg-muted font-medium text-foreground"
                  : "border-border text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              )}
            >
              {label}
            </button>
          )
        })}
      </div>

      {file ? (
        <div className="mt-2 max-h-80 overflow-y-auto rounded-md border border-border/60 bg-background/60 px-3 py-2">
          {file.content.trim() ? (
            <div className="text-sm">
              <Markdown components={markdownComponents}>{stripProjectionComments(file.content)}</Markdown>
            </div>
          ) : (
            <p className="py-2 text-xs text-muted-foreground">This file is empty — no memories in this scope yet.</p>
          )}
        </div>
      ) : null}

      <p className="mt-1.5 break-all font-mono text-[11px] text-muted-foreground">{selectedEntry?.path ?? file?.path}</p>
      {lastReport ? <p className="mt-1.5 text-xs text-foreground/80">{lastReport}</p> : null}
      {error ? <p className="mt-1.5 text-xs text-destructive">{error}</p> : null}

      <div className="mt-2">
        <ExpandableRow
          defaultExpanded={false}
          expandedContent={
            <div className="mt-2 space-y-2">
              <Textarea
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder={"Paste an existing CLAUDE.md / .cursorrules — every bullet line ('- …') becomes a candidate to review."}
                className="min-h-24 text-xs"
              />
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <select
                  value={importScope === "personal" ? "personal" : importProjectId}
                  onChange={(e) => {
                    if (e.target.value === "personal") {
                      setImportScope("personal")
                    } else {
                      setImportScope("project")
                      setImportProjectId(e.target.value)
                    }
                  }}
                  className="h-7 rounded-md border border-border bg-background px-2 text-xs"
                >
                  <option value="personal">Personal scope</option>
                  {Object.entries(projects).map(([id, title]) => (
                    <option key={id} value={id}>
                      Project: {title}
                    </option>
                  ))}
                </select>
                <Button
                  variant="juicy"
                  size="sm"
                  className="ml-auto h-7 px-2 text-xs"
                  disabled={busy !== null || !importText.trim() || (importScope === "project" && !importProjectId)}
                  onClick={() => void handleImport()}
                >
                  {busy === "import" ? <Loader2 className="h-3 w-3 animate-spin" /> : <FolderInput className="h-3 w-3" />}
                  Import as candidates
                </Button>
              </div>
            </div>
          }
        >
          <span className="text-xs text-muted-foreground">Import an existing config file…</span>
        </ExpandableRow>
      </div>
    </section>
  )
}
