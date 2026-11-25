import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  DEVICE_TOKEN_PREFIX,
  DeviceStore,
  PAIRING_APPROVED_TOKEN_GRACE_MS,
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

  test("keeps a revoked device rejected after the store reloads from devices.json", async () => {
    const { store, dataDir, clock } = await createStore()
    const request = await store.createRequest("Phone", "198.51.100.95")
    const approved = await store.approveRequest(request.id)
    expect(await store.authenticateToken(approved.token)).not.toBeNull()
    expect(await store.revokeDevice(approved.device.id)).toBe(true)

    // The revocation must live in the file, not in process memory: a fresh
    // store instance on the same devices.json (the post-restart shape) never
    // authenticates the old token again.
    const reloaded = new DeviceStore(dataDir, { now: () => clock.value })
    await reloaded.initialize()
    expect(await reloaded.authenticateToken(approved.token)).toBeNull()
    expect(reloaded.isDeviceActive(approved.device.id)).toBe(false)
    const persistedDevice = reloaded.listDevices().find((device) => device.id === approved.device.id)
    expect(persistedDevice?.revokedAt).toEqual(expect.any(Number))
    const onDisk = JSON.parse(await readFile(path.join(dataDir, "devices.json"), "utf8"))
    expect(onDisk.devices[0].revokedAt).toBe(persistedDevice?.revokedAt)
    expect(onDisk.devices[0]).not.toHaveProperty("token")
    expect(JSON.stringify(onDisk)).not.toContain(approved.token)
    expect(await reloaded.revokeDevice(approved.device.id)).toBe(false)
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

  test("keeps a near-expiry approval redeemable only for the short token grace period", async () => {
    const { store, clock } = await createStore()
    const approvedRequest = await store.createRequest("Phone", "198.51.100.31")
    clock.advance(PAIRING_REQUEST_TTL_MS - 1_000)
    const approved = await store.approveRequest(approvedRequest.id)

    // Approval one second before the original TTL does not strand a device
    // that polls one second later, but the secret does not stay redeemable
    // for the rest of request retention.
    clock.advance(1_000)
    expect(store.getRequestStatus(approvedRequest.id, approvedRequest.code)).toEqual({
      status: "approved",
      token: approved.token,
    })
    clock.advance(PAIRING_APPROVED_TOKEN_GRACE_MS - 1_000)
    expect(store.getRequestStatus(approvedRequest.id, approvedRequest.code)).toEqual({ status: "expired" })
    expect(store.getRequestStatus(approvedRequest.id, approvedRequest.code)).toEqual({ status: "expired" })

    const deniedRequest = await store.createRequest("Tablet", "198.51.100.32")
    await store.denyRequest(deniedRequest.id)
    clock.advance(PAIRING_REQUEST_TTL_MS)
    expect(store.getRequestStatus(deniedRequest.id, deniedRequest.code)).toEqual({ status: "denied" })
  })

  test("ages out an approved pairing token at the retained-request boundary", async () => {
    const { store, clock } = await createStore()
    const request = await store.createRequest("Phone", "198.51.100.33")
    await store.approveRequest(request.id)

    // Terminal-state retention is bounded too: expiry plus retention is
    // currently two TTLs from creation, after which the request id itself
    // disappears instead of waiting for another pairing creation.
    clock.advance(PAIRING_REQUEST_TTL_MS * 2)
    expect(store.getRequestStatus(request.id, request.code)).toBeNull()
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
      const request = await store.createRequest(`Device ${index}`, "198.51.100.50")
      // Keep the pending-per-IP cap from masking the creation-rate window:
      // denied requests no longer count as pending, but their creations still
      // count toward the per-minute limit.
      if (index < 4) await store.denyRequest(request.id)
    }
    expect(await errorOf(store.createRequest("One too many", "198.51.100.50"))).toMatchObject({ code: "rate_limited" })
    await store.createRequest("Other IP is independent", "198.51.100.51")
    clock.advance(60_001)
    await store.createRequest("Window moved", "198.51.100.50")
  })

  test("allows at most two pending pairing requests from one IP", async () => {
    const { store } = await createStore()
    const first = await store.createRequest("First", "198.51.100.52")
    await store.createRequest("Second", "198.51.100.52")
    expect(await errorOf(store.createRequest("Third", "198.51.100.52"))).toMatchObject({ code: "rate_limited" })

    // The cap is on live pending requests, not total creations: resolving one
    // lets the same source ask again, while other source addresses stay independent.
    await store.denyRequest(first.id)
    await store.createRequest("Replacement", "198.51.100.52")
    await store.createRequest("Other IP is independent", "198.51.100.53")
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

describe("DeviceStore corrupt persistence recovery", () => {
  test("quarantines unreadable json or shapes and starts with an empty store", async () => {
    const corruptPayloads = [
      "",
      "{not-json",
      JSON.stringify({ devices: [{ id: "missing-required-fields" }] }),
    ]
    const logger = spyOn(console, "error").mockImplementation(() => {})
    try {
      for (const [index, payload] of corruptPayloads.entries()) {
        const dataDir = await mkdtemp(path.join(tmpdir(), "memosync-devices-corrupt-"))
        tempDirs.push(dataDir)
        await writeFile(path.join(dataDir, "devices.json"), payload, "utf8")

        const store = new DeviceStore(dataDir, { now: () => 1_700_000_000_000 + index })
        await store.initialize()

        expect(store.listDevices()).toEqual([])
        const files = await readdir(dataDir)
        const corruptName = `devices.json.corrupt-${1_700_000_000_000 + index}`
        expect(files).toContain(corruptName)
        expect(files).not.toContain("devices.json")
        expect(await readFile(path.join(dataDir, corruptName), "utf8")).toBe(payload)

        // Recovery is usable, not just non-crashing: the next approval recreates
        // a clean store file beside the quarantined bytes.
        const request = await store.createRequest("Recovered phone", `198.51.100.${100 + index}`)
        const approved = await store.approveRequest(request.id)
        expect(approved.device.name).toBe("Recovered phone")
        expect(JSON.parse(await readFile(path.join(dataDir, "devices.json"), "utf8")).devices).toHaveLength(1)
      }
      expect(logger).toHaveBeenCalledTimes(corruptPayloads.length)
    } finally {
      logger.mockRestore()
    }
  })
})
