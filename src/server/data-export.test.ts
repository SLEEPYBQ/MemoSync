import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const tempDirs: string[] = []
const script = path.resolve(import.meta.dir, "../../scripts/export-data.ts")

function inspectArchive(...args: string[]) {
  return Bun.spawnSync(["tar", ...args], { env: { ...process.env, TAR_OPTIONS: "" } })
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("data export", () => {
  test("does not write an archive into a directory it will recursively export", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "memosync-export-nested-"))
    tempDirs.push(root)
    const experiments = path.join(root, "experiments")
    const out = path.join(experiments, "backups")
    await mkdir(experiments)
    await writeFile(path.join(experiments, "events.jsonl"), '{"event":"synthetic"}\n')
    const run = (extra: string[]) => Bun.spawnSync([process.execPath, script, "--out", out, ...extra], {
      env: { PATH: process.env.PATH, HOME: root, TMPDIR: tmpdir(), DATA_DIR: root },
    })
    const rejected = run(["--full"])
    expect(rejected.exitCode).not.toBe(0)
    expect(rejected.stderr.toString()).toContain("outside the exported directory")
    expect(await readdir(experiments)).toEqual(["events.jsonl"])
    // Default mode only archives events.jsonl, not the whole experiments directory.
    expect(run([]).exitCode).toBe(0)
    expect(await readdir(out)).toHaveLength(1)
  })

  test("treats linked sources according to the native archiver", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "memosync-export-link-"))
    tempDirs.push(root)
    const library = path.join(root, "shared-library")
    const data = path.join(root, "data")
    await mkdir(library)
    await mkdir(data)
    await symlink(library, path.join(data, "memories"), process.platform === "win32" ? "junction" : "dir")
    for (const base of [library, path.join(data, "memories")]) {
      const result = Bun.spawnSync([process.execPath, script, "--out", path.join(base, "new", "output")], {
        env: { PATH: process.env.PATH, HOME: root, TMPDIR: tmpdir(), DATA_DIR: data, TAR_OPTIONS: "--dereference" },
      })
      if (process.platform === "win32") {
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr.toString()).toContain("outside the exported directory")
      } else {
        expect(result.exitCode).toBe(0)
      }
    }
    if (process.platform === "win32") {
      expect(await readdir(library)).toEqual([])
    } else {
      const out = path.join(library, "new", "output")
      const archives = await readdir(out)
      expect(archives).toHaveLength(2)
      for (const archive of archives) {
        const extracted = await mkdtemp(path.join(root, "extract-"))
        const result = inspectArchive("-xzf", path.join(out, archive), "-C", extracted)
        expect(result.exitCode).toBe(0)
        expect(await readdir(extracted)).toEqual(["memories"])
        expect(await readlink(path.join(extracted, "memories"))).toBe(library)
      }
    }
  })

  test("refuses an output alias into a regular exported directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "memosync-export-alias-"))
    tempDirs.push(root)
    const memories = path.join(root, "memories")
    const alias = path.join(root, "external-alias")
    await mkdir(memories)
    await symlink(memories, alias, process.platform === "win32" ? "junction" : "dir")
    const result = Bun.spawnSync([process.execPath, script, "--out", path.join(alias, "new", "backups")], {
      env: { PATH: process.env.PATH, HOME: root, TMPDIR: tmpdir(), DATA_DIR: root },
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("outside the exported directory")
    expect(await readdir(memories)).toEqual([])
  })

  test("preserves both snapshots when run twice in the same minute", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "memosync-export-collision-"))
    tempDirs.push(root)
    const dataDir = path.join(root, "data")
    const outDir = path.join(root, "out")
    await mkdir(dataDir)
    await writeFile(path.join(dataDir, "install-id"), "synthetic-install")
    const clock = path.join(root, "fixed-clock.ts")
    await writeFile(clock, 'import { setSystemTime } from "bun:test"\nsetSystemTime(new Date("2026-04-23T12:34:56Z"))\n')

    const stem = "memosync-export-synthetic-install-20260423-1234"
    const snapshots = [
      { archive: `${stem}.tar.gz`, settings: '{"revision":1}' },
      { archive: `${stem}-2.tar.gz`, settings: '{"revision":2}' },
    ]
    for (const { settings } of snapshots) {
      await writeFile(path.join(dataDir, "settings.json"), settings)
      const result = Bun.spawnSync([process.execPath, "--preload", clock, script, "--out", outDir], {
        env: { PATH: process.env.PATH, HOME: root, TMPDIR: tmpdir(), DATA_DIR: dataDir },
      })
      expect(result.exitCode).toBe(0)
    }
    for (const { archive, settings } of snapshots) {
      const contents = inspectArchive("-xzOf", path.join(outDir, archive), "settings.json")
      expect(contents.exitCode).toBe(0)
      expect(contents.stdout.toString()).toBe(settings)
    }
  })

  test.each([false, true])("exports raw historical data only with explicit --full (full=%s)", async (full) => {
    const root = await mkdtemp(path.join(tmpdir(), "memosync-export-privacy-"))
    tempDirs.push(root)
    const dataDir = path.join(root, "data")
    const outDir = path.join(root, "out")
    const entries: Record<string, string> = {
      "install-id": "synthetic-install",
      "memory.sqlite": "MEMORY_LIBRARY",
      "experiments/events.jsonl": '{"event":"memory.opened"}\n',
      // Preserve the database path written by older versions.
      "experiments/study.sqlite": "PRIVATE_USER_PROMPT",
      "experiments/workspace-snapshots/source/private.ts": "PRIVATE_WORKSPACE_CODE",
      "experiments/unrecognized-future-file.json": "PRIVATE_FUTURE_DATA",
      "transcripts/chat.jsonl": "PRIVATE_TRANSCRIPT",
    }
    for (const [name, contents] of Object.entries(entries)) {
      const target = path.join(dataDir, name)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, contents)
    }
    const result = Bun.spawnSync([process.execPath, script, "--out", outDir, ...(full ? ["--full"] : [])], {
      env: { PATH: process.env.PATH, HOME: root, TMPDIR: tmpdir(), DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(result.exitCode).toBe(0)
    const archives = await readdir(outDir)
    expect(archives).toHaveLength(1)
    const archivePath = path.join(outDir, archives[0]!)
    const listing = inspectArchive("-tzf", archivePath)
    expect(listing.exitCode).toBe(0)
    const names = listing.stdout.toString().trimEnd().split(/\r?\n/)
    expect(names).toContain("memory.sqlite")
    expect(names).toContain("experiments/events.jsonl")
    for (const name of Object.keys(entries).filter((name) => entries[name]!.startsWith("PRIVATE_"))) {
      expect(names.includes(name)).toBe(full)
    }
    const contents = inspectArchive("-xzOf", archivePath)
    expect(contents.exitCode).toBe(0)
    expect(contents.stdout.toString()).toContain("MEMORY_LIBRARY")
    expect(contents.stdout.toString().includes("PRIVATE_")).toBe(full)
  })
})
