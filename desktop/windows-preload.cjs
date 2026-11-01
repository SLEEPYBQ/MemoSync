const { ipcRenderer } = require("electron")

window.addEventListener("DOMContentLoaded", () => {
  const style = document.createElement("style")
  style.textContent = `
    :root { --app-viewport-height: calc(100dvh - 36px); }
    #root { padding-top: 36px; box-sizing: border-box; }
    #memosync-titlebar {
      position: fixed; inset: 0 0 auto; height: 36px; z-index: 100;
      display: flex; align-items: center; padding-left: 16px;
      padding-right: 150px; box-sizing: border-box;
      background: hsl(var(--background)); color: hsl(var(--muted-foreground));
      border-bottom: 1px solid hsl(var(--border));
      font: 12px "Segoe UI", sans-serif; user-select: none;
      -webkit-app-region: drag;
    }
  `
  document.head.append(style)
  const bar = document.createElement("header")
  bar.id = "memosync-titlebar"
  bar.textContent = "MemoSync"
  document.body.prepend(bar)
  const syncTheme = () => ipcRenderer.send("memosync:window-theme", document.documentElement.classList.contains("dark"))
  new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
  syncTheme()
})
