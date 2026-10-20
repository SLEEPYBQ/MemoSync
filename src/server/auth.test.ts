import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAuthManager, validateRequestOrigin } from "./auth"
import { persistProjectUpload } from "./uploads"
import { startMemoSyncServer } from "./server"

const tempDirs: string[] = []
// Every server a helper boots, stopped in afterEach even when a test aborted
// mid-boot (a timed-out test never reaches its own finally).
const liveServers: Array<{ stop: () => Promise<void> }> = []

describe("request origin validation", () => {
  test("rejects a foreign browser origin without requiring password auth", () => {
    expect(validateRequestOrigin(new Request("http://localhost:3210/ws", {
      headers: { Origin: "https://evil.example" },
    }))).toBe(false)
    expect(validateRequestOrigin(new Request("http://localhost:3210/ws", {
      headers: { Origin: "http://localhost:3210" },
    }))).toBe(true)
    expect(validateRequestOrigin(new Request("http://localhost:3210/ws", {
      headers: { Origin: "http://localhost:5173" },
    }), { allowedOrigins: ["http://localhost:5173"] })).toBe(true)
  })
})

describe("login redirect boundary", () => {
  test("rejects ASCII controls in next paths before URL normalization", async () => {
    const auth = createAuthManager("secret")
    const origin = "http://localhost:3210"
    for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
      for (const control of [String.fromCharCode(code), `%${code.toString(16).padStart(2, "0")}`]) {
        const next = `/${control}/foreign.invalid`
        const response = auth.redirectToApp(new Request(`${origin}/auth/login?next=${encodeURIComponent(next)}`))
        expect(response.headers.get("location")).toBe(`${origin}/`)
        const login = await auth.handleLogin(new Request(`${origin}/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: "secret", next }),
        }), "/")
        expect(await login.json()).toEqual({ ok: true, nextPath: "/" })
      }
    }
  })

  test("preserves local next paths with query, fragment and encoded spaces", () => {
    const auth = createAuthManager("secret")
    const origin = "http://localhost:3210"
    const next = "/chat/a%20b?tab=files#details"
    const response = auth.redirectToApp(new Request(`${origin}/auth/login?next=${encodeURIComponent(next)}`))
    expect(response.headers.get("location")).toBe(`${origin}${next}`)
  })
})

afterEach(async () => {
  // Stop servers BEFORE deleting their data dirs — a live server watches
  // settings.json inside them (deleting first fires unhandled fs.watch errors).
  await Promise.all(liveServers.splice(0).map((server) => server.stop().catch(() => {})))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function startPasswordServer(options: { trustProxy?: boolean; port?: number } = {}) {
  const projectDir = await mkdtemp(path.join(tmpdir(), "memosync-auth-test-"))
  const dataDir = await mkdtemp(path.join(tmpdir(), "memosync-auth-data-"))
  tempDirs.push(projectDir)
  tempDirs.push(dataDir)
  const server = await startMemoSyncServer({
    dataDir,
    // Ephemeral by default; restart coverage may opt into the released port.
    port: options.port ?? 0,
    strictPort: true,
    password: "secret",
    trustProxy: options.trustProxy ?? false,
    // Never scan the developer's real ~/.claude / ~/.codex from a test boot.
    discoverProjects: () => [],
  })
  liveServers.push(server)
  const project = await server.store.openProject(projectDir, "Project")
  return { server, projectDir, project }
}

async function startNoPasswordServer() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "memosync-origin-data-"))
  tempDirs.push(dataDir)
  const server = await startMemoSyncServer({
    dataDir,
    port: 0,
    strictPort: true,
    discoverProjects: () => [],
  })
  liveServers.push(server)
  return server
}

function extractCookie(response: Response) {
  const header = response.headers.get("set-cookie")
  expect(header).toBeTruthy()
  return header!.split(";", 1)[0]
}

describe("password auth", () => {
  test("serves the app shell to unauthenticated browser requests", async () => {
    const { server } = await startPasswordServer()

    try {
      const response = await fetch(`http://localhost:${server.port}/chat/demo`, { headers: { Accept: "text/html" } })
      expect(response.status).toBe(200)
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(response.headers.get("content-type")).toContain("text/html")
      expect(await response.text()).toContain('id="root"')
    } finally {
      await server.stop()
    }
  })

  test("serves health checks without authentication", async () => {
    const { server } = await startPasswordServer()

    try {
      const response = await fetch(`http://localhost:${server.port}/health`, { redirect: "manual" })
      expect(response.status).toBe(200)
    } finally {
      await server.stop()
    }
  })

  test("blocks unauthenticated api requests", async () => {
    const { server } = await startPasswordServer()

    try {
      const response = await fetch(`http://localhost:${server.port}/api/projects/project-1/uploads`, { redirect: "manual" })
      expect(response.status).toBe(401)
    } finally {
      await server.stop()
    }
  })

  test("keeps executable preview content off the app origin even after login", async () => {
    const target = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("protected preview target"),
    })
    const { server } = await startPasswordServer()
    const appOrigin = `http://localhost:${server.port}`
    const previewUrl = `${appOrigin}/__memosync/preview/${target.port}/`

    try {
      const unauthenticated = await fetch(previewUrl, {
        headers: { "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" },
        redirect: "manual",
      })
      // Navigations are redirected to the isolated preview origin, never
      // served executable upstream content on the app origin.
      expect(unauthenticated.status).toBe(302)
      expect(unauthenticated.headers.get("location")).toBe(
        `http://${target.port}.localhost:${server.port}/`,
      )

      const loginResponse = await fetch(`${appOrigin}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Origin: appOrigin,
        },
      })
      const cookie = extractCookie(loginResponse)
      const authenticated = await fetch(previewUrl, {
        headers: { Cookie: cookie, "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" },
        redirect: "manual",
      })

      // An authenticated navigation mints a one-time ticket to the isolated
      // origin's callback instead of proxying on the app origin.
      expect(authenticated.status).toBe(302)
      const callback = new URL(authenticated.headers.get("location")!)
      expect(callback.hostname).toBe(`${target.port}.localhost`)
      expect(callback.pathname).toBe("/__memosync/preview-callback")
      expect(callback.searchParams.get("ticket")).toBeTruthy()

      // Navigation-shaped requests redirect to the isolated origin; requests
      // that cannot be navigations get an explicit safe block — neither ever
      // proxies executable upstream content on the app origin.
      for (const headers of [
        { Cookie: cookie, "Sec-Fetch-Dest": "iframe" },
        { Cookie: cookie },
      ] as HeadersInit[]) {
        const nav = await fetch(previewUrl, { headers, redirect: "manual" })
        expect(nav.status).toBe(302)
        expect(new URL(nav.headers.get("location")!).hostname).toBe(`${target.port}.localhost`)
      }
      for (const headers of [
        { Cookie: cookie, "Sec-Fetch-Mode": "cors" },
        { Cookie: cookie, "Sec-Fetch-Dest": "image" },
      ] as HeadersInit[]) {
        const blocked = await fetch(previewUrl, { headers, redirect: "manual" })
        expect(blocked.status).toBe(403)
      }
      const method = await fetch(previewUrl, { method: "POST", headers: { Cookie: cookie }, redirect: "manual" })
      expect(method.status).toBe(403)
    } finally {
      target.stop(true)
      await server.stop()
    }
  })

  test("preserves query parameters through the authenticated preview bootstrap", async () => {
    const { server } = await startPasswordServer()
    const appOrigin = `http://localhost:${server.port}`
    const targetPort = 8901
    const previewUrl = `${appOrigin}/__memosync/preview/${targetPort}/dashboard?tab=files&next=%2Fother`
    try {
      const login = await fetch(`${appOrigin}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: appOrigin },
        body: JSON.stringify({ password: "secret", next: "/" }),
      })
      const sessionCookie = extractCookie(login)
      const navigation = await fetch(previewUrl, {
        headers: {
          Cookie: sessionCookie,
          "Sec-Fetch-Dest": "iframe",
          "Sec-Fetch-Mode": "navigate",
        },
        redirect: "manual",
      })
      expect(navigation.status).toBe(302)
      const callbackUrl = new URL(navigation.headers.get("location")!)
      expect(callbackUrl.hostname).toBe(`${targetPort}.localhost`)
      const callback = await fetch(`${appOrigin}${callbackUrl.pathname}${callbackUrl.search}`, {
        headers: { Host: callbackUrl.host },
        redirect: "manual",
      })
      expect(callback.status).toBe(302)
      expect(callback.headers.get("location")).toBe("/dashboard?tab=files&next=%2Fother")

      const encodedQuery = await fetch(`${appOrigin}/__memosync/preview/${targetPort}/dashboard?tab=files&next=%0Aother`, {
        headers: {
          Cookie: sessionCookie,
          "Sec-Fetch-Dest": "iframe",
          "Sec-Fetch-Mode": "navigate",
        },
        redirect: "manual",
      })
      const encodedCallbackUrl = new URL(encodedQuery.headers.get("location")!)
      const encodedCallback = await fetch(`${appOrigin}${encodedCallbackUrl.pathname}${encodedCallbackUrl.search}`, {
        headers: { Host: encodedCallbackUrl.host },
        redirect: "manual",
      })
      expect(encodedCallback.headers.get("location")).toBe("/dashboard?tab=files&next=%0Aother")
    } finally {
      await server.stop()
    }
  })

  test("does not mint embedded credentials for a public HTTP preview origin", async () => {
    const appOrigin = "https://memosync.example.com"
    const auth = createAuthManager("secret", {
      appOrigin,
      previewOrigin: "http://preview.example.com",
    })
    const login = await auth.handleLogin(new Request(`${appOrigin}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: appOrigin },
      body: JSON.stringify({ password: "secret", next: "/" }),
    }), "/")
    const sessionCookie = extractCookie(login)

    const mint = await auth.handlePreviewTicketMint(new Request(`${appOrigin}/api/preview-grants`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: appOrigin, Cookie: sessionCookie },
      body: JSON.stringify({ port: 8901, next: "/" }),
    }))
    expect(mint.status).toBe(200)
    expect(await mint.json()).toEqual({ url: null })

    const grant = auth.handlePreviewGrant(new Request(
      `${appOrigin}/auth/preview-grant?port=8901&redirect=${encodeURIComponent("http://preview.example.com/__memosync/preview/8901/")}`,
      { headers: { Cookie: sessionCookie } },
    ))
    expect(grant.status).toBe(400)
  })

  test("does not proxy when a preview Host conflicts with the app URL", async () => {
    let upstreamHits = 0
    const target = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => {
        upstreamHits += 1
        return new Response("preview target")
      },
    })
    const { server } = await startPasswordServer()
    const appOrigin = `http://localhost:${server.port}`
    const previewHost = `${target.port}.localhost:${server.port}`
    try {
      const login = await fetch(`${appOrigin}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: appOrigin },
        body: JSON.stringify({ password: "secret", next: "/" }),
      })
      const sessionCookie = extractCookie(login)
      const url = `${appOrigin}/__memosync/preview/${target.port}/script.js`

      const subresource = await fetch(url, {
        headers: {
          Host: previewHost,
          Cookie: sessionCookie,
          "Sec-Fetch-Dest": "script",
          "Sec-Fetch-Mode": "no-cors",
        },
        redirect: "manual",
      })
      expect(subresource.status).toBe(401)

      const navigation = await fetch(url, {
        headers: {
          Host: previewHost,
          Cookie: sessionCookie,
          "Sec-Fetch-Dest": "iframe",
          "Sec-Fetch-Mode": "navigate",
        },
        redirect: "manual",
      })
      expect(navigation.status).toBe(302)
      const bootstrap = new URL(navigation.headers.get("location")!)
      expect(bootstrap.origin).toBe(appOrigin)
      expect(bootstrap.pathname).toBe("/auth/preview-grant")
      expect(upstreamHits).toBe(0)
    } finally {
      target.stop(true)
      await server.stop()
    }
  })

  test("rejects the preview credential on MemoSync app APIs", async () => {
    const { server } = await startPasswordServer()
    const appOrigin = `http://localhost:${server.port}`
    try {
      const login = await fetch(`${appOrigin}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: appOrigin },
        body: JSON.stringify({ password: "secret", next: "/" }),
      })
      const cookie = extractCookie(login)
      // Mint a real preview credential, then prove it buys nothing on /api.
      const mint = await fetch(`${appOrigin}/api/preview-grants`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: appOrigin, Cookie: cookie },
        body: JSON.stringify({ port: 8901, next: "/" }),
      })
      expect(mint.status).toBe(200)
      const { url: callbackUrl } = await mint.json() as { url: string }
      const callback = await fetch(`${appOrigin}${new URL(callbackUrl).pathname}${new URL(callbackUrl).search}`, {
        headers: { Host: new URL(callbackUrl).host },
        redirect: "manual",
      })
      const previewCookie = extractCookie(callback)
      expect(previewCookie).toContain("memosync_preview=")

      const api = await fetch(`${appOrigin}/api/projects/project-1/uploads`, {
        headers: { Cookie: previewCookie },
        redirect: "manual",
      })
      expect(api.status).toBe(401)
      const ws = await fetch(`${appOrigin}/ws`, { headers: { Cookie: previewCookie } })
      expect(ws.status).toBe(401)
    } finally {
      await server.stop()
    }
  })

  test("bootstraps embedded host previews through a one-time preview credential", async () => {
    const seen: Array<{ path: string; cookie: string | null }> = []
    const target = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url)
        seen.push({ path: `${url.pathname}${url.search}`, cookie: req.headers.get("cookie") })
        return new Response("protected preview target")
      },
    })
    const { server } = await startPasswordServer()
    const appOrigin = `http://localhost:${server.port}`
    const previewHost = `${target.port}.localhost:${server.port}`
    const suffix = "/nested/a%20b?tab=files&next=%2Fother"
    try {
      const login = await fetch(`${appOrigin}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "secret", next: "/" }),
      })
      expect(login.headers.get("set-cookie")?.toLowerCase()).not.toContain("domain=")
      const sessionCookie = extractCookie(login)
      const browserRequest = (url: string, cookies: string | null, method = "GET") => {
        const parsed = new URL(url)
        const headers = new Headers({ Host: parsed.host, "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Mode": "navigate" })
        if (cookies) headers.set("Cookie", cookies)
        // Connect locally while retaining the browser URL's host and cookie scope.
        return fetch(`${appOrigin}${parsed.pathname}${parsed.search}`, { method, headers, redirect: "manual" })
      }

      // An iframe navigation on the isolated preview origin without the
      // preview credential bootstraps toward the app-origin grant instead of
      // failing with 401.
      const bootstrap = await browserRequest(`http://${previewHost}${suffix}`, null)
      expect(bootstrap.status).toBe(302)
      const grantUrl = new URL(bootstrap.headers.get("location")!)
      expect(grantUrl.origin).toBe(appOrigin)
      expect(grantUrl.pathname).toBe("/auth/preview-grant")
      expect(grantUrl.searchParams.get("port")).toBe(String(target.port))
      expect(grantUrl.searchParams.get("redirect")).toBe(`http://${previewHost}${suffix}`)
      expect(seen).toHaveLength(0)

      // The grant endpoint requires the app session and returns a one-time
      // callback URL on the isolated preview origin.
      expect((await fetch(`${appOrigin}${grantUrl.pathname}${grantUrl.search}`, { redirect: "manual" })).status).toBe(302)
      const granted = await fetch(`${appOrigin}${grantUrl.pathname}${grantUrl.search}`, {
        headers: { Cookie: sessionCookie },
        redirect: "manual",
      })
      expect(granted.status).toBe(302)
      const callbackUrl = new URL(granted.headers.get("location")!)
      expect(callbackUrl.host).toBe(previewHost)
      expect(callbackUrl.pathname).toBe("/__memosync/preview-callback")
      expect(callbackUrl.searchParams.get("ticket")).toBeTruthy()

      // The callback consumes the ticket, sets the host-only HttpOnly preview
      // cookie, and lands back on the original path.
      const callback = await browserRequest(callbackUrl.href, null)
      expect(callback.status).toBe(302)
      expect(callback.headers.get("location")).toBe(suffix)
      const setCookie = callback.headers.get("set-cookie") ?? ""
      expect(setCookie).toContain("memosync_preview=")
      expect(setCookie.toLowerCase()).not.toContain("domain=")
      expect(setCookie).toContain("HttpOnly")
      const previewCookie = setCookie.split(";", 1)[0]!

      // One-time: replaying the callback is rejected.
      expect((await browserRequest(callbackUrl.href, null)).status).toBe(401)

      // The preview credential — not the app session — unlocks the proxy on
      // the isolated host, for iframe navigations too.
      const content = await browserRequest(`http://${previewHost}${suffix}`, previewCookie)
      expect(content.status).toBe(200)
      expect(await content.text()).toBe("protected preview target")
      // The upstream project server sees neither reserved cookie.
      expect(seen).toEqual([{ path: suffix, cookie: null }])
    } finally {
      target.stop(true)
      await server.stop()
    }
  })

  test("binds the preview credential to its host, port, session, and boot", async () => {
    const targetA = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("a") })
    const targetB = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("b") })
    const { server } = await startPasswordServer()
    const appOrigin = `http://localhost:${server.port}`
    const hostA = `${targetA.port}.localhost:${server.port}`
    try {
      const login = await fetch(`${appOrigin}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: appOrigin },
        body: JSON.stringify({ password: "secret", next: "/" }),
      })
      const sessionCookie = extractCookie(login)

      // Mint a preview credential for target A via the app-origin API the
      // client uses for embedded frames.
      const mint = await fetch(`${appOrigin}/api/preview-grants`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: appOrigin, Cookie: sessionCookie },
        body: JSON.stringify({ port: targetA.port, next: "/" }),
      })
      expect(mint.status).toBe(200)
      const { url: mintedUrl } = await mint.json() as { url: string }
      const callbackUrl = new URL(mintedUrl)
      expect(callbackUrl.host).toBe(hostA)
      const callback = await fetch(`${appOrigin}${callbackUrl.pathname}${callbackUrl.search}`, {
        headers: { Host: hostA },
        redirect: "manual",
      })
      const previewCookie = (callback.headers.get("set-cookie") ?? "").split(";", 1)[0]!
      expect(previewCookie).toContain("memosync_preview=")

      const requestOn = (host: string, cookie: string | null) => fetch(`${appOrigin}/`, {
        headers: {
          Host: host,
          "Sec-Fetch-Dest": "iframe",
          "Sec-Fetch-Mode": "navigate",
          ...(cookie ? { Cookie: cookie } : {}),
        },
        redirect: "manual",
      })

      // Valid on its own host.
      expect((await requestOn(hostA, previewCookie)).status).toBe(200)
      // Rejected on another target port's host. On the app origin the preview
      // credential buys nothing: an app-origin preview path still redirects to
      // the isolated origin (and would need a session to mint a ticket).
      expect((await requestOn(`${targetB.port}.localhost:${server.port}`, previewCookie)).status).toBe(302)
      const appOriginPreview = await fetch(`${appOrigin}/__memosync/preview/${targetB.port}/`, {
        headers: {
          Cookie: previewCookie,
          "Sec-Fetch-Dest": "iframe",
          "Sec-Fetch-Mode": "navigate",
        },
        redirect: "manual",
      })
      expect(appOriginPreview.status).toBe(302)
      expect(new URL(appOriginPreview.headers.get("location")!).hostname).toBe(`${targetB.port}.localhost`)

      // Unauthenticated mint attempts and foreign-origin mints are refused.
      expect((await fetch(`${appOrigin}/api/preview-grants`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: appOrigin },
        body: JSON.stringify({ port: targetA.port, next: "/" }),
      })).status).toBe(401)
      expect((await fetch(`${appOrigin}/api/preview-grants`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://foreign.invalid", Cookie: sessionCookie },
        body: JSON.stringify({ port: targetA.port, next: "/" }),
      })).status).toBe(403)

      // Logout revokes grants bound to that session.
      await fetch(`${appOrigin}/auth/logout`, {
        method: "POST",
        headers: { Cookie: sessionCookie, Origin: appOrigin },
      })
      expect((await requestOn(hostA, previewCookie)).status).not.toBe(200)
    } finally {
      await server.stop()
    }

    // A restarted server (same password — session tokens survive by design)
    // rejects credentials signed by the previous boot's preview key.
    const targetC = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("c") })
    const { server: restarted } = await startPasswordServer()
    const restartedOrigin = `http://localhost:${restarted.port}`
    const freshHost = `${targetC.port}.localhost:${restarted.port}`
    try {
      const login2 = await fetch(`${restartedOrigin}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: restartedOrigin },
        body: JSON.stringify({ password: "secret", next: "/" }),
      })
      const sessionCookie2 = extractCookie(login2)
      const mint = await fetch(`${restartedOrigin}/api/preview-grants`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: restartedOrigin, Cookie: sessionCookie2 },
        body: JSON.stringify({ port: targetC.port, next: "/" }),
      })
      const { url: mintedUrl } = await mint.json() as { url: string }
      const callbackUrl = new URL(mintedUrl)
      expect(callbackUrl.host).toBe(freshHost)
      const callback = await fetch(`${restartedOrigin}${callbackUrl.pathname}${callbackUrl.search}`, {
        headers: { Host: freshHost },
        redirect: "manual",
      })
      const freshCookie = (callback.headers.get("set-cookie") ?? "").split(";", 1)[0]!
      const requestOn = (cookie: string) => fetch(`${restartedOrigin}/`, {
        headers: {
          Host: freshHost,
          Cookie: cookie,
          "Sec-Fetch-Dest": "iframe",
          "Sec-Fetch-Mode": "navigate",
        },
        redirect: "manual",
      })
      expect((await requestOn(freshCookie)).status).toBe(200)
      // Credentials signed before the restart (or outright forged) fail.
      const forged = `${targetC.port}.nonexistent-session-nonce.forged`
      expect((await requestOn(`memosync_preview=${forged}`)).status).toBe(302)
    } finally {
      targetA.stop(true)
      targetB.stop(true)
      targetC.stop(true)
      await restarted.stop()
    }
  })

  test("host-form preview mutations and upgrades require the preview credential", async () => {
    const seenCookies: Array<string | null> = []
    const target = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        seenCookies.push(req.headers.get("cookie"))
        return new Response("protected preview target")
      },
    })
    const { server } = await startPasswordServer()
    const appOrigin = `http://localhost:${server.port}`
    const host = `${target.port}.localhost:${server.port}`
    const previewUrl = `${appOrigin}/`
    try {
      const login = await fetch(`${appOrigin}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: appOrigin },
        body: JSON.stringify({ password: "secret", next: "/" }),
      })
      const sessionCookie = extractCookie(login)
      // Obtain a preview credential through the grant bootstrap.
      const mint = await fetch(`${appOrigin}/api/preview-grants`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: appOrigin, Cookie: sessionCookie },
        body: JSON.stringify({ port: target.port, next: "/" }),
      })
      const { url: mintedUrl } = await mint.json() as { url: string }
      const callback = await fetch(`${appOrigin}${new URL(mintedUrl).pathname}${new URL(mintedUrl).search}`, {
        headers: { Host: host },
        redirect: "manual",
      })
      const previewCookie = (callback.headers.get("set-cookie") ?? "").split(";", 1)[0]!

      for (const upgrade of [false, true]) {
        const method = upgrade ? "GET" : "POST"
        const headers = new Headers({ Host: host, Origin: `http://${host}` })
        if (upgrade) {
          headers.set("Connection", "Upgrade")
          headers.set("Upgrade", "websocket")
          headers.set("Sec-WebSocket-Version", "13")
          headers.set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
        }
        // No preview credential → 401 (no bootstrap for non-navigations).
        expect((await fetch(previewUrl, { method, headers, redirect: "manual" })).status).toBe(401)
        // The app session cookie alone does not unlock the preview host.
        headers.set("Cookie", `${sessionCookie}; project_session=kept`)
        expect((await fetch(previewUrl, { method, headers, redirect: "manual" })).status).toBe(401)
        // Foreign origins stay out even with the preview credential.
        headers.set("Cookie", `${previewCookie}; project_session=kept`)
        headers.set("Origin", "http://foreign.invalid")
        expect((await fetch(previewUrl, { method, headers, redirect: "manual" })).status).toBe(403)
        headers.set("Origin", `http://${host}`)
        const authenticated = await fetch(previewUrl, { method, headers, redirect: "manual" })
        expect(authenticated.status).toBe(200)
        expect(await authenticated.text()).toBe("protected preview target")
        expect(seenCookies.at(-1)).toBe("project_session=kept")
      }
    } finally {
      target.stop(true)
      await server.stop()
    }
  })

  test("invalidates a previous boot's preview credential on the same origin", async () => {
    const seen: string[] = []
    const target = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        seen.push(new URL(req.url).pathname)
        return new Response("preview target")
      },
    })
    const { server: first } = await startPasswordServer()
    const appPort = first.port
    const appOrigin = `http://localhost:${appPort}`
    const previewHost = `${target.port}.localhost:${appPort}`
    const requestPreview = (cookie: string) => fetch(`${appOrigin}/`, {
      headers: {
        Host: previewHost,
        Cookie: cookie,
        "Sec-Fetch-Dest": "iframe",
        "Sec-Fetch-Mode": "navigate",
      },
      redirect: "manual",
    })
    try {
      const login = await fetch(`${appOrigin}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: appOrigin },
        body: JSON.stringify({ password: "secret", next: "/" }),
      })
      const sessionCookie = extractCookie(login)
      const mint = await fetch(`${appOrigin}/api/preview-grants`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: appOrigin, Cookie: sessionCookie },
        body: JSON.stringify({ port: target.port, next: "/" }),
      })
      const { url: mintedUrl } = await mint.json() as { url: string }
      const callbackUrl = new URL(mintedUrl)
      const callback = await fetch(`${appOrigin}${callbackUrl.pathname}${callbackUrl.search}`, {
        headers: { Host: previewHost },
        redirect: "manual",
      })
      const oldPreviewCookie = extractCookie(callback)
      expect((await requestPreview(oldPreviewCookie)).status).toBe(200)
      await first.stop()

      const { server: restarted } = await startPasswordServer({ port: appPort })
      expect(restarted.port).toBe(appPort)
      // The old preview credential cannot cross a boot boundary even though
      // the stateless app session cookie still can.
      expect((await requestPreview(oldPreviewCookie)).status).toBe(302)
      expect(seen).toEqual(["/"])

      const remint = await fetch(`${appOrigin}/api/preview-grants`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: appOrigin, Cookie: sessionCookie },
        body: JSON.stringify({ port: target.port, next: "/" }),
      })
      expect(remint.status).toBe(200)
      const { url: remintedUrl } = await remint.json() as { url: string }
      const freshCallbackUrl = new URL(remintedUrl)
      const freshCallback = await fetch(`${appOrigin}${freshCallbackUrl.pathname}${freshCallbackUrl.search}`, {
        headers: { Host: previewHost },
        redirect: "manual",
      })
      const freshPreviewCookie = extractCookie(freshCallback)
      expect((await requestPreview(freshPreviewCookie)).status).toBe(200)
      expect(seen).toEqual(["/", "/"])
    } finally {
      target.stop(true)
      await first.stop().catch(() => {})
    }
  })

  test("keeps control-character login redirects on the app origin", async () => {
    const { server } = await startPasswordServer()
    const origin = `http://localhost:${server.port}`
    try {
      for (const control of ["%09", "%0A", "%0D"]) {
        const response = await fetch(`${origin}/auth/login?next=%2F${control}%2Fforeign.invalid`, { redirect: "manual" })
        expect(response.status).toBe(302)
        expect(response.headers.get("location")).toBe(`${origin}/`)
      }
    } finally {
      await server.stop()
    }
  })

  test("redirects /auth/login back into the app", async () => {
    const { server } = await startPasswordServer()

    try {
      const response = await fetch(`http://localhost:${server.port}/auth/login?next=%2Fchat%2Fdemo`, { redirect: "manual" })
      expect(response.status).toBe(302)
      expect(response.headers.get("location")).toBe(`http://localhost:${server.port}/chat/demo`)
    } finally {
      await server.stop()
    }
  })

  test("sets a session cookie after a successful login", async () => {
    const { server } = await startPasswordServer()

    try {
      const response = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Origin: `http://localhost:${server.port}`,
        },
      })

      expect(response.status).toBe(200)
      expect(extractCookie(response)).toContain("memosync_session=")
    } finally {
      await server.stop()
    }
  })

  test("rejects an invalid password", async () => {
    const { server } = await startPasswordServer()

    try {
      const response = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "wrong", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Origin: `http://localhost:${server.port}`,
        },
      })

      expect(response.status).toBe(401)
      expect(response.headers.get("set-cookie")).toBeNull()
    } finally {
      await server.stop()
    }
  })

  test("rejects cross-origin login attempts", async () => {
    const { server } = await startPasswordServer()

    try {
      const response = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret" }),
        headers: {
          "Content-Type": "application/json",
          Origin: "http://evil.test",
        },
      })

      expect(response.status).toBe(403)
    } finally {
      await server.stop()
    }
  })

  test("allows authenticated access to protected routes", async () => {
    const { server, project, projectDir } = await startPasswordServer()

    try {
      const attachment = await persistProjectUpload({
        projectId: project.id,
        localPath: projectDir,
        fileName: "hello.txt",
        bytes: new TextEncoder().encode("hello from upload"),
        fallbackMimeType: "text/plain",
      })

      const loginResponse = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Origin: `http://localhost:${server.port}`,
        },
      })
      const cookie = extractCookie(loginResponse)

      const healthResponse = await fetch(`http://localhost:${server.port}/health`, {
        headers: {
          Cookie: cookie,
        },
      })
      expect(healthResponse.status).toBe(200)

      const contentResponse = await fetch(`http://localhost:${server.port}${attachment.contentUrl}`, {
        headers: {
          Cookie: cookie,
        },
      })
      expect(contentResponse.status).toBe(200)
      expect(await contentResponse.text()).toBe("hello from upload")
    } finally {
      await server.stop()
    }
  })

  test("ignores forwarded proto when trustProxy is off", async () => {
    const { server } = await startPasswordServer()

    try {
      const response = await fetch(`http://localhost:${server.port}/auth/login?next=%2F`, {
        redirect: "manual",
        headers: {
          "X-Forwarded-Proto": "https",
        },
      })
      expect(response.status).toBe(302)
      expect(response.headers.get("location")).toBe(`http://localhost:${server.port}/`)

      const loginResponse = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.test",
          "X-Forwarded-Proto": "https",
        },
      })
      expect(loginResponse.status).toBe(403)

      const goodLoginResponse = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Origin: `http://localhost:${server.port}`,
          "X-Forwarded-Proto": "https",
        },
      })
      expect(goodLoginResponse.status).toBe(200)
      const cookieHeader = goodLoginResponse.headers.get("set-cookie") ?? ""
      expect(cookieHeader).not.toContain("Secure")
    } finally {
      await server.stop()
    }
  })

  test("honors forwarded proto when trustProxy is on", async () => {
    const { server } = await startPasswordServer({ trustProxy: true })

    try {
      const redirect = await fetch(`http://localhost:${server.port}/auth/login?next=%2F`, {
        redirect: "manual",
        headers: {
          "X-Forwarded-Proto": "https",
        },
      })
      expect(redirect.status).toBe(302)
      expect(redirect.headers.get("location")).toBe(`https://localhost:${server.port}/`)

      const loginResponse = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Origin: `https://localhost:${server.port}`,
          "X-Forwarded-Proto": "https",
        },
      })
      expect(loginResponse.status).toBe(200)
      expect(loginResponse.headers.get("set-cookie") ?? "").toContain("Secure")

      const evilResponse = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Origin: `http://localhost:${server.port}`,
        },
      })
      expect(evilResponse.status).toBe(200)
    } finally {
      await server.stop()
    }
  })

  test("ignores invalid forwarded proto values", async () => {
    const { server } = await startPasswordServer({ trustProxy: true })

    try {
      const redirect = await fetch(`http://localhost:${server.port}/auth/login?next=%2F`, {
        redirect: "manual",
        headers: {
          "X-Forwarded-Proto": "ftp",
        },
      })
      expect(redirect.status).toBe(302)
      expect(redirect.headers.get("location")).toBe(`http://localhost:${server.port}/`)

      const loginResponse = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Origin: `http://localhost:${server.port}`,
          "X-Forwarded-Proto": "ftp",
        },
      })
      expect(loginResponse.status).toBe(200)
      expect(loginResponse.headers.get("set-cookie") ?? "").not.toContain("Secure")
    } finally {
      await server.stop()
    }
  })

  test("clears the session cookie on logout", async () => {
    const { server } = await startPasswordServer()

    try {
      const loginResponse = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Origin: `http://localhost:${server.port}`,
        },
      })
      const cookie = extractCookie(loginResponse)

      const logoutResponse = await fetch(`http://localhost:${server.port}/auth/logout`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: `http://localhost:${server.port}`,
        },
      })

      expect(logoutResponse.status).toBe(200)
      expect(logoutResponse.headers.get("set-cookie")).toContain("Max-Age=0")

      const healthResponse = await fetch(`http://localhost:${server.port}/health`, {
        headers: {
          Cookie: cookie,
        },
      })
      expect(healthResponse.status).toBe(200)
    } finally {
      await server.stop()
    }
  })
})

describe("api origin protection", () => {
  test("rejects foreign-origin API mutations even when password auth is disabled", async () => {
    const server = await startNoPasswordServer()
    const url = `http://localhost:${server.port}/api/memories/merge-duplicates`

    try {
      const foreignResponse = await fetch(url, {
        method: "POST",
        body: "{}",
        headers: {
          "Content-Type": "text/plain",
          Origin: "https://evil.example",
        },
      })
      expect(foreignResponse.status).toBe(403)

      const sameOriginResponse = await fetch(url, {
        method: "POST",
        body: "{}",
        headers: {
          "Content-Type": "text/plain",
          Origin: `http://localhost:${server.port}`,
        },
      })
      expect(sameOriginResponse.status).toBe(400)
    } finally {
      await server.stop()
    }
  }, 15_000)
})
