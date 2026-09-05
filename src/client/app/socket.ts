import type {
  ClientCommand,
  ClientEnvelope,
  ServerEnvelope,
  SubscriptionTopic,
  TerminalEvent,
  TerminalSnapshot,
} from "../../shared/protocol"
import { LOG_PREFIX } from "../../shared/branding"
import { generateUUID } from "../lib/utils"

type SnapshotListener<T> = (value: T) => void
type EventListener<T> = (value: T) => void
export type SocketStatus = "connecting" | "connected" | "disconnected"

/** Fired on window when a reconnect probe finds the session locked out. */
export const WS_UNAUTHORIZED_EVENT = "memosync:ws-unauthorized"

/** True when the server says password auth is on and this session is not in. */
export function isLockedOutAuthStatus(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false
  const status = payload as { enabled?: unknown; authenticated?: unknown }
  return status.enabled === true && status.authenticated === false
}
type StatusListener = (status: SocketStatus) => void

const STALE_CONNECTION_MS = 25_000
const HEARTBEAT_INTERVAL_MS = 15_000
const PING_TIMEOUT_MS = 4_000
// Acks are fast (chat.send acks even before the engine boots — the preview
// gate parks instead of blocking), so a missing ack means the connection is
// gone even when the transport never says so (zombie TCP after a container
// restart: no error, no close event). Reject on a local timer the transport
// can't stall, so callers' error paths (draft restore, banner) actually run.
const COMMAND_ACK_TIMEOUT_MS = 10_000
const SEND_TO_STARTING_PROFILE_STORAGE_KEY = "memosync:profile-send-to-starting"

interface SubscriptionEntry<TSnapshot, TEvent = never> {
  topic: SubscriptionTopic
  listener: SnapshotListener<TSnapshot>
  eventListener?: EventListener<TEvent>
}

function isSendToStartingProfilingEnabled() {
  try {
    return window.sessionStorage.getItem(SEND_TO_STARTING_PROFILE_STORAGE_KEY) === "1"
      || window.localStorage.getItem(SEND_TO_STARTING_PROFILE_STORAGE_KEY) === "1"
  } catch {
    return false
  }
}

export class AppSocket {
  private readonly url: string
  private ws: WebSocket | null = null
  private started = false
  private reconnectTimer: number | null = null
  private reconnectDelayMs = 750
  private readonly subscriptions = new Map<string, SubscriptionEntry<unknown, unknown>>()
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }>()
  private readonly outboundQueue: ClientEnvelope[] = []
  private readonly statusListeners = new Set<StatusListener>()
  private heartbeatTimer: number | null = null
  private pingTimeoutTimer: number | null = null
  private pingPromise: Promise<void> | null = null
  private lastOpenAt = 0
  private lastMessageAt = 0
  private reconnectImmediatelyOnClose = false
  private readonly handleWindowFocus = () => {
    void this.ensureHealthyConnection()
  }
  private readonly handleVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      this.startHeartbeat()
      void this.ensureHealthyConnection()
      return
    }
    this.stopHeartbeat()
  }
  private readonly handleOnline = () => {
    void this.ensureHealthyConnection()
  }

  constructor(url: string) {
    this.url = url
  }

  start() {
    if (this.started) {
      return
    }
    this.started = true
    window.addEventListener("focus", this.handleWindowFocus)
    window.addEventListener("online", this.handleOnline)
    document.addEventListener("visibilitychange", this.handleVisibilityChange)
    this.connect()
  }

  dispose() {
    this.started = false
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.stopHeartbeat()
    this.clearPingState()
    window.removeEventListener("focus", this.handleWindowFocus)
    window.removeEventListener("online", this.handleOnline)
    document.removeEventListener("visibilitychange", this.handleVisibilityChange)
    this.ws?.close()
    this.ws = null
    for (const pending of this.pending.values()) {
      pending.reject(new Error("Socket disposed"))
    }
    this.pending.clear()
  }

  onStatus(listener: StatusListener) {
    this.statusListeners.add(listener)
    listener(this.getStatus())
    return () => {
      this.statusListeners.delete(listener)
    }
  }

  subscribe<TSnapshot, TEvent = never>(
    topic: SubscriptionTopic,
    listener: SnapshotListener<TSnapshot>,
    eventListener?: EventListener<TEvent>
  ) {
    const id = generateUUID()
    this.subscriptions.set(id, {
      topic,
      listener: listener as SnapshotListener<unknown>,
      eventListener: eventListener as EventListener<unknown> | undefined,
    })
    this.enqueue({ v: 1, type: "subscribe", id, topic })
    return () => {
      this.subscriptions.delete(id)
      this.enqueue({ v: 1, type: "unsubscribe", id })
    }
  }

  /**
   * Ask the server to rebuild the latest snapshot for an existing topic.
   * Reusing the subscription id is intentional: the server clears that id's
   * snapshot signature before replying, so this repairs a single dropped
   * terminal snapshot without tearing down the socket or duplicating
   * listeners.
   */
  refreshTopic(topic: SubscriptionTopic): boolean {
    const wanted = JSON.stringify(topic)
    let refreshed = false
    for (const [id, subscription] of this.subscriptions.entries()) {
      if (JSON.stringify(subscription.topic) !== wanted) continue
      this.enqueue({ v: 1, type: "subscribe", id, topic: subscription.topic })
      refreshed = true
    }
    return refreshed
  }

  subscribeTerminal(
    terminalId: string,
    handlers: {
      onSnapshot: SnapshotListener<TerminalSnapshot | null>
      onEvent?: EventListener<TerminalEvent>
    }
  ) {
    const id = generateUUID()
    const topic: SubscriptionTopic = { type: "terminal", terminalId }
    this.subscriptions.set(id, {
      topic,
      listener: handlers.onSnapshot as SnapshotListener<unknown>,
      eventListener: handlers.onEvent as EventListener<unknown> | undefined,
    })
    this.enqueue({ v: 1, type: "subscribe", id, topic })
    return () => {
      this.subscriptions.delete(id)
      this.enqueue({ v: 1, type: "unsubscribe", id })
    }
  }

  command<TResult = unknown>(command: ClientCommand) {
    const id = generateUUID()
    const envelope: ClientEnvelope = { v: 1, type: "command", id, command }
    return new Promise<TResult>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        reject(new Error(`${command.type} timed out waiting for the server — reconnecting`))
        this.reconnectNow()
      }, COMMAND_ACK_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: (value: unknown) => {
          window.clearTimeout(timer)
          resolve(value as TResult)
        },
        reject: (reason?: unknown) => {
          window.clearTimeout(timer)
          reject(reason)
        },
      })
      this.enqueue(envelope)
    })
  }

  ensureHealthyConnection() {
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
      this.reconnectNow()
      return Promise.resolve()
    }

    if (this.ws.readyState === WebSocket.CONNECTING) {
      return Promise.resolve()
    }

    if (!this.isConnectionStale()) {
      return Promise.resolve()
    }

    return this.sendPing()
  }

  private connect() {
    if (!this.started) {
      return
    }
    this.emitStatus("connecting")
    this.ws = new WebSocket(this.url)

    this.ws.addEventListener("open", () => {
      this.reconnectDelayMs = 750
      this.reconnectImmediatelyOnClose = false
      this.lastOpenAt = Date.now()
      this.lastMessageAt = this.lastOpenAt
      this.emitStatus("connected")
      this.startHeartbeat()
      for (const [id, subscription] of this.subscriptions.entries()) {
        this.sendNow({ v: 1, type: "subscribe", id, topic: subscription.topic })
      }
      while (this.outboundQueue.length > 0) {
        const envelope = this.outboundQueue.shift()
        if (!envelope) continue
        // Only still-pending commands cross a reconnect. A settled command
        // (close-rejected or ack-timed-out) was already reported failed — the
        // draft came back and the user may have re-sent it, so replaying the
        // queued envelope would deliver the "failed" message twice. Queued
        // (un)subscribes are stale here too: the loop above already
        // re-subscribed every live topic on this fresh connection.
        if (envelope.type !== "command") continue
        if (!this.pending.has(envelope.id)) continue
        this.sendNow(envelope)
      }
    })

    this.ws.addEventListener("message", (event) => {
      this.lastMessageAt = Date.now()
      const receivedAt = performance.now()
      const rawText = String(event.data)
      let payload: ServerEnvelope
      try {
        payload = JSON.parse(rawText) as ServerEnvelope
      } catch {
        return
      }

      if (isSendToStartingProfilingEnabled() && payload.type === "snapshot" && payload.snapshot.type === "chat" && payload.snapshot.data?.runtime.status === "starting") {
        console.debug("[memosync/send->starting][client-ws]", {
          stage: "socket_message_received",
          receivedAt,
          payloadBytes: rawText.length,
          chatId: payload.snapshot.data.runtime.chatId,
          status: payload.snapshot.data.runtime.status,
          messageCount: payload.snapshot.data.messages.length,
        })
      }

      if (isSendToStartingProfilingEnabled() && payload.type === "ack") {
        console.debug("[memosync/send->starting][client-ws]", {
          stage: "socket_ack_received",
          receivedAt,
          payloadBytes: rawText.length,
          commandId: payload.id,
        })
      }

      if (payload.type === "snapshot") {
        const subscription = this.subscriptions.get(payload.id)
        subscription?.listener(payload.snapshot.data)
        return
      }

      if (payload.type === "event") {
        const subscription = this.subscriptions.get(payload.id)
        subscription?.eventListener?.(payload.event)
        return
      }

      if (payload.type === "ack") {
        const pending = this.pending.get(payload.id)
        if (!pending) return
        this.pending.delete(payload.id)
        pending.resolve(payload.result)
        return
      }

      if (payload.type === "error") {
        if (!payload.id) {
          console.error(LOG_PREFIX, payload.message)
          return
        }
        const pending = this.pending.get(payload.id)
        if (pending) {
          this.pending.delete(payload.id)
          pending.reject(new Error(payload.message))
          return
        }
        // A scoped subscription error (the server could not derive this
        // topic's snapshot). For nullable-data topics, deliver null so the
        // UI shows its empty/not-found state instead of freezing on the
        // last good snapshot.
        const subscription = this.subscriptions.get(payload.id)
        if (subscription) {
          console.error(LOG_PREFIX, `subscription ${subscription.topic.type} failed:`, payload.message)
          const topicType = subscription.topic.type
          if (topicType === "chat" || topicType === "project-git" || topicType === "terminal") {
            subscription.listener(null)
          }
        }
      }
    })

    this.ws.addEventListener("close", () => {
      if (!this.started) {
        return
      }
      const reconnectImmediately = this.reconnectImmediatelyOnClose
      this.reconnectImmediatelyOnClose = false
      this.stopHeartbeat()
      this.clearPingState()
      this.emitStatus("disconnected")
      for (const pending of this.pending.values()) {
        pending.reject(new Error("Disconnected"))
      }
      this.pending.clear()
      // In parallel with the reconnect loop: a handshake 401 (expired or
      // rotated password cookie) closes the socket with no readable status,
      // so without this probe the client reconnects forever instead of
      // returning to the password gate.
      void this.probeAuthLockout()
      if (reconnectImmediately) {
        this.connect()
        return
      }
      this.scheduleReconnect()
    })
  }

  private async probeAuthLockout() {
    if (typeof fetch !== "function") return
    try {
      const controller = new AbortController()
      const abortTimer = setTimeout(() => controller.abort(), 2_000)
      const response = await fetch("/auth/status", {
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      })
      clearTimeout(abortTimer)
      if (!response.ok) return
      if (!isLockedOutAuthStatus(await response.json())) return
    } catch {
      // Network trouble — indistinguishable from a real outage; let the
      // normal reconnect loop keep trying.
      return
    }
    if (!this.started) return
    this.dispose()
    this.emitStatus("disconnected")
    window.dispatchEvent(new Event(WS_UNAUTHORIZED_EVENT))
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== null) return
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 5_000)
    }, this.reconnectDelayMs)
  }

  private getStatus(): SocketStatus {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return "connected"
    }
    if (this.ws?.readyState === WebSocket.CONNECTING) {
      return "connecting"
    }
    return "disconnected"
  }

  private emitStatus(status: SocketStatus) {
    for (const listener of this.statusListeners) {
      listener(status)
    }
  }

  private isConnectionStale() {
    const baseline = Math.max(this.lastMessageAt, this.lastOpenAt)
    return baseline > 0 && Date.now() - baseline >= STALE_CONNECTION_MS
  }

  private sendPing() {
    if (this.pingPromise) {
      return this.pingPromise
    }

    const pingPromise = this.command({ type: "system.ping" })
      .then(() => {
        this.clearPingState()
      })
      .catch((error) => {
        this.clearPingState()
        this.reconnectNow()
        throw error
      })

    this.pingTimeoutTimer = window.setTimeout(() => {
      this.clearPingState()
      this.reconnectNow()
    }, PING_TIMEOUT_MS)

    this.pingPromise = pingPromise
    return pingPromise
  }

  private reconnectNow() {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
      this.connect()
      return
    }

    if (this.ws.readyState === WebSocket.CONNECTING) {
      return
    }

    this.reconnectImmediatelyOnClose = true
    this.ws.close()
  }

  private startHeartbeat() {
    if (document.visibilityState !== "visible") {
      return
    }

    if (this.heartbeatTimer !== null) {
      return
    }

    this.heartbeatTimer = window.setInterval(() => {
      if (document.visibilityState !== "visible") {
        this.stopHeartbeat()
        return
      }
      if (this.ws?.readyState !== WebSocket.OPEN) {
        return
      }
      void this.ensureHealthyConnection()
    }, HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private clearPingState() {
    if (this.pingTimeoutTimer !== null) {
      window.clearTimeout(this.pingTimeoutTimer)
      this.pingTimeoutTimer = null
    }
    this.pingPromise = null
  }

  private enqueue(envelope: ClientEnvelope) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendNow(envelope)
      return
    }
    this.outboundQueue.push(envelope)
  }

  private sendNow(envelope: ClientEnvelope) {
    this.ws?.send(JSON.stringify(envelope))
  }
}
