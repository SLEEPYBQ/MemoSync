import type { resolveEngineExecutable } from "./executables"

/** Mapping/transport unit tests do not probe CLIs installed on the test host. */
export const fakeExecutableResolver: typeof resolveEngineExecutable = async (engine, setup) =>
  engine === "pi" ? { state: "not-needed" } : {
    state: "ready", path: setup?.executablePath ?? process.execPath,
    source: setup?.executablePath ? "configured" : "path",
  }
