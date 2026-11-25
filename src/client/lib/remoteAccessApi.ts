// Client data layer for the remote-access HTTP API. Same-origin relative
// fetch, authenticated by the session cookie (or open on loopback when no
// password is set) — the same convention as workspaceApi.ts. Responses are
// direct JSON (no { data } envelope); the contract lives in
// REMOTE_ACCESS_SPEC.md.
import { t } from "../i18n"
import type { AppSettingsPatch, AppSettingsSnapshot } from "../../shared/types"
import { notifyIfUnauthorized } from "./authGuard"

export interface RemoteAccessStatus {
  enabled: boolean
  /** False while the server still needs a restart to (un)bind the LAN socket. */
  active: boolean
  /** Actual process bind, included so launch-override copy can name it. */
  bindHost?: string
  /** True when startup supplied --host/HOST, which keeps overriding the toggle after restarts. */
  bindControlledExternally?: boolean
  lanUrls: string[]
}

export interface PairingRequestEntry {
  id: string
  deviceName: string
  code: string
  createdAt: string | number
  expiresAt: string | number
}

export interface PairedDevice {
  id: string
  name: string
  createdAt: string | number
  lastSeenAt: string | number | null
  revokedAt?: string | number | null
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { cache: "no-store", ...init })
  notifyIfUnauthorized(res)
  if (!res.ok) throw new Error(t("errors:requestFailedValue0", { v0: res.status }))
  return (await res.json()) as T
}

function post(path: string): Promise<unknown> {
  return fetchJson(path, { method: "POST" })
}

export const remoteAccessApi = {
  status: () => fetchJson<RemoteAccessStatus>("/api/remote-access/status"),
  pendingRequests: () => fetchJson<{ requests: PairingRequestEntry[] }>("/api/pairing/pending"),
  approveRequest: (id: string) => post(`/api/pairing/requests/${encodeURIComponent(id)}/approve`),
  denyRequest: (id: string) => post(`/api/pairing/requests/${encodeURIComponent(id)}/deny`),
  devices: () => fetchJson<{ devices: PairedDevice[] }>("/api/devices"),
  revokeDevice: (id: string) => post(`/api/devices/${encodeURIComponent(id)}/revoke`),
}

export interface RemoteAccessOverview {
  status: RemoteAccessStatus
  pendingRequests: PairingRequestEntry[]
  devices: PairedDevice[]
}

/** One coherent settings-section read: bind state, approval queue, and the
 * device list can all change in another window or after a restart. */
export async function fetchRemoteAccessOverview(): Promise<RemoteAccessOverview> {
  const [status, pending, devices] = await Promise.all([
    remoteAccessApi.status(),
    remoteAccessApi.pendingRequests(),
    remoteAccessApi.devices(),
  ])
  return {
    status,
    pendingRequests: pending.requests,
    devices: devices.devices,
  }
}

/** The settings patch written by the toggle, matching the frozen ws contract. */
export function buildRemoteAccessPatch(enabled: boolean): AppSettingsPatch {
  return { remoteAccess: { enabled } }
}

/** Reads the toggle state from the settings snapshot; defaults to off (opt-in). */
export function readRemoteAccessEnabled(settings: AppSettingsSnapshot | null | undefined): boolean {
  // Optional chaining on a required key: an older server's snapshot may lack it.
  return settings?.remoteAccess?.enabled === true
}

/**
 * Builds the pairing URL encoded in the QR code from the server's LAN URLs:
 * `memosync://pair?host=<first-lan-ip>&port=<port>`. Returns null when no
 * usable LAN URL exists (nothing meaningful to scan then).
 */
export function buildPairingUrl(lanUrls: readonly string[]): { pairingUrl: string; lanUrl: string } | null {
  const first = lanUrls[0]
  if (!first) return null
  try {
    const url = new URL(first)
    if (!url.hostname) return null
    const port = url.port || (url.protocol === "https:" ? "443" : "80")
    return {
      pairingUrl: `memosync://pair?host=${encodeURIComponent(url.hostname)}&port=${encodeURIComponent(port)}`,
      lanUrl: first,
    }
  } catch {
    return null
  }
}

/** Display form of a pairing code: uppercase alphanumeric, grouped XXXX-XXXX-XXXX. */
export function formatPairingCode(code: string): string {
  const normalized = code.replace(/[^a-zA-Z0-9]/g, "").toUpperCase()
  const groups: string[] = []
  for (let index = 0; index < normalized.length; index += 4) {
    groups.push(normalized.slice(index, index + 4))
  }
  return groups.join("-")
}

/** Accepts ISO strings or epoch milliseconds; returns epoch ms or null. */
export function parseTimeMs(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

/** m:ss countdown, clamped at zero — an expired entry disappears on the next poll. */
export function formatPairingCountdown(msRemaining: number): string {
  const totalSeconds = Math.max(0, Math.ceil(msRemaining / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, "0")}`
}
