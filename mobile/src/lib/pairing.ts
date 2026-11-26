import type {
  PairingRequestResponse,
  PairingStatusResponse,
} from "../types"

/**
 * Pairing REST client for the frozen pairing contract:
 *
 *   POST /api/pairing/requests {deviceName} → 201 {requestId, code}
 *   GET  /api/pairing/requests/:id/status?code=<code> → {status, token?}
 *
 * The pairing-code UX (12 chars grouped XXXX-XXXX-XXXX, shown large on the
 * device while the host approves) was inspired by pingdotgg/t3code (MIT);
 * the implementation here is original.
 */

const FETCH_TIMEOUT_MS = 8_000

export function hostBaseUrl(host: string, port: number): string {
  return `http://${host}:${port}`
}

/** Strict hostname / IPv4 allowlist so no path, query, authority, or port
 * delimiter can ever smuggle into constructed `http://` or `ws://` URLs. */
export function isValidHost(host: string): boolean {
  if (!host || host.length > 253) return false
  if (host.startsWith(".") || host.endsWith(".") || host.includes("..")) return false
  if (!/^[a-zA-Z0-9._-]+$/.test(host)) return false
  if (/^\d+(?:\.\d+)*$/.test(host)) {
    const parts = host.split(".")
    if (parts.length !== 4) return false
    return parts.every((part) => {
      if (!/^\d{1,3}$/.test(part)) return false
      const value = Number.parseInt(part, 10)
      return value >= 0 && value <= 255
    })
  }
  return true
}

function parsePortString(raw: string | undefined): number {
  const trimmed = raw?.trim() ?? ""
  if (!/^\d+$/.test(trimmed)) return NaN
  const port = Number.parseInt(trimmed, 10)
  return port >= 1 && port <= 65535 ? port : NaN
}

/** Parse `memosync://pair?host=<lan-ip>&port=<port>` (what the host QR encodes).
 * Query parsing is manual on purpose: Hermes' URL/URLSearchParams coverage has
 * historically lagged, and the contract is exactly two params. */
export function parsePairingUri(uri: string): { host: string; port: number } | null {
  const withoutFragment = uri.trim().split("#")[0] ?? ""
  const match = withoutFragment.match(/^memosync:\/\/pair\/?\?(.+)$/i)
  if (!match) return null
  const query = match[1] ?? ""
  const params: Record<string, string> = {}
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=")
    if (eq <= 0) continue
    try {
      params[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1))
    } catch {
      // Malformed percent-encoding — ignore that pair.
    }
  }
  const host = params.host?.trim()
  const port = parsePortString(params.port)
  if (!host || !isValidHost(host) || !Number.isFinite(port)) return null
  return { host, port }
}

/** Accept `host`, `host:port`, `http(s)://host(:port)` (copied from desktop
 * "Other addresses"), or a full pairing URI; returns null when invalid. */
export function normalizeHostInput(hostInput: string, portInput: string): { host: string; port: number } | null {
  const fromUri = parsePairingUri(hostInput)
  if (fromUri) return fromUri
  let host = hostInput.trim()
  let defaultSchemePort = NaN
  const schemeMatch = host.match(/^(https?):\/\//i)
  if (schemeMatch) {
    defaultSchemePort = schemeMatch[1]?.toLowerCase() === "https" ? 443 : 80
    host = host.slice(schemeMatch[0].length)
    // Allow a trailing root slash on copied origin URLs (`http://192.168.1.20:4040/`),
    // while keeping non-root paths/queries invalid via `isValidHost`.
    if (host.endsWith("/")) host = host.slice(0, -1)
  }
  let port = parsePortString(portInput)
  // Support pasting `192.168.1.20:4040` or `http://192.168.1.20:4040` into the
  // host field — an embedded port always wins over whatever remained in Port.
  const colonIndex = host.lastIndexOf(":")
  if (colonIndex > 0 && host.indexOf(":") === colonIndex) {
    const embeddedPort = parsePortString(host.slice(colonIndex + 1))
    if (!Number.isFinite(embeddedPort)) return null
    port = embeddedPort
    host = host.slice(0, colonIndex)
  } else if (!Number.isFinite(port) && Number.isFinite(defaultSchemePort)) {
    port = defaultSchemePort
  }
  if (!isValidHost(host) || !Number.isFinite(port)) return null
  return { host, port }
}

/** 12-char codes display grouped `XXXX-XXXX-XXXX`. */
export function formatPairingCode(code: string): string {
  const clean = code.replace(/[\s-]/g, "").toUpperCase()
  return clean.replace(/(.{4})(?=.)/g, "$1-")
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Validate a persisted bearer token against the device-accessible remote-access
 * status route. Network and unexpected statuses are deliberately "unknown":
 * an offline host must not erase a usable pairing.
 */
export async function validateDeviceToken(
  host: string,
  port: number,
  token: string,
): Promise<"valid" | "invalid" | "unknown"> {
  try {
    const response = await fetchWithTimeout(`${hostBaseUrl(host, port)}/api/remote-access/status`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    })
    if (response.status === 401) return "invalid"
    if (!response.ok) return "unknown"
    return "valid"
  } catch {
    return "unknown"
  }
}

async function readServerErrorMessage(response: Response): Promise<string | null> {
  try {
    const payload = (await response.json()) as { error?: unknown }
    return typeof payload?.error === "string" && payload.error.trim() ? payload.error.trim() : null
  } catch {
    return null
  }
}

export async function createPairingRequest(
  host: string,
  port: number,
  deviceName: string,
): Promise<PairingRequestResponse> {
  const response = await fetchWithTimeout(`${hostBaseUrl(host, port)}/api/pairing/requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ deviceName }),
  })
  if (response.status !== 201) {
    const serverMessage = await readServerErrorMessage(response)
    if (response.status === 404 || response.status === 403) {
      throw new Error("This MemoSync host is not accepting pairing requests. Enable remote access in its settings.")
    }
    if (response.status === 429) {
      throw new Error(
        serverMessage?.toLowerCase().includes("pending")
          ? `${serverMessage}. Approve or deny the open request in MemoSync settings on your computer before starting another.`
          : `${serverMessage ?? "Too many pairing requests"}. Approve or deny pending requests on your computer, or wait a moment and try again.`,
      )
    }
    throw new Error(serverMessage ?? `Pairing request failed (HTTP ${response.status})`)
  }
  return (await response.json()) as PairingRequestResponse
}

export class PairingStatusRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly serverMessage?: string | null,
  ) {
    super(message)
    this.name = "PairingStatusRequestError"
  }
}

export async function fetchPairingStatus(
  host: string,
  port: number,
  requestId: string,
  code: string,
): Promise<PairingStatusResponse> {
  const url = `${hostBaseUrl(host, port)}/api/pairing/requests/${encodeURIComponent(requestId)}/status?code=${encodeURIComponent(code)}`
  const response = await fetchWithTimeout(url, {
    headers: { Accept: "application/json" },
  })
  if (!response.ok) {
    const serverMessage = await readServerErrorMessage(response)
    throw new PairingStatusRequestError(
      response.status,
      serverMessage ?? `Could not read pairing status (HTTP ${response.status})`,
      serverMessage,
    )
  }
  return (await response.json()) as PairingStatusResponse
}
