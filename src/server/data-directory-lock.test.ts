import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { acquireDataDirectoryLock, acquireDataRootBootstrapLock } from "./data-directory-lock"
import { hasMemoSyncDataRoot, isDefaultDataDirectory, prepareDefaultDataRoot } from "./migrate-data-root"
import { cleanupFailedMemoSyncStartup, startMemoSyncServer } from "./server"

const directories: string[] = []
const servers: Array<{ stop: () => Promise<void> }> = []
const children: Bun.Subprocess[] = []
const locks: Array<{ release: () => void }> = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const child of children.splice(0)) {
    child.kill("SIGKILL")
    await child.exited
  }
  for (const lock of locks.splice(0)) lock.release()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function directory() {
  const dir = await mkdtemp(path.join(tmpdir(), "memosync-instance-"))
  directories.push(dir)
  return dir
}

async function start(dataDir: string) {
  const server = await startMemoSyncServer({ dataDir, port: 0, discoverProjects: () => [] })
  servers.push(server)
  return server
}

function createHistoryDatabase(filePath: string, value: string) {
  const database = new Database(filePath, { create: true })
  database.exec("CREATE TABLE history (value TEXT NOT NULL)")
  database.query("INSERT INTO history (value) VALUES (?)").run(value)
  database.close()
}

function readHistoryDatabase(filePath: string) {
  const database = new Database(filePath, { readonly: true })
  try {
    return (database.query("SELECT value FROM history").get() as { value: string }).value
  } finally {
    database.close()
  }
}

function createLockDatabase(filePath: string, withLegacyMarker = false) {
  const database = new Database(filePath, { create: true })
  if (withLegacyMarker) database.exec("CREATE TABLE legacy_lock_marker (value TEXT)")
  database.close()
}

test("rejects a second server before loading a live data directory and releases after stop", async () => {
  const dataDir = await directory()
  const first = await start(dataDir)
  let discoveryCalled = false
  const duplicate = startMemoSyncServer({
    dataDir, port: 0,
    discoverProjects: () => {
      discoveryCalled = true
      return []
    },
  }).then((server) => {
    servers.push(server)
    return server
  })
  await expect(duplicate).rejects.toThrow("already using data directory")
  expect(discoveryCalled).toBe(false)

  const parent = await directory()
  const alias = path.join(parent, "alias")
  await symlink(dataDir, alias, "junction")
  await expect(start(alias)).rejects.toThrow("already using data directory")

  const different = await start(await directory())
  expect(different.port).not.toBe(first.port)
  await Promise.all([first.stop(), first.stop()])
  const restarted = await start(dataDir)
  expect((await fetch(`http://127.0.0.1:${restarted.port}/health`)).ok).toBe(true)
})

test("holds the data directory during asynchronous startup", async () => {
  const dataDir = await directory()
  const first = start(dataDir)
  try {
    await expect(start(dataDir)).rejects.toThrow("already using data directory")
  } finally {
    await first
  }
})

test("cleans up failed startup before allowing another server", async () => {
  const dataDir = await directory()
  await expect(startMemoSyncServer({
    dataDir, port: 0,
    discoverProjects: () => { throw new Error("discovery failed") },
  })).rejects.toThrow("discovery failed")

  const occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("occupied") })
  try {
    await expect(startMemoSyncServer({
      dataDir, port: occupied.port, strictPort: true, discoverProjects: () => [],
    })).rejects.toThrow()
  } finally {
    await occupied.stop(true)
  }

  const restarted = await start(dataDir)
  expect((await fetch(`http://127.0.0.1:${restarted.port}/health`)).ok).toBe(true)
})

test("excludes another process and recovers immediately after a crash without removing the lock file", async () => {
  const dataDir = await directory()
  const child = Bun.spawn({
    cmd: [process.execPath, "--eval", `
      import { acquireDataDirectoryLock } from ${JSON.stringify(new URL("./data-directory-lock.ts", import.meta.url).href)};
      const lock = acquireDataDirectoryLock(${JSON.stringify(dataDir)});
      console.log("locked");
      for await (const chunk of Bun.stdin.stream()) break;
      lock.release();
    `],
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  children.push(child)
  const reader = child.stdout.getReader()
  let output = ""
  try {
    while (!output.includes("\n")) {
      const chunk = await reader.read()
      if (chunk.done) break
      output += new TextDecoder().decode(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  expect(output.trim()).toBe("locked")
  expect(() => acquireDataDirectoryLock(dataDir)).toThrow("already using data directory")
  child.kill("SIGKILL")
  await child.exited
  expect(await Bun.file(path.join(dataDir, ".instance-lock.sqlite")).exists()).toBe(true)
  const recovered = acquireDataDirectoryLock(dataDir)
  locks.push(recovered)
  recovered.release()
  recovered.release()
  locks.push(acquireDataDirectoryLock(dataDir))
})

test("releases the instance lock even when shutdown fails", async () => {
  const dataDir = await directory()
  const server = await startMemoSyncServer({ dataDir, port: 0, discoverProjects: () => [] })
  const mutableStore = server.store as unknown as { compact: () => Promise<void> }
  mutableStore.compact = async () => { throw new Error("compact failed") }

  await expect(server.stop()).rejects.toThrow("compact failed")
  const recovered = acquireDataDirectoryLock(dataDir)
  recovered.release()
})

test("releases the instance lock even when startup cleanup fails", async () => {
  let released = false
  const failure = await cleanupFailedMemoSyncStartup({
    error: new Error("startup failed"),
    cleanups: [async () => { throw new Error("cleanup failed") }],
    releaseLock: () => { released = true },
  })
  expect(failure).toBeInstanceOf(AggregateError)
  expect((failure as AggregateError).message).toBe("MemoSync startup and cleanup failed")
  expect(released).toBe(true)
})

test("serializes default-root migration with a lock outside the renamed directory", async () => {
  const homeDir = await directory()
  const first = acquireDataRootBootstrapLock(homeDir, 25)
  locks.push(first)
  expect(() => acquireDataRootBootstrapLock(homeDir, 25)).toThrow("preparing its default data directory")
  first.release()

  const second = acquireDataRootBootstrapLock(homeDir, 25)
  locks.push(second)
  second.release()
})

test("migrates legacy data when the current root only contains a transient lock", async () => {
  const homeDir = await directory()
  const legacyData = path.join(homeDir, ".kanna", "data")
  const lockOnlyData = path.join(homeDir, ".memosync", "data")
  await mkdir(legacyData, { recursive: true })
  await mkdir(lockOnlyData, { recursive: true })
  await writeFile(path.join(legacyData, "memory.sqlite"), "legacy user data")
  await writeFile(path.join(lockOnlyData, ".instance-lock.sqlite"), "stale first-start lock")

  prepareDefaultDataRoot(homeDir, { allowInTest: true })

  expect(existsSync(path.join(homeDir, ".kanna"))).toBe(false)
  expect(existsSync(path.join(homeDir, ".memosync", "data", "memory.sqlite"))).toBe(true)
  const backupName = (await readdir(homeDir)).find((entry) => entry.startsWith(".memosync-v1-backup-"))
  expect(backupName).toBeTruthy()
  expect(existsSync(path.join(homeDir, backupName!, "data", ".instance-lock.sqlite"))).toBe(true)
})

test("preserves a current root with keybindings and an empty data directory", async () => {
  const homeDir = await directory()
  const currentRoot = path.join(homeDir, ".memosync")
  const legacyData = path.join(homeDir, ".kanna", "data")
  await mkdir(path.join(currentRoot, "data"), { recursive: true })
  await writeFile(path.join(currentRoot, "keybindings.json"), '{"toggleRightSidebar":["ctrl+b"]}\n')
  await mkdir(legacyData, { recursive: true })
  createHistoryDatabase(path.join(legacyData, "memory.sqlite"), "legacy history")

  prepareDefaultDataRoot(homeDir, { allowInTest: true })

  expect(existsSync(path.join(currentRoot, "keybindings.json"))).toBe(true)
  expect(await Bun.file(path.join(currentRoot, "keybindings.json")).text()).toBe('{"toggleRightSidebar":["ctrl+b"]}\n')
  expect(existsSync(path.join(currentRoot, "data"))).toBe(true)
  const activeHistory = path.join(currentRoot, "data", "memory.sqlite")
  expect(existsSync(activeHistory)).toBe(true)
  expect(readHistoryDatabase(activeHistory)).toBe("legacy history")
  expect(readHistoryDatabase(path.join(homeDir, ".kanna", "data", "memory.sqlite"))).toBe("legacy history")
  expect((await readdir(homeDir)).some((entry) => entry.startsWith(".memosync-v1-backup-"))).toBe(false)
})

test("preserves a current root with provider settings and a lock-only data directory", async () => {
  const homeDir = await directory()
  const currentRoot = path.join(homeDir, ".memosync")
  const legacyData = path.join(homeDir, ".kanna", "data")
  const currentData = path.join(currentRoot, "data")
  const currentLock = path.join(currentData, ".instance-lock.sqlite")
  await mkdir(currentData, { recursive: true })
  createLockDatabase(currentLock)
  await writeFile(path.join(currentRoot, "llm-provider.json"), '{"provider":"custom"}\n')
  await mkdir(legacyData, { recursive: true })
  createHistoryDatabase(path.join(legacyData, "memory.sqlite"), "legacy history")
  createLockDatabase(path.join(legacyData, ".instance-lock.sqlite"), true)

  prepareDefaultDataRoot(homeDir, { allowInTest: true })

  expect(existsSync(path.join(currentRoot, "llm-provider.json"))).toBe(true)
  expect(await Bun.file(path.join(currentRoot, "llm-provider.json")).text()).toBe('{"provider":"custom"}\n')
  const activeHistory = path.join(currentData, "memory.sqlite")
  expect(existsSync(activeHistory)).toBe(true)
  expect(readHistoryDatabase(activeHistory)).toBe("legacy history")
  expect(readHistoryDatabase(path.join(legacyData, "memory.sqlite"))).toBe("legacy history")
  const legacyLockDb = new Database(path.join(legacyData, ".instance-lock.sqlite"), { readonly: true })
  try {
    expect(legacyLockDb.query("SELECT name FROM sqlite_master WHERE name = 'legacy_lock_marker'").get()).not.toBeNull()
  } finally {
    legacyLockDb.close()
  }
  const currentLockDb = new Database(currentLock, { readonly: true })
  try {
    expect(currentLockDb.query("SELECT name FROM sqlite_master WHERE name = 'legacy_lock_marker'").get()).toBeNull()
  } finally {
    currentLockDb.close()
  }
  const recoveredLock = acquireDataDirectoryLock(currentData)
  recoveredLock.release()
  expect(existsSync(path.join(currentRoot, ".legacy-data-import-in-progress"))).toBe(false)
  expect((await readdir(homeDir)).some((entry) => entry.startsWith(".memosync-v1-backup-"))).toBe(false)
})

test("preserves root-level current settings when the data directory is missing", async () => {
  const homeDir = await directory()
  const providerSettings = path.join(homeDir, ".memosync", "llm-provider.json")
  const legacyData = path.join(homeDir, ".kanna", "data")
  const currentData = path.join(homeDir, ".memosync", "data")
  await mkdir(path.dirname(providerSettings), { recursive: true })
  await writeFile(providerSettings, '{"provider":"custom"}\n')
  await mkdir(legacyData, { recursive: true })
  createHistoryDatabase(path.join(legacyData, "memory.sqlite"), "legacy history")

  prepareDefaultDataRoot(homeDir, { allowInTest: true })

  expect(existsSync(providerSettings)).toBe(true)
  expect(await Bun.file(providerSettings).text()).toBe('{"provider":"custom"}\n')
  const activeHistory = path.join(currentData, "memory.sqlite")
  expect(existsSync(activeHistory)).toBe(true)
  expect(readHistoryDatabase(activeHistory)).toBe("legacy history")
  expect(readHistoryDatabase(path.join(legacyData, "memory.sqlite"))).toBe("legacy history")
  expect((await readdir(homeDir)).some((entry) => entry.startsWith(".memosync-v1-backup-"))).toBe(false)
  expect(hasMemoSyncDataRoot(homeDir)).toBe(true)
})

test("preserves the effective target of a relative legacy data symlink", async () => {
  const homeDir = await directory()
  const currentRoot = path.join(homeDir, ".memosync")
  const currentData = path.join(currentRoot, "data")
  const legacyRoot = path.join(homeDir, ".kanna")
  const legacyData = path.join(legacyRoot, "data")
  const legacySibling = path.join(legacyRoot, "shared-memories")
  await mkdir(currentRoot, { recursive: true })
  await writeFile(path.join(currentRoot, "keybindings.json"), '{"toggleRightSidebar":["ctrl+b"]}\n')
  await mkdir(legacySibling, { recursive: true })
  await writeFile(path.join(legacySibling, "history.jsonl"), "legacy history\n")
  await mkdir(legacyData, { recursive: true })
  await symlink("../shared-memories", path.join(legacyData, "memories"))

  prepareDefaultDataRoot(homeDir, { allowInTest: true })

  const importedLink = path.join(currentData, "memories")
  expect(lstatSync(importedLink).isSymbolicLink()).toBe(true)
  expect(realpathSync(importedLink)).toBe(realpathSync(legacySibling))
  expect(readlinkSync(importedLink)).not.toBe("../shared-memories")
  expect(await Bun.file(path.join(importedLink, "history.jsonl")).text()).toBe("legacy history\n")
  expect(readlinkSync(path.join(legacyData, "memories"))).toBe("../shared-memories")
})

test("rejects malformed legacy import marker IDs without touching sibling paths", async () => {
  const malformedIds = ["..", "../sibling", "..\\sibling", "..\n/sibling"]
  for (const malformedId of malformedIds) {
    const homeDir = await directory()
    const currentRoot = path.join(homeDir, ".memosync")
    const legacyData = path.join(homeDir, ".kanna", "data")
    const sibling = path.join(homeDir, "sibling")
    await mkdir(currentRoot, { recursive: true })
    await writeFile(path.join(currentRoot, "keybindings.json"), '{"toggleRightSidebar":["ctrl+b"]}\n')
    await mkdir(legacyData, { recursive: true })
    createHistoryDatabase(path.join(legacyData, "memory.sqlite"), "legacy history")
    await mkdir(sibling, { recursive: true })
    await writeFile(path.join(sibling, "keep.txt"), "keep me\n")
    await writeFile(
      path.join(currentRoot, ".legacy-data-import-in-progress"),
      `memosync-legacy-data-import-v1:${malformedId}\n`,
    )

    expect(() => prepareDefaultDataRoot(homeDir, { allowInTest: true })).toThrow("Unable to import legacy MemoSync data")
    expect(await Bun.file(path.join(sibling, "keep.txt")).text()).toBe("keep me\n")
    expect(existsSync(path.join(currentRoot, ".legacy-data-import-in-progress"))).toBe(true)
  }
})

test("prefers existing current history and leaves legacy history intact", async () => {
  const homeDir = await directory()
  const currentData = path.join(homeDir, ".memosync", "data")
  const legacyData = path.join(homeDir, ".kanna", "data")
  await mkdir(currentData, { recursive: true })
  await mkdir(legacyData, { recursive: true })
  await writeFile(path.join(homeDir, ".memosync", "keybindings.json"), '{"toggleRightSidebar":["ctrl+b"]}\n')
  createHistoryDatabase(path.join(currentData, "memory.sqlite"), "current history")
  createHistoryDatabase(path.join(legacyData, "memory.sqlite"), "legacy history")

  prepareDefaultDataRoot(homeDir, { allowInTest: true })

  expect(readHistoryDatabase(path.join(currentData, "memory.sqlite"))).toBe("current history")
  expect(readHistoryDatabase(path.join(legacyData, "memory.sqlite"))).toBe("legacy history")
})

test("does not import legacy history while the current data directory is locked", async () => {
  const homeDir = await directory()
  const currentRoot = path.join(homeDir, ".memosync")
  const currentData = path.join(currentRoot, "data")
  const legacyData = path.join(homeDir, ".kanna", "data")
  await mkdir(currentData, { recursive: true })
  await writeFile(path.join(currentRoot, "keybindings.json"), '{"toggleRightSidebar":["ctrl+b"]}\n')
  await mkdir(legacyData, { recursive: true })
  createHistoryDatabase(path.join(legacyData, "memory.sqlite"), "legacy history")
  const activeLock = acquireDataDirectoryLock(currentData)
  locks.push(activeLock)

  expect(() => prepareDefaultDataRoot(homeDir, { allowInTest: true })).toThrow("already using data directory")
  expect(existsSync(path.join(currentData, "memory.sqlite"))).toBe(false)
  expect(readHistoryDatabase(path.join(legacyData, "memory.sqlite"))).toBe("legacy history")
  expect(await Bun.file(path.join(currentRoot, "keybindings.json")).text()).toBe('{"toggleRightSidebar":["ctrl+b"]}\n')
})

if (process.platform !== "win32") {
  test("fails closed and retries a staged legacy import after a copy error", async () => {
    const homeDir = await directory()
    const currentRoot = path.join(homeDir, ".memosync")
    const currentData = path.join(currentRoot, "data")
    const legacyData = path.join(homeDir, ".kanna", "data")
    const blockedHistory = path.join(legacyData, "z-blocked-history.sqlite")
    await mkdir(currentData, { recursive: true })
    await mkdir(legacyData, { recursive: true })
    await writeFile(path.join(currentRoot, "keybindings.json"), '{"toggleRightSidebar":["ctrl+b"]}\n')
    createHistoryDatabase(path.join(legacyData, "a-history.sqlite"), "first history")
    createHistoryDatabase(blockedHistory, "blocked history")
    await chmod(blockedHistory, 0)

    expect(() => prepareDefaultDataRoot(homeDir, { allowInTest: true })).toThrow("Unable to import legacy MemoSync data")
    expect(existsSync(path.join(currentData, "a-history.sqlite"))).toBe(false)
    expect(existsSync(path.join(currentRoot, ".legacy-data-import-in-progress"))).toBe(true)
    expect(await Bun.file(path.join(currentRoot, "keybindings.json")).text()).toBe('{"toggleRightSidebar":["ctrl+b"]}\n')

    await chmod(blockedHistory, 0o600)
    createHistoryDatabase(path.join(currentData, "a-history.sqlite"), "first history")
    prepareDefaultDataRoot(homeDir, { allowInTest: true })

    expect(readHistoryDatabase(path.join(currentData, "a-history.sqlite"))).toBe("first history")
    expect(readHistoryDatabase(path.join(currentData, "z-blocked-history.sqlite"))).toBe("blocked history")
    expect(existsSync(path.join(currentRoot, ".legacy-data-import-in-progress"))).toBe(false)
  })
}

test("coordinates an explicit path or symlink to the default data directory", async () => {
  const homeDir = await directory()
  const defaultData = path.join(homeDir, ".memosync", "data")
  await mkdir(defaultData, { recursive: true })
  const alias = path.join(homeDir, "linked-default-data")
  await symlink(defaultData, alias, "junction")

  expect(isDefaultDataDirectory(defaultData, homeDir)).toBe(true)
  expect(isDefaultDataDirectory(alias, homeDir)).toBe(true)
  expect(isDefaultDataDirectory(path.join(homeDir, "other-data"), homeDir)).toBe(false)
})

test("resolves an explicit path through a symlinked home when the default directory is missing", async () => {
  const base = await directory()
  const realHome = path.join(base, "real-home")
  const aliasHome = path.join(base, "alias-home")
  await mkdir(realHome, { recursive: true })
  await symlink(realHome, aliasHome, "dir")

  expect(isDefaultDataDirectory(path.join(aliasHome, ".memosync", "data"), realHome)).toBe(true)
  expect(isDefaultDataDirectory(path.join(aliasHome, "other", "data"), realHome)).toBe(false)
})
