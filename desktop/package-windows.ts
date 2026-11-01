import { readFile, rename, rm } from "node:fs/promises"
import path from "node:path"

const desktopDir = path.resolve(import.meta.dir)

function run(command: string[]) {
  const result = Bun.spawnSync(command, { cwd: desktopDir, stdout: "inherit", stderr: "inherit" })
  if (!result.success) throw new Error(`Command failed (${result.exitCode}): ${command.join(" ")}`)
}

async function renameArtifact(source: string, destination: string) {
  const sourcePath = path.join(desktopDir, "release", source)
  const destinationPath = path.join(desktopDir, "release", destination)
  await rm(destinationPath, { force: true })
  await rename(sourcePath, destinationPath)
}

async function packageWindows() {
  run([process.execPath, "run", "prepare.ts"])

  const builderCli = path.join(desktopDir, "node_modules", "electron-builder", "out", "cli", "cli.js")
  run([process.env.MEMOSYNC_NODE_PATH || "node", builderCli, "--win", "nsis", "zip", "--x64"])

  const { version } = JSON.parse(await readFile(path.join(desktopDir, "package.json"), "utf8")) as { version: string }
  const artifact = `MemoSync-${version}-x64`
  await renameArtifact(`${artifact}.exe`, `${artifact}-Setup.exe`)
  await renameArtifact(`${artifact}.zip`, `${artifact}-portable.zip`)
}

if (import.meta.main) {
  packageWindows().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
