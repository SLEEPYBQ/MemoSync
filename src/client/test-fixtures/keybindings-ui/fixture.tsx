import { useMemo, useState } from "react"
import { createRoot } from "react-dom/client"
import { DEFAULT_KEYBINDINGS, type KeybindingsSnapshot } from "../../../shared/types"
import type { ClientCommand } from "../../../shared/protocol"
import type { AppSocket } from "../../app/socket"
import { KeybindingsSection } from "../../app/settings/KeybindingsSection"
import { i18n, t, useI18n } from "../../i18n"
import "./fixture.css"

const params = new URLSearchParams(window.location.search)
document.documentElement.classList.toggle("dark", params.get("theme") === "dark")
void i18n.changeLanguage(params.get("lang") === "zh-CN" ? "zh-CN" : "en")
const appleOverride = params.has("apple") ? params.get("apple") === "1" : undefined
const commands: ClientCommand[] = []
let rejectNext = false

window.keybindingsFixture = {
  commands: () => structuredClone(commands),
  rejectNext: () => { rejectNext = true },
}

declare global {
  interface Window {
    keybindingsFixture: {
      commands: () => ClientCommand[]
      rejectNext: () => void
    }
  }
}

function Fixture() {
  useI18n()
  const [keybindings, setKeybindings] = useState<KeybindingsSnapshot>({
    bindings: structuredClone(DEFAULT_KEYBINDINGS),
    warning: null,
    filePathDisplay: "~/.memosync/keybindings.json",
  })
  const socket = useMemo(() => ({
    async command(command: ClientCommand) {
      commands.push(structuredClone(command))
      if (rejectNext) {
        rejectNext = false
        throw new Error("Fixture rejected request")
      }
      if (command.type === "settings.writeKeybindings") {
        const snapshot = { bindings: structuredClone(command.bindings), warning: null, filePathDisplay: "~/.memosync/keybindings.json" }
        setKeybindings(snapshot)
        return snapshot
      }
      return {}
    },
  }) as unknown as AppSocket, [])
  return (
    <main className="w-full px-5 pb-16 pt-6 md:px-10 md:pt-8">
      <div className="@container mx-auto max-w-[760px]">
        <div className="px-1 pb-8">
          <h1 className="text-[22px] font-semibold tracking-[-0.015em] text-foreground">{t("settings:keybindings")}</h1>
        </div>
        <KeybindingsSection state={{ keybindings, socket }} appleOverride={appleOverride} />
      </div>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
