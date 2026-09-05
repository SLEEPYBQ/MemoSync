// One-time on-disk migration from the Kanna-era data layout to MemoSync's.
// The user-level data root used to be ~/.kanna (~/.kanna-dev in dev profile);
// it is now ~/.memosync (~/.memosync-dev). A plain directory rename carries
// everything over — settings, keybindings, llm-provider config, event logs,
// memory.sqlite — because nothing inside the root stores its own absolute path.
//
// Complication: ~/.memosync may already be occupied by the ORIGINAL MemoSync
// (v1) prototype's data dir, which used a different flat layout (db.sqlite at
// the root, no data/ subdir). That dir is not this app's data. When the target
// exists but does not carry this app's layout, it is moved aside to a
// timestamped backup (never deleted) before the legacy root is renamed in.
import { existsSync, renameSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { getDataRootDir, getLegacyDataRootDir, LOG_PREFIX } from "../shared/branding"

/** This app's root is recognized by its data/ subdir (settings, event logs). */
function looksLikeThisAppsDataRoot(rootDir: string): boolean {
  return existsSync(path.join(rootDir, "data"))
}

function moveAsideAsBackup(dir: string): string | null {
  const stamp = new Date().toISOString().slice(0, 10)
  let backup = `${dir}-v1-backup-${stamp}`
  let suffix = 2
  while (existsSync(backup)) {
    backup = `${dir}-v1-backup-${stamp}-${suffix}`
    suffix += 1
  }
  try {
    renameSync(dir, backup)
    return backup
  } catch {
    return null
  }
}

/**
 * Migrate the legacy data root to the current name. Returns true when a
 * migration happened. Never deletes anything: a foreign occupant of the target
 * name is renamed to a `-v1-backup-<date>` sibling first.
 */
export function migrateLegacyDataRoot(homeDir: string = homedir()): boolean {
  // Never touch real user data from inside a test run.
  if (process.env.NODE_ENV === "test") return false

  const current = getDataRootDir(homeDir)
  const legacy = getLegacyDataRootDir(homeDir)
  if (!existsSync(legacy)) return false

  if (existsSync(current)) {
    if (looksLikeThisAppsDataRoot(current)) return false
    const backup = moveAsideAsBackup(current)
    if (!backup) {
      console.warn(`${LOG_PREFIX} data root ${current} is occupied by an unrecognized directory and could not be moved aside; leaving ${legacy} unmigrated`)
      return false
    }
    console.log(`${LOG_PREFIX} moved pre-existing ${current} (old MemoSync v1 layout) to ${backup}`)
  }

  try {
    renameSync(legacy, current)
    console.log(`${LOG_PREFIX} migrated data root ${legacy} -> ${current}`)
    return true
  } catch (error) {
    console.warn(`${LOG_PREFIX} failed to migrate data root ${legacy} -> ${current}:`, error)
    return false
  }
}
