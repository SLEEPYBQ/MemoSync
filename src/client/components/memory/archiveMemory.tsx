import { useState } from "react"
import { Archive, Loader2, Undo2 } from "lucide-react"
import { t, useI18n } from "../../i18n"
import { memoriesApi, type MemoryControlSurface } from "../../lib/memoriesApi"
import { cn } from "../../lib/utils"
import { useMemoryStore } from "../../stores/memoryStore"

export function useArchiveMemory(surface: MemoryControlSurface, options: { localOnly?: boolean } = {}) {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function update(id: string, status: "active" | "archived") {
    setBusyId(id)
    setError(null)
    try {
      const item = options.localOnly
        ? useMemoryStore.getState().items.find((memory) => memory.id === id)
        : await memoriesApi.update(id, { status }, { surface })
      if (!item) throw new Error(t("memory:failedToLoadMemories"))
      useMemoryStore.getState().upsertLocal(options.localOnly ? { ...item, status } : item)
    } catch (err) {
      const message = status === "archived" ? t("memory:couldntArchive") : t("memory:couldntRestore")
      setError(err instanceof Error ? `${message}: ${err.message}` : message)
      throw err
    } finally {
      setBusyId(null)
    }
  }

  return { archive: (id: string) => update(id, "archived"), restore: (id: string) => update(id, "active"), busyId, error }
}

export function ArchiveIconButton({ onClick, disabled, className }: { onClick: () => void; disabled?: boolean; className?: string }) {
  useI18n()
  return <button type="button" onClick={onClick} disabled={disabled} title={t("memory:archiveEverywhereTitle")}
    aria-label={t("memory:archiveEverywhereTitle")}
    className={cn("shrink-0 rounded p-0.5 text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40", className)}>
    <Archive className="h-3.5 w-3.5" />
  </button>
}

export function ArchivedInline({ id, onUndo, busy, note }: { id: string; onUndo: (id: string) => void; busy?: boolean; note?: string }) {
  useI18n()
  return <div role="status" className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
    <Archive className="h-3 w-3 shrink-0" />
    <span>{note ?? t("memory:archivedWontBeUsed")}</span>
    <button type="button" onClick={() => onUndo(id)} disabled={busy}
      className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-40">
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Undo2 className="h-3 w-3" />}
      {t("common:undo")}
    </button>
  </div>
}
