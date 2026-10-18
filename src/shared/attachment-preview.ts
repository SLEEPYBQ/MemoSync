import type { ChatAttachment } from "./types"

export const TEXT_PREVIEW_LIMIT_BYTES = 1024 * 1024
export const JSON_PREVIEW_LIMIT_BYTES = 256 * 1024

export const CODE_OR_CONFIG_EXTENSIONS = new Set([
  ".c", ".cc", ".cfg", ".conf", ".cpp", ".cs", ".css", ".env", ".go", ".graphql", ".h", ".hpp", ".html",
  ".ini", ".java", ".js", ".jsonc", ".jsx", ".kt", ".lua", ".mjs", ".php", ".pl", ".properties", ".py",
  ".rb", ".rs", ".scss", ".sh", ".sql", ".swift", ".toml", ".ts", ".tsx", ".txt", ".vue", ".xml", ".yaml",
  ".yml", ".zsh",
])

export type AttachmentPreviewKind =
  | "image"
  | "pdf"
  | "markdown"
  | "text"
  | "json"
  | "table"
  | "external"

export interface AttachmentPreviewTarget {
  kind: AttachmentPreviewKind
  openInNewTab: boolean
}

export interface TextPreviewResult {
  content: string
  truncated: boolean
}

export function normalizeAttachmentMimeType(mimeType: string): string {
  return mimeType.split(";", 1)[0]!.trim().toLowerCase()
}

export function classifyAttachmentPreview(attachment: ChatAttachment): AttachmentPreviewTarget {
  const mimeType = normalizeAttachmentMimeType(attachment.mimeType)
  const extension = getFileExtension(attachment.displayName)

  if (mimeType.startsWith("image/")) {
    return { kind: "image", openInNewTab: false }
  }
  if (mimeType === "application/pdf") {
    return { kind: "pdf", openInNewTab: false }
  }
  if (mimeType === "application/json") {
    return attachment.size <= JSON_PREVIEW_LIMIT_BYTES
      ? { kind: "json", openInNewTab: false }
      : { kind: "external", openInNewTab: true }
  }
  if (extension === ".md") {
    return { kind: "markdown", openInNewTab: false }
  }
  if (mimeType === "text/csv" || mimeType === "text/tab-separated-values") {
    return { kind: "table", openInNewTab: false }
  }
  if (mimeType.startsWith("text/")) {
    return { kind: "text", openInNewTab: false }
  }
  if (CODE_OR_CONFIG_EXTENSIONS.has(extension)) {
    return { kind: "text", openInNewTab: false }
  }
  return { kind: "external", openInNewTab: true }
}

export function getFileExtension(fileName: string) {
  const index = fileName.lastIndexOf(".")
  return index >= 0 ? fileName.slice(index).toLowerCase() : ""
}
