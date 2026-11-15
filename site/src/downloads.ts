const RELEASES = "https://github.com/SLEEPYBQ/MemoSync/releases"
const SUFFIXES = {
  "mac-arm64": "macos-arm64.dmg",
  "mac-x64": "macos-x64.dmg",
  windows: "windows-x64-Setup.exe",
  linux: "linux-x64.AppImage",
} as const
type Target = keyof typeof SUFFIXES
type UserAgentData = {
  platform?: string
  mobile?: boolean
  getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }>
}

export function initializeDownloads() {
  const hints = (navigator as Navigator & { userAgentData?: UserAgentData }).userAgentData
  const platform = hints?.platform || navigator.platform
  const ua = navigator.userAgent
  // iPadOS can report MacIntel; Android and ChromeOS also contain Linux in their UA.
  const mobile = hints?.mobile || /Android|iPhone|iPad|iPod/i.test(ua)
    || (/Mac/i.test(platform) && navigator.maxTouchPoints > 1)
  const os = mobile ? null
    : /Win/i.test(platform) ? "windows"
    : /Mac/i.test(platform) ? "mac"
    : /Linux/i.test(platform) && !/CrOS|aarch64|armv\d/i.test(`${platform} ${ua}`) ? "linux"
    : null
  let target: Target | null = os === "mac" ? null : os
  let version = "v0.45.0"
  // Keep real installer links usable even if GitHub's API is unavailable or rate limited.
  let urls = Object.fromEntries(Object.entries(SUFFIXES).map(([key, suffix]) =>
    [key, `${RELEASES}/download/${version}/MemoSync-${version.slice(1)}-${suffix}`],
  )) as Record<Target, string>

  const controls = [...document.querySelectorAll<HTMLElement>("[data-download]")].map((root, index) => {
    const link = root.querySelector<HTMLAnchorElement>("a")!
    const label = link.querySelector<HTMLElement>("[data-download-label]")!
    const choices = document.createElement("div")
    choices.className = "download-options"
    choices.id = `mac-download-${index}`
    choices.hidden = true
    choices.setAttribute("role", "group")
    choices.setAttribute("aria-label", "Choose your Mac chip")
    const caption = document.createElement("p")
    caption.textContent = "Choose your Mac chip"
    choices.append(caption)
    const macLinks = (["mac-arm64", "mac-x64"] as const).map((key) => {
      const option = document.createElement("a")
      option.textContent = key === "mac-arm64" ? "Apple silicon · DMG" : "Intel · DMG"
      option.addEventListener("click", () => setExpanded(false))
      choices.append(option)
      return { key, option }
    })
    root.append(choices)

    function setExpanded(expanded: boolean) {
      choices.hidden = !expanded
      link.setAttribute("aria-expanded", String(expanded))
    }
    link.addEventListener("click", (event) => {
      if (os !== "mac" || target || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      setExpanded(choices.hidden)
      if (!choices.hidden) macLinks[0].option.focus()
    })
    link.addEventListener("keydown", (event) => {
      if (event.key === " " && os === "mac" && !target) {
        event.preventDefault()
        link.click()
      }
    })
    root.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !choices.hidden) {
        setExpanded(false)
        link.focus()
      }
    })
    document.addEventListener("click", (event) => {
      if (!root.contains(event.target as Node) && !choices.hidden) setExpanded(false)
    })
    root.addEventListener("focusout", (event) => {
      if (!root.contains(event.relatedTarget as Node) && !choices.hidden) setExpanded(false)
    })
    return { link, label, choices, macLinks, setExpanded }
  })

  function render() {
    for (const { link, label, choices, macLinks, setExpanded } of controls) {
      link.href = target ? urls[target] : `${RELEASES}/latest`
      label.textContent = os ? `Download for ${{ mac: "Mac", windows: "Windows", linux: "Linux" }[os]}` : "Download MemoSync"
      for (const { key, option } of macLinks) option.href = urls[key]
      if (os === "mac" && !target) {
        link.setAttribute("role", "button")
        link.setAttribute("aria-controls", choices.id)
        link.setAttribute("aria-expanded", String(!choices.hidden))
      } else {
        setExpanded(false)
        for (const attribute of ["role", "aria-controls", "aria-expanded"]) link.removeAttribute(attribute)
      }
    }
    const detail = os === "mac"
      ? target === "mac-arm64" ? "Apple silicon · DMG" : target === "mac-x64" ? "Intel Mac · DMG" : "Apple silicon & Intel Macs · DMG"
      : os === "windows" ? "Windows x64 · EXE installer"
      : os === "linux" ? "Linux x64 · AppImage"
      : "For macOS, Windows & Linux"
    for (const element of document.querySelectorAll("[data-download-detail]")) element.textContent = detail
    for (const element of document.querySelectorAll("[data-version]")) element.textContent = os ? ` · ${version}` : ""
    for (const element of document.querySelectorAll<HTMLElement>("[data-mac-install]")) element.hidden = os !== "mac"
  }
  render()

  // MacIntel in navigator.platform is also used on Apple silicon. Only trust an explicit CPU hint.
  if (os === "mac" && hints?.getHighEntropyValues) {
    hints.getHighEntropyValues(["architecture"]).then(({ architecture }) => {
      if (architecture === "arm") target = "mac-arm64"
      if (architecture === "x86") target = "mac-x64"
      render()
    }).catch(() => {})
  }

  fetch("https://api.github.com/repos/SLEEPYBQ/MemoSync/releases/latest")
    .then((response) => response.ok ? response.json() : null)
    .then((release) => {
      if (typeof release?.tag_name !== "string" || !Array.isArray(release.assets)) return
      const next = {} as Record<Target, string>
      for (const [key, suffix] of Object.entries(SUFFIXES)) {
        const asset = release.assets.find((item: { name?: string }) => item.name?.endsWith(`-${suffix}`))
        if (typeof asset?.browser_download_url !== "string" || !asset.browser_download_url.startsWith(`${RELEASES}/download/`)) return
        next[key as Target] = asset.browser_download_url
      }
      // Switch the complete set together, so the version always matches the offered installers.
      urls = next
      version = release.tag_name
      render()
    })
    .catch(() => {})
}
