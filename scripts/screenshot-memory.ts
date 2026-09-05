// Visual QA for the Memory Board: boot the real server on a temp data dir,
// seed a few memories (+candidates), and screenshot /memory in light & dark via
// Playwright. Usage: `bun run scripts/screenshot-memory.ts [outDir]`
// Requires: `bun add -d playwright && bunx playwright install chromium`.
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium } from "playwright"
import { startMemoSyncServer } from "../src/server/server"

const outDir = process.argv[2] || join(process.cwd(), "tmp")
mkdirSync(outDir, { recursive: true })

const dataDir = mkdtempSync(join(tmpdir(), "memv2-ui-"))
const srv = await startMemoSyncServer({ port: 3921, dataDir, openBrowser: false, discoverProjects: () => [] })
const base = `http://127.0.0.1:${srv.port}`

const post = (body: unknown) =>
  fetch(`${base}/api/memories`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

await post({ content: "Use fnm instead of nvm for Node version management", scope: "personal", type: "preference" })
await post({ content: "Prefer early returns over deeply nested conditionals", scope: "personal", type: "preference" })
await post({ content: "Only run MainTests (~19s) before pushing", scope: "project", type: "constraint", projectId: "default", topic: "Testing" })
await post({ content: "L20 GPU has 48G VRAM", scope: "project", type: "fact", projectId: "default", topic: "Environment" })
await post({ content: "Use .env.local for secrets, never commit .env", scope: "project", type: "constraint", projectId: "default", topic: "Environment" })
await post({ content: "The flaky login test needs --runInBand to pass", scope: "project", type: "lesson", status: "candidate", projectId: "default" })
await post({ content: "User prefers pnpm over npm for this repo", scope: "project", type: "preference", status: "candidate", projectId: "default" })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1360, height: 940 } })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(String(e)))
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })

await page.goto(`${base}/memory`, { waitUntil: "networkidle", timeout: 30000 })
await page.waitForTimeout(1200)
await page.screenshot({ path: join(outDir, "memory-board-light.png"), fullPage: true })
await page.evaluate(() => document.documentElement.classList.add("dark"))
await page.waitForTimeout(400)
await page.screenshot({ path: join(outDir, "memory-board-dark.png"), fullPage: true })

await browser.close()
await srv.stop()
console.log(`screenshots -> ${outDir} ; console errors: ${JSON.stringify(errors.slice(0, 8))}`)
process.exit(0)
