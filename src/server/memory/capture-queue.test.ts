import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CaptureQueue } from './capture-queue';

const lease = (turn: number, chatId = 'chat') => ({ chatId, turnId: `turn-${turn}`, turnNumber: turn, projectId: 'project' });

describe('durable per-turn capture journal', () => {
  it('retains busy turns in order, coalesces only identical leases, and exposes capacity skips', () => {
    const db = new Database(':memory:');
    try {
      const q = new CaptureQueue<{ task: string }>(db, { perChat: 2, total: 3, history: 10, payloadBytes: 1024 });
      expect(q.enqueue(lease(1), { task: 'first' }).outcome).toBe('queued');
      expect(q.transition(lease(1), 'pending', 'running')).toBe(true);
      q.enqueue(lease(2), { task: 'second' });
      expect(q.enqueue(lease(2), { task: 'overwrite' })).toEqual({ outcome: 'coalesced', reason: 'same-turn-already-recorded' });
      expect(q.get('chat', 'turn-2')!.payload.task).toBe('second');
      expect(q.enqueue(lease(3), { task: 'third' })).toEqual({ outcome: 'skipped', reason: 'queue-capacity' });
      q.enqueue(lease(1, 'other'), { task: 'other' });
      expect(q.enqueue(lease(1, 'third'), { task: 'global-limit' }).outcome).toBe('skipped');
      q.finish(lease(1), 'completed');
      expect(q.next('chat')!.turnId).toBe('turn-2');
      expect(q.list('chat').map(j => j.status)).toEqual(['completed', 'pending', 'skipped']);
      q.cancelChat('chat', 'memory-disabled');
      expect(q.next('chat')).toBeUndefined();
      expect(q.get('chat', 'turn-2')).toMatchObject({ status: 'skipped', reason: 'memory-disabled', payload: {} });
    } finally { db.close(); }
  });

  it('reopens interrupted model work, retains ready answers, and never replays ambiguous applying work', () => {
    const directory = mkdtempSync(join(tmpdir(), 'memosync-capture-journal-'));
    const path = join(directory, 'jobs.sqlite');
    let db = new Database(path);
    try {
      let q = new CaptureQueue<{ task: string }>(db);
      for (let turn = 1; turn <= 4; turn++) q.enqueue(lease(turn), { task: `task-${turn}` });
      q.transition(lease(1), 'pending', 'running');
      q.transition(lease(2), 'pending', 'running');
      q.ready(lease(2), { raw: { candidates: [] }, dependencyKey: 'exact' });
      q.transition(lease(3), 'pending', 'running');
      q.ready(lease(3), { raw: {}, dependencyKey: 'original' });
      q.transition(lease(3), 'ready', 'applying');
      q.finish(lease(4), 'completed');
      db.close(); db = new Database(path); q = new CaptureQueue(db);
      q.recover();
      expect(q.list().map(j => j.status)).toEqual(['pending', 'ready', 'failed', 'completed']);
      expect(q.get('chat', 'turn-2')!.result).toEqual({ raw: { candidates: [] }, dependencyKey: 'exact' });
      expect(q.get('chat', 'turn-3')!.reason).toBe('restart-during-apply');
      expect(q.enqueue(lease(4), { task: 'duplicate' }).outcome).toBe('coalesced');
    } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it('bounds payload/history and preserves idempotency after outcome pruning', () => {
    const db = new Database(':memory:');
    try {
      const q = new CaptureQueue(db, { perChat: 2, total: 2, history: 2, payloadBytes: 32 });
      expect(q.enqueue(lease(1), { task: 'x'.repeat(100) })).toEqual({ outcome: 'skipped', reason: 'payload-limit' });
      for (let turn = 2; turn <= 10; turn++) { q.enqueue(lease(turn), {}); q.finish(lease(turn), 'completed'); }
      expect(q.list()).toHaveLength(2);
      expect(q.enqueue(lease(1), {}).outcome).toBe('coalesced');
      expect(q.enqueue(lease(5), {}).outcome).toBe('coalesced');
      expect(q.next('chat')).toBeUndefined();
    } finally { db.close(); }
  });
});
