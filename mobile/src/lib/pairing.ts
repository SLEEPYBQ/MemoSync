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

/** Parse `memosync://pair?host=<lan-ip>&port=<port>` (what the host QR encodes).
 * Query parsing is manual on purpose: Hermes' URL/URLSearchParams coverage has
 * historically lagged, and the contract is exactly two params. */
export function parsePairingUri(uri: string): { host: string; port: number } | null {
  const trimmed = uri.trim()
  if (!trimmed.toLowerCase().startsWith("memosync://pair")) return null
  const queryIndex = trimmed.indexOf("?")
  if (queryIndex === -1) return null
  const params: Record<string, string> = {}
  for (const pair of trimmed.slice(queryIndex + 1).split("&")) {
    const eq = pair.indexOf("=")
    if (eq <= 0) continue
    try {
      params[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1))
    } catch {
      // Malformed percent-encoding — ignore that pair.
    }
  }
  const host = params.host?.trim()
  const port = params.port ? Number.parseInt(params.port.trim(), 10) : NaN
  if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) return null
  return { host, port }
}

/** Accept `host`, `host:port`, or a full pairing URI; returns null when invalid. */
export function normalizeHostInput(hostInput: string, portInput: string): { host: string; port: number } | null {
  const fromUri = parsePairingUri(hostInput)
  if (fromUri) return fromUri
  let host = hostInput.trim()
  let port = Number.parseInt(portInput.trim(), 10)
  // Support pasting `192.168.1.20:4040` into the host field.
  const colonIndex = host.lastIndexOf(":")
  if (colonIndex > 0 && host.indexOf(":") === colonIndex) {
    const embeddedPort = Number.parseInt(host.slice(colonIndex + 1), 10)
    if (Number.isFinite(embeddedPort) && (!portInput.trim() || Number.isNaN(port))) {
      port = embeddedPort
      host = host.slice(0, colonIndex)
    }
  }
  if (!host || !/^[a-zA-Z0-9._-]+$/.test(host)) return null
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null
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
    throw new Error(
      response.status === 404 || response.status === 403
        ? "This MemoSync host is not accepting pairing requests. Enable remote access in its settings."
        : `Pairing request failed (HTTP ${response.status})`,
    )
  }
  return (await response.json()) as PairingRequestResponse
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
    throw new Error(`Could not read pairing status (HTTP ${response.status})`)
  }
  return (await response.json()) as PairingStatusResponse
}
