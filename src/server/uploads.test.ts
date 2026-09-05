import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { deleteProjectUpload, inferAttachmentContentType, persistProjectUpload } from "./uploads"
import { getProjectUploadDir } from "./paths"
import {
  handleProjectUpload,
  handleProjectUploadDelete,
  persistUploadedFiles,
  startMemoSyncServer,
  validateUploadFiles,
} from "./server"

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yF9sAAAAASUVORK5CYII="

const tempDirs: string[] = []
// Every server a helper boots, stopped in afterEach even when a test aborted
// mid-boot (a timed-out test never reaches its own finally).
const liveServers: Array<{ stop: () => Promise<void> }> = []

afterEach(async () => {
  // Stop servers BEFORE deleting their data dirs — a live server watches
  // settings.json inside them (deleting first fires unhandled fs.watch errors).
  await Promise.all(liveServers.splice(0).map((server) => server.stop().catch(() => {})))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function startIsolatedServer() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "memosync-server-data-"))
  tempDirs.push(dataDir)
  const server = await startMemoSyncServer({
    dataDir,
    // Ephemeral port: parallel files and leftover servers can never collide.
    port: 0,
    strictPort: true,
    // Never scan the developer's real ~/.claude / ~/.codex from a test boot.
    discoverProjects: () => [],
  })
  liveServers.push(server)
  return server
}

describe("uploads", () => {
  test("rejects a batch whose combined size exceeds the request limit", () => {
    const files = ["a.bin", "b.bin", "c.bin"].map((name) => ({
      name,
      size: 80 * 1024 * 1024,
    }))

    expect(validateUploadFiles(files)).toEqual({
      error: "Combined uploads exceed the 200 MB limit.",
      status: 413,
    })
  })

  test("stores uploads in .memosync/uploads and keeps duplicate filenames", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-upload-test-"))
    tempDirs.push(projectDir)

    const first = await persistProjectUpload({
      projectId: "project-1",
      localPath: projectDir,
      fileName: "notes.txt",
      bytes: new TextEncoder().encode("hello"),
      fallbackMimeType: "text/plain",
    })
    const second = await persistProjectUpload({
      projectId: "project-1",
      localPath: projectDir,
      fileName: "notes.txt",
      bytes: new TextEncoder().encode("world"),
      fallbackMimeType: "text/plain",
    })

    expect(first.absolutePath).toBe(path.join(projectDir, ".memosync/uploads/notes.txt"))
    expect(first.relativePath).toBe("./.memosync/uploads/notes.txt")
    expect(first.contentUrl).toBe("/api/projects/project-1/uploads/notes.txt/content")
    expect(second.absolutePath).toBe(path.join(projectDir, ".memosync/uploads/notes-1.txt"))
    expect(second.relativePath).toBe("./.memosync/uploads/notes-1.txt")
    expect(second.contentUrl).toBe("/api/projects/project-1/uploads/notes-1.txt/content")
    expect(await Bun.file(path.join(projectDir, ".memosync/uploads/notes.txt")).text()).toBe("hello")
    expect(await Bun.file(path.join(projectDir, ".memosync/uploads/notes-1.txt")).text()).toBe("world")
  })

  test("stores concurrent same-name uploads without overwriting existing content", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-upload-concurrent-"))
    tempDirs.push(projectDir)

    const attachments = await Promise.all([
      persistProjectUpload({
        projectId: "project-1",
        localPath: projectDir,
        fileName: "notes.txt",
        bytes: new TextEncoder().encode("first"),
        fallbackMimeType: "text/plain",
      }),
      persistProjectUpload({
        projectId: "project-1",
        localPath: projectDir,
        fileName: "notes.txt",
        bytes: new TextEncoder().encode("second"),
        fallbackMimeType: "text/plain",
      }),
      persistProjectUpload({
        projectId: "project-1",
        localPath: projectDir,
        fileName: "notes.txt",
        bytes: new TextEncoder().encode("third"),
        fallbackMimeType: "text/plain",
      }),
    ])

    const storedNames = attachments.map((attachment) => path.basename(attachment.absolutePath)).sort()
    expect(storedNames).toEqual(["notes-1.txt", "notes-2.txt", "notes.txt"])

    const contents = await Promise.all(attachments.map((attachment) => Bun.file(attachment.absolutePath).text()))
    expect(new Set(contents)).toEqual(new Set(["first", "second", "third"]))
  })

  test("detects image uploads and returns absolute plus project-relative paths", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-upload-image-"))
    tempDirs.push(projectDir)

    const attachment = await persistProjectUpload({
      projectId: "project-2",
      localPath: projectDir,
      fileName: "pixel.png",
      bytes: Buffer.from(PNG_BASE64, "base64"),
    })

    expect(attachment.kind).toBe("image")
    expect(attachment.mimeType).toBe("image/png")
    expect(getProjectUploadDir(projectDir)).toBe(path.join(projectDir, ".memosync", "uploads"))
    expect(attachment.absolutePath).toBe(path.join(projectDir, ".memosync/uploads/pixel.png"))
    expect(attachment.relativePath).toBe("./.memosync/uploads/pixel.png")
    expect(attachment.contentUrl).toBe("/api/projects/project-2/uploads/pixel.png/content")
  })

  test("serves uploaded attachment content through the project content URL", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-project-"))
    tempDirs.push(projectDir)

    const server = await startIsolatedServer()

    try {
      const project = await server.store.openProject(projectDir, "Project")
      const attachment = await persistProjectUpload({
        projectId: project.id,
        localPath: projectDir,
        fileName: "hello.txt",
        bytes: new TextEncoder().encode("hello from upload"),
        fallbackMimeType: "text/plain",
      })

      const response = await fetch(`http://localhost:${server.port}${attachment.contentUrl}`)
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8")
      expect(await response.text()).toBe("hello from upload")
    } finally {
      await server.stop()
    }
  })

  test("serves TypeScript uploads as text content", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-project-typescript-"))
    tempDirs.push(projectDir)

    const server = await startIsolatedServer()

    try {
      const project = await server.store.openProject(projectDir, "Project")
      const attachment = await persistProjectUpload({
        projectId: project.id,
        localPath: projectDir,
        fileName: "main.ts",
        bytes: new TextEncoder().encode("export const value = 1\n"),
        fallbackMimeType: "video/mp2t",
      })

      const response = await fetch(`http://localhost:${server.port}${attachment.contentUrl}`)
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8")
      expect(await response.text()).toContain("export const value = 1")
    } finally {
      await server.stop()
    }
  })

  test("serves SVG uploads as non-executable text with nosniff", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-project-svg-"))
    tempDirs.push(projectDir)
    const server = await startIsolatedServer()

    try {
      const project = await server.store.openProject(projectDir, "Project")
      const attachment = await persistProjectUpload({
        projectId: project.id,
        localPath: projectDir,
        fileName: "diagram.svg",
        bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
        fallbackMimeType: "image/svg+xml",
      })

      expect(attachment.kind).toBe("file")
      expect(attachment.mimeType).toBe("text/plain; charset=utf-8")
      const response = await fetch(`http://localhost:${server.port}${attachment.contentUrl}`)
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8")
      expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    } finally {
      await server.stop()
    }
  })

  test("serves XHTML uploads as non-executable text with nosniff", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-project-xhtml-"))
    tempDirs.push(projectDir)
    const server = await startIsolatedServer()

    try {
      const project = await server.store.openProject(projectDir, "Project")
      const attachment = await persistProjectUpload({
        projectId: project.id,
        localPath: projectDir,
        fileName: "page.xhtml",
        bytes: new TextEncoder().encode('<html xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></html>'),
        fallbackMimeType: "application/xhtml+xml",
      })

      const response = await fetch(`http://localhost:${server.port}${attachment.contentUrl}`)
      expect(attachment.kind).toBe("file")
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8")
      expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    } finally {
      await server.stop()
    }
  })

  test("rejects upload writes and deletes when the uploads directory is a symlink", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-upload-link-project-"))
    const outsideDir = await mkdtemp(path.join(tmpdir(), "kanna-upload-link-outside-"))
    tempDirs.push(projectDir, outsideDir)
    await mkdir(path.join(projectDir, ".memosync"))
    await symlink(outsideDir, path.join(projectDir, ".memosync", "uploads"))
    await writeFile(path.join(outsideDir, "keep.txt"), "outside", "utf8")

    await expect(persistProjectUpload({
      projectId: "project-escape",
      localPath: projectDir,
      fileName: "escaped.txt",
      bytes: new TextEncoder().encode("must stay inside"),
    })).rejects.toThrow("escapes the project root")
    expect(await Bun.file(path.join(outsideDir, "escaped.txt")).exists()).toBe(false)

    expect(await deleteProjectUpload({ localPath: projectDir, storedName: "keep.txt" })).toBe(false)
    expect(await Bun.file(path.join(outsideDir, "keep.txt")).text()).toBe("outside")
  })

  test("rejects project file symlinks that resolve outside the project", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-project-files-"))
    const outsideDir = await mkdtemp(path.join(tmpdir(), "kanna-outside-files-"))
    tempDirs.push(projectDir, outsideDir)
    await writeFile(path.join(outsideDir, "secret.txt"), "outside", "utf8")
    await symlink(path.join(outsideDir, "secret.txt"), path.join(projectDir, "leak.txt"))
    const server = await startIsolatedServer()

    try {
      const project = await server.store.openProject(projectDir, "Project")
      const response = await fetch(
        `http://localhost:${server.port}/api/projects/${project.id}/files/leak.txt/content`,
      )
      expect(response.status).toBe(400)
    } finally {
      await server.stop()
    }
  })

  test("rejects non-GET requests for attachment content", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-project-content-method-"))
    tempDirs.push(projectDir)

    const server = await startIsolatedServer()

    try {
      const project = await server.store.openProject(projectDir, "Project")
      const attachment = await persistProjectUpload({
        projectId: project.id,
        localPath: projectDir,
        fileName: "hello.txt",
        bytes: new TextEncoder().encode("hello from upload"),
        fallbackMimeType: "text/plain",
      })

      const response = await fetch(`http://localhost:${server.port}${attachment.contentUrl}`, { method: "POST" })
      expect(response.status).toBe(405)
      expect(response.headers.get("allow")).toBe("GET")
    } finally {
      await server.stop()
    }
  })

  test("rejects oversized uploads before reading them into memory", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-project-oversize-"))
    tempDirs.push(projectDir)

    const server = await startIsolatedServer()

    try {
      const project = await server.store.openProject(projectDir, "Project")
      const formData = new FormData()
      formData.append("files", new File([new Uint8Array(100 * 1024 * 1024 + 1)], "big.bin", { type: "application/octet-stream" }))

      const response = await fetch(`http://localhost:${server.port}/api/projects/${project.id}/uploads`, {
        method: "POST",
        body: formData,
      })

      expect(response.status).toBe(413)
      expect(await response.json()).toEqual({
        error: "File \"big.bin\" exceeds the 100 MB limit.",
      })
    } finally {
      await server.stop()
    }
  })

  test("cleans up already-persisted files when a later file in the batch fails", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-project-cleanup-"))
    tempDirs.push(projectDir)

    const files = [
      new File(["first"], "first.txt", { type: "text/plain" }),
      new File(["second"], "second.txt", { type: "text/plain" }),
    ]

    await expect(
      persistUploadedFiles({
        projectId: "project-4",
        localPath: projectDir,
        files,
        persistUpload: async (args) => {
          if (args.fileName === "second.txt") {
            throw new Error("disk full")
          }

          return persistProjectUpload(args)
        },
      })
    ).rejects.toThrow("disk full")

    expect(await Bun.file(path.join(projectDir, ".memosync/uploads/first.txt")).exists()).toBe(false)
    expect(await Bun.file(path.join(projectDir, ".memosync/uploads/second.txt")).exists()).toBe(false)
  })

  test("deletes uploaded attachments from the project uploads directory", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-upload-delete-"))
    tempDirs.push(projectDir)

    const attachment = await persistProjectUpload({
      projectId: "project-3",
      localPath: projectDir,
      fileName: "delete-me.txt",
      bytes: new TextEncoder().encode("bye"),
      fallbackMimeType: "text/plain",
    })

    const deleted = await deleteProjectUpload({
      localPath: projectDir,
      storedName: "delete-me.txt",
    })

    expect(deleted).toBe(true)
    expect(await Bun.file(attachment.absolutePath).exists()).toBe(false)
  })

  test("deletes uploaded attachment content through the project delete URL", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-project-delete-"))
    tempDirs.push(projectDir)

    const server = await startIsolatedServer()

    try {
      const project = await server.store.openProject(projectDir, "Project")
      const attachment = await persistProjectUpload({
        projectId: project.id,
        localPath: projectDir,
        fileName: "bye.txt",
        bytes: new TextEncoder().encode("delete over http"),
        fallbackMimeType: "text/plain",
      })

      const deleteUrl = `http://localhost:${server.port}${attachment.contentUrl.replace(/\/content$/, "")}`
      const response = await fetch(deleteUrl, { method: "DELETE" })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
      expect(await Bun.file(attachment.absolutePath).exists()).toBe(false)
    } finally {
      await server.stop()
    }
  })

  test("rejects wrong-project upload writes and deletes through the study authority", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-project-study-upload-"))
    tempDirs.push(projectDir)
    const project = { id: "project-car", localPath: projectDir }
    const store = { getProject: (id: string) => id === project.id ? project : null }
    const access = { projectRefusal: () => "Use the assigned apartment project." }
    const formData = new FormData()
    formData.append("files", new File(["notes"], "notes.txt", { type: "text/plain" }))
    const uploadRequest = new Request(`http://localhost/api/projects/${project.id}/uploads`, {
      method: "POST",
      body: formData,
    })
    const upload = await handleProjectUpload(
      uploadRequest,
      new URL(uploadRequest.url),
      store as never,
      access,
    )

    const attachment = await persistProjectUpload({
      projectId: project.id,
      localPath: projectDir,
      fileName: "existing.txt",
      bytes: new TextEncoder().encode("keep"),
      fallbackMimeType: "text/plain",
    })
    const deleteRequest = new Request(
      `http://localhost/api/projects/${project.id}/uploads/existing.txt`,
      { method: "DELETE" },
    )
    const deletion = await handleProjectUploadDelete(
      deleteRequest,
      new URL(deleteRequest.url),
      store as never,
      access,
    )

    expect(upload!.status).toBe(409)
    expect(deletion!.status).toBe(409)
    expect(await Bun.file(path.join(projectDir, ".memosync/uploads/notes.txt")).exists()).toBe(false)
    expect(await Bun.file(attachment.absolutePath).text()).toBe("keep")
  })

  test("infers text-friendly content types for previewable source files", () => {
    expect(inferAttachmentContentType("notes.txt")).toBe("text/plain; charset=utf-8")
    expect(inferAttachmentContentType("README.md")).toBe("text/markdown; charset=utf-8")
    expect(inferAttachmentContentType("main.ts", "video/mp2t")).toBe("text/plain; charset=utf-8")
    expect(inferAttachmentContentType("diagram.svg", "image/svg+xml")).toBe("text/plain; charset=utf-8")
    expect(inferAttachmentContentType("page.htm", "text/html")).toBe("text/plain; charset=utf-8")
    expect(inferAttachmentContentType("page.xhtml", "application/xhtml+xml")).toBe("text/plain; charset=utf-8")
    expect(inferAttachmentContentType("diagram.svgz", "image/svg+xml")).toBe("text/plain; charset=utf-8")
    expect(inferAttachmentContentType("archive.zip", "application/zip")).toBe("application/zip")
  })
})
