import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  DEVICE_TOKEN_PREFIX,
  DeviceStore,
  PAIRING_CODE_ALPHABET,
  PAIRING_REQUEST_TTL_MS,
  formatPairingCode,
} from "./devices"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function createClock(start = 1_000) {
  return {
    value: start,
    advance(ms: number) {
      this.value += ms
    },
  }
}

async function createStore(clock = createClock()) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "memosync-devices-"))
  tempDirs.push(dataDir)
  const store = new DeviceStore(dataDir, { now: () => clock.value })
  await store.initialize()
  return { store, dataDir, clock }
}

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise
    return null
  } catch (error) {
    return error
  }
}

describe("DeviceStore pairing codes", () => {
  test("generates 12-character codes from the unambiguous alphabet and formats display groups", async () => {
    const { store } = await createStore()
    for (let index = 0; index < 5; index += 1) {
      const request = await store.createRequest("Test Phone", `198.51.100.${index}`)
      expect(request.code).toHaveLength(12)
      expect(request.code).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/)
      expect([...request.code].every((character) => PAIRING_CODE_ALPHABET.includes(character))).toBe(true)
      expect(formatPairingCode(request.code)).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/)
    }
  })
})

describe("DeviceStore pairing lifecycle", () => {
  test("creates, approves, authenticates, persists and revokes a device", async () => {
    const { store, dataDir, clock } = await createStore()
    const request = await store.createRequest("  Ada's   Phone  ", "198.51.100.10")
    expect(request.deviceName).toBe("Ada's Phone")
    expect(store.getRequestStatus(request.id, request.code)).toEqual({ status: "pending" })

    const approved = await store.approveRequest(request.id)
    expect(approved.token).toMatch(new RegExp(`^${DEVICE_TOKEN_PREFIX}[0-9a-f]{48}$`))
    expect(approved.device).toMatchObject({ name: "Ada's Phone", createdAt: clock.value, lastSeenAt: clock.value })
    expect(approved.device).not.toHaveProperty("token")
    expect(approved.device).not.toHaveProperty("tokenHash")

    const mixedCaseCode = formatPairingCode(request.code).toLowerCase()
    expect(store.getRequestStatus(request.id, mixedCaseCode)).toEqual({ status: "approved", token: approved.token })

    const onDisk = await readFile(path.join(dataDir, "devices.json"), "utf8")
    expect(onDisk).not.toContain(approved.token)
    expect(JSON.parse(onDisk).devices[0].tokenHash).toMatch(/^[0-9a-f]{64}$/)

    clock.advance(1_000)
    expect(await store.authenticateToken(approved.token)).toMatchObject({ id: approved.device.id, lastSeenAt: clock.value })

    // Sub-minute updates stay in memory only; the file is rewritten at most
    // once per minute per device.
    const reloadedEarly = new DeviceStore(dataDir, { now: () => clock.value })
    await reloadedEarly.initialize()
    expect(reloadedEarly.listDevices()[0]?.lastSeenAt).toBe(approved.device.lastSeenAt)

    clock.advance(60_000)
    expect(await store.authenticateToken(approved.token)).toMatchObject({ id: approved.device.id, lastSeenAt: clock.value })

    const reloaded = new DeviceStore(dataDir, { now: () => clock.value })
    await reloaded.initialize()
    expect(reloaded.listDevices()).toEqual([{ ...approved.device, lastSeenAt: clock.value }])

    const revoked: string[] = []
    const stopListening = reloaded.onRevoke((deviceId) => revoked.push(deviceId))
    expect(reloaded.isDeviceActive(approved.device.id)).toBe(true)
    expect(await reloaded.revokeDevice(approved.device.id)).toBe(true)
    expect(reloaded.isDeviceActive(approved.device.id)).toBe(false)
    expect(revoked).toEqual([approved.device.id])
    expect(await reloaded.authenticateToken(approved.token)).toBeNull()
    expect(await reloaded.revokeDevice(approved.device.id)).toBe(false)
    stopListening()
  })

  test("rejects a wrong status code without revealing the request", async () => {
    const { store } = await createStore()
    const request = await store.createRequest("Tablet", "198.51.100.20")
    expect(store.getRequestStatus(request.id, "000000000000")).toBeNull()
    expect(store.getRequestStatus(request.id, formatPairingCode(request.code))).toEqual({ status: "pending" })
  })

  test("expires requests with the injected clock", async () => {
    const { store, clock } = await createStore()
    const request = await store.createRequest("Laptop", "198.51.100.30")
    clock.advance(PAIRING_REQUEST_TTL_MS)
    expect(store.getRequestStatus(request.id, request.code)).toEqual({ status: "expired" })
    expect(await errorOf(store.approveRequest(request.id))).toMatchObject({ code: "request_not_pending" })
    expect(await errorOf(store.denyRequest(request.id))).toMatchObject({ code: "request_not_pending" })
  })

  test("makes approval and denial single-use", async () => {
    const { store } = await createStore()
    const approvedRequest = await store.createRequest("Phone", "198.51.100.40")
    await store.approveRequest(approvedRequest.id)
    expect(await errorOf(store.approveRequest(approvedRequest.id))).toMatchObject({ code: "request_not_pending" })
    expect(await errorOf(store.denyRequest(approvedRequest.id))).toMatchObject({ code: "request_not_pending" })

    const deniedRequest = await store.createRequest("Other phone", "198.51.100.40")
    await store.denyRequest(deniedRequest.id)
    expect(store.getRequestStatus(deniedRequest.id, deniedRequest.code)).toEqual({ status: "denied" })
    expect(await errorOf(store.approveRequest(deniedRequest.id))).toMatchObject({ code: "request_not_pending" })
    expect(await errorOf(store.denyRequest(deniedRequest.id))).toMatchObject({ code: "request_not_pending" })
  })
})

describe("DeviceStore limits and redaction", () => {
  test("rejects blank and overlong device names", async () => {
    const { store } = await createStore()
    expect(await errorOf(store.createRequest("   ", "198.51.100.45"))).toMatchObject({ code: "invalid_device_name" })
    expect(await errorOf(store.createRequest("x".repeat(121), "198.51.100.45"))).toMatchObject({ code: "invalid_device_name" })
  })

  test("rate-limits five new pairing requests per minute per IP", async () => {
    const { store, clock } = await createStore()
    for (let index = 0; index < 5; index += 1) {
      await store.createRequest(`Device ${index}`, "198.51.100.50")
    }
    expect(await errorOf(store.createRequest("One too many", "198.51.100.50"))).toMatchObject({ code: "rate_limited" })
    await store.createRequest("Other IP is independent", "198.51.100.51")
    clock.advance(60_001)
    await store.createRequest("Window moved", "198.51.100.50")
  })

  test("allows at most ten pending pairing requests per server instance", async () => {
    const { store } = await createStore()
    for (let index = 0; index < 10; index += 1) {
      await store.createRequest(`Device ${index}`, `198.51.100.${60 + index}`)
    }
    expect(await errorOf(store.createRequest("Eleventh", "198.51.100.70"))).toMatchObject({ code: "rate_limited" })
  })

  test("never exposes token material in device lists", async () => {
    const { store } = await createStore()
    const request = await store.createRequest("Phone", "198.51.100.80")
    const approved = await store.approveRequest(request.id)
    const devices = store.listDevices()
    expect(devices).toHaveLength(1)
    expect(devices[0]).toEqual(approved.device)
    expect(devices[0]).not.toHaveProperty("token")
    expect(devices[0]).not.toHaveProperty("tokenHash")
    expect(JSON.stringify(devices)).not.toContain(approved.token)
  })

  test("updates lastSeenAt when a token authenticates", async () => {
    const { store, clock } = await createStore()
    const request = await store.createRequest("Phone", "198.51.100.90")
    const approved = await store.approveRequest(request.id)
    clock.advance(5_000)
    const first = await store.authenticateToken(approved.token)
    expect(first).toMatchObject({ id: approved.device.id, lastSeenAt: clock.value })
    clock.advance(5_000)
    const second = await store.authenticateToken(approved.token)
    expect(second?.lastSeenAt).toBe(clock.value)
    expect(second?.lastSeenAt).toBeGreaterThan(first?.lastSeenAt ?? 0)
  })
})
