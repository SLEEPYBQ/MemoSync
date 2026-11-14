import { expect, test } from "bun:test"
import { listListeningTcpEntries, parseWindowsListeningEntries } from "./local-http-servers"

test("Windows listener records deduplicate IPv4/IPv6 owners and reject invalid ports", () => {
  expect(parseWindowsListeningEntries(JSON.stringify([
    { port: 43210, pid: 25, command: "synthetic-bun" }, { port: 43210, pid: 25, command: "synthetic-bun" },
    { port: 65536, pid: 26 }, { port: 10, pid: 0 },
  ]))).toEqual([{ port: 43210, owners: [{ command: "synthetic-bun", pid: 25 }] }])
})

test.skipIf(process.platform !== "win32")("discovers a real Windows loopback listener and its process", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("synthetic") })
  try {
    const entry = (await listListeningTcpEntries()).find(entry => entry.port === server.port)
    expect(entry?.owners.some(owner => owner.pid === process.pid)).toBe(true)
  } finally { server.stop(true) }
}, 15_000)
