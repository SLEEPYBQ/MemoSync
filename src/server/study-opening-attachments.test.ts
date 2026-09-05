import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ChatAttachment } from "../shared/types"
import {
  captureContainedAttachment,
  createStudyOpeningAttachmentSnapshotStore,
} from "./study-opening-attachments"

function attachment(absolutePath: string): ChatAttachment {
  return {
    id: "attachment-1",
    kind: "file",
    displayName: "notes.txt",
    absolutePath,
    relativePath: "./.memosync/uploads/notes.txt",
    contentUrl: "/api/projects/project-1/uploads/notes.txt/content",
    mimeType: "text/plain",
    size: 14,
  }
}

describe("study opening attachment snapshots", () => {
  test("keeps the exact admitted bytes across same-size source replacement and restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "opening-attachment-snapshot-"))
    const projectRoot = join(dir, "project")
    const snapshotRoot = join(dir, "server-data", "opening-attachments")
    const source = join(projectRoot, "notes.txt")
    mkdirSync(projectRoot, { recursive: true })
    writeFileSync(source, "original bytes")
    try {
      const original = attachment(source)
      const captured = captureContainedAttachment(projectRoot, original)
      expect(captured?.bytes.toString("utf8")).toBe("original bytes")
      const store = createStudyOpeningAttachmentSnapshotStore(snapshotRoot)
      const first = store.persist("opening-review-1", [captured!])

      writeFileSync(source, "replaced bytes")
      const restarted = createStudyOpeningAttachmentSnapshotStore(snapshotRoot)
      const verified = restarted.verify(first)

      expect(verified.ok).toBe(true)
      if (!verified.ok) throw new Error(verified.error)
      expect(verified.attachments).toHaveLength(1)
      expect(verified.attachments[0]!.absolutePath).not.toBe(source)
      expect(verified.attachments[0]!.relativePath).not.toContain(original.relativePath)
      expect(readFileSync(verified.attachments[0]!.absolutePath, "utf8")).toBe("original bytes")
      expect(readFileSync(source, "utf8")).toBe("replaced bytes")
      expect(restarted.persist("opening-review-1", [captured!])).toEqual(first)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("fails closed for a missing, corrupt, or wrong-digest durable snapshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "opening-attachment-corrupt-"))
    const projectRoot = join(dir, "project")
    const source = join(projectRoot, "notes.txt")
    mkdirSync(projectRoot, { recursive: true })
    writeFileSync(source, "original bytes")
    try {
      const store = createStudyOpeningAttachmentSnapshotStore(join(dir, "server-data", "opening-attachments"))
      const captured = captureContainedAttachment(projectRoot, attachment(source))!
      const snapshots = store.persist("opening-review-corrupt", [captured])
      const snapshotPath = snapshots[0]!.snapshotPath

      chmodSync(snapshotPath, 0o600)
      writeFileSync(snapshotPath, "corrupt! bytes")
      expect(store.verify(snapshots)).toMatchObject({ ok: false })

      writeFileSync(snapshotPath, "original bytes")
      expect(store.verify([{ ...snapshots[0]!, contentSha256: "0".repeat(64) }])).toMatchObject({ ok: false })

      unlinkSync(snapshotPath)
      expect(store.verify(snapshots)).toMatchObject({ ok: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
