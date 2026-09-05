import { afterEach, describe, expect, test } from "bun:test"
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ensureStaticMemoryScaffold,
  STATIC_MEMORY_SCAFFOLD_MARKER,
} from "../memory/static-files"
import {
  copyStaticProjectRepresentation,
  STATIC_PROJECT_COPY_PREPARING_MARKER,
} from "./static-project-copy"

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memosync-static-project-copy-"))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("copyStaticProjectRepresentation", () => {
  test("copies the exact canonical Markdown bytes and returns deterministic source and target manifests", async () => {
    const root = await tempRoot()
    const source = join(root, "snapshot", "workspace")
    const destination = join(root, "second-project")
    const memory = join(source, "memory")
    await mkdir(memory, { recursive: true })
    await mkdir(destination, { recursive: true })

    const rootBytes = Buffer.from("\ufeff# Memory\r\n\r\n- Preserve CRLF and trailing spaces.  \r\n", "utf8")
    const alphaBytes = Buffer.from("# Alpha\n\n- café means the original bytes stay intact.\n", "utf8")
    const zetaBytes = Buffer.from([0x23, 0x20, 0x5a, 0x65, 0x74, 0x61, 0x0a, 0xff, 0x0a])
    await writeFile(join(source, "MEMORY.md"), rootBytes)
    await writeFile(join(memory, "zeta.md"), zetaBytes)
    await writeFile(join(memory, "alpha.md"), alphaBytes)
    await writeFile(join(source, STATIC_MEMORY_SCAFFOLD_MARKER), "source-only scaffold timestamp\n")
    await writeFile(join(destination, "app.ts"), "export const untouched = true\n")

    const result = await copyStaticProjectRepresentation({
      sourceSnapshotWorkspaceDir: source,
      destinationWorkspaceDir: destination,
    })

    expect(result.outcome).toBe("copied")
    expect(await readFile(join(destination, "MEMORY.md"))).toEqual(rootBytes)
    expect(await readFile(join(destination, "memory", "alpha.md"))).toEqual(alphaBytes)
    expect(await readFile(join(destination, "memory", "zeta.md"))).toEqual(zetaBytes)
    expect(await readFile(join(destination, "app.ts"), "utf8")).toBe("export const untouched = true\n")
    expect(result.source).toEqual(result.target)
    const representationHash = result.source.representationHash
    expect(result.source).toMatchObject({
      schemaVersion: 1,
      kind: "static_markdown_files",
      files: [
        { relPath: "MEMORY.md", byteLength: rootBytes.byteLength, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        { relPath: "memory/alpha.md", byteLength: alphaBytes.byteLength, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        { relPath: "memory/zeta.md", byteLength: zetaBytes.byteLength, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      ],
      totalBytes: rootBytes.byteLength + alphaBytes.byteLength + zetaBytes.byteLength,
      representationHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(result.source.files.some((file) => file.relPath === STATIC_MEMORY_SCAFFOLD_MARKER)).toBe(false)
    const marker = await readFile(join(destination, STATIC_MEMORY_SCAFFOLD_MARKER))
    expect(marker.toString("utf8")).toBe(
      `static baseline project copy\nrepresentation-sha256 ${representationHash}\n`,
    )
    expect(marker.toString("utf8")).not.toBe("source-only scaffold timestamp\n")
  })

  test("refuses to overwrite an initialized destination even when its Markdown representation is empty", async () => {
    const root = await tempRoot()
    const source = join(root, "snapshot", "workspace")
    const destination = join(root, "second-project")
    await mkdir(source, { recursive: true })
    await mkdir(destination, { recursive: true })
    await writeFile(join(source, "MEMORY.md"), "# Memory\n- Carry this exact note.\n")
    await writeFile(join(destination, STATIC_MEMORY_SCAFFOLD_MARKER), "existing empty Static representation\n")

    await expect(copyStaticProjectRepresentation({
      sourceSnapshotWorkspaceDir: source,
      destinationWorkspaceDir: destination,
    })).rejects.toThrow(/different representation/i)

    await expect(readFile(join(destination, "MEMORY.md"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(join(destination, STATIC_MEMORY_SCAFFOLD_MARKER), "utf8"))
      .toBe("existing empty Static representation\n")
  })

  test("makes an identical retry a no-op and never restores a later destination edit", async () => {
    const root = await tempRoot()
    const source = join(root, "snapshot", "workspace")
    const destination = join(root, "second-project")
    await mkdir(source, { recursive: true })
    await writeFile(join(source, "MEMORY.md"), "# Memory\n- Original copied note.\n")

    const first = await copyStaticProjectRepresentation({
      sourceSnapshotWorkspaceDir: source,
      destinationWorkspaceDir: destination,
    })
    const beforeRetry = await lstat(join(destination, "MEMORY.md"))
    const retry = await copyStaticProjectRepresentation({
      sourceSnapshotWorkspaceDir: source,
      destinationWorkspaceDir: destination,
    })
    const afterRetry = await lstat(join(destination, "MEMORY.md"))

    expect(first.outcome).toBe("copied")
    expect(retry.outcome).toBe("already_present")
    expect(retry.source).toEqual(first.source)
    expect(retry.target).toEqual(first.target)
    expect(afterRetry.ino).toBe(beforeRetry.ino)
    expect(afterRetry.mtimeMs).toBe(beforeRetry.mtimeMs)

    await writeFile(join(destination, "MEMORY.md"), "# Memory\n- Participant changed only the new project copy.\n")
    await expect(copyStaticProjectRepresentation({
      sourceSnapshotWorkspaceDir: source,
      destinationWorkspaceDir: destination,
    })).rejects.toThrow(/different representation/i)
    expect(await readFile(join(destination, "MEMORY.md"), "utf8"))
      .toBe("# Memory\n- Participant changed only the new project copy.\n")
    expect(await readFile(join(source, "MEMORY.md"), "utf8"))
      .toBe("# Memory\n- Original copied note.\n")
  })

  test("copies every direct Markdown file without the injection reader's file-count or truncation limits", async () => {
    const root = await tempRoot()
    const source = join(root, "snapshot", "workspace")
    const destination = join(root, "second-project")
    await mkdir(join(source, "memory"), { recursive: true })
    const oversized = Buffer.from(`# Memory\n${"x".repeat(30_000)}\n`, "utf8")
    await writeFile(join(source, "MEMORY.md"), oversized)
    for (let index = 0; index < 21; index += 1) {
      await writeFile(
        join(source, "memory", `topic-${String(index).padStart(2, "0")}.md`),
        `# Topic ${index}\n- exact-${index}\n`,
      )
    }

    const result = await copyStaticProjectRepresentation({
      sourceSnapshotWorkspaceDir: source,
      destinationWorkspaceDir: destination,
    })

    expect(result.source.files).toHaveLength(22)
    expect(result.source.files.at(-1)?.relPath).toBe("memory/topic-20.md")
    expect(await readFile(join(destination, "MEMORY.md"))).toEqual(oversized)
    expect(await readFile(join(destination, "memory", "topic-20.md"), "utf8"))
      .toBe("# Topic 20\n- exact-20\n")
  })

  test("publishes an empty representation without letting the next injection regenerate MEMORY.md", async () => {
    const root = await tempRoot()
    const source = join(root, "snapshot", "workspace")
    const destination = join(root, "second-project")
    await mkdir(source, { recursive: true })

    const result = await copyStaticProjectRepresentation({
      sourceSnapshotWorkspaceDir: source,
      destinationWorkspaceDir: destination,
    })

    expect(result.outcome).toBe("copied")
    expect(result.source.files).toEqual([])
    expect(result.source).toEqual(result.target)
    expect(ensureStaticMemoryScaffold(destination)).toBe(false)
    await expect(readFile(join(destination, "MEMORY.md"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("resumes an exact partial representation after a mid-copy crash", async () => {
    const root = await tempRoot()
    const source = join(root, "snapshot", "workspace")
    const destination = join(root, "second-project")
    await mkdir(join(source, "memory"), { recursive: true })
    await mkdir(destination, { recursive: true })
    await writeFile(join(source, "MEMORY.md"), "# Memory\n- Root note.\n")
    await writeFile(join(source, "memory", "alpha.md"), "# Alpha\n- First topic.\n")
    await writeFile(join(source, "memory", "beta.md"), "# Beta\n- Second topic.\n")

    await expect(copyStaticProjectRepresentation({
      sourceSnapshotWorkspaceDir: source,
      destinationWorkspaceDir: destination,
      onFilePublished: ({ publishedCount }) => {
        if (publishedCount === 1) throw new Error("simulated process crash")
      },
    })).rejects.toThrow("simulated process crash")

    expect(await readFile(join(destination, "MEMORY.md"), "utf8")).toBe("# Memory\n- Root note.\n")
    await expect(readFile(join(destination, "memory", "alpha.md"))).rejects.toMatchObject({ code: "ENOENT" })
    await expect(readFile(join(destination, STATIC_MEMORY_SCAFFOLD_MARKER))).rejects.toMatchObject({ code: "ENOENT" })
    expect(JSON.parse(await readFile(join(destination, STATIC_PROJECT_COPY_PREPARING_MARKER), "utf8")))
      .toMatchObject({
        schemaVersion: 1,
        kind: "static_project_copy_preparing",
        representation: {
          kind: "static_markdown_files",
          files: [
            { relPath: "MEMORY.md" },
            { relPath: "memory/alpha.md" },
            { relPath: "memory/beta.md" },
          ],
        },
      })

    const resumed = await copyStaticProjectRepresentation({
      sourceSnapshotWorkspaceDir: source,
      destinationWorkspaceDir: destination,
    })

    expect(resumed.outcome).toBe("copied")
    expect(resumed.source).toEqual(resumed.target)
    expect(await readFile(join(destination, "memory", "alpha.md"), "utf8"))
      .toBe("# Alpha\n- First topic.\n")
    expect(await readFile(join(destination, "memory", "beta.md"), "utf8"))
      .toBe("# Beta\n- Second topic.\n")
    await expect(readFile(join(destination, STATIC_PROJECT_COPY_PREPARING_MARKER))).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(join(destination, STATIC_MEMORY_SCAFFOLD_MARKER), "utf8"))
      .toContain(resumed.source.representationHash)
  })

  test("rejects mismatched or unexpected files found beside a preparing journal", async () => {
    for (const mutation of ["mismatch", "unexpected"] as const) {
      const root = await tempRoot()
      const source = join(root, "snapshot", "workspace")
      const destination = join(root, "second-project")
      await mkdir(join(source, "memory"), { recursive: true })
      await mkdir(destination, { recursive: true })
      await writeFile(join(source, "MEMORY.md"), "# Memory\n- Expected root.\n")
      await writeFile(join(source, "memory", "expected.md"), "# Expected\n- Expected topic.\n")

      await expect(copyStaticProjectRepresentation({
        sourceSnapshotWorkspaceDir: source,
        destinationWorkspaceDir: destination,
        onFilePublished: () => {
          throw new Error("simulated process crash")
        },
      })).rejects.toThrow("simulated process crash")

      if (mutation === "mismatch") {
        await writeFile(join(destination, "MEMORY.md"), "# Memory\n- Mismatched root.\n")
      } else {
        await mkdir(join(destination, "memory"), { recursive: true })
        await writeFile(join(destination, "memory", "unexpected.md"), "# Unexpected\n- Must not merge.\n")
      }

      await expect(copyStaticProjectRepresentation({
        sourceSnapshotWorkspaceDir: source,
        destinationWorkspaceDir: destination,
      })).rejects.toThrow(/different representation/i)
      await expect(readFile(join(destination, STATIC_MEMORY_SCAFFOLD_MARKER))).rejects.toMatchObject({ code: "ENOENT" })
      expect(await readFile(join(destination, STATIC_PROJECT_COPY_PREPARING_MARKER), "utf8"))
        .toContain("static_project_copy_preparing")
    }
  })

  test("refuses a source memory directory symlink instead of traversing it", async () => {
    const root = await tempRoot()
    const source = join(root, "snapshot", "workspace")
    const destination = join(root, "second-project")
    await mkdir(join(source, "notes"), { recursive: true })
    await mkdir(destination, { recursive: true })
    await writeFile(join(source, "notes", "indirect.md"), "# Indirect\n- Must not traverse.\n")
    await symlink("notes", join(source, "memory"))

    await expect(copyStaticProjectRepresentation({
      sourceSnapshotWorkspaceDir: source,
      destinationWorkspaceDir: destination,
    })).rejects.toThrow(/memory.*regular directory/i)

    await expect(readFile(join(destination, "memory", "indirect.md"))).rejects.toMatchObject({ code: "ENOENT" })
    await expect(readFile(join(destination, STATIC_MEMORY_SCAFFOLD_MARKER))).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("never writes through a destination memory directory symlink", async () => {
    const root = await tempRoot()
    const source = join(root, "snapshot", "workspace")
    const destination = join(root, "second-project")
    const outside = join(root, "outside")
    await mkdir(join(source, "memory"), { recursive: true })
    await mkdir(destination, { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(source, "memory", "private.md"), "# Private\n- Stay inside the project.\n")
    await symlink(outside, join(destination, "memory"))

    await expect(copyStaticProjectRepresentation({
      sourceSnapshotWorkspaceDir: source,
      destinationWorkspaceDir: destination,
    })).rejects.toThrow(/memory.*regular directory/i)

    await expect(readFile(join(outside, "private.md"))).rejects.toMatchObject({ code: "ENOENT" })
    await expect(readFile(join(destination, STATIC_PROJECT_COPY_PREPARING_MARKER))).rejects.toMatchObject({ code: "ENOENT" })
    await expect(readFile(join(destination, STATIC_MEMORY_SCAFFOLD_MARKER))).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("refuses a symlink at any Markdown representation path", async () => {
    const root = await tempRoot()
    const source = join(root, "snapshot", "workspace")
    const destination = join(root, "second-project")
    const outside = join(root, "outside-memory.md")
    await mkdir(source, { recursive: true })
    await mkdir(join(destination, "memory"), { recursive: true })
    await writeFile(join(source, "MEMORY.md"), "# Memory\n- Source note.\n")
    await writeFile(outside, "# Outside\n- Must remain untouched.\n")
    await symlink(outside, join(destination, "memory", "linked.md"))

    await expect(copyStaticProjectRepresentation({
      sourceSnapshotWorkspaceDir: source,
      destinationWorkspaceDir: destination,
    })).rejects.toThrow(/not a regular file/i)

    expect(await readFile(outside, "utf8")).toBe("# Outside\n- Must remain untouched.\n")
    await expect(readFile(join(destination, "MEMORY.md"))).rejects.toMatchObject({ code: "ENOENT" })
    await expect(readFile(join(destination, STATIC_PROJECT_COPY_PREPARING_MARKER))).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("refuses a destination workspace symlink without writing into its target", async () => {
    const root = await tempRoot()
    const source = join(root, "snapshot", "workspace")
    const destination = join(root, "second-project")
    const outside = join(root, "outside-workspace")
    await mkdir(source, { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(source, "MEMORY.md"), "# Memory\n- Never escape the destination root.\n")
    await symlink(outside, destination)

    await expect(copyStaticProjectRepresentation({
      sourceSnapshotWorkspaceDir: source,
      destinationWorkspaceDir: destination,
    })).rejects.toThrow(/destination.*regular directory/i)

    await expect(readFile(join(outside, "MEMORY.md"))).rejects.toMatchObject({ code: "ENOENT" })
    await expect(readFile(join(outside, STATIC_PROJECT_COPY_PREPARING_MARKER))).rejects.toMatchObject({ code: "ENOENT" })
    await expect(readFile(join(outside, STATIC_MEMORY_SCAFFOLD_MARKER))).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("does not accept a scaffold marker symlink as a completed copy", async () => {
    const root = await tempRoot()
    const source = join(root, "snapshot", "workspace")
    const destination = join(root, "second-project")
    const outsideMarker = join(root, "outside-marker")
    await mkdir(source, { recursive: true })
    await mkdir(destination, { recursive: true })
    await writeFile(outsideMarker, "untrusted marker\n")
    await symlink(outsideMarker, join(destination, STATIC_MEMORY_SCAFFOLD_MARKER))

    await expect(copyStaticProjectRepresentation({
      sourceSnapshotWorkspaceDir: source,
      destinationWorkspaceDir: destination,
    })).rejects.toThrow(/scaffold marker.*regular file/i)

    expect(await readFile(outsideMarker, "utf8")).toBe("untrusted marker\n")
    await expect(readFile(join(destination, STATIC_PROJECT_COPY_PREPARING_MARKER))).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("does not follow a preparing journal symlink", async () => {
    const root = await tempRoot()
    const source = join(root, "snapshot", "workspace")
    const destination = join(root, "second-project")
    const outsideJournal = join(root, "outside-journal")
    await mkdir(source, { recursive: true })
    await mkdir(destination, { recursive: true })
    await writeFile(join(source, "MEMORY.md"), "# Memory\n- Journal paths stay local.\n")
    await writeFile(outsideJournal, "{}\n")
    await symlink(outsideJournal, join(destination, STATIC_PROJECT_COPY_PREPARING_MARKER))

    await expect(copyStaticProjectRepresentation({
      sourceSnapshotWorkspaceDir: source,
      destinationWorkspaceDir: destination,
    })).rejects.toThrow(/preparing journal.*regular file/i)

    expect(await readFile(outsideJournal, "utf8")).toBe("{}\n")
    await expect(readFile(join(destination, "MEMORY.md"))).rejects.toMatchObject({ code: "ENOENT" })
    await expect(readFile(join(destination, STATIC_MEMORY_SCAFFOLD_MARKER))).rejects.toMatchObject({ code: "ENOENT" })
  })
})
