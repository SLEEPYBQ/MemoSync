import { useCallback, useLayoutEffect, useState } from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { LockKeyhole, X } from "lucide-react"
import { t, useI18n } from "../../i18n"
import { HostFileWorkbench, type ReadonlySnapshotTab } from "../../lib/hostFileWorkbench"
import { baseName } from "../../lib/filesWorkbench"
import { cn } from "../../lib/utils"
import { Button } from "../ui/button"
import { CodeEditor } from "./CodeEditor"

export function HostFileSnapshotTab({ tab, active, workbench }: { tab: ReadonlySnapshotTab; active: boolean; workbench: HostFileWorkbench }) {
  useI18n()
  const name = baseName(tab.request.action.path)
  return (
    <div className={cn("flex shrink-0 items-center gap-1 rounded-md text-xs", active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50")} title={tab.request.action.path}>
      <button type="button" aria-pressed={active} onClick={() => workbench.select(tab.request.operationId)} className="flex min-w-0 items-center gap-1.5 px-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <LockKeyhole aria-hidden className="size-3" />
        <span className="max-w-36 truncate">{name}</span>
        <span className="text-[10px] text-muted-foreground">{t("files:snapshot")}</span>
      </button>
      <button type="button" aria-label={t("files:closeSnapshot", { name })} onClick={() => workbench.close(tab.request.operationId)} className="mr-1 rounded p-0.5 hover:bg-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <X aria-hidden className="size-3" />
      </button>
    </div>
  )
}

const SAFE_MARKDOWN_ELEMENTS = ["p", "a", "strong", "em", "del", "blockquote", "ul", "ol", "li", "pre", "code", "table", "thead", "tbody", "tr", "th", "td", "hr", "br", "h1", "h2", "h3", "h4", "h5", "h6"]

export function HostFileSnapshotView({ tab, workbench, onOpenCurrentFile }: { tab: ReadonlySnapshotTab; workbench: HostFileWorkbench; onOpenCurrentFile: () => void }) {
  useI18n()
  const canPreview = tab.snapshot.mediaType === "text/markdown" && tab.snapshot.byteLength <= 256 * 1024
  const [preview, setPreview] = useState(canPreview && tab.request.action.view === "preview" && !tab.request.action.selection)
  const rendered = useCallback(() => workbench.rendered(tab.request.operationId), [workbench, tab.request.operationId])
  useLayoutEffect(() => { if (preview) rendered() }, [preview, rendered])
  const selection = tab.request.action.selection
  return (
    <section className="flex min-h-0 flex-1 flex-col" data-host-snapshot={tab.request.operationId} data-file-version={tab.snapshot.version}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground">
        <LockKeyhole aria-hidden className="size-3.5" />
        <span>{t("files:readonlySnapshot")}</span>
        <code className="truncate text-[10px]" title={tab.snapshot.version}>{tab.snapshot.version.slice(0, 12)}</code>
        <div className="ml-auto flex items-center gap-1">
          {canPreview ? <Button size="xs" variant="ghost" onClick={() => setPreview(value => !value)}>{preview ? t("files:source") : t("common:preview")}</Button> : null}
          <Button size="xs" variant="ghost" onClick={onOpenCurrentFile}>{t("files:openCurrentFile")}</Button>
        </div>
      </div>
      {preview ? (
        <div className="prose prose-sm dark:prose-invert min-h-0 max-w-full flex-1 overflow-y-auto p-4">
          <Markdown remarkPlugins={[remarkGfm]} skipHtml allowedElements={SAFE_MARKDOWN_ELEMENTS} components={{ a: ({ children }) => <span>{children}</span> }}>
            {tab.snapshot.content}
          </Markdown>
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <CodeEditor
            key={tab.viewInstanceId}
            fileName={baseName(tab.request.action.path)}
            initialValue={tab.snapshot.content}
            readOnly
            onReady={rendered}
            reveal={selection ? { line: selection.startLine, endLine: selection.endLine, nonce: 1 } : undefined}
          />
        </div>
      )}
    </section>
  )
}
