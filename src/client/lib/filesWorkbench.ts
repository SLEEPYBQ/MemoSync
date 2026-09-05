// Pure helpers for the Files workbench panel (tree, tabs, filter). Kept
// UI-free so they can be unit-tested directly.

export function baseName(relPath: string): string {
  const i = relPath.lastIndexOf("/")
  return i >= 0 ? relPath.slice(i + 1) : relPath
}

export function dirName(relPath: string): string {
  const i = relPath.lastIndexOf("/")
  return i >= 0 ? relPath.slice(0, i) : ""
}

/**
 * Filter the recursive file index with a quick-open style query. Every
 * whitespace-separated token must appear as a case-insensitive substring of
 * the path. Results are ranked: basename prefix &lt; basename substring &lt;
 * path-only match, ties kept in index (alphabetical) order.
 */
export function filterIndexPaths(index: string[], query: string, limit = 200): string[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return []
  const ranked: Array<{ path: string; rank: number }> = []
  for (const p of index) {
    const lower = p.toLowerCase()
    if (!tokens.every((t) => lower.includes(t))) continue
    const base = baseName(lower)
    const first = tokens[0]
    const rank = base.startsWith(first) ? 0 : base.includes(first) ? 1 : 2
    ranked.push({ path: p, rank })
    // Collect generously, then sort+trim, so better-ranked late matches are
    // not lost — but bail once far past the limit to bound work.
    if (ranked.length >= limit * 5) break
  }
  return ranked
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map((r) => r.path)
}

/** The tab to activate after closing `closing`, mirroring editor conventions:
 * keep the current tab unless it is the one closing; then prefer the right
 * neighbour, else the left, else none. */
export function nextActiveTab(tabs: string[], closing: string, active: string | null): string | null {
  if (active !== closing) return active
  const i = tabs.indexOf(closing)
  if (i === -1) return active
  const remaining = tabs.filter((t) => t !== closing)
  if (remaining.length === 0) return null
  return remaining[Math.min(i, remaining.length - 1)]
}

/** Ancestor directories of a path, shallowest first ("a/b/c.ts" → ["a", "a/b"]). */
export function ancestorDirs(relPath: string): string[] {
  const parts = relPath.split("/")
  const dirs: string[] = []
  for (let i = 1; i < parts.length; i++) dirs.push(parts.slice(0, i).join("/"))
  return dirs
}

/** Rewrite a path after `from` was renamed to `to` (covers the path itself and
 * anything under it when a directory moved); unrelated paths pass through. */
export function remapPathAfterRename(p: string, from: string, to: string): string {
  if (p === from) return to
  if (p.startsWith(`${from}/`)) return to + p.slice(from.length)
  return p
}

/** Whether `p` is `target` or lives under it (used when a directory is deleted). */
export function isSameOrUnder(p: string, target: string): boolean {
  return p === target || p.startsWith(`${target}/`)
}
