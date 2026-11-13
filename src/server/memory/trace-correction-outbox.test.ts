import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../event-store';
import { MemoryService } from './index';
import { createTraceCorrectionTransport, flushTraceCorrections, startTraceCorrectionDelivery } from './trace-correction-outbox';

const dirs: string[] = [];
const memories: MemoryService[] = [];
afterEach(() => {
  for (const memory of memories.splice(0)) memory.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'memosync-correction-outbox-'));
  dirs.push(dir);
  const eventDir = join(dir, 'events');
  const dbPath = join(dir, 'memory.sqlite');
  const dataDir = join(dir, 'projections');
  const events = new EventStore(eventDir);
  await events.initialize();
  const project = await events.openProject(join(dir, 'synthetic-project'));
  const chat = await events.createChat(project.id);
  const memory = new MemoryService({ dbPath, dataDir });
  memories.push(memory);
  return { dir, eventDir, dbPath, dataDir, events, chat, memory };
}

function seed(memory: MemoryService, chatId: string) {
  const item = memory.store.create({ content: 'Synthetic rule', scope: 'personal', type: 'constraint' }, { actor: 'user' });
  memory.store.recordTraceLabel(item.id, 'violated', { actor: 'agent', sessionId: chatId, turn: 1, cited: false });
  return item;
}

test('recovers a committed correction and invalidated proposal after restart without another POST', async () => {
  const { eventDir, dbPath, dataDir, events, chat, memory } = await setup();
  const target = memory.store.create({ content: 'Synthetic project rule', scope: 'project', projectId: 'SyntheticProject', type: 'constraint' }, { actor: 'user' });
  for (let turn = 1; turn <= 3; turn++) {
    memory.store.recordTraceLabel(target.id, 'violated', { actor: 'agent', sessionId: chat.id, turn, cited: false });
  }
  const traceEvidence = memory.store.recentTraceEvidence(target.id).map(row => row.seq);
  const proposal = memory.store.createRevisionProposal(
    { content: 'Synthetic proposal', scope: 'project', projectId: 'SyntheticProject', type: 'constraint', evidenceClass: 'inferred' },
    target.id, { actor: 'system' }, { traceEvidence },
  )!;
  memory.syncProjection('SyntheticProject');
  const originalSetKv = memory.store.setKv.bind(memory.store);
  const targetBefore = memory.store.getById(target.id);
  const eventsBefore = memory.store.getEvents(target.id);
  memory.store.setKv = (key, value) => {
    if (key.startsWith('trace_correction_delivery:')) throw new Error('Synthetic queue failure');
    originalSetKv(key, value);
  };
  try {
    expect(() => memory.store.recordTraceCorrection(target.id, { sessionId: chat.id, turn: 2, label: 'operational' }, { enqueueTranscript: true })).toThrow('Synthetic queue failure');
  } finally {
    memory.store.setKv = originalSetKv;
  }
  expect(memory.store.getById(target.id)).toEqual(targetBefore);
  expect(memory.store.getEvents(target.id)).toEqual(eventsBefore);
  expect(memory.store.getById(proposal.id)?.status).toBe('candidate');
  expect(memory.store.pendingTraceCorrectionDeliveries()).toEqual([]);
  const result = memory.store.recordTraceCorrection(target.id, { sessionId: chat.id, turn: 2, label: 'operational' }, { enqueueTranscript: true });
  expect(result.invalidatedIds).toEqual([proposal.id]);
  expect(memory.store.getById(proposal.id)?.status).toBe('archived');
  expect(memory.store.getById(target.id)?.usageCount).toBe(1);
  const queued = memory.store.pendingTraceCorrectionDeliveries();
  expect(queued).toHaveLength(1);
  expect(queued[0]?.projectionProjectIds).toEqual(['SyntheticProject']);
  await expect(flushTraceCorrections(memory, { hasChat: () => true, append: async () => { throw new Error('Synthetic write failure'); } })).rejects.toThrow('Synthetic write failure');
  expect(memory.store.pendingTraceCorrectionDeliveries()).toEqual(queued);
  const eventCount = memory.store.getEvents(target.id).filter(event => event.kind === 'trace_correction').length;
  memory.close();
  memories.splice(memories.indexOf(memory), 1);

  const reopenedEvents = new EventStore(eventDir);
  await reopenedEvents.initialize();
  const reopened = new MemoryService({ dbPath, dataDir });
  memories.push(reopened);
  expect(reopened.store.pendingTraceCorrectionDeliveries()).toEqual(queued);
  let delivered!: () => void;
  const deliveredPromise = new Promise<void>(resolve => { delivered = resolve; });
  const stop = startTraceCorrectionDelivery(reopened, createTraceCorrectionTransport(reopenedEvents, async () => { delivered(); }));
  await deliveredPromise;
  await stop();
  expect(reopened.store.pendingTraceCorrectionDeliveries()).toEqual([]);
  expect(reopenedEvents.getMessages(chat.id).filter(entry => entry.kind === 'memory_trace_correction')).toEqual([queued[0]!.entry]);
  expect(reopened.store.getEvents(target.id).filter(event => event.kind === 'trace_correction')).toHaveLength(eventCount);
  expect(reopened.store.getById(target.id)?.usageCount).toBe(1);
  expect(reopened.store.getById(proposal.id)?.status).toBe('archived');
  expect(readFileSync(join(dataDir, 'projects', 'SyntheticProject', 'memories.md'), 'utf8')).not.toContain('Synthetic proposal');
  expect(events.getChat(chat.id)).toBeDefined();
});

test('delivers a correction and withdrawal in sequence order', async () => {
  const { events, chat, memory } = await setup();
  const item = seed(memory, chat.id);
  memory.store.recordTraceCorrection(item.id, { sessionId: chat.id, turn: 1, label: 'operational' }, { enqueueTranscript: true });
  memory.store.recordTraceCorrection(item.id, { sessionId: chat.id, turn: 1, label: null }, { enqueueTranscript: true });
  const pending = memory.store.pendingTraceCorrectionDeliveries();
  expect(pending.map(delivery => delivery.entry.label)).toEqual(['operational', null]);
  expect(pending[0]!.seq).toBeLessThan(pending[1]!.seq);
  await flushTraceCorrections(memory, createTraceCorrectionTransport(events, async () => {}));
  expect(events.getMessages(chat.id)).toEqual(pending.map(delivery => delivery.entry));
  expect(memory.store.recentTraceLabels(item.id)).toEqual(['violated']);
  expect(memory.store.getById(item.id)?.usageCount).toBe(0);
  expect(memory.store.pendingTraceCorrectionDeliveries()).toEqual([]);
});

test('refreshes an invalidated project projection even if the chat was deleted', async () => {
  const { dataDir, chat, memory } = await setup();
  const target = memory.store.create({ content: 'Synthetic project rule', scope: 'project', projectId: 'SyntheticProject', type: 'constraint' }, { actor: 'user' });
  for (let turn = 1; turn <= 3; turn++) {
    memory.store.recordTraceLabel(target.id, 'violated', { actor: 'agent', sessionId: chat.id, turn });
  }
  const traceEvidence = memory.store.recentTraceEvidence(target.id).map(row => row.seq);
  const proposal = memory.store.createRevisionProposal(
    { content: 'Synthetic proposal', scope: 'project', projectId: 'SyntheticProject', type: 'constraint', evidenceClass: 'inferred' },
    target.id, { actor: 'system' }, { traceEvidence },
  )!;
  memory.syncProjection('SyntheticProject');
  const projection = join(dataDir, 'projects', 'SyntheticProject', 'memories.md');
  expect(readFileSync(projection, 'utf8')).toContain('Synthetic proposal');
  const result = memory.store.recordTraceCorrection(target.id, { sessionId: chat.id, turn: 2, label: 'operational' }, { enqueueTranscript: true });
  expect(result.invalidatedIds).toEqual([proposal.id]);
  let appended = false;
  await flushTraceCorrections(memory, { hasChat: () => false, append: async () => { appended = true; } });
  expect(readFileSync(projection, 'utf8')).not.toContain('Synthetic proposal');
  expect(memory.store.pendingTraceCorrectionDeliveries()).toEqual([]);
  expect(appended).toBe(false);
});

test('periodically retries a transient append failure without another request', async () => {
  const { events, chat, memory } = await setup();
  const item = seed(memory, chat.id);
  memory.store.recordTraceCorrection(item.id, { sessionId: chat.id, turn: 1, label: 'operational' }, { enqueueTranscript: true });
  let delivered!: () => void;
  const deliveredPromise = new Promise<void>(resolve => { delivered = resolve; });
  const base = createTraceCorrectionTransport(events, async () => { delivered(); });
  let calls = 0;
  const stop = startTraceCorrectionDelivery(memory, {
    ...base,
    append: async (...args) => {
      calls++;
      if (calls === 1) throw new Error('Synthetic temporary failure');
      await base.append(...args);
    },
  });
  try {
    await deliveredPromise;
  } finally {
    await stop();
  }
  expect(calls).toBe(2);
  expect(memory.store.pendingTraceCorrectionDeliveries()).toEqual([]);
  expect(events.getMessages(chat.id).filter(entry => entry.kind === 'memory_trace_correction')).toHaveLength(1);
}, 5000);

test('a crash after append but before acknowledgment does not duplicate the transcript', async () => {
  const { events, chat, memory } = await setup();
  const item = seed(memory, chat.id);
  memory.store.recordTraceCorrection(item.id, { sessionId: chat.id, turn: 1, label: 'operational' }, { enqueueTranscript: true });
  memory.db.exec(`CREATE TRIGGER fail_delivery_ack BEFORE DELETE ON memory_kv
    WHEN OLD.key LIKE 'trace_correction_delivery:%'
    BEGIN SELECT RAISE(FAIL, 'Synthetic acknowledgment failure'); END`);
  const transport = createTraceCorrectionTransport(events, async () => {});
  await expect(flushTraceCorrections(memory, transport)).rejects.toThrow('Synthetic acknowledgment failure');
  const pending = memory.store.pendingTraceCorrectionDeliveries();
  expect(pending).toHaveLength(1);
  expect(memory.store.getKv<boolean>(`trace_correction_delivered:${pending[0]!.seq}`)).toBeNull();
  expect(events.getMessages(chat.id)).toEqual([pending[0]!.entry]);
  memory.db.exec('DROP TRIGGER fail_delivery_ack');
  await flushTraceCorrections(memory, transport);
  expect(memory.store.getKv<boolean>(`trace_correction_delivered:${pending[0]!.seq}`)).toBe(true);
  expect(events.getMessages(chat.id)).toEqual([pending[0]!.entry]);
  expect(memory.store.pendingTraceCorrectionDeliveries()).toEqual([]);
});

test('broadcast failure does not retain a delivery after its durable append', async () => {
  const { events, chat, memory } = await setup();
  const item = seed(memory, chat.id);
  memory.store.recordTraceCorrection(item.id, { sessionId: chat.id, turn: 1, label: 'operational' }, { enqueueTranscript: true });
  const transport = createTraceCorrectionTransport(events, async () => { throw new Error('Synthetic broadcast failure'); });
  await flushTraceCorrections(memory, transport);
  expect(memory.store.pendingTraceCorrectionDeliveries()).toEqual([]);
  expect(events.getMessages(chat.id).filter(entry => entry.kind === 'memory_trace_correction')).toHaveLength(1);
});

test('stop waits for queued delivery after an earlier concurrent flush fails', async () => {
  const { events, chat, memory } = await setup();
  const item = seed(memory, chat.id);
  memory.store.recordTraceCorrection(item.id, { sessionId: chat.id, turn: 1, label: 'operational' }, { enqueueTranscript: true });
  let entered!: () => void;
  let release!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const base = createTraceCorrectionTransport(events, async () => {});
  let calls = 0;
  const transport = {
    ...base,
    append: async (...args: Parameters<typeof base.append>) => {
      calls++;
      if (calls === 1) { entered(); await held; throw new Error('Synthetic first failure'); }
      await base.append(...args);
    },
  };
  const stop = startTraceCorrectionDelivery(memory, transport);
  await enteredPromise;
  const retry = flushTraceCorrections(memory, transport);
  let stopped = false;
  const stopping = stop().then(() => { stopped = true; });
  await Promise.resolve();
  expect(stopped).toBe(false);
  release();
  await retry;
  await stopping;
  expect(stopped).toBe(true);
  expect(calls).toBe(2);
  expect(memory.store.pendingTraceCorrectionDeliveries()).toEqual([]);
  expect(events.getMessages(chat.id).filter(entry => entry.kind === 'memory_trace_correction')).toHaveLength(1);
});
