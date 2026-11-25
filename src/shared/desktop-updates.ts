/** Desktop updates are handled by Electron, independently of the CLI updater. */
export interface DesktopUpdateSnapshot {
  status: "idle" | "checking" | "up_to_date" | "available" | "downloading" | "downloaded" | "installing" | "error" | "unsupported"
  currentVersion: string
  latestVersion: string | null
  releaseUrl: string | null
  progress: number | null
  error: string | null
  lastCheckedAt: number | null
  installMode: "automatic" | "installer" | "appimage" | "unsupported"
}

export interface DesktopUpdatesBridge {
  getSnapshot: () => Promise<DesktopUpdateSnapshot>
  checkForUpdates: () => Promise<DesktopUpdateSnapshot>
  downloadUpdate: () => Promise<DesktopUpdateSnapshot>
  installUpdate: () => Promise<DesktopUpdateSnapshot>
  onChange: (listener: (snapshot: DesktopUpdateSnapshot) => void) => () => void
}
