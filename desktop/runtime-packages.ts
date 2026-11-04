import { lstat, readFile, readdir, readlink, rm } from "node:fs/promises"
import path from "node:path"

const PI_PACKAGE_PREFIX = "@earendil-works/pi-"
const CLAUDE_NATIVE_PACKAGE_PREFIX = "@anthropic-ai/claude-agent-sdk-"
const CLAUDE_CODE_PACKAGE_PREFIX = "@anthropic-ai/claude-code"
const CODEX_PACKAGE_PREFIX = "@openai/codex"

export function isBundledAgentPackage(name: string) {
  return name.startsWith(PI_PACKAGE_PREFIX)
    || name.startsWith(CLAUDE_NATIVE_PACKAGE_PREFIX)
    || name.startsWith(CLAUDE_CODE_PACKAGE_PREFIX)
    || name.startsWith(CODEX_PACKAGE_PREFIX)
}

function isBundledAgentReference(value: string) {
  return value.includes(PI_PACKAGE_PREFIX)
    || value.includes(CLAUDE_NATIVE_PACKAGE_PREFIX)
    || value.includes(CLAUDE_CODE_PACKAGE_PREFIX)
    || value.includes(CODEX_PACKAGE_PREFIX)
}

function isBundledAgentShim(name: string, reference: string) {
  return ["pi", "claude", "claude-code", "codex", "codex-cli"].includes(name) ||
    isBundledAgentReference(reference)
}

async function packageName(packageDir: string) {
  try {
    const metadata = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8")) as { name?: unknown }
    return typeof metadata.name === "string" ? metadata.name : undefined
  } catch {
    return undefined
  }
}

async function moduleDirectories(modulesDir: string) {
  try {
    return await readdir(modulesDir, { withFileTypes: true })
  } catch {
    return []
  }
}

async function prunePackage(packageDir: string) {
  const name = await packageName(packageDir)
  if (name && isBundledAgentPackage(name)) {
    await rm(packageDir, { recursive: true, force: true })
    return
  }
  await pruneModules(path.join(packageDir, "node_modules"))
}

async function pruneModules(modulesDir: string): Promise<void> {
  for (const entry of await moduleDirectories(modulesDir)) {
    const entryPath = path.join(modulesDir, entry.name)
    if (entry.name === ".bin") {
      await pruneBinaryShims(entryPath)
      continue
    }
    if (entry.name.startsWith("@") && entry.isDirectory()) {
      for (const nestedPackage of await moduleDirectories(entryPath)) {
        if (nestedPackage.isDirectory() || nestedPackage.isSymbolicLink())
          await prunePackage(path.join(entryPath, nestedPackage.name))
      }
      continue
    }
    if (entry.isDirectory() || entry.isSymbolicLink()) await prunePackage(entryPath)
  }
}

async function pruneBinaryShims(binDir: string) {
  for (const entry of await moduleDirectories(binDir)) {
    const entryPath = path.join(binDir, entry.name)
    let reference = entry.name
    try {
      if (entry.isSymbolicLink()) reference += ` ${await readlink(entryPath)}`
      else reference += ` ${await readFile(entryPath, "utf8")}`
    } catch {
      // A broken shim is safe to remove with the agent packages it references.
    }
    if (isBundledAgentShim(entry.name, reference))
      await rm(entryPath, { recursive: true, force: true })
  }
}

async function collectPackageIssues(modulesDir: string, issues: string[]): Promise<void> {
  for (const entry of await moduleDirectories(modulesDir)) {
    if (entry.name === ".bin") {
      for (const shim of await moduleDirectories(path.join(modulesDir, entry.name))) {
        const shimPath = path.join(modulesDir, entry.name, shim.name)
        let reference = shim.name
        try {
          if (shim.isSymbolicLink()) reference += ` ${await readlink(shimPath)}`
          else reference += ` ${await readFile(shimPath, "utf8")}`
        } catch {
          // Report the shim name below if it is an agent entry point.
        }
        if (isBundledAgentShim(shim.name, reference)) issues.push(shimPath)
      }
      continue
    }
    const entryPath = path.join(modulesDir, entry.name)
    if (entry.name.startsWith("@") && entry.isDirectory()) {
      for (const nestedPackage of await moduleDirectories(entryPath)) {
        if (!(nestedPackage.isDirectory() || nestedPackage.isSymbolicLink())) continue
        const packagePath = path.join(entryPath, nestedPackage.name)
        const name = await packageName(packagePath)
        if (name && isBundledAgentPackage(name)) issues.push(packagePath)
        await collectPackageIssues(path.join(packagePath, "node_modules"), issues)
      }
      continue
    }
    if (!(entry.isDirectory() || entry.isSymbolicLink())) continue
    const name = await packageName(entryPath)
    if (name && isBundledAgentPackage(name)) issues.push(entryPath)
    await collectPackageIssues(path.join(entryPath, "node_modules"), issues)
  }
}

export async function removeBundledAgentPackages(nodeModulesDir: string) {
  await pruneModules(nodeModulesDir)
}

export async function findBundledAgentPackages(nodeModulesDir: string) {
  const issues: string[] = []
  await collectPackageIssues(nodeModulesDir, issues)
  return issues
}

export async function hasNodeModules(directory: string) {
  try {
    return (await lstat(directory)).isDirectory()
  } catch {
    return false
  }
}
