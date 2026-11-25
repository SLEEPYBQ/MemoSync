import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, rmSync } from "node:fs"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ChatAttachment } from "../shared/types"
import { EventStore } from "./event-store"
import { getProjectUploadDir } from "./paths"
import {
  handleProjectUpload,
  handleProjectUploadDelete,
  persistUploadedFiles,
  startMemoSyncServer,
  validateUploadFiles
} from "./server"
import { deleteProjectUpload, DraftUploadReceipts, inferAttachmentContentType, matchesProjectUpload, persistProjectUpload } from "./uploads"

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
  async function setupDraft() {
    const dir = await mkdtemp(path.join(tmpdir(), "memosync-draft-upload-"))
    tempDirs.push(dir)
    const store = new EventStore(path.join(dir, "data"))
    await store.initialize()
    const receipts = new DraftUploadReceipts()
    const first = await store.ensureDraft({ localPath: dir })
    function post(projectId: string, ...files: File[]) {
      const form = new FormData()
      for (const file of files) form.append("files", file)
      const req = new Request(`http://localhost/api/projects/${projectId}/uploads`, { method: "POST", body: form })
      return handleProjectUpload(req, new URL(req.url), store, receipts)
    }
    function remove(projectId: string, name: string, receipt?: string, sha256?: string) {
      const headers: Record<string, string> = {}
      if (receipt) headers["X-MemoSync-Upload-Receipt"] = receipt
      if (sha256) headers["X-MemoSync-Upload-Sha256"] = sha256
      const req = new Request(`http://localhost/api/projects/${projectId}/uploads/${encodeURIComponent(name)}`, {
        method: "DELETE", headers: Object.keys(headers).length ? headers : undefined,
      })
      return handleProjectUploadDelete(req, new URL(req.url), store, receipts)
    }
    return { dir, store, receipts, first, post, remove }
  }

  test("rolls back just the in-flight batch when its draft project retires between writes", async () => {
    const { dir, store, receipts, first, post } = await setupDraft()
    await post(first.projectId, new File(["already delivered"], "note.txt"))
    const form = new FormData()
    form.append("files", new File(["first in batch"], "note.txt"))
    form.append("files", new File(["last in batch"], "last.txt"))
    // Bun can return fresh File wrappers on each getAll. Gate the actual read
    // of file #2, after file #1 is on disk, without a timer or a mocked writer.
    const files = form.getAll("files")
    const last = files[1] as File
    const read = last.arrayBuffer.bind(last)
    const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
    last.arrayBuffer = async () => { entered.resolve(); await resume.promise; return read() }
    const getAll = form.getAll.bind(form)
    form.getAll = name => name === "files" ? files : getAll(name)
    const req = new Request(`http://localhost/api/projects/${first.projectId}/uploads`, { method: "POST" })
    req.formData = async () => form
    const result = handleProjectUpload(req, new URL(req.url), store, receipts)
    const file = (name: string) => Bun.file(path.join(getProjectUploadDir(dir), name))
    await entered.promise
    try {
      expect(await file("note-1.txt").text()).toBe("first in batch")
      await store.discardDraft(first.chatId)
      const next = await store.ensureDraft({ localPath: dir })
      await post(next.projectId, new File(["current draft"], "last.txt"))
    } finally { resume.resolve() }
    const response = await result
    expect(await file("note-1.txt").exists()).toBe(false)
    expect(await file("last-1.txt").exists()).toBe(false)
    expect(await file("note.txt").text()).toBe("already delivered")
    expect(await file("last.txt").text()).toBe("current draft")
    expect(response?.status).toBe(404)
  })

  test.each([false, true])("discards only the undelivered result after HTTP finalization and draft retirement (name reused=%s)", async reused => {
    const { dir, store, first, post, remove } = await setupDraft()
    await post(first.projectId, new File(["keep this attachment"], "kept.txt"))
    // POST has finalized, but the old composer hasn't processed its response.
    const response = await post(first.projectId, new File(["abandoned"], "late.txt"))
    expect(response?.status).toBe(200)
    await store.discardDraft(first.chatId)
    const next = await store.ensureDraft({ localPath: dir })
    expect(next.projectId).not.toBe(first.projectId)
    const oldPath = path.join(getProjectUploadDir(dir), "late.txt")
    expect(await Bun.file(oldPath).text()).toBe("abandoned")
    if (reused) rmSync(path.join(getProjectUploadDir(dir), "late.txt"), { force: true })
    const current = await post(next.projectId, new File(["new draft"], "late.txt"))
    const { attachments: [live] } = await current!.json() as { attachments: ChatAttachment[] }
    expect(live!.absolutePath === oldPath).toBe(reused)

    const { attachments: [abandoned], cleanupReceipts } = await response!.json() as {
      attachments: ChatAttachment[]; cleanupReceipts?: Record<string, string>
    }
    const receipt = cleanupReceipts?.[abandoned!.id]
    expect(receipt).toEqual(expect.any(String))
    // A returning tab can rebind the old project's URL, but not its byte
    // identity. Nor can that old POST's cleanup grant unlink the replacement.
    const project = store.getProject(next.projectId)!
    const rebound = { ...abandoned!, contentUrl: `/api/projects/${project.id}/uploads/late.txt/content` }
    expect(live!.size).toBe(rebound.size)
    expect(await matchesProjectUpload(project, rebound)).toBe(!reused)
    expect((await remove(first.projectId, "late.txt"))?.status).toBe(404)
    expect(await (await remove(first.projectId, "late.txt", receipt))!.json()).toEqual({ ok: !reused })
    if (!reused) expect(await Bun.file(oldPath).exists()).toBe(false)
    expect(await matchesProjectUpload(project, rebound)).toBe(false)
    expect(await matchesProjectUpload(project, live!)).toBe(true)
    expect(await Bun.file(live!.absolutePath).text()).toBe("new draft")
    expect(await Bun.file(path.join(getProjectUploadDir(dir), "kept.txt")).text()).toBe("keep this attachment")
  })

  test("leaves a draft upload alone if its on-disk contents changed before late cleanup", async () => {
    const { store, first, post, remove } = await setupDraft()
    const response = await post(first.projectId, new File(["original"], "Résumé.txt"))
    const { attachments: [attachment], cleanupReceipts } = await response!.json() as {
      attachments: ChatAttachment[]; cleanupReceipts: Record<string, string>
    }
    await store.discardDraft(first.chatId)
    await writeFile(attachment!.absolutePath, "edited in the workspace")
    const removed = await remove(first.projectId, "Résumé.txt", cleanupReceipts[attachment!.id])
    expect(await removed!.json()).toEqual({ ok: false })
    expect(await Bun.file(attachment!.absolutePath).text()).toBe("edited in the workspace")
  })

  test("a receiptless delete unlinks only bytes identical to the chip's upload", async () => {
    const { first, post, remove } = await setupDraft()
    const response = await post(first.projectId, new File(["original upload"], "notes.txt"))
    const { attachments: [attachment] } = await response!.json() as { attachments: ChatAttachment[] }
    expect(attachment!.uploadSha256).toMatch(/^[0-9a-f]{64}$/)
    const file = () => Bun.file(attachment!.absolutePath)
    // No byte proof: the chip detaches but nothing is unlinked.
    expect(await (await remove(first.projectId, "notes.txt"))!.json()).toEqual({ ok: false })
    expect(await file().text()).toBe("original upload")
    // A wrong digest proves nothing either.
    expect(await (await remove(first.projectId, "notes.txt", undefined, "0".repeat(64)))!.json()).toEqual({ ok: false })
    expect(await file().text()).toBe("original upload")
    expect(await (await remove(first.projectId, "notes.txt", undefined, attachment!.uploadSha256))!.json()).toEqual({ ok: true })
    expect(await file().exists()).toBe(false)
  })

  test("a rebound chip cannot unlink a replacement occupying its stored name", async () => {
    const { first, post, remove } = await setupDraft()
    const response = await post(first.projectId, new File(["original upload"], "notes.txt"))
    const { attachments: [attachment] } = await response!.json() as { attachments: ChatAttachment[] }
    // The workspace file is replaced behind the draft's back, keeping the name.
    await writeFile(attachment!.absolutePath, "someone else's replacement")
    expect(await (await remove(first.projectId, "notes.txt", undefined, attachment!.uploadSha256))!.json()).toEqual({ ok: false })
    expect(await Bun.file(attachment!.absolutePath).text()).toBe("someone else's replacement")
  })

  test("returns a controlled 400 for malformed multipart without writing files", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "memosync-upload-malformed-"))
    tempDirs.push(projectDir)
    const server = await startIsolatedServer()
    const project = await server.store.openProject(projectDir, "Project")
    const response = await fetch(`http://localhost:${server.port}/api/projects/${project.id}/uploads`, {
      method: "POST",
      headers: { "Content-Type": "multipart/form-data" },
      body: "private-payload-that-must-not-be-in-the-response",
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "Could not read the upload request. Please try again.", uiText: { code: "uploadUnreadable" } })
    expect(existsSync(getProjectUploadDir(projectDir))).toBe(false)
  })

  test("rejects mismatched or invalid upload sizes before writing any files", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "memosync-upload-sizes-"))
    tempDirs.push(projectDir)
    const server = await startIsolatedServer()
    const project = await server.store.openProject(projectDir, "Project")
    for (const sizes of [["5"], ["6", "0"], ["-1"], ["1.5"], [""], ["NaN"], ["9007199254740992"]]) {
      const form = new FormData()
      form.append("files", new File(["你好"], "notes.txt"))
      for (const size of sizes) form.append("clientFileSizes", size)
      const response = await fetch(`http://localhost:${server.port}/api/projects/${project.id}/uploads`, {
        method: "POST", body: form,
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        error: sizes[0] === "5"
          ? "The uploaded file size does not match. Please try again."
          : "Invalid upload size metadata.",
        uiText: { code: sizes[0] === "5" ? "uploadMismatch" : "uploadMetadata" },
      })
      expect(existsSync(getProjectUploadDir(projectDir))).toBe(false)
    }
  })

  test("accepts matching upload byte sizes and requests without size metadata", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "memosync-upload-matching-"))
    tempDirs.push(projectDir)
    const server = await startIsolatedServer()
    const project = await server.store.openProject(projectDir, "Project")
    for (const withSizes of [true, false]) {
      const form = new FormData()
      const files = [new File(["你好"], "notes.txt"), new File([], "empty.txt")]
      for (const file of files) {
        form.append("files", file)
        if (withSizes) form.append("clientFileSizes", String(file.size))
      }
      const response = await fetch(`http://localhost:${server.port}/api/projects/${project.id}/uploads`, {
        method: "POST", body: form,
      })
      expect(response.status).toBe(200)
      const payload = await response.json() as { attachments: Array<{ size: number; absolutePath: string }> }
      expect(Object.keys(payload)).toEqual(["attachments"]) // Saved projects need no draft cleanup receipts.
      expect(payload.attachments.map((attachment) => attachment.size)).toEqual([6, 0])
      expect(await Bun.file(payload.attachments[0]!.absolutePath).text()).toBe("你好")
      expect(await Bun.file(payload.attachments[1]!.absolutePath).text()).toBe("")
    }
  })

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
        uiText: { code: "uploadFileSize", params: { v0: "big.bin", v1: "100" } },
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
