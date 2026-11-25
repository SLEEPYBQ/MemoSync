import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { connect } from "node:net"
import { networkInterfaces, tmpdir } from "node:os"
import path from "node:path"
import { startMemoSyncServer, authorizeMemoSyncRequest, isLoopbackBindHost, isLoopbackClientAddress, listRemoteAccessLanUrls, remoteAccessLanAddressRank } from "./server"
import { DEVICE_TOKEN_PREFIX, formatPairingCode } from "./devices"
import type { ClientCommand } from "../shared/protocol"

const tempDirs: string[] = []
const liveServers: Array<{ stop: () => Promise<void> }> = []

afterEach(async () => {
  await Promise.all(liveServers.splice(0).map((server) => server.stop().catch(() => {})))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function startRemoteAccessServer(options: {
  password?: string
  host?: string
  persistedRemoteAccess?: boolean
  remoteAccess?: boolean
  corruptDevicesFile?: boolean
} = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "memosync-remote-access-data-"))
  tempDirs.push(dataDir)
  if (options.corruptDevicesFile) {
    await writeFile(path.join(dataDir, "devices.json"), "{not-json", "utf8")
  }
  if (options.persistedRemoteAccess !== undefined) {
    await writeFile(path.join(dataDir, "settings.json"), JSON.stringify({
      remoteAccess: { enabled: options.persistedRemoteAccess },
    }))
  }
  const server = await startMemoSyncServer({
    dataDir,
    port: 0,
    strictPort: true,
    discoverProjects: () => [],
    ...(options.password ? { password: options.password } : {}),
    ...(options.host ? { host: options.host } : {}),
    ...(options.remoteAccess !== undefined ? { remoteAccess: options.remoteAccess } : {}),
  })
  liveServers.push(server)
  return { server, dataDir, baseUrl: `http://127.0.0.1:${server.port}` }
}

function extractCookie(response: Response) {
  const header = response.headers.get("set-cookie")
  expect(header).toBeTruthy()
  return header!.split(";", 1)[0]
}

function firstLanIpv4() {
  for (const entries of Object.values(networkInterfaces())) {
    const address = entries?.find((entry) => entry.family === "IPv4" && !entry.internal)?.address
    if (address) return address
  }
  return null
}

const HTML_NAVIGATION_HEADERS = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

async function pairDevice(baseUrl: string, authHeaders: Record<string, string> = {}) {
  const created = await fetch(`${baseUrl}/api/pairing/requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceName: "Test Phone" }),
  })
  expect(created.status).toBe(201)
  const { requestId, code } = await created.json() as { requestId: string; code: string }

  const pending = await fetch(`${baseUrl}/api/pairing/pending`, { headers: authHeaders })
  expect(pending.status).toBe(200)
  const pendingPayload = await pending.json() as { requests: Array<{ id: string; deviceName: string; code: string }> }
  expect(pendingPayload.requests).toContainEqual(expect.objectContaining({
    id: requestId,
    deviceName: "Test Phone",
    code,
  }))

  const wrongCode = await fetch(`${baseUrl}/api/pairing/requests/${requestId}/status?code=000000000000`)
  expect(wrongCode.status).toBe(404)

  const approved = await fetch(`${baseUrl}/api/pairing/requests/${requestId}/approve`, {
    method: "POST",
    headers: authHeaders,
  })
  expect(approved.status).toBe(200)
  const approvedPayload = await approved.json() as { device: { id: string; name: string } }
  expect(approvedPayload.device).toMatchObject({ name: "Test Phone" })
  expect(approvedPayload.device).not.toHaveProperty("token")
  expect(approvedPayload.device).not.toHaveProperty("tokenHash")

  const status = await fetch(`${baseUrl}/api/pairing/requests/${requestId}/status?code=${encodeURIComponent(formatPairingCode(code).toLowerCase())}`)
  expect(status.status).toBe(200)
  const statusPayload = await status.json() as { status: string; token?: string }
  expect(statusPayload.status).toBe("approved")
  expect(statusPayload.token).toMatch(new RegExp(`^${DEVICE_TOKEN_PREFIX}[0-9a-f]{48}$`))
  return { requestId, code, device: approvedPayload.device, token: statusPayload.token! }
}

async function login(baseUrl: string) {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl },
    body: JSON.stringify({ password: "secret", next: "/" }),
  })
  expect(response.status).toBe(200)
  return extractCookie(response)
}

function createWebSocketWithHeaders(url: string, headers: Record<string, string>) {
  // With DOM lib enabled TypeScript selects the browser constructor, while
  // Bun's runtime constructor also accepts a headers option.
  const BunWebSocket = WebSocket as unknown as new (
    url: string,
    options: { headers: Record<string, string> },
  ) => WebSocket
  return new BunWebSocket(url, { headers })
}

function waitForWebSocketOpen(ws: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket open timed out")), 5_000)
    ws.addEventListener("open", () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
    ws.addEventListener("error", () => {
      clearTimeout(timer)
      reject(new Error("WebSocket failed to open"))
    }, { once: true })
  })
}

function waitForWebSocketClose(ws: WebSocket) {
  return new Promise<CloseEvent>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket close timed out")), 5_000)
    ws.addEventListener("close", (event) => {
      clearTimeout(timer)
      resolve(event)
    }, { once: true })
  })
}

/** Speaks one raw HTTP/1.1 exchange over TCP so tests control framing exactly
 * (chunked bodies, declared content-length) instead of what fetch normalizes. */
function rawHttpExchange(port: number, requestText: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = connect({ port, host: "127.0.0.1" })
    let received = ""
    socket.setEncoding("utf8")
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error("raw http exchange timed out"))
    }, 5_000)
    socket.on("connect", () => socket.write(requestText))
    socket.on("data", (chunk) => { received += chunk })
    socket.on("close", () => {
      clearTimeout(timer)
      resolve(received)
    })
    socket.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

type WsCommandResponse = {
  type?: string
  id?: string
  message?: string
  result?: unknown
}

function sendWsCommand(ws: WebSocket, id: string, command: ClientCommand) {
  const response = new Promise<WsCommandResponse>((resolve, reject) => {
    const timer = setTimeout(() => finish(() => reject(new Error(`command ${id} timed out`))), 5_000)
    const finish = (callback: () => void) => {
      clearTimeout(timer)
      ws.removeEventListener("message", onMessage)
      ws.removeEventListener("close", onClose)
      callback()
    }
    const onMessage = (event: MessageEvent) => {
      void (async () => {
        try {
          const raw = typeof event.data === "string"
            ? event.data
            : event.data instanceof Blob
              ? await event.data.text()
              : String(event.data)
          const payload = JSON.parse(raw) as WsCommandResponse
          if (payload.id !== id) return
          finish(() => resolve(payload))
        } catch (error) {
          finish(() => reject(error))
        }
      })()
    }
    const onClose = () => finish(() => reject(new Error(`WebSocket closed before command ${id} answered`)))
    ws.addEventListener("message", onMessage)
    ws.addEventListener("close", onClose)
  })
  ws.send(JSON.stringify({
    v: 1,
    type: "command",
    id,
    command,
  }))
  return response
}

async function writeRemoteAccessSetting(baseUrl: string, enabled: boolean, headers: Record<string, string> = {}) {
  const ws = createWebSocketWithHeaders(`${baseUrl.replace(/^http/, "ws")}/ws`, headers)
  await waitForWebSocketOpen(ws)
  try {
    const payload = await sendWsCommand(ws, `write-remote-access-${enabled}`, {
      type: "settings.writeAppSettingsPatch",
      patch: { remoteAccess: { enabled } },
    })
    if (payload.type !== "ack") {
      throw new Error(payload.message ?? "settings write failed")
    }
  } finally {
    ws.close()
  }
}

describe("remote access authorization decision", () => {
  test("ranks RFC1918 LAN addresses before VPN and other non-private ranges", () => {
    for (const privateAddress of ["10.0.0.8", "172.16.0.8", "172.31.255.8", "192.168.1.8"]) {
      expect(remoteAccessLanAddressRank(privateAddress)).toBe(0)
    }
    for (const otherAddress of ["172.15.0.8", "172.32.0.8", "100.64.0.8", "198.18.0.8", "203.0.113.8"]) {
      expect(remoteAccessLanAddressRank(otherAddress)).toBe(1)
    }
    expect(remoteAccessLanAddressRank("not-an-ip")).toBe(2)
    expect(remoteAccessLanAddressRank("198.18.0.8")).toBeGreaterThan(remoteAccessLanAddressRank("192.168.1.8"))
  })

  test("sorts one url per interface with RFC1918 LAN addresses before VPN fake-ip ranges", () => {
    const interfaceEntry = (address: string) => ({
      address,
      netmask: "255.255.255.0",
      family: "IPv4" as const,
      mac: "00:00:00:00:00:00",
      internal: false,
      cidr: `${address}/24`,
    })
    const urls = listRemoteAccessLanUrls(3210, {
      vpn0: [interfaceEntry("198.18.0.2")],
      lan0: [interfaceEntry("192.168.1.20"), interfaceEntry("10.0.0.20")],
      overlay0: [interfaceEntry("100.64.0.2")],
    })

    expect(urls).toEqual([
      "http://192.168.1.20:3210",
      "http://198.18.0.2:3210",
      "http://100.64.0.2:3210",
    ])
  })

  test("keeps loopback open without a password but never opens non-loopback without credentials", () => {
    expect(isLoopbackClientAddress("127.0.0.1")).toBe(true)
    expect(isLoopbackClientAddress("127.255.255.255")).toBe(true)
    expect(isLoopbackClientAddress("::1")).toBe(true)
    expect(isLoopbackClientAddress("::ffff:127.0.0.1")).toBe(true)
    expect(isLoopbackClientAddress("192.168.1.20")).toBe(false)
    expect(isLoopbackBindHost("127.0.0.1")).toBe(true)
    expect(isLoopbackBindHost("localhost")).toBe(true)
    expect(isLoopbackBindHost("0.0.0.0")).toBe(false)

    expect(authorizeMemoSyncRequest({
      isLoopbackClient: true,
      passwordAuthEnabled: false,
      sessionAuthenticated: false,
      deviceAuthenticated: false,
    })).toBe(true)
    expect(authorizeMemoSyncRequest({
      isLoopbackClient: false,
      passwordAuthEnabled: false,
      sessionAuthenticated: false,
      deviceAuthenticated: false,
    })).toBe(false)
    expect(authorizeMemoSyncRequest({
      isLoopbackClient: true,
      passwordAuthEnabled: true,
      sessionAuthenticated: false,
      deviceAuthenticated: false,
    })).toBe(false)
    expect(authorizeMemoSyncRequest({
      isLoopbackClient: false,
      passwordAuthEnabled: true,
      sessionAuthenticated: true,
      deviceAuthenticated: false,
    })).toBe(true)
    expect(authorizeMemoSyncRequest({
      isLoopbackClient: false,
      passwordAuthEnabled: false,
      sessionAuthenticated: false,
      deviceAuthenticated: true,
    })).toBe(true)
  })
})

describe("remote access HTTP integration", () => {
  test("lets the loopback host approve pairing without a password session and reports the bind state", async () => {
    const { baseUrl, server } = await startRemoteAccessServer({ persistedRemoteAccess: true })

    const statusBefore = await fetch(`${baseUrl}/api/remote-access/status`)
    expect(statusBefore.status).toBe(200)
    const statusPayload = await statusBefore.json() as {
      enabled: boolean
      active: boolean
      bindHost: string
      lanUrls: string[]
    }
    expect(statusPayload.enabled).toBe(true)
    expect(statusPayload.active).toBe(true)
    expect(statusPayload.bindHost).toBe("0.0.0.0")
    expect(Array.isArray(statusPayload.lanUrls)).toBe(true)

    const lanAddress = firstLanIpv4()
    if (lanAddress) {
      // Connecting to our own LAN address still arrives as a non-loopback
      // client, so the no-password loopback exemption must not apply.
      const lanBaseUrl = `http://${lanAddress}:${server.port}`
      const unauthenticatedDevices = await fetch(`${lanBaseUrl}/api/devices`)
      expect(unauthenticatedDevices.status).toBe(401)
      const unauthenticatedUpgrade = await fetch(`${lanBaseUrl}/ws`)
      expect(unauthenticatedUpgrade.status).toBe(401)

      // Pairing creation is the deliberate unauthenticated exception: a LAN
      // device must be able to ask for approval before it has any credential.
      const lanPairing = await fetch(`${lanBaseUrl}/api/pairing/requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceName: "LAN Probe" }),
      })
      expect(lanPairing.status).toBe(201)
      const { requestId: lanRequestId } = await lanPairing.json() as { requestId: string }
      const denyLanProbe = await fetch(`${baseUrl}/api/pairing/requests/${lanRequestId}/deny`, { method: "POST" })
      expect(denyLanProbe.status).toBe(200)
    }

    const paired = await pairDevice(baseUrl)
    const devices = await fetch(`${baseUrl}/api/devices`)
    expect(devices.status).toBe(200)
    const payload = await devices.json() as { devices: Array<Record<string, unknown>> }
    expect(payload.devices).toHaveLength(1)
    expect(payload.devices[0]).toMatchObject({ id: paired.device.id, name: "Test Phone" })
    expect(payload.devices[0]).not.toHaveProperty("token")
    expect(payload.devices[0]).not.toHaveProperty("tokenHash")
  })

  test("serves a passwordless LAN navigation interstitial while loopback and paired devices reach the app shell", async () => {
    const { baseUrl, server } = await startRemoteAccessServer({ persistedRemoteAccess: true })

    const loopback = await fetch(`${baseUrl}/`, { headers: HTML_NAVIGATION_HEADERS })
    expect(loopback.status).toBe(200)
    const loopbackHtml = await loopback.text()
    expect(loopbackHtml).toContain('<div id="root"')
    expect(loopbackHtml).not.toContain("data-memosync-access-interstitial")

    const lanAddress = firstLanIpv4()
    if (!lanAddress) return
    const lanBaseUrl = `http://${lanAddress}:${server.port}`
    const unauthenticated = await fetch(`${lanBaseUrl}/`, { headers: HTML_NAVIGATION_HEADERS })
    // 403 is deliberate: the response is an authorization interstitial, not
    // the application shell, even though browsers render its explanatory HTML.
    expect(unauthenticated.status).toBe(403)
    const interstitialHtml = await unauthenticated.text()
    expect(interstitialHtml).toContain("data-memosync-access-interstitial")
    expect(interstitialHtml).toContain("Pair the mobile app using the pairing flow on the host")
    expect(interstitialHtml).not.toContain('<div id="root"')

    // Navigation detection must not swallow static assets, even when their
    // request is artificially given a document-like Accept header.
    const asset = await fetch(`${lanBaseUrl}/icon-192.png`, { headers: HTML_NAVIGATION_HEADERS })
    expect(asset.status).toBe(200)
    expect(asset.headers.get("content-type")).toContain("image/png")

    const paired = await pairDevice(baseUrl)
    const deviceNavigation = await fetch(`${lanBaseUrl}/`, {
      headers: { ...HTML_NAVIGATION_HEADERS, Authorization: `Bearer ${paired.token}` },
    })
    expect(deviceNavigation.status).toBe(200)
    expect(await deviceNavigation.text()).toContain('<div id="root"')
  })

  test("does not intercept LAN navigations when password auth can show the app sign-in wall", async () => {
    const { server } = await startRemoteAccessServer({ password: "secret", persistedRemoteAccess: true })
    const lanAddress = firstLanIpv4()
    if (!lanAddress) return

    const response = await fetch(`http://${lanAddress}:${server.port}/`, { headers: HTML_NAVIGATION_HEADERS })
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('<div id="root"')
    expect(html).not.toContain("data-memosync-access-interstitial")
  })

  test("honors an explicit loopback host override while reporting that remote access is not active", async () => {
    const { baseUrl } = await startRemoteAccessServer({ persistedRemoteAccess: true, host: "127.0.0.1" })
    const response = await fetch(`${baseUrl}/api/remote-access/status`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      enabled: true,
      active: false,
      bindHost: "127.0.0.1",
    })
  })

  test("rejects pairing creation while remote access is disabled", async () => {
    const { baseUrl } = await startRemoteAccessServer()
    const response = await fetch(`${baseUrl}/api/pairing/requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceName: "Test Phone" }),
    })
    expect(response.status).toBe(403)

    const status = await fetch(`${baseUrl}/api/remote-access/status`)
    expect(await status.json()).toMatchObject({
      enabled: false,
      active: false,
      bindHost: "127.0.0.1",
    })
  })

  test("starts with an empty device list after quarantining a corrupt devices file", async () => {
    const logger = spyOn(console, "error").mockImplementation(() => {})
    let started!: Awaited<ReturnType<typeof startRemoteAccessServer>>
    try {
      started = await startRemoteAccessServer({ corruptDevicesFile: true })
    } finally {
      logger.mockRestore()
    }

    const devices = await fetch(`${started.baseUrl}/api/devices`)
    expect(devices.status).toBe(200)
    expect(await devices.json()).toEqual({ devices: [] })
    expect((await readdir(started.dataDir)).some((name) => name.startsWith("devices.json.corrupt-"))).toBe(true)
  })

  test("allows pairing on an explicit non-loopback bind even when the setting was never enabled", async () => {
    const { baseUrl } = await startRemoteAccessServer({ host: "0.0.0.0" })
    const pairing = await fetch(`${baseUrl}/api/pairing/requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceName: "CLI Bind Phone" }),
    })
    expect(pairing.status).toBe(201)
    const status = await fetch(`${baseUrl}/api/remote-access/status`)
    expect(await status.json()).toMatchObject({
      enabled: false,
      active: true,
      bindHost: "0.0.0.0",
    })
  })

  test("stops device tokens and pairing once effective remote access becomes false on a loopback bind", async () => {
    const { baseUrl } = await startRemoteAccessServer({ password: "secret", persistedRemoteAccess: true, host: "127.0.0.1" })
    const cookie = await login(baseUrl)
    const authHeaders = { Cookie: cookie }
    const paired = await pairDevice(baseUrl, authHeaders)
    const deviceHeaders = { Authorization: `Bearer ${paired.token}` }
    // Password auth closes the loopback exemption, so this 200 can only come
    // from the device bearer token rather than from the loopback client address.
    expect((await fetch(`${baseUrl}/api/remote-access/status`, { headers: deviceHeaders })).status).toBe(200)

    await writeRemoteAccessSetting(baseUrl, false, authHeaders)

    expect((await fetch(`${baseUrl}/api/remote-access/status`, { headers: deviceHeaders })).status).toBe(401)
    const pairing = await fetch(`${baseUrl}/api/pairing/requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceName: "Too Late" }),
    })
    expect(pairing.status).toBe(403)
    const pairingStatus = await fetch(`${baseUrl}/api/pairing/requests/${paired.requestId}/status?code=${encodeURIComponent(paired.code)}`)
    expect(pairingStatus.status).toBe(403)
  })

  test("keeps device tokens and pairing effective while a non-loopback bind remains after the setting is disabled", async () => {
    const { baseUrl } = await startRemoteAccessServer({ password: "secret", persistedRemoteAccess: true })
    const cookie = await login(baseUrl)
    const authHeaders = { Cookie: cookie }
    const paired = await pairDevice(baseUrl, authHeaders)
    const deviceHeaders = { Authorization: `Bearer ${paired.token}` }

    await writeRemoteAccessSetting(baseUrl, false, authHeaders)

    expect((await fetch(`${baseUrl}/api/remote-access/status`, { headers: deviceHeaders })).status).toBe(200)
    const pairing = await fetch(`${baseUrl}/api/pairing/requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceName: "Still Bind-Exposed" }),
    })
    expect(pairing.status).toBe(201)
    const status = await fetch(`${baseUrl}/api/remote-access/status`, { headers: authHeaders })
    expect(await status.json()).toMatchObject({
      enabled: false,
      active: true,
      bindHost: "0.0.0.0",
    })
  })

  test("accepts a device token on HTTP and WebSocket, then revokes it and closes the live socket", async () => {
    const { baseUrl, server } = await startRemoteAccessServer({ password: "secret", persistedRemoteAccess: true })
    const cookie = await login(baseUrl)
    const authHeaders = { Cookie: cookie }

    const unauthenticatedPending = await fetch(`${baseUrl}/api/pairing/pending`)
    expect(unauthenticatedPending.status).toBe(401)

    const paired = await pairDevice(baseUrl, authHeaders)
    const noCredentialDevices = await fetch(`${baseUrl}/api/devices`)
    expect(noCredentialDevices.status).toBe(401)

    const deviceHeaders = { Authorization: `Bearer ${paired.token}` }
    // Device management is host-only: the token authenticates (ordinary
    // authenticated routes accept it) yet is forbidden from listing devices.
    expect((await fetch(`${baseUrl}/api/remote-access/status`, { headers: deviceHeaders })).status).toBe(200)
    const deviceDevices = await fetch(`${baseUrl}/api/devices`, { headers: deviceHeaders })
    expect(deviceDevices.status).toBe(403)

    const ws = createWebSocketWithHeaders(`ws://127.0.0.1:${server.port}/ws`, {
      Authorization: `Bearer ${paired.token}`,
    })
    await waitForWebSocketOpen(ws)
    const closed = waitForWebSocketClose(ws)

    const revoke = await fetch(`${baseUrl}/api/devices/${paired.device.id}/revoke`, {
      method: "POST",
      headers: authHeaders,
    })
    expect(revoke.status).toBe(200)
    await closed

    const afterRevoke = await fetch(`${baseUrl}/api/devices`, { headers: deviceHeaders })
    expect(afterRevoke.status).toBe(401)
    const wsAfterRevoke = await fetch(`${baseUrl}/ws`, { headers: deviceHeaders })
    expect(wsAfterRevoke.status).toBe(401)
  })

  test("rejects settings writes from a device-token websocket while ordinary chat commands still work", async () => {
    const { baseUrl, server, dataDir } = await startRemoteAccessServer({ password: "secret", persistedRemoteAccess: true })
    const cookie = await login(baseUrl)
    const authHeaders = { Cookie: cookie }
    const paired = await pairDevice(baseUrl, authHeaders)
    const project = await server.store.openProject(path.join(dataDir, "device-command-project"), "Device Command Project")

    const deviceWs = createWebSocketWithHeaders(`${baseUrl.replace(/^http/, "ws")}/ws`, {
      Authorization: `Bearer ${paired.token}`,
    })
    await waitForWebSocketOpen(deviceWs)
    try {
      const settingsWrite = await sendWsCommand(deviceWs, "device-settings-write", {
        type: "settings.writeAppSettingsPatch",
        patch: { remoteAccess: { enabled: false } },
      })
      expect(settingsWrite.type).toBe("error")
      expect(settingsWrite.message).toContain("requires host access")

      const chatCreate = await sendWsCommand(deviceWs, "device-chat-create", {
        type: "chat.create",
        projectId: project.id,
      })
      expect(chatCreate.type).toBe("ack")
      expect(chatCreate.result).toMatchObject({ chatId: expect.any(String) })
    } finally {
      deviceWs.close()
    }

    // A password session is host evidence even when the same write is sent
    // over a websocket rather than the settings HTTP/UI path.
    const hostWs = createWebSocketWithHeaders(`${baseUrl.replace(/^http/, "ws")}/ws`, authHeaders)
    await waitForWebSocketOpen(hostWs)
    try {
      const hostWrite = await sendWsCommand(hostWs, "host-settings-write", {
        type: "settings.writeAppSettingsPatch",
        patch: { remoteAccess: { enabled: true } },
      })
      expect(hostWrite.type).toBe("ack")
    } finally {
      hostWs.close()
    }

    const status = await fetch(`${baseUrl}/api/remote-access/status`, { headers: authHeaders })
    expect(await status.json()).toMatchObject({ enabled: true })
  })

  test("lets a loopback websocket write app settings while no password exists", async () => {
    const { baseUrl } = await startRemoteAccessServer()
    await writeRemoteAccessSetting(baseUrl, true)
  })

  test("forbids device tokens on all pairing-admin and device-management endpoints without mutating state", async () => {
    const { baseUrl } = await startRemoteAccessServer({ password: "secret", persistedRemoteAccess: true })
    const cookie = await login(baseUrl)
    const authHeaders = { Cookie: cookie }
    const paired = await pairDevice(baseUrl, authHeaders)
    const deviceHeaders = { Authorization: `Bearer ${paired.token}` }

    const createRequest = async (deviceName: string) => {
      const created = await fetch(`${baseUrl}/api/pairing/requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceName }),
      })
      expect(created.status).toBe(201)
      return (await created.json() as { requestId: string }).requestId
    }
    const approveProbeId = await createRequest("Approve Probe")
    const denyProbeId = await createRequest("Deny Probe")

    // Every admin endpoint rejects the device token with 403 even though the
    // token itself is valid: authentication succeeds, authorization does not.
    const deviceProbes = [
      () => fetch(`${baseUrl}/api/pairing/pending`, { headers: deviceHeaders }),
      () => fetch(`${baseUrl}/api/pairing/requests/${approveProbeId}/approve`, { method: "POST", headers: deviceHeaders }),
      () => fetch(`${baseUrl}/api/pairing/requests/${denyProbeId}/deny`, { method: "POST", headers: deviceHeaders }),
      () => fetch(`${baseUrl}/api/devices`, { headers: deviceHeaders }),
      () => fetch(`${baseUrl}/api/devices/${paired.device.id}/revoke`, { method: "POST", headers: deviceHeaders }),
    ]
    for (const probe of deviceProbes) {
      expect((await probe()).status).toBe(403)
    }

    // The forbidden probes must have been inert: both pairing requests are
    // still pending and the paired device is neither approved-escalated nor revoked.
    const pendingAfter = await fetch(`${baseUrl}/api/pairing/pending`, { headers: authHeaders })
    const pendingPayload = await pendingAfter.json() as { requests: Array<{ id: string }> }
    expect(pendingPayload.requests.map((request) => request.id)).toEqual(expect.arrayContaining([approveProbeId, denyProbeId]))
    const devicesAfter = await fetch(`${baseUrl}/api/devices`, { headers: authHeaders })
    const devicesPayload = await devicesAfter.json() as { devices: Array<{ id: string; revokedAt?: number }> }
    expect(devicesPayload.devices).toHaveLength(1)
    expect(devicesPayload.devices[0]).toMatchObject({ id: paired.device.id })
    expect(devicesPayload.devices[0]).not.toHaveProperty("revokedAt")

    // The same token still works on ordinary authenticated routes: the mobile
    // app reads the remote-access status as a device, so that one stays open.
    expect((await fetch(`${baseUrl}/api/remote-access/status`, { headers: deviceHeaders })).status).toBe(200)

    // A password session passes all five admin endpoints.
    expect((await fetch(`${baseUrl}/api/pairing/pending`, { headers: authHeaders })).status).toBe(200)
    const approved = await fetch(`${baseUrl}/api/pairing/requests/${approveProbeId}/approve`, { method: "POST", headers: authHeaders })
    expect(approved.status).toBe(200)
    const approvedPayload = await approved.json() as { device: { id: string } }
    expect((await fetch(`${baseUrl}/api/pairing/requests/${denyProbeId}/deny`, { method: "POST", headers: authHeaders })).status).toBe(200)
    expect((await fetch(`${baseUrl}/api/devices`, { headers: authHeaders })).status).toBe(200)
    expect((await fetch(`${baseUrl}/api/devices/${approvedPayload.device.id}/revoke`, { method: "POST", headers: authHeaders })).status).toBe(200)
  })

  test("lets the loopback-no-password host use every pairing-admin endpoint", async () => {
    const { baseUrl } = await startRemoteAccessServer({ persistedRemoteAccess: true })

    const createRequest = async (deviceName: string) => {
      const created = await fetch(`${baseUrl}/api/pairing/requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceName }),
      })
      expect(created.status).toBe(201)
      return (await created.json() as { requestId: string }).requestId
    }
    const approveId = await createRequest("Loopback Phone")
    const denyId = await createRequest("Loopback Tablet")

    // No credential headers at all: with no password configured, loopback
    // itself is the host-level evidence.
    expect((await fetch(`${baseUrl}/api/pairing/pending`)).status).toBe(200)
    const approved = await fetch(`${baseUrl}/api/pairing/requests/${approveId}/approve`, { method: "POST" })
    expect(approved.status).toBe(200)
    const approvedPayload = await approved.json() as { device: { id: string } }
    expect((await fetch(`${baseUrl}/api/pairing/requests/${denyId}/deny`, { method: "POST" })).status).toBe(200)
    expect((await fetch(`${baseUrl}/api/devices`)).status).toBe(200)
    expect((await fetch(`${baseUrl}/api/devices/${approvedPayload.device.id}/revoke`, { method: "POST" })).status).toBe(200)
  })

  test("rejects an oversized declared pairing body with 413 before creating a queue entry", async () => {
    const { baseUrl } = await startRemoteAccessServer({ persistedRemoteAccess: true })
    // Well-formed JSON whose honest content-length crosses the 4KB cap: the
    // early header check must reject before the body is even read.
    const padded = JSON.stringify({ deviceName: "Padded Phone", padding: "x".repeat(8192) })
    const response = await fetch(`${baseUrl}/api/pairing/requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: padded,
    })
    expect(response.status).toBe(413)

    const pending = await fetch(`${baseUrl}/api/pairing/pending`)
    expect((await pending.json() as { requests: unknown[] }).requests).toHaveLength(0)
  })

  test("rejects an oversized chunked pairing body that has no content-length to trust", async () => {
    const { baseUrl, server } = await startRemoteAccessServer({ persistedRemoteAccess: true })
    // Chunked framing carries no content-length, so the early header check is
    // blind here; only the hard cap enforced while streaming the body can
    // reject it. ASCII-only payload keeps length == byte length.
    const payload = JSON.stringify({ deviceName: "Chunked Phone", padding: "x".repeat(8192) })
    const raw = [
      "POST /api/pairing/requests HTTP/1.1",
      `Host: 127.0.0.1:${server.port}`,
      "Content-Type: application/json",
      "Transfer-Encoding: chunked",
      "Connection: close",
      "",
      payload.length.toString(16),
      payload,
      "0",
      "",
      "",
    ].join("\r\n")
    const response = await rawHttpExchange(server.port, raw)
    expect(response.startsWith("HTTP/1.1 413")).toBe(true)

    const pending = await fetch(`${baseUrl}/api/pairing/pending`)
    expect((await pending.json() as { requests: unknown[] }).requests).toHaveLength(0)
  })

  test("rejects a declared oversized body on the pairing status endpoint", async () => {
    const { baseUrl, server } = await startRemoteAccessServer({ persistedRemoteAccess: true })
    const body = "x".repeat(5000)
    const raw = [
      "GET /api/pairing/requests/some-request/status?code=ABCDEFGHJKLM HTTP/1.1",
      `Host: 127.0.0.1:${server.port}`,
      `Content-Length: ${body.length}`,
      "Connection: close",
      "",
      body,
    ].join("\r\n")
    const response = await rawHttpExchange(server.port, raw)
    expect(response.startsWith("HTTP/1.1 413")).toBe(true)
    // The cap fires before the pairing-code lookup, so a well-formed small
    // poll on a missing request still answers 404 rather than 413.
    const small = await fetch(`${baseUrl}/api/pairing/requests/some-request/status?code=ABCDEFGHJKLM`)
    expect(small.status).toBe(404)
  })
})
