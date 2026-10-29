// These pages can be shown before the app loads. Keep their tiny shared
// catalog available to the packaged server (which does not ship src/client).
export const STANDALONE_UI_COPY = {
  en: {
    previewUnavailable: "Preview unavailable",
    previewOriginRequired: "Previews run on an isolated origin. Open MemoSync locally, or ask whoever hosts this server to set MEMOSYNC_PREVIEW_ORIGIN to an HTTPS origin.",
    previewPortUnavailable: "Nothing is answering on port {{port}} right now.",
    previewRestart: "The server may have stopped — start it again (for example from the app terminal) and reload this pane.",
  },
  zhCN: {
    previewUnavailable: "预览不可用",
    previewOriginRequired: "预览需要独立源。请在本机打开MemoSync，或让服务器托管者将MEMOSYNC_PREVIEW_ORIGIN设为HTTPS源。",
    previewPortUnavailable: "端口{{port}}当前没有服务响应。",
    previewRestart: "服务器可能已停止。请重新启动（例如在应用终端中），然后刷新此面板。",
  },
}

export function renderStandalonePreviewError(reason: "origin" | "port", port?: number): string {
  const keys = reason === "origin" ? ["previewOriginRequired"] as const : ["previewPortUnavailable", "previewRestart"] as const
  const params = { port: port ?? "" }
  const format = (value: string) => value.replace("{{port}}", String(params.port))
  const data = JSON.stringify({ code: "previewUnavailable", keys, params, resources: STANDALONE_UI_COPY }).replaceAll("<", "\\u003c")
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${STANDALONE_UI_COPY.en.previewUnavailable}</title></head><body style="font-family:system-ui;color:#667085;background:#fafafa;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center;max-width:32rem;padding:0 1.5rem">${keys.map((key) => `<p data-ui-copy="${key}" style="font-size:14px">${format(STANDALONE_UI_COPY.en[key])}</p>`).join("")}</div><script type="application/json" id="memosync-ui-copy">${data}</script><script>(()=>{const data=JSON.parse(document.getElementById("memosync-ui-copy").textContent);let language=navigator.languages.some(value=>/^zh/i.test(value))?"zh-CN":"en";try{const cached=localStorage.getItem("memosync:resolved-language");if(cached==="en"||cached==="zh-CN")language=cached}catch{}document.documentElement.lang=language;const resource=language==="zh-CN"?data.resources.zhCN:data.resources.en;document.title=resource[data.code];document.querySelectorAll("[data-ui-copy]").forEach(element=>{element.textContent=resource[element.dataset.uiCopy].replace(/{{([^}]+)}}/g,(_,key)=>data.params[key]??"")})})()</script></body></html>`
}
