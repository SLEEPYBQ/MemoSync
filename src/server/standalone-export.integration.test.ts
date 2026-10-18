import { expect, test } from "bun:test"
import { copyFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { chromium, type Browser } from "playwright"
import { writeStandaloneTranscriptExport } from "./standalone-export"

test("opens the real standalone export offline with transcript and bundled image", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "memosync-offline-export-"))
  let browser: Browser | undefined
  try {
    const attachmentPath = path.join(projectDir, "proof.png")
    await copyFile(new URL("../../public/icon-192.png", import.meta.url), attachmentPath)
    const exported = await writeStandaloneTranscriptExport({
      chatId: "offline-proof",
      title: "Offline export proof",
      localPath: projectDir,
      theme: "light",
      attachmentMode: "bundle",
      messages: [
        {
          _id: "first", createdAt: 1, kind: "user_prompt", messageId: "first",
          content: "First offline prompt",
          attachments: [{
            id: "image", kind: "image", displayName: "proof.png", mimeType: "image/png",
            absolutePath: attachmentPath, relativePath: "proof.png", contentUrl: "/api/uploads/proof.png",
            size: (await Bun.file(attachmentPath).arrayBuffer()).byteLength,
          }],
        },
        { _id: "last", createdAt: 2, kind: "assistant_text", messageId: "last", text: "Final offline reply" },
      ],
    })
    await rm(exported.transcriptJsonPath)
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    const networkRequests: string[] = []
    const failures: string[] = []
    page.on("requestfailed", (request) => failures.push(request.url()))
    page.on("pageerror", (error) => failures.push(error.message))
    await page.route(/^https?:\/\//, (route) => {
      networkRequests.push(route.request().url())
      return route.abort()
    })
    await page.goto(pathToFileURL(exported.indexHtmlPath).href)
    await page.getByText("First offline prompt", { exact: true }).waitFor({ state: "visible", timeout: 10_000 })
    await page.getByText("Final offline reply", { exact: true }).waitFor({ state: "visible", timeout: 10_000 })
    const image = page.getByRole("img", { name: "proof.png", exact: true })
    await image.waitFor({ state: "visible" })
    expect(await image.evaluate(async (element) => {
      await (element as HTMLImageElement).decode()
      return (element as HTMLImageElement).naturalWidth
    })).toBeGreaterThan(0)
    await page.evaluate(() => document.fonts.ready.then(() => undefined))
    expect(networkRequests).toEqual([])
    expect(failures).toEqual([])
  } finally {
    await browser?.close()
    await rm(projectDir, { recursive: true, force: true })
  }
}, 25_000)
