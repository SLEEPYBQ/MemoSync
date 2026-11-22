import type { resolveEngineExecutable } from "./executables"

/** Mapping/transport unit tests do not probe CLIs installed on the test host. */
export const fakeExecutableResolver: typeof resolveEngineExecutable = async (engine, setup) =>
  engine === "pi" ? { state: "not-needed" } : {
    state: "ready", path: setup?.executablePath ?? process.execPath,
    source: setup?.executablePath ? "configured" : "path",
  }

/** Isolated OS-vault stand-in shared by reopened services within a test run. */
export function createTestKeyring(): import("./keyring").Keyring {
  const values = new Map<string, string>()
  const key = (service: string, name: string) => JSON.stringify([service, name])
  return {
    get: async ({ service, name }) => values.get(key(service, name)) ?? null,
    set: async ({ service, name, value }) => { values.set(key(service, name), value) },
    delete: async ({ service, name }) => values.delete(key(service, name)),
  }
}
export const testKeyring = createTestKeyring()
