import { createRoot } from "react-dom/client"
import type { DesktopUpdateSnapshot, DesktopUpdatesBridge } from "../../../shared/desktop-updates"
import { DesktopUpdateSection } from "../../app/settings/DesktopUpdateSection"
import { i18n } from "../../i18n"
import "./fixture.css"

const parameters = new URLSearchParams(location.search)
const platform = parameters.get("platform") ?? "win32"
let snapshot: DesktopUpdateSnapshot = {
  status: "idle", currentVersion: "1.0.0", latestVersion: null, releaseUrl: null,
  progress: null, error: null, lastCheckedAt: null,
  installMode: platform === "darwin" ? "installer" : "automatic",
}
const listeners = new Set<(next: DesktopUpdateSnapshot) => void>()
const calls: string[] = []
let initialResolve: ((next: DesktopUpdateSnapshot) => void) | undefined
let actionResolve: ((next: DesktopUpdateSnapshot) => void) | undefined
function publish(patch: Partial<DesktopUpdateSnapshot>) {
  snapshot = { ...snapshot, ...patch }
  for (const listener of listeners) listener(snapshot)
}
function action(name: string, status: DesktopUpdateSnapshot["status"]) {
  calls.push(name)
  publish({ status, error: null })
  return new Promise<DesktopUpdateSnapshot>((resolve) => { actionResolve = resolve })
}
const bridge: DesktopUpdatesBridge = {
  getSnapshot: () => parameters.has("deferInitial")
    ? new Promise((resolve) => { initialResolve = resolve })
    : Promise.resolve(snapshot),
  onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  checkForUpdates: () => action("check", "checking"),
  downloadUpdate: () => action("download", "downloading"),
  installUpdate: () => action("install", "installing"),
}
const root = createRoot(document.getElementById("root")!)
const controls = {
  publish,
  finish(patch: Partial<DesktopUpdateSnapshot>) {
    publish(patch)
    actionResolve?.(snapshot)
    actionResolve = undefined
  },
  resolveInitial() {
    initialResolve?.({ ...snapshot, status: "idle", latestVersion: null })
  },
  calls: () => calls,
  listeners: () => listeners.size,
  unmount: () => root.unmount(),
}
declare global { interface Window { desktopUpdateFixture: typeof controls } }
window.desktopUpdateFixture = controls
void i18n.changeLanguage(parameters.get("language") ?? "en").then(() => {
  root.render(<main className="@container mx-auto max-w-[760px] p-6"><DesktopUpdateSection bridge={bridge} platform={platform} /></main>)
})
