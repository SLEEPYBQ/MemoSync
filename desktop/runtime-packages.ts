import { lstat, readFile, readdir, readlink, rm } from "node:fs/promises"
import path from "node:path"

const PI_PACKAGE_PREFIX = "@mariozechner/pi-"
const CLAUDE_NATIVE_PACKAGE_PREFIX = "@anthropic-ai/claude-agent-sdk-"
const CLAUDE_CODE_PACKAGE_PREFIX = "@anthropic-ai/claude-code"
const CODEX_PACKAGE_PREFIX = "@openai/codex"
const excludedDirectories = new Set([
  ".bin", ".cache", "cache", "test", "tests", "__tests__", "fixtures", "__fixtures__",
  "userdata", "user-data", "user_data",
])
const agentShimNames = new Set(["pi", "claude", "claude-code", "codex", "codex-cli"])

function isUnshippedArtifact(name: string, isDirectory: boolean) {
  const normalized = name.toLowerCase()
  return (isDirectory && excludedDirectories.has(normalized))
    || /^\.env(?:\.|$)/i.test(name)
    || /\.(test|spec)\.[^.]+$/i.test(name)
}

export function isBundledAgentPackage(name: string) {
  return name.startsWith(PI_PACKAGE_PREFIX)
    || name.startsWith(CLAUDE_NATIVE_PACKAGE_PREFIX)
    || name.startsWith(CLAUDE_CODE_PACKAGE_PREFIX)
    || name.startsWith(CODEX_PACKAGE_PREFIX)
}

function isBundledAgentReference(value: string) {
  const normalized = value.toLowerCase()
  return normalized.includes(PI_PACKAGE_PREFIX)
    || normalized.includes(CLAUDE_NATIVE_PACKAGE_PREFIX)
    || normalized.includes(CLAUDE_CODE_PACKAGE_PREFIX)
    || normalized.includes(CODEX_PACKAGE_PREFIX)
}

function isBundledAgentShim(name: string, reference: string) {
  const baseName = name.toLowerCase().replace(/\.(?:cmd|bat|ps1|exe)$/i, "")
  return agentShimNames.has(baseName) ||
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
  await pruneUnshippedEntries(packageDir)
  await pruneModules(path.join(packageDir, "node_modules"))
}

async function pruneUnshippedEntries(directory: string): Promise<void> {
  for (const entry of await moduleDirectories(directory)) {
    const entryPath = path.join(directory, entry.name)
    if (isUnshippedArtifact(entry.name, entry.isDirectory() || entry.isSymbolicLink())) {
      await rm(entryPath, { recursive: true, force: true })
    } else if (entry.isDirectory()) {
      await pruneUnshippedEntries(entryPath)
    }
  }
}

async function pruneModules(modulesDir: string): Promise<void> {
  for (const entry of await moduleDirectories(modulesDir)) {
    const entryPath = path.join(modulesDir, entry.name)
    if (entry.name === ".bin") {
      await pruneBinaryShims(entryPath)
      await rm(entryPath, { recursive: true, force: true })
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
      issues.push(path.join(modulesDir, entry.name))
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
  await pruneUnshippedEntries(nodeModulesDir)
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
