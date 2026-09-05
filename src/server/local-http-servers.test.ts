import { describe, expect, test } from "bun:test"
import {
  buildProcListeningEntries,
  extractHtmlTitle,
  filterLocalHttpServers,
  isDescendantPid,
  isPathWithin,
  listLocalHttpServers,
  mergeListeningTcpEntries,
  parseLsofListeningEntries,
  parseLsofListeningPorts,
  parseProcNetListeningSockets,
} from "./local-http-servers"

describe("local http servers", () => {
  test("extracts html titles", () => {
    expect(extractHtmlTitle("<html><head><title> Vite App </title></head></html>")).toBe("Vite App")
    expect(extractHtmlTitle("<html></html>")).toBe("")
  })

  test("parses listening tcp ports from lsof output", () => {
    const output = `
COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
node    12345 jake   23u  IPv4 123456      0t0  TCP *:5174 (LISTEN)
bun     12346 jake   23u  IPv4 123457      0t0  TCP localhost:3210 (LISTEN)
other   12347 jake   23u  IPv4 123458      0t0  TCP 127.0.0.1:8080 (LISTEN)
    `

    expect(parseLsofListeningPorts(output)).toEqual([3210, 5174, 8080])
    expect(parseLsofListeningEntries(output)).toEqual([
      { port: 3210, owners: [{ command: "bun", pid: 12346 }] },
      { port: 5174, owners: [{ command: "node", pid: 12345 }] },
      { port: 8080, owners: [{ command: "other", pid: 12347 }] },
    ])
  })

  test("supplements incomplete lsof discovery from Linux proc socket owners", () => {
    const procNet = `
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 18724774 1
   1: 00000000000000000000000000000000:0BB9 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 18779318 1
   2: 0100007F:B31C 0100007F:0BB8 06 00000000:00000000 03:000002BA 00000000 0 0 99999999 3
    `
    const sockets = parseProcNetListeningSockets(procNet)
    expect(sockets).toEqual([
      { inode: "18724774", port: 3000 },
      { inode: "18779318", port: 3001 },
    ])

    const procEntries = buildProcListeningEntries(sockets, [
      { pid: 1821, command: "next-server", socketInodes: ["18724774"] },
      { pid: 351, command: "node", socketInodes: ["18779318"] },
    ])
    expect(mergeListeningTcpEntries([
      { port: 3210, owners: [{ command: "bun", pid: 1 }] },
    ], procEntries)).toEqual([
      { port: 3000, owners: [{ command: "next-server", pid: 1821 }] },
      { port: 3001, owners: [{ command: "node", pid: 351 }] },
      { port: 3210, owners: [{ command: "bun", pid: 1 }] },
    ])
  })

  test("detects project paths", () => {
    expect(isPathWithin("/tmp/project", "/tmp/project")).toBe(true)
    expect(isPathWithin("/tmp/project", "/tmp/project/app")).toBe(true)
    expect(isPathWithin("/tmp/project", "/tmp/project-other")).toBe(false)
  })

  test("detects descendant processes", () => {
    const parentByPid = new Map([
      [20, 10],
      [30, 20],
      [40, 1],
    ])

    expect(isDescendantPid(30, new Set([10]), parentByPid)).toBe(true)
    expect(isDescendantPid(40, new Set([10]), parentByPid)).toBe(false)
  })

  test("filters internal responders without collapsing duplicate page titles", () => {
    expect(filterLocalHttpServers([
      { title: "localhost:3211", address: "http://localhost:3211", port: 3211, status: 404, ownerPath: "/tmp/app", processName: "bun", sameProject: true },
      { title: "Superwall Agents", address: "http://localhost:5174", port: 5174, status: 200, ownerPath: "/tmp/app", processName: "node", sameProject: true },
      { title: "Superwall Agents", address: "http://localhost:5175", port: 5175, status: 200, ownerPath: "/tmp/app", processName: "node", sameProject: true },
      { title: "Superwall Agents", address: "http://localhost:8787", port: 8787, status: 200, ownerPath: "/tmp/app", processName: "workerd", sameProject: true },
      { title: "Welcome to nginx!", address: "http://localhost:8080", port: 8080, status: 200, ownerPath: "/opt/homebrew", processName: "nginx", sameProject: false },
      { title: "wterm-demo", address: "http://localhost:5003", port: 5003, status: 200, ownerPath: "/tmp/wterm", processName: "node", sameProject: false },
    ])).toEqual([
      { title: "Superwall Agents", address: "http://localhost:5174", port: 5174, status: 200, ownerPath: "/tmp/app", processName: "node", sameProject: true },
      { title: "Superwall Agents", address: "http://localhost:5175", port: 5175, status: 200, ownerPath: "/tmp/app", processName: "node", sameProject: true },
      { title: "wterm-demo", address: "http://localhost:5003", port: 5003, status: 200, ownerPath: "/tmp/wterm", processName: "node", sameProject: false },
    ])
  })

  test("does not hide a cold server behind the positive-result cache window", async () => {
    let fetchCalls = 0
    const listeningEntries = async () => [{
      port: 31337,
      owners: [{ command: "node", pid: 991_337 }],
    }]
    const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) => {
      fetchCalls += 1
      if (fetchCalls === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
        })
      }
      return Promise.resolve(new Response("<title>Apartment rentals</title>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }))
    }) as typeof fetch
    const options = {
      fetchImpl,
      projectPath: "/workspace/apartment-cold-start-regression",
      projectTerminalRootPids: [991_337],
      listEntries: listeningEntries,
      probeTimeoutMs: 5,
    }

    expect(await listLocalHttpServers(options)).toEqual([])
    expect(await listLocalHttpServers(options)).toEqual([
      expect.objectContaining({
        port: 31337,
        title: "Apartment rentals",
        sameProject: true,
      }),
    ])
    expect(fetchCalls).toBe(2)
  })

  test("does not cache a partial scan while the frontend is still compiling", async () => {
    let frontendReady = false
    const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
      const port = Number(new URL(String(input)).port)
      if (port === 31338) {
        return Promise.resolve(new Response("<title>Nest API</title>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }))
      }
      if (frontendReady) {
        return Promise.resolve(new Response("<title>Apartment frontend</title>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }))
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      })
    }) as typeof fetch
    const options = {
      fetchImpl,
      projectPath: "/workspace/apartment-mixed-cold-start",
      projectTerminalRootPids: [991_338, 991_339],
      listEntries: async () => [
        { port: 31338, owners: [{ command: "node", pid: 991_338 }] },
        { port: 31339, owners: [{ command: "node", pid: 991_339 }] },
      ],
      probeTimeoutMs: 5,
    }

    expect((await listLocalHttpServers(options)).map((server) => server.port)).toEqual([31338])
    frontendReady = true
    expect((await listLocalHttpServers(options)).map((server) => server.port)).toEqual([31338, 31339])
  })
})
