import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { join } from "node:path"
import react from "@vitejs/plugin-react"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import { previewProxyPath } from "../shared/preview-proxy"
import { previewProxyTarget, proxyPreviewRequest } from "./preview-proxy"

describe("remote path preview contract", () => {
  let api: ReturnType<typeof Bun.serve>
  let browser: Browser
  let gateway: ReturnType<typeof Bun.serve>
  let page: Page
  let previewUrl: string
  let vite: ViteDevServer
  let backendGatewayHits = 0

  beforeAll(async () => {
    api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ message: "backend reached" }),
    })

    vite = await createServer({
      root: join(import.meta.dir, "fixtures", "preview-vite-app"),
      plugins: [react()],
      server: {
        host: "127.0.0.1",
        port: 0,
        strictPort: false,
        proxy: {
          "/api": { target: `http://127.0.0.1:${api.port}` },
        },
      },
      define: {
        "import.meta.env.VITE_FIXTURE_API_ORIGIN": JSON.stringify(`http://localhost:${api.port}`),
      },
      logLevel: "silent",
    })
    await vite.listen()
    const viteAddress = vite.httpServer!.address()
    if (!viteAddress || typeof viteAddress === "string") throw new Error("Vite did not bind a TCP port")

    gateway = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const targetPort = previewProxyTarget(request, gateway.port ?? -1)
        if (targetPort === null) return new Response("Not found", { status: 404 })
        if (targetPort === api.port) backendGatewayHits += 1
        return proxyPreviewRequest(request, new URL(request.url), targetPort)
      },
    })
    previewUrl = `http://127.0.0.1:${gateway.port}${previewProxyPath(viteAddress.port)}`

    browser = await chromium.launch({ headless: true })
    page = await browser.newPage()
    page.setDefaultTimeout(3_000)
  }, 20_000)

  afterAll(async () => {
    await page?.close()
    await browser?.close()
    gateway?.stop(true)
    await vite?.close()
    api?.stop(true)
  })

  it("renders a normal Vite/React app without changing its business strings", async () => {
    let websocketCount = 0
    page.on("websocket", () => { websocketCount += 1 })
    await page.goto(previewUrl)

    await page.locator("#root > *").first().waitFor({ state: "visible" })
    expect(await page.getByRole("heading", { name: "Remote preview ready" }).isVisible()).toBe(true)
    expect(await page.getByTestId("business-literal").textContent()).toBe("Business literal: /")
    await page.getByTestId("api-message").getByText("API: backend reached").waitFor({ state: "visible" })
    await page.getByTestId("xhr-message").getByText("XHR: backend reached").waitFor({ state: "visible" })
    await page.getByTestId("absolute-fetch-message").getByText("Absolute fetch: backend reached").waitFor({ state: "visible" })
    await page.getByTestId("absolute-xhr-message").getByText("Absolute XHR: backend reached").waitFor({ state: "visible" })
    expect(backendGatewayHits).toBeGreaterThanOrEqual(2)
    expect(await page.getByAltText("Fixture mark").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true)
    expect(await page.locator("main").evaluate((element) => getComputedStyle(element).color)).toBe("rgb(18, 52, 86)")

    await page.getByRole("button", { name: "Count: 0" }).click()
    await page.getByRole("button", { name: "Count: 1" }).waitFor({ state: "visible" })
    expect(await page.evaluate(() => Reflect.get(window, "__MEMOSYNC_PREVIEW_UPDATE_MODE__"))).toBe("manual-refresh")
    expect(websocketCount).toBe(0)
  })

  it("supports React Router navigation and a nested-route hard refresh", async () => {
    await page.goto(previewUrl)
    await page.getByRole("link", { name: "Apartment 42" }).click()
    await page.getByText("Apartment detail route").waitFor({ state: "visible" })

    await page.reload()
    await page.getByText("Apartment detail route").waitFor({ state: "visible" })
  })
})
