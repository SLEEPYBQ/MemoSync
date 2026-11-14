import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { TerminalManager } from "./terminal-manager"

test.skipIf(process.platform !== "win32")("native ConPTY accepts input, resizes and terminates its child tree", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "memosync terminal 测试-"))
  const manager = new TerminalManager()
  const waitForFile = async (name: string) => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      try { return JSON.parse(await readFile(path.join(root, name), "utf8")) }
      catch { await Bun.sleep(25) }
    }
    throw new Error(`Terminal did not produce ${name}: ${manager.getSnapshot("terminal")?.serializedState}`)
  }
  const command = (name: string, stayAlive = false) => `"${process.execPath}" -e "require('fs').writeFileSync('${name}', JSON.stringify({pid:process.pid,tty:process.stdout.isTTY,cols:process.stdout.columns,rows:process.stdout.rows,cwd:process.cwd()}));${stayAlive ? "setInterval(()=>{},1000)" : ""}"\r`
  try {
    manager.createTerminal({ terminalId: "terminal", projectPath: root, cols: 80, rows: 24, scrollback: 500 })
    manager.write("terminal", command("first.json"))
    expect(await waitForFile("first.json")).toMatchObject({ tty: true, cols: 80, rows: 24, cwd: root })
    manager.resize("terminal", 120, 40)
    manager.write("terminal", command("second.json", true))
    const second = await waitForFile("second.json")
    expect(second).toMatchObject({ tty: true, cols: 120, rows: 40, cwd: root })
    await manager.closeAll()
    expect(manager.getSnapshot("terminal")).toBeNull()
    expect(() => process.kill(second.pid, 0)).toThrow()
  } finally { await manager.closeAll(); await rm(root, { recursive: true, force: true }) }
}, 30_000)
