import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

const require = createRequire(import.meta.url)
export interface SdkInstallation {
  minimumVersion: string
  bundledPaths: string[]
}

/** Resolve relative to the SDK, just as sdk.mjs does (including Linux libc order). */
export function readSdkInstallation(
  entry: string = require.resolve("@anthropic-ai/claude-agent-sdk"),
  platform: string = process.platform,
  arch: string = process.arch,
  preferMusl = platform === "linux" && !((process.report?.getReport() as { header?: { glibcVersionRuntime?: string } })?.header?.glibcVersionRuntime),
): SdkInstallation {
  const metadata = JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8"))
  if (typeof metadata.claudeCodeVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(metadata.claudeCodeVersion))
    throw new Error("Claude Agent SDK has no valid claudeCodeVersion")
  const prefix = "@anthropic-ai/claude-agent-sdk"
  const packages = platform === "android" ? [`${prefix}-linux-${arch}-android`]
    : platform === "linux" ? (preferMusl ? [`${prefix}-linux-${arch}-musl`, `${prefix}-linux-${arch}`]
      : [`${prefix}-linux-${arch}`, `${prefix}-linux-${arch}-musl`])
      : [`${prefix}-${platform}-${arch}`]
  const sdkRequire = createRequire(entry)
  const bundledPaths: string[] = []
  for (const name of packages) {
    try { bundledPaths.push(sdkRequire.resolve(`${name}/claude${platform === "win32" ? ".exe" : ""}`)) }
    catch { /* optional platform dependency absent */ }
  }
  return { minimumVersion: metadata.claudeCodeVersion, bundledPaths }
}
