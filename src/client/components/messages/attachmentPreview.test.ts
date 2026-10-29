import { describe, expect, test } from "bun:test"
import type { ChatAttachment } from "../../../shared/types"
import {
  JSON_PREVIEW_LIMIT_BYTES,
  classifyAttachmentIcon,
  classifyAttachmentPreview,
  parseDelimitedPreview,
  prettifyJson,
} from "./attachmentPreview"

function makeAttachment(overrides: Partial<ChatAttachment>): ChatAttachment {
  return {
    id: "attachment-1",
    kind: "file",
    displayName: "file.txt",
    absolutePath: "/tmp/project/.kanna/uploads/file.txt",
    relativePath: "./.kanna/uploads/file.txt",
    contentUrl: "/api/projects/project-1/uploads/file.txt/content",
    mimeType: "text/plain",
    size: 128,
    ...overrides,
  }
}

describe("classifyAttachmentPreview", () => {
  for (const [mimeType, kind] of [
    ["application/json; charset=utf-8", "json"],
    [" Application/JSON ; Charset=UTF-8 ", "json"],
    ["text/csv; charset=utf-8", "table"],
    ["text/tab-separated-values; charset=utf-8", "table"],
    ["application/pdf; version=1.7", "pdf"],
  ] as const) {
    test(`normalizes parameterized MIME type ${mimeType}`, () => {
      const attachment = makeAttachment({ displayName: "data", mimeType })
      expect(classifyAttachmentPreview(attachment)).toEqual({ kind, openInNewTab: false })
      expect(classifyAttachmentIcon(attachment)).toBe(kind)
    })
  }

  test("keeps the JSON size limit for parameterized MIME types", () => {
    expect(classifyAttachmentPreview(makeAttachment({
      displayName: "data.json",
      mimeType: "application/json; charset=utf-8",
      size: JSON_PREVIEW_LIMIT_BYTES + 1,
    }))).toEqual({ kind: "external", openInNewTab: true })
  })

  test("routes oversized json directly to a new tab", () => {
    const target = classifyAttachmentPreview(makeAttachment({
      displayName: "data.json",
      mimeType: "application/json",
      size: JSON_PREVIEW_LIMIT_BYTES + 1,
    }))

    expect(target.kind).toBe("external")
    expect(target.openInNewTab).toBe(true)
  })

  test("keeps markdown files in the modal preview flow", () => {
    const target = classifyAttachmentPreview(makeAttachment({
      displayName: "README.md",
      mimeType: "application/octet-stream",
    }))

    expect(target.kind).toBe("markdown")
    expect(target.openInNewTab).toBe(false)
  })

  test("treats code extensions as text previews", () => {
    const target = classifyAttachmentPreview(makeAttachment({
      displayName: "app.tsx",
      mimeType: "application/octet-stream",
    }))

    expect(target.kind).toBe("text")
    expect(target.openInNewTab).toBe(false)
  })
})

describe("parseDelimitedPreview", () => {
  test("parses quoted csv cells correctly", () => {
    const result = parseDelimitedPreview("name,notes\njake,\"a,b,c\"", ",")

    expect(result.rows).toEqual([
      ["name", "notes"],
      ["jake", "a,b,c"],
    ])
  })
})

describe("prettifyJson", () => {
  test("formats valid json", () => {
    expect(prettifyJson("{\"a\":1}")).toContain("\n  \"a\": 1\n")
  })
})

describe("classifyAttachmentIcon", () => {
  test("uses specific icons for markdown, json, table, code, and archives", () => {
    expect(classifyAttachmentIcon(makeAttachment({ displayName: "paper.pdf", mimeType: "application/pdf" }))).toBe("pdf")
    expect(classifyAttachmentIcon(makeAttachment({ displayName: "README.md", mimeType: "text/markdown" }))).toBe("markdown")
    expect(classifyAttachmentIcon(makeAttachment({ displayName: "data.json", mimeType: "application/json" }))).toBe("json")
    expect(classifyAttachmentIcon(makeAttachment({ displayName: "people.csv", mimeType: "text/csv" }))).toBe("table")
    expect(classifyAttachmentIcon(makeAttachment({ displayName: "app.tsx", mimeType: "application/octet-stream" }))).toBe("code")
    expect(classifyAttachmentIcon(makeAttachment({ displayName: "bundle.zip", mimeType: "application/zip" }))).toBe("archive")
  })
})
