// Turn [M-NN] tokens in assistant text into clickable citation chips, reusing
// the markdown renderer's existing custom-link-scheme pattern (like the app's
// local-file links). Step 1: rewrite [M-07] -> a markdown link with a private
// scheme; step 2: the markdown `a` component detects the scheme and renders a
// chip instead of an anchor.
import type { MemoryScope } from "./memoriesApi"

export const MEMORY_CITATION_SCHEME = "memosync-memory:"

const CITATION_RE = /\[(M-\d+)\]/g

/** Rewrite [M-NN] citations into markdown links with the private scheme. */
export function linkifyMemoryCitations(text: string): string {
  if (!text) return text
  // Skip [M-NN] inside fenced or inline code: the code is shown verbatim, and a
  // markdown link injected there would leak as literal "[M-07](memosync-memory:…)"
  // (BUG MSG-9). String.split with a capturing group puts the code segments at
  // odd indices; only rewrite the prose (even indices) between them.
  const CODE_SEGMENT = /(```[\s\S]*?```|`[^`\n]*`)/g
  return text
    .split(CODE_SEGMENT)
    .map((segment, index) =>
      index % 2 === 1
        ? segment
        : segment.replace(CITATION_RE, (full, id) => `[${full}](${MEMORY_CITATION_SCHEME}${id})`),
    )
    .join("")
}

/** If `href` is a memory-citation link, return the memory id; else null. */
export function parseMemoryCitationHref(href?: string): string | null {
  if (!href || !href.startsWith(MEMORY_CITATION_SCHEME)) return null
  const id = href.slice(MEMORY_CITATION_SCHEME.length)
  return /^M-\d+$/.test(id) ? id : null
}

/** Type guard for an arbitrary (server-supplied) scope string. */
export function isMemoryScope(value: string): value is MemoryScope {
  return value === "personal" || value === "project" || value === "session"
}

/** Human label for a scope, used in the citation hover card and trace rows. */
export function memoryScopeLabel(scope: string): string {
  switch (scope) {
    case "personal":
      return "Personal"
    case "project":
      return "Project"
    case "session":
      return "Session"
    default:
      return scope
  }
}

// Full literal class strings per scope (Tailwind's scanner needs the whole
// class name to appear verbatim in source — it can't see `border-${scope}-border`).
export const MEMORY_SCOPE_CHIP_CLASSES: Record<MemoryScope, string> = {
  personal: "border-personal-border bg-personal-surface text-personal-fg",
  project: "border-project-border bg-project-surface text-project-fg",
  session: "border-session-border bg-session-surface text-session-fg",
}

export const MEMORY_SCOPE_TEXT_CLASSES: Record<MemoryScope, string> = {
  personal: "text-personal-fg",
  project: "text-project-fg",
  session: "text-session-fg",
}

export const MEMORY_SCOPE_SELECTED_CLASSES: Record<MemoryScope, string> = {
  personal: "bg-personal-surface text-personal-fg",
  project: "bg-project-surface text-project-fg",
  session: "bg-session-surface text-session-fg",
}
