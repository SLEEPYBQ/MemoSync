import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { chromium, type Browser, type Page } from "playwright"
import { previewProxyPath } from "../shared/preview-proxy"
import { previewProxyTarget, proxyPreviewRequest } from "./preview-proxy"

const dependencySeed = process.env.STUDY_DEPENDENCY_SEED
const nextModules = dependencySeed ? join(dependencySeed, "frontend", "node_modules") : ""
const nextE2eRequested = process.env.NEXT_PREVIEW_E2E === "1"
const nextPackagePath = join(nextModules, "next", "package.json")
if (nextE2eRequested && !existsSync(nextPackagePath)) {
  throw new Error(`NEXT_PREVIEW_E2E requires the image-baked Next runtime at ${nextPackagePath}`)
}

async function availablePort(): Promise<number> {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") })
  const port = reservation.port
  reservation.stop(true)
  if (port === undefined) throw new Error("Bun did not reserve a TCP port")
  return port
}

interface PipedProcess {
  exitCode: number | null
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
  kill(): void
}

async function waitForHttp(url: string, process: PipedProcess) {
  const deadline = Date.now() + 30_000
  let lastError: unknown = new Error("Next did not answer")
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      const stderr = await new Response(process.stderr).text()
      throw new Error(`Next exited before becoming ready (${process.exitCode}): ${stderr}`)
    }
    try {
      const response = await fetch(url)
      if (response.ok) return
      lastError = new Error(`Next answered ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await Bun.sleep(100)
  }
  throw lastError
}

describe.skipIf(!nextE2eRequested)("Next 15 App Router through the public preview path", () => {
  let browser: Browser
  let directBase = ""
  let fixtureDir = ""
  let gateway: ReturnType<typeof Bun.serve>
  let nextProcess: PipedProcess
  let nextTargetPort = 0
  let page: Page
  let previewBase = ""

  beforeAll(async () => {
    const nextPackage = await Bun.file(nextPackagePath).json() as { version?: unknown }
    if (typeof nextPackage.version !== "string" || !nextPackage.version.startsWith("15.")) {
      throw new Error(`Expected Next 15 in the dependency seed, received ${String(nextPackage.version)}`)
    }
    fixtureDir = await mkdtemp(join(tmpdir(), "memosync-next-preview-"))
    await mkdir(join(fixtureDir, "app", "detail"), { recursive: true })
    await mkdir(join(fixtureDir, "app", "redirect-me"), { recursive: true })
    await symlink(nextModules, join(fixtureDir, "node_modules"), "dir")
    await writeFile(join(fixtureDir, "package.json"), JSON.stringify({
      private: true,
      scripts: { dev: "next dev" },
      dependencies: { next: "15.5.0", react: "19.1.0", "react-dom": "19.1.0" },
    }))
    await writeFile(join(fixtureDir, "app", "layout.tsx"), `
import Link from "next/link";
export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body>
    <nav>
      <Link href="/" data-testid="home-link">Home</Link>
      <Link href="/detail" data-testid="nav-detail-link">Detail</Link>
      <Link href="/redirect-me" data-testid="redirect-link">Redirect</Link>
    </nav>
    {children}
  </body></html>;
}
`)
    await writeFile(join(fixtureDir, "app", "page.tsx"), `
import Link from "next/link";
import HydrationReady from "./HydrationReady";
export default function Home() {
  return <main>
    <h1>Next fixture home</h1>
    <HydrationReady />
    <Link href="/detail">Open detail</Link>
  </main>;
}
`)
    await writeFile(join(fixtureDir, "app", "HydrationReady.tsx"), `
"use client";
import { useEffect, useState } from "react";
export default function HydrationReady() {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return <p data-testid="hydration-ready">{ready ? "Hydrated" : "Hydrating"}</p>;
}
`)
    await writeFile(join(fixtureDir, "app", "detail", "page.tsx"), `
import DetailClient from "./DetailClient";
export default function Detail() {
  return <main><h1>Next fixture detail</h1><DetailClient /></main>;
}
`)
    await writeFile(join(fixtureDir, "app", "detail", "DetailClient.tsx"), `
"use client";
import { useState } from "react";
export default function DetailClient() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount((value) => value + 1)}>Detail count: {count}</button>;
}
`)
    await writeFile(join(fixtureDir, "app", "redirect-me", "page.tsx"), `
import { redirect } from "next/navigation";
export default function RedirectMe() { redirect("/detail?from=redirect"); }
`)

    const nextPort = await availablePort()
    nextTargetPort = nextPort
    nextProcess = Bun.spawn([
      "node",
      join(nextModules, "next", "dist", "bin", "next"),
      "dev",
      "--turbopack",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(nextPort),
    ], {
      cwd: fixtureDir,
      env: {
        ...process.env,
        NODE_ENV: "development",
        NEXT_TELEMETRY_DISABLED: "1",
        NEXT_PRIVATE_OUTPUT_TRACE_ROOT: "/",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    await waitForHttp(`http://127.0.0.1:${nextPort}/`, nextProcess)
    directBase = `http://127.0.0.1:${nextPort}/`

    gateway = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const targetPort = previewProxyTarget(request, gateway.port ?? -1)
        if (targetPort === null) return new Response("Not found", { status: 404 })
        return proxyPreviewRequest(request, new URL(request.url), targetPort)
      },
    })
    previewBase = `http://127.0.0.1:${gateway.port}${previewProxyPath(nextPort)}`
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    })
    page = await browser.newPage()
    page.setDefaultTimeout(15_000)
  }, 45_000)

  afterAll(async () => {
    await page?.close()
    await browser?.close()
    gateway?.stop(true)
    nextProcess?.kill()
    await nextProcess?.exited
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true })
  })

  it("hydrates and keeps Link, RSC, dynamic chunks, hard reload, Home, and redirects inside the preview mount", async () => {
    const browserErrors: string[] = []
    const httpErrors: string[] = []
    const requestUrls: string[] = []
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text())
    })
    page.on("pageerror", (error) => browserErrors.push(error.message))
    page.on("request", (request) => requestUrls.push(request.url()))
    page.on("response", (response) => {
      if (response.status() >= 400) httpErrors.push(`${response.status()} ${response.url()}`)
    })

    await page.goto(previewBase)
    await page.getByRole("heading", { name: "Next fixture home" }).waitFor()
    await page.getByTestId("hydration-ready").getByText("Hydrated").waitFor()
    expect(page.url()).toBe(previewBase)

    await page.getByRole("link", { name: "Open detail" }).click()
    await page.getByRole("heading", { name: "Next fixture detail" }).waitFor()
    await page.getByRole("button", { name: "Detail count: 0" }).click()
    await page.getByRole("button", { name: "Detail count: 1" }).waitFor()
    expect(page.url()).toBe(`${previewBase}detail`)

    const navigationRequests = requestUrls.filter((url) => url.includes("?_rsc=") || url.includes("/_next/"))
    expect(navigationRequests.some((url) => url.includes("?_rsc="))).toBe(true)
    expect(navigationRequests.some((url) => decodeURIComponent(url).includes("_app_detail_page_"))).toBe(true)
    expect(navigationRequests.filter((url) => !url.startsWith(previewBase))).toEqual([])

    const previewPath = previewProxyPath(nextTargetPort)
    const chunkPaths = [...new Set(navigationRequests
      .filter((url) => url.startsWith(previewBase) && url.includes("/_next/static/chunks/"))
      .map((url) => new URL(url).pathname.slice(previewPath.length - 1)))]
    const exactChunkPaths = [
      chunkPaths.find((chunkPath) => decodeURIComponent(chunkPath).includes("next_dist_compiled_react-dom")),
      chunkPaths.find((chunkPath) => decodeURIComponent(chunkPath).includes("_app_detail_page_")),
      chunkPaths.find((chunkPath) => (
        decodeURIComponent(chunkPath).split("/").at(-1)?.startsWith("turbopack-")
      )),
    ]
    expect(exactChunkPaths.every(Boolean)).toBe(true)
    for (const chunkPath of exactChunkPaths as string[]) {
      const [rawResponse, proxyResponse] = await Promise.all([
        fetch(`http://127.0.0.1:${nextTargetPort}${chunkPath}`),
        fetch(`${previewBase}${chunkPath.slice(1)}`),
      ])
      const [rawBytes, proxyBytes] = await Promise.all([
        rawResponse.arrayBuffer().then((value) => new Uint8Array(value)),
        proxyResponse.arrayBuffer().then((value) => new Uint8Array(value)),
      ])
      const firstDifference = rawBytes.findIndex((byte, index) => byte !== proxyBytes[index])
      const rawSha256 = createHash("sha256").update(rawBytes).digest("hex")
      const proxySha256 = createHash("sha256").update(proxyBytes).digest("hex")
      expect(rawResponse.status).toBe(200)
      expect(proxyResponse.status).toBe(200)
      expect(rawResponse.headers.get("content-type")).toContain("javascript")
      expect(proxyResponse.headers.get("content-type")).toContain("javascript")
      expect(proxySha256).toBe(rawSha256)
      expect(firstDifference).toBe(-1)
    }

    const runtimeScriptUrl = await page.evaluate(() => {
      const script = [...document.scripts].find((candidate) => candidate.src.includes("/turbopack-"))
      return script ? { attribute: script.getAttribute("src"), property: script.src } : null
    })
    expect(runtimeScriptUrl?.attribute).toStartWith("/_next/static/chunks/turbopack-")
    expect(runtimeScriptUrl?.property).toStartWith(`${previewBase}_next/static/chunks/turbopack-`)

    await page.reload()
    await page.getByRole("heading", { name: "Next fixture detail" }).waitFor()
    await page.getByRole("button", { name: "Detail count: 0" }).click()
    await page.getByRole("button", { name: "Detail count: 1" }).waitFor()
    expect(page.url()).toBe(`${previewBase}detail`)

    await page.getByTestId("home-link").click()
    await page.getByRole("heading", { name: "Next fixture home" }).waitFor()
    expect(page.url()).toBe(previewBase)

    await page.getByTestId("redirect-link").click()
    await page.getByRole("heading", { name: "Next fixture detail" }).waitFor()
    expect(page.url()).toBe(`${previewBase}detail?from=redirect`)
    // The preview gateway deliberately does not proxy dev-server WebSockets;
    // Next's HMR connection therefore reports a known manual-refresh warning.
    // Application errors and escaped HTTP resources must still stay at zero.
    const unexpectedErrors = browserErrors.filter((message) => (
      !message.includes("/_next/webpack-hmr")
      && message !== "Failed to load resource: the server responded with a status of 404 (Not Found)"
    ))
    expect(unexpectedErrors).toEqual([])
    expect(httpErrors.filter((entry) => !entry.includes("/_next/webpack-hmr"))).toEqual([])
  }, 45_000)

  it("proves the generated Next fixture works at its direct origin", async () => {
    const controlPage = await browser.newPage()
    try {
      await controlPage.goto(directBase)
      await controlPage.getByRole("heading", { name: "Next fixture home" }).waitFor()
      await controlPage.getByTestId("hydration-ready").getByText("Hydrated").waitFor()
      await controlPage.getByRole("link", { name: "Open detail" }).click()
      await controlPage.getByRole("heading", { name: "Next fixture detail" }).waitFor()
      await controlPage.getByRole("button", { name: "Detail count: 0" }).click()
      await controlPage.getByRole("button", { name: "Detail count: 1" }).waitFor()
    } finally {
      await controlPage.close()
    }
  })
})
