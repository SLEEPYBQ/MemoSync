import { createRoot } from "react-dom/client"
import { useState } from "react"
import { applyLanguage, t, useI18n, i18n } from "../../i18n"
import { SETTINGS_ROWS } from "../../app/settings/registry"
import { ProcessingMessage } from "../../components/messages/ProcessingMessage"
import { memoryScopeLabel } from "../../lib/memoryCitations"

function Fixture() {
  useI18n()
  const [draft, setDraft] = useState("")
  return <>
    <label htmlFor="draft">{t("common:language")}</label>
    <input id="draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
    <span data-registry>{SETTINGS_ROWS.memoryEnabled.title}</span>
    <span data-scope>{memoryScopeLabel("personal")}</span>
    <ProcessingMessage status="running" />
    <button onClick={() => void applyLanguage("en")}>English</button>
    <button onClick={() => void applyLanguage("zh-CN")}>简体中文</button>
  </>
}
void i18n.changeLanguage("en")
createRoot(document.getElementById("root")!).render(<Fixture />)
