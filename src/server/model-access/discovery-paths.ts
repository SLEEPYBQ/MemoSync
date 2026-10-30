// Adapted from Magpie (https://github.com/yetone/magpie), MIT License, Copyright (c) 2026 yetone
// Also adapted from DispatchDock's launcher-paths.mjs, MIT License,
// Copyright (c) 2026 LBEILC. See THIRD_PARTY_NOTICES.md.
import { readdir, readFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"

export type ExecutableEnvironment = Readonly<Record<string, string | undefined>>

/** Bounded, one-level scans only. Never execute package managers or shell rc files. */
export async function knownInstallDirectories(
  env: ExecutableEnvironment,
  systemDirectories: readonly string[] = ["/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin"],
  runtimePath: string = process.execPath,
): Promise<string[]> {
  const dirs: string[] = []
  const add = (dir: string | undefined) => { if (dir && isAbsolute(dir)) dirs.push(resolve(dir)) }
  add(dirname(runtimePath))
  for (const key of ["NVM_BIN", "PNPM_HOME"]) add(env[key])
  for (const key of ["NPM_CONFIG_PREFIX", "npm_config_prefix", "VOLTA_HOME", "BUN_INSTALL"])
    if (env[key]) add(join(env[key], "bin"))
  if (env.FNM_MULTISHELL_PATH) add(join(env.FNM_MULTISHELL_PATH, "bin"))
  const roots: [string, string][] = []
  const root = (base: string | undefined, suffix: string, bin: string) => {
    if (base && isAbsolute(base)) roots.push([join(base, suffix), bin])
  }
  root(env.NVM_DIR, "versions/node", "bin")
  root(env.XDG_CONFIG_HOME, "nvm/versions/node", "bin")
  root(env.FNM_DIR, "node-versions", "installation/bin")
  root(env.ASDF_DATA_DIR, "installs/nodejs", "bin")
  root(env.MISE_DATA_DIR, "installs/node", "bin")
  const home = env.HOME || env.USERPROFILE
  if (home && isAbsolute(home)) {
    for (const suffix of [
      ".local/bin", ".claude/local", ".npm-global/bin", ".npm/bin", ".bun/bin", ".volta/bin",
      ".asdf/shims", ".local/share/mise/shims", ".cargo/bin", ".deno/bin", "Library/pnpm",
      ".local/share/pnpm", ".yarn/bin", ".n/bin",
    ]) add(join(home, suffix))
    // npmrc is installation metadata only; no agent configuration or credentials are read.
    try {
      const text = await readFile(join(home, ".npmrc"), "utf8")
      for (const line of text.split(/\r?\n/)) {
        const match = /^\s*prefix\s*=\s*(.*?)\s*$/.exec(line)
        if (!match) continue
        let prefix = match[1]!.replace(/^["']|["']$/g, "")
        prefix = prefix.replace(/\$\{([^}]+)\}/g, (_, key: string) => env[key] ?? "")
        if (prefix.startsWith("~/")) prefix = join(home, prefix.slice(2))
        if (isAbsolute(prefix)) add(join(prefix, "bin"))
        break
      }
    } catch { /* no npm prefix */ }
    root(home, ".nvm/versions/node", "bin")
    root(home, ".config/nvm/versions/node", "bin")
    root(home, "Library/Application Support/fnm/node-versions", "installation/bin")
    root(home, ".local/share/fnm/node-versions", "installation/bin")
    root(home, ".asdf/installs/nodejs", "bin")
    root(home, ".local/share/mise/installs/node", "bin")
  }
  const seen = new Set<string>()
  for (const [base, bin] of roots) {
    if (seen.has(base)) continue
    seen.add(base)
    try {
      const versions = await readdir(base, { withFileTypes: true })
      versions.filter(v => (v.isDirectory() || v.isSymbolicLink()) && /^v?\d+(?:\.\d+){1,2}$/.test(v.name))
        .sort((a, b) => b.name.localeCompare(a.name, "en", { numeric: true }))
        .slice(0, 32).forEach(v => add(join(base, v.name, bin)))
    } catch { /* manager not installed */ }
  }
  for (const dir of systemDirectories) add(dir)
  return [...new Set(dirs)]
}
