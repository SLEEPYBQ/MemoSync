import { expect, test } from "bun:test"
import path from "node:path"
import react from "@vitejs/plugin-react"
import { chromium, type Browser } from "playwright"
import { createServer } from "vite"

test("uploads and submits attachments over ordinary HTTP without crypto.randomUUID", async () => {
  const vite = await createServer({
    configFile: false,
    root: path.resolve(import.meta.dir, "../../../.."),
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 0,
      allowedHosts: ["memosync-test.invalid"],
    },
    logLevel: "silent",
  })
  let browser: Browser | undefined
  try {
    await vite.listen()
    const address = vite.httpServer!.address()
    if (!address || typeof address === "string") throw new Error("Vite did not bind a TCP port")
    browser = await chromium.launch({
      headless: true,
      args: ["--host-resolver-rules=MAP memosync-test.invalid 127.0.0.1", "--no-proxy-server"],
    })
    const page = await browser.newPage()
    page.setDefaultTimeout(5_000)
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    const uploads: string[] = []
    const attachment = {
      id: "uploaded-file", kind: "file", displayName: "hello.txt",
      absolutePath: "/project/hello.txt", relativePath: "hello.txt",
      contentUrl: "/api/projects/http-upload-project/uploads/uploaded-file",
      mimeType: "text/plain", size: 12,
    }
    await page.route("**/api/projects/http-upload-project/uploads", async (route) => {
      if (route.request().method() !== "POST") throw new Error("Expected upload POST")
      uploads.push(route.request().postData() ?? "")
      await route.fulfill({ json: { attachments: [attachment] } })
    })
    await page.goto(`http://memosync-test.invalid:${address.port}/src/client/components/chat-ui/fixtures/http-uploads/index.html`)
    await page.getByPlaceholder("Build something...").waitFor({ state: "visible" })
    expect(await page.evaluate(() => window.isSecureContext)).toBe(false)
    expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe("undefined")

    await page.locator('input[type="file"]').setInputFiles({
      name: "hello.txt", mimeType: "text/plain", buffer: Buffer.from("hello upload"),
    })
    await page.getByPlaceholder("Build something...").fill("Use this file")
    await page.getByPlaceholder("Build something...").locator("..").locator("button").click()
    await page.getByTestId("submitted").filter({ hasText: "uploaded-file" }).waitFor({ state: "visible" })
    expect(uploads).toHaveLength(1)
    expect(uploads[0]).toContain('filename="hello.txt"')
    expect(uploads[0]).toContain("hello upload")
    expect(JSON.parse(await page.getByTestId("submitted").textContent() ?? "")).toEqual({
      value: "Use this file", attachments: [attachment],
    })
    expect(errors).toEqual([])
  } finally {
    try {
      await browser?.close()
    } finally {
      await vite.close()
    }
  }
}, 30_000)
