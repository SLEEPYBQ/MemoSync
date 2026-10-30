import type { TerminalSnapshot } from "../../../shared/protocol"

interface Output { data: string; version?: number; sessionId?: string }
interface TerminalWriter { reset(): void; write(data: string, callback: () => void): void }

/** Owns both the accepted output cursor and the xterm write queue. */
export class TerminalOutputSync {
  private version: number | null = null
  private sessionId: string | undefined
  private queue: Array<{ data: string; reset: boolean }> = []
  private writing = false
  private disposed = false

  constructor(private readonly terminal: TerminalWriter) {}

  get cursor() { return { sinceVersion: this.version, sessionId: this.sessionId } }

  snapshot(snapshot: TerminalSnapshot) {
    if (this.disposed) return false
    if (snapshot.sessionId === this.sessionId && this.version !== null && snapshot.outputVersion !== undefined && snapshot.outputVersion <= this.version) return false
    this.sessionId = snapshot.sessionId
    this.version = snapshot.outputVersion ?? null
    this.enqueue(snapshot.serializedState, true)
    return true
  }

  /** False means the server must repair a gap or replace a different session. */
  output(output: Output) {
    if (this.disposed) return false
    if (output.version === undefined) {
      this.version = null
      this.enqueue(output.data, false)
      return true
    }
    if (this.version === null || output.sessionId !== this.sessionId) return false
    if (output.version <= this.version) return true
    const start = output.version - output.data.length
    if (start > this.version) return false
    this.enqueue(output.data.slice(this.version - start), false)
    this.version = output.version
    return true
  }

  dispose() { this.disposed = true; this.queue = []; this.version = null; this.sessionId = undefined }

  private enqueue(data: string, reset: boolean) {
    this.queue.push({ data, reset })
    this.flush()
  }

  private flush() {
    if (this.disposed || this.writing) return
    const next = this.queue.shift()
    if (!next) return
    this.writing = true
    if (next.reset) this.terminal.reset()
    this.terminal.write(next.data, () => { this.writing = false; this.flush() })
  }
}
