import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryService } from './index';
import { handleMemoryRequest } from './routes';
let memory: MemoryService;
let dir: string;
const actor = { actor: 'user' as const };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'topic-routes-'));
  memory = new MemoryService({ dbPath: ':memory:', dataDir: dir });
});
afterEach(() => { memory.close(); rmSync(dir, { recursive: true, force: true }); });
async function call(method: string, path: string, body?: unknown) {
  const req = new Request(`http://localhost/api/memories${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  const res = (await handleMemoryRequest(req, new URL(req.url), memory))!;
  return { status: res.status, ...await res.json() as any };
}
it('creates once under concurrent requests, renames, lists and deletes empty topics', async () => {
  const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => call('POST', '/topics', { name: i % 2 ? ' TEST ' : 'test' })));
  expect(responses.every(r => r.status === 200)).toBe(true);
  expect(new Set(responses.map(r => r.data.id)).size).toBe(1);
  const id = responses[0].data.id;
  expect((await call('PATCH', `/topics/${id}`, { name: 'Renamed' })).data.name).toBe('Renamed');
  expect((await call('GET', '/topics')).data).toHaveLength(1);
  expect((await call('DELETE', `/topics/${id}`)).data.count).toBe(0);
  expect((await call('GET', '/topics')).data).toEqual([]);
});
it('reports partial failure and retries the same topic without accepting candidates', async () => {
  const pending = memory.store.create({ content: 'Synthetic pending', scope: 'project', projectId: 'test-project', type: 'fact', status: 'candidate', sensitive: true }, actor);
  const rejected = memory.store.create({ content: 'Synthetic rejected', scope: 'personal', type: 'fact', status: 'candidate' }, actor);
  memory.store.dismissCandidate(rejected.id, actor);
  const r = await call('POST', '/topics/assign', { ids: [pending.id, rejected.id, 'missing'], name: 'Testing' });
  expect(r.status).toBe(200);
  expect(r.data.results.map((x: any) => x.status)).toEqual(['success', 'failed', 'failed']);
  expect(memory.store.getById(pending.id)).toMatchObject({ status: 'candidate', sensitive: true, version: 1, topicId: r.data.topicId });
  const before = memory.store.getEvents(pending.id);
  const retry = await call('POST', '/topics/assign', { ids: [pending.id, rejected.id], topicId: r.data.topicId });
  expect(retry.data.results.map((x: any) => x.status)).toEqual(['success', 'failed']);
  expect(memory.store.getEvents(pending.id)).toEqual(before);
  expect((await call('GET', `/topics`)).data).toHaveLength(1);
  expect((await call('GET', `?topicId=${r.data.topicId}&scope=project&projectId=test-project&status=candidate`)).data.map((x: any) => x.id)).toEqual([pending.id]);
  expect((await call('GET', '?topicId=unclassified')).data.map((x: any) => x.id)).toContain(rejected.id);
  expect((await call('POST', '/topics/assign', { ids: [pending.id], topicId: null })).data.results[0].status).toBe('success');
});
it('validates topic requests before creating a topic or modifying anything', async () => {
  for (const body of [{ name: '' }, { name: '   ' }, { name: 42 }, {}]) {
    expect((await call('POST', '/topics', body)).status).toBe(400);
  }
  for (const body of [{ ids: [], name: 'No' }, { ids: ['a'], topicId: 42 }, { ids: ['a'], name: 'No', topicId: null }, { ids: [2], name: 'No' }, { ids: Array(501).fill('a'), name: 'No' }, { ids: ['a'] }]) {
    expect((await call('POST', '/topics/assign', body)).status).toBe(400);
  }
  expect((await call('GET', '/topics')).data).toEqual([]);
  expect((await call('POST', '/topics/assign', { ids: ['a'], topicId: 'deleted' })).status).toBe(404);
});
it('creates and moves child topics without allowing cycles', async () => {
  const root = (await call('POST', '/topics', { name: 'Root' })).data;
  const child = (await call('POST', '/topics', { name: 'Child', parentId: root.id })).data;
  expect(child.parentId).toBe(root.id);
  expect((await call('PATCH', `/topics/${root.id}`, { parentId: child.id })).status).toBe(409);
  expect((await call('DELETE', `/topics/${root.id}`)).status).toBe(409);
  expect((await call('PATCH', `/topics/${child.id}`, { parentId: null })).data.parentId).toBeNull();
});
