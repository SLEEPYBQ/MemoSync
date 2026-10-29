import { expect, test } from "bun:test"
import { generateUUID } from "./utils"

test("upload temporary ids work when insecure HTTP hides crypto.randomUUID", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto")
  try {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: {} })
    const ids = Array.from({ length: 100 }, generateUUID)
    expect(ids.every(id => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  } finally {
    if (original) Object.defineProperty(globalThis, "crypto", original)
    else Reflect.deleteProperty(globalThis, "crypto")
  }
})
