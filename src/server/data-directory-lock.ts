import { Database } from "bun:sqlite"
import { mkdirSync, realpathSync } from "node:fs"
import path from "node:path"

// Keep ownership until explicit release, even if a caller drops its runtime handle.
const heldLocks = new Set<Database>()

export function acquireDataDirectoryLock(dataDir: string) {
  mkdirSync(dataDir, { recursive: true })
  const resolvedDir = realpathSync(dataDir)
  const database = new Database(path.join(resolvedDir, ".instance-lock.sqlite"), { create: true })
  try {
    // A dedicated transaction provides crash-safe exclusion without stale-file takeover.
    database.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE")
  } catch (error) {
    database.close()
    if (error instanceof Error && "code" in error && (error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED")) {
      throw new Error(`MemoSync is already using data directory "${resolvedDir}". Stop the other instance before starting another.`, { cause: error })
    }
    throw error
  }
  heldLocks.add(database)

  let released = false
  return {
    dataDir: resolvedDir,
    release() {
      if (released) return
      database.close()
      heldLocks.delete(database)
      released = true
      // Keep the file: unlinking it could let another process lock a different inode.
    },
  }
}
