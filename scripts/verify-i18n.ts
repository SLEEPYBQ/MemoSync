import { renderStandalonePreviewError } from "../src/shared/standalone-ui-copy"
// Real-app i18n QA. Start bun run dev with an isolated HOME and seed qa-state.json
// (see docs/i18n-report.md); this harness never calls a model or publishes data.
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { chromium, type Page } from "playwright"
import { join } from "node:path"

const base = process.env.I18N_QA_URL ?? "http://localhost:5194"
const qaHome = process.env.I18N_QA_HOME ?? process.argv[2]
if (!qaHome) throw new Error("Set I18N_QA_HOME to the isolated QA HOME containing qa-state.json")
const state = JSON.parse(await readFile(join(qaHome, "qa-state.json"), "utf8")) as { projectId: string; chatId: string }
const out = join(process.cwd(), ".codex-runs/i18n-shots")
await mkdir(out, { recursive: true })
const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: "en-US" })
const page = await context.newPage()
const errors: string[] = []
const checks: { name: string; passed: boolean; detail?: unknown }[] = []
const screenshots: string[] = []
page.on("pageerror", (error) => errors.push(String(error)))
function check(name: string, passed: boolean, detail?: unknown) {
  checks.push({ name, passed, detail })
  if (!passed) throw new Error(`${name}: ${JSON.stringify(detail)}`)
}
async function shot(name: string, target?: ReturnType<Page["locator"]>) {
  const path = join(out, `${name}.png`)
  if (target) await target.screenshot({ path })
  else await page.screenshot({ path, fullPage: true })
  screenshots.push(path)
  const overflow = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth }))
  check(`no page overflow: ${name}`, overflow.document <= overflow.width, overflow)
}
async function lang(expected: string) { await page.waitForFunction((value) => document.documentElement.lang === value, expected) }
async function select(label: string, option: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click()
  await page.getByRole("option", { name: option, exact: true }).press("Enter")
}
async function command(command: Record<string, unknown>) {
  return page.evaluate(async (command) => await new Promise<unknown>((resolve, reject) => {
    const socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`)
    const timer = setTimeout(() => { socket.close(); reject(new Error("QA command timed out")) }, 15000)
    socket.onopen = () => socket.send(JSON.stringify({ v: 1, type: "command", id: "qa", command }))
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== "qa") return
      clearTimeout(timer); socket.close()
      if (message.type === "error") reject(new Error(message.message))
      else resolve(message.result)
    }
  }), command)
}
try {
  // Seed only this isolated instance, never the developer's real memory pool.
  const existing = await (await fetch(`${base}/api/memories`)).json() as { data: unknown[] }
  if (existing.data.length === 0) for (const memory of [
    { content: "Store money as integer cents.", scope: "project", type: "constraint", projectId: state.projectId },
    { content: "Prefer early returns.", scope: "personal", type: "preference" },
    { content: "The API uses port 3001.", scope: "session", type: "fact", sessionId: state.chatId },
    { content: "Use isolated fixtures for tests.", scope: "project", type: "lesson", status: "candidate", projectId: state.projectId },
  ]) {
    const response = await fetch(`${base}/api/memories`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(memory) })
    check("seed memory", response.ok, await response.text())
  }
  await page.goto(`${base}/settings/general`)
  await page.getByRole("combobox", { name: /Language|语言/ }).waitFor()
  if (await page.locator("html").getAttribute("lang") === "zh-CN") await select("语言", "English")
  await lang("en")
  const navigationCount = { value: 0 }
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigationCount.value++ })
  await select("Language", "简体中文")
  await lang("zh-CN")
  check("switch updates registry immediately", await page.getByText("选择界面语言，更改立即生效。", { exact: true }).isVisible())
  check("switch does not navigate/reload", navigationCount.value === 0)
  check("resolved locale cached", await page.evaluate(() => localStorage.getItem("memosync:resolved-language")) === "zh-CN")
  await select("语言", "English")
  await lang("en")
  check("switch back uses English registry", await page.getByText("Choose the interface language. Changes apply immediately.", { exact: true }).isVisible())
  await shot("settings-general-en")
  await select("Language", "System")
  await lang("en")
  await page.evaluate(() => {
    Object.defineProperty(navigator, "languages", { configurable: true, get: () => ["en-US", "zh-HK"] })
    window.dispatchEvent(new Event("languagechange"))
  })
  await lang("zh-CN")
  check("System follows a Chinese secondary browser language", true)
  await select("语言", "简体中文")
  await page.evaluate(() => {
    Object.defineProperty(navigator, "languages", { configurable: true, get: () => ["en-US"] })
    window.dispatchEvent(new Event("languagechange"))
  })
  await lang("zh-CN")
  check("explicit language ignores system changes", true)
  for (const theme of ["light", "dark"] as const) {
    await page.goto(`${base}/settings/general`)
    await page.getByRole("combobox", { name: "主题", exact: true }).waitFor()
    await select("主题", theme === "light" ? "浅色" : "深色")
    await page.waitForFunction((dark) => document.documentElement.classList.contains("dark") === dark, theme === "dark")
    await shot(`settings-general-zh-${theme}`)
    await page.goto(`${base}/settings/memory`)
    await page.getByText("从对话中学习", { exact: true }).waitFor()
    await shot(`settings-memory-zh-${theme}`)
    await page.goto(`${base}/memory`)
    await page.getByPlaceholder("搜索记忆…").waitFor()
    await page.getByText("Store money as integer cents.", { exact: true }).first().waitFor()
    await shot(`memory-board-zh-${theme}`)
    await page.goto(`${base}/chat/${state.chatId}`)
    await page.getByRole("textbox").first().waitFor()
    await page.getByText("本轮工作记忆", { exact: true }).waitFor()
    // Let virtualization and type-in empty-state animations settle before capture.
    await page.waitForTimeout(500)
    await shot(`chat-memory-cards-zh-${theme}`)
    const textarea = page.locator("textarea").first()
    await textarea.fill("保留输入草稿 / keep this draft")
    const composer = textarea.locator("xpath=ancestor::div[contains(@class, 'rounded')][1]")
    await shot(`composer-zh-${theme}`, composer)
    const sidebar = page.getByRole("separator", { name: "调整侧栏宽度" }).locator("xpath=..")
    await shot(`sidebar-zh-${theme}`, sidebar)
    if (!await page.getByText("记忆记录", { exact: true }).first().isVisible()) await page.getByRole("button", { name: "会话记忆", exact: true }).click()
    await page.getByText("记忆记录", { exact: true }).first().waitFor()
    await shot(`memory-record-zh-${theme}`)
    await textarea.fill("")
  }
  // The exported artifact is self-contained; serve its generated HTML at an
  // intercepted local test origin to verify the real bundled viewer offline.
  const exported = await command({ type: "chat.exportStandalone", chatId: state.chatId, theme: "dark", attachmentMode: "metadata" }) as { indexHtmlPath: string }
  const exportHtml = await readFile(exported.indexHtmlPath, "utf8")
  await page.route("http://i18n-export.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: exportHtml }))
  await page.addInitScript(() => {
    try { localStorage.setItem("memosync:resolved-language", "zh-CN") } catch {}
  })
  await page.goto("http://i18n-export.test/viewer")
  await lang("zh-CN")
  await page.getByText("本轮工作记忆", { exact: true }).waitFor()
  check("export viewer preserves original agent content", await page.getByText(/User and agent content stays in its original language/).isVisible())
  await shot("export-viewer-zh-dark")
  await page.unroute("http://i18n-export.test/**")
  await page.route("http://i18n-preview-error.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: renderStandalonePreviewError("port", 65534) }))
  await page.goto("http://i18n-preview-error.test/")
  await lang("zh-CN")
  check("standalone server preview error localizes", await page.getByText("端口65534当前没有服务响应。", { exact: true }).isVisible())
  await shot("preview-error-zh")
  await page.unroute("http://i18n-preview-error.test/**")
  // A mounted standalone message + live registry update, retaining input state.
  await page.goto(`${base}/src/client/test-fixtures/i18n/index.html`)
  await page.locator("#draft").fill("state survives 语言切换")
  const originalInput = await page.locator("#draft").elementHandle()
  await page.getByRole("button", { name: "简体中文", exact: true }).click()
  await lang("zh-CN")
  await page.getByText("正在运行…", { exact: true }).waitFor()
  check("mounted component re-renders", await page.locator("[data-registry]").textContent() === "使用记忆")
  check("scope helper re-renders", await page.locator("[data-scope]").textContent() === "个人")
  check("switch preserves component/input identity", await originalInput!.evaluate((input) => input === document.querySelector("#draft")))
  check("switch preserves draft state", await page.locator("#draft").inputValue() === "state survives 语言切换")
  await page.getByRole("button", { name: "English", exact: true }).click()
  await page.getByText("Running...", { exact: true }).waitFor()
  check("standalone component switches back", await page.locator("[data-registry]").textContent() === "Use Memory")
  // Reload starts in the persisted language; initial visible UI never flashes English.
  await page.goto(`${base}/settings/general`)
  await lang("zh-CN")
  const firstFrames = await page.evaluate(async () => {
    const modulePath = "/src/client/i18n/index.ts"
    const { i18n } = await import(/* @vite-ignore */ modulePath)
    return { lang: document.documentElement.lang, resolved: i18n.resolvedLanguage, cached: localStorage.getItem("memosync:resolved-language") }
  })
  check("persisted language wins at hydration", firstFrames.resolved === "zh-CN", firstFrames)
  const cachedContext = await browser.newContext({ viewport: { width: 900, height: 700 }, locale: "en-US" })
  await cachedContext.addInitScript(() => {
    localStorage.setItem("memosync:resolved-language", "zh-CN")
    const state = window as unknown as { __firstUi?: { text: string; lang: string } }
    new MutationObserver(() => {
      const text = document.getElementById("root")?.textContent?.trim()
      if (text && !state.__firstUi) state.__firstUi = { text, lang: document.documentElement.lang }
    }).observe(document, { childList: true, subtree: true })
  })
  const cachedPage = await cachedContext.newPage()
  await cachedPage.goto(`${base}/settings/general`)
  await cachedPage.getByRole("combobox", { name: "语言", exact: true }).waitFor()
  const initialUi = await cachedPage.evaluate(() => (window as unknown as { __firstUi: { text: string; lang: string } }).__firstUi)
  check("cached Chinese applies before the first UI render", initialUi.lang === "zh-CN" && !initialUi.text.includes("Checking session"), initialUi)
  await cachedContext.close()
  const deniedContext = await browser.newContext({ locale: "en-US" })
  await deniedContext.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get: () => { throw new DOMException("Storage disabled", "SecurityError") } })
  })
  const deniedPage = await deniedContext.newPage()
  const deniedErrors: string[] = []
  deniedPage.on("pageerror", (error) => deniedErrors.push(String(error)))
  await deniedPage.goto(`${base}/src/client/test-fixtures/i18n/index.html`)
  await deniedPage.getByRole("button", { name: "简体中文", exact: true }).click()
  await deniedPage.getByText("正在运行…", { exact: true }).waitFor()
  check("disabled storage does not prevent language switching", deniedErrors.length === 0, deniedErrors)
  await deniedContext.close()
  // Narrow layouts in both themes use the same real app controls.
  await page.setViewportSize({ width: 390, height: 844 })
  for (const theme of ["light", "dark"] as const) {
    await command({ type: "settings.writeAppSettingsPatch", patch: { theme } })
    for (const [name, path] of [["settings-general", "/settings/general"], ["settings-memory", "/settings/memory"], ["memory-board", "/memory"], ["chat", `/chat/${state.chatId}`]]) {
      await page.goto(`${base}${path}`)
      await lang("zh-CN")
      if (name === "settings-general") await page.getByRole("combobox", { name: "语言", exact: true }).waitFor()
      else if (name === "settings-memory") await page.getByText("从对话中学习", { exact: true }).waitFor()
      else if (name === "memory-board") await page.getByPlaceholder("搜索记忆…").waitFor()
      else await page.getByRole("textbox").first().waitFor()
      await shot(`${name}-zh-${theme}-mobile`)
    }
  }
  check("no uncaught browser errors", errors.length === 0, errors)
} finally {
  await writeFile(join(out, "verification.json"), JSON.stringify({ base, qaHome, checks, screenshots, errors }, null, 2))
  await browser.close()
}
console.log(JSON.stringify({ checks: checks.length, screenshots: screenshots.length, errors }))
