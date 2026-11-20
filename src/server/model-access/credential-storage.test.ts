import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ModelCredentialStore } from "./storage"
import { createTestKeyring, fakeExecutableResolver } from "./test-fixtures"
import { ModelAccessService } from "./service"

const dirs: string[] = []
function temporaryDir() {
  const dir = mkdtempSync(join(tmpdir(), "memosync-vault-test-"))
  dirs.push(dir)
  return dir
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

test("legacy connection keys remain intact until every OS vault write has been verified and can be retried", async () => {
  const dir = temporaryDir()
  const file = join(dir, "credentials.json")
  const keys = { first: "fixture-one", second: "fixture-two" }
  writeFileSync(file, JSON.stringify(keys))
  const vault = createTestKeyring()
  let locked = true
  const store = new ModelCredentialStore(dir, {
    ...vault,
    set: async options => {
      if (locked && options.name === "second") throw new Error("locked")
      await vault.set(options)
    },
  })
  await expect(store.migrate()).rejects.toThrow("model-access-keyring-unavailable")
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(keys)
  locked = false
  await store.migrate()
  expect(existsSync(file)).toBe(false)
  expect(await store.get("first")).toBe(keys.first)
  await store.set("second", "replacement")
  // Restoring an old plaintext backup to the same profile must not undo a rotation.
  writeFileSync(file, JSON.stringify(keys))
  const restarted = new ModelCredentialStore(dir, vault)
  expect(await restarted.get("second")).toBe("replacement")
  await restarted.set("second", null)
  expect(await store.get("second")).toBeUndefined()
  expect(existsSync(file)).toBe(false)
  expect(await new ModelCredentialStore(temporaryDir(), vault).get("first")).toBeUndefined()
})

test("locked vault permits account and keyless use and protects saved metadata when a rotation or deletion fails", async () => {
  const dir = temporaryDir()
  const vault = createTestKeyring()
  let locked = false
  const check = () => { if (locked) throw new Error("locked") }
  const keyring = {
    get: async (opts: Parameters<typeof vault.get>[0]) => { check(); return vault.get(opts) },
    set: async (opts: Parameters<typeof vault.set>[0]) => { check(); await vault.set(opts) },
    delete: async (opts: Parameters<typeof vault.delete>[0]) => { check(); return vault.delete(opts) },
  }
  const open = () => new ModelAccessService({ dataDir: dir, env: { HOME: dir }, keyring,
    readLegacyPi: async () => null, resolveExecutable: fakeExecutableResolver }).initialize()
  const service = await open()
  const input = { name: "Synthetic", endpoints: [{ protocol: "openai-chat" as const, baseUrl: "https://example.test/v1" }], models: [{ id: "test" }] }
  const saved = await service.saveConnection({ ...input, apiKey: "fixture-secret" })
  await service.setEngine("pi", { access: { mode: "connection", connectionId: saved.id } })
  const privateLocal = await service.saveConnection({ ...input, endpoints: [{ protocol: "openai-responses", baseUrl: "http://localhost/v1" }], apiKey: "fixture-local-key" })
  await service.setEngine("codex", { access: { mode: "connection", connectionId: privateLocal.id } })
  locked = true
  const restarted = await open()
  expect(restarted.getSnapshot().engines.pi.problem).toBe("model-access-keyring-unavailable")
  expect(restarted.getSnapshot().engines.codex.problem).toBe("model-access-keyring-unavailable")
  const local = await restarted.saveConnection({ ...input, endpoints: [{ protocol: "openai-chat", baseUrl: "http://localhost/v1" }] })
  expect(local.keySource).toBe("none")
  await expect(restarted.saveConnection({ ...input, id: saved.id, apiKey: "new-secret" })).rejects.toThrow("model-access-keyring-unavailable")
  await expect(restarted.deleteConnection(saved.id)).rejects.toThrow("model-access-keyring-unavailable")
  expect(restarted.connection(saved.id)?.keySource).toBe("stored")
  locked = false
  expect(await restarted.getKey(saved.id)).toBe("fixture-secret")
})
