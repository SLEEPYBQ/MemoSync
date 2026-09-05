// Stable anonymous identity for one local deployment. Longitudinal analysis
// aggregates events.jsonl files collected from many machines; stamping every
// event with a persisted per-install id keeps those streams separable without
// accounts or manual labeling. PARTICIPANT_ID (study orchestration) wins when
// present.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const INSTALL_ID_FILE = "install-id"

export function resolveInstallId(dataDir: string): string {
  const filePath = join(dataDir, INSTALL_ID_FILE)
  try {
    const existing = readFileSync(filePath, "utf8").trim()
    if (/^[A-Za-z0-9-]{8,64}$/.test(existing)) return existing
  } catch {
    /* first boot */
  }
  const id = `local-${crypto.randomUUID()}`
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, `${id}\n`)
  } catch {
    /* read-only data dir: fall back to a per-process id */
  }
  return id
}
