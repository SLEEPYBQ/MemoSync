import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
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

async function addShim(nodeModules: string, name: string, reference = "agent shim") {
  const binDir = join(nodeModules, ".bin")
  await mkdir(binDir, { recursive: true })
  await writeFile(join(binDir, name), reference)
}

test("removes nested agent packages and shims but keeps Claude transport", async () => {
  fixture = await mkdtemp(join(tmpdir(), "memosync-runtime-packages-"))
  const nodeModules = join(fixture, "node_modules")
  const nestedModules = join(nodeModules, "wrapper", "node_modules")
  const transport = await addPackage(nodeModules, "@anthropic-ai/claude-agent-sdk")
  await writeFile(join(transport, "bridge.mjs"), "export {}")
  await addPackage(nodeModules, "@mariozechner/pi-coding-agent")
  const wrapper = await addPackage(nodeModules, "wrapper")
  const pi = await addPackage(nestedModules, "@mariozechner/pi-agent-core")
  const nativeClaude = await addPackage(nestedModules, "@anthropic-ai/claude-agent-sdk-darwin-arm64")
  const claudeCode = await addPackage(nestedModules, "@anthropic-ai/claude-code")
  const codex = await addPackage(nestedModules, "@openai/codex")
  await addPackage(nestedModules, "@openai/codex-cli")
  await mkdir(join(wrapper, "cache"), { recursive: true })
  await mkdir(join(wrapper, "fixtures"), { recursive: true })
  await writeFile(join(wrapper, ".env.test"), "not for shipping")
  await writeFile(join(wrapper, "metadata.test.js"), "not for shipping")
  await addShim(nodeModules, "pi.cmd")
  await addShim(nestedModules, "claude-code.bat")
  await addShim(nestedModules, "codex.ps1")
  await addShim(nestedModules, "codex-cli.exe")
  await addShim(nestedModules, "typescript.cmd")

  const issues = await findBundledAgentPackages(nodeModules)
  for (const shimPath of [
    join(nodeModules, ".bin", "pi.cmd"),
    join(nestedModules, ".bin", "claude-code.bat"),
    join(nestedModules, ".bin", "codex.ps1"),
    join(nestedModules, ".bin", "codex-cli.exe"),
  ]) expect(issues).toContain(shimPath)

  await removeBundledAgentPackages(nodeModules)

  expect(await findBundledAgentPackages(nodeModules)).toEqual([])
  await expect(stat(join(transport, "bridge.mjs"))).resolves.toBeTruthy()
  for (const directory of [pi, nativeClaude, claudeCode, codex, join(nodeModules, ".bin"), join(nestedModules, ".bin")]) {
    await expect(stat(directory)).rejects.toThrow()
  }
  for (const entry of ["cache", "fixtures", ".env.test", "metadata.test.js"]) {
    await expect(stat(join(wrapper, entry))).rejects.toThrow()
  }
})
