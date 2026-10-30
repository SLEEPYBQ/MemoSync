import type { EngineId, EngineSetup, ExecutableStatus } from "../../shared/model-access"

/**
 * Find the executable an engine should run. Contract shared by the runtime
 * (which passes `path` to the SDK / spawn) and the status shown in Settings.
 *
 * Placeholder: keeps today's behaviour (Claude uses the SDK's bundled CLI or
 * CLAUDE_EXECUTABLE; Codex is `codex` from PATH). The discovery task replaces
 * the body; the signature and result shape stay.
 */
export async function resolveEngineExecutable(
  engine: EngineId,
  setup?: Pick<EngineSetup, "executablePath">,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ExecutableStatus> {
  if (engine === "pi") return { state: "not-needed" }
  const configured = setup?.executablePath?.trim()
  if (engine === "claude") {
    const explicit = configured || env.CLAUDE_EXECUTABLE?.trim()
    return explicit ? { state: "ready", path: explicit, source: "configured" } : { state: "ready", source: "bundled" }
  }
  return { state: "ready", path: configured || "codex", source: configured ? "configured" : "path" }
}
