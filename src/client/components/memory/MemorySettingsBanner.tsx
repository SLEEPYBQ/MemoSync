import { Info } from "lucide-react"
import { MemoryBadge } from "./MemoryBadge"
import { MemoryCallout } from "./MemorySurface"
import { useState } from "react"
import { useOutletContext } from "react-router-dom"
import type { AppState } from "../../app/useAppState"
import { useAppSettingsStore } from "../../stores/appSettingsStore"
import { Button } from "../ui/button"

export function MemoryOffBadge() {
  const enabled = useAppSettingsStore((s) => s.settings?.memory.enabled ?? true)
  return !enabled ? (
    <MemoryBadge>Off</MemoryBadge>
  ) : null
}

export function MemorySettingsBanner() {
  const app = useOutletContext<AppState | null>()
  const memory = useAppSettingsStore((s) => s.settings?.memory)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!memory || (memory.enabled && memory.learn)) return null
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
    <MemoryCallout icon={Info} role="status" className="mb-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="min-w-0 flex-1 basis-48">
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
    </MemoryCallout>
  )
}
