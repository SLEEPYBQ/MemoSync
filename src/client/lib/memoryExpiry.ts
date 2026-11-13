import type { MemoryItem } from "./memoriesApi"

export function localDateValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function localEndOfDay(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
  const date = new Date(year, month - 1, day, 23, 59, 59, 999)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
  return date.toISOString()
}

export function relativeExpiry(days: number, now = new Date()): string {
  if (days === 0) {
    const date = new Date(now)
    date.setHours(23, 59, 59, 999)
    return date.toISOString()
  }
  return new Date(now.getTime() + days * 86400000).toISOString()
}

export function isPastExpiry(value?: string | null, now = Date.now()): boolean {
  return Boolean(value && Number.isFinite(Date.parse(value)) && Date.parse(value) <= now)
}

export function expiryDaysLeft(value?: string | null, now = Date.now()): number | null {
  if (!value) return null
  const difference = Date.parse(value) - now
  return Number.isFinite(difference) && difference > 0 ? Math.ceil(difference / 86400000) : null
}

export function isExpiringSoon(item: Pick<MemoryItem, "status" | "expiresAt">, now = Date.now()): boolean {
  if (item.status !== "active" || !item.expiresAt) return false
  const remaining = Date.parse(item.expiresAt) - now
  return remaining > 0 && remaining <= 7 * 86400000
}
