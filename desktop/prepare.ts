import { chmod, cp, mkdir, readdir, rm } from "node:fs/promises"
import path from "node:path"
import { findBundledAgentPackages, hasNodeModules, removeBundledAgentPackages } from "./runtime-packages"
import { verifyNativeTarget } from "./platform"

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

async function prepareRuntime() {
  const target = verifyNativeTarget(process.env.MEMOSYNC_TARGET_PLATFORM, process.env.MEMOSYNC_TARGET_ARCH)
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
  await cp(process.execPath, path.join(runtimeDir, target.bunName))
  if (process.platform !== "win32") await chmod(path.join(runtimeDir, target.bunName), 0o755)

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

  console.log(`Prepared ${runtimeDir} for ${target.platform}/${target.arch} with Bun ${Bun.version}`)
}

if (import.meta.main) {
  prepareRuntime().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
