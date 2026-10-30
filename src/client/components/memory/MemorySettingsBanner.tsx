import { useState } from "react"
import { useOutletContext } from "react-router-dom"
import type { AppState } from "../../app/useAppState"
import { useConditionPolicy } from "../../lib/conditionApi"
import { useAppSettingsStore } from "../../stores/appSettingsStore"
import { Button } from "../ui/button"

export function MemoryOffBadge() {
  const policy = useConditionPolicy()
  const enabled = useAppSettingsStore((s) => s.settings?.memory.enabled ?? true)
  return !policy.studyMode && !enabled ? (
    <span className="rounded px-1 text-[10px] text-muted-foreground">Off</span>
  ) : null
}

export function MemorySettingsBanner() {
  const app = useOutletContext<AppState | null>()
  const policy = useConditionPolicy()
  const memory = useAppSettingsStore((s) => s.settings?.memory)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (policy.studyMode || !memory || (memory.enabled && memory.learn)) return null
  const off = !memory.enabled
  async function resume() {
    if (!app) return
    setPending(true)
    setError(null)
    try {
      await app.handleWriteAppSettings({ memory: off ? { enabled: true } : { learn: true } })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }
  return (
    <div
      role="status"
      className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
    >
      <span className="flex-1">
        {off
          ? "Memory is off. The agent isn't using or learning memories — you can still browse and edit them here."
          : "Learning is paused. The agent uses these memories but won't suggest new ones."}
      </span>
      <Button
        size="sm"
        variant="outline"
        disabled={pending || !app}
        onClick={() => {
          void resume()
        }}
      >
        {off ? "Turn on" : "Resume"}
      </Button>
      {error ? (
        <span role="alert" className="w-full text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  )
}
