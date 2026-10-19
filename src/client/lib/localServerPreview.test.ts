import { describe, expect, it } from "bun:test"
import type { LocalHttpServerInfo } from "../../shared/protocol"
import { canKillLocalHttpServer, isProxiedPreviewAddress, localServerPreviewUrl, manualBrowserAddressUrl } from "./localServerPreview"

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

  it.each([
    "http://localhost:4300/chat",
    "http://127.0.0.1:4300/chat",
  ])("routes loopback browsers through the isolated proxy host for %s", (location) => {
    for (const preferProxy of [true, false]) {
      const server = { ...proxiedServer, preferProxy }
      expect(localServerPreviewUrl(server, new URL(location))).toBe(
        `${new URL(location).protocol}//5173.localhost:4300/`,
      )
    }
  })

  it("uses a same-origin path proxy when the app is reached through a public HTTPS origin", () => {
    expect(localServerPreviewUrl(proxiedServer, new URL("https://memosync.example.com/chat"))).toBe(
      "https://memosync.example.com/__memosync/preview/5173/",
    )
  })

  it("keeps the discovered direct address for a remote browser without proxy mode", () => {
    expect(localServerPreviewUrl({ ...proxiedServer, preferProxy: false }, new URL("https://memosync.example.com"))).toBe(
      "http://localhost:5173",
    )
  })
})

describe("manualBrowserAddressUrl", () => {
  it("routes a manual localhost address through the isolated proxy host locally", () => {
    expect(manualBrowserAddressUrl(
      "localhost:8080",
      new URL("http://localhost:4300/chat"),
      true,
    )).toBe("http://8080.localhost:4300/")
  })

  it("routes loopback URLs through the isolated proxy host even outside proxy mode", () => {
    expect(manualBrowserAddressUrl("localhost:8080", new URL("http://localhost:3210/chat"))).toBe(
      "http://8080.localhost:3210/",
    )
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
    expect(manualBrowserAddressUrl(
      "http://127.0.0.1:8080/dashboard?tab=run#details",
      new URL("http://localhost:4300/chat"),
    )).toBe("http://8080.localhost:4300/dashboard?tab=run#details")
  })

  it("rebases a saved localhost-subdomain proxy URL to the current app port", () => {
    expect(manualBrowserAddressUrl(
      "http://8080.localhost:3210/dashboard",
      new URL("http://localhost:4300/chat"),
    )).toBe("http://8080.localhost:4300/dashboard")
    expect(manualBrowserAddressUrl(
      "http://8080.localhost:3210/dashboard",
      new URL("https://memosync.example.com/chat"),
    )).toBe("https://memosync.example.com/__memosync/preview/8080/dashboard")
  })

  it("leaves a manual app-port address alone", () => {
    expect(manualBrowserAddressUrl("localhost:3210/chat/demo", new URL("http://localhost:3210/chat"))).toBe(
      "http://localhost:3210/chat/demo",
    )
  })

  it("normalizes an ordinary manually entered hostname without proxying it", () => {
    expect(manualBrowserAddressUrl("example.com/path", new URL("https://memosync.example.com/chat"))).toBe(
      "http://example.com/path",
    )
  })
})

describe("isProxiedPreviewAddress", () => {
  const local = new URL("http://localhost:4300/chat")
  it("recognizes isolated host-form and same-origin path-form previews", () => {
    expect(isProxiedPreviewAddress("http://8080.localhost:4300/", local)).toBe(true)
    expect(isProxiedPreviewAddress("http://localhost:4300/__memosync/preview/8080/x", local)).toBe(true)
    expect(isProxiedPreviewAddress("http://localhost:4300/chat", local)).toBe(false)
    expect(isProxiedPreviewAddress("http://8080.localhost:9999/", local)).toBe(false)
    expect(isProxiedPreviewAddress("https://other.example/__memosync/preview/8080/", local)).toBe(false)
    expect(isProxiedPreviewAddress("http://example.com/", local)).toBe(false)
  })
})
