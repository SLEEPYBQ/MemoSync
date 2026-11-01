import { chmod, cp, mkdir, readdir, rm } from "node:fs/promises"
import path from "node:path"
import { findBundledAgentPackages, hasNodeModules, removeBundledAgentPackages } from "./runtime-packages"

export const REQUIRED_BUN_VERSION = "1.3.10"

const desktopDir = path.resolve(import.meta.dir)
const repoRoot = path.resolve(desktopDir, "..")
const buildDir = path.join(desktopDir, "build")
const runtimeDir = path.join(buildDir, "runtime")
const excludedSourceEntries = new Set(["test", "tests", "__tests__", "fixtures", "__fixtures__"])

async function copyRuntimeSource(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (excludedSourceEntries.has(entry.name) || /\.(test|spec)\.[^.]+$/.test(entry.name)) continue
    const sourcePath = path.join(source, entry.name)
    const destinationPath = path.join(destination, entry.name)
    if (entry.isDirectory()) await copyRuntimeSource(sourcePath, destinationPath)
    else if (entry.isFile()) await cp(sourcePath, destinationPath)
  }
}

function run(command: string[], cwd = repoRoot) {
  const result = Bun.spawnSync(command, { cwd, stdout: "inherit", stderr: "inherit" })
  if (!result.success) throw new Error(`Command failed (${result.exitCode}): ${command.join(" ")}`)
}

function verifyNativeRuntime() {
  if (process.platform !== "darwin") throw new Error("macOS packaging must run on macOS")
  if (process.arch !== "arm64" && process.arch !== "x64")
    throw new Error(`Unsupported macOS architecture: ${process.arch}`)
  if (process.env.MEMOSYNC_TARGET_ARCH && process.env.MEMOSYNC_TARGET_ARCH !== process.arch)
    throw new Error(`Native build architecture mismatch: expected ${process.env.MEMOSYNC_TARGET_ARCH}, got ${process.arch}`)
  if (Bun.version !== REQUIRED_BUN_VERSION)
    throw new Error(`MemoSync packaging requires Bun ${REQUIRED_BUN_VERSION}, got ${Bun.version}`)
}

async function prepareRuntime() {
  verifyNativeRuntime()
  run([process.execPath, "run", "build"])
  await rm(buildDir, { recursive: true, force: true })
  await mkdir(path.join(runtimeDir, "desktop"), { recursive: true })

  for (const directory of ["src/server", "src/shared"])
    await copyRuntimeSource(path.join(repoRoot, directory), path.join(runtimeDir, directory))
  for (const directory of ["dist/client", "dist/export-viewer"])
    await cp(path.join(repoRoot, directory), path.join(runtimeDir, directory), { recursive: true })
  for (const file of ["package.json", "bun.lock", "LICENSE", "THIRD_PARTY_NOTICES.md"])
    await cp(path.join(repoRoot, file), path.join(runtimeDir, file))
  await cp(path.join(desktopDir, "server.ts"), path.join(runtimeDir, "desktop/server.ts"))
  await cp(process.execPath, path.join(runtimeDir, "bun"))
  await chmod(path.join(runtimeDir, "bun"), 0o755)

  run([
    process.execPath,
    "install",
    "--production",
    "--frozen-lockfile",
    "--ignore-scripts",
    "--omit=optional",
    "--linker=hoisted",
  ], runtimeDir)

  const nodeModulesDir = path.join(runtimeDir, "node_modules")
  if (!await hasNodeModules(nodeModulesDir)) throw new Error("Staged runtime has no production node_modules")
  await removeBundledAgentPackages(nodeModulesDir)
  const bundledAgents = await findBundledAgentPackages(nodeModulesDir)
  if (bundledAgents.length > 0)
    throw new Error(`Staged runtime still contains agent packages:\n${bundledAgents.join("\n")}`)

  console.log(`Prepared ${runtimeDir} for macOS ${process.arch} with Bun ${Bun.version}`)
}

if (import.meta.main) {
  prepareRuntime().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
