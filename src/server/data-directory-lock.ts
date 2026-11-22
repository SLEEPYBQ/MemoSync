import { Database } from "bun:sqlite"
import { mkdirSync, realpathSync } from "node:fs"
import path from "node:path"
import { getDataRootName } from "../shared/branding"

// Keep ownership until explicit release, even if a caller drops its runtime handle.
const heldLocks = new Set<Database>()

function acquireFileLock(lockFile: string, options: { busyTimeoutMs: number; busyMessage: string }) {
  mkdirSync(path.dirname(lockFile), { recursive: true })
  const database = new Database(lockFile, { create: true })
  try {
    // A dedicated transaction provides crash-safe exclusion without stale-file takeover.
    database.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs}; BEGIN IMMEDIATE`)
  } catch (error) {
    database.close()
    if (error instanceof Error && "code" in error && (error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED")) {
      throw new Error(options.busyMessage, { cause: error })
    }
    throw error
  }
  heldLocks.add(database)

  let released = false
  return {
    release() {
      if (released) return
      database.close()
      heldLocks.delete(database)
      released = true
      // Keep the file: unlinking it could let another process lock a different inode.
    },
  }
}

/**
 * Serialize legacy-root migration and first data-dir creation. The lock lives
 * beside (never inside) the root that migration may rename.
 */
export function acquireDataRootBootstrapLock(homeDir: string, busyTimeoutMs = 30_000) {
  const lockFile = path.join(homeDir, `${getDataRootName()}-bootstrap.lock.sqlite`)
  return acquireFileLock(lockFile, {
    busyTimeoutMs,
    busyMessage: "MemoSync is preparing its default data directory in another instance. Please try again.",
  })
}

export function acquireDataDirectoryLock(dataDir: string) {
  mkdirSync(dataDir, { recursive: true })
  const resolvedDir = realpathSync(dataDir)
  const lock = acquireFileLock(path.join(resolvedDir, ".instance-lock.sqlite"), {
    busyTimeoutMs: 0,
    busyMessage: `MemoSync is already using data directory "${resolvedDir}". Stop the other instance before starting another.`,
  })
  return { dataDir: resolvedDir, release: lock.release }
}

/** Serialize reads and updates to one provider file even across data directories. */
export async function acquireLlmProviderFileLock(filePath: string) {
  const busyMessage = "Another MemoSync instance is updating the LLM provider configuration. Please try again."
  for (let attempt = 0; ; attempt++) {
    try {
      return acquireFileLock(`${filePath}.lock.sqlite`, { busyTimeoutMs: 0, busyMessage })
    } catch (error) {
      if (attempt === 100 || !(error instanceof Error) || error.message !== busyMessage) throw error
      await Bun.sleep(50)
    }
  }
}
