import { describe, expect, it } from "bun:test"
import type { LocalHttpServerInfo } from "../../shared/protocol"
import { canKillLocalHttpServer, localServerPreviewUrl, manualBrowserAddressUrl } from "./localServerPreview"

const proxiedServer: LocalHttpServerInfo = {
  title: "Vite",
  address: "http://localhost:5173",
  port: 5173,
  status: 200,
  preferProxy: true,
}

describe("localServerPreviewUrl", () => {
  it("hides process termination when the server marks a study preview as managed", () => {
    expect(canKillLocalHttpServer({ ...proxiedServer, canKill: false })).toBe(false)
    expect(canKillLocalHttpServer(proxiedServer)).toBe(true)
  })

  it("uses the authenticated same-origin path when a proxied server is opened through a loopback gateway", () => {
    expect(localServerPreviewUrl(proxiedServer, new URL("http://127.0.0.1:4300/chat"))).toBe(
      "http://127.0.0.1:4300/__memosync/preview/5173/",
    )
  })

  it("uses a same-origin path proxy when the app is reached through a public HTTPS origin", () => {
    expect(localServerPreviewUrl(proxiedServer, new URL("https://memosync.example.com/chat"))).toBe(
      "https://memosync.example.com/__memosync/preview/5173/",
    )
  })

  it("keeps the discovered direct address outside Docker proxy mode", () => {
    expect(localServerPreviewUrl({ ...proxiedServer, preferProxy: false }, new URL("https://memosync.example.com"))).toBe(
      "http://localhost:5173",
    )
  })
})

describe("manualBrowserAddressUrl", () => {
  it("uses the same-origin path for a manual localhost address in discovered proxy mode", () => {
    expect(manualBrowserAddressUrl(
      "localhost:8080",
      new URL("http://localhost:4300/chat"),
      true,
    )).toBe("http://localhost:4300/__memosync/preview/8080/")
  })

  it("rewrites a manually entered localhost port on a public deployment", () => {
    expect(manualBrowserAddressUrl("localhost:8080", new URL("https://memosync.example.com/chat"))).toBe(
      "https://memosync.example.com/__memosync/preview/8080/",
    )
  })

  it("preserves the path, query, and hash of a manually entered loopback URL", () => {
    expect(manualBrowserAddressUrl(
      "http://127.0.0.1:8080/dashboard?tab=run#details",
      new URL("https://memosync.example.com/chat"),
    )).toBe("https://memosync.example.com/__memosync/preview/8080/dashboard?tab=run#details")
  })

  it("rewrites a saved localhost-subdomain proxy URL when reopened remotely", () => {
    expect(manualBrowserAddressUrl(
      "http://8080.localhost:3210/dashboard",
      new URL("https://memosync.example.com/chat"),
    )).toBe("https://memosync.example.com/__memosync/preview/8080/dashboard")
  })

  it("keeps direct localhost navigation when MemoSync itself is local", () => {
    expect(manualBrowserAddressUrl("localhost:8080", new URL("http://localhost:3210/chat"))).toBe(
      "http://localhost:8080",
    )
  })

  it("normalizes an ordinary manually entered hostname without proxying it", () => {
    expect(manualBrowserAddressUrl("example.com/path", new URL("https://memosync.example.com/chat"))).toBe(
      "http://example.com/path",
    )
  })
})
