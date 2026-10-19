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
import { existsSync, readdirSync, realpathSync, renameSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import {
  getDataDir,
  getDataRootDir,
  getKeybindingsFilePath,
  getLegacyDataRootDir,
  getLlmProviderFilePath,
  LOG_PREFIX,
} from "../shared/branding"

const INSTANCE_LOCK_BASENAME = ".instance-lock.sqlite"

function isTransientInstanceLockFile(name: string): boolean {
  return name === INSTANCE_LOCK_BASENAME || name.startsWith(`${INSTANCE_LOCK_BASENAME}-`)
}

/**
 * This app's root is recognized by substantive files in its data/ subdir or
 * its root-level settings files. A lock-only data directory can be left behind
 * by a failed first start and is not proof that legacy migration already ran.
 */
function looksLikeThisAppsDataRoot(rootDir: string): boolean {
  const homeDir = path.dirname(rootDir)
  if ([getKeybindingsFilePath(homeDir), getLlmProviderFilePath(homeDir)].some(existsSync)) return true

  try {
    return readdirSync(path.join(rootDir, "data")).some((entry) => !isTransientInstanceLockFile(entry))
  } catch {
    return false
  }
}

export function hasMemoSyncDataRoot(homeDir: string = homedir()): boolean {
  return looksLikeThisAppsDataRoot(getDataRootDir(homeDir))
}

/** Canonicalize a path through its deepest existing ancestor so a missing
 * leaf still resolves symlinked parents (e.g. an aliased home directory). */
function canonicalPath(target: string): string {
  let current = path.resolve(target)
  const missing: string[] = []
  while (true) {
    try {
      return path.join(realpathSync(current), ...missing.reverse())
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(target)
      missing.push(path.basename(current))
      current = parent
    }
  }
}

/** Resolve an explicitly supplied data path against the default root. */
export function isDefaultDataDirectory(dataDir: string, homeDir: string = homedir()): boolean {
  const configured = path.resolve(dataDir)
  const defaultDir = path.resolve(getDataDir(homeDir))
  if (configured === defaultDir) return true
  return canonicalPath(configured) === canonicalPath(defaultDir)
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
export function migrateLegacyDataRoot(
  homeDir: string = homedir(),
  options: { allowInTest?: boolean } = {},
): boolean {
  // Never touch real user data from inside a test run.
  if (process.env.NODE_ENV === "test" && !options.allowInTest) return false

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

/**
 * Resolve the default root while a bootstrap lock is held. A failed migration
 * must fail startup instead of creating a fresh empty root beside user data.
 */
export function prepareDefaultDataRoot(
  homeDir: string = homedir(),
  options: { allowInTest?: boolean } = {},
): void {
  const hadLegacyRoot = existsSync(getLegacyDataRootDir(homeDir))
  const migrated = migrateLegacyDataRoot(homeDir, options)
  if (hadLegacyRoot && !migrated && !hasMemoSyncDataRoot(homeDir)) {
    throw new Error(`Unable to migrate the legacy MemoSync data root in ${homeDir}`)
  }
}
