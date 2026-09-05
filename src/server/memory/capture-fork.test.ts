import { describe, expect, test } from "bun:test"
import { AUTO_CAPTURE_SYSTEM } from "./capture"
import { buildForkCapturePrompt } from "./capture-fork"

describe("finished-session capture fork", () => {
  test("Auto reuses the same broad extraction contract as the sidecar fallback", () => {
    const prompt = buildForkCapturePrompt("auto-project-copy")

    expect(prompt).toContain(AUTO_CAPTURE_SYSTEM)
    expect(prompt).toContain("ordinary task work often produces useful memory")
    expect(prompt).toContain("return an empty array when there is nothing useful to preserve")
    expect(prompt).toContain("0 to 4 total memory operations")
    expect(prompt).toContain("reinforcements of existing memories")
    expect(prompt).toContain("at most 100 words")
    expect(prompt).not.toContain("at most 160 characters")
  })

  test("MemoSync retains the durable precision-first fork contract", () => {
    const prompt = buildForkCapturePrompt("review")

    expect(prompt).toContain("likely to matter again in a future session")
    expect(prompt).toContain("Returning no candidates is fine")
    expect(prompt).toContain("at most 100 words")
    expect(prompt).not.toContain(AUTO_CAPTURE_SYSTEM)
  })
})
