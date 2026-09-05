import { describe, expect, test } from "bun:test"
import { classifyFilePreview } from "./filePreview"

describe("classifyFilePreview", () => {
  test("markdown files", () => {
    expect(classifyFilePreview("README.md")).toBe("markdown")
    expect(classifyFilePreview("notes.markdown")).toBe("markdown")
    expect(classifyFilePreview("DOCS.MD")).toBe("markdown")
  })

  test("pdf files", () => {
    expect(classifyFilePreview("paper.pdf")).toBe("pdf")
  })

  test("images", () => {
    expect(classifyFilePreview("shot.png")).toBe("image")
    expect(classifyFilePreview("photo.JPG")).toBe("image")
    expect(classifyFilePreview("icon.svg")).toBe("image")
    expect(classifyFilePreview("anim.gif")).toBe("image")
    expect(classifyFilePreview("pic.webp")).toBe("image")
  })

  test("code and plain text", () => {
    expect(classifyFilePreview("index.ts")).toBe("text")
    expect(classifyFilePreview("app.tsx")).toBe("text")
    expect(classifyFilePreview("config.json")).toBe("text")
    expect(classifyFilePreview("style.css")).toBe("text")
    expect(classifyFilePreview("notes.txt")).toBe("text")
    expect(classifyFilePreview("compose.yaml")).toBe("text")
    expect(classifyFilePreview("script.py")).toBe("text")
  })

  test("extensionless well-known files are text", () => {
    expect(classifyFilePreview("Dockerfile")).toBe("text")
    expect(classifyFilePreview("Makefile")).toBe("text")
    expect(classifyFilePreview("LICENSE")).toBe("text")
    expect(classifyFilePreview(".gitignore")).toBe("text")
    expect(classifyFilePreview(".env")).toBe("text")
  })

  test("unknown extensions are binary", () => {
    expect(classifyFilePreview("data.sqlite")).toBe("binary")
    expect(classifyFilePreview("bundle.zip")).toBe("binary")
    expect(classifyFilePreview("font.woff2")).toBe("binary")
  })
})
