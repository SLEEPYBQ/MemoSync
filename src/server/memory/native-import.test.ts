import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { NativeImportOperation, NativeMemoryRoot, NativeMemorySource } from '../../shared/native-memory';
import { MemoryService } from './index';
import { NativeMemoryDiscovery, nativeHash, NATIVE_DISCOVERY_LIMITS } from './native-discovery';
import { createNativeSemanticExtractor, NativeMemoryImportService, type NativeSemanticExtractor } from './native-import';
import { handleMemoryRequest } from './routes';

// No HOME mutation, engine invocation, model, network or global config access.
// Every home/root/data path passed to the service is inside this temp fixture.
let dir: string, home: string, project: string, nativeFile: string;
let memory: MemoryService, service: NativeMemoryImportService;
let roots: NativeMemoryRoot[];
function put(path: string, text: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
function setup(extractor?: NativeSemanticExtractor, isClaimSuppressed?: ConstructorParameters<typeof NativeMemoryImportService>[0]['isClaimSuppressed']) {
  service = new NativeMemoryImportService({ memory, discovery: new NativeMemoryDiscovery(home, () => roots), semanticExtractor: extractor, isClaimSuppressed });
}
function source(): NativeMemorySource {
  return service.discover(['project:p1']).sources.find(source => source.kind === 'native-memory')!;
}
async function plan(id: string, selected = source(), extra: Record<string, unknown> = {}) {
  return service.dryRun({ operationId: id, sourceId: selected.sourceId, sourceHash: selected.sourceHash, ...extra });
}
function accept(operation: NativeImportOperation, keys = operation.plan.items.map(item => item.itemKey)) {
  return service.commit(operation.plan.operationId, { approved: true, approvedItemKeys: keys });
}
async function request(method: string, path: string, body?: unknown) {
  const req = new Request(`http://localhost${path}`, { method, ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  return (await handleMemoryRequest(req, new URL(req.url), memory, { nativeMemory: service }))!;
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'memosync-native-')));
  home = join(dir, 'fake-home'); project = join(dir, 'Project');
  mkdirSync(home); mkdirSync(project);
  nativeFile = join(home, '.claude', 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'), 'memory', 'MEMORY.md');
  put(nativeFile, '- Use /Src/Parser.ts for parsing.\n- Run bun test before release.\n');
  roots = [{ id: 'personal', label: 'Personal', path: home, owner: { scope: 'personal' } }, { id: 'project:p1', label: 'Project', path: project, owner: { scope: 'project', projectId: 'p1' } }];
  memory = new MemoryService({ dbPath: join(dir, 'memory.sqlite'), dataDir: join(dir, 'managed') });
  setup();
});
afterEach(() => { memory.close(); rmSync(dir, { recursive: true, force: true }); });

describe('bounded read-only discovery', () => {
  it('probes only explicit selected locations and classifies rules/skills separately', () => {
    put(join(home, '.claude', 'credentials.json'), '{"token":"do not read"}');
    put(join(home, '.codex', 'auth.json'), '{"token":"do not read"}');
    put(join(home, 'Documents', 'memory.md'), '- Never discover this');
    put(join(home, '.claude', 'projects', 'unselected', 'memory', 'MEMORY.md'), '- Never discover another project');
    put(join(project, 'CLAUDE.md'), '- Project policy');
    put(join(project, '.claude', 'skills', 'deploy', 'SKILL.md'), '# Deployment\n- Build');
    put(join(home, '.codex', 'memories', 'MEMORY.md'), '- Global native memory');
    const found = service.discover(['project:p1']);
    expect(found.sources.map(source => source.kind).sort()).toEqual(['native-memory', 'project-rule', 'skill']);
    expect(found.sources.every(source => source.owner.scope === 'project' && source.owner.projectId === 'p1')).toBe(true);
    expect(service.discovery.allowedRoots().find(root => root.id === 'project:p1')!.locations).toContain(dirname(nativeFile));
    expect(JSON.stringify(found)).not.toContain('Global native memory');
    expect(JSON.stringify(found)).not.toContain('do not read');
    expect(JSON.stringify(found)).not.toContain('Use /Src');
    const personal = service.discover(['personal']);
    expect(personal.sources.map(source => source.engine)).toEqual(['codex']);
    expect(() => service.discover([join(home, '.codex', 'auth.json')])).toThrow('Unknown allowed root');
    expect(() => service.discover([])).toThrow();
    expect(readFileSync(nativeFile, 'utf8')).toContain('/Src/Parser.ts');
  });

  it('refuses linked, oversized and nested files and bounds directory entries', () => {
    const folder = dirname(nativeFile);
    put(join(dir, 'outside.md'), '- Outside secret');
    symlinkSync(join(dir, 'outside.md'), join(folder, 'link.md'));
    linkSync(join(dir, 'outside.md'), join(folder, 'hardlink.md'));
    put(join(folder, 'large.md'), 'x'.repeat(NATIVE_DISCOVERY_LIMITS.fileBytes + 1));
    put(join(folder, 'nested', 'hidden.md'), '- Not a direct memory file');
    const found = service.discover(['project:p1']);
    expect(found.sources).toHaveLength(1);
    expect(found.skipped).toBeGreaterThan(0);
    for (let index = 0; index < 260; index++) put(join(folder, `noise-${index}.txt`), 'noise');
    expect(service.discover(['project:p1']).truncated).toBe(true);
  });

  it('rechecks current allowlist, links and roots before importing', async () => {
    const manifest = source();
    rmSync(nativeFile); put(join(dir, 'replacement.md'), '- Arbitrary file'); symlinkSync(join(dir, 'replacement.md'), nativeFile);
    await expect(plan('linked', manifest)).rejects.toMatchObject({ status: 409, code: 'SOURCE_UNAVAILABLE' });
    roots = roots.filter(root => root.id !== 'project:p1');
    await expect(plan('removed-root', manifest)).rejects.toThrow('no longer allowed');
  });

  it('reports source versions and never treats rules or skills as chat memory', async () => {
    put(join(project, 'AGENTS.md'), '- Independent project instruction');
    const rule = service.discover(['project:p1']).sources.find(source => source.kind === 'project-rule')!;
    const blocked = await plan('rule', rule);
    expect(blocked.plan.blockedReason).toBe('independent-asset');
    expect(blocked.plan.items).toEqual([]);
    const before = source();
    put(nativeFile, '- Changed native memory');
    const after = source();
    expect(after.sourceId).toBe(before.sourceId);
    expect(after.sourceVersion).toBe(before.sourceVersion + 1);
    expect(after.sourceHash).not.toBe(before.sourceHash);
  });
});

describe('screening and extraction', () => {
  it('quarantines whole sensitive sources without retaining values or sending them to an extractor', async () => {
    let called = 0; setup(async () => { called++; return []; });
    const secret = 'sk-testSensitiveKey01234567890123456789';
    put(nativeFile, `- Safe rule\n- api_key = ${secret}\n`);
    const manifest = source();
    expect(manifest.screening).toBe('blocked-sensitive');
    const operation = await plan('secret', manifest, { extraction: 'semantic', allowSemanticExtraction: true });
    expect(called).toBe(0);
    expect(operation.plan.blockedReason).toBe('sensitive-source');
    expect(operation.plan.items).toEqual([]);
    expect(JSON.stringify(operation)).not.toContain(secret);
    expect(JSON.stringify(memory.db.query('SELECT * FROM native_memory_operations').all())).not.toContain(secret);
    expect(memory.store.list()).toEqual([]);
    put(nativeFile, '- Contact person@example.invalid');
    expect(source().screening).toBe('blocked-sensitive');
  });

  it('requires explicit semantic permission and exact quotes; model output grants no authority', async () => {
    let calls = 0;
    setup(createNativeSemanticExtractor(async () => { calls++; return { items: [{ content: 'Use /Src/Parser.ts.', quote: '- Use /Src/Parser.ts for parsing.', startLine: 1, endLine: 1 }] }; }));
    const manifest = source();
    await expect(plan('no-permission', manifest, { extraction: 'semantic' })).rejects.toThrow('explicit permission');
    expect(calls).toBe(0);
    const operation = await plan('semantic', manifest, { extraction: 'semantic', allowSemanticExtraction: true });
    expect(calls).toBe(1); expect(operation.plan.items).toHaveLength(1);
    expect(memory.store.list()).toEqual([]);
    setup(async () => [{ content: 'Invented fact', quote: 'not in source', startLine: 1, endLine: 1 }]);
    await expect(plan('bad-quote', manifest, { extraction: 'semantic', allowSemanticExtraction: true })).rejects.toThrow('exact quoted');
    setup(async () => [{ content: 'token = synthetic-secret', quote: '- Use /Src/Parser.ts for parsing.', startLine: 1, endLine: 1 }]);
    await expect(plan('bad-content', manifest, { extraction: 'semantic', allowSemanticExtraction: true })).rejects.toThrow('non-sensitive');
  });
});

describe('durable reviewed import and CAS', () => {
  it('requires approval, preserves provenance and original files, retries unchanged imports across restart', async () => {
    const original = readFileSync(nativeFile, 'utf8');
    const first = await plan('first');
    expect(memory.store.list()).toEqual([]);
    expect(first.plan.items[0]!.provenance.quote).toBe('- Use /Src/Parser.ts for parsing.');
    expect(first.plan.items[0]!.owner).toEqual({ scope: 'project', projectId: 'p1' });
    expect(() => service.commit('first', { approved: false, approvedItemKeys: [] } as never)).toThrow('approval');
    const receipt = accept(first);
    expect(receipt.accepted).toHaveLength(2);
    expect(memory.store.list().every(item => item.status === 'active' && item.evidenceClass === 'agent_proposed')).toBe(true);
    expect(readFileSync(nativeFile, 'utf8')).toBe(original);
    memory.close();
    memory = new MemoryService({ dbPath: join(dir, 'memory.sqlite'), dataDir: join(dir, 'managed') }); setup();
    expect(accept(first)).toEqual(receipt);
    expect(await plan('first')).toEqual(service.getOperation('first')!);
    const second = await plan('second');
    expect(second.plan.items.map(item => item.itemKey)).toEqual(first.plan.items.map(item => item.itemKey));
    expect(second.plan.items.every(item => item.disposition === 'unchanged')).toBe(true);
    expect(accept(second).accepted.every(item => !item.created)).toBe(true);
    expect(memory.store.list()).toHaveLength(2);
    expect(() => service.commit('first', { approved: true, approvedItemKeys: [] })).toThrow('different committed decisions');
  });

  it('rejects source changes and stale target content, lifecycle and scope atomically', async () => {
    const existing = memory.store.create({ content: 'Use /Src/Parser.ts for parsing.', scope: 'project', projectId: 'p1', type: 'fact' }, { actor: 'user' });
    const before = await plan('target');
    expect(before.plan.items[0]!.disposition).toBe('exact-match');
    memory.store.archive(existing.id, { actor: 'user' });
    expect(() => accept(before)).toThrow('rejected or revoked');
    expect(memory.store.list()).toHaveLength(1);
    memory.store.update(existing.id, { status: 'active', scope: 'personal' }, { actor: 'user' });
    expect(() => accept(before)).toThrow('scope');
    const changed = await plan('source-cas');
    put(nativeFile, '- Source edited after dry-run');
    expect(() => accept(changed)).toThrow('Source content changed');
    expect(memory.store.list()).toHaveLength(1);
  });

  it('rechecks source content after an awaited semantic extractor and creates no stale plan', async () => {
    setup(async () => {
      put(nativeFile, '- Source changed while extraction was running');
      return [{ content: 'Use /Src/Parser.ts for parsing.', quote: '- Use /Src/Parser.ts for parsing.', startLine: 1, endLine: 1 }];
    });
    await expect(plan('await-cas', source(), { extraction: 'semantic', allowSemanticExtraction: true })).rejects.toThrow('Source content changed');
    expect(service.getOperation('await-cas')).toBeNull();
    expect(memory.store.list()).toEqual([]);
  });

  it('serializes same-operation dry-run and detects a concurrent newly committed exact match', async () => {
    const manifest = source();
    const [first, retried] = await Promise.all([plan('concurrent', manifest), plan('concurrent', manifest)]);
    expect(retried).toEqual(first);
    const competing = await plan('competing', manifest);
    accept(first);
    expect(() => accept(competing)).toThrow('appeared after the dry-run');
    expect(memory.store.list()).toHaveLength(2);
  });

  it('rolls back all writes and the receipt when a mapping write fails', async () => {
    const operation = await plan('atomic');
    memory.db.exec("CREATE TRIGGER fail_native_mapping BEFORE INSERT ON native_memory_mappings BEGIN SELECT RAISE(ABORT, 'test mapping failure'); END;");
    expect(() => accept(operation)).toThrow('test mapping failure');
    expect(memory.store.list()).toEqual([]);
    expect(service.getOperation('atomic')!.receipt).toBeUndefined();
    memory.db.exec('DROP TRIGGER fail_native_mapping');
    expect(accept(operation).accepted).toHaveLength(2);
  });

  it('deduplicates only exact content in its complete owner and preserves path/code case', async () => {
    memory.store.create({ content: 'Use /Src/Parser.ts for parsing.', scope: 'personal', type: 'fact' }, { actor: 'user' });
    memory.store.create({ content: 'Use /Src/Parser.ts for parsing.', scope: 'project', projectId: 'other', type: 'fact' }, { actor: 'user' });
    memory.store.create({ content: 'Use /src/parser.ts for parsing.', scope: 'project', projectId: 'p1', type: 'fact' }, { actor: 'user' });
    const operation = await plan('case');
    expect(operation.plan.items[0]!.disposition).toBe('new');
    accept(operation);
    expect(memory.store.list()).toHaveLength(5);
    expect(memory.store.list().some(item => item.content.includes('/Src/Parser.ts') && item.projectId === 'p1')).toBe(true);
  });

  it('keeps item lineage when only line positions move and blocks repeated/split/rewritten identity', async () => {
    const first = await plan('lineage'); accept(first);
    put(nativeFile, '# Moved heading\n\n- Use /Src/Parser.ts for parsing.\n\n- Run bun test before release.\n');
    const moved = await plan('moved');
    expect(moved.plan.items.map(item => item.itemKey)).toEqual(first.plan.items.map(item => item.itemKey));
    expect(moved.plan.items.every(item => item.disposition === 'unchanged')).toBe(true);
    put(nativeFile, '- Use /Src/Parser.ts for parsing.\n- Use /Src/Parser.ts for parsing.\n- Run bun test before release.\n');
    const repeated = await plan('repeated');
    expect(repeated.plan.items.slice(0, 2).every(item => item.disposition === 'conflict')).toBe(true);
    expect(new Set(repeated.plan.items.map(item => item.itemKey)).size).toBe(3);
    put(nativeFile, '- Parse with /Src/NewParser.ts.\n- Run bun test before release.\n');
    const rewritten = await plan('rewrite');
    expect(rewritten.plan.items[0]!.disposition).toBe('conflict');
    expect(() => accept(rewritten)).toThrow('conflicting');
    const retry = await plan('rewrite-again');
    expect(retry.plan.items[0]!.disposition).toBe('conflict');
  });

  it('retains removed lineage so observing an empty file cannot reset rewritten identity', async () => {
    const first = await plan('remove-first'); accept(first);
    put(nativeFile, ''); await plan('empty');
    put(nativeFile, '- Rewritten memory after removal');
    const rewritten = await plan('after-empty');
    expect(rewritten.plan.items[0]!.disposition).toBe('conflict');
  });

  it('marks multiple semantic claims from the same quote as split identity conflicts', async () => {
    setup(async () => [
      { content: 'Use the parser.', quote: '- Use /Src/Parser.ts for parsing.', startLine: 1, endLine: 1 },
      { content: 'Parser lives in /Src.', quote: '- Use /Src/Parser.ts for parsing.', startLine: 1, endLine: 1 },
    ]);
    const split = await plan('split', source(), { extraction: 'semantic', allowSemanticExtraction: true });
    expect(split.plan.items.every(item => item.disposition === 'conflict')).toBe(true);
    expect(() => accept(split)).toThrow('conflicting');
  });

  it('persists exact scoped rejection and revocation tombstones across source versions', async () => {
    const first = await plan('reject');
    service.commit('reject', { approved: true, approvedItemKeys: [], rejectedItemKeys: first.plan.items.map(item => item.itemKey) });
    put(nativeFile, '# New heading\n- Use /Src/Parser.ts for parsing.\n- Run bun test before release.\n');
    const rejected = await plan('rejected-retry');
    expect(rejected.plan.items.every(item => item.disposition === 'suppressed')).toBe(true);
    expect(() => accept(rejected)).toThrow('suppressed');
    // Same exact claim in a different owner is independent.
    put(join(home, '.codex', 'memories', 'MEMORY.md'), '- Use /Src/Parser.ts for parsing.');
    const personal = service.discover(['personal']).sources[0]!;
    expect((await plan('different-owner', personal)).plan.items[0]!.disposition).toBe('new');
  });

  it('rechecks shared tombstone authority after the dry-run', async () => {
    let rejected = false;
    setup(undefined, (_content, owner) => rejected && owner.scope === 'project' && owner.projectId === 'p1');
    const operation = await plan('shared-tombstone');
    rejected = true;
    expect(() => accept(operation)).toThrow('rejected or revoked');
    expect(memory.store.list()).toEqual([]);
  });
});

describe('operation-owned rollback', () => {
  it('archives untouched derived memories and remains idempotent after restart', async () => {
    const first = await plan('rollback'); const receipt = accept(first);
    const rolled = service.rollback('rollback', true);
    expect(rolled.archived.sort()).toEqual(receipt.accepted.map(item => item.memoryId).sort());
    expect(rolled.conflicts).toEqual([]);
    memory.close(); memory = new MemoryService({ dbPath: join(dir, 'memory.sqlite'), dataDir: join(dir, 'managed') }); setup();
    expect(service.rollback('rollback', true)).toEqual(rolled);
    expect(accept(first)).toEqual(receipt);
    expect(memory.store.list({ status: 'active' })).toEqual([]);
    expect((await plan('revoked-retry')).plan.items.every(item => item.disposition === 'suppressed')).toBe(true);
  });

  it('reports independent edits and never archives preexisting exact matches', async () => {
    const existing = memory.store.create({ content: 'Use /Src/Parser.ts for parsing.', scope: 'project', projectId: 'p1', type: 'fact' }, { actor: 'user' });
    const first = await plan('mixed'); const receipt = accept(first);
    const derivedId = receipt.accepted.find(item => item.created)!.memoryId;
    memory.store.update(derivedId, { content: 'An independently edited rule.' }, { actor: 'user' });
    const result = service.rollback('mixed', true);
    expect(result.archived).toEqual([]);
    expect(result.conflicts.map(item => item.memoryId)).toEqual([derivedId]);
    expect(memory.store.getById(existing.id)!.status).toBe('active');
    expect(memory.store.getById(derivedId)!.content).toBe('An independently edited rule.');
  });

  it('does not roll back memories or mappings owned by an earlier unchanged import', async () => {
    const first = await plan('owner'); accept(first);
    const second = await plan('observer'); accept(second);
    expect(service.rollback('observer', true)).toEqual({ operationId: 'observer', state: 'rolled-back', archived: [], conflicts: [] });
    expect(memory.store.list({ status: 'active' })).toHaveLength(2);
    expect(service.rollback('owner', true).archived).toHaveLength(2);
  });
});

describe('real memory API routes', () => {
  it('exposes roots, manifest, dry-run, approved commit, persisted operation and rollback', async () => {
    const available = await (await request('GET', '/api/memories/sources')).json();
    expect(available.data.roots.map((root: NativeMemoryRoot) => root.id)).toEqual(['personal', 'project:p1']);
    const found = await (await request('POST', '/api/memories/sources/discover', { rootIds: ['project:p1'] })).json();
    const manifest = found.data.sources[0];
    const draft = await (await request('POST', '/api/memories/imports/dry-run', { operationId: 'route-test', sourceId: manifest.sourceId, sourceHash: manifest.sourceHash })).json();
    expect(draft.data.plan.state).toBe('proposed');
    expect(memory.store.list()).toHaveLength(0);
    const approval = { approved: true, approvedItemKeys: draft.data.plan.items.map((item: { itemKey: string }) => item.itemKey) };
    expect((await request('POST', '/api/memories/imports/route-test/commit', { ...approval, approved: false })).status).toBe(400);
    const committed = await (await request('POST', '/api/memories/imports/route-test/commit', approval)).json();
    expect(committed.data.accepted).toHaveLength(2);
    expect(await (await request('POST', '/api/memories/imports/route-test/commit', approval)).json()).toEqual(committed);
    expect((await (await request('GET', '/api/memories/imports/route-test')).json()).data.receipt).toEqual(committed.data);
    expect((await (await request('POST', '/api/memories/imports/route-test/rollback', { approved: true })).json()).data.archived).toHaveLength(2);
  });

  it('returns bounded errors for arbitrary roots, invalid bodies, stale sources and method mismatches', async () => {
    expect((await request('POST', '/api/memories/sources/discover', { rootIds: [join(home, '.codex', 'auth.json')] })).status).toBe(400);
    expect((await request('POST', '/api/memories/imports/dry-run', { path: nativeFile })).status).toBe(400);
    expect((await request('POST', '/api/memories/imports/dry-run', { operationId: 'too-large', sourceId: 'x'.repeat(40000) })).status).toBe(413);
    expect((await request('GET', '/api/memories/sources/discover')).status).toBe(405);
    expect((await request('GET', '/api/memories/imports/missing')).status).toBe(404);
    const draft = await plan('stale-route'); put(nativeFile, '- Changed');
    const response = await request('POST', '/api/memories/imports/stale-route/commit', { approved: true, approvedItemKeys: draft.plan.items.map(item => item.itemKey) });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('IMPORT_CONFLICT');
    expect(nativeHash('Path.ts')).not.toBe(nativeHash('path.ts'));
  });
});
