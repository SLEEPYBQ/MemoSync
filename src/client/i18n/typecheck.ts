import { t } from "./index"
// This branch never runs; tsc must reject unknown keys even with a default.
if (false) {
  // @ts-expect-error Unknown translation key must fail compilation.
  t("common:thisKeyDoesNotExist")
  // @ts-expect-error A fallback cannot hide a missing translation key.
  t("settings:thisKeyDoesNotExist", { defaultValue: "fallback" })
}
