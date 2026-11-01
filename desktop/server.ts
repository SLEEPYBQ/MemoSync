import { createInterface } from "node:readline"
import { startMemoSyncServer } from "../src/server/server"

const input = createInterface({ input: process.stdin })
let starting = false
let stopping = false
let runtime: Awaited<ReturnType<typeof startMemoSyncServer>> | undefined
let shutdownTimer: ReturnType<typeof setTimeout> | undefined

async function shutdown(exitCode = 0) {
  if (stopping) return
  stopping = true
  shutdownTimer = setTimeout(() => process.exit(1), 15_000)
  if (starting && !runtime) return
  try {
    await runtime?.stop()
    process.exit(exitCode)
  } catch (error) {
    console.error("[desktop] Shutdown failed", error)
    process.exit(1)
  }
}

input.on("close", () => { void shutdown() })
process.on("SIGTERM", () => { void shutdown() })
process.on("SIGINT", () => { void shutdown() })
input.on("line", (line) => {
  void (async () => {
    const message = JSON.parse(line) as { type?: string; password?: string; dataDir?: string }
    if (message.type === "stop") return shutdown()
    if (starting || stopping || runtime || message.type !== "start" || !message.password || message.password.length < 32) {
      throw new Error("Invalid desktop startup message")
    }
    starting = true
    runtime = await startMemoSyncServer({
      host: "127.0.0.1",
      port: 0,
      strictPort: true,
      openBrowser: false,
      password: message.password,
      dataDir: message.dataDir,
      allowedOrigins: [],
      previewOrigin: "",
      appOrigin: "",
      allowSignOut: false,
    })
    if (stopping) {
      if (shutdownTimer) clearTimeout(shutdownTimer)
      stopping = false
      return shutdown()
    }
    starting = false
    console.log(`MEMOSYNC_DESKTOP_READY:${JSON.stringify({ port: runtime.port })}`)
  })().catch(async (error) => {
    starting = false
    console.error("[desktop] Startup failed", error)
    if (shutdownTimer) clearTimeout(shutdownTimer)
    stopping = false
    await shutdown(1)
  })
})
