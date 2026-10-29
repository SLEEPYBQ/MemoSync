import { join } from "node:path"
import react from "@vitejs/plugin-react"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import { PROVIDERS } from "../../shared/types"

export type MountedRaceView = "app-state" | "chat-input"

export async function startMountedRaceHarness() {
  const vite: ViteDevServer = await createServer({
    configFile: false,
    root: join(import.meta.dir, "../test-fixtures/race-tests"),
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
      hmr: false,
    },
    logLevel: "error",
  })
  await vite.listen()
  const address = vite.httpServer?.address()
  if (!address || typeof address === "string") {
    await vite.close()
    throw new Error("Vite did not bind a TCP port")
  }

  const browser: Browser = await chromium.launch({ headless: true })
  const baseUrl = `http://127.0.0.1:${address.port}`
  let uploadCount = 0

  return {
    async openPage(view: MountedRaceView): Promise<Page> {
      uploadCount = 0
      const page = await browser.newPage()
      page.setDefaultTimeout(5_000)
      page.on("pageerror", (error) => console.error(`[race fixture pageerror] ${error.stack ?? error.message}`))
      page.on("console", (message) => {
        if (message.type() === "error") console.error(`[race fixture console] ${message.text()}`)
      })
      page.on("response", (response) => {
        if (response.status() >= 400) {
          void response.text().then((body) => {
            console.error(`[race fixture response ${response.status()}] ${response.url()}\n${body}`)
          })
        }
      })
      await page.route("**/api/**", async (route) => {
        const url = new URL(route.request().url())
        if (url.pathname === "/api/condition") {
          await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
              data: {
                condition: "memosync",
                capture: "review",
                preview: true,
                trace: true,
                boardVisible: true,
                boardWritable: true,
                bringIn: true,
                injection: "skills",
                memoryTools: true,
                studyMode: false,
              },
              providers: PROVIDERS,
            }),
          })
          return
        }

        if (route.request().method() === "POST" && url.pathname.endsWith("/uploads")) {
          uploadCount += 1
          await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
              attachments: [{
                id: `fixture-attachment-${uploadCount}`,
                kind: "file",
                displayName: `uploaded-${uploadCount}.txt`,
                absolutePath: `/fixture/uploaded-${uploadCount}.txt`,
                relativePath: `uploaded-${uploadCount}.txt`,
                contentUrl: `/api/projects/fixture/uploads/${uploadCount}/content`,
                mimeType: "text/plain",
                size: 1,
              }],
            }),
          })
          return
        }

        await route.fulfill({
          contentType: "application/json",
          body: "{}",
        })
      })
      await page.goto(`${baseUrl}/?view=${view}`)
      await page.getByTestId("fixture-ready").waitFor({ state: "attached" })
      return page
    },
    async close() {
      await browser.close()
      await vite.close()
    },
  }
}
