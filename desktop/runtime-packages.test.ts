import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { findBundledAgentPackages, removeBundledAgentPackages } from "./runtime-packages"

let fixture: string | undefined

afterEach(async () => {
  if (fixture) await rm(fixture, { recursive: true, force: true })
  fixture = undefined
})

async function addPackage(nodeModules: string, name: string) {
  const packageDir = join(nodeModules, ...name.split("/"))
  await mkdir(packageDir, { recursive: true })
  await writeFile(join(packageDir, "package.json"), JSON.stringify({ name }))
  return packageDir
}

async function addShim(nodeModules: string, name: string, target: string) {
  const binDir = join(nodeModules, ".bin")
  await mkdir(binDir, { recursive: true })
  await symlink(target, join(binDir, name))
}

test("removes nested agent packages and shims but keeps Claude transport", async () => {
  fixture = await mkdtemp(join(tmpdir(), "memosync-runtime-packages-"))
  const nodeModules = join(fixture, "node_modules")
  const nestedModules = join(nodeModules, "wrapper", "node_modules")
  const transport = await addPackage(nodeModules, "@anthropic-ai/claude-agent-sdk")
  await writeFile(join(transport, "bridge.mjs"), "export {}")
  await addPackage(nodeModules, "@earendil-works/pi-coding-agent")
  await addPackage(nodeModules, "wrapper")
  const pi = await addPackage(nestedModules, "@earendil-works/pi-agent-core")
  const nativeClaude = await addPackage(nestedModules, "@anthropic-ai/claude-agent-sdk-darwin-arm64")
  const claudeCode = await addPackage(nestedModules, "@anthropic-ai/claude-code")
  const codex = await addPackage(nestedModules, "@openai/codex")
  await addPackage(nestedModules, "@openai/codex-cli")
  await addShim(nodeModules, "pi", "../@earendil-works/pi-coding-agent/dist/cli.js")
  await addShim(nestedModules, "claude", "../@anthropic-ai/claude-code/bin/claude")
  await addShim(nestedModules, "codex", "../@openai/codex/bin/codex")
  await addShim(nestedModules, "native-agent", "../@anthropic-ai/claude-agent-sdk-darwin-arm64/index.js")

  await removeBundledAgentPackages(nodeModules)

  expect(await findBundledAgentPackages(nodeModules)).toEqual([])
  await expect(stat(join(transport, "bridge.mjs"))).resolves.toBeTruthy()
  for (const directory of [pi, nativeClaude, claudeCode, codex]) {
    await expect(stat(directory)).rejects.toThrow()
  }
})
