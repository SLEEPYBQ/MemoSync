import { t, useI18n } from "../../i18n"
import { Info } from "lucide-react"
import { MemoryBadge } from "./MemoryBadge"
import { MemoryCallout } from "./MemorySurface"
import { useState } from "react"
import { useOutletContext } from "react-router-dom"
import type { AppState } from "../../app/useAppState"
import { useAppSettingsStore } from "../../stores/appSettingsStore"
import { Button } from "../ui/button"

export function MemoryOffBadge() {
  useI18n()
  const enabled = useAppSettingsStore((s) => s.settings?.memory.enabled ?? true)
  return !enabled ? (
    <MemoryBadge>{t("settings:off")}</MemoryBadge>
  ) : null
}

export function MemorySettingsBanner() {
  useI18n()
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
            ? t("settings:memoryIsOffTheAgentIsnTUsingOrLearning")
            : t("settings:learningIsPausedTheAgentUsesTheseMemoriesButWon")}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={pending || !app}
          onClick={() => {
            void resume()
          }}
        >
          {off ? t("settings:turnOn") : t("settings:resume")}
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
