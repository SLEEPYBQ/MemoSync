// How to preview a workspace file in the Files side panel, by file name.
export type FilePreviewKind = "markdown" | "image" | "pdf" | "text" | "binary"

const MARKDOWN = new Set(["md", "markdown", "mdx"])
const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico", "bmp"])
const TEXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "jsonc", "css", "scss", "html", "htm",
  "txt", "yml", "yaml", "toml", "sh", "bash", "zsh", "py", "rs", "go", "java", "kt",
  "c", "cc", "cpp", "h", "hpp", "rb", "sql", "xml", "csv", "tsv", "log", "ini", "cfg",
  "conf", "env", "lock", "tex", "bib", "diff", "patch", "gitignore", "dockerignore",
  "editorconfig", "prettierrc", "eslintrc", "example",
])

/** Files whose whole name (no extension) marks them as text. */
const TEXT_BASENAMES = new Set(["dockerfile", "makefile", "license", "readme", "changelog", "codeowners", "procfile"])

export function classifyFilePreview(name: string): FilePreviewKind {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf(".")
  // ".gitignore" → ext "gitignore"; "LICENSE" → no extension.
  const ext = dot >= 0 ? lower.slice(dot + 1) : ""
  if (MARKDOWN.has(ext)) return "markdown"
  if (ext === "pdf") return "pdf"
  if (IMAGE.has(ext)) return "image"
  if (TEXT.has(ext)) return "text"
  if (!ext || dot === -1) return TEXT_BASENAMES.has(lower) ? "text" : "binary"
  return "binary"
}
