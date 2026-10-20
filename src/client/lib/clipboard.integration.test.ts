import { expect, test } from "bun:test"
import { chromium, type Browser } from "playwright"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

type ClipboardWindow = Window & { copyForTest: (text: string) => Promise<boolean> }

test("copies real code over ordinary HTTP and restores clipboard fallback state", async () => {
  const fixtureDirectory = new URL("../components/messages/fixtures/clipboard/", import.meta.url)
  const html = await Bun.file(fileURLToPath(new URL("index.html", fixtureDirectory))).text()
  const entrypoint = fileURLToPath(new URL("main.tsx", fixtureDirectory))
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))
  const tempDir = await mkdtemp(join(tmpdir(), "memosync-clipboard-"))
  let browser: Browser | undefined
  let server: ReturnType<typeof Bun.serve> | undefined
  try {
    const bundlePath = join(tempDir, "clipboard.js")
    const build = Bun.spawn([process.execPath, "build", entrypoint, "--target=browser", `--outfile=${bundlePath}`], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    })
    const stdout = build.stdout ? new Response(build.stdout).text() : Promise.resolve("")
    const stderr = build.stderr ? new Response(build.stderr).text() : Promise.resolve("")
    const exitCode = await build.exited
    const [buildStdout, buildStderr] = await Promise.all([stdout, stderr])
    if (exitCode !== 0) {
      throw new Error(`Clipboard fixture build failed (${exitCode})\n${buildStdout}\n${buildStderr}`)
    }
    const scriptText = await readFile(bundlePath, "utf8")
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const pathname = new URL(request.url).pathname
        if (pathname === "/") {
          return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })
        }
        if (pathname === "/main.js") {
          return new Response(scriptText, { headers: { "content-type": "text/javascript; charset=utf-8" } })
        }
        return new Response("Not found", { status: 404 })
      },
    })
    browser = await chromium.launch({
      headless: true,
      args: ["--host-resolver-rules=MAP memosync-test.invalid 127.0.0.1", "--no-proxy-server"],
    })
    const page = await browser.newPage()
    page.setDefaultTimeout(5_000)
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    const url = `http://memosync-test.invalid:${server.port}/`
    await page.goto(url, { waitUntil: "domcontentloaded" })
    await page.getByTestId("code").waitFor()
    expect(await page.evaluate(() => window.isSecureContext)).toBe(false)
    expect(await page.evaluate(() => typeof navigator.clipboard)).toBe("undefined")
    await page.getByTestId("code").locator("button").click()
    await page.getByLabel("Paste destination").focus()
    await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V")
    await page.waitForFunction(() => (document.getElementById("paste") as HTMLTextAreaElement).value === "echo 你好\nsecond line")
    expect(await page.getByLabel("Paste destination").inputValue()).toBe("echo 你好\nsecond line")
    await page.getByTestId("code").locator(".lucide-check").waitFor()
    expect(errors).toEqual([])

    await page.getByRole("button", { name: "Open modal", exact: true }).click()
    await page.getByTestId("modal-code").locator("button").click()
    await page.getByLabel("Modal paste destination").focus()
    await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V")
    await page.waitForFunction(() => (document.querySelector('[aria-label="Modal paste destination"]') as HTMLTextAreaElement).value === "modal copy\n你好")
    expect(await page.getByLabel("Modal paste destination").inputValue()).toBe("modal copy\n你好")
    await page.getByRole("dialog").press("Escape")

    const native = await page.evaluate(async () => {
      let written = ""
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (text: string) => { written = text } },
      })
      document.execCommand = () => { throw new Error("Native success must not use fallback") }
      const copied = await (window as ClipboardWindow).copyForTest("native text")
      return { copied, written }
    })
    expect(native).toEqual({ copied: true, written: "native text" })

    for (const outcome of ["success", "false", "throw"] as const) {
      const fallback = await page.evaluate(async (outcome) => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: async () => { throw new DOMException("Denied", "NotAllowedError") } },
        })
        const draft = document.getElementById("draft") as HTMLTextAreaElement
        draft.focus()
        draft.setSelectionRange(2, 8, "backward")
        const beforeCount = document.querySelectorAll("textarea").length
        let selected = ""
        document.execCommand = (command) => {
          if (command !== "copy") throw new Error("Unexpected command")
          selected = (document.activeElement as HTMLTextAreaElement).value
          if (outcome === "throw") throw new Error("Copy denied")
          return outcome === "success"
        }
        const copied = await (window as ClipboardWindow).copyForTest("fallback text")
        return {
          copied, selected, focused: document.activeElement === draft,
          selection: [draft.selectionStart, draft.selectionEnd, draft.selectionDirection],
          clean: document.querySelectorAll("textarea").length === beforeCount,
          value: draft.value,
        }
      }, outcome)
      expect(fallback).toEqual({
        copied: outcome === "success", selected: "fallback text", focused: true,
        selection: [2, 8, "backward"], clean: true, value: "unfinished draft",
      })
    }

    const restoredRange = await page.evaluate(async () => {
      (document.activeElement as HTMLElement).blur()
      const selection = document.getSelection()!
      const range = document.createRange()
      range.selectNodeContents(document.getElementById("selection")!)
      selection.removeAllRanges()
      selection.addRange(range)
      document.execCommand = () => true
      await (window as ClipboardWindow).copyForTest("selection copy")
      return selection.toString()
    })
    expect(restoredRange).toBe("Selection to preserve")

    await page.goto(url, { waitUntil: "domcontentloaded" })
    await page.getByTestId("code").waitFor()
    await page.evaluate(() => { document.execCommand = () => false })
    await page.getByTestId("code").locator("button").click()
    expect(await page.getByTestId("code").locator(".lucide-check").count()).toBe(0)
    expect(await page.locator("textarea").count()).toBe(2)
    expect(errors).toEqual([])
  } finally {
    try {
      await browser?.close()
    } finally {
      try {
        await server?.stop(true)
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    }
  }
}, 30_000)
