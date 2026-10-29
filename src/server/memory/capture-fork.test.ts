import { describe, expect, test } from "bun:test";
import { buildForkCapturePrompt } from "./capture-fork";

describe("finished-session capture fork", () => {
  test("MemoSync retains the durable precision-first fork contract", () => {
    const prompt = buildForkCapturePrompt()

    expect(prompt).toContain("likely to matter again in a future session")
    expect(prompt).toContain("Returning no candidates is fine")
    expect(prompt).toContain("at most 100 words")
  })
})
