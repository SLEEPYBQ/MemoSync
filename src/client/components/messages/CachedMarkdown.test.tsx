import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { createMarkdownRenderCache } from "./CachedMarkdown"

test("renders Windows drive links as local files while rejecting executable URI schemes", () => {
  const render = createMarkdownRenderCache()
  for (const memoryLinks of [false, true]) {
    const html = renderToStaticMarkup(render('[source](<C:/Projects/with spaces/app.ts#L4>)', memoryLinks))
    expect(html).toContain('href="C:/Projects/with%20spaces/app.ts#L4"')
    expect(html).not.toContain('target="_blank"')
    expect(renderToStaticMarkup(render('[bad](javascript:alert%281%29)', memoryLinks))).not.toContain('href="javascript:')
  }
})

test("reuses rendered markdown by text across entries", () => {
  const render = createMarkdownRenderCache()
  const first = render("**shared** [file](src/app.ts)")
  expect(render("**shared** [file](src/app.ts)")).toBe(first)
  expect(renderToStaticMarkup(first)).toContain("<strong>shared</strong>")
})
test("evicts least recently used text and retains recently read text", () => {
  const render = createMarkdownRenderCache({ maxEntries: 2 })
  const a = render("a"), b = render("b")
  expect(render("a")).toBe(a)
  render("c")
  expect(render("a")).toBe(a)
  expect(render("b")).not.toBe(b)
})
test("bounds retained source characters and bypasses oversized markdown", () => {
  const render = createMarkdownRenderCache({ maxCharacters: 10 })
  const first = render("123456")
  expect(render("123456")).toBe(first)
  render("abcdef")
  expect(render("123456")).not.toBe(first)
  expect(render("x".repeat(11))).not.toBe(render("x".repeat(11)))
})
