import { describe, it, expect } from "bun:test"
import { isolatedPreviewTarget } from "../shared/preview-proxy"
import { previewProxyTarget, proxyPreviewRequest } from "./preview-proxy"

function reqWithHost(host: string, url = "http://x/", init?: RequestInit): Request {
  const req = new Request(url, init)
  req.headers.set("host", host)
  return req
}

describe("preview proxy", () => {
  it.each(["host", "path"] as const)("isolates reserved MemoSync cookies in both directions for %s previews", async (form) => {
    const url = form === "host"
      ? "http://8901.localhost:3210/"
      : "http://localhost:3210/__memosync/preview/8901/"
    const req = reqWithHost(new URL(url).host, url, {
      headers: { Cookie: "memosync_session=secret; project_session=kept; memosync_session=duplicate; memosync_preview=grant; memosync_session_extra=also-kept" },
    })
    const projectCookie = "project_session=new; Path=/; Expires=Wed, 21 Oct 2037 07:28:00 GMT; HttpOnly"
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("cookie")).toBe("project_session=kept; memosync_session_extra=also-kept")
      const headers = new Headers()
      headers.append("Set-Cookie", "memosync_session=overwrite; Path=/; HttpOnly")
      headers.append("Set-Cookie", "memosync_preview=planted; Path=/; HttpOnly")
      headers.append("Set-Cookie", projectCookie)
      headers.append("Set-Cookie", "memosync_session=; Domain=localhost; Path=/; Max-Age=0")
      headers.append("Set-Cookie", "memosync_preview=; Domain=localhost; Path=/; Max-Age=0")
      headers.append("Set-Cookie", "memosync_session_extra=project-owned; Path=/")
      return new Response("ok", { headers })
    }) as typeof fetch
    const response = await proxyPreviewRequest(req, new URL(url), 8901, fetchImpl)
    expect(response.status).toBe(200)
    expect(response.headers.getSetCookie()).toEqual([projectCookie, "memosync_session_extra=project-owned; Path=/"])
  })

  it("omits Cookie upstream when only the MemoSync session is present", async () => {
    const req = reqWithHost("8901.localhost:3210", "http://8901.localhost:3210/", {
      headers: { Cookie: "memosync_session=secret" },
    })
    let cookie: string | null | undefined
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      cookie = new Headers(init?.headers).get("cookie")
      return new Response("ok")
    }) as typeof fetch
    await proxyPreviewRequest(req, new URL(req.url), 8901, fetchImpl)
    expect(cookie).toBeNull()
  })

  it("recognizes <port>.localhost hosts and nothing else", () => {
    expect(previewProxyTarget(reqWithHost("8901.localhost:3210"), 3210)).toBe(8901)
    expect(previewProxyTarget(reqWithHost("5173.localhost"), 3210)).toBe(5173)
    expect(previewProxyTarget(reqWithHost("localhost:3210"), 3210)).toBeNull()
    expect(previewProxyTarget(reqWithHost("evil.com"), 3210)).toBeNull()
    expect(previewProxyTarget(reqWithHost("8901.evil.com"), 3210)).toBeNull()
    expect(previewProxyTarget(reqWithHost("0.localhost"), 3210)).toBeNull()
    expect(previewProxyTarget(reqWithHost("99999.localhost"), 3210)).toBeNull()
    // Never proxy to ourselves — that would loop.
    expect(previewProxyTarget(reqWithHost("3210.localhost:3210"), 3210)).toBeNull()
  })

  it("recognizes a same-origin preview path on a public host", () => {
    const req = reqWithHost(
      "memosync.example.com",
      "https://memosync.example.com/__memosync/preview/8901/app/page?x=1",
    )
    expect(previewProxyTarget(req, 3210)).toBe(8901)
  })

  it("requires HTTPS or loopback for a configured public preview origin", () => {
    const req = new Request("https://memosync.example.com/__memosync/preview/8901/app")
    expect(isolatedPreviewTarget(req, 8901, "http://preview.example.com", "/app?x=1")).toBeNull()
    expect(isolatedPreviewTarget(req, 8901, "https://preview.example.com", "/app?x=1")).toEqual({
      origin: "https://preview.example.com",
      host: "preview.example.com",
      path: "/__memosync/preview/8901/app?x=1",
    })
    expect(isolatedPreviewTarget(req, 8901, "http://127.0.0.1:3211", "/app")).toEqual({
      origin: "http://127.0.0.1:3211",
      host: "127.0.0.1:3211",
      path: "/__memosync/preview/8901/app",
    })
  })

  it("forwards to 127.0.0.1:<port>, strips frame-blocking headers, rewrites absolute redirects", async () => {
    const seen: Array<{ url: string; host: string | null }> = []
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      seen.push({ url: String(input), host: headers.get("host") })
      return new Response("ok", {
        status: 200,
        headers: {
          "x-frame-options": "DENY",
          "content-security-policy": "frame-ancestors 'none'",
          "x-custom": "kept",
        },
      })
    }) as typeof fetch
    const req = reqWithHost("8901.localhost:3210", "http://8901.localhost:3210/app/page?x=1")
    const res = await proxyPreviewRequest(req, new URL(req.url), 8901, fetchImpl)

    expect(seen[0]!.url).toBe("http://127.0.0.1:8901/app/page?x=1")
    expect(seen[0]!.host).toBe("localhost:8901")
    expect(res.status).toBe(200)
    expect(res.headers.get("x-frame-options")).toBeNull()
    expect(res.headers.get("content-security-policy")).toBeNull()
    expect(res.headers.get("x-custom")).toBe("kept")

    // Absolute self-redirects must stay on the proxy origin.
    const redirecting = (async () =>
      new Response(null, { status: 302, headers: { location: "http://localhost:8901/login" } })) as unknown as typeof fetch
    const res2 = await proxyPreviewRequest(req, new URL(req.url), 8901, redirecting)
    expect(res2.headers.get("location")).toBe("/login")
  })

  it("strips the public proxy prefix upstream and keeps redirects inside it", async () => {
    const seen: string[] = []
    const fetchImpl = (async (input: string | URL | Request) => {
      seen.push(String(input))
      return new Response(null, { status: 302, headers: { location: "/login" } })
    }) as typeof fetch
    const req = reqWithHost(
      "memosync.example.com",
      "https://memosync.example.com/__memosync/preview/8901/app/page?x=1",
    )
    const res = await proxyPreviewRequest(req, new URL(req.url), 8901, fetchImpl)

    expect(seen).toEqual(["http://127.0.0.1:8901/app/page?x=1"])
    expect(res.headers.get("location")).toBe("/__memosync/preview/8901/login")
  })

  it("keeps URL-bearing HTML and module syntax inside the public proxy without changing other strings", async () => {
    const req = reqWithHost(
      "memosync.example.com",
      "https://memosync.example.com/__memosync/preview/5173/",
    )
    const html = [
      "<!doctype html><html><head></head><body>",
      '<img src="/images/hero.png">',
      '<script type="module" src="/@vite/client"></script>',
      '<script type="module">import "/src/main.tsx"; const business = "/"; fetch("/api/items")</script>',
      "</body></html>",
    ].join("")
    const fetchImpl = (async () => new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" },
    })) as unknown as typeof fetch

    const res = await proxyPreviewRequest(req, new URL(req.url), 5173, fetchImpl)
    const body = await res.text()

    expect(body).toContain('<base href="/__memosync/preview/5173/">')
    expect(body).toContain('src="/__memosync/preview/5173/@vite/client"')
    expect(body).toContain('src="/__memosync/preview/5173/images/hero.png"')
    expect(body).toContain('patchUrlProperty(HTMLImageElement.prototype, "src")')
    expect(body).toContain("HTMLImageElement.prototype.setAttribute")
    expect(body).toContain('/(^|,\\s*)(\\/(?!\\/)[^\\s,]+)/g')
    expect(body).toContain('import "/__memosync/preview/5173/src/main.tsx"')
    expect(body).toContain('const business = "/"')
    expect(body).toContain('fetch("/api/items")')
    expect(body).toContain('data-memosync-preview-mode="manual-refresh"')
  })

  it("adapts module URLs and BrowserRouter at their syntax boundaries", async () => {
    const req = reqWithHost(
      "memosync.example.com",
      "https://memosync.example.com/__memosync/preview/5173/src/main.tsx",
    )
    const javascript = [
      'import "/src/style.css";',
      'import { BrowserRouter } from "/node_modules/.vite/deps/react-router-dom.js";',
      'const business = "/";',
      'jsxDEV(BrowserRouter, {children: jsxDEV(App, {})});',
    ].join("\n")
    const fetchImpl = (async () => new Response(javascript, {
      headers: { "content-type": "text/javascript" },
    })) as unknown as typeof fetch

    const res = await proxyPreviewRequest(req, new URL(req.url), 5173, fetchImpl)
    const body = await res.text()

    expect(body).toContain('import "/__memosync/preview/5173/src/style.css"')
    expect(body).toContain('from "/__memosync/preview/5173/node_modules/.vite/deps/react-router-dom.js"')
    expect(body).toContain('const business = "/"')
    expect(body).toContain('jsxDEV(BrowserRouter, {basename:"/__memosync/preview/5173",children:')
  })

  it("recognizes an aliased BrowserRouter without rewriting route literals", async () => {
    const req = reqWithHost(
      "memosync.example.com",
      "https://memosync.example.com/__memosync/preview/5173/src/main.tsx",
    )
    const javascript = [
      'import { BrowserRouter as Router } from "/node_modules/.vite/deps/react-router-dom.js";',
      'const homeRoute = "/";',
      'jsxDEV(Router, {children: jsxDEV(Route, {path: homeRoute})});',
    ].join("\n")
    const fetchImpl = (async () => new Response(javascript, {
      headers: { "content-type": "text/javascript" },
    })) as unknown as typeof fetch

    const res = await proxyPreviewRequest(req, new URL(req.url), 5173, fetchImpl)
    const body = await res.text()

    expect(body).toContain('jsxDEV(Router, {basename:"/__memosync/preview/5173",children:')
    expect(body).toContain('const homeRoute = "/"')
  })

  it("serves a no-WebSocket Vite compatibility client for explicit manual refresh", async () => {
    const req = reqWithHost(
      "memosync.example.com",
      "https://memosync.example.com/__memosync/preview/5173/@vite/client",
    )
    const upstream = 'new WebSocket("ws://localhost:5173"); export function createHotContext() {}'
    const fetchImpl = (async () => new Response(upstream, {
      headers: { "content-type": "text/javascript" },
    })) as unknown as typeof fetch

    const res = await proxyPreviewRequest(req, new URL(req.url), 5173, fetchImpl)
    const body = await res.text()

    expect(res.headers.get("x-memosync-preview-update-mode")).toBe("manual-refresh")
    expect(body).toContain("export function createHotContext")
    expect(body).not.toContain("WebSocket")
  })

  it("a dead target answers with a friendly 502, never throws", async () => {
    const failing = (async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch
    const req = reqWithHost("8901.localhost:3210", "http://8901.localhost:3210/")
    const res = await proxyPreviewRequest(req, new URL(req.url), 8901, failing)
    expect(res.status).toBe(502)
    expect(await res.text()).toContain("port 8901")
  })

  it("bounds a target that accepts the request but never answers", async () => {
    let sawAbortSignal = false
    const hanging = ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      sawAbortSignal = signal instanceof AbortSignal
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
    })) as typeof fetch
    const req = reqWithHost("8901.localhost:3210", "http://8901.localhost:3210/")

    const res = await proxyPreviewRequest(req, new URL(req.url), 8901, hanging, 5)

    expect(sawAbortSignal).toBe(true)
    expect(res.status).toBe(502)
    expect(await res.text()).toContain("Nothing is answering on port 8901")
  })
})
