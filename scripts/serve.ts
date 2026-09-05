// Deterministic headless server entrypoint (used by prod deployments). Unlike
// the interactive CLI it never opens a browser or prompts. Config via env:
//   HOST (default 0.0.0.0), PORT (default 3210), DATA_DIR (optional),
//   MEMOSYNC_PASSWORD (optional: enables the login gate — set it whenever the
//   server is reachable beyond localhost, e.g. a lab-server deployment),
//   MEMOSYNC_TRUST_PROXY=1 (only behind a TLS-terminating reverse proxy).
import { startMemoSyncServer } from "../src/server/server"
import { applyDeepSeekEngineEnvDefaults } from "../src/server/deepseek-engine-env"

const port = Number(process.env.PORT) || 3210
const host = process.env.HOST || "0.0.0.0"
const dataDir = process.env.DATA_DIR || undefined
const password = process.env.MEMOSYNC_PASSWORD || null
const trustProxy = process.env.MEMOSYNC_TRUST_PROXY === "1"

// Claude Code engine → DeepSeek's Anthropic-compatible endpoint whenever a
// DeepSeek key is configured and no explicit ANTHROPIC_* override exists.
applyDeepSeekEngineEnvDefaults()

// strictPort: a published deployment port must match exactly — never let the
// server silently bump to another port.
const srv = await startMemoSyncServer({ port, host, dataDir, password, trustProxy, openBrowser: false, strictPort: true })
console.log(`[memosync] serving on http://${host}:${srv.port}`)

const shutdown = async () => {
  try {
    await srv.stop()
  } finally {
    process.exit(0)
  }
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
