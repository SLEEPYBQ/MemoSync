import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import path from "node:path"

export const DEVICE_TOKEN_PREFIX = "memosync_device_"
export const PAIRING_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
export const PAIRING_CODE_LENGTH = 12
export const PAIRING_REQUEST_TTL_MS = 10 * 60 * 1000

const MAX_PENDING_PAIRING_REQUESTS = 10
const MAX_PAIRING_REQUESTS_PER_MINUTE_PER_IP = 5
const PAIRING_REQUEST_RATE_WINDOW_MS = 60 * 1000
const EXPIRED_REQUEST_RETENTION_MS = PAIRING_REQUEST_TTL_MS
const DEVICE_TOKEN_PATTERN = /^memosync_device_[0-9a-f]{48}$/
const MAX_DEVICE_NAME_LENGTH = 120

export interface Device {
  id: string
  name: string
  createdAt: number
  lastSeenAt: number
  revokedAt?: number
}

interface StoredDevice extends Device {
  tokenHash: string
}

interface DevicesFile {
  devices?: unknown
}

export interface PairingRequestInfo {
  id: string
  deviceName: string
  code: string
  createdAt: number
  expiresAt: number
}

export type PairingRequestStatus = "pending" | "approved" | "denied" | "expired"

export interface PairingRequestStatusResult {
  status: PairingRequestStatus
  token?: string
}

interface PairingRequest extends PairingRequestInfo {
  status: "pending" | "approved" | "denied"
  token?: string
  deviceId?: string
}

export type DeviceStoreErrorCode = "invalid_device_name" | "rate_limited" | "request_not_found" | "request_not_pending"

export class DeviceStoreError extends Error {
  readonly code: DeviceStoreErrorCode

  constructor(code: DeviceStoreErrorCode, message: string) {
    super(message)
    this.name = "DeviceStoreError"
    this.code = code
  }
}

export interface DeviceStoreOptions {
  now?: () => number
}

function generatePairingCode() {
  let code = ""
  const rejectionLimit = Math.floor(256 / PAIRING_CODE_ALPHABET.length) * PAIRING_CODE_ALPHABET.length
  // Adapted from pingdotgg/t3code (MIT): https://github.com/pingdotgg/t3code/blob/main/apps/server/src/auth/PairingGrantStore.ts
  while (code.length < PAIRING_CODE_LENGTH) {
    const byte = randomBytes(1)[0]
    if (byte >= rejectionLimit) continue
    code += PAIRING_CODE_ALPHABET[byte % PAIRING_CODE_ALPHABET.length]
  }
  return code
}

export function normalizePairingCode(code: string) {
  return code.replace(/[\s-]/g, "").toUpperCase()
}

export function formatPairingCode(code: string) {
  const normalized = normalizePairingCode(code)
  return normalized.replace(/(.{4})(?=.)/g, "$1-")
}

function generateDeviceToken() {
  return `${DEVICE_TOKEN_PREFIX}${randomBytes(24).toString("hex")}`
}

function hashDeviceToken(token: string) {
  return createHash("sha256").update(token).digest("hex")
}

function redactDevice(device: StoredDevice): Device {
  const redacted: Device = {
    id: device.id,
    name: device.name,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
  }
  if (device.revokedAt !== undefined) redacted.revokedAt = device.revokedAt
  return redacted
}

function isStoredDevice(value: unknown): value is StoredDevice {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const device = value as Partial<StoredDevice>
  return typeof device.id === "string"
    && typeof device.name === "string"
    && typeof device.tokenHash === "string"
    && typeof device.createdAt === "number"
    && typeof device.lastSeenAt === "number"
    && (device.revokedAt === undefined || typeof device.revokedAt === "number")
}

function safeCompare(left: string, right: string) {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function normalizeDeviceName(deviceName: string) {
  const normalized = deviceName.trim().replace(/\s+/g, " ")
  if (!normalized || normalized.length > MAX_DEVICE_NAME_LENGTH) {
    throw new DeviceStoreError("invalid_device_name", "Device name must be 1-120 characters")
  }
  return normalized
}

export class DeviceStore {
  readonly dataDir: string
  readonly filePath: string
  private readonly now: () => number
  private devices = new Map<string, StoredDevice>()
  private readonly pairingRequests = new Map<string, PairingRequest>()
  private readonly pairingRequestIps = new Map<string, number[]>()
  private readonly revokeListeners = new Set<(deviceId: string) => void>()
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(dataDir: string, options: DeviceStoreOptions = {}) {
    this.dataDir = dataDir
    this.filePath = path.join(dataDir, "devices.json")
    this.now = options.now ?? Date.now
  }

  async initialize() {
    await mkdir(this.dataDir, { recursive: true })
    let text: string
    try {
      text = await readFile(this.filePath, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return
      throw error
    }
    if (!text.trim()) return

    const parsed = JSON.parse(text) as DevicesFile
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.devices)) {
      throw new Error("devices-store-unreadable")
    }
    const devices = new Map<string, StoredDevice>()
    for (const value of parsed.devices) {
      if (!isStoredDevice(value)) throw new Error("devices-store-unreadable")
      devices.set(value.id, { ...value })
    }
    this.devices = devices
  }

  private serialize<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation)
    this.mutationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  private async writeDevicesFile(devices: Map<string, StoredDevice>) {
    await mkdir(this.dataDir, { recursive: true })
    const temporaryPath = `${this.filePath}.${randomBytes(8).toString("hex")}.tmp`
    const payload = `${JSON.stringify({ version: 1, devices: [...devices.values()] }, null, 2)}\n`
    try {
      await writeFile(temporaryPath, payload, { encoding: "utf8", mode: 0o600 })
      await rename(temporaryPath, this.filePath)
    } finally {
      await unlink(temporaryPath).catch(() => {})
    }
  }

  private prunePairingRequests(now: number) {
    for (const [id, request] of this.pairingRequests) {
      if (request.expiresAt + EXPIRED_REQUEST_RETENTION_MS <= now) {
        this.pairingRequests.delete(id)
      }
    }
    for (const [ip, timestamps] of this.pairingRequestIps) {
      const recent = timestamps.filter((timestamp) => timestamp + PAIRING_REQUEST_RATE_WINDOW_MS > now)
      if (recent.length) this.pairingRequestIps.set(ip, recent)
      else this.pairingRequestIps.delete(ip)
    }
  }

  private isExpired(request: PairingRequest, now = this.now()) {
    return request.expiresAt <= now
  }

  private pendingRequestCount(now: number) {
    let count = 0
    for (const request of this.pairingRequests.values()) {
      if (request.status === "pending" && !this.isExpired(request, now)) count += 1
    }
    return count
  }

  private newId() {
    return randomBytes(16).toString("base64url")
  }

  async createRequest(deviceName: string, clientIp = "unknown"): Promise<PairingRequestInfo> {
    return this.serialize(() => {
      const now = this.now()
      this.prunePairingRequests(now)
      if (this.pendingRequestCount(now) >= MAX_PENDING_PAIRING_REQUESTS) {
        throw new DeviceStoreError("rate_limited", "Too many pending pairing requests")
      }
      const ip = clientIp || "unknown"
      const recent = this.pairingRequestIps.get(ip) ?? []
      if (recent.length >= MAX_PAIRING_REQUESTS_PER_MINUTE_PER_IP) {
        throw new DeviceStoreError("rate_limited", "Too many pairing requests")
      }

      let id = this.newId()
      while (this.pairingRequests.has(id)) id = this.newId()
      const request: PairingRequest = {
        id,
        deviceName: normalizeDeviceName(deviceName),
        code: generatePairingCode(),
        createdAt: now,
        expiresAt: now + PAIRING_REQUEST_TTL_MS,
        status: "pending",
      }
      this.pairingRequests.set(id, request)
      this.pairingRequestIps.set(ip, [...recent, now])
      return {
        id: request.id,
        deviceName: request.deviceName,
        code: request.code,
        createdAt: request.createdAt,
        expiresAt: request.expiresAt,
      }
    })
  }

  listPendingRequests(): PairingRequestInfo[] {
    const now = this.now()
    return [...this.pairingRequests.values()]
      .filter((request) => request.status === "pending" && !this.isExpired(request, now))
      .map((request) => ({
        id: request.id,
        deviceName: request.deviceName,
        code: request.code,
        createdAt: request.createdAt,
        expiresAt: request.expiresAt,
      }))
  }

  async approveRequest(id: string): Promise<{ token: string; device: Device }> {
    return this.serialize(async () => {
      const request = this.pairingRequests.get(id)
      if (!request) throw new DeviceStoreError("request_not_found", "Pairing request not found")
      if (request.status !== "pending" || this.isExpired(request)) {
        throw new DeviceStoreError("request_not_pending", "Pairing request is no longer pending")
      }

      const now = this.now()
      const token = generateDeviceToken()
      let deviceId = this.newId()
      while (this.devices.has(deviceId)) deviceId = this.newId()
      const device: StoredDevice = {
        id: deviceId,
        name: request.deviceName,
        tokenHash: hashDeviceToken(token),
        createdAt: now,
        lastSeenAt: now,
      }
      const nextDevices = new Map(this.devices)
      nextDevices.set(device.id, device)
      await this.writeDevicesFile(nextDevices)
      this.devices = nextDevices

      request.status = "approved"
      request.token = token
      request.deviceId = device.id
      return { token, device: redactDevice(device) }
    })
  }

  async denyRequest(id: string): Promise<void> {
    return this.serialize(() => {
      const request = this.pairingRequests.get(id)
      if (!request) throw new DeviceStoreError("request_not_found", "Pairing request not found")
      if (request.status !== "pending" || this.isExpired(request)) {
        throw new DeviceStoreError("request_not_pending", "Pairing request is no longer pending")
      }
      request.status = "denied"
    })
  }

  getRequestStatus(id: string, code: string): PairingRequestStatusResult | null {
    const request = this.pairingRequests.get(id)
    if (!request || !safeCompare(request.code, normalizePairingCode(code))) return null
    if (this.isExpired(request)) return { status: "expired" }
    if (request.status === "approved") return { status: "approved", token: request.token }
    return { status: request.status }
  }

  listDevices(): Device[] {
    return [...this.devices.values()].map(redactDevice)
  }

  /** Synchronous liveness check for the narrow upgrade window before a WS open handler runs. */
  isDeviceActive(id: string) {
    const device = this.devices.get(id)
    return Boolean(device && device.revokedAt === undefined)
  }

  async revokeDevice(id: string): Promise<boolean> {
    let revoked = false
    const result = await this.serialize(async () => {
      const device = this.devices.get(id)
      if (!device || device.revokedAt !== undefined) return false
      const nextDevices = new Map(this.devices)
      nextDevices.set(id, { ...device, revokedAt: this.now() })
      await this.writeDevicesFile(nextDevices)
      this.devices = nextDevices
      revoked = true
      return true
    })
    if (revoked) {
      for (const listener of this.revokeListeners) {
        try {
          listener(id)
        } catch (error) {
          console.error("[memosync] device revoke listener failed:", error)
        }
      }
    }
    return result
  }

  async authenticateToken(token: string): Promise<Device | null> {
    if (!DEVICE_TOKEN_PATTERN.test(token)) return null
    return this.serialize(async () => {
      const tokenHash = hashDeviceToken(token)
      const device = [...this.devices.values()].find((candidate) => safeCompare(candidate.tokenHash, tokenHash))
      if (!device || device.revokedAt !== undefined) return null
      const updated = { ...device, lastSeenAt: this.now() }
      const nextDevices = new Map(this.devices)
      nextDevices.set(updated.id, updated)
      // Every API request re-authenticates; persisting each one would rewrite
      // the file constantly. A minute-old lastSeenAt is granular enough.
      if (updated.lastSeenAt - device.lastSeenAt >= 60_000) {
        await this.writeDevicesFile(nextDevices)
      }
      this.devices = nextDevices
      return redactDevice(updated)
    })
  }

  onRevoke(listener: (deviceId: string) => void) {
    this.revokeListeners.add(listener)
    return () => {
      this.revokeListeners.delete(listener)
    }
  }
}
