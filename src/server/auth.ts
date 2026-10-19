import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import {
  isLoopbackHostname,
  isPreviewNavigationRequest,
  isolatedPreviewTarget,
  PREVIEW_CALLBACK_PATH,
  PREVIEW_COOKIE_NAME,
  PREVIEW_GRANT_PATH,
  PREVIEW_PROXY_PATH_PREFIX,
} from "../shared/preview-proxy"

export const SESSION_COOKIE_NAME = "memosync_session"
export { PREVIEW_COOKIE_NAME }

export interface AuthStatusPayload {
  enabled: boolean
  authenticated: boolean
}

export interface AuthManager {
  isAuthenticated(req: Request): boolean
  isPreviewAuthenticated(req: Request, targetPort: number): boolean
  validateOrigin(req: Request): boolean
  redirectToApp(req: Request): Response
  handleLogin(req: Request, nextPath: string): Promise<Response>
  handleLogout(req: Request): Response
  handleStatus(req: Request): Response
  /** GET /auth/preview-grant on the app origin: mint a one-time ticket and
   * redirect to the isolated preview origin's callback. */
  handlePreviewGrant(req: Request): Response
  /** GET <preview-origin>/__memosync/preview-callback: consume a ticket, set
   * the host-only preview cookie, and continue to the original path. */
  handlePreviewCallback(req: Request): Response
  /** POST /api/preview-grants: app-origin mint for embedded frames that cannot
   * run the navigation bootstrap themselves. */
  handlePreviewTicketMint(req: Request): Promise<Response>
  /** Navigation on an isolated preview origin without a preview credential:
   * 302 to the app-origin grant endpoint, or null when no app origin is
   * derivable (non-navigation requests always get null → callers answer 401). */
  previewBootstrapRedirect(req: Request, targetPort: number): Response | null
  /** For an app-origin path-form request, the isolated URL it should redirect
   * to — or null when no isolated origin exists for this deployment. */
  previewIsolationUrl(req: Request, targetPort: number): string | null
  /** 302 to the isolated origin's callback carrying a freshly minted ticket;
   * requires an authenticated session. */
  previewTicketRedirect(req: Request, targetPort: number): Response
}

function parseCookies(header: string | null) {
  const cookies = new Map<string, string>()
  if (!header) return cookies

  for (const segment of header.split(";")) {
    const trimmed = segment.trim()
    if (!trimmed) continue
    const separator = trimmed.indexOf("=")
    if (separator <= 0) continue
    const key = trimmed.slice(0, separator).trim()
    const value = trimmed.slice(separator + 1).trim()
    cookies.set(key, decodeURIComponent(value))
  }

  return cookies
}

function sanitizeNextPath(nextPath: string | null | undefined) {
  if (!nextPath || typeof nextPath !== "string") return "/"
  if (/[\u0000-\u001f\u007f]|%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(nextPath)) return "/"
  if (!nextPath.startsWith("/")) return "/"
  // Reject protocol-relative URLs. The WHATWG URL parser treats backslashes as
  // forward slashes, so "/\evil.com" resolves to "//evil.com" → an open
  // redirect to another origin (BUG HTTP-1). Block a leading "/" followed by
  // any slash-or-backslash.
  if (/^\/[/\\]/.test(nextPath)) return "/"
  if (nextPath.startsWith("/auth/login")) return "/"
  return nextPath
}

function forwardedProto(req: Request): "http" | "https" | null {
  const xfp = req.headers.get("x-forwarded-proto")
  if (!xfp) return null
  const value = xfp.split(",")[0]?.trim().toLowerCase()
  return value === "http" || value === "https" ? value : null
}

function effectiveOrigin(req: Request, trustProxy: boolean): string {
  const url = new URL(req.url)
  if (!trustProxy) return url.origin
  const proto = forwardedProto(req)
  const scheme = proto ?? url.protocol.replace(":", "")
  return `${scheme}://${url.host}`
}

export function validateRequestOrigin(
  req: Request,
  options: { trustProxy?: boolean; allowedOrigins?: string[] } = {}
) {
  const origin = req.headers.get("origin")
  if (!origin) return true
  if (origin === new URL(req.url).origin) return true
  if (options.trustProxy && origin === effectiveOrigin(req, true)) return true
  return (options.allowedOrigins ?? []).some((allowed) => allowed.trim() === origin)
}

function shouldUseSecureCookie(req: Request, trustProxy: boolean) {
  if (trustProxy) {
    const proto = forwardedProto(req)
    if (proto) return proto === "https"
  }
  return new URL(req.url).protocol === "https:"
}

function buildCookie(name: string, value: string, req: Request, trustProxy: boolean, extras: string[] = []) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
  ]

  if (shouldUseSecureCookie(req, trustProxy)) {
    parts.push("Secure")
  }

  parts.push(...extras)
  return parts.join("; ")
}

async function readLoginForm(req: Request) {
  const contentType = req.headers.get("content-type") ?? ""

  if (contentType.includes("application/json")) {
    const payload = await req.json() as { password?: unknown; next?: unknown }
    return {
      password: typeof payload.password === "string" ? payload.password : "",
      nextPath: sanitizeNextPath(typeof payload.next === "string" ? payload.next : "/"),
    }
  }

  const formData = await req.formData()
  return {
    password: String(formData.get("password") ?? ""),
    nextPath: sanitizeNextPath(String(formData.get("next") ?? "/")),
  }
}

export interface AuthManagerOptions {
  /**
   * When true, the auth layer trusts X-Forwarded-Proto to decide whether the
   * public origin is http or https. The hostname always comes from the Host
   * header (never X-Forwarded-Host) because X-Forwarded-Host is passed
   * through by some tunnels unmodified and would otherwise allow open
   * redirects.
   * Enable only when the server is reachable solely through a trusted reverse
   * proxy such as cloudflared.
   */
  trustProxy?: boolean
  /**
   * Isolated HTTPS origin that also reaches this server and is allowed to
   * execute preview content (MEMOSYNC_PREVIEW_ORIGIN), e.g.
   * `https://preview.example.com`. Required for previews when the app itself
   * is reached through a non-loopback public origin.
   */
  previewOrigin?: string | null
  /**
   * Public origin of the app (MEMOSYNC_APP_ORIGIN). Used to send a
   * credential-less navigation on the preview origin back to the app-origin
   * grant endpoint. Optional when previews only run on `<port>.localhost`.
   */
  appOrigin?: string | null
}

export function createAuthManager(password: string, options: AuthManagerOptions = {}): AuthManager {
  const expectedPassword = Buffer.from(password)
  const trustProxy = options.trustProxy ?? false
  // Sessions are STATELESS, HMAC-signed tokens keyed on the password, not an
  // in-memory Set. An in-memory Set was wiped on every restart, so a deploy /
  // crash logged everyone out — and open tabs couldn't tell (a WS handshake 401
  // is indistinguishable from a network drop), so they hung on "reconnecting"
  // forever instead of returning to the password page (BUG HTTP-4). A signed
  // token validates without server state and survives restart while the
  // password is unchanged. Logout clears the cookie client-side.
  const configuredPreviewOrigin = options.previewOrigin?.trim() ? new URL(options.previewOrigin!.trim()) : null
  // SameSite=None preview credentials require Secure transport; browsers only
  // accept Secure on HTTP for loopback hosts.
  const previewOrigin = configuredPreviewOrigin && (configuredPreviewOrigin.protocol === "https:" || isLoopbackHostname(configuredPreviewOrigin.hostname))
    ? configuredPreviewOrigin.origin
    : null
  const configuredAppOrigin = options.appOrigin?.trim() ? new URL(options.appOrigin!.trim()).origin : null
  // Preview credentials are bound to a per-boot nonce: restarting the process
  // invalidates every outstanding memosync_preview cookie even though the
  // (password-derived) session tokens survive restarts by design.
  const bootNonce = randomBytes(16).toString("base64url")
  const PREVIEW_TICKET_TTL_MS = 60_000
  const previewTickets = new Map<string, {
    port: number
    host: string
    next: string
    sessionNonce: string
    expiresAt: number
  }>()
  // Session nonces whose preview grants were revoked by logout. Bounded: one
  // entry per explicit logout, cleared on restart (bootNonce rotates anyway).
  const revokedSessionNonces = new Set<string>()
  const sessionKey = createHash("sha256").update(`memosync-session\u0000${password}`).digest()

  const previewKey = createHmac("sha256", sessionKey).update(`memosync-preview${bootNonce}`).digest()

  function signNonce(nonce: string) {
    return createHmac("sha256", sessionKey).update(nonce).digest("base64url")
  }

  function isValidToken(token: string) {
    const dot = token.lastIndexOf(".")
    if (dot <= 0) return false
    const expected = Buffer.from(signNonce(token.slice(0, dot)))
    const actual = Buffer.from(token.slice(dot + 1))
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }

  function getSessionToken(req: Request) {
    return parseCookies(req.headers.get("cookie")).get(SESSION_COOKIE_NAME) ?? null
  }

  function isAuthenticated(req: Request) {
    const sessionToken = getSessionToken(req)
    return Boolean(sessionToken && isValidToken(sessionToken))
  }

  function getSessionNonce(req: Request) {
    const token = getSessionToken(req)
    if (!token || !isValidToken(token)) return null
    return token.slice(0, token.lastIndexOf("."))
  }

  function signPreviewToken(targetPort: number, host: string, sessionNonce: string) {
    return createHmac("sha256", previewKey)
      .update(`${targetPort} ${host} ${sessionNonce}`)
      .digest("base64url")
  }

  function isPreviewAuthenticated(req: Request, targetPort: number) {
    const token = parseCookies(req.headers.get("cookie")).get(PREVIEW_COOKIE_NAME)
    if (!token) return false
    const firstDot = token.indexOf(".")
    const lastDot = token.lastIndexOf(".")
    if (firstDot <= 0 || lastDot === firstDot) return false
    if (Number(token.slice(0, firstDot)) !== targetPort) return false
    const nonce = token.slice(firstDot + 1, lastDot)
    if (revokedSessionNonces.has(nonce)) return false
    const host = new URL(req.url).host
    const expected = Buffer.from(signPreviewToken(targetPort, host, nonce))
    const actual = Buffer.from(token.slice(lastDot + 1))
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }

  function purgeExpiredPreviewTickets() {
    const now = Date.now()
    for (const [id, ticket] of previewTickets) {
      if (ticket.expiresAt <= now) previewTickets.delete(id)
    }
  }

  function mintPreviewTicket(req: Request, target: { port: number; host: string; next: string }) {
    const sessionNonce = getSessionNonce(req)
    if (!sessionNonce) return null
    purgeExpiredPreviewTickets()
    const id = randomBytes(18).toString("base64url")
    previewTickets.set(id, {
      port: target.port,
      host: target.host,
      next: target.next,
      sessionNonce,
      expiresAt: Date.now() + PREVIEW_TICKET_TTL_MS,
    })
    return id
  }

  function buildPreviewCookie(value: string, req: Request, extras: string[] = []) {
    const url = new URL(req.url)
    const parts = [
      `${PREVIEW_COOKIE_NAME}=${encodeURIComponent(value)}`,
      "Path=/",
      "HttpOnly",
    ]
    // Embedded previews are cross-site iframes (the preview host is a sibling
    // of the app origin), which only SameSite=None;Secure cookies reach.
    // Loopback preview hosts are potentially trustworthy, so Secure is safe
    // there even over http.
    if (shouldUseSecureCookie(req, trustProxy) || isLoopbackHostname(url.hostname)) {
      parts.push("SameSite=None", "Secure")
    } else {
      parts.push("SameSite=Lax")
    }
    parts.push(...extras)
    return parts.join("; ")
  }

  /** The app origin that can mint tickets for a navigation arriving on an
   * isolated preview origin: the `localhost` sibling of `<port>.localhost`,
   * or the configured public app origin. */
  function appOriginForPreviewRequest(req: Request) {
    const url = new URL(req.url)
    if (/^\d{1,5}\.localhost$/i.test(url.hostname)) {
      return `${url.protocol}//localhost${url.port ? `:${url.port}` : ""}`
    }
    return configuredAppOrigin
  }

  function previewBootstrapRedirect(req: Request, targetPort: number) {
    if (!isPreviewNavigationRequest(req)) return null
    const appOrigin = appOriginForPreviewRequest(req)
    if (!appOrigin) return null
    const grant = new URL(`${appOrigin}${PREVIEW_GRANT_PATH}`)
    grant.searchParams.set("port", String(targetPort))
    grant.searchParams.set("redirect", req.url)
    return Response.redirect(grant, 302)
  }

  function previewIsolationUrl(req: Request, targetPort: number) {
    const url = new URL(req.url)
    const base = `${PREVIEW_PROXY_PATH_PREFIX}/${targetPort}`
    const stripped = url.pathname === base ? "/"
      : url.pathname.startsWith(`${base}/`) ? url.pathname.slice(base.length)
      : url.pathname
    const target = isolatedPreviewTarget(req, targetPort, previewOrigin, stripped)
    return target ? `${target.origin}${target.path}${url.search}` : null
  }

  function validateGrantRedirect(req: Request, port: number, target: URL) {
    if (target.protocol !== "http:" && target.protocol !== "https:") return false
    const url = new URL(req.url)
    const hostMatch = target.hostname.match(/^(\d{1,5})\.localhost$/i)
    if (hostMatch) {
      return Number(hostMatch[1]) === port && target.port === url.port
    }
    if (previewOrigin && target.origin === previewOrigin) {
      const base = `${PREVIEW_PROXY_PATH_PREFIX}/${port}`
      return target.pathname === base || target.pathname.startsWith(`${base}/`)
    }
    return false
  }

  function handlePreviewGrant(req: Request) {
    const url = new URL(req.url)
    if (!isAuthenticated(req)) {
      const login = new URL(`${effectiveOrigin(req, trustProxy)}/auth/login`)
      login.searchParams.set("next", `${url.pathname}${url.search}`)
      return Response.redirect(login, 302)
    }
    const port = Number(url.searchParams.get("port"))
    let target: URL
    try {
      target = new URL(url.searchParams.get("redirect") ?? "")
    } catch {
      return new Response("Bad Request", { status: 400 })
    }
    if (!Number.isInteger(port) || port <= 0 || port > 65535 || !validateGrantRedirect(req, port, target)) {
      return new Response("Bad Request", { status: 400 })
    }
    const ticket = mintPreviewTicket(req, {
      port,
      host: target.host,
      next: `${target.pathname}${target.search}`,
    })
    if (!ticket) return new Response("Unauthorized", { status: 401 })
    return Response.redirect(`${target.origin}${PREVIEW_CALLBACK_PATH}?ticket=${ticket}`, 302)
  }

  function handlePreviewCallback(req: Request) {
    const url = new URL(req.url)
    const id = url.searchParams.get("ticket") ?? ""
    const ticket = previewTickets.get(id)
    previewTickets.delete(id)
    if (!ticket || ticket.expiresAt <= Date.now() || ticket.host !== url.host) {
      return new Response("Unauthorized", { status: 401 })
    }
    const value = `${ticket.port}.${ticket.sessionNonce}.${signPreviewToken(ticket.port, ticket.host, ticket.sessionNonce)}`
    const response = new Response(null, {
      status: 302,
      headers: { Location: sanitizeNextPath(ticket.next) },
    })
    response.headers.set("Set-Cookie", buildPreviewCookie(value, req))
    return response
  }

  function previewTicketRedirect(req: Request, targetPort: number) {
    const url = new URL(req.url)
    const base = `${PREVIEW_PROXY_PATH_PREFIX}/${targetPort}`
    const path = url.pathname === base ? "/"
      : url.pathname.startsWith(`${base}/`) ? url.pathname.slice(base.length)
      : "/"
    const target = isolatedPreviewTarget(req, targetPort, previewOrigin, `${path}${url.search}`)
    if (!target) return new Response("Forbidden", { status: 403 })
    const ticket = mintPreviewTicket(req, { port: targetPort, host: target.host, next: target.path })
    if (!ticket) return new Response("Unauthorized", { status: 401 })
    return Response.redirect(`${target.origin}${PREVIEW_CALLBACK_PATH}?ticket=${ticket}`, 302)
  }

  async function handlePreviewTicketMint(req: Request) {
    if (!validateOrigin(req)) {
      return Response.json({ error: "Forbidden" }, { status: 403 })
    }
    if (!isAuthenticated(req)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 })
    }
    let port = NaN
    let nextPath = "/"
    try {
      const body = await req.json() as { port?: unknown; next?: unknown }
      port = Number(body.port)
      if (typeof body.next === "string") nextPath = body.next
    } catch {
      return Response.json({ error: "Bad Request" }, { status: 400 })
    }
    const target = Number.isInteger(port) && port > 0 && port <= 65535
      ? isolatedPreviewTarget(req, port, previewOrigin, sanitizeNextPath(nextPath))
      : null
    if (!target) return Response.json({ url: null })
    const ticket = mintPreviewTicket(req, { port, host: target.host, next: target.path })
    if (!ticket) return Response.json({ error: "Unauthorized" }, { status: 401 })
    return Response.json({ url: `${target.origin}${PREVIEW_CALLBACK_PATH}?ticket=${ticket}` })
  }

  function validateOrigin(req: Request) {
    return validateRequestOrigin(req, { trustProxy })
  }

  function createSessionCookie(req: Request) {
    const nonce = randomBytes(24).toString("base64url")
    const sessionToken = `${nonce}.${signNonce(nonce)}`
    return buildCookie(SESSION_COOKIE_NAME, sessionToken, req, trustProxy)
  }

  function clearSessionCookie(req: Request) {
    // Stateless tokens: clearing the cookie is the revocation (the browser no
    // longer presents a valid token).
    return buildCookie(SESSION_COOKIE_NAME, "", req, trustProxy, ["Max-Age=0"])
  }

  function verifyPassword(candidate: string) {
    const actual = Buffer.from(candidate)
    if (actual.length !== expectedPassword.length) {
      return false
    }
    return timingSafeEqual(actual, expectedPassword)
  }

  function handleStatus(req: Request) {
    return Response.json({
      enabled: true,
      authenticated: isAuthenticated(req),
    } satisfies AuthStatusPayload)
  }

  function redirectToApp(req: Request) {
    const currentUrl = new URL(req.url)
    const origin = effectiveOrigin(req, trustProxy)
    const destination = new URL(sanitizeNextPath(currentUrl.searchParams.get("next")), origin)
    return Response.redirect(destination.origin === origin ? destination : new URL("/", origin), 302)
  }

  async function handleLogin(req: Request, fallbackNextPath: string) {
    if (!validateOrigin(req)) {
      return Response.json({ error: "Forbidden" }, { status: 403 })
    }

    const { password: candidate, nextPath } = await readLoginForm(req)
    if (!verifyPassword(candidate)) {
      return Response.json({ error: "Invalid password" }, { status: 401 })
    }

    const response = Response.json({ ok: true, nextPath: sanitizeNextPath(nextPath || fallbackNextPath) })

    response.headers.set("Set-Cookie", createSessionCookie(req))
    return response
  }

  function handleLogout(req: Request) {
    if (!validateOrigin(req)) {
      return Response.json({ error: "Forbidden" }, { status: 403 })
    }

    // Revoke the preview grants bound to this session: the preview cookie
    // lives on a different host and cannot be cleared from here.
    const sessionNonce = getSessionNonce(req)
    if (sessionNonce) revokedSessionNonces.add(sessionNonce)

    const response = Response.json({ ok: true })
    response.headers.set("Set-Cookie", clearSessionCookie(req))
    return response
  }

  return {
    isAuthenticated,
    isPreviewAuthenticated,
    validateOrigin,
    redirectToApp,
    handleLogin,
    handleLogout,
    handleStatus,
    handlePreviewGrant,
    handlePreviewCallback,
    handlePreviewTicketMint,
    previewBootstrapRedirect,
    previewIsolationUrl,
    previewTicketRedirect,
  }
}
