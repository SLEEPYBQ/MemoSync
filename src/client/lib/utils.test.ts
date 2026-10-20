import { describe, expect, test } from "bun:test"
import { generateUUID } from "./utils"

describe("generateUUID", () => {
  test("uses crypto randomness when randomUUID is unavailable on HTTP", () => {
    const originalCrypto = globalThis.crypto
    Object.defineProperty(globalThis, "crypto", {
      value: {
        getRandomValues: (bytes: Uint8Array) => bytes.forEach((_, index) => { bytes[index] = index }),
      },
      configurable: true,
      writable: true,
    })
    try {
      expect(generateUUID()).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f")
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: originalCrypto, configurable: true, writable: true })
    }
  })
})
