import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { TranscriptEntry } from "../shared/types"
import { TEXT_PREVIEW_LIMIT_BYTES } from "../shared/attachment-preview"
import { writeStandaloneTranscriptExport } from "./standalone-export"

const tempDirs: string[] = []

async function createTempDir(prefix: string) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function createViewerDist() {
  const viewerDistDir = await createTempDir("kanna-viewer-")
  await mkdir(path.join(viewerDistDir, "assets"), { recursive: true })
  await writeFile(path.join(viewerDistDir, "index.html"), "<!doctype html><html><body><div id=\"root\"></div></body></html>\n", "utf8")
  await writeFile(path.join(viewerDistDir, "assets", "viewer.js"), "console.log('viewer')\n", "utf8")
  return viewerDistDir
}

function createMessages(attachmentAbsolutePath: string): TranscriptEntry[] {
  return [
    {
      _id: "user-1",
      createdAt: Date.now(),
      kind: "user_prompt",
      messageId: "message-1",
      content: "Please review this attachment.",
      attachments: [{
        id: "attachment-1",
        kind: "image",
        displayName: "mock.png",
        absolutePath: attachmentAbsolutePath,
        relativePath: "./.kanna/uploads/mock.png",
        contentUrl: "/api/projects/project-1/uploads/mock.png/content",
        mimeType: "image/png",
        size: 4,
      }],
    },
    {
      _id: "assistant-1",
      createdAt: Date.now(),
      kind: "assistant_text",
      messageId: "message-2",
      text: `Looks good in ${attachmentAbsolutePath}.`,
    },
    {
      _id: "candidate-1",
      createdAt: Date.now(),
      kind: "memory_candidates",
      candidates: [{
        id: "M-01",
        content: "legacy-secret-candidate",
        detail: "legacy-person@example.com",
        type: "fact",
        scope: "personal",
        abstractionLevel: "concrete",
        sensitive: true,
      }],
    },
  ]
}

describe("writeStandaloneTranscriptExport", () => {
  test("embeds escaped, path-scrubbed text previews only for bundled attachments", async () => {
    const viewerDistDir = await createViewerDist()
    const projectDir = await createTempDir("memosync-export-text-")
    const attachmentPath = path.join(projectDir, "notes.md")
    const payload = `# Private attachment\n${projectDir}\n</script><script>window.attachmentInjected=true</script>`
    await writeFile(attachmentPath, payload)
    const messages: TranscriptEntry[] = [{
      _id: "text", createdAt: 1, kind: "user_prompt", messageId: "text", content: "Read notes",
      attachments: [{ id: "note", kind: "file", displayName: "notes.md", mimeType: "text/markdown",
        absolutePath: attachmentPath, relativePath: "notes.md", contentUrl: "/api/notes.md", size: payload.length }],
    }]
    const args = { chatId: "text", title: "Text attachment", localPath: projectDir, theme: "light" as const, messages }
    const result = await writeStandaloneTranscriptExport({ ...args, attachmentMode: "bundle" }, { viewerDistDir })
    const bundle = await Bun.file(result.transcriptJsonPath).json()
    const url = bundle.messages[0].attachments[0].contentUrl
    expect(bundle.textAttachmentPreviews[url]).toEqual({ content: payload.replaceAll(projectDir, "/workspace"), truncated: false })
    const html = await Bun.file(result.indexHtmlPath).text()
    expect(html).not.toContain("</script><script>window.attachmentInjected")
    expect(html).not.toContain(projectDir)
    const inline = html.match(/<script id="memosync-transcript-data" type="application\/json">([\s\S]*?)<\/script>/)?.[1]
    expect(JSON.parse(inline!)).toEqual(bundle)

    const metadata = await writeStandaloneTranscriptExport({ ...args, attachmentMode: "metadata" }, { viewerDistDir })
    expect((await Bun.file(metadata.transcriptJsonPath).json()).textAttachmentPreviews).toBeUndefined()
    expect(await Bun.file(metadata.indexHtmlPath).text()).not.toContain("Private attachment")
  })

  test("bounds embedded text previews while preserving the complete attachment file", async () => {
    const viewerDistDir = await createViewerDist()
    const projectDir = await createTempDir("memosync-export-bounded-")
    const attachmentPath = path.join(projectDir, "large.txt")
    await writeFile(attachmentPath, "x".repeat(TEXT_PREVIEW_LIMIT_BYTES + 17))
    const result = await writeStandaloneTranscriptExport({
      chatId: "bounded", title: "Bounded text", localPath: projectDir, theme: "light", attachmentMode: "bundle",
      messages: [{ _id: "text", createdAt: 1, kind: "user_prompt", messageId: "text", content: "Read text",
        attachments: [{ id: "large", kind: "file", displayName: "large.txt", mimeType: "text/plain",
          absolutePath: attachmentPath, relativePath: "large.txt", contentUrl: "/api/large.txt", size: TEXT_PREVIEW_LIMIT_BYTES + 17 }] }],
    }, { viewerDistDir })
    const bundle = await Bun.file(result.transcriptJsonPath).json()
    const url = bundle.messages[0].attachments[0].contentUrl
    expect(bundle.textAttachmentPreviews[url].content.length).toBe(TEXT_PREVIEW_LIMIT_BYTES)
    expect(bundle.textAttachmentPreviews[url].truncated).toBe(true)
    expect((await Bun.file(path.join(result.outputDir, url)).text()).length).toBe(TEXT_PREVIEW_LIMIT_BYTES + 17)
  })

  test("embeds the sanitized transcript as inert JSON without an HTML injection", async () => {
    const viewerDistDir = await createViewerDist()
    const literalBodyTag = '<script>window.tag = "</body>"</script>'
    await writeFile(path.join(viewerDistDir, "index.html"), `<html><body>${literalBodyTag}<div id="root"></div></body></html>`)
    const projectDir = await createTempDir("memosync-export-inline-")
    const payload = '</script><script>window.exportInjected = true</script>'
    const result = await writeStandaloneTranscriptExport({
      chatId: "inline-proof", title: payload, localPath: projectDir,
      theme: "light", attachmentMode: "metadata", messages: createMessages(path.join(projectDir, "private.png")),
    }, { viewerDistDir })
    const html = await Bun.file(result.indexHtmlPath).text()
    const inlineJson = html.match(/<script id="memosync-transcript-data" type="application\/json">([\s\S]*?)<\/script>/)?.[1]
    expect(inlineJson).toBeDefined()
    expect(JSON.parse(inlineJson!)).toEqual(await Bun.file(result.transcriptJsonPath).json())
    expect(html).not.toContain(payload)
    expect(html).not.toContain("legacy-secret-candidate")
    expect(html).not.toContain("legacy-person@example.com")
    expect(html).not.toContain(projectDir)
    expect(html).toContain(literalBodyTag)
  })

  test("writes a metadata-only export with viewer assets and sanitized attachments", async () => {
    const viewerDistDir = await createViewerDist()
    const projectDir = await createTempDir("memosync-project-")
    const uploadsDir = path.join(projectDir, ".memosync", "uploads")
    await mkdir(uploadsDir, { recursive: true })
    const attachmentPath = path.join(uploadsDir, "mock.png")
    await writeFile(attachmentPath, "mock", "utf8")

    const result = await writeStandaloneTranscriptExport({
      chatId: "chat-1",
      title: "Release Review",
      localPath: projectDir,
      theme: "dark",
      attachmentMode: "metadata",
      messages: createMessages(attachmentPath),
    }, {
      viewerDistDir,
      now: new Date("2026-04-23T12:34:56.000Z"),
    })

    expect(result.ok).toBe(true)
    expect(await Bun.file(result.indexHtmlPath).exists()).toBe(true)
    expect(await Bun.file(path.join(result.outputDir, "assets", "viewer.js")).exists()).toBe(true)
    expect(result.totalAttachmentCount).toBe(1)
    expect(result.bundledAttachmentCount).toBe(0)

    const bundle = await Bun.file(result.transcriptJsonPath).json()
    expect(bundle.title).toBe("Release Review")
    expect(bundle.viewerVersion).toBeDefined()
    expect(bundle.theme).toBe("dark")
    expect(bundle.attachmentMode).toBe("metadata")
    expect(bundle.localPath).toBe("/workspace")
    expect(bundle.messages[0].attachments[0].contentUrl).toBe("")
    expect(bundle.messages[0].attachments[0].absolutePath).toBe("")
    expect(bundle.messages[0].attachments[0].relativePath).toBe("")
    expect(bundle.messages[2].candidates).toEqual([{ id: "M-01" }])
    expect(JSON.stringify(bundle)).not.toContain("legacy-secret-candidate")
    expect(JSON.stringify(bundle)).not.toContain("legacy-person@example.com")
    expect(JSON.stringify(bundle)).not.toContain(projectDir)
  })

  test("copies attachments into the export when bundle mode is selected", async () => {
    const viewerDistDir = await createViewerDist()
    const projectDir = await createTempDir("memosync-project-")
    const uploadsDir = path.join(projectDir, ".memosync", "uploads")
    await mkdir(uploadsDir, { recursive: true })
    const attachmentPath = path.join(uploadsDir, "mock.png")
    await writeFile(attachmentPath, "mock", "utf8")

    const result = await writeStandaloneTranscriptExport({
      chatId: "chat-1",
      title: "Release Review",
      localPath: projectDir,
      theme: "light",
      attachmentMode: "bundle",
      messages: createMessages(attachmentPath),
    }, {
      viewerDistDir,
      now: new Date("2026-04-23T12:34:56.000Z"),
    })

    expect(result.ok).toBe(true)
    expect(result.totalAttachmentCount).toBe(1)
    expect(result.bundledAttachmentCount).toBe(1)

    const bundle = await Bun.file(result.transcriptJsonPath).json()
    const exportedAttachment = bundle.messages[0].attachments[0]
    expect(bundle.viewerVersion).toBeDefined()
    expect(exportedAttachment.contentUrl).toStartWith("./attachments/")
    expect(exportedAttachment.absolutePath).toStartWith("./attachments/")
    expect(exportedAttachment.relativePath).toStartWith("./attachments/")
    expect(await Bun.file(path.join(result.outputDir, exportedAttachment.contentUrl.replace(/^\.\//u, ""))).text()).toBe("mock")
  })

})
