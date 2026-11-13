import { expect, test } from "bun:test"
import { expiryDaysLeft, isExpiringSoon, isPastExpiry, localDateValue, localEndOfDay, relativeExpiry } from "./memoryExpiry"
import { memoryMatchesLens } from "../components/memory/MemoryExplorer"
import type { MemoryItem } from "./memoriesApi"

test("custom dates use the end of the local calendar day", () => {
  const value = localEndOfDay("2030-03-11")!
  const date = new Date(value)
  expect(localDateValue(date)).toBe("2030-03-11")
  expect([date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds()]).toEqual([23, 59, 59, 999])
  expect(localEndOfDay("2030-02-30")).toBeNull()
})

test("relative expiry and expiring lens respect future and active status", () => {
  const now = new Date(2030, 2, 10, 12)
  expect(new Date(relativeExpiry(7, now)).getDate()).toBe(17)
  const soon = relativeExpiry(6, now)
  expect(expiryDaysLeft(soon, now.getTime())).toBe(6)
  expect(isExpiringSoon({ status: "active", expiresAt: soon }, now.getTime())).toBe(true)
  expect(isExpiringSoon({ status: "archived", expiresAt: soon }, now.getTime())).toBe(false)
  expect(isPastExpiry(soon, now.getTime())).toBe(false)
  expect(isPastExpiry(soon, now.getTime() + 7 * 86400000)).toBe(true)
})

test("relative presets span exact elapsed days across daylight saving transitions", () => {
  const previousTimezone = process.env.TZ
  try {
    process.env.TZ = "America/Los_Angeles"
    for (const input of ["2026-10-30T12:00:00-07:00", "2026-03-06T12:00:00-08:00"]) {
      const now = new Date(input)
      const today = new Date(relativeExpiry(0, now))
      expect(localDateValue(today)).toBe(localDateValue(now))
      expect([today.getHours(), today.getMinutes(), today.getSeconds(), today.getMilliseconds()]).toEqual([23, 59, 59, 999])
      for (const days of [7, 30]) {
        const expiry = relativeExpiry(days, now)
        expect(Date.parse(expiry) - now.getTime()).toBe(days * 86400000)
        expect(expiryDaysLeft(expiry, now.getTime())).toBe(days)
        expect(isExpiringSoon({ status: "active", expiresAt: expiry }, now.getTime())).toBe(days === 7)
      }
    }
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ
    else process.env.TZ = previousTimezone
  }
})

test("expiring lens shows only active memories due in the next week", () => {
  const item = { status: "active", expiresAt: new Date(Date.now() + 86400000).toISOString() } as MemoryItem
  expect(memoryMatchesLens(item, { kind: "expiring" })).toBe(true)
  expect(memoryMatchesLens({ ...item, status: "archived" }, { kind: "expiring" })).toBe(false)
  expect(memoryMatchesLens({ ...item, expiresAt: null }, { kind: "expiring" })).toBe(false)
})
