import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { acquireDataDirectoryLock } from "./data-directory-lock"
import { startMemoSyncServer } from "./server"

const directories: string[] = []
const servers: Array<{ stop: () => Promise<void> }> = []
const children: Bun.Subprocess[] = []
const locks: ReturnType<typeof acquireDataDirectoryLock>[] = []

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
