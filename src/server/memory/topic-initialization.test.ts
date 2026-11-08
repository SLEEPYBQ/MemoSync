import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryService } from './index';
import { createTopicInitializationService } from './topic-initialization';
let dir: string;
let memory: MemoryService;
const actor = { actor: 'user' as const };
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'topic-init-')); memory = new MemoryService({ dbPath: ':memory:', dataDir: dir }); });
afterEach(() => { memory.close(); rmSync(dir, { recursive: true, force: true }); });
it('previews a synthetic topic tree without mutating memory', async () => {
  const item = memory.store.create({ content: 'Synthetic test rule', scope: 'personal', type: 'fact' }, actor);
  const service = createTopicInitializationService({ memory, callJson: async () => ({ topics: [{ key: 't', name: 'Testing', parentKey: null }], assignments: [{ memoryId: item.id, topicKey: 't' }] }) });
  const preview = await service.preview();
  expect(memory.store.listTopics()).toEqual([]);
  expect(memory.store.getById(item.id)?.topicId).toBeUndefined();
  expect(preview.assignments).toEqual([{ memoryId: item.id, topicKey: 't' }]);
  await service.apply(preview.id);
  expect(memory.store.getById(item.id)?.topicName).toBe('Testing');
  expect(memory.store.getById(item.id)?.status).toBe('active');
});
it('refuses stale previews instead of overwriting edits', async () => {
  const item = memory.store.create({ content: 'Synthetic test rule', scope: 'personal', type: 'fact' }, actor);
  const service = createTopicInitializationService({ memory, callJson: async () => ({ topics: [{ key: 't', name: 'Testing', parentKey: null }], assignments: [{ memoryId: item.id, topicKey: 't' }] }) });
  const preview = await service.preview();
  memory.store.update(item.id, { content: 'Synthetic revised rule' }, actor);
  await expect(service.apply(preview.id)).rejects.toThrow('changed');
  expect(memory.store.listTopics()).toEqual([]);
});

it('reports an unavailable agent without changing the library or exposing provider text', async () => {
  memory.store.create({ content: 'Synthetic rule', scope: 'personal', type: 'fact' }, actor);
  const service = createTopicInitializationService({ memory, callJson: async () => { throw new Error('synthetic private provider text'); } });
  await expect(service.preview()).rejects.toMatchObject({ status: 502, code: 'AGENT_UNAVAILABLE', message: 'Topic initialization agent failed. Check the selected agent and its connection, then retry.' });
  expect(memory.store.listTopics()).toEqual([]);
});

it('exposes the configured initialization model without starting initialization', async () => {
  const { handleMemoryRequest } = await import('./routes');
  const request = new Request('http://localhost/api/memories/topics/initialize/model');
  const response = await handleMemoryRequest(request, new URL(request.url), memory, {
    topicInitializationModel: async () => ({ provider: 'codex', model: 'synthetic-model', available: false }),
  });
  expect(response!.status).toBe(200);
  expect((await response!.json() as any).data).toEqual({ provider: 'codex', model: 'synthetic-model', available: false });
  expect(memory.store.listTopics()).toEqual([]);
});
