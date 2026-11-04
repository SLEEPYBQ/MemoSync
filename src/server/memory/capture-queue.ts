import type { Database } from 'bun:sqlite';

export type CaptureJobStatus = 'pending' | 'running' | 'ready' | 'applying' | 'completed' | 'skipped' | 'failed';
export interface CaptureLease {
  chatId: string;
  turnId: string;
  turnNumber: number;
  projectId?: string;
}
export interface CaptureJob<T> extends CaptureLease {
  status: CaptureJobStatus;
  payload: T;
  result?: { raw: Record<string, unknown>; dependencyKey: string };
  reason?: string;
  enqueuedAt: number;
}
interface Row { chat_id: string; turn_id: string; turn_number: number; project_id: string | null; status: CaptureJobStatus; payload: string; result: string | null; reason: string | null; enqueued_at: number }
const terminal = "'completed','skipped','failed'";

/** A narrow journal on the existing SQLite connection. No provider credentials,
 * transports or native configuration belong in payloads. One worker owns it
 * under the server's existing data-directory lock. */
export class CaptureQueue<T> {
  constructor(private readonly db: Database, private readonly limits = { perChat: 32, total: 256, history: 1024, payloadBytes: 512_000 }) {
    for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid capture queue limit');
    db.exec(`CREATE TABLE IF NOT EXISTS memory_capture_jobs (
      chat_id TEXT NOT NULL, turn_id TEXT NOT NULL, turn_number INTEGER NOT NULL,
      project_id TEXT, status TEXT NOT NULL, payload TEXT NOT NULL, result TEXT,
      reason TEXT, enqueued_at INTEGER NOT NULL, PRIMARY KEY(chat_id,turn_id));
      CREATE TABLE IF NOT EXISTS memory_capture_watermarks (chat_id TEXT PRIMARY KEY, turn_number INTEGER NOT NULL);`);
  }
  private decode(row: Row): CaptureJob<T> {
    return { chatId: row.chat_id, turnId: row.turn_id, turnNumber: row.turn_number, projectId: row.project_id ?? undefined,
      status: row.status, payload: JSON.parse(row.payload), result: row.result ? JSON.parse(row.result) : undefined,
      reason: row.reason ?? undefined, enqueuedAt: row.enqueued_at };
  }
  get(chatId: string, turnId: string): CaptureJob<T> | undefined {
    const row = this.db.query<Row, [string, string]>('SELECT * FROM memory_capture_jobs WHERE chat_id=? AND turn_id=?').get(chatId, turnId);
    return row ? this.decode(row) : undefined;
  }
  list(chatId?: string): CaptureJob<T>[] {
    const rows = chatId === undefined
      ? this.db.query<Row, []>('SELECT * FROM memory_capture_jobs ORDER BY enqueued_at,rowid').all()
      : this.db.query<Row, [string]>('SELECT * FROM memory_capture_jobs WHERE chat_id=? ORDER BY enqueued_at,rowid').all(chatId);
    return rows.map(row => this.decode(row));
  }
  enqueue(lease: CaptureLease, payload: T): { outcome: 'queued' | 'skipped' | 'coalesced'; reason?: string } {
    return this.db.transaction(() => {
      if (this.get(lease.chatId, lease.turnId)) return { outcome: 'coalesced' as const, reason: 'same-turn-already-recorded' };
      const watermark = this.db.query<{ turn_number: number }, [string]>('SELECT turn_number FROM memory_capture_watermarks WHERE chat_id=?').get(lease.chatId);
      if (watermark && lease.turnNumber <= watermark.turn_number) return { outcome: 'coalesced' as const, reason: 'turn-outside-retained-history' };
      const text = JSON.stringify(payload);
      const counts = this.db.query<{ total: number; chat: number }, [string]>(`SELECT COUNT(*) AS total, COALESCE(SUM(chat_id=?),0) AS chat FROM memory_capture_jobs WHERE status NOT IN (${terminal})`).get(lease.chatId)!;
      const reason = Buffer.byteLength(text) > this.limits.payloadBytes ? 'payload-limit'
        : counts.total >= this.limits.total || counts.chat >= this.limits.perChat ? 'queue-capacity' : undefined;
      this.db.query('INSERT INTO memory_capture_jobs(chat_id,turn_id,turn_number,project_id,status,payload,reason,enqueued_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(lease.chatId, lease.turnId, lease.turnNumber, lease.projectId ?? null, reason ? 'skipped' : 'pending', reason ? '{}' : text, reason ?? null, Date.now());
      this.prune();
      return { outcome: reason ? 'skipped' as const : 'queued' as const, reason };
    })();
  }
  next(chatId: string): CaptureJob<T> | undefined {
    const row = this.db.query<Row, [string]>("SELECT * FROM memory_capture_jobs WHERE chat_id=? AND status IN ('pending','ready') ORDER BY enqueued_at,rowid LIMIT 1").get(chatId);
    return row ? this.decode(row) : undefined;
  }
  transition(job: CaptureLease, from: CaptureJobStatus, to: CaptureJobStatus, reason?: string): boolean {
    return this.db.query('UPDATE memory_capture_jobs SET status=?,reason=? WHERE chat_id=? AND turn_id=? AND status=?')
      .run(to, reason ?? null, job.chatId, job.turnId, from).changes === 1;
  }
  ready(job: CaptureLease, result: NonNullable<CaptureJob<T>['result']>): void {
    const text = JSON.stringify(result);
    if (Buffer.byteLength(text) > this.limits.payloadBytes) throw new Error('Capture result exceeds queue payload limit');
    this.db.query("UPDATE memory_capture_jobs SET status='ready',result=? WHERE chat_id=? AND turn_id=? AND status='running'").run(text, job.chatId, job.turnId);
  }
  finish(job: CaptureLease, status: 'completed' | 'skipped' | 'failed', reason?: string): void {
    this.db.query(`UPDATE memory_capture_jobs SET status=?,reason=?,payload='{}',result=NULL WHERE chat_id=? AND turn_id=? AND status NOT IN (${terminal})`)
      .run(status, reason ?? null, job.chatId, job.turnId);
    this.prune();
  }
  cancelChat(chatId: string, reason: string): void {
    this.db.query(`UPDATE memory_capture_jobs SET status='skipped',reason=?,payload='{}',result=NULL WHERE chat_id=? AND status NOT IN (${terminal})`).run(reason, chatId);
    this.prune();
  }
  /** Never replay a possibly committed memory mutation. Ready answers can be
   * retried under their original dependency guard; interrupted analysis can
   * resume only after the coordinator validates its original runtime. */
  recover(): void {
    this.db.exec("UPDATE memory_capture_jobs SET status='pending' WHERE status='running'; UPDATE memory_capture_jobs SET status='failed',reason='restart-during-apply',payload='{}',result=NULL WHERE status='applying'");
    this.prune();
  }
  private prune(): void {
    const rows = this.db.query<Row, [number]>(`SELECT * FROM memory_capture_jobs WHERE status IN (${terminal}) ORDER BY enqueued_at DESC,rowid DESC LIMIT -1 OFFSET ?`).all(this.limits.history);
    for (const row of rows) {
      this.db.query('INSERT INTO memory_capture_watermarks(chat_id,turn_number) VALUES(?,?) ON CONFLICT(chat_id) DO UPDATE SET turn_number=MAX(turn_number,excluded.turn_number)').run(row.chat_id, row.turn_number);
      this.db.query('DELETE FROM memory_capture_jobs WHERE chat_id=? AND turn_id=?').run(row.chat_id, row.turn_id);
    }
  }
}
