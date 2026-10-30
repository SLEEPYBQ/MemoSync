import { expect, test } from "bun:test"
import type { TerminalSnapshot } from "../../../shared/protocol"
import * as terminalPane from "./TerminalPane"

function fixture() {
  let text = ""
  const callbacks: Array<() => void> = []
  const sync = new terminalPane.TerminalOutputSync({
    reset: () => { text = "" },
    write: (data, callback) => { callbacks.push(() => { text += data; callback() }) },
  })
  const drain = () => { while (callbacks.length) callbacks.shift()!() }
  const snapshot = (version: number, data: string, sessionId = "one") => ({
    terminalId: "a", sessionId, outputVersion: version, serializedState: data,
  } as TerminalSnapshot)
  return { sync, drain, snapshot, text: () => text }
}

test("client reconnect tail and live overlap render every character once", () => {
  const f = fixture()
  f.sync.snapshot(f.snapshot(3, "one"))
  f.sync.output({ data: "two", version: 6, sessionId: "one" })
  // A tail requested at version 3 arrives after the live event at version 6.
  f.sync.output({ data: "two中", version: 7, sessionId: "one" })
  f.sync.output({ data: "two中", version: 7, sessionId: "one" })
  f.drain()
  expect(f.text()).toBe("onetwo中")
  expect(f.sync.cursor).toEqual({ sinceVersion: 7, sessionId: "one" })
})

test("client gaps request repair and stale snapshots cannot rewind output", () => {
  const f = fixture()
  f.sync.snapshot(f.snapshot(3, "one"))
  expect(f.sync.output({ data: "end", version: 10, sessionId: "one" })).toBe(false)
  f.sync.output({ data: "two", version: 6, sessionId: "one" })
  expect(f.sync.snapshot(f.snapshot(3, "one"))).toBe(false)
  f.drain()
  expect(f.text()).toBe("onetwo")
})

test("client reset waits for queued writes and then applies subsequent output in order", () => {
  const f = fixture()
  f.sync.snapshot(f.snapshot(3, "old"))
  f.sync.output({ data: "pending", version: 10, sessionId: "one" })
  f.sync.snapshot(f.snapshot(20, "RESET"))
  f.sync.output({ data: "next", version: 24, sessionId: "one" })
  f.drain()
  expect(f.text()).toBe("RESETnext")
})

test("client session replacement rejects old events and accepts the reset", () => {
  const f = fixture()
  f.sync.snapshot(f.snapshot(9, "old-state"))
  expect(f.sync.output({ data: "new", version: 3, sessionId: "two" })).toBe(false)
  f.sync.snapshot(f.snapshot(3, "new", "two"))
  expect(f.sync.output({ data: "stale", version: 14, sessionId: "one" })).toBe(false)
  f.drain()
  expect(f.text()).toBe("new")
})

test("disposing client sync drops queued writes and releases its buffer", () => {
  const f = fixture()
  f.sync.snapshot(f.snapshot(3, "one"))
  f.sync.output({ data: "queued", version: 9, sessionId: "one" })
  f.sync.dispose()
  f.drain()
  expect(f.text()).toBe("one")
  expect(f.sync.cursor.sinceVersion).toBeNull()
})
