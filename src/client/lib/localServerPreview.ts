import type { LocalHttpServerInfo } from "../../shared/protocol"
import { previewProxyPath } from "../../shared/preview-proxy"

interface BrowserLocationLike {
  hostname: string
  origin: string
  port: string
  protocol: string
}

function browserOriginCanReachLocalhost(hostname: string) {
  const normalized = hostname.toLowerCase()
  return normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized === "127.0.0.1"
    || normalized === "0.0.0.0"
    || normalized === "[::1]"
    || normalized === "::1"
}

function normalizeManualAddress(address: string) {
  const trimmed = address.trim()
  if (!trimmed) return ""
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) return trimmed
  return `http://${trimmed}`
}

function manualPreviewTargetPort(url: URL) {
  const hostname = url.hostname.toLowerCase()
  const proxyHostMatch = hostname.match(/^(\d{1,5})\.localhost$/)
  if (proxyHostMatch) return Number(proxyHostMatch[1])
  if (!browserOriginCanReachLocalhost(hostname) || url.protocol !== "http:" || !url.port) return null
  const port = Number(url.port)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
}

/** Resolve an agent-started HTTP server from the browser that renders MemoSync.
 * Container previews stay on the current origin so authentication and the
 * participant allocation survive local orchestrator and remote gateways. */
export function localServerPreviewUrl(
  server: LocalHttpServerInfo,
  browserLocation: BrowserLocationLike = window.location,
) {
  if (!server.preferProxy) return server.address
  return `${browserLocation.origin}${previewProxyPath(server.port)}`
}

export function canKillLocalHttpServer(server: LocalHttpServerInfo) {
  return server.canKill !== false
}

/** Normalize address-bar input and keep in-container localhost URLs reachable
 * when MemoSync itself is being used through a remote gateway. */
export function manualBrowserAddressUrl(
  address: string,
  browserLocation: BrowserLocationLike = window.location,
  preferProxy = false,
) {
  const normalized = normalizeManualAddress(address)
  if (!normalized) return normalized

  try {
    const url = new URL(normalized)
    const targetPort = manualPreviewTargetPort(url)
    if (targetPort === null) return normalized
    if (!preferProxy && browserOriginCanReachLocalhost(browserLocation.hostname)) return normalized
    return `${browserLocation.origin}${previewProxyPath(targetPort, url.pathname)}${url.search}${url.hash}`
  } catch {
    return normalized
  }
}
