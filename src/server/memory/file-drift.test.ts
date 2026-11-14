import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileDrift, extractPaths, gitBlobHash, readProjectSource } from './file-drift';
import { MemoryService } from './index';

let dir: string;
let project: string;
let memory: MemoryService;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'file-drift-'));
  project = join(dir, 'project');
  mkdirSync(project);
  memory = new MemoryService({ dbPath: ':memory:', dataDir: join(dir, 'data') });
});
afterEach(() => { memory.close(); rmSync(dir, { recursive: true, force: true }); });

describe('file drift', () => {
  it('uses the git blob hash', () => {
    expect(gitBlobHash(Buffer.from('test content\n'))).toBe('d670460b4b4aece5915caf5c68d12f560a9fe3e4');
  });

  it('extracts only regular, allowed project files, rejecting missing and symlink escapes', () => {
    mkdirSync(join(project, 'src'));
    mkdirSync(join(project, '.git'));
    mkdirSync(join(project, 'node_modules'));
    writeFileSync(join(project, 'src', 'auth.ts'), 'synthetic');
    writeFileSync(join(project, '.git', 'config'), 'synthetic');
    writeFileSync(join(project, 'node_modules', 'x.js'), 'synthetic');
    writeFileSync(join(dir, 'outside.ts'), 'synthetic');
    symlinkSync(join(dir, 'outside.ts'), join(project, 'escape.ts'));
    const paths = extractPaths('`src/auth.ts`, "src/auth.ts" missing.ts ../outside.ts escape.ts .git/config node_modules/x.js', project);
    expect(paths).toEqual(['src/auth.ts']);
    expect(readProjectSource(project, '../outside.ts')).toBeNull();
    expect(readProjectSource(project, 'escape.ts')).toBeNull();
  });

  it('limits extraction to eight files and ignores files over one megabyte', () => {
    for (let index = 0; index < 10; index++) writeFileSync(join(project, `file${index}.ts`), 'synthetic');
    writeFileSync(join(project, 'large.ts'), Buffer.alloc(1024 * 1024 + 1));
    const paths = extractPaths(`large.ts ${Array.from({ length: 10 }, (_, index) => `file${index}.ts`).join(' ')}`, project);
    expect(paths).toHaveLength(8);
    expect(paths).not.toContain('large.ts');
  });

  it('tracks changes, restoration and missing files independently, and re-extracts on edit', () => {
    const file = join(project, 'auth.ts');
    writeFileSync(file, 'baseline');
    const a = memory.store.create({ content: 'Use auth.ts', scope: 'project', projectId: 'P1', type: 'fact' }, { actor: 'user' });
    const b = memory.store.create({ content: 'Review auth.ts', scope: 'project', projectId: 'P1', type: 'fact' }, { actor: 'user' });
    const personal = memory.store.create({ content: 'Use auth.ts', scope: 'personal', type: 'fact' }, { actor: 'user' });
    const session = memory.store.create({ content: 'Use auth.ts', scope: 'session', sessionId: 'S1', type: 'fact' }, { actor: 'user' });
    const sync = () => memory.fileDrift.syncProject('P1', project);
    sync();
    expect(memory.fileDrift.refsFor([a.id, b.id, personal.id]).get(a.id)).toEqual([{ path: 'auth.ts', kind: 'mention', drift: null }]);
    expect(memory.fileDrift.refsFor([personal.id]).size).toBe(0);
    expect(memory.fileDrift.refsFor([session.id]).size).toBe(0);
    writeFileSync(file, 'changed contents');
    sync();
    expect(memory.fileDrift.refsFor([a.id]).get(a.id)?.[0]?.drift).toBe('changed');
    expect(memory.fileDrift.driftSignature(a.id)).not.toBe('');
    memory.fileDrift.acknowledge(a.id, { actor: 'user' });
    expect(memory.fileDrift.refsFor([a.id]).get(a.id)?.[0]?.drift).toBeNull();
    expect(memory.fileDrift.refsFor([b.id]).get(b.id)?.[0]?.drift).toBe('changed');
    expect(memory.store.getEvents(a.id).at(-1)).toMatchObject({ kind: 'file_check', actor: 'user', meta: { paths: ['auth.ts'] } });
    writeFileSync(file, 'baseline');
    sync();
    expect(memory.fileDrift.refsFor([b.id]).get(b.id)?.[0]?.drift).toBeNull();
    rmSync(file);
    sync();
    expect(memory.fileDrift.refsFor([a.id]).get(a.id)?.[0]?.drift).toBe('missing');
    memory.fileDrift.acknowledge(a.id, { actor: 'user' });
    expect(memory.fileDrift.refsFor([a.id]).size).toBe(0);
    writeFileSync(file, 'baseline');
    sync();
    expect(memory.fileDrift.refsFor([b.id]).get(b.id)?.[0]?.drift).toBeNull();
    writeFileSync(file, 'restored baseline and more');
    sync();
    expect(memory.fileDrift.refsFor([b.id]).get(b.id)?.[0]?.drift).toBe('changed');
    memory.store.update(b.id, { content: 'Revised auth.ts rule' }, { actor: 'user' });
    sync();
    expect(memory.fileDrift.refsFor([b.id]).get(b.id)?.[0]?.drift).toBeNull();
  });

  it('tracks a source bullet rather than unrelated source changes and keeps it across edits', () => {
    const file = join(project, 'AGENTS.md');
    writeFileSync(file, '- [x] Synthetic rule\n- Another rule\n');
    const item = memory.store.create({ content: 'Synthetic rule', scope: 'project', projectId: 'P1', type: 'fact' }, { actor: 'user' });
    memory.fileDrift.addSource(item.id, readProjectSource(project, 'AGENTS.md')!);
    memory.store.update(item.id, { detail: 'Edited synthetic detail' }, { actor: 'user' });
    writeFileSync(file, '- [new] Synthetic   rule\n- Different unrelated rule\n');
    memory.fileDrift.syncProject('P1', project);
    expect(memory.fileDrift.refsFor([item.id]).get(item.id)).toEqual([{ path: 'AGENTS.md', kind: 'source', drift: null }]);
    writeFileSync(file, '- Different unrelated rule\n');
    memory.fileDrift.syncProject('P1', project);
    expect(memory.fileDrift.refsFor([item.id]).get(item.id)?.[0]?.drift).toBe('line_removed');
    rmSync(file);
    memory.fileDrift.syncProject('P1', project);
    expect(memory.fileDrift.refsFor([item.id]).get(item.id)?.[0]?.drift).toBe('line_removed');
    memory.fileDrift.acknowledge(item.id, { actor: 'user' });
    expect(memory.fileDrift.refsFor([item.id]).size).toBe(0);
    expect(memory.store.getById(item.id)?.status).toBe('active');
  });

  it('returns file mtime only for changed references', () => {
    for (const name of ['auth.ts', 'missing.ts', 'stable.ts']) writeFileSync(join(project, name), 'synthetic baseline');
    const content = 'Check auth.ts missing.ts stable.ts';
    const item = memory.store.create({ content, scope: 'project', projectId: 'P1', type: 'fact' }, { actor: 'user' });
    const sourceFile = join(project, 'AGENTS.md');
    writeFileSync(sourceFile, `- ${content}\n`);
    memory.fileDrift.addSource(item.id, readProjectSource(project, 'AGENTS.md')!);
    memory.fileDrift.syncProject('P1', project);

    const changedFile = join(project, 'auth.ts');
    writeFileSync(changedFile, 'synthetic changed contents');
    const modified = new Date('2024-04-03T12:30:00.000Z');
    utimesSync(changedFile, modified, modified);
    rmSync(join(project, 'missing.ts'));
    writeFileSync(sourceFile, '- A different synthetic rule\n');
    memory.fileDrift.syncProject('P1', project);

    expect(memory.fileDrift.refsFor([item.id]).get(item.id)).toEqual([
      { path: 'AGENTS.md', kind: 'source', drift: 'line_removed' },
      { path: 'auth.ts', kind: 'mention', drift: 'changed', changedAt: statSync(changedFile).mtime.toISOString() },
      { path: 'missing.ts', kind: 'mention', drift: 'missing' },
      { path: 'stable.ts', kind: 'mention', drift: null },
    ]);
  });

  it('does not hash unchanged stat hints and removes refs on hard deletion', () => {
    writeFileSync(join(project, 'auth.ts'), 'synthetic');
    const item = memory.store.create({ content: 'Use auth.ts', scope: 'project', projectId: 'P1', type: 'fact', status: 'candidate' }, { actor: 'user' });
    let hashes = 0;
    const drift = new FileDrift(memory.db, memory.store, bytes => { hashes++; return gitBlobHash(bytes); });
    drift.syncProject('P1', project);
    expect(hashes).toBe(1);
    drift.syncProject('P1', project);
    expect(hashes).toBe(1);
    memory.store.eraseCandidate(item.id);
    expect(drift.refsFor([item.id]).size).toBe(0);
  });

  it('re-extracts candidate mention refs when a draft changes without a version bump', () => {
    writeFileSync(join(project, 'old.ts'), 'synthetic old');
    writeFileSync(join(project, 'new.ts'), 'synthetic new');
    const item = memory.store.create({ content: 'Use old.ts', scope: 'project', projectId: 'P1', type: 'fact', status: 'candidate' }, { actor: 'user' });
    memory.fileDrift.syncProject('P1', project);
    writeFileSync(join(project, 'old.ts'), 'synthetic changed old');
    memory.fileDrift.syncProject('P1', project);
    const revised = memory.store.replaceCandidateDraft(item.id, { content: 'Use new.ts' }, { actor: 'user' });
    expect(revised.version).toBe(item.version);
    memory.fileDrift.syncProject('P1', project);
    expect(memory.fileDrift.refsFor([item.id]).get(item.id)).toEqual([{ path: 'new.ts', kind: 'mention', drift: null }]);
    const detailed = memory.store.replaceCandidateDraft(item.id, { detail: 'See old.ts' }, { actor: 'user' });
    expect(detailed.version).toBe(item.version);
    memory.fileDrift.syncProject('P1', project);
    expect(memory.fileDrift.refsFor([item.id]).get(item.id)?.map(ref => ref.path)).toEqual(['new.ts', 'old.ts']);
  });

  it('preserves file drift and confirmation signature across topic and expiry changes', () => {
    const file = join(project, 'auth.ts');
    writeFileSync(file, 'baseline');
    const item = memory.store.create({ content: 'Use auth.ts', scope: 'project', projectId: 'P1', type: 'fact' }, { actor: 'user' });
    memory.fileDrift.syncProject('P1', project);
    writeFileSync(file, 'changed synthetic file');
    memory.fileDrift.syncProject('P1', project);
    const signature = memory.fileDrift.driftSignature(item.id);
    expect(signature).not.toBe('');
    memory.store.update(item.id, { topic: 'Testing', expiresAt: '2099-01-01T00:00:00.000Z' }, { actor: 'user' });
    memory.fileDrift.syncProject('P1', project);
    expect(memory.fileDrift.refsFor([item.id]).get(item.id)?.[0]?.drift).toBe('changed');
    expect(memory.fileDrift.driftSignature(item.id)).toBe(signature);
  });

  it('clears source and mention refs when a candidate moves to personal or another project', () => {
    writeFileSync(join(project, 'AGENTS.md'), '- Use auth.ts\n');
    writeFileSync(join(project, 'auth.ts'), 'first project');
    const other = join(dir, 'other-project');
    mkdirSync(other);
    writeFileSync(join(other, 'auth.ts'), 'second project');
    writeFileSync(join(other, 'AGENTS.md'), '- Different synthetic rule\n');
    const source = readProjectSource(project, 'AGENTS.md')!;
    const create = () => {
      const item = memory.store.create({ content: 'Use auth.ts', scope: 'project', projectId: 'P1', type: 'fact', status: 'candidate' }, { actor: 'user' });
      memory.fileDrift.addSource(item.id, source);
      memory.fileDrift.syncProject('P1', project);
      return item;
    };
    const personal = create();
    memory.store.replaceCandidateDraft(personal.id, { scope: 'personal' }, { actor: 'user' });
    expect(memory.fileDrift.refsFor([personal.id]).size).toBe(0);
    const moved = create();
    memory.store.replaceCandidateDraft(moved.id, { projectId: 'P2' }, { actor: 'user' });
    expect(memory.fileDrift.refsFor([moved.id]).size).toBe(0);
    memory.fileDrift.syncProject('P2', other);
    expect(memory.fileDrift.refsFor([moved.id]).get(moved.id)).toEqual([{ path: 'auth.ts', kind: 'mention', drift: null }]);
  });
});
