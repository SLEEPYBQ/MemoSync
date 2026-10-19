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
import {
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { randomUUID } from "node:crypto"
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
import { acquireDataDirectoryLock } from "./data-directory-lock"

const INSTANCE_LOCK_BASENAME = ".instance-lock.sqlite"
const LEGACY_IMPORT_MARKER = ".legacy-data-import-in-progress"
const LEGACY_IMPORT_STAGE_PREFIX = ".legacy-data-import-staging-"
const LEGACY_IMPORT_TEMP_PREFIX = ".legacy-data-import-"
const LEGACY_IMPORT_MARKER_PREFIX = "memosync-legacy-data-import-v1:"
const IMPORT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isTransientInstanceLockFile(name: string): boolean {
  return name === INSTANCE_LOCK_BASENAME || name.startsWith(`${INSTANCE_LOCK_BASENAME}-`)
}

function hasSubstantiveData(dataDir: string): boolean {
  try {
    return readdirSync(dataDir).some((entry) => !isTransientInstanceLockFile(entry))
  } catch {
    return false
  }
}

function hasCurrentRootSettings(homeDir: string): boolean {
  return [getKeybindingsFilePath(homeDir), getLlmProviderFilePath(homeDir)].some(existsSync)
}

/**
 * This app's root is recognized by substantive files in its data/ subdir or
 * its root-level settings files. A lock-only data directory can be left behind
 * by a failed first start and is not proof that legacy migration already ran.
 */
function looksLikeThisAppsDataRoot(rootDir: string): boolean {
  const homeDir = path.dirname(rootDir)
  return hasCurrentRootSettings(homeDir) || hasSubstantiveData(path.join(rootDir, "data"))
}

function pathStatOrNull(target: string) {
  try {
    return lstatSync(target)
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null
    throw error
  }
}

function effectiveSymlinkTarget(linkPath: string): string {
  const target = readlinkSync(linkPath)
  let linkParent = path.dirname(linkPath)
  try {
    linkParent = realpathSync(linkParent)
  } catch {
    // Keep lexical resolution for a dangling parent; the link target itself is still preserved.
  }
  return path.normalize(path.isAbsolute(target) ? target : path.resolve(linkParent, target))
}

function comparableSymlinkTarget(linkPath: string): string {
  let target = effectiveSymlinkTarget(linkPath)
  try {
    target = realpathSync(target)
  } catch {
    // Dangling links are compared by their normalized effective path.
  }
  return process.platform === "win32" ? target.toLowerCase() : target
}

function symlinkTypeForTarget(effectiveTarget: string, linkTarget: string): "file" | "dir" | "junction" | undefined {
  if (process.platform !== "win32") return undefined
  try {
    if (statSync(effectiveTarget).isDirectory()) return path.isAbsolute(linkTarget) ? "junction" : "dir"
    return "file"
  } catch {
    // A dangling link has no reliable file-vs-directory type; preserve its target without dereferencing it.
    return undefined
  }
}

function createSymlinkForEffectiveTarget(effectiveTarget: string, destination: string): void {
  let linkParent = path.dirname(destination)
  try {
    linkParent = realpathSync(linkParent)
  } catch {
    // The merge creates destination parents before calling this for normal data links.
  }
  const relativeTarget = path.relative(linkParent, effectiveTarget)
  const linkTarget = relativeTarget || "."
  symlinkSync(linkTarget, destination, symlinkTypeForTarget(effectiveTarget, linkTarget))
}

function copySymlinkPreservingTarget(source: string, destination: string): void {
  createSymlinkForEffectiveTarget(effectiveSymlinkTarget(source), destination)
}

function copyLegacyEntryToStage(source: string, destination: string): void {
  const sourceStat = lstatSync(source)
  if (sourceStat.isSymbolicLink()) {
    copySymlinkPreservingTarget(source, destination)
    return
  }
  if (sourceStat.isDirectory()) {
    mkdirSync(destination)
    for (const entry of readdirSync(source).sort()) {
      copyLegacyEntryToStage(path.join(source, entry), path.join(destination, entry))
    }
    return
  }
  if (sourceStat.isFile()) {
    copyFileSync(source, destination)
    return
  }
  throw new Error(`Unsupported legacy data entry: ${source}`)
}

function entriesMatch(source: string, destination: string): boolean {
  const sourceStat = lstatSync(source)
  const destinationStat = lstatSync(destination)
  if (sourceStat.isSymbolicLink() || destinationStat.isSymbolicLink()) {
    return sourceStat.isSymbolicLink() && destinationStat.isSymbolicLink() && comparableSymlinkTarget(source) === comparableSymlinkTarget(destination)
  }
  if (sourceStat.isDirectory() || destinationStat.isDirectory()) return sourceStat.isDirectory() && destinationStat.isDirectory()
  if (!sourceStat.isFile() || !destinationStat.isFile()) return false
  return readFileSync(source).equals(readFileSync(destination))
}

function mergeStagedEntry(source: string, destination: string, importId: string, nextTemp: { value: number }): void {
  const sourceStat = lstatSync(source)
  const destinationStat = pathStatOrNull(destination)
  if (destinationStat) {
    if (sourceStat.isDirectory() && destinationStat.isDirectory() && !destinationStat.isSymbolicLink()) {
      for (const entry of readdirSync(source).sort()) {
        mergeStagedEntry(path.join(source, entry), path.join(destination, entry), importId, nextTemp)
      }
      return
    }
    if (entriesMatch(source, destination)) return
    throw new Error(`Refusing to overwrite conflicting data at ${destination}`)
  }

  if (sourceStat.isDirectory()) {
    mkdirSync(destination)
    for (const entry of readdirSync(source).sort()) {
      mergeStagedEntry(path.join(source, entry), path.join(destination, entry), importId, nextTemp)
    }
  } else if (sourceStat.isSymbolicLink()) {
    createSymlinkForEffectiveTarget(effectiveSymlinkTarget(source), destination)
  } else if (sourceStat.isFile()) {
    const temporaryCopy = path.join(
      path.dirname(destination),
      `${LEGACY_IMPORT_TEMP_PREFIX}${importId}-${nextTemp.value++}.tmp`,
    )
    copyFileSync(source, temporaryCopy, constants.COPYFILE_EXCL)
    try {
      // A hard link publishes a complete staged file atomically and never overwrites a race.
      linkSync(temporaryCopy, destination)
    } catch (error) {
      if (!pathStatOrNull(destination) || !entriesMatch(temporaryCopy, destination)) throw error
    } finally {
      if (pathStatOrNull(temporaryCopy)) unlinkSync(temporaryCopy)
    }
  } else {
    throw new Error(`Unsupported staged data entry: ${source}`)
  }
}

function cleanImportTemporaryFiles(dataDir: string, importId: string): void {
  for (const entry of readdirSync(dataDir)) {
    const target = path.join(dataDir, entry)
    const targetStat = lstatSync(target)
    if (entry.startsWith(`${LEGACY_IMPORT_TEMP_PREFIX}${importId}-`)) {
      if (!targetStat.isFile() && !targetStat.isSymbolicLink()) {
        throw new Error(`Unexpected legacy import temporary entry: ${target}`)
      }
      unlinkSync(target)
    } else if (targetStat.isDirectory() && !targetStat.isSymbolicLink()) {
      cleanImportTemporaryFiles(target, importId)
    }
  }
}

function importLegacyDataDirectory(currentRoot: string, currentData: string, legacyData: string): void {
  if (canonicalPath(currentData) === canonicalPath(legacyData)) return

  const currentLock = acquireDataDirectoryLock(currentData)
  let legacyLock: ReturnType<typeof acquireDataDirectoryLock> | undefined
  try {
    legacyLock = acquireDataDirectoryLock(legacyData)
    const marker = path.join(currentRoot, LEGACY_IMPORT_MARKER)
    let importId: string | undefined
    try {
      if (existsSync(marker)) {
        const markerContent = readFileSync(marker, "utf8")
        if (!markerContent.startsWith(LEGACY_IMPORT_MARKER_PREFIX)) {
          throw new Error(`Unrecognized legacy data import marker at ${marker}`)
        }
        const markerSuffix = markerContent.slice(LEGACY_IMPORT_MARKER_PREFIX.length)
        importId = markerSuffix.endsWith("\n") ? markerSuffix.slice(0, -1) : ""
        if (!IMPORT_ID_PATTERN.test(importId)) throw new Error(`Invalid legacy data import marker at ${marker}`)
      } else {
        importId = randomUUID()
        writeFileSync(marker, `${LEGACY_IMPORT_MARKER_PREFIX}${importId}\n`, { flag: "wx" })
      }

      const staging = path.join(currentRoot, `${LEGACY_IMPORT_STAGE_PREFIX}${importId}`)
      cleanImportTemporaryFiles(currentData, importId)
      rmSync(staging, { recursive: true, force: true })
      mkdirSync(staging)
      for (const entry of readdirSync(legacyData).sort()) {
        if (!isTransientInstanceLockFile(entry)) {
          copyLegacyEntryToStage(path.join(legacyData, entry), path.join(staging, entry))
        }
      }
      const nextTemp = { value: 0 }
      for (const entry of readdirSync(staging).sort()) {
        mergeStagedEntry(path.join(staging, entry), path.join(currentData, entry), importId, nextTemp)
      }
      rmSync(staging, { recursive: true, force: true })
      unlinkSync(marker)
    } catch (error) {
      if (importId) {
        try {
          cleanImportTemporaryFiles(currentData, importId)
        } catch {
          // Keep the marker so a later startup can retry without trusting partial data.
        }
      }
      throw new Error(`Unable to import legacy MemoSync data from ${legacyData} into ${currentData}`, { cause: error })
    }
  } finally {
    try {
      legacyLock?.release()
    } finally {
      currentLock.release()
    }
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
    const currentData = getDataDir(homeDir)
    const hasCurrentHistory = hasSubstantiveData(currentData)
    const importInProgress = existsSync(path.join(current, LEGACY_IMPORT_MARKER))
    if (hasCurrentHistory && !importInProgress) return false
    if (hasCurrentRootSettings(homeDir)) {
      const legacyData = path.join(legacy, "data")
      if (hasSubstantiveData(legacyData)) {
        importLegacyDataDirectory(current, currentData, legacyData)
      } else if (importInProgress) {
        throw new Error(`Unable to resume legacy MemoSync data import because ${legacyData} is unavailable`)
      }
      return false
    }
    if (importInProgress) throw new Error(`Unable to resume legacy MemoSync data import because current settings are missing from ${current}`)
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
