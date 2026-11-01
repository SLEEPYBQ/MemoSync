import path from "node:path"

const desktopDir = path.resolve(import.meta.dir)

function run(command: string[], cwd = path.resolve(desktopDir, "..")) {
  const result = Bun.spawnSync(command, {
    cwd,
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
    stdout: "inherit",
    stderr: "inherit",
  })
  if (!result.success) throw new Error(`Command failed (${result.exitCode}): ${command.join(" ")}`)
}

run([process.execPath, "run", "desktop/prepare.ts"])
run([
  path.join(desktopDir, "node_modules/.bin/electron-builder"),
  "--mac",
  "dmg",
  "zip",
  `--${process.arch}`,
], desktopDir)
