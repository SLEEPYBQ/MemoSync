import { Link } from "react-router-dom"
import { Settings2 } from "lucide-react"
import { t, useI18n } from "../i18n"
import { useModelAccessStore } from "./modelAccess"

export function FirstRunCallout() {
  useI18n()
  const snapshot = useModelAccessStore(s => s.snapshot)
  if (!snapshot || Object.values(snapshot.engines).some(engine => engine.ready)) return null
  return <div data-testid="model-access-first-run" className="mx-auto mb-3 flex max-w-[840px] flex-wrap items-center gap-x-2 gap-y-1 px-4 text-sm text-muted-foreground">
    <Settings2 className="size-4 shrink-0" aria-hidden="true" />
    <span>{t("modelAccess:firstRun")}</span>
    <Link className="underline underline-offset-4 hover:text-foreground" to="/settings/providers">{t("modelAccess:openProviders")}</Link>
  </div>
}
