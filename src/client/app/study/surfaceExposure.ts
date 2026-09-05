import { useCallback, useEffect, useState } from "react"
import { isUiMonitorSuppressed } from "../../lib/memoriesApi"
import { enqueueStudyTelemetry, type StudyTelemetryOutboxRequest } from "./studyTelemetry"

export type StudySurfaceExposure =
  | "auto_summary_sidebar"
  | "static_memory_sidebar"
  | "memory_board"
  | "memory_record"
  | "audit_card"
  | "audit_group"
  | "citation_hover"

export type StudySurfaceExposureInitiator = "participant" | "system"
export type StudySurfaceExposureCloseReason =
  | "unmount"
  | "pagehide"
  | "toggle"
  | "dialog"
  | "popover"
  | "route_change"

type VisibilityTarget = Pick<EventTarget, "addEventListener" | "removeEventListener"> & {
  readonly visibilityState: "visible" | "hidden" | "prerender"
}

export interface SurfaceExposureController {
  open(): void
  close(reason: StudySurfaceExposureCloseReason): void
}

type SurfaceIntersectionEntry = Pick<IntersectionObserverEntry, "target" | "isIntersecting" | "intersectionRatio">
type SurfaceIntersectionObserver = Pick<IntersectionObserver, "observe" | "disconnect">
export interface SurfaceIntersectionMetadata {
  initial: boolean
}

export function getSurfaceIntersectionInitiator(
  metadata: SurfaceIntersectionMetadata,
): StudySurfaceExposureInitiator {
  return metadata.initial ? "system" : "participant"
}

export function observeSurfaceIntersection({
  element,
  onVisibleChange,
  createObserver = (callback) => {
    if (typeof IntersectionObserver === "undefined") return null
    return new IntersectionObserver(callback, { threshold: [0.01] })
  },
}: {
  element: Element
  onVisibleChange: (visible: boolean, metadata: SurfaceIntersectionMetadata) => void
  createObserver?: (
    callback: (entries: SurfaceIntersectionEntry[]) => void,
  ) => SurfaceIntersectionObserver | null
}): () => void {
  let previousVisible: boolean | null = null
  const observer = createObserver((entries) => {
    const entry = entries.find((candidate) => candidate.target === element)
    if (!entry) return
    const next = entry.isIntersecting && entry.intersectionRatio > 0
    if (next === previousVisible) return
    const initial = previousVisible === null
    previousVisible = next
    onVisibleChange(next, { initial })
  })
  if (!observer) return () => undefined
  observer.observe(element)
  return () => observer.disconnect()
}

/** Viewport seam for virtualized audit rows. Without IntersectionObserver the
 * hook fails closed, so a buffered/offscreen mount never becomes exposure. */
export function useSurfaceViewportVisibility<T extends Element>(): {
  ref: (element: T | null) => void
  visible: boolean
  initiator: StudySurfaceExposureInitiator
} {
  const [element, setElement] = useState<T | null>(null)
  const [visibility, setVisibility] = useState<{
    visible: boolean
    initiator: StudySurfaceExposureInitiator
  }>({ visible: false, initiator: "system" })
  const ref = useCallback((next: T | null) => setElement(next), [])
  useEffect(() => {
    if (!element) {
      setVisibility({ visible: false, initiator: "system" })
      return
    }
    setVisibility({ visible: false, initiator: "system" })
    return observeSurfaceIntersection({
      element,
      onVisibleChange: (visible, metadata) => {
        setVisibility((current) => ({
          visible,
          initiator: visible
            ? getSurfaceIntersectionInitiator(metadata)
            : current.initiator,
        }))
      },
    })
  }, [element])
  return { ref, ...visibility }
}

/**
 * One client-observed visibility interval. Callers name only the mounted
 * surface and its authoritative chat. This module owns stable identity,
 * ordered transitions, visibility pauses, page teardown and durable outbox
 * delivery. Polling, scrolling and render updates never cross this seam.
 */
export function createSurfaceExposure({
  surface,
  chatId,
  initiator,
  memoryIds = [],
  randomId = () => crypto.randomUUID(),
  now = Date.now,
  visibilityTarget = typeof document === "undefined" ? null : document,
  pageTarget = typeof window === "undefined" ? null : window,
  enqueue = enqueueStudyTelemetry,
  suppressed = isUiMonitorSuppressed,
}: {
  surface: StudySurfaceExposure
  chatId: string
  initiator: StudySurfaceExposureInitiator
  memoryIds?: string[]
  randomId?: () => string
  now?: () => number
  visibilityTarget?: VisibilityTarget | null
  pageTarget?: Pick<EventTarget, "addEventListener" | "removeEventListener"> | null
  enqueue?: (request: StudyTelemetryOutboxRequest) => void
  suppressed?: () => boolean
}): SurfaceExposureController {
  const exposureId = randomId()
  let sequence = 0
  let state: "idle" | "visible" | "hidden" | "closed" = "idle"
  let lastClientMs = Number.NEGATIVE_INFINITY

  const emit = (
    action: "opened" | "hidden" | "visible" | "closed",
    closeReason?: StudySurfaceExposureCloseReason,
    sampledClientMs?: number,
  ): number => {
    const clientMs = sampledClientMs ?? Math.max(now(), lastClientMs + 1)
    lastClientMs = Math.max(lastClientMs, clientMs)
    const eventId = `surface-exposure:${exposureId}:${sequence}`
    enqueue({
      eventId,
      endpoint: "/api/memories/surface-exposure",
      body: {
        eventId,
        clientTimestamp: new Date(clientMs).toISOString(),
        kind: "surface_exposure",
        surface,
        action,
        chatId,
        payload: {
          exposureId,
          sequence,
          initiator,
          ...(memoryIds.length > 0 ? { memoryIds: [...memoryIds] } : {}),
          ...(closeReason ? { closeReason } : {}),
        },
      },
    })
    sequence += 1
    return clientMs
  }

  const onVisibilityChange = () => {
    if (state === "closed" || state === "idle" || !visibilityTarget) return
    if (visibilityTarget.visibilityState === "hidden" && state === "visible") {
      state = "hidden"
      emit("hidden")
    } else if (visibilityTarget.visibilityState === "visible" && state === "hidden") {
      state = "visible"
      emit("visible")
    }
  }
  const removeListeners = () => {
    visibilityTarget?.removeEventListener("visibilitychange", onVisibilityChange)
    pageTarget?.removeEventListener("pagehide", onPageHide)
  }
  const onPageHide = () => controller.close("pagehide")
  const controller: SurfaceExposureController = {
    open() {
      if (state !== "idle" || suppressed() || !chatId.trim()) return
      state = "visible"
      // enqueueStudyTelemetry persists into localStorage synchronously before
      // its first network await, so opened survives an immediate reload.
      const openedAt = emit("opened")
      if (visibilityTarget && visibilityTarget.visibilityState !== "visible") {
        state = "hidden"
        // The surface mounted while the document was already hidden. Preserve
        // the same clock sample so export observes exactly 0 ms of visibility.
        emit("hidden", undefined, openedAt)
      }
      visibilityTarget?.addEventListener("visibilitychange", onVisibilityChange)
      pageTarget?.addEventListener("pagehide", onPageHide)
    },
    close(reason) {
      if (state === "idle" || state === "closed") return
      state = "closed"
      emit("closed", reason)
      removeListeners()
    },
  }
  return controller
}

export function useSurfaceExposure({
  active,
  surface,
  chatId,
  initiator,
  memoryIds,
  closeReason = "unmount",
}: {
  active: boolean
  surface: StudySurfaceExposure
  chatId?: string | null
  initiator: StudySurfaceExposureInitiator
  memoryIds?: string[]
  closeReason?: StudySurfaceExposureCloseReason
}): void {
  const memoryKey = JSON.stringify(memoryIds ?? [])
  useEffect(() => {
    if (!active || !chatId) return
    const exposure = createSurfaceExposure({
      surface,
      chatId,
      initiator,
      memoryIds: JSON.parse(memoryKey) as string[],
    })
    exposure.open()
    return () => exposure.close(closeReason)
  }, [active, chatId, closeReason, initiator, memoryKey, surface])
}
