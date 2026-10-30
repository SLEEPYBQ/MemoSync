// JS/symlink launcher handling adapted from DispatchDock, MIT License,
// Copyright (c) 2026 LBEILC. See THIRD_PARTY_NOTICES.md.
import { constants } from "node:fs"
import { access, open, readFile, realpath, stat } from "node:fs/promises"
import { delimiter, dirname, join, resolve } from "node:path"
import type { ExecutableEnvironment } from "./discovery-paths"

export interface ExecutableLauncher {
  command: string
  args: string[]
}

async function runnable(file: string) {
  try {
    if (!(await stat(file)).isFile()) return false
    await access(file, constants.X_OK)
    return true
  } catch { return false }
}

/**
 * The status.path stays a real CLI path, not a shell command. T2 must use this
 * helper for spawn: JS entries need a runtime even on a GUI's node-less PATH.
 * No shell evaluation; only the standard npm Windows shim format is supported.
 */
export async function executableLauncher(file: string, env: ExecutableEnvironment = process.env): Promise<ExecutableLauncher> {
  const target = await realpath(file)
  if (!(await stat(target)).isFile()) throw new Error("Executable path is not a file")
  await access(target, constants.R_OK)
  if (/\.(cmd|bat)$/i.test(target)) {
    const wrapper = await readFile(target, "utf8")
    const match = wrapper.match(/"%dp0%[\\/]([^"\r\n]+\.(?:js|mjs|cjs))"\s+%\*/i)
    if (!match) throw new Error("Unsupported executable shim; configure the native binary or JS entry")
    return executableLauncher(resolve(dirname(target), match[1]!.replaceAll("\\", "/")), env)
  }
  const handle = await open(target, "r")
  let firstLine: string
  try {
    const buffer = Buffer.alloc(512)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    firstLine = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/, 1)[0] ?? ""
  } finally { await handle.close() }
  const shebang = /^#!.*\b(node|bun)(?:\s|$)/.exec(firstLine)
  if (!/\.(js|mjs|cjs)$/i.test(target) && !shebang) {
    if (!await runnable(target)) throw new Error("File is not executable")
    return { command: target, args: [] }
  }
  const runtime = shebang?.[1] ?? "node"
  const name = `${runtime}${process.platform === "win32" ? ".exe" : ""}`
  const candidates = [join(dirname(resolve(file)), name), join(dirname(target), name)]
  // npm globals in a version manager point into lib/node_modules, while that
  // version's runtime is in bin. Stay within a bounded set of ancestors.
  let parent = dirname(target)
  for (let depth = 0; depth < 6; depth++) {
    const next = dirname(parent)
    if (next === parent) break
    candidates.push(join(parent, "bin", name))
    parent = next
  }
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) candidates.push(resolve(dir, name))
  for (const candidate of new Set(candidates)) {
    if (await runnable(candidate)) return { command: await realpath(candidate), args: [target] }
  }
  // The service's Bun/Node is an absolute, already running JS runtime. Like
  // DispatchDock, use it as a last resort rather than /usr/bin/env node.
  return { command: process.execPath, args: [target] }
}
