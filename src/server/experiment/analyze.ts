// Local usage statistics. Historical labels are preserved as metadata, never
// interpreted as product settings or used to merge chats into task windows.
export interface InteractionSurfaceCounts {
  board: number
  chat_gate: number
  other: number
}

export interface SessionMetrics {
  sessionId: string
  legacyMetadata?: Array<Record<string, string>>
  engine?: string
  maxTurn: number
  injections: number
  avgInjectedSetSize: number
  avgInjectTokenEstimate: number
  citations: number
  uniqueCitedIds: string[]
  detailLoads: number
  captureProposed: number
  captureSurfaced: number
  captureDropped: number
  captureSensitive: number
  conflicts: number
  previews: number
  previewDecisions: { go_on: number; dismiss: number; without_memory: number; auto_go_on: number }
  traceLabels: { operational: number; injected_without_effect: number; violated: number; not_applicable: number }
  bringIns: number
  /** Step-one proposals gates (redesign 2026-08-07): parked reviews + how each settled. */
  proposalsGates: number
  proposalsCandidates: number
  proposalsDecisions: { reviewed: number; skipped: number; cancelled: number; expired: number; empty: number }
  /** Step-one library checkups: runs, suggestion volume, cache hits, outcomes. */
  checkups: number
  checkupSuggestions: number
  checkupCacheHits: number
  /** Complete and partial Checkups whose raw event names one or more failed lanes. */
  checkupIncomplete: number
  checkupDecisions: { clear: number; handled: number; skipped: number; cancelled: number; expired: number; failed: number }
  /** Transfer cards (Transfer design 2026-08-08): shown cards, suggestion volume, outcomes, row actions. */
  transferCards: number
  transferSuggestions: number
  transferDecisions: { handled: number; skipped: number; cancelled: number; expired: number; empty: number }
  transferAccepts: number
  transferDeclines: number
  /** Review-again reopens of the pre-turn preparation. */
  preparationReopens: number
  /** User stopped a running turn over one delivered memory. */
  memoryInterrupts: number
  /** Claude accepted a continuation whose delivery links to an interrupt. */
  resumeLinkedDeliveries: number
  /** User armed one-turn Enforce from audit or interrupt recovery. */
  memoryEnforces: number
  /** User memory mutations, separated from passive inspection. */
  controlInteractions: InteractionSurfaceCounts
  /** Raw ui.monitor acts, never folded into Control. */
  monitoringInteractions: InteractionSurfaceCounts
}

export interface AnalysisReport {
  sessions: Record<string, SessionMetrics>
  totals: {
    sessions: number
    events: number
    ignoredEvents: number
    skippedLines: number
    decisions: { create: number; accept: number; edit: number; dismiss: number; rescope: number; archive: number; revert: number }
    /** accepts / (accepts + dismisses) over UI decisions. NaN-safe: 0 when no reviews. */
    acceptRate: number
    citations: number
    detailLoads: number
    captureProposed: number
    captureSurfaced: number
    previewDecisions: { go_on: number; dismiss: number; without_memory: number; auto_go_on: number }
    traceLabels: { operational: number; injected_without_effect: number; violated: number; not_applicable: number }
    proposalsDecisions: { reviewed: number; skipped: number; cancelled: number; expired: number; empty: number }
    checkupDecisions: { clear: number; handled: number; skipped: number; cancelled: number; expired: number; failed: number }
    checkupIncomplete: number
    transferDecisions: { handled: number; skipped: number; cancelled: number; expired: number; empty: number }
    preparationReopens: number
    memoryInterrupts: number
    resumeLinkedDeliveries: number
    memoryEnforces: number
    controlInteractions: InteractionSurfaceCounts
    monitoringInteractions: InteractionSurfaceCounts
  }
  toCsv(): string
}

function emptySession(sessionId: string): SessionMetrics {
  return {
    sessionId,
    maxTurn: 0,
    injections: 0,
    avgInjectedSetSize: 0,
    avgInjectTokenEstimate: 0,
    citations: 0,
    uniqueCitedIds: [],
    detailLoads: 0,
    captureProposed: 0,
    captureSurfaced: 0,
    captureDropped: 0,
    captureSensitive: 0,
    conflicts: 0,
    previews: 0,
    previewDecisions: { go_on: 0, dismiss: 0, without_memory: 0, auto_go_on: 0 },
    traceLabels: { operational: 0, injected_without_effect: 0, violated: 0, not_applicable: 0 },
    bringIns: 0,
    proposalsGates: 0,
    proposalsCandidates: 0,
    proposalsDecisions: { reviewed: 0, skipped: 0, cancelled: 0, expired: 0, empty: 0 },
    checkups: 0,
    checkupSuggestions: 0,
    checkupCacheHits: 0,
    checkupIncomplete: 0,
    checkupDecisions: { clear: 0, handled: 0, skipped: 0, cancelled: 0, expired: 0, failed: 0 },
    transferCards: 0,
    transferSuggestions: 0,
    transferDecisions: { handled: 0, skipped: 0, cancelled: 0, expired: 0, empty: 0 },
    transferAccepts: 0,
    transferDeclines: 0,
    preparationReopens: 0,
    memoryInterrupts: 0,
    resumeLinkedDeliveries: 0,
    memoryEnforces: 0,
    controlInteractions: { board: 0, chat_gate: 0, other: 0 },
    monitoringInteractions: { board: 0, chat_gate: 0, other: 0 },
  }
}

type InteractionSurface = keyof InteractionSurfaceCounts

function normalizeInteractionSurface(value: unknown): InteractionSurface {
  return value === "board" || value === "chat_gate" ? value : "other"
}

function isResumeLinkedDelivery(event: any): boolean {
  return event.type === "memory.inject"
    && event.schemaVersion === 2
    && event.deliveryStage === "queued_to_claude"
    && typeof event.resumeOfInterruptId === "string"
    && event.resumeOfInterruptId.length > 0
}

function controlSurfaceOf(event: any): InteractionSurface | null {
  if (event.type === "memory.interrupt") return "other"
  if (event.type === "memory.audit_action" && event.action === "enforce") return "other"
  if (isResumeLinkedDelivery(event)) return "other"
  if (event.type === "memory.decision") return normalizeInteractionSurface(event.via)
  if (
    event.type === "memory.attention"
    || event.type === "memory.transfer"
    || event.type === "memory.transfer_decline"
  ) {
    return normalizeInteractionSurface(event.surface)
  }
  return null
}

function monitoringSurfaceOf(event: any): InteractionSurface | null {
  return event.type === "ui.monitor" ? normalizeInteractionSurface(event.surface) : null
}

function incrementSurface(counts: InteractionSurfaceCounts, surface: InteractionSurface | null): void {
  if (surface) counts[surface]++
}

const PRODUCT_EVENT_TYPES = new Set([
  "memory.branch", "memory.inject", "memory.propose", "memory.cite", "memory.decision",
  "memory.capture", "memory.conflict", "memory.proposals", "memory.checkup", "memory.preparation_reopen",
  "memory.trace", "memory.detail_load", "memory.bringin", "memory.exclude", "memory.working_memory_selection",
  "memory.transfer", "memory.transfer_decline", "memory.transfer_card", "memory.sanitize",
  "ui.monitor", "ui.surface_exposure", "memory.attention", "memory.audit_action", "memory.interrupt",
  "memory.resume", "memory.preview", "memory.revise_injection", "memory.relevance", "memory.setting",
  "turn.usage", "turn.compacted",
])

export function analyzeEvents(lines: string[]): AnalysisReport {
  const sessions = new Map<string, SessionMetrics & { injectSizes: number[]; injectTokens: number[]; cited: Set<string> }>()
  const totals: AnalysisReport["totals"] = {
    sessions: 0,
    events: 0,
    ignoredEvents: 0,
    skippedLines: 0,
    decisions: { create: 0, accept: 0, edit: 0, dismiss: 0, rescope: 0, archive: 0, revert: 0 },
    acceptRate: 0,
    citations: 0,
    detailLoads: 0,
    captureProposed: 0,
    captureSurfaced: 0,
    previewDecisions: { go_on: 0, dismiss: 0, without_memory: 0, auto_go_on: 0 },
    traceLabels: { operational: 0, injected_without_effect: 0, violated: 0, not_applicable: 0 },
    proposalsDecisions: { reviewed: 0, skipped: 0, cancelled: 0, expired: 0, empty: 0 },
    checkupDecisions: { clear: 0, handled: 0, skipped: 0, cancelled: 0, expired: 0, failed: 0 },
    checkupIncomplete: 0,
    transferDecisions: { handled: 0, skipped: 0, cancelled: 0, expired: 0, empty: 0 },
    preparationReopens: 0,
    memoryInterrupts: 0,
    resumeLinkedDeliveries: 0,
    memoryEnforces: 0,
    controlInteractions: { board: 0, chat_gate: 0, other: 0 },
    monitoringInteractions: { board: 0, chat_gate: 0, other: 0 },
  }

  const forSession = (id: string | undefined) => {
    const key = id ?? "(global)"
    let s = sessions.get(key)
    if (!s) {
      s = { ...emptySession(key), injectSizes: [], injectTokens: [], cited: new Set() }
      sessions.set(key, s)
    }
    return s
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    let e: any
    try {
      e = JSON.parse(line)
    } catch {
      totals.skippedLines++
      continue
    }
    if (!e || typeof e !== "object" || typeof e.type !== "string") {
      totals.skippedLines++
      continue
    }
    if (!PRODUCT_EVENT_TYPES.has(e.type)) {
      totals.ignoredEvents++
      continue
    }
    totals.events++
    const controlSurface = controlSurfaceOf(e)
    const monitoringSurface = monitoringSurfaceOf(e)
    incrementSurface(totals.controlInteractions, controlSurface)
    incrementSurface(totals.monitoringInteractions, monitoringSurface)
    if (e.type === "memory.interrupt") totals.memoryInterrupts++
    if (isResumeLinkedDelivery(e)) totals.resumeLinkedDeliveries++
    if (e.type === "memory.audit_action" && e.action === "enforce") totals.memoryEnforces++

    const analysisSessionId = typeof e.sessionId === "string" && e.sessionId
      ? e.sessionId : typeof e.chatId === "string" && e.chatId ? e.chatId : undefined

    // Global (session-less) events: UI decisions come from HTTP routes.
    if (e.type === "memory.decision") {
      const action = e.action as keyof typeof totals.decisions
      if (action in totals.decisions) totals.decisions[action]++
      if (!analysisSessionId) continue
    }

    if (!analysisSessionId) continue
    const s = forSession(analysisSessionId)
    // Preserve exact metadata keys written by older versions.
    const metadata = Object.fromEntries(["condition", "participant", "allocationMode", "taskId"]
      .filter((key) => typeof e[key] === "string").map((key) => [key, e[key]]))
    if (Object.keys(metadata).length) {
      s.legacyMetadata ??= []
      if (!s.legacyMetadata.some((value) => JSON.stringify(value) === JSON.stringify(metadata))) {
        s.legacyMetadata.push(metadata)
      }
    }
    if (typeof e.engine === "string") s.engine = e.engine
    if (typeof e.turn === "number") s.maxTurn = Math.max(s.maxTurn, e.turn)
    incrementSurface(s.controlInteractions, controlSurface)
    incrementSurface(s.monitoringInteractions, monitoringSurface)

    switch (e.type) {
      case "memory.inject":
        s.injections++
        s.injectSizes.push(Array.isArray(e.memories) ? e.memories.length : 0)
        if (typeof e.tokenEstimate === "number") s.injectTokens.push(e.tokenEstimate)
        if (isResumeLinkedDelivery(e)) s.resumeLinkedDeliveries++
        break
      case "memory.cite":
        s.citations++
        totals.citations++
        for (const id of e.countedIds ?? []) s.cited.add(id)
        break
      case "memory.detail_load":
        s.detailLoads++
        totals.detailLoads++
        break
      case "memory.capture":
        s.captureProposed += e.proposed ?? 0
        s.captureSurfaced += e.surfaced ?? 0
        s.captureDropped += e.dropped ?? 0
        s.captureSensitive += e.sensitive ?? 0
        totals.captureProposed += e.proposed ?? 0
        totals.captureSurfaced += e.surfaced ?? 0
        break
      case "memory.conflict":
        // Drift detected: a captured item superseded an existing memory.
        s.conflicts++
        break
      case "memory.preview": {
        s.previews++
        const d = e.decision as keyof SessionMetrics["previewDecisions"]
        if (d && d in s.previewDecisions) {
          s.previewDecisions[d]++
          totals.previewDecisions[d]++
        }
        break
      }
      case "memory.trace":
        for (const l of e.labels ?? []) {
          const label = l?.label as keyof SessionMetrics["traceLabels"]
          if (label in s.traceLabels) {
            s.traceLabels[label]++
            totals.traceLabels[label]++
          }
        }
        break
      case "memory.bringin":
        s.bringIns++
        break
      case "memory.proposals": {
        s.proposalsGates++
        s.proposalsCandidates += e.count ?? 0
        const d = e.decision as keyof SessionMetrics["proposalsDecisions"]
        if (d && d in s.proposalsDecisions) {
          s.proposalsDecisions[d]++
          totals.proposalsDecisions[d]++
        }
        break
      }
      case "memory.checkup": {
        s.checkups++
        s.checkupSuggestions += e.suggestions ?? 0
        if (e.cached === true) s.checkupCacheHits++
        if (Array.isArray(e.failedKinds) && e.failedKinds.length > 0) {
          s.checkupIncomplete++
          totals.checkupIncomplete++
        }
        const d = e.decision as keyof SessionMetrics["checkupDecisions"]
        if (d && d in s.checkupDecisions) {
          s.checkupDecisions[d]++
          totals.checkupDecisions[d]++
        }
        break
      }
      case "memory.transfer_card": {
        s.transferCards++
        s.transferSuggestions += e.suggestions ?? 0
        const d = e.decision as keyof SessionMetrics["transferDecisions"]
        if (d && d in s.transferDecisions) {
          s.transferDecisions[d]++
          totals.transferDecisions[d]++
        }
        break
      }
      case "memory.transfer":
        s.transferAccepts++
        break
      case "memory.transfer_decline":
        s.transferDeclines++
        break
      case "memory.preparation_reopen":
        s.preparationReopens++
        totals.preparationReopens++
        break
      case "memory.interrupt":
        s.memoryInterrupts++
        break
      case "memory.audit_action":
        if (e.action === "enforce") s.memoryEnforces++
        break

    }
  }

  const finalized: Record<string, SessionMetrics> = {}
  for (const [key, s] of sessions) {
    const { injectSizes, injectTokens, cited, ...rest } = s
    finalized[key] = {
      ...rest,
      avgInjectedSetSize: injectSizes.length ? injectSizes.reduce((a, b) => a + b, 0) / injectSizes.length : 0,
      avgInjectTokenEstimate: injectTokens.length ? injectTokens.reduce((a, b) => a + b, 0) / injectTokens.length : 0,
      uniqueCitedIds: [...cited],
    }
  }
  totals.sessions = Object.keys(finalized).length
  const reviews = totals.decisions.accept + totals.decisions.dismiss
  totals.acceptRate = reviews ? totals.decisions.accept / reviews : 0

  const CSV_COLUMNS: Array<[string, (s: SessionMetrics) => string | number]> = [
    ["sessionId", (s) => s.sessionId],
    ["legacyMetadata", (s) => s.legacyMetadata ? JSON.stringify(s.legacyMetadata) : ""],
    ["engine", (s) => s.engine ?? ""],
    ["maxTurn", (s) => s.maxTurn],
    ["injections", (s) => s.injections],
    ["avgInjectedSetSize", (s) => s.avgInjectedSetSize.toFixed(2)],
    ["avgInjectTokenEstimate", (s) => s.avgInjectTokenEstimate.toFixed(0)],
    ["citations", (s) => s.citations],
    ["uniqueCited", (s) => s.uniqueCitedIds.length],
    ["detailLoads", (s) => s.detailLoads],
    ["captureProposed", (s) => s.captureProposed],
    ["captureSurfaced", (s) => s.captureSurfaced],
    ["captureDropped", (s) => s.captureDropped],
    ["captureSensitive", (s) => s.captureSensitive],
    ["previews", (s) => s.previews],
    ["previewGoOn", (s) => s.previewDecisions.go_on],
    ["previewDismiss", (s) => s.previewDecisions.dismiss],
    ["previewWithoutMemory", (s) => s.previewDecisions.without_memory],
    ["previewAutoGoOn", (s) => s.previewDecisions.auto_go_on],
    ["traceOperational", (s) => s.traceLabels.operational],
    ["traceNoEffect", (s) => s.traceLabels.injected_without_effect],
    ["traceNotApplicable", (s) => s.traceLabels.not_applicable],
    ["traceViolated", (s) => s.traceLabels.violated],
    ["bringIns", (s) => s.bringIns],
    ["conflicts", (s) => s.conflicts],
    ["proposalsGates", (s) => s.proposalsGates],
    ["proposalsCandidates", (s) => s.proposalsCandidates],
    ["proposalsReviewed", (s) => s.proposalsDecisions.reviewed],
    ["proposalsSkipped", (s) => s.proposalsDecisions.skipped],
    ["proposalsEmpty", (s) => s.proposalsDecisions.empty],
    ["checkups", (s) => s.checkups],
    ["checkupSuggestions", (s) => s.checkupSuggestions],
    ["checkupCacheHits", (s) => s.checkupCacheHits],
    ["checkupIncomplete", (s) => s.checkupIncomplete],
    ["checkupHandled", (s) => s.checkupDecisions.handled],
    ["checkupSkipped", (s) => s.checkupDecisions.skipped],
    ["checkupFailed", (s) => s.checkupDecisions.failed],
    ["transferCards", (s) => s.transferCards],
    ["transferSuggestions", (s) => s.transferSuggestions],
    ["transferHandled", (s) => s.transferDecisions.handled],
    ["transferSkipped", (s) => s.transferDecisions.skipped],
    ["transferAccepts", (s) => s.transferAccepts],
    ["transferDeclines", (s) => s.transferDeclines],
    ["preparationReopens", (s) => s.preparationReopens],
    ["memoryInterrupts", (s) => s.memoryInterrupts],
    ["resumeLinkedDeliveries", (s) => s.resumeLinkedDeliveries],
    ["memoryEnforces", (s) => s.memoryEnforces],
    ["controlBoard", (s) => s.controlInteractions.board],
    ["controlChatGate", (s) => s.controlInteractions.chat_gate],
    ["controlOther", (s) => s.controlInteractions.other],
    ["monitorBoard", (s) => s.monitoringInteractions.board],
    ["monitorChatGate", (s) => s.monitoringInteractions.chat_gate],
    ["monitorOther", (s) => s.monitoringInteractions.other],
  ]

  return {
    sessions: finalized,
    totals,
    toCsv() {
      const header = CSV_COLUMNS.map(([name]) => name).join(",")
      const rows = Object.values(finalized).map((s) => CSV_COLUMNS.map(([, get]) => csvCell(String(get(s)))).join(","))
      return [header, ...rows].join("\n") + "\n"
    },
  }
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value
}
