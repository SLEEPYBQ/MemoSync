import { createExecutableResolver } from "./resolver"
export { executableLauncher } from "./launcher"

const resolver = createExecutableResolver()

/** Call after the server's shellPathReady, using its freshly imported PATH. */
export const resolveEngineExecutable = resolver.resolveEngineExecutable
/** Invalidate probes after install/update, a launch failure, or a manual rescan. */
export const refreshExecutables = resolver.refreshExecutables
/** Informational snapshot only; resolve again before starting a turn. */
export const lastEngineExecutable = resolver.lastEngineExecutable
