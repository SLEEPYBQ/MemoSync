import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { networkInterfaces, tmpdir } from "node:os"
import path from "node:path"
import { startMemoSyncServer, authorizeMemoSyncRequest, isLoopbackBindHost, isLoopbackClientAddress } from "./server"
import { DEVICE_TOKEN_PREFIX, formatPairingCode } from "./devices"

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
} = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "memosync-remote-access-data-"))
  tempDirs.push(dataDir)
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

describe("remote access authorization decision", () => {
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
    const deviceDevices = await fetch(`${baseUrl}/api/devices`, { headers: deviceHeaders })
    expect(deviceDevices.status).toBe(200)
    const devicePayload = await deviceDevices.json() as { devices: Array<{ id: string }> }
    expect(devicePayload.devices.map((device) => device.id)).toContain(paired.device.id)

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
})
