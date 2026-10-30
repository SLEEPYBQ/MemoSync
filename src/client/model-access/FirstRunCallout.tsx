import { Link } from "react-router-dom"
import { Info } from "lucide-react"
import { t, useI18n } from "../i18n"
import { useModelAccessStore } from "./modelAccess"
import { buttonVariants } from "../components/ui/button"
import { SettingsNotice } from "../app/settings/shared"

export function FirstRunCallout() {
  useI18n()
  const snapshot = useModelAccessStore((s) => s.snapshot)
  if (!snapshot || Object.values(snapshot.engines).some((engine) => engine.ready)) return null
  return (
    <div data-testid="model-access-first-run" className="model-access-ui mx-auto mb-3 max-w-[840px] px-4">
      <SettingsNotice tone="info" className="@container">
        <div className="flex flex-wrap items-center gap-3">
          <Info className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">{t("modelAccess:firstRun")}</span>
          <Link className={buttonVariants({ variant: "outline", size: "sm" })} to="/settings/providers">
            {t("modelAccess:openProviders")}
          </Link>
        </div>
      </SettingsNotice>
    </div>
  )
}
