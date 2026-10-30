import { afterEach, describe, expect, test } from "bun:test"

const originals = new Map(["AudioContext", "Audio", "fetch", "window"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
afterEach(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})

let moduleId = 0
async function setup(options: { unavailable?: boolean; decodeFails?: boolean; fetchFails?: boolean } = {}) {
  const fetched: string[] = []
  const fallback: string[] = []
  const contexts: FakeContext[] = []
  const sources: Array<{ buffer: unknown; connected: boolean; started: boolean }> = []
  class FakeContext {
    state = "suspended"
    destination = {}
    resumes = 0
    decodes = 0
    constructor() { contexts.push(this) }
    async resume() { this.resumes++; this.state = "running" }
    async decodeAudioData(bytes: ArrayBuffer) {
      this.decodes++
      expect(bytes.byteLength).toBe(4)
      if (options.decodeFails) throw new Error("unsupported codec")
      return { decoded: true }
    }
    createBufferSource() {
      const source = {
        buffer: null as unknown,
        connected: false,
        started: false,
        onended: null as (() => void) | null,
        connect: (destination: unknown) => { expect(destination).toBe(this.destination); source.connected = true },
        disconnect: () => { source.connected = false },
        start: () => { source.started = true; queueMicrotask(() => source.onended?.()) },
      }
      sources.push(source)
      return source
    }
  }
  const globals = {
    AudioContext: options.unavailable ? undefined : FakeContext,
    Audio: class {
      preload = ""
      constructor(readonly src: string) {}
      async play() { fallback.push(this.src) }
    },
    fetch: async (src: string) => {
      fetched.push(src)
      return new Response(new Uint8Array(4), { status: options.fetchFails ? 500 : 200 })
    },
    window: { setTimeout },
  }
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  // Separate module state per case without exposing test-only reset APIs.
  const sounds: typeof import("./chatSounds") = await import(`./chatSounds.ts?test=${moduleId++}`)
  return { sounds, fetched, fallback, contexts, sources }
}

describe("chat sounds", () => {
  test("uses one resumed Web Audio context, caches decoded selections, and disconnects sources", async () => {
    const { sounds, fetched, fallback, contexts, sources } = await setup()
    await sounds.playChatNotificationSound("funk", 2)
    await sounds.playChatNotificationSound("funk", 1)
    await sounds.playChatNotificationSound("ping", 1)
    expect(contexts).toHaveLength(1)
    expect(contexts[0]?.resumes).toBe(1)
    expect(contexts[0]?.decodes).toBe(2)
    expect(fetched).toEqual(["/chat-sounds/Funk.mp3", "/chat-sounds/Ping.mp3"])
    expect(fallback).toEqual([])
    expect(sources).toHaveLength(4)
    expect(sources.every((source) => source.started && !source.connected && source.buffer)).toBe(true)
    contexts[0]!.state = "suspended"
    await sounds.playChatNotificationSound("ping", 1)
    expect(contexts[0]?.resumes).toBe(2)
    expect(contexts[0]?.decodes).toBe(2)
  })

  for (const failure of ["unavailable", "decodeFails", "fetchFails"] as const) {
    test(`falls back to the selected HTML audio when ${failure}`, async () => {
      const { sounds, fallback, contexts } = await setup({ [failure]: true })
      await sounds.playChatNotificationSound("glass", 1)
      await sounds.playChatNotificationSound("glass", 1)
      expect(fallback).toEqual(["/chat-sounds/Glass.mp3", "/chat-sounds/Glass.mp3"])
      if (failure === "decodeFails") expect(contexts[0]?.decodes).toBe(2) // failed cache entries are retryable
    })
  }

  test("keeps notification policy and skips empty playback", async () => {
    const { sounds, contexts, fallback } = await setup()
    await sounds.playChatNotificationSound("funk", 0)
    await sounds.playChatNotificationSound("funk", -1)
    expect(contexts).toEqual([])
    expect(fallback).toEqual([])
    const focused = { visibilityState: "visible" as const, hasFocus: () => true }
    const unfocused = { visibilityState: "visible" as const, hasFocus: () => false }
    const hidden = { visibilityState: "hidden" as const, hasFocus: () => true }
    expect(sounds.shouldPlayChatSound("never", hidden)).toBe(false)
    expect(sounds.shouldPlayChatSound("always", focused)).toBe(true)
    expect(sounds.shouldPlayChatSound("unfocused", focused)).toBe(false)
    expect(sounds.shouldPlayChatSound("unfocused", unfocused)).toBe(true)
    expect(sounds.shouldPlayChatSound("unfocused", hidden)).toBe(true)
  })
})
