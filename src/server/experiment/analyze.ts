// Experiment-log analysis (SPEC §6): turn events.jsonl into per-session and
// aggregate metamemory metrics — the study's manipulation checks and core
// measures (Write / Structure / Utilization / Maintenance signals). Pure
// function over log lines; the CLI wrapper lives in scripts/analyze-experiment.ts.

export interface InteractionSurfaceCounts {
  board: number
  chat_gate: number
  other: number
}

export interface SessionMetrics {
  sessionId: string
  allocationMode: "study" | "internal_qa"
  condition: string
  participant?: string
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
  /** Participant stopped a running turn over one delivered memory. */
  memoryInterrupts: number
  /** Claude accepted a continuation whose delivery links to an interrupt. */
  resumeLinkedDeliveries: number
  /** Participant armed one-turn Enforce from audit or interrupt recovery. */
  memoryEnforces: number
  /** Participant memory mutations, separated from passive inspection. */
  controlInteractions: InteractionSurfaceCounts
  /** Raw ui.monitor acts, never folded into Control. */
  monitoringInteractions: InteractionSurfaceCounts
  /** Participant-reported time between entering and submitting Static Markdown edits. */
  staticEditDurationMs: number
}

export interface AnalysisReport {
  sessions: Record<string, SessionMetrics>
  totals: {
    sessions: number
    events: number
    /** Valid QA events intentionally omitted from this report. */
    excludedInternalQaEvents: number
    skippedLines: number
    conditions: Record<string, number>
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
    staticEditDurationMs: number
  }
  toCsv(): string
}

function emptySession(sessionId: string): SessionMetrics {
  return {
    sessionId,
    allocationMode: "study",
    condition: "unknown",
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
    staticEditDurationMs: 0,
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

function collectTaskWindowByChat(lines: string[], includeInternalQa: boolean): Map<string, string> {
  const taskByChat = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const raw of lines) {
    let event: any
    try {
      event = JSON.parse(raw.trim())
    } catch {
      continue
    }
    if (!event || typeof event !== "object" || typeof event.taskId !== "string" || !event.taskId) continue
    if (event.allocationMode === "internal_qa" && !includeInternalQa) continue
    const chatIds = [event.chatId, event.sessionId]
      .filter((value): value is string => typeof value === "string" && value.length > 0 && value !== event.taskId)
    for (const chatId of chatIds) {
      const existing = taskByChat.get(chatId)
      if (existing && existing !== event.taskId) {
        ambiguous.add(chatId)
        taskByChat.delete(chatId)
      } else if (!ambiguous.has(chatId)) {
        taskByChat.set(chatId, event.taskId)
      }
    }
  }
  return taskByChat
}

export function analyzeEvents(
  lines: string[],
  options: { includeInternalQa?: boolean } = {},
): AnalysisReport {
  const taskWindowByChat = collectTaskWindowByChat(lines, options.includeInternalQa === true)
  const sessions = new Map<string, SessionMetrics & { injectSizes: number[]; injectTokens: number[]; cited: Set<string> }>()
  const totals: AnalysisReport["totals"] = {
    sessions: 0,
    events: 0,
    excludedInternalQaEvents: 0,
    skippedLines: 0,
    conditions: {},
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
    staticEditDurationMs: 0,
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
    if (e.allocationMode === "internal_qa" && options.includeInternalQa !== true) {
      totals.excludedInternalQaEvents++
      continue
    }
    totals.events++
    if (typeof e.condition === "string") totals.conditions[e.condition] = (totals.conditions[e.condition] ?? 0) + 1
    const controlSurface = controlSurfaceOf(e)
    const monitoringSurface = monitoringSurfaceOf(e)
    incrementSurface(totals.controlInteractions, controlSurface)
    incrementSurface(totals.monitoringInteractions, monitoringSurface)
    if (e.type === "memory.interrupt") totals.memoryInterrupts++
    if (isResumeLinkedDelivery(e)) totals.resumeLinkedDeliveries++
    if (e.type === "memory.audit_action" && e.action === "enforce") totals.memoryEnforces++

    // Formal study sessions are task windows and may include several chats.
    // New production events carry taskId; sessionId remains the legacy chat
    // key only when no authoritative task identity exists.
    const legacySessionId = typeof e.sessionId === "string" && e.sessionId ? e.sessionId : undefined
    const analysisSessionId = typeof e.taskId === "string" && e.taskId
      ? e.taskId
      : legacySessionId
        ? taskWindowByChat.get(legacySessionId) ?? legacySessionId
        : undefined

    // Global (session-less) events: UI decisions come from HTTP routes.
    if (e.type === "memory.decision") {
      const action = e.action as keyof typeof totals.decisions
      if (action in totals.decisions) totals.decisions[action]++
      if (!analysisSessionId) continue
    }

    if (!analysisSessionId) continue
    const s = forSession(analysisSessionId)
    if (e.allocationMode === "internal_qa") s.allocationMode = "internal_qa"
    if (typeof e.condition === "string") s.condition = e.condition
    if (typeof e.participant === "string") s.participant = e.participant
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
      case "study.control_operation":
        if (
          e.phase === "completed"
          && e.surface === "static_memory"
          && e.action === "edit"
          && e.controlType === "static_edit"
          && typeof e.payload?.durationMs === "number"
          && Number.isFinite(e.payload.durationMs)
          && e.payload.durationMs >= 0
        ) {
          s.staticEditDurationMs += e.payload.durationMs
          totals.staticEditDurationMs += e.payload.durationMs
        }
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
    ["allocationMode", (s) => s.allocationMode],
    ["condition", (s) => s.condition],
    ["participant", (s) => s.participant ?? ""],
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
    ["staticEditDurationMs", (s) => s.staticEditDurationMs],
  ]

  return {
    sessions: finalized,
    totals,
    toCsv() {
      const header = CSV_COLUMNS.map(([name]) => name).join(",")
      const rows = Object.values(finalized).map((s) => CSV_COLUMNS.map(([, get]) => String(get(s))).join(","))
      return [header, ...rows].join("\n") + "\n"
    },
  }
}
