import { randomUUID } from "node:crypto"
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { ApiConnection, EngineId, EngineSetup } from "../../shared/model-access"

/** Replaceable by Electron safeStorage without changing the service/runtime. */
export interface CredentialStore {
  get(id: string): Promise<string | undefined>
  set(id: string, secret: string | null): Promise<void>
}

export function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(readFileSync(file, "utf8")) as T }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback
    throw new Error("model-access-storage-unreadable")
  }
}

export function atomicJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(tmp, "wx", 0o600)
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n")
    fsyncSync(fd); closeSync(fd); fd = undefined
    renameSync(tmp, file)
  } catch {
    throw new Error("model-access-storage-write-failed")
  } finally {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(tmp) } catch { /* renamed or never created */ }
  }
}

export class FileCredentialStore implements CredentialStore {
  private readonly file: string
  constructor(dataDir: string) { this.file = join(dataDir, "credentials.json") }
  async get(id: string) {
    const keys = readJson<Record<string, string>>(this.file, {})
    try { chmodSync(this.file, 0o600) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("model-access-storage-unreadable")
    }
    return Object.hasOwn(keys, id) && typeof keys[id] === "string" ? keys[id] : undefined
  }
  async set(id: string, secret: string | null) {
    const keys = readJson<Record<string, string>>(this.file, {})
    if (secret === null) delete keys[id]
    else Object.defineProperty(keys, id, { value: secret, enumerable: true, configurable: true, writable: true })
    atomicJson(this.file, keys)
  }
}

export interface ModelAccessData {
  version: 1
  connections: ApiConnection[]
  engines: Partial<Record<EngineId, EngineSetup>>
}
