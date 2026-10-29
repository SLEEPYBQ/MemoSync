import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

/** Best-effort local JSONL output. Logging must never prevent a product action. */
export class LocalUsageLog {
  private readonly enabled: boolean
  private readonly filePath: string | null
  private readonly stdout: boolean

  constructor(options: { filePath?: string | null; stdout?: boolean; enabled?: boolean } = {}) {
    this.enabled = options.enabled ?? (process.env.MEMOSYNC_USAGE_LOG ?? process.env.EXPERIMENT_LOG) !== "0"
    this.filePath = options.filePath ?? null
    this.stdout = options.stdout ?? true
    if (this.enabled && this.filePath) {
      try { mkdirSync(dirname(this.filePath), { recursive: true }) } catch { /* best-effort */ }
    }
  }

  write(record: Record<string, unknown>): void {
    if (!this.enabled) return
    const line = JSON.stringify(record)
    if (this.stdout) console.log(`[usage] ${line}`)
    if (this.filePath) {
      try { appendFileSync(this.filePath, line + "\n") } catch { /* best-effort */ }
    }
  }
}
