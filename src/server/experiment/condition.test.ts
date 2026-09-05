import { describe, expect, test } from "bun:test"
import { resolveConditionPolicy } from "./condition"

describe("resolveConditionPolicy", () => {
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

  test("auto: silent capture, plain-list injection, no tools, no surfaces", () => {
    const p = resolveConditionPolicy("auto")
    expect(p.capture).toBe("silent")
    expect(p.preview).toBe(false)
    expect(p.trace).toBe(false)
    expect(p.boardVisible).toBe(false)
    expect(p.boardWritable).toBe(false)
    expect(p.bringIn).toBe(false)
    expect(p.injection).toBe("plain")
    expect(p.memoryTools).toBe(false)
  })

  test("static: capture off, workspace-file injection, no tools, nothing user-facing", () => {
    const p = resolveConditionPolicy("static")
    expect(p.capture).toBe("off")
    expect(p.preview).toBe(false)
    expect(p.trace).toBe(false)
    expect(p.boardVisible).toBe(false)
    expect(p.boardWritable).toBe(false)
    expect(p.bringIn).toBe(false)
    expect(p.injection).toBe("file")
    expect(p.memoryTools).toBe(false)
  })

  test("unknown value falls back to memosync", () => {
    expect(resolveConditionPolicy("weird").condition).toBe("memosync")
  })

  // studyMode = the researcher explicitly pinned an arm. It narrows the Claude
  // SDK settingSources to ["user"] so a workspace CLAUDE.md cannot bypass the
  // system's injection channel — required in EVERY arm for a controlled study.
  test("studyMode is true only when EXPERIMENT_CONDITION is an explicit valid arm", () => {
    expect(resolveConditionPolicy("memosync").studyMode).toBe(true)
    expect(resolveConditionPolicy("auto").studyMode).toBe(true)
    expect(resolveConditionPolicy("static").studyMode).toBe(true)
    expect(resolveConditionPolicy(undefined).studyMode).toBe(false)
    expect(resolveConditionPolicy("weird").studyMode).toBe(false)
  })
})
