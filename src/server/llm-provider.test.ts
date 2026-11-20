import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { acquireLlmProviderFileLock } from "./data-directory-lock"
import type { Keyring } from "./model-access/keyring"
import { resolveEngineRuntime } from "./model-access/runtime"
import { ModelAccessService } from "./model-access/service"
import { fakeExecutableResolver, testKeyring } from "./model-access/test-fixtures"
import { getLlmProviderFilePath } from "../shared/branding"
import { DEFAULT_OPENAI_SDK_MODEL, DEFAULT_OPENROUTER_SDK_MODEL } from "../shared/types"
import {
  normalizeLlmProviderSnapshot,
  OPENAI_BASE_URL,
  OPENROUTER_BASE_URL,
  readLlmProviderSnapshot,
  resolveLlmProviderBaseUrl,
  writeLlmProviderSnapshot,
} from "./llm-provider"

let tempDirs: string[] = []
const TEST_FILE_PATH = "/tmp/kanna-test-llm-provider.json"

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

async function createTempFilePath() {
  const dir = await mkdtemp(path.join(tmpdir(), "kanna-llm-provider-"))
  tempDirs.push(dir)
  return path.join(dir, "llm-provider.json")
}

describe("resolveLlmProviderBaseUrl", () => {
  test("derives known provider URLs and preserves custom URLs", () => {
    expect(resolveLlmProviderBaseUrl("openai", "")).toBe(OPENAI_BASE_URL)
    expect(resolveLlmProviderBaseUrl("openrouter", "")).toBe(OPENROUTER_BASE_URL)
    expect(resolveLlmProviderBaseUrl("custom", " https://example.com/v1 ")).toBe("https://example.com/v1")
  })
})

describe("normalizeLlmProviderSnapshot", () => {
  test("normalizes a valid custom provider config", () => {
    expect(normalizeLlmProviderSnapshot({
      provider: "custom",
      apiKey: "  test-key  ",
      model: "  gpt-test  ",
      baseUrl: " https://example.com/v1 ",
    }, TEST_FILE_PATH)).toEqual({
      provider: "custom",
      apiKey: "test-key",
      model: "gpt-test",
      baseUrl: "https://example.com/v1",
      resolvedBaseUrl: "https://example.com/v1",
      enabled: true,
      warning: null,
      filePathDisplay: TEST_FILE_PATH,
    })
  })

  test("disables invalid configs with a warning", () => {
    const snapshot = normalizeLlmProviderSnapshot({
      provider: "custom",
      apiKey: "test-key",
      model: "gpt-test",
      baseUrl: "",
    }, TEST_FILE_PATH)

    expect(snapshot.enabled).toBe(false)
    expect(snapshot.warning).toContain("custom provider requires a baseUrl")
  })
})

describe("readLlmProviderSnapshot", () => {
  test("returns defaults when the file does not exist", async () => {
    const filePath = await createTempFilePath()
    expect(await readLlmProviderSnapshot(filePath, testKeyring)).toEqual({
      provider: "openai",
      apiKey: "",
      model: DEFAULT_OPENAI_SDK_MODEL,
      baseUrl: "",
      resolvedBaseUrl: OPENAI_BASE_URL,
      enabled: false,
      warning: null,
      filePathDisplay: filePath,
    })
    expect(await Bun.file(`${filePath}.lock.sqlite`).exists()).toBe(false)
  })

  test("returns a warning when the file contains invalid json", async () => {
    const filePath = await createTempFilePath()
    await writeFile(filePath, "{not-json", "utf8")

    const snapshot = await readLlmProviderSnapshot(filePath, testKeyring)
    expect(snapshot.enabled).toBe(false)
    expect(snapshot.warning).toContain("invalid JSON")
  })

  test("fills named-provider default models when the file omits them", async () => {
    const filePath = await createTempFilePath()
    await writeFile(filePath, JSON.stringify({
      provider: "openrouter",
      apiKey: "test-key",
      baseUrl: null,
    }), "utf8")

    const snapshot = await readLlmProviderSnapshot(filePath, testKeyring)
    expect(snapshot.model).toBe(DEFAULT_OPENROUTER_SDK_MODEL)
    expect(snapshot.enabled).toBe(true)
    expect(await readLlmProviderSnapshot(filePath, testKeyring)).toEqual(snapshot)
    expect(await Bun.file(filePath).json()).toEqual({
      provider: "openrouter",
      baseUrl: null,
      credentialRef: expect.any(String),
    })
  })

  test("tightens permissions on a provider file created by an older version", async () => {
    const filePath = await createTempFilePath()
    await writeFile(filePath, JSON.stringify({ provider: "openai", apiKey: "secret", model: "gpt-test" }), "utf8")
    await chmod(filePath, 0o644)

    await readLlmProviderSnapshot(filePath, testKeyring)

    expect((await stat(filePath)).mode & 0o777).toBe(0o600)
  })
})

describe("writeLlmProviderSnapshot", () => {
  test("writes normalized config to disk", async () => {
    const filePath = await createTempFilePath()
    const snapshot = await writeLlmProviderSnapshot({
      provider: "openrouter",
      apiKey: " test-key ",
      model: " openrouter/model ",
      baseUrl: "ignored",
    }, filePath, testKeyring)

    expect(snapshot).toEqual({
      provider: "openrouter",
      apiKey: "test-key",
      model: "openrouter/model",
      baseUrl: "ignored",
      resolvedBaseUrl: OPENROUTER_BASE_URL,
      enabled: true,
      warning: null,
      filePathDisplay: filePath,
    })
    expect(await Bun.file(filePath).json()).toEqual({
      provider: "openrouter",
      model: "openrouter/model",
      baseUrl: null,
      credentialRef: expect.any(String),
    })
    expect((await readLlmProviderSnapshot(filePath, testKeyring)).apiKey).toBe("test-key")
    expect((await stat(filePath)).mode & 0o777).toBe(0o600)
  })

  test("supports concurrent atomic writes without sharing a temp file", async () => {
    const filePath = await createTempFilePath()
    const values = ["first-key", "second-key"] as const

    await Promise.all(values.map((apiKey) => writeLlmProviderSnapshot({
      provider: "openai",
      apiKey,
      model: "gpt-test",
      baseUrl: "",
    }, filePath, testKeyring)))

    expect((await readLlmProviderSnapshot(filePath, testKeyring)).apiKey).toBe(values[1])
    expect((await stat(filePath)).mode & 0o777).toBe(0o600)
  })
})

const unavailableKeyring: Keyring = {
  get: async () => { throw new Error("synthetic keyring failure") },
  set: async () => { throw new Error("synthetic keyring failure") },
  delete: async () => { throw new Error("synthetic keyring failure") },
}

describe("protected provider credentials", () => {
  const connection = { provider: "openai", apiKey: "synthetic-key", model: "first-model", baseUrl: "" } as const

  test("shares the migrated credential with the Model Access Pi runtime without exposing it to Settings", async () => {
    const home = path.dirname(await createTempFilePath())
    const env = { HOME: home }
    const filePath = getLlmProviderFilePath(home, env)
    await mkdir(path.dirname(filePath))
    await writeFile(filePath, JSON.stringify(connection))

    const service = await new ModelAccessService({
      dataDir: path.join(home, "data"),
      env,
      keyring: testKeyring,
      resolveExecutable: fakeExecutableResolver,
    }).initialize()
    expect(service.setup("pi").access).toMatchObject({ connectionId: "env-llm-provider" })
    expect(JSON.stringify(service.getSnapshot())).not.toContain(connection.apiKey)
    expect((await resolveEngineRuntime({ engine: "pi", service })).piConnection?.apiKey).toBe(connection.apiKey)
    expect((await readLlmProviderSnapshot(filePath, testKeyring)).apiKey).toBe(connection.apiKey)
    expect(await readFile(filePath, "utf8")).not.toContain(connection.apiKey)
  })

  test("preserves legacy plaintext for retry while storage is unavailable", async () => {
    const filePath = await createTempFilePath()
    const legacy = JSON.stringify(connection)
    await writeFile(filePath, legacy)
    expect(await readLlmProviderSnapshot(filePath, unavailableKeyring)).toMatchObject({
      apiKey: "",
      model: connection.model,
      enabled: false,
      warning: expect.stringContaining("protected storage"),
    })

    await expect(writeLlmProviderSnapshot({ ...connection, apiKey: "" }, filePath, unavailableKeyring)).rejects.toThrow("model-access-keyring-unavailable")
    expect(await readFile(filePath, "utf8")).toBe(legacy)
    expect(await readLlmProviderSnapshot(filePath, testKeyring)).toMatchObject({ apiKey: connection.apiKey, enabled: true })
    expect(await readFile(filePath, "utf8")).not.toContain(connection.apiKey)
  })

  test("keeps the committed credential and metadata when a replacement cannot be staged", async () => {
    const filePath = await createTempFilePath()
    await writeLlmProviderSnapshot(connection, filePath, testKeyring)
    const committed = await readFile(filePath, "utf8")
    const next = { ...connection, model: "second-model", apiKey: "new-synthetic-key" }
    await expect(writeLlmProviderSnapshot(next, filePath, unavailableKeyring)).rejects.toThrow("model-access-keyring-unavailable")
    await expect(writeLlmProviderSnapshot({ ...next, apiKey: "" }, filePath, unavailableKeyring)).rejects.toThrow("model-access-keyring-unavailable")
    expect(await readFile(filePath, "utf8")).toBe(committed)
    expect(await readLlmProviderSnapshot(filePath, testKeyring)).toMatchObject({ apiKey: connection.apiKey, model: connection.model })
  })

  test("removes a staged vault entry if committing metadata fails", async () => {
    const filePath = await createTempFilePath()
    let staged: Parameters<Keyring["get"]>[0] | undefined
    const blockedCommit: Keyring = {
      ...testKeyring,
      set: async (entry) => {
        await testKeyring.set(entry)
        staged = { service: entry.service, name: entry.name }
        await mkdir(filePath)
      },
    }
    await expect(writeLlmProviderSnapshot(connection, filePath, blockedCommit)).rejects.toThrow("model-access-storage-write-failed")
    expect(staged).toBeDefined()
    expect(await testKeyring.get(staged!)).toBeNull()
  })

  test("keeps the active credential usable and retries old vault entry removal", async () => {
    const filePath = await createTempFilePath()
    let previous: Parameters<Keyring["get"]>[0] | undefined
    const failingDelete: Keyring = {
      ...testKeyring,
      set: async (entry) => {
        previous ??= { service: entry.service, name: entry.name }
        await testKeyring.set(entry)
      },
      delete: async () => { throw new Error("synthetic deletion failure") },
    }
    await writeLlmProviderSnapshot(connection, filePath, failingDelete)
    const first = await Bun.file(filePath).json() as { credentialRef: string }

    await writeLlmProviderSnapshot({ ...connection, model: "edited-model" }, filePath, testKeyring)
    expect((await Bun.file(filePath).json()).credentialRef).toBe(first.credentialRef)

    const next = { ...connection, apiKey: "new-synthetic-key" }
    await writeLlmProviderSnapshot(next, filePath, failingDelete)
    expect((await Bun.file(filePath).json()).retiredCredentialRefs).toEqual([first.credentialRef])
    expect(await testKeyring.get(previous!)).toBe(connection.apiKey)
    expect((await readLlmProviderSnapshot(filePath, failingDelete)).apiKey).toBe(next.apiKey)
    expect((await readLlmProviderSnapshot(filePath, testKeyring)).apiKey).toBe(next.apiKey)
    expect(await testKeyring.get(previous!)).toBeNull()
    expect((await Bun.file(filePath).json()).retiredCredentialRefs).toBeUndefined()
  })

  test("waits for the provider file lock without blocking another holder's release", async () => {
    const filePath = await createTempFilePath()
    const legacy = JSON.stringify(connection)
    await writeFile(filePath, legacy)
    const lock = await acquireLlmProviderFileLock(filePath)
    const reading = readLlmProviderSnapshot(filePath, testKeyring)
    try {
      await Bun.sleep(80)
      expect(await readFile(filePath, "utf8")).toBe(legacy)
    } finally {
      lock.release()
    }
    expect((await reading).apiKey).toBe(connection.apiKey)
    expect(await readFile(filePath, "utf8")).not.toContain(connection.apiKey)
  })

  test("retains the previous key until a concurrent reader finishes", async () => {
    const filePath = await createTempFilePath()
    let previous: Parameters<Keyring["get"]>[0] | undefined
    const keyring: Keyring = {
      ...testKeyring,
      set: async (entry) => {
        previous ??= { service: entry.service, name: entry.name }
        await testKeyring.set(entry)
      },
    }
    await writeLlmProviderSnapshot(connection, filePath, keyring)
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const pausedReader: Keyring = {
      ...keyring,
      get: async (entry) => {
        entered.resolve()
        await resume.promise
        return keyring.get(entry)
      },
    }
    const reading = readLlmProviderSnapshot(filePath, pausedReader)
    await entered.promise
    const next = { ...connection, model: "second-model", apiKey: "new-synthetic-key" }
    try {
      const updating = writeLlmProviderSnapshot(next, filePath, keyring)
      expect(await testKeyring.get(previous!)).toBe(connection.apiKey)
      resume.resolve()
      expect(await reading).toMatchObject({ apiKey: connection.apiKey, model: connection.model })
      await updating
      expect(await readLlmProviderSnapshot(filePath, keyring)).toMatchObject({ apiKey: next.apiKey, model: next.model })
      expect(await testKeyring.get(previous!)).toBeNull()
    } finally {
      resume.resolve()
    }
  })
})
