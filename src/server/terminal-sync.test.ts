import { afterEach, beforeEach, expect, test } from "bun:test"
import * as terminals from "./terminal-manager"
import type { TerminalEvent } from "../shared/protocol"

const originalTerminal = Bun.Terminal
const originalSpawn = Bun.spawn
let manager: terminals.TerminalManager
let events: TerminalEvent[]
let ptys: FakePty[]

class FakePty {
  readonly data: (terminal: unknown, data: Uint8Array) => void
  closed = false
  sizes: number[][] = []
  constructor(options: { data: FakePty["data"] }) { this.data = options.data; ptys.push(this) }
  write() {}
  resize(cols: number, rows: number) { this.sizes.push([cols, rows]) }
  close() { this.closed = true }
  output(data: string) { this.data(this, new TextEncoder().encode(data)) }
}

beforeEach(() => {
  ptys = []
  events = []
  Object.defineProperty(Bun, "Terminal", { value: FakePty })
  Object.defineProperty(Bun, "spawn", { value: () => ({ pid: undefined, exited: new Promise(() => {}) }) })
  manager = new terminals.TerminalManager()
  manager.onEvent((event) => events.push(event))
})
afterEach(() => {
  manager.closeAll()
  Object.defineProperty(Bun, "Terminal", { value: originalTerminal })
  Object.defineProperty(Bun, "spawn", { value: originalSpawn })
})

function create(id = "a") {
  return manager.createTerminal({ terminalId: id, projectPath: "/tmp", cols: 80, rows: 24, scrollback: 500 })
}
async function drain() { await Bun.sleep(30) }

test("normal output versions count decoded UTF-16 characters and snapshots include pending writes", async () => {
  create()
  ptys[0]!.output("中🙂")
  // A snapshot immediately after a PTY read must never claim unparsed output.
  const snapshot = manager.getSnapshot("a")!
  if (snapshot.outputVersion === 3) expect(snapshot.serializedState).toContain("中🙂")
  await drain()
  expect(events).toContainEqual(expect.objectContaining({ type: "terminal.output", data: "中🙂", version: 3 }))
  expect(manager.getSnapshot("a")?.outputVersion).toBe(3)
  expect(manager.getSnapshot("a")?.serializedState).toContain("中🙂")
})

test("reconnect mid-stream returns exactly missing output and a repeated tail is empty", async () => {
  const first = create()
  ptys[0]!.output("one")
  await drain()
  const version = manager.getSnapshot("a")!.outputVersion!
  ptys[0]!.output("two中")
  await drain()
  const result = manager.getTail("a", version, first.sessionId)!
  expect(result.tail?.data).toBe("two中")
  expect(result.tail?.version).toBe(7)
  expect(result.snapshot).toBeNull()
  expect(manager.getTail("a", 7, first.sessionId)?.tail?.data).toBe("")
})

test("trimmed output and invalid versions return a reset with matching state", async () => {
  const first = create()
  ptys[0]!.output("x".repeat(1_000_001) + "END")
  await drain()
  for (const version of [0, -1, 1.5, NaN, Infinity, 2_000_000]) {
    const result = manager.getTail("a", version, first.sessionId)!
    expect(result.tail).toBeNull()
    expect(result.snapshot?.outputVersion).toBe(1_000_004)
    expect(result.snapshot?.serializedState).toContain("END")
  }
})

test("resize keeps output version and tail continuous", async () => {
  const first = create()
  ptys[0]!.output("before")
  await drain()
  manager.resize("a", 100, 30)
  ptys[0]!.output("after")
  await drain()
  expect(ptys[0]!.sizes).toContainEqual([100, 30])
  expect(manager.getSnapshot("a")).toMatchObject({ cols: 100, rows: 30, outputVersion: 11 })
  expect(manager.getTail("a", 6, first.sessionId)?.tail?.data).toBe("after")
})

test("close releases buffers and reopening the same id forces a new session reset", async () => {
  const first = create()
  ptys[0]!.output("old")
  await drain()
  manager.close("a")
  expect(ptys[0]!.closed).toBe(true)
  expect(manager.getTail("a", 0, first.sessionId)).toBeNull()
  const second = create()
  ptys[0]!.output("stale")
  ptys[1]!.output("new")
  await drain()
  expect(second.sessionId).not.toBe(first.sessionId)
  expect(manager.getTail("a", 3, first.sessionId)?.snapshot?.serializedState).toContain("new")
  expect(manager.getTail("a", 0, second.sessionId)?.tail?.data).toBe("new")
})

test("many terminals keep independent logs and closeByCwd releases every session", async () => {
  const sessions = Array.from({ length: 40 }, (_, i) => create(String(i)))
  ptys.forEach((pty, i) => pty.output(`value${i}`))
  await drain()
  sessions.forEach((session, i) => {
    expect(manager.getTail(String(i), 0, session.sessionId)?.tail?.data).toBe(`value${i}`)
  })
  manager.closeByCwd("/tmp")
  sessions.forEach((session, i) => expect(manager.getTail(String(i), 0, session.sessionId)).toBeNull())
  expect(ptys.every((pty) => pty.closed)).toBe(true)
})

test("output log bounds oversized writes and packs a slow trickle into segments", () => {
  const log = new terminals.TerminalOutputLog(100, 16)
  for (let i = 0; i < 200; i++) log.append("x")
  expect(log.version).toBe(200)
  expect(log.segmentCount).toBeLessThanOrEqual(7)
  expect(log.tailSince(0)).toBeNull()
  expect(log.tailSince(190)).toBe("x".repeat(10))
  log.append("y".repeat(1_000))
  expect(log.retainedCharacters).toBeLessThanOrEqual(100)
  expect(log.segmentCount).toBeLessThanOrEqual(7)
  expect(log.tailSince(1_100)).toBe("y".repeat(100))
})

test("ASCII shell locales are upgraded without replacing an existing UTF-8 regional choice", () => {
  const env = { LANG: "de_DE.UTF-8", LC_ALL: "C", LC_CTYPE: "POSIX" }
  terminals.applyUtf8Locale(env)
  expect(env.LANG).toBe("de_DE.UTF-8")
  expect(env.LC_ALL).toBe(process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8")
  expect(env.LC_CTYPE).toBe(env.LC_ALL)
  const regional = { LANG: "zh_CN.UTF-8", LC_ALL: "zh_CN.UTF-8" }
  expect(terminals.applyUtf8Locale(regional)).toEqual(regional)
})

test("headless snapshots use modern two-cell emoji widths", async () => {
  create()
  ptys[0]!.output("中🙂X")
  await drain()
  expect((manager as any).sessions.get("a").headless.buffer.active.cursorX).toBe(5)
})
