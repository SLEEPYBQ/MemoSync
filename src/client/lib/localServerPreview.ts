import type { LocalHttpServerInfo } from "../../shared/protocol"
import {
  isPreviewHostForm,
  PREVIEW_PROXY_PATH_PREFIX,
  PREVIEW_TICKETS_PATH,
  previewProxyPath,
  stripPreviewPathPrefix,
} from "../../shared/preview-proxy"

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

const PREVIEW_PATH_PATTERN = new RegExp(
  `^${PREVIEW_PROXY_PATH_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(\\d{1,5})(?:/|$)`,
)

/** The target port a URL previews through this server, or null when the URL
 * is not a loopback project address / preview-proxy URL. */
function manualPreviewTargetPort(url: URL) {
  const proxyHostMatch = url.hostname.toLowerCase().match(/^(\d{1,5})\.localhost$/)
  if (proxyHostMatch) return Number(proxyHostMatch[1])
  const pathMatch = url.pathname.match(PREVIEW_PATH_PATTERN)
  if (pathMatch) return Number(pathMatch[1])
  if (!browserOriginCanReachLocalhost(url.hostname) || url.protocol !== "http:" || !url.port) return null
  const port = Number(url.port)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
}

/** The isolated `<port>.localhost:<appPort>` origin that keeps executable
 * preview content away from the app origin and its session cookie. */
function isolatedPreviewOrigin(targetPort: number, browserLocation: BrowserLocationLike) {
  const portPart = browserLocation.port ? `:${browserLocation.port}` : ""
  return `${browserLocation.protocol}//${targetPort}.localhost${portPart}`
}

/** Resolve an agent-started HTTP server from the browser that renders MemoSync.
 * Loopback browsers always use the isolated `<port>.localhost` proxy host so
 * neither the app session cookie nor arbitrary localhost ports are exposed;
 * remote gateways keep the same-origin path form, which the server redirects
 * to the configured isolated preview origin. */
export function localServerPreviewUrl(
  server: LocalHttpServerInfo,
  browserLocation: BrowserLocationLike = window.location,
) {
  if (browserOriginCanReachLocalhost(browserLocation.hostname)) {
    return `${isolatedPreviewOrigin(server.port, browserLocation)}/`
  }
  if (!server.preferProxy) return server.address
  return `${browserLocation.origin}${previewProxyPath(server.port)}`
}

export function canKillLocalHttpServer(server: LocalHttpServerInfo) {
  return server.canKill !== false
}

/** Normalize address-bar input. Loopback target ports route through the
 * isolated preview proxy host (never direct `localhost:<port>`), remote
 * browsers through the same-origin path form the server isolates itself. */
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
    const path = `${stripPreviewPathPrefix(url.pathname, targetPort)}${url.search}${url.hash}`
    if (browserOriginCanReachLocalhost(browserLocation.hostname)) {
      if (targetPort === Number(browserLocation.port)) return normalized
      return `${isolatedPreviewOrigin(targetPort, browserLocation)}${path}`
    }
    return `${browserLocation.origin}${previewProxyPath(targetPort, stripPreviewPathPrefix(url.pathname, targetPort))}${url.search}${url.hash}`
  } catch {
    return normalized
  }
}

/** True when the address is preview content this server proxies: either the
 * isolated `<port>.localhost` host form or the same-origin path form. */
export function isProxiedPreviewAddress(address: string, browserLocation: BrowserLocationLike = window.location) {
  try {
    const url = new URL(address)
    if (isPreviewHostForm(url.host)) {
      return isLoopbackSibling(url, browserLocation)
    }
    return url.origin === browserLocation.origin && PREVIEW_PATH_PATTERN.test(url.pathname)
  } catch {
    return false
  }
}

function isLoopbackSibling(url: URL, browserLocation: BrowserLocationLike) {
  return browserOriginCanReachLocalhost(browserLocation.hostname)
    && url.port === browserLocation.port
}

/**
 * Return the URL the preview iframe should actually load. For proxied
 * preview addresses the app mints a one-time ticket on the app origin — where
 * the session cookie IS available — and returns an isolated-origin callback
 * URL that sets the host-only memosync_preview cookie. Without this, an
 * iframe navigation on the preview origin could never complete the grant
 * bootstrap (the Strict app session cookie is not sent inside cross-site
 * frames). Non-preview addresses pass through unchanged.
 */
export async function previewFrameUrl(address: string, browserLocation: BrowserLocationLike = window.location) {
  if (!isProxiedPreviewAddress(address, browserLocation)) return address
  try {
    const url = new URL(address)
    const pathMatch = url.pathname.match(PREVIEW_PATH_PATTERN)
    const hostMatch = url.hostname.toLowerCase().match(/^(\d{1,5})\.localhost$/)
    const targetPort = hostMatch ? Number(hostMatch[1]) : pathMatch ? Number(pathMatch[1]) : null
    if (targetPort === null) return address
    const next = hostMatch
      ? `${url.pathname}${url.search}${url.hash}`
      : `${stripPreviewPathPrefix(url.pathname, targetPort)}${url.search}${url.hash}`
    const response = await fetch(PREVIEW_TICKETS_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port: targetPort, next }),
    })
    if (!response.ok) return address
    const payload = await response.json() as { url?: unknown }
    return typeof payload.url === "string" && payload.url ? payload.url : address
  } catch {
    return address
  }
}
