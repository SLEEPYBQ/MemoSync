import { PREVIEW_PROXY_PATH_PREFIX, previewProxyPath } from "../shared/preview-proxy"

// Dev-server preview proxy. In Docker, an agent can start a server on ANY
// container port (8901, 5000, …) — publishing port ranges can never cover
// that, so the app server itself proxies to 127.0.0.1:<targetPort>.
//
// A browser on the Docker host uses http://<targetPort>.localhost:<appPort>.
// A browser reaching MemoSync through Cloudflare / SSH cannot use localhost
// (that would be the participant's computer), so it uses the same app origin:
//   /__memosync/preview/<targetPort>/...
// Text responses on the path form adapt URL-bearing syntax so root-relative
// assets and module imports remain inside that prefix. Ordinary JavaScript
// strings are deliberately left untouched.
//
// WebSocket upgrades are not passed through. Vite's HMR client is replaced by
// a small compatibility module, making manual Browser Refresh the explicit
// update mode while preserving normal module and CSS rendering.

const HOST_PATTERN = /^(\d{1,5})\.localhost(?::\d+)?$/i
const PATH_PATTERN = new RegExp(`^${PREVIEW_PROXY_PATH_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(\\d{1,5})(?:/|$)`)
const DEFAULT_PREVIEW_UPSTREAM_TIMEOUT_MS = 15_000

function validTargetPort(port: number, selfPort: number) {
  return Number.isInteger(port) && port > 0 && port <= 65535 && port !== selfPort
}

function pathProxyBase(targetPort: number) {
  return previewProxyPath(targetPort)
}

function isPathProxyRequest(url: URL, targetPort: number) {
  const base = pathProxyBase(targetPort)
  return url.pathname === base.slice(0, -1) || url.pathname.startsWith(base)
}

export function isPathPreviewProxyRequest(req: Request, targetPort: number) {
  return isPathProxyRequest(new URL(req.url), targetPort)
}

function stripPathProxyPrefix(pathname: string, targetPort: number) {
  const base = pathProxyBase(targetPort)
  if (pathname === base.slice(0, -1)) return "/"
  const stripped = pathname.slice(base.length - 1)
  return stripped.startsWith("/") ? stripped : `/${stripped}`
}

/** The target port encoded in the request's Host, or null when this is not a
 * preview-proxy request. `selfPort` guards against proxying to ourselves. */
export function previewProxyTarget(req: Request, selfPort: number): number | null {
  const host = req.headers.get("host") ?? ""
  const match = host.match(HOST_PATTERN)
  if (match) {
    const port = Number(match[1])
    return validTargetPort(port, selfPort) ? port : null
  }

  const pathMatch = new URL(req.url).pathname.match(PATH_PATTERN)
  if (!pathMatch) return null
  const port = Number(pathMatch[1])
  return validTargetPort(port, selfPort) ? port : null
}

/** Build the client-facing proxy origin for a target port (used in tests;
 * the client derives it from window.location at runtime). */
export function previewProxyOrigin(targetPort: number, appHostWithPort: string): string {
  return `http://${targetPort}.localhost${appHostWithPort.includes(":") ? `:${appHostWithPort.split(":")[1]}` : ""}`
}

const HOP_BY_HOP = ["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-authenticate", "proxy-authorization", "te", "trailer"]

function rootRelativeUrl(url: string, targetPort: number) {
  const base = pathProxyBase(targetPort)
  if (!url.startsWith("/") || url.startsWith("//") || url.startsWith(base)) return url
  return `${base.slice(0, -1)}${url}`
}

function rewriteTargetOrigin(body: string, targetPort: number) {
  const baseWithoutSlash = pathProxyBase(targetPort).slice(0, -1)
  const targetOrigin = new RegExp(`(?:https?:)?//(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0):${targetPort}(?=/)`, "gi")
  return body.replace(targetOrigin, baseWithoutSlash)
}

function browserRouterIdentifiers(source: string) {
  const identifiers = new Set<string>(["BrowserRouter"])
  const imports = source.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*["'][^"']*react-router(?:-dom)?[^"']*["']/g)
  for (const match of imports) {
    for (const imported of (match[1] ?? "").split(",")) {
      const browserRouter = imported.match(/^\s*BrowserRouter(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/)
      if (browserRouter) identifiers.add(browserRouter[1] ?? "BrowserRouter")
    }
  }
  return identifiers
}

function rewriteJavaScriptUrls(body: string, targetPort: number, upstreamPathname: string) {
  const base = pathProxyBase(targetPort)
  const routerIdentifiers = browserRouterIdentifiers(body)
  let rewritten = rewriteTargetOrigin(body, targetPort)

  // Only ECMAScript module specifiers are rewritten. The old implementation
  // changed every quoted root-relative string, including Router defaults.
  rewritten = rewritten.replace(
    /(\b(?:from|import)\s*(?:\(\s*)?)(["'])(\/(?!\/|__memosync\/preview\/)[^"'\r\n]*)(\2)/g,
    (_match, prefix: string, quote: string, url: string) => `${prefix}${quote}${rootRelativeUrl(url, targetPort)}${quote}`,
  )
  rewritten = rewritten.replace(
    /(\bimport\s+)(["'])(\/(?!\/|__memosync\/preview\/)[^"'\r\n]*)(\2)/g,
    (_match, prefix: string, quote: string, url: string) => `${prefix}${quote}${rootRelativeUrl(url, targetPort)}${quote}`,
  )

  // Vite turns imported static assets into tiny URL modules.
  rewritten = rewritten.replace(
    /(\bexport\s+default\s+)(["'])(\/(?!\/|__memosync\/preview\/)[^"'\r\n]*)(\2)/g,
    (_match, prefix: string, quote: string, url: string) => `${prefix}${quote}${rootRelativeUrl(url, targetPort)}${quote}`,
  )

  // BrowserRouter must know the public mount point. Adapt the application call
  // site rather than changing its route literals or dependency source.
  if (!upstreamPathname.includes("/node_modules/") && !upstreamPathname.startsWith("/@")) {
    for (const identifier of routerIdentifiers) {
      const escapedIdentifier = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      rewritten = rewritten.replace(
        new RegExp(`(\\b(?:jsxDEV|jsx|jsxs)\\(\\s*${escapedIdentifier}\\s*,\\s*\\{)(?!\\s*basename\\s*:)`, "g"),
        `$1basename:${JSON.stringify(base.slice(0, -1))},`,
      )
    }
  }

  return rewritten
}

function manualRefreshViteClient() {
  return `
const styles = new Map();
export class ErrorOverlay extends HTMLElement {}
export function createHotContext() {
  const noop = () => {};
  return { accept: noop, acceptExports: noop, decline: noop, dispose: noop, prune: noop, invalidate: noop, on: noop, off: noop, send: noop };
}
export function injectQuery(url) { return url; }
export function updateStyle(id, content) {
  let style = styles.get(id);
  if (!style) {
    style = document.createElement("style");
    style.setAttribute("data-vite-dev-id", id);
    document.head.appendChild(style);
    styles.set(id, style);
  }
  style.textContent = content;
}
export function removeStyle(id) {
  const style = styles.get(id);
  if (style) style.remove();
  styles.delete(id);
}
`
}

function previewBootstrap(targetPort: number) {
  const baseWithoutSlash = pathProxyBase(targetPort).slice(0, -1)
  const pathPrefix = PREVIEW_PROXY_PATH_PREFIX
  return `<script data-memosync-preview-mode="manual-refresh">
window.__MEMOSYNC_PREVIEW_UPDATE_MODE__ = "manual-refresh";
{
  const previewBase = ${JSON.stringify(baseWithoutSlash)};
  const previewPathPrefix = ${JSON.stringify(pathPrefix)};
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"]);
  const rewritePreviewUrl = (raw) => {
    if (typeof raw !== "string") return raw;
    if (raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith(previewBase + "/")) {
      return previewBase + raw;
    }
    try {
      const parsed = new URL(raw, location.href);
      if (parsed.origin === location.origin) {
        const alreadyInsidePreview = parsed.pathname === previewBase || parsed.pathname.startsWith(previewBase + "/");
        if (parsed.pathname.startsWith("/") && !alreadyInsidePreview) {
          return location.origin + previewBase + parsed.pathname + parsed.search + parsed.hash;
        }
        return raw;
      }
      if (loopbackHosts.has(parsed.hostname.toLowerCase()) && parsed.port) {
        const port = Number(parsed.port);
        if (Number.isInteger(port) && port > 0 && port <= 65535) {
          return location.origin + previewPathPrefix + "/" + port + parsed.pathname + parsed.search + parsed.hash;
        }
      }
    } catch {
      // Preserve malformed or non-URL application values for the native API.
    }
    return raw;
  };
  const nativeFetch = window.fetch.bind(window);
  const nativeXhrOpen = XMLHttpRequest.prototype.open;
  const nativePushState = history.pushState.bind(history);
  const nativeReplaceState = history.replaceState.bind(history);
  const nativeGetAttribute = Element.prototype.getAttribute;
  const nativeSetAttribute = Element.prototype.setAttribute;
  const rewritePreviewSrcset = (raw) => raw.replace(
    /(^|,\\s*)(\\/(?!\\/)[^\\s,]+)/g,
    (_match, separator, url) => separator + rewritePreviewUrl(url),
  );
  const patchUrlProperty = (prototype, property) => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
    if (!descriptor || !descriptor.get || !descriptor.set) return;
    Object.defineProperty(prototype, property, {
      ...descriptor,
      get: descriptor.get,
      set(value) { descriptor.set.call(this, rewritePreviewUrl(String(value))); },
    });
  };
  patchUrlProperty(HTMLScriptElement.prototype, "src");
  patchUrlProperty(HTMLLinkElement.prototype, "href");
  patchUrlProperty(HTMLImageElement.prototype, "src");
  HTMLImageElement.prototype.setAttribute = function(name, value) {
    if (typeof name === "string" && name.toLowerCase() === "src") value = rewritePreviewUrl(String(value));
    if (typeof name === "string" && name.toLowerCase() === "srcset") value = rewritePreviewSrcset(String(value));
    return nativeSetAttribute.call(this, name, value);
  };
  // Turbopack keys loaded chunks by document.currentScript.getAttribute("src")
  // and compares that value with its logical /_next/... resolver paths. Keep
  // the real property/network URL mounted, but expose the upstream path to
  // runtime code so registration and Flight chunk requests share one identity.
  HTMLScriptElement.prototype.getAttribute = function(name) {
    const value = nativeGetAttribute.call(this, name);
    if (typeof name !== "string" || name.toLowerCase() !== "src" || typeof value !== "string") return value;
    return value.startsWith(previewBase + "/") ? value.slice(previewBase.length) : value;
  };
  HTMLScriptElement.prototype.setAttribute = function(name, value) {
    if (typeof name === "string" && name.toLowerCase() === "src") value = rewritePreviewUrl(String(value));
    return nativeSetAttribute.call(this, name, value);
  };
  history.pushState = (state, unused, url) => nativePushState(state, unused, url == null ? url : rewritePreviewUrl(String(url)));
  history.replaceState = (state, unused, url) => nativeReplaceState(state, unused, url == null ? url : rewritePreviewUrl(String(url)));
  document.addEventListener("click", (event) => {
    const target = event.target;
    const anchor = target instanceof Element ? target.closest("a[href]") : null;
    if (!anchor) return;
    const href = anchor.getAttribute("href");
    if (href) anchor.setAttribute("href", rewritePreviewUrl(href));
  }, true);
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    if (typeof url === "string") url = rewritePreviewUrl(url);
    else if (url instanceof URL) url = new URL(rewritePreviewUrl(url.href));
    return nativeXhrOpen.call(this, method, url, ...rest);
  };
  window.fetch = (input, init) => {
    if (typeof input === "string") {
      input = rewritePreviewUrl(input);
    } else if (input instanceof URL) {
      input = new URL(rewritePreviewUrl(input.href));
    } else if (input instanceof Request) {
      const rewritten = rewritePreviewUrl(input.url);
      if (rewritten !== input.url) input = new Request(rewritten, input);
    }
    return nativeFetch(input, init);
  };
}
</script>`
}

function rewritePathProxyText(body: string, targetPort: number, contentType: string, upstreamPathname: string) {
  const base = pathProxyBase(targetPort)
  let rewritten = rewriteTargetOrigin(body, targetPort)
  const normalizedContentType = contentType.toLowerCase()

  if (normalizedContentType.includes("javascript")) {
    return rewriteJavaScriptUrls(rewritten, targetPort, upstreamPathname)
  }

  if (normalizedContentType.includes("css")) {
    rewritten = rewritten.replace(/(url\(\s*["']?)\/(?!\/|__memosync\/preview\/)/gi, `$1${base}`)
  }

  if (normalizedContentType.includes("text/html")) {
    rewritten = rewritten.replace(
      /(<script\b[^>]*\btype\s*=\s*["']module["'][^>]*>)([\s\S]*?)(<\/script>)/gi,
      (_match, open: string, script: string, close: string) => `${open}${rewriteJavaScriptUrls(script, targetPort, upstreamPathname)}${close}`,
    )
    const headContent = `<base href="${base}">${previewBootstrap(targetPort)}`
    if (/<meta\s+[^>]*charset\s*=\s*["']?[^\s"'>]+["']?[^>]*>/i.test(rewritten)) {
      rewritten = rewritten.replace(
        /<meta\s+[^>]*charset\s*=\s*["']?[^\s"'>]+["']?[^>]*>/i,
        (meta) => `${meta}${headContent}`,
      )
    } else if (/<head(?:\s[^>]*)?>/i.test(rewritten)) {
      rewritten = rewritten.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${headContent}`)
    } else {
      rewritten = `${headContent}${rewritten}`
    }
    // Keep anchor href values untouched until hydration. Rewriting those in
    // server HTML makes frameworks such as Next compare a prefixed server href
    // with their original client prop. The capture listener above protects a
    // native anchor navigation; URL-bearing asset/form attributes are safe to
    // adapt before the framework starts.
    rewritten = rewritten.replace(
      /(\b(?:src|action|poster)\s*=\s*["'])\/(?!\/|__memosync\/preview\/)/gi,
      `$1${base}`,
    )
    rewritten = rewritten.replace(
      /(<link\b[^>]*\bhref\s*=\s*["'])\/(?!\/|__memosync\/preview\/)/gi,
      `$1${base}`,
    )
  }

  return rewritten
}

function shouldRewritePathProxyBody(contentType: string) {
  const normalized = contentType.toLowerCase()
  return normalized.startsWith("text/")
    || normalized.includes("javascript")
    || normalized.includes("json")
    || normalized.includes("xml")
    || normalized.includes("svg")
}

function rewritePathProxyLocation(location: string, targetPort: number) {
  const base = pathProxyBase(targetPort)
  const absoluteTarget = new RegExp(`^https?://(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0):${targetPort}`, "i")
  const targetRelative = location.replace(absoluteTarget, "") || "/"
  if (targetRelative.startsWith(base)) return targetRelative
  if (targetRelative.startsWith("/")) return `${base.slice(0, -1)}${targetRelative}`
  return targetRelative
}

export async function proxyPreviewRequest(
  req: Request,
  url: URL,
  targetPort: number,
  fetchImpl: typeof fetch = fetch,
  upstreamTimeoutMs = DEFAULT_PREVIEW_UPSTREAM_TIMEOUT_MS,
): Promise<Response> {
  const pathProxy = isPathProxyRequest(url, targetPort)
  const upstreamPathname = pathProxy ? stripPathProxyPrefix(url.pathname, targetPort) : url.pathname
  const headers = new Headers(req.headers)
  headers.set("host", `localhost:${targetPort}`)
  // fetch decodes the body; forwarding the original encoding headers would lie.
  headers.delete("accept-encoding")
  for (const h of HOP_BY_HOP) headers.delete(h)
  try {
    const upstreamSignal = AbortSignal.any([
      req.signal,
      AbortSignal.timeout(upstreamTimeoutMs),
    ])
    const res = await fetchImpl(`http://127.0.0.1:${targetPort}${upstreamPathname}${url.search}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      redirect: "manual",
      signal: upstreamSignal,
    })
    const out = new Headers(res.headers)
    // The pane iframes this from another origin — frame-blocking headers from
    // the dev server would blank it. This is a local dev preview, not a
    // hosting surface.
    out.delete("x-frame-options")
    out.delete("content-security-policy")
    // Body arrives decoded/re-chunked from fetch; drop stale envelope headers.
    out.delete("content-encoding")
    out.delete("content-length")
    for (const h of HOP_BY_HOP) out.delete(h)
    // A dev server redirecting to its own absolute localhost URL would escape
    // the proxy — rewrite to origin-relative so the browser stays on the
    // proxy origin.
    const location = out.get("location")
    if (location) {
      if (pathProxy) {
        out.set("location", rewritePathProxyLocation(location, targetPort))
      } else {
        const rewritten = location.replace(new RegExp(`^https?://(?:localhost|127\\.0\\.0\\.1):${targetPort}`, "i"), "")
        out.set("location", rewritten || "/")
      }
    }

    let body: BodyInit | null = res.body
    const contentType = out.get("content-type") ?? ""
    if (pathProxy && res.body && shouldRewritePathProxyBody(contentType)) {
      if (upstreamPathname === "/@vite/client") {
        body = manualRefreshViteClient()
        out.set("x-memosync-preview-update-mode", "manual-refresh")
      } else {
        body = rewritePathProxyText(await res.text(), targetPort, contentType, upstreamPathname)
      }
    }
    return new Response(body, { status: res.status, statusText: res.statusText, headers: out })
  } catch {
    return new Response(
      `<!doctype html><meta charset="utf-8"><title>Preview unavailable</title><body style="font-family:system-ui;color:#667085;background:#fafafa;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center;max-width:32rem;padding:0 1.5rem"><p style="font-size:15px;margin:0 0 .5rem">Nothing is answering on port ${targetPort} right now.</p><p style="font-size:13px;margin:0">The server may have stopped — start it again (for example from the app terminal) and reload this pane.</p></div>`,
      { status: 502, headers: { "content-type": "text/html; charset=utf-8" } },
    )
  }
}
