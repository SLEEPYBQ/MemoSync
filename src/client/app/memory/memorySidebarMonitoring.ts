import type { SurfaceExposureInitiator } from "./surfaceExposure"

export interface MemorySidebarOpenMonitoring {
  surface: "timeline"
  sessionId: string
  interaction: "open"
}

/**
 * Raw Monitoring counts only an explicit participant inspection. System
 * defaults and restored layouts are represented by surface exposure instead.
 */
export function memorySidebarOpenMonitoring(
  initiator: SurfaceExposureInitiator,
  surface: MemorySidebarOpenMonitoring["surface"],
  sessionId: string,
): MemorySidebarOpenMonitoring | null {
  if (initiator !== "participant") return null
  return { surface, sessionId, interaction: "open" }
}
