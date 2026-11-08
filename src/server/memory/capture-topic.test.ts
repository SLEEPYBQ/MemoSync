import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryService } from './index';
import { createCaptureService } from './capture';
let dir: string;
let memory: MemoryService;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'topic-capture-')); memory = new MemoryService({ dbPath: ':memory:', dataDir: dir }); });
afterEach(() => { memory.close(); rmSync(dir, { recursive: true, force: true }); });
const input = { content: 'Synthetic rule about testing', scope: 'personal', type: 'fact' };
it('uses a valid existing topic from the agent without accepting the candidate', async () => {
  const root = memory.store.createTopic('Synthetic');
  const topic = memory.store.createTopic('Tests', root.id);
  let calls = 0;
  const capture = createCaptureService({ memory, callJson: async () => ++calls === 1
    ? { decisions: [{ index: 0, route: 'new' }] }
    : { assignments: [{ index: 0, topicId: topic.id }] } });
  const result = await capture.routeProposal(input, { sessionId: 'test-session', turn: 1 });
  expect(result!.created[0]).toMatchObject({ status: 'candidate', topicId: topic.id, scope: 'personal', version: 1 });
  expect(memory.store.getById(result!.created[0].id)?.topicId).toBe(topic.id);
});
it('keeps candidates unclassified if topic choice fails or references a deleted topic', async () => {
  const topic = memory.store.createTopic('Synthetic');
  let calls = 0;
  const capture = createCaptureService({ memory, callJson: async () => {
    if (++calls === 1) return { decisions: [{ index: 0, route: 'new' }] };
    memory.store.deleteTopic(topic.id, { actor: 'user' });
    return { assignments: [{ index: 0, topicId: topic.id }] };
  } });
  const result = await capture.routeProposal(input, { sessionId: 'test-session', turn: 1 });
  expect(result!.created[0].topicId).toBeUndefined();
  expect(result!.created[0].status).toBe('candidate');
});
it('falls back to unclassified when topic selection fails', async () => {
  memory.store.createTopic('Synthetic');
  let calls = 0;
  const capture = createCaptureService({ memory, callJson: async () => {
    if (++calls === 1) return { decisions: [{ index: 0, route: 'new' }] };
    throw new Error('Synthetic model failure');
  } });
  const result = await capture.routeProposal(input, { sessionId: 's', turn: 2 });
  expect(result!.created[0]).toMatchObject({ status: 'candidate', topicId: undefined });
});
it('does not send sensitive candidates to the extra topic selection pass', async () => {
  memory.store.createTopic('Synthetic');
  let calls = 0;
  const capture = createCaptureService({ memory, callJson: async () => { calls++; return { decisions: [{ index: 0, route: 'new' }] }; } });
  const result = await capture.routeProposal({ ...input, sensitive: true }, { sessionId: 's', turn: 3 });
  expect(calls).toBe(1);
  expect(result!.created[0]).toMatchObject({ sensitive: true, status: 'candidate', topicId: undefined });
});
