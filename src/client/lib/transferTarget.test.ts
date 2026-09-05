import { describe, expect, test } from "bun:test"

import { defaultTransferScope, transferScopeDisabled } from "./transferTarget"

describe("defaultTransferScope", () => {
  test("personal memories default to project — personal → personal is a no-op", () => {
    expect(defaultTransferScope("personal")).toBe("project")
  })

  test("project memories default to personal", () => {
    expect(defaultTransferScope("project")).toBe("personal")
  })

  test("session memories default to personal", () => {
    expect(defaultTransferScope("session")).toBe("personal")
  })
})

describe("transferScopeDisabled", () => {
  test("personal target is disabled for personal memories", () => {
    expect(transferScopeDisabled("personal", "personal")).toBe(true)
  })

  test("personal target stays enabled for project and session memories", () => {
    expect(transferScopeDisabled("project", "personal")).toBe(false)
    expect(transferScopeDisabled("session", "personal")).toBe(false)
  })

  test("project target is always enabled — cross-project transfer is legal", () => {
    expect(transferScopeDisabled("personal", "project")).toBe(false)
    expect(transferScopeDisabled("project", "project")).toBe(false)
    expect(transferScopeDisabled("session", "project")).toBe(false)
  })
})
