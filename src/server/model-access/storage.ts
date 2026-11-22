import { randomUUID } from "node:crypto"
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { ApiConnection, EngineId, EngineSetup } from "../../shared/model-access"
import { SystemCredentialStore, type Keyring } from "./keyring"

export interface CredentialStore {
  migrate?(): Promise<void>
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

export class ModelCredentialStore implements CredentialStore {
  private readonly legacyFile: string
  private readonly vault: SystemCredentialStore
  private migration?: Promise<void>

  constructor(dataDir: string, keyring?: Keyring) {
    this.legacyFile = join(dataDir, "credentials.json")
    this.vault = new SystemCredentialStore(this.legacyFile, keyring)
  }
  private async importLegacyFile() {
    const keys = readJson<Record<string, string> | null>(this.legacyFile, null)
    if (keys === null) return
    if (typeof keys !== "object" || Array.isArray(keys) || Object.values(keys).some(value => typeof value !== "string")) {
      throw new Error("model-access-storage-unreadable")
    }
    chmodSync(this.legacyFile, 0o600)
    for (const [id, key] of Object.entries(keys)) {
      // A restored pre-upgrade backup can be older than a subsequent key
      // rotation. The vault is authoritative once this identity exists there.
      if (await this.vault.get(id) !== undefined) continue
      await this.vault.set(id, key)
      if (await this.vault.get(id) !== key) throw new Error("model-access-storage-write-failed")
    }
    // The backend holds the data-directory lock. All mutations wait for this
    // migration, so a partial import can be replayed without undoing rotations.
    unlinkSync(this.legacyFile)
  }
  migrate() {
    return this.migration ??= this.importLegacyFile().catch(error => {
      this.migration = undefined
      throw error
    })
  }
  async get(id: string) {
    await this.migrate()
    return this.vault.get(id)
  }
  async set(id: string, value: string | null) {
    await this.migrate()
    await this.vault.set(id, value)
  }
}

export interface ModelAccessData {
  version: 1
  connections: ApiConnection[]
  engines: Partial<Record<EngineId, EngineSetup>>
}
