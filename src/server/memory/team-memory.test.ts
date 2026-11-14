import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryService } from './index';
import { parseTeamFile, serializeRule } from './team-memory';
import { getMemoryConfirmation, memoryConfirmationReasons, recordMemoryConfirmation } from './confirmation';

let dir: string, project: string, file: string, memory: MemoryService;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'team-memory-'));
  project = join(dir, 'project');
  mkdirSync(join(project, '.memosync'), { recursive: true });
  file = join(project, '.memosync', 'team.md');
  memory = new MemoryService({ dbPath: ':memory:', dataDir: join(dir, 'data') });
});
afterEach(() => { memory.close(); rmSync(dir, { recursive: true, force: true }); });

test('parse and serialize topics, dates, duplicates and conflicts', () => {
  const until = new Date(2030, 10, 20, 23, 59, 59, 999).toISOString();
  const text = `# Team memory\n## Testing\n${serializeRule({ id: 'T-abcd', content: 'Run synthetic suite', expiresAt: until })}\n- [T-abcd] duplicate\n- no id\n## General\n- [T-0001] General rule\n`;
  expect(parseTeamFile(text)).toEqual({ conflict: false, rules: [
    { id: 'T-abcd', content: 'Run synthetic suite', topic: 'Testing', expiresAt: until },
    { id: 'T-0001', content: 'General rule' },
  ] });
  for (const marker of ['<<<<<<< HEAD', '=======', '>>>>>>> branch']) expect(parseTeamFile(`${text}${marker}\n`).conflict).toBe(true);
});

test('sync creates, changes, removes and restores the same id; respects local off and projects', () => {
  writeFileSync(file, '# Team memory\n## Testing\n- [T-a123] Run synthetic suite\n');
  const added = memory.team.syncProject('P1', project);
  expect(added.added).toHaveLength(1);
  const id = added.added[0]!;
  const item = memory.store.getById(id)!;
  expect(item).toMatchObject({ scope: 'project', projectId: 'P1', type: 'constraint', status: 'active', topic: 'Testing', evidenceClass: 'user_stated' });
  expect(memory.store.getEvents(id)[0]).toMatchObject({ actor: 'system', meta: { via: 'team' } });
  expect(memory.team.syncProject('P1', project)).toEqual({ added: [], changed: [], removed: [], conflict: false });
  memory.store.archive(id, { actor: 'user' });
  writeFileSync(file, '# Team memory\n## Testing\n- [T-a123] Run updated synthetic suite\n');
  expect(memory.team.syncProject('P1', project).changed).toEqual([id]);
  expect(memory.store.getById(id)).toMatchObject({ status: 'archived', content: 'Run updated synthetic suite', version: item.version + 1 });
  const other = join(dir, 'other');
  mkdirSync(other);
  expect(memory.team.syncProject('P2', other).removed).toEqual([]);
  rmSync(file);
  expect(memory.team.syncProject('P1', project).removed).toEqual([id]);
  expect(memory.store.getEvents(id).at(-1)).toMatchObject({ actor: 'system', meta: { via: 'team_removed' } });
  writeFileSync(file, '# Team memory\n## Testing\n- [T-a123] Run updated synthetic suite\n');
  expect(memory.team.syncProject('P1', project)).toEqual({ added: [], changed: [], removed: [], conflict: false });
  expect(memory.store.getById(id)).toMatchObject({ status: 'active', version: item.version + 1 });
  expect(memory.team.refsFor([id]).get(id)).toEqual({ id: 'T-a123' });
});

test('conflicts freeze last good state and sensitive rules are skipped', () => {
  writeFileSync(file, '- [T-a123] A synthetic rule\n');
  const id = memory.team.syncProject('P1', project).added[0]!;
  writeFileSync(file, '<<<<<<< HEAD\n- [T-a123] altered\n=======\n>>>>>>> other\n');
  expect(memory.team.status('P1', project)).toMatchObject({ exists: true, conflict: true, canShare: true });
  expect(memory.team.syncProject('P1', project).conflict).toBe(true);
  expect(memory.store.getById(id)?.content).toBe('A synthetic rule');
  expect(() => memory.team.propose(id, 'changed', project, { actor: 'user' })).toThrow('merge conflicts');
  writeFileSync(file, '- [T-a123] password = SYNTHETIC_ONLY\n- [T-aaaa] token = SYNTHETIC_ONLY\n');
  expect(memory.team.syncProject('P1', project)).toEqual({ added: [], changed: [], removed: [], conflict: false });
  expect(memory.store.getById(id)?.content).toBe('A synthetic rule');
});

test('publish creates and extends topic sections, proposes and unshares', () => {
  const create = (content: string, topic?: string) => memory.store.create({ content, topic, scope: 'project', projectId: 'P1', type: 'fact' }, { actor: 'user' });
  const first = create('Run synthetic\nsuite', 'Testing');
  const second = create('Run synthetic lint', 'Testing');
  const third = create('Use synthetic flags', 'General');
  const published = memory.team.publish(first.id, project, { actor: 'user' });
  memory.team.publish(second.id, project, { actor: 'user' });
  memory.team.publish(third.id, project, { actor: 'user' });
  const rules = parseTeamFile(readFileSync(file, 'utf8')).rules;
  expect(rules).toHaveLength(3);
  expect(new Set(rules.map(rule => rule.id)).size).toBe(3);
  expect(rules[0]).toMatchObject({ content: 'Run synthetic suite', topic: 'Testing' });
  expect(published.team?.id).toMatch(/^T-[0-9a-f]{4}$/);
  const revised = memory.team.propose(first.id, 'Run revised\nsynthetic suite', project, { actor: 'user' });
  expect(revised).toMatchObject({ content: 'Run revised synthetic suite', team: published.team });
  const local = memory.team.unshare(first.id, project, { actor: 'user' });
  expect(local.status).toBe('active');
  expect(memory.team.refsFor([first.id]).size).toBe(0);
  expect(parseTeamFile(readFileSync(file, 'utf8')).rules.map(rule => rule.id)).not.toContain(published.team!.id);
});

test('a proposal preserves notices for other file changes synced in the same pass', () => {
  writeFileSync(file, '- [T-a123] First synthetic rule\n');
  const first = memory.team.syncProject('P1', project).added[0]!;
  writeFileSync(file, '- [T-a123] First synthetic rule\n- [T-b234] Another synthetic rule\n');
  memory.team.propose(first, 'Revised synthetic rule', project, { actor: 'user' });
  const second = memory.team.refsFor(memory.store.list().map(item => item.id));
  const secondId = [...second].find(([, team]) => team.id === 'T-b234')![0];
  expect(memory.team.pendingNotice('P1')).toMatchObject({ added: [secondId], changed: [], removed: [] });
});

test('team rule is confirmed once and again only after an update', () => {
  writeFileSync(file, '- [T-a123] Synthetic original\n');
  const id = memory.team.syncProject('P1', project).added[0]!;
  const first = memory.store.getById(id)!;
  const reasons = () => memoryConfirmationReasons([memory.store.getById(id)!], getMemoryConfirmation(memory.store, 'chat'), [], memory.fileDrift, memory.store);
  expect(reasons()).toMatchObject([{ reason: 'first', team: true }]);
  recordMemoryConfirmation(memory.store, 'chat', [first], []);
  expect(reasons()).toEqual([]);
  rmSync(file);
  memory.team.syncProject('P1', project);
  writeFileSync(file, '- [T-a123] Synthetic original\n');
  memory.team.syncProject('P1', project);
  expect(reasons()).toEqual([]);
  writeFileSync(file, '- [T-a123] Synthetic revised\n');
  memory.team.syncProject('P1', project);
  expect(reasons()).toMatchObject([{ reason: 'changed', team: true, previousVersion: 1, version: 2 }]);
  recordMemoryConfirmation(memory.store, 'chat', [memory.store.getById(id)!], []);
  expect(reasons()).toEqual([]);
});

test('the same team id in two projects creates independent mirrors', () => {
  const other = join(dir, 'other');
  mkdirSync(join(other, '.memosync'), { recursive: true });
  writeFileSync(file, '- [T-a123] First project synthetic rule\n');
  writeFileSync(join(other, '.memosync', 'team.md'), '- [T-a123] Second project synthetic rule\n');
  const first = memory.team.syncProject('P1', project).added[0]!;
  const second = memory.team.syncProject('P2', other).added[0]!;
  expect(first).not.toBe(second);
  rmSync(file);
  expect(memory.team.syncProject('P1', project).removed).toEqual([first]);
  expect(memory.store.getById(second)).toMatchObject({ status: 'active', content: 'Second project synthetic rule' });
});

test('team links prevent revision proposals and invalidate already-drafted acceptance', () => {
  const target = memory.store.create({ content: 'Synthetic original', scope: 'project', projectId: 'P1', type: 'constraint' }, { actor: 'user' });
  const draft = memory.store.createRevisionProposal({ content: 'Synthetic revision', scope: 'project', projectId: 'P1', type: 'constraint' }, target.id, { actor: 'system' })!;
  memory.team.publish(target.id, project, { actor: 'user' });
  expect(memory.store.createRevisionProposal({ content: 'Another synthetic revision', scope: 'project', projectId: 'P1', type: 'constraint' }, target.id, { actor: 'system' })).toBeNull();
  expect(() => memory.store.acceptRevision(draft.id, { actor: 'user' })).toThrow();
  expect(memory.store.getById(target.id)?.status).toBe('active');
});
