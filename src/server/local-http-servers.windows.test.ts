import { expect, test } from "bun:test"
import { listListeningTcpEntries, parseWindowsListeningEntries } from "./local-http-servers"

test("Windows listener records deduplicate IPv4/IPv6 owners and reject invalid ports", () => {
  expect(parseWindowsListeningEntries(`
  TCP  0.0.0.0:43210   0.0.0.0:0   LISTENING  25
  TCP  [::]:43210     [::]:0      LISTENING  25
  TCP  127.0.0.1:12   127.0.0.1:43210 ESTABLISHED 30
  TCP  0.0.0.0:65536  0.0.0.0:0   LISTENING  26
  TCP  0.0.0.0:10     0.0.0.0:0   LISTENING  0
  UDP  0.0.0.0:20     *:*         31
  `)).toEqual([{ port: 43210, owners: [{ command: "PID 25", pid: 25 }] }])
})

test.skipIf(process.platform !== "win32")("discovers a real Windows loopback listener and its process", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("synthetic") })
  try {
    const entry = (await listListeningTcpEntries()).find(entry => entry.port === server.port)
    expect(entry?.owners.some(owner => owner.pid === process.pid)).toBe(true)
  } finally { server.stop(true) }
}, 15_000)
