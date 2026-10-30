import { describe, expect, test } from "bun:test"
import { describeServerUiText, uiJson, SERVER_UI_COPY, type UiCopyCode } from "./ui-copy"

describe("server UI codes", () => {
  test("extracts parameters and preserves opaque filenames", () => {
    expect(describeServerUiText('File "账户-<x>.txt" exceeds the 20 MB limit.')).toEqual({ code: "uploadFileSize", params: { v0: "账户-<x>.txt", v1: "20" } })
    expect(describeServerUiText("memory not found: M-01")).toEqual({ code: "memoryNotFound", params: { v0: "M-01" } })
  })
  test("keeps raw exception text untouched", () => {
    expect(describeServerUiText("ENOENT: failed to open /private/tmp/example")).toBeUndefined()
  })
  test("all fallback templates resolve to stable codes", () => {
    for (const [code, template] of Object.entries(SERVER_UI_COPY)) {
      const message = template.replace(/{{v\d+}}/g, "example")
      // Some exact validation copy also matches the generic required-fields rule;
      // prefer the exact code to keep product errors distinct.
      expect(describeServerUiText(message)?.code).toBe(code as UiCopyCode)
    }
  })
  test("HTTP envelopes retain diagnostic text and expose code + params", async () => {
    const response = uiJson({ error: { code: "NOT_FOUND", message: "memory not found: M-01" } }, { status: 404 })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: { code: "NOT_FOUND", message: "memory not found: M-01", uiText: { code: "memoryNotFound", params: { v0: "M-01" } } } })
  })
})
