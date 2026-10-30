// No app server or provider: fixture data and blocked API routes only.
// Run with HOME=$(mktemp -d) MEMOSYNC_ISOLATE_CLI=1 bun scripts/benchmark-transcript.ts
import { createServer } from "vite"
import react from "@vitejs/plugin-react"
import { chromium } from "playwright"
import { join } from "node:path"

const vite = await createServer({ configFile: false, root: join(import.meta.dir, "../src/client/test-fixtures/transcript-performance"), plugins: [react()], server: { host: "127.0.0.1", port: 0, hmr: false }, logLevel: "error" })
await vite.listen()
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH })
try {
  const address = vite.httpServer!.address() as { port: number }
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "[]" }))
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${address.port}`)
  await page.waitForFunction(() => "runTranscriptBenchmark" in window)
  const results = []
  for (const mode of ["all", "viewport"]) {
    // One warm-up and five measured mounts; React development build, no StrictMode.
    await page.evaluate(mode => (window as any).runTranscriptBenchmark(mode), mode)
    const runs = []
    for (let i = 0; i < 5; i++) runs.push(await page.evaluate(mode => (window as any).runTranscriptBenchmark(mode), mode))
    const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]
    results.push({ mode, entries: 1200, tools: 600, memoryCards: 300, runs: 5, deltasPerRun: 30,
      initialReactMedianMs: median(runs.map(r => r.initial.reactMs)), initialWallMedianMs: median(runs.map(r => r.initial.wallMs)),
      deltaReactMedianMs: median(runs.flatMap(r => r.deltas.map((d: any) => d.reactMs))), deltaWallMedianMs: median(runs.flatMap(r => r.deltas.map((d: any) => d.wallMs))), raw: runs })
  }
  if (errors.length) throw new Error(`Benchmark page errors: ${errors.join("; ")}`)
  console.log(JSON.stringify({ browser: await browser.version(), results }, null, 2))
} finally {
  await browser.close()
  await vite.close()
}
