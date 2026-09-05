/**
 * Canonical participant-editable Static memory Markdown paths.
 *
 * Paths are repository-relative, normalized POSIX paths. Backslashes,
 * absolute paths, empty/dot segments and traversal are rejected rather than
 * normalized into a different authority target. Matching is case-sensitive.
 */
export function isStaticMemoryMarkdownPath(value: string): boolean {
  if (!value || value.startsWith("/") || value.includes("\\")) return false
  const segments = value.split("/")
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return false
  if (value === "MEMORY.md") return true
  return segments[0] === "memory"
    && segments.length >= 2
    && segments[segments.length - 1]!.endsWith(".md")
}
