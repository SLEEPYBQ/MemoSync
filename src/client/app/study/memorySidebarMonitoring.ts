import type { StudySurfaceExposureInitiator } from "./surfaceExposure"

export interface MemorySidebarOpenMonitoring {
  surface: "summary_panel_open" | "static_memory_panel_open" | "timeline"
  sessionId: string
  interaction: "open"
}

/**
 * Raw Monitoring counts only an explicit participant inspection. System
 * defaults and restored layouts are represented by surface exposure instead.
 */
export function memorySidebarOpenMonitoring(
  initiator: StudySurfaceExposureInitiator,
  surface: MemorySidebarOpenMonitoring["surface"],
  sessionId: string,
): MemorySidebarOpenMonitoring | null {
  if (initiator !== "participant") return null
  return { surface, sessionId, interaction: "open" }
}
