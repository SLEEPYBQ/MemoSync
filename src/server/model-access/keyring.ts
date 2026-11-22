import { createHash } from "node:crypto"
import { resolve } from "node:path"

export interface Keyring {
  get(options: { service: string; name: string }): Promise<string | null>
  set(options: { service: string; name: string; value: string; persist?: "local" }): Promise<void>
  delete(options: { service: string; name: string }): Promise<boolean>
}

export class KeyringUnavailable extends Error {
  constructor() { super("model-access-keyring-unavailable") }
}

/** Independent profiles may contain copied connection IDs. Scope vault access to their local configuration path. */
export class SystemCredentialStore {
  private readonly service: string
  constructor(file: string, private readonly keyring: Keyring = Bun.secrets) {
    const location = resolve(file)
    this.service = "cc.memosync.credentials." + createHash("sha256")
      .update(process.platform === "win32" ? location.toLowerCase() : location).digest("hex")
  }
  async get(name: string) {
    try { return (await this.keyring.get({ service: this.service, name })) ?? undefined }
    catch { throw new KeyringUnavailable() }
  }
  async set(name: string, value: string | null) {
    try {
      if (value === null) await this.keyring.delete({ service: this.service, name })
      else await this.keyring.set({ service: this.service, name, value, persist: "local" })
    } catch { throw new KeyringUnavailable() }
  }
}
