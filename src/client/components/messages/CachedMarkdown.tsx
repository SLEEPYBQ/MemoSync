import type { ReactElement } from "react"
import Markdown, { defaultUrlTransform } from "react-markdown"
import remarkGfm from "remark-gfm"
import { MEMORY_CITATION_SCHEME } from "../../lib/memoryCitations"
import { markdownComponentsWithLinks } from "./shared"

export function urlTransform(url: string): string {
  return url.startsWith(MEMORY_CITATION_SCHEME) ? url : defaultUrlTransform(url)
}

export function createMarkdownRenderCache({ maxEntries = 256, maxCharacters = 512 * 1024 } = {}) {
  // Cache immutable element trees, never HTML or resolved memory data. Link
  // components still read live context/stores (citations, interrupts, locale).
  // react-markdown's synchronous renderer has no hooks; it returns this tree.
  const entries = new Map<string, { tree: ReactElement; characters: number }>()
  let characters = 0
  return (text: string, memoryLinks = false) => {
    const key = `${memoryLinks ? "memory" : "plain"}:${text}`
    const cached = entries.get(key)
    if (cached) {
      entries.delete(key)
      entries.set(key, cached)
      return cached.tree
    }
    const tree = Markdown({
      children: text, remarkPlugins: [remarkGfm], components: markdownComponentsWithLinks,
      urlTransform: memoryLinks ? urlTransform : defaultUrlTransform,
    })
    if (maxEntries <= 0 || text.length > maxCharacters) return tree
    entries.set(key, { tree, characters: text.length })
    characters += text.length
    while (entries.size > maxEntries || characters > maxCharacters) {
      const oldest = entries.keys().next().value!
      characters -= entries.get(oldest)!.characters
      entries.delete(oldest)
    }
    return tree
  }
}
const renderMarkdown = createMarkdownRenderCache()
export function CachedMarkdown({ children, memoryLinks = false }: { children: string; memoryLinks?: boolean }) {
  return renderMarkdown(children, memoryLinks)
}
