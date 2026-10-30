import { t, useI18n } from "../../i18n"

export function PanelLoading() {
  useI18n()
  return <div role="status" className="flex min-h-24 w-full items-center justify-center p-4 text-sm text-muted-foreground">{t("common:loading")}</div>
}
