import { afterEach, describe, expect, test } from "bun:test"
import { copyTextToClipboard } from "./clipboard"
const originals = Object.fromEntries(["navigator", "document", "HTMLElement"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
afterEach(() => {
  for (const [key, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})
function install({ clipboard, copied = true, throws = false }: { clipboard?: (text: string) => Promise<void>; copied?: boolean; throws?: boolean } = {}) {
  const calls: string[] = []
  class Element { focus() { calls.push("focus") } }
  const helper = Object.assign(new Element(), { value: "", style: {}, setAttribute() {}, select() { calls.push("select") }, setSelectionRange() {}, remove() { calls.push("remove") } })
  Object.defineProperties(globalThis, {
    navigator: { configurable: true, value: { clipboard: clipboard ? { writeText: clipboard } : undefined } },
    HTMLElement: { configurable: true, value: Element },
    document: { configurable: true, value: { activeElement: new Element(), createElement: () => helper, body: { appendChild() { calls.push("append") } }, execCommand(command: string) { calls.push(command); if (throws) throw Error("blocked"); return copied } } },
  })
  return { helper, calls }
}
describe("copyTextToClipboard", () => {
  test("uses the native API when available", async () => {
    const copied: string[] = []
    const { calls } = install({ clipboard: async text => { copied.push(text) } })
    expect(await copyTextToClipboard("hello")).toBe(true)
    expect(copied).toEqual(["hello"])
    expect(calls).toEqual([])
  })
  test("insecure origins and rejected native writes fall back to selection", async () => {
    for (const clipboard of [undefined, async () => { throw Error("denied") }]) {
      const { helper, calls } = install({ clipboard })
      expect(await copyTextToClipboard("hello")).toBe(true)
      expect(helper.value).toBe("hello")
      expect(calls).toEqual(["append", "focus", "select", "copy", "remove", "focus"])
    }
  })
  test("failed copies do not claim success and always clean up", async () => {
    for (const options of [{ copied: false }, { throws: true }]) {
      const { calls } = install(options)
      expect(await copyTextToClipboard("hello")).toBe(false)
      expect(calls).toContain("remove")
    }
  })
})
