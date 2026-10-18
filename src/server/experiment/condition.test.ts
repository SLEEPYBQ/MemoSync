import { describe, expect, spyOn, test } from "bun:test";
import { resolveConditionPolicy } from "./condition";

describe("resolveConditionPolicy", () => {
  test("warns when a retired or unknown condition falls back to MemoSync", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      for (const condition of ["static", "auto", "unknown"]) {
        expect(resolveConditionPolicy(condition).condition).toBe("memosync")
        expect(warn).toHaveBeenLastCalledWith(
          `[experiment] unsupported EXPERIMENT_CONDITION "${condition}" — using MemoSync`,
        )
      }
      expect(warn).toHaveBeenCalledTimes(3)
    } finally {
      warn.mockRestore()
    }
  })

  test("memosync (default): everything on, capture surfaces review cards", () => {
    const p = resolveConditionPolicy(undefined)
    expect(p.condition).toBe("memosync")
    expect(p.capture).toBe("review")
    expect(p.preview).toBe(true)
    expect(p.trace).toBe(true)
    expect(p.boardVisible).toBe(true)
    expect(p.boardWritable).toBe(true)
    expect(p.bringIn).toBe(true)
    expect(p.injection).toBe("skills")
    expect(p.memoryTools).toBe(true)
  })

  test("only an explicit MemoSync condition enables study mode", () => {
    for (const value of ["", "static", "auto", "unknown"]) {
      const p = resolveConditionPolicy(value)
      expect(p.condition).toBe("memosync")
      expect(p.capture).toBe("review")
      expect(p.injection).toBe("skills")
      expect(p.preview).toBe(true)
      expect(p.trace).toBe(true)
      expect(p.boardVisible).toBe(true)
      expect(p.boardWritable).toBe(true)
      expect(p.bringIn).toBe(true)
      expect(p.memoryTools).toBe(true)
      expect(p.studyMode).toBe(false)
    }
    expect(resolveConditionPolicy("memosync").studyMode).toBe(true)
  })
})
