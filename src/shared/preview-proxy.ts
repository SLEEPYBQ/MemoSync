export const PREVIEW_PROXY_PATH_PREFIX = "/__memosync/preview"
export const PREVIEW_COOKIE_NAME = "memosync_preview"
export const PREVIEW_CALLBACK_PATH = "/__memosync/preview-callback"
export const PREVIEW_GRANT_PATH = "/auth/preview-grant"
export const PREVIEW_TICKETS_PATH = "/api/preview-grants"

export function previewProxyPath(targetPort: number, pathname = "/") {
  if (!Number.isInteger(targetPort) || targetPort <= 0 || targetPort > 65535) {
    throw new RangeError(`Invalid preview target port: ${targetPort}`)
  }
  const suffix = pathname.startsWith("/") ? pathname : `/${pathname}`
  return `${PREVIEW_PROXY_PATH_PREFIX}/${targetPort}${suffix}`
}

/** The `<port>.localhost` isolated preview host form. */
export const PREVIEW_HOST_PATTERN = /^(\d{1,5})\.localhost(?::\d+)?$/i

export function isPreviewHostForm(host: string) {
  return PREVIEW_HOST_PATTERN.test(host)
}

/** Hostnames that resolve to this machine, so `<port>.localhost:<appPort>`
 * reaches the same server as an isolated origin. */
export function isLoopbackHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  return normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized === "::1"
    || normalized === "0.0.0.0"
    || /^127(?:\.\d{1,3}){3}$/.test(normalized)
}

/** True for plain top-level and iframe document navigations (the requests a
 * browser willing to follow a bootstrap redirect chain makes). Subresource,
 * fetch, and upgrade requests return false. */
export function isPreviewNavigationRequest(req: Request) {
  if (req.method !== "GET" && req.method !== "HEAD") return false
  if (req.headers.has("upgrade")) return false
  const connection = req.headers.get("connection")?.toLowerCase() ?? ""
  if (connection.split(",").some((token) => token.trim() === "upgrade")) return false
  const destination = req.headers.get("sec-fetch-dest")
  const mode = req.headers.get("sec-fetch-mode")
  if (destination && destination !== "document" && destination !== "iframe") return false
  if (mode && mode !== "navigate") return false
  return true
}

/** Remove the `/__memosync/preview/<port>` prefix a path-form request carries. */
export function stripPreviewPathPrefix(pathname: string, targetPort: number) {
  const base = `${PREVIEW_PROXY_PATH_PREFIX}/${targetPort}`
  if (pathname === base) return "/"
  if (pathname.startsWith(`${base}/`)) return pathname.slice(base.length)
  return pathname
}

export interface IsolatedPreviewTarget {
  /** Absolute origin of the isolated preview host. */
  origin: string
  /** Host header the browser will send to that origin (cookie scope key). */
  host: string
  /** Path on that origin that proxies to the target port. */
  path: string
}

/**
 * Resolve where executable preview content for `targetPort` is allowed to
 * live: the configured MEMOSYNC_PREVIEW_ORIGIN when present, otherwise the
 * `<port>.localhost` sibling of a loopback app origin. `nextPath` is the
 * user-facing path on the previewed project ("/" root form, no proxy prefix).
 * Returns null when no isolated origin is available (remote deployment without
 * a configured HTTPS or loopback preview origin) — callers must not fall back
 * to the app origin.
 */
export function isolatedPreviewTarget(
  req: Request,
  targetPort: number,
  configuredPreviewOrigin: string | null,
  nextPath: string,
): IsolatedPreviewTarget | null {
  const url = new URL(req.url)
  const path = nextPath.startsWith("/") ? nextPath : `/${nextPath}`
  if (configuredPreviewOrigin) {
    const origin = new URL(configuredPreviewOrigin)
    // A public HTTP preview origin cannot carry the required
    // SameSite=None;Secure credential inside a cross-site iframe. Treat it as
    // unavailable rather than sending the browser into a bootstrap/401 loop.
    if (origin.protocol !== "https:" && !isLoopbackHostname(origin.hostname)) return null
    return {
      origin: origin.origin,
      host: origin.host,
      path: previewProxyPath(targetPort, path),
    }
  }
  if (isLoopbackHostname(url.hostname)) {
    const host = `${targetPort}.localhost${url.port ? `:${url.port}` : ""}`
    return {
      origin: `${url.protocol}//${host}`,
      host,
      path,
    }
  }
  return null
}
