import { expect, test } from "bun:test"
import {
  createSurfaceExposure,
  getSurfaceIntersectionInitiator,
  observeSurfaceIntersection,
} from "./surfaceExposure"

test("persists opened-hidden-visible-closed with one exposure id and monotonic client time", () => {
  const visibility = new EventTarget() as EventTarget & { visibilityState: "visible" | "hidden" }
  visibility.visibilityState = "visible"
  const page = new EventTarget()
  const queued: Array<{ eventId: string; endpoint: string; body: Record<string, unknown> }> = []
  let now = Date.parse("2026-08-20T10:00:00.000Z")
  const exposure = createSurfaceExposure({
    surface: "memory_record",
    chatId: "chat-1",
    initiator: "participant",
    randomId: () => "exposure-1",
    now: () => now,
    visibilityTarget: visibility,
    pageTarget: page,
    enqueue: (request) => queued.push(request),
  })

  exposure.open()
  now += 2_000
  visibility.visibilityState = "hidden"
  visibility.dispatchEvent(new Event("visibilitychange"))
  now += 3_000
  visibility.visibilityState = "visible"
  visibility.dispatchEvent(new Event("visibilitychange"))
  now += 4_000
  exposure.close("unmount")

  expect(queued.map((request) => request.body)).toEqual([
    expect.objectContaining({ action: "opened", clientTimestamp: "2026-08-20T10:00:00.000Z", payload: expect.objectContaining({ sequence: 0 }) }),
    expect.objectContaining({ action: "hidden", clientTimestamp: "2026-08-20T10:00:02.000Z", payload: expect.objectContaining({ sequence: 1 }) }),
    expect.objectContaining({ action: "visible", clientTimestamp: "2026-08-20T10:00:05.000Z", payload: expect.objectContaining({ sequence: 2 }) }),
    expect.objectContaining({ action: "closed", clientTimestamp: "2026-08-20T10:00:09.000Z", payload: expect.objectContaining({ sequence: 3, closeReason: "unmount" }) }),
  ])
  expect(queued.map((request) => request.eventId)).toEqual([
    "surface-exposure:exposure-1:0",
    "surface-exposure:exposure-1:1",
    "surface-exposure:exposure-1:2",
    "surface-exposure:exposure-1:3",
  ])
})

test("suppresses every Guide exposure and pagehide closes a production exposure once", () => {
  const page = new EventTarget()
  const suppressed: string[] = []
  createSurfaceExposure({
    surface: "memory_board",
    chatId: "guide-chat",
    initiator: "system",
    suppressed: () => true,
    enqueue: (request) => suppressed.push(request.eventId),
  }).open()
  expect(suppressed).toEqual([])

  const queued: string[] = []
  const exposure = createSurfaceExposure({
    surface: "memory_board",
    chatId: "chat-1",
    initiator: "system",
    randomId: () => "opening-board",
    pageTarget: page,
    visibilityTarget: null,
    enqueue: (request) => queued.push(`${request.eventId}:${request.body.action}`),
  })
  exposure.open()
  page.dispatchEvent(new Event("pagehide"))
  exposure.close("unmount")
  expect(queued).toEqual([
    "surface-exposure:opening-board:0:opened",
    "surface-exposure:opening-board:1:closed",
  ])
})

test("an initially hidden mount records opened and hidden at the same sampled time", () => {
  const visibility = new EventTarget() as EventTarget & { visibilityState: "visible" | "hidden" }
  visibility.visibilityState = "hidden"
  const queued: Array<Record<string, unknown>> = []
  const exposure = createSurfaceExposure({
    surface: "static_memory_sidebar",
    chatId: "chat-hidden",
    initiator: "participant",
    randomId: () => "initially-hidden",
    now: () => Date.parse("2026-08-20T10:00:00.000Z"),
    visibilityTarget: visibility,
    pageTarget: null,
    enqueue: (request) => queued.push(request.body),
  })

  exposure.open()

  expect(queued).toEqual([
    expect.objectContaining({
      action: "opened",
      clientTimestamp: "2026-08-20T10:00:00.000Z",
      payload: expect.objectContaining({ sequence: 0 }),
    }),
    expect.objectContaining({
      action: "hidden",
      clientTimestamp: "2026-08-20T10:00:00.000Z",
      payload: expect.objectContaining({ sequence: 1 }),
    }),
  ])
})

test("a buffered audit starts only after intersection and ordinary callbacks do not reopen it", () => {
  const element = {} as Element
  const visible: Array<{ visible: boolean; initial: boolean }> = []
  let notify: ((entries: Array<Pick<IntersectionObserverEntry, "target" | "isIntersecting" | "intersectionRatio">>) => void) | null = null
  let observed: Element | null = null
  let disconnected = false
  const stop = observeSurfaceIntersection({
    element,
    onVisibleChange: (next, metadata) => visible.push({ visible: next, initial: metadata.initial }),
    createObserver: (callback) => {
      notify = callback
      return {
        observe: (target) => { observed = target },
        disconnect: () => { disconnected = true },
      }
    },
  })

  expect(observed as Element | null).toBe(element)
  notify!([{ target: element, isIntersecting: false, intersectionRatio: 0 }])
  notify!([{ target: element, isIntersecting: true, intersectionRatio: 0.5 }])
  notify!([{ target: element, isIntersecting: true, intersectionRatio: 0.7 }])
  notify!([{ target: element, isIntersecting: false, intersectionRatio: 0 }])
  expect(visible).toEqual([
    { visible: false, initial: true },
    { visible: true, initial: false },
    { visible: false, initial: false },
  ])
  expect(getSurfaceIntersectionInitiator(visible[1]!)).toBe("participant")
  stop()
  expect(disconnected).toBe(true)
})

test("an audit already intersecting on mount is a system-opened exposure", () => {
  const element = {} as Element
  const visible: Array<{ visible: boolean; initial: boolean }> = []
  let notify: ((entries: Array<Pick<IntersectionObserverEntry, "target" | "isIntersecting" | "intersectionRatio">>) => void) | null = null
  observeSurfaceIntersection({
    element,
    onVisibleChange: (next, metadata) => visible.push({ visible: next, initial: metadata.initial }),
    createObserver: (callback) => {
      notify = callback
      return { observe: () => undefined, disconnect: () => undefined }
    },
  })

  notify!([{ target: element, isIntersecting: true, intersectionRatio: 0.5 }])
  notify!([{ target: element, isIntersecting: true, intersectionRatio: 0.9 }])

  expect(visible).toEqual([{ visible: true, initial: true }])
  expect(getSurfaceIntersectionInitiator(visible[0]!)).toBe("system")
})
