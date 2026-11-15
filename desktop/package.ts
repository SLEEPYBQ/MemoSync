import path from "node:path"
import { verifyNativeTarget } from "./platform"

const desktopDir = path.resolve(import.meta.dir)
const target = verifyNativeTarget(process.argv[2] ?? process.env.MEMOSYNC_TARGET_PLATFORM, process.env.MEMOSYNC_TARGET_ARCH)

function run(command: string[], cwd = path.resolve(desktopDir, "..")) {
  const result = Bun.spawnSync(command, {
    cwd,
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
    stdout: "inherit", stderr: "inherit",
  })
  if (!result.success) throw new Error(`Command failed (${result.exitCode}): ${command.join(" ")}`)
}

run([process.execPath, "run", "desktop/prepare.ts"])
// Launch the JS entry directly: Windows .cmd wrappers are not executables.
run(["node", path.join(desktopDir, "node_modules/electron-builder/out/cli/cli.js"),
  target.builderFlag, `--${target.arch}`, "--publish", "never"], desktopDir)
