import { expect, test } from "bun:test"
import { copyFile, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { chromium, type Browser } from "playwright"
import { writeStandaloneTranscriptExport } from "./standalone-export"
import { persistProjectUpload } from "./uploads"

test("opens the real standalone export offline with image and text previews, retaining HTTP fallback", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "memosync-offline-export-"))
  let browser: Browser | undefined
  let server: ReturnType<typeof Bun.serve> | undefined
  try {
    const attachmentPath = path.join(projectDir, "proof.png")
    await copyFile(new URL("../../public/icon-192.png", import.meta.url), attachmentPath)
    const textFiles = [
      { name: "notes.md", mime: "text/markdown; charset=utf-8", content: "# Offline markdown note", marker: "Offline markdown note" },
      { name: "data.json", mime: "application/json; charset=utf-8", content: '{"proof":"offline-json-value"}', marker: "offline-json-value" },
      { name: "table.csv", mime: "text/csv; charset=utf-8", content: "name,value\noffline-table-value,42", marker: "offline-table-value" },
      { name: "table.tsv", mime: "text/tab-separated-values; charset=utf-8", content: "name\tvalue\noffline-tsv-value\t42", marker: "offline-tsv-value" },
      { name: "plain.txt", mime: "text/plain; charset=utf-8", content: "Offline plain text", marker: "Offline plain text" },
    ]
    const textAttachments = await Promise.all(textFiles.map(async (file) => {
      const attachment = await persistProjectUpload({
        projectId: "offline-proof-project",
        localPath: projectDir,
        fileName: file.name,
        bytes: Buffer.from(file.content),
      })
      expect(attachment.mimeType).toBe(file.mime)
      return attachment
    }))
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
          }, ...textAttachments],
        },
        { _id: "last", createdAt: 2, kind: "assistant_text", messageId: "last", text: "Final offline reply" },
      ],
    })
    await rename(exported.transcriptJsonPath, `${exported.transcriptJsonPath}.saved`)
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
    for (const file of textFiles) {
      await page.getByRole("button", { name: new RegExp(file.name.replaceAll(".", "\\.")) }).click()
      await page.getByRole("dialog").filter({ hasText: file.marker }).waitFor({ state: "visible", timeout: 5_000 })
      if (file.name.endsWith(".csv") || file.name.endsWith(".tsv")) {
        const table = page.getByRole("dialog").getByRole("table")
        expect(await table.getByRole("columnheader").allTextContents()).toEqual(["name", "value"])
        expect(await table.getByRole("cell").allTextContents()).toEqual([file.marker, "42"])
      }
      await page.getByRole("button", { name: "Close", exact: true }).click()
    }
    await page.evaluate(() => document.fonts.ready.then(() => undefined))
    expect(networkRequests).toEqual([])
    expect(failures).toEqual([])

    await rename(`${exported.transcriptJsonPath}.saved`, exported.transcriptJsonPath)
    const bundle = await Bun.file(exported.transcriptJsonPath).json()
    const notes = bundle.messages[0].attachments.find((attachment: { displayName: string }) => attachment.displayName === "notes.md")
    await writeFile(path.join(exported.outputDir, notes.contentUrl), "# HTTP attachment source")
    const html = await readFile(exported.indexHtmlPath, "utf8")
    await writeFile(exported.indexHtmlPath, html.replace(/<script id="memosync-transcript-data" type="application\/json">[\s\S]*?<\/script>/, ""))
    const httpPaths: string[] = []
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const pathname = new URL(request.url).pathname
      httpPaths.push(pathname)
      const file = Bun.file(path.join(exported.outputDir, pathname))
      return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 })
    } })
    await page.unroute(/^https?:\/\//)
    await page.goto(`http://127.0.0.1:${server.port}/index.html`)
    await page.getByRole("button", { name: /notes\.md/ }).click()
    await page.getByRole("dialog").filter({ hasText: "HTTP attachment source" }).waitFor({ state: "visible", timeout: 5_000 })
    expect(httpPaths).toContain("/transcript.json")
    expect(httpPaths).toContain(notes.contentUrl.replace(/^\./, ""))
    expect(httpPaths.filter((pathname) => pathname.startsWith("/api/"))).toEqual([])
    expect(failures).toEqual([])
  } finally {
    await browser?.close()
    server?.stop(true)
    await rm(projectDir, { recursive: true, force: true })
  }
}, 25_000)
