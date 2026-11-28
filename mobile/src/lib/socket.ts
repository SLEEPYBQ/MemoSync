import { AppState, type AppStateStatus, type NativeEventSubscription } from "react-native"
import type {
  ClientCommand,
  ClientEnvelope,
  ServerEnvelope,
  SubscriptionTopic,
} from "../types"

export type SocketStatus = "connecting" | "connected" | "disconnected"

type SnapshotListener = (value: unknown) => void
type StatusListener = (status: SocketStatus) => void

const INITIAL_RECONNECT_MS = 750
const MAX_RECONNECT_MS = 5_000
const CONNECT_TIMEOUT_MS = 8_000
const COMMAND_ACK_TIMEOUT_MS = 10_000
// Sending is not a read-only probe: the host can durably commit the prompt
// and still be cold-starting a provider when a short client deadline fires.
// Give admission-style commands a startup-sized grace period instead.
const SEND_COMMAND_ACK_TIMEOUT_MS = 90_000
const STALE_CONNECTION_MS = 15_000
const HEARTBEAT_INTERVAL_MS = 15_000
const PING_TIMEOUT_MS = 4_000

function ackTimeoutForCommand(command: ClientCommand): number {
  return command.type === "chat.send" || command.type === "message.enqueue"
    ? SEND_COMMAND_ACK_TIMEOUT_MS
    : COMMAND_ACK_TIMEOUT_MS
}

/** Small RFC4122-ish id; only needs uniqueness within one socket session. */
function generateId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === "x" ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/**
 * React Native's WebSocket constructor accepts a third options bag with
 * `headers` — the way device-token auth is attached to the handshake. The
 * dom-style constructor types don't model it, so construct through a cast.
 */
const RNWebSocket = WebSocket as unknown as new (
  url: string,
  protocols: string | string[] | null,
  options: { headers?: Record<string, string> },
) => WebSocket

interface SubscriptionEntry {
  topic: SubscriptionTopic
  listener: SnapshotListener
}

interface PendingCommand {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Reconnecting MemoSync host socket.
 *
 * Conceptually adapted from the web client's src/client/app/socket.ts, cut to
 * what mobile needs: exponential-backoff reconnect, command/ack promise
 * correlation with timeouts, subscription re-send on reconnect, and an
 * outbound queue so commands issued while offline fail fast instead of being
 * replayed twice.
 */
export class MemoSyncSocket {
  private ws: WebSocket | null = null
  private started = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelayMs = INITIAL_RECONNECT_MS
  private connectTimeoutTimer: ReturnType<typeof setTimeout> | null = null
  private connectStartedAt = 0
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private pingTimeoutTimer: ReturnType<typeof setTimeout> | null = null
  private pingPromise: Promise<void> | null = null
  private appStateSubscription: NativeEventSubscription | null = null
  private backgroundedAt: number | null = null
  private lastOpenAt = 0
  private lastMessageAt = 0
  private readonly subscriptions = new Map<string, SubscriptionEntry>()
  private readonly pending = new Map<string, PendingCommand>()
  private readonly statusListeners = new Set<StatusListener>()

  constructor(
    private readonly url: string,
    private readonly token: string,
    private onUnauthorized?: () => void,
  ) {}

  setUnauthorizedListener(listener: (() => void) | undefined) {
    this.onUnauthorized = listener
  }

  start() {
    if (this.started) return
    this.started = true
    this.appStateSubscription?.remove()
    this.appStateSubscription = AppState.addEventListener("change", this.handleAppStateChange)
    this.connect()
  }

  dispose() {
    this.started = false
    this.appStateSubscription?.remove()
    this.appStateSubscription = null
    this.backgroundedAt = null
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.detachSocket()
    this.failAllPending(new Error("Socket disposed"))
    this.subscriptions.clear()
    this.statusListeners.clear()
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener)
    listener(this.getStatus())
    return () => {
      this.statusListeners.delete(listener)
    }
  }

  /**
   * Subscribe to a topic. The listener receives every snapshot pushed for it.
   * Subscriptions re-send automatically when the socket reconnects.
   * Returns the unsubscribe function.
   */
  subscribe<TSnapshot>(topic: SubscriptionTopic, listener: (value: TSnapshot) => void): () => void {
    const id = generateId()
    this.subscriptions.set(id, { topic, listener: listener as SnapshotListener })
    this.sendNow({ v: 1, type: "subscribe", id, topic })
    return () => {
      this.subscriptions.delete(id)
      this.sendNow({ v: 1, type: "unsubscribe", id })
    }
  }

  /** Dispatch a command; the promise resolves with the ack result or rejects
   * on error/disconnect/timeout. */
  command<TResult = unknown>(command: ClientCommand): Promise<TResult> {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      // Fail fast: the caller restores the draft and the user decides to
      // retry, instead of a dropped envelope timing out silently 10s later.
      return Promise.reject(new Error("Not connected to the MemoSync host"))
    }
    const id = generateId()
    const envelope: ClientEnvelope = { v: 1, type: "command", id, command }
    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        reject(new Error(`Timed out waiting for the server (${command.type})`))
      }, ackTimeoutForCommand(command))
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value as TResult)
        },
        reject: (reason) => {
          clearTimeout(timer)
          reject(reason)
        },
        timer,
      })
      this.sendNow(envelope)
    })
  }

  getStatus(): SocketStatus {
    if (this.ws?.readyState === WebSocket.OPEN) return "connected"
    if (this.ws?.readyState === WebSocket.CONNECTING) return "connecting"
    return "disconnected"
  }

  // -- internals ------------------------------------------------------------

  private connect() {
    if (!this.started) return
    this.detachSocket()
    this.connectStartedAt = Date.now()
    this.emitStatus("connecting")
    const ws = new RNWebSocket(this.url, null, {
      headers: { Authorization: `Bearer ${this.token}` },
    })
    this.ws = ws
    this.connectTimeoutTimer = setTimeout(() => {
      if (!this.started || this.ws !== ws || ws.readyState !== WebSocket.CONNECTING) return
      this.detachSocket()
      this.emitStatus("disconnected")
      this.failAllPending(new Error("Timed out connecting to the MemoSync host"))
      void this.probeUnauthorized()
      this.scheduleReconnect()
    }, CONNECT_TIMEOUT_MS)

    ws.onopen = () => {
      if (!this.started || this.ws !== ws) return
      this.clearConnectTimeout()
      this.reconnectDelayMs = INITIAL_RECONNECT_MS
      this.lastOpenAt = Date.now()
      this.lastMessageAt = this.lastOpenAt
      this.emitStatus("connected")
      if (AppState.currentState !== "background") {
        this.startHeartbeat()
      }
      // Re-subscribe every live topic on the fresh connection. Commands that
      // were in flight when the last socket died already rejected — the user
      // re-sends deliberately — so nothing else is replayed.
      for (const [id, subscription] of this.subscriptions.entries()) {
        this.sendNow({ v: 1, type: "subscribe", id, topic: subscription.topic })
      }
    }

    ws.onmessage = (event) => {
      if (!this.started || this.ws !== ws) return
      this.lastMessageAt = Date.now()
      let payload: ServerEnvelope
      try {
        payload = JSON.parse(String(event.data)) as ServerEnvelope
      } catch {
        return
      }
      this.handleEnvelope(payload)
    }

    ws.onclose = (event) => {
      if (!this.started || this.ws !== ws) return
      this.ws = null
      this.clearConnectTimeout()
      this.stopHeartbeat()
      this.clearPingState()
      this.emitStatus("disconnected")
      this.failAllPending(new Error("Disconnected from the MemoSync host"))
      const closeEvent = event as unknown as { code?: number; reason?: string }
      if (closeEvent.code === 4001 || closeEvent.reason === "Device revoked") {
        this.handleUnauthorized()
        return
      }
      // A rejected WebSocket upgrade does not expose its HTTP status to RN.
      // Probe the device-accessible status route before continuing the retry
      // loop; otherwise a revoked token reconnects forever instead of sending
      // the app back through pairing.
      void this.probeUnauthorized()
      this.scheduleReconnect()
    }

    ws.onerror = () => {
      // onclose always follows on normal failures; blackholed connects/pings
      // are separately bounded by connectTimeoutTimer and pingTimeoutTimer.
    }
  }

  private handleEnvelope(payload: ServerEnvelope) {
    if (payload.type === "snapshot") {
      const subscription = this.subscriptions.get(payload.id)
      subscription?.listener(payload.snapshot.data)
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
      if (!payload.id) return
      const pending = this.pending.get(payload.id)
      if (pending) {
        this.pending.delete(payload.id)
        pending.reject(new Error(payload.message))
        return
      }
      // A scoped subscription error: deliver null so the screen shows its
      // empty/not-found state instead of freezing on the last good snapshot.
      const subscription = this.subscriptions.get(payload.id)
      if (subscription && subscription.topic.type === "chat") {
        subscription.listener(null)
      }
    }
  }

  private sendNow(envelope: ClientEnvelope) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(envelope))
    }
    // Envelopes written while disconnected are dropped on purpose:
    // subscriptions are re-sent on reconnect anyway, and commands reject
    // via failAllPending so the UI can offer an explicit retry.
  }

  private failAllPending(error: Error) {
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }
    this.pending.clear()
  }

  private unauthorizedProbeUrl(): string {
    const httpUrl = this.url.replace(/^ws(s?):\/\//, (_match, secure: string) => `http${secure}://`)
    return `${httpUrl.replace(/\/ws$/, "")}/api/remote-access/status`
  }

  private async probeUnauthorized() {
    if (typeof fetch !== "function") return
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2_500)
    let unauthorized = false
    try {
      const response = await fetch(this.unauthorizedProbeUrl(), {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.token}`,
        },
        signal: controller.signal,
      })
      unauthorized = response.status === 401
    } catch {
      // Network trouble is indistinguishable from a real outage here; keep the
      // ordinary reconnect loop running rather than discarding a usable pairing.
      return
    } finally {
      clearTimeout(timer)
    }
    if (unauthorized) this.handleUnauthorized()
  }

  private handleUnauthorized() {
    if (!this.started) return
    this.started = false
    this.appStateSubscription?.remove()
    this.appStateSubscription = null
    this.backgroundedAt = null
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.detachSocket()
    this.emitStatus("disconnected")
    this.failAllPending(new Error("This device is no longer paired with the MemoSync host"))
    this.onUnauthorized?.()
  }

  private readonly handleAppStateChange = (nextState: AppStateStatus) => {
    if (!this.started) return
    if (nextState === "background") {
      this.backgroundedAt = Date.now()
      this.stopHeartbeat()
      this.clearPingState()
      return
    }
    if (nextState !== "active") return

    const wasBackgrounded = this.backgroundedAt !== null
    this.backgroundedAt = null
    this.reconnectDelayMs = INITIAL_RECONNECT_MS

    if (!this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
      this.reconnectNow(true)
      return
    }
    if (this.ws.readyState === WebSocket.CONNECTING) {
      if (wasBackgrounded || Date.now() - this.connectStartedAt >= CONNECT_TIMEOUT_MS) {
        this.reconnectNow(true)
      }
      return
    }
    this.startHeartbeat()
    const idleMs = Date.now() - Math.max(this.lastMessageAt, this.lastOpenAt)
    if (wasBackgrounded || idleMs >= 2_000) {
      void this.sendPing()
    }
  }

  /** React Native can keep a TCP/WebSocket connection nominally open after a
   * network path silently drops. The host answers system.ping immediately, so
   * an idle-open socket that cannot produce a pong is detached and replaced. */
  ensureHealthyConnection(): Promise<void> {
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
      this.reconnectNow(true)
      return Promise.resolve()
    }
    if (this.ws.readyState === WebSocket.CONNECTING) {
      if (Date.now() - this.connectStartedAt >= CONNECT_TIMEOUT_MS) {
        this.reconnectNow(true)
      }
      return Promise.resolve()
    }
    if (!this.isConnectionStale()) return Promise.resolve()
    return this.sendPing()
  }

  private isConnectionStale(): boolean {
    const baseline = Math.max(this.lastMessageAt, this.lastOpenAt)
    return baseline > 0 && Date.now() - baseline >= STALE_CONNECTION_MS
  }

  private sendPing(): Promise<void> {
    if (this.pingPromise) return this.pingPromise
    const targetWs = this.ws
    if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
      this.reconnectNow(true)
      return Promise.resolve()
    }
    let settled = false
    const finish = (healthy: boolean) => {
      if (settled) return
      settled = true
      this.clearPingState()
      if (!healthy && this.ws === targetWs) {
        this.reconnectNow(true)
      }
    }
    const pingPromise = this.command({ type: "system.ping" })
      .then(() => finish(true))
      .catch(() => finish(false))
    this.pingTimeoutTimer = setTimeout(() => finish(false), PING_TIMEOUT_MS)
    this.pingPromise = pingPromise
    return pingPromise
  }

  private reconnectNow(force = false) {
    if (!this.started) return
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
      this.connect()
      return
    }
    if (
      this.ws.readyState === WebSocket.CONNECTING &&
      !force &&
      Date.now() - this.connectStartedAt < CONNECT_TIMEOUT_MS
    ) {
      return
    }
    // Detach handlers and abandon the wedged socket immediately instead of
    // waiting 60-120s for OS TCP FIN/SYN retransmission on a dead route.
    this.detachSocket()
    this.emitStatus("disconnected")
    this.failAllPending(new Error("Disconnected from the MemoSync host"))
    this.connect()
  }

  private detachSocket(): WebSocket | null {
    this.clearConnectTimeout()
    this.stopHeartbeat()
    this.clearPingState()
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onopen = null
      ws.onmessage = null
      ws.onclose = null
      ws.onerror = null
      try {
        ws.close()
      } catch {
        // Ignore close errors on already-broken native sockets.
      }
    }
    return ws
  }

  private clearConnectTimeout() {
    if (this.connectTimeoutTimer !== null) {
      clearTimeout(this.connectTimeoutTimer)
      this.connectTimeoutTimer = null
    }
  }

  private startHeartbeat() {
    if (this.heartbeatTimer !== null) return
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return
      void this.ensureHealthyConnection()
    }, HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private clearPingState() {
    if (this.pingTimeoutTimer !== null) {
      clearTimeout(this.pingTimeoutTimer)
      this.pingTimeoutTimer = null
    }
    this.pingPromise = null
  }

  private scheduleReconnect() {
    if (!this.started || this.reconnectTimer !== null) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, MAX_RECONNECT_MS)
    }, this.reconnectDelayMs)
  }

  private emitStatus(status: SocketStatus) {
    for (const listener of this.statusListeners) {
      listener(status)
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton: one socket per paired host, shared by all screens.
// ---------------------------------------------------------------------------

let currentSocket: MemoSyncSocket | null = null
let currentKey: string | null = null

/** Create (or reuse) the shared socket for a paired host. */
export function ensureSocket(host: string, port: number, token: string, onUnauthorized?: () => void): MemoSyncSocket {
  const key = `${host}:${port}:${token}`
  if (currentSocket && currentKey === key) {
    if (onUnauthorized) currentSocket.setUnauthorizedListener(onUnauthorized)
    return currentSocket
  }
  currentSocket?.dispose()
  const url = `ws://${host}:${port}/ws`
  currentSocket = new MemoSyncSocket(url, token, onUnauthorized)
  currentKey = key
  currentSocket.start()
  return currentSocket
}

export function getSocket(): MemoSyncSocket | null {
  return currentSocket
}

export function teardownSocket() {
  currentSocket?.dispose()
  currentSocket = null
  currentKey = null
}
