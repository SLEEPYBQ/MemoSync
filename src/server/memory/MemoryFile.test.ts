import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryFile } from './MemoryFile';
import { MemoryStore } from './MemoryStore';
import type { MemoryItem } from './types';

/** Build a full MemoryItem from a partial (test convenience). */
function mem(p: Partial<MemoryItem> & Pick<MemoryItem, 'id' | 'content'>): MemoryItem {
  return {
    scope: 'personal',
    type: 'preference',
    status: 'active',
    createdAt: '2025-06-10T00:00:00.000Z',
    updatedAt: '2025-06-10T00:00:00.000Z',
    usageCount: 0,
    reinforcedCount: 0,
    version: 1,
    citedInCurrentSession: 0,
    abstractionLevel: 'contextual',
    sensitive: false,
    ...p,
  };
}

describe('MemoryFile', () => {
  let dir: string;
  let file: MemoryFile;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memosync-file-'));
    file = new MemoryFile(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes personal memories to correct path', () => {
    const items = [
      mem({ id: 'M-01', content: 'Use node via nvm', scope: 'personal', type: 'preference' }),
      mem({ id: 'M-08', content: 'Check for port conflicts', scope: 'personal', type: 'lesson' }),
    ];
    file.writePersonal(items);
    const path = join(dir, 'personal', 'memories.md');
    expect(existsSync(path)).toBe(true);
    const text = readFileSync(path, 'utf-8');
    expect(text).toContain('# Personal Memories');
    expect(text).toContain('## Preferences');
    expect(text).toContain('- [M-01] Use node via nvm');
    expect(text).toContain('## Lessons');
    expect(text).toContain('- [M-08] Check for port conflicts');
  });

  it('writes project memories to correct path', () => {
    const items = [
      mem({ id: 'M-07', content: 'Only run MainTests (~19s)', scope: 'project', type: 'constraint', projectId: 'RenderX', topic: 'Testing' }),
      mem({ id: 'M-03', content: 'L20 = 48G', scope: 'project', type: 'fact', projectId: 'RenderX', topic: 'Environment' }),
    ];
    file.writeProject('RenderX', items);
    const path = join(dir, 'projects', 'RenderX', 'memories.md');
    expect(existsSync(path)).toBe(true);
    const text = readFileSync(path, 'utf-8');
    expect(text).toContain('# Project: RenderX');
    expect(text).toContain('## Testing');
    expect(text).toContain('- [M-07] Only run MainTests (~19s)');
    expect(text).toContain('## Environment');
    expect(text).toContain('- [M-03] L20 = 48G');
  });

  it('parses existing markdown memory file', () => {
    const md = [
      '# Personal Memories',
      '<!-- memosync:hash:deadbeef -->',
      '<!-- memosync:updated:2025-06-10T14:23:00Z -->',
      '',
      '## Preferences',
      '- [M-01] Use node via nvm',
      '- [M-02] Keep commits concise',
      '',
      '## Lessons',
      '- [M-08] Always check for port conflicts before starting dev server',
      '',
    ].join('\n');
    mkdirSync(join(dir, 'personal'), { recursive: true });
    writeFileSync(join(dir, 'personal', 'memories.md'), md);

    const parsed = file.readPersonal();
    expect(parsed).toHaveLength(3);
    const byId = Object.fromEntries(parsed.map((m) => [m.id, m]));
    expect(byId['M-01'].content).toBe('Use node via nvm');
    expect(byId['M-01'].type).toBe('preference');
    expect(byId['M-01'].scope).toBe('personal');
    expect(byId['M-08'].type).toBe('lesson');
    expect(byId['M-02'].content).toBe('Keep commits concise');
  });

  it('returns [] when reading a file that does not exist', () => {
    expect(file.readPersonal()).toEqual([]);
    expect(file.readProject('Nonexistent')).toEqual([]);
  });

  it('round-trips: write then read produces same items', () => {
    const items = [
      mem({ id: 'M-07', content: 'Only run MainTests (~19s)', scope: 'project', type: 'constraint', projectId: 'RenderX', topic: 'Testing' }),
      mem({ id: 'M-12', content: 'Run full test suite before push', scope: 'project', type: 'constraint', projectId: 'RenderX', topic: 'Testing' }),
      mem({ id: 'M-11', content: 'Use .env.local for secrets', scope: 'project', type: 'constraint', projectId: 'RenderX', topic: 'Environment' }),
    ];
    file.writeProject('RenderX', items);
    const parsed = file.readProject('RenderX');

    const norm = (arr: { id: string; content: string; topic?: string }[]) =>
      arr.map((m) => ({ id: m.id, content: m.content, topic: m.topic })).sort((a, b) => a.id.localeCompare(b.id));

    expect(norm(parsed)).toEqual(norm(items.map((m) => ({ id: m.id, content: m.content, topic: m.topic }))));
    expect(parsed.every((m) => m.scope === 'project')).toBe(true);
    expect(parsed.every((m) => m.type === undefined)).toBe(true);
  });

  it('round-trips a topic-less project memory as an undefined topic', () => {
    const items = [mem({ id: 'M-20', content: 'no topic here', scope: 'project', type: 'fact', projectId: 'RenderX' })];
    file.writeProject('RenderX', items);
    const parsed = file.readProject('RenderX');
    expect(parsed).toHaveLength(1);
    expect(parsed[0].content).toBe('no topic here');
    expect(parsed[0].topic).toBeUndefined();
  });

  it('updates hash comment on write', () => {
    const items = [
      mem({ id: 'M-01', content: 'alpha', scope: 'personal', type: 'fact' }),
      mem({ id: 'M-02', content: 'beta', scope: 'personal', type: 'fact' }),
    ];
    file.writePersonal(items);
    const text = readFileSync(join(dir, 'personal', 'memories.md'), 'utf-8');
    const expectedHash = MemoryStore.computeHash(items);
    expect(text).toContain(`<!-- memosync:hash:${expectedHash} -->`);
    expect(text).toMatch(/<!-- memosync:updated:.+ -->/);

    const edited = items.map((m) => (m.id === 'M-01' ? { ...m, content: 'ALPHA' } : m));
    file.writePersonal(edited);
    const text2 = readFileSync(join(dir, 'personal', 'memories.md'), 'utf-8');
    expect(text2).toContain(`<!-- memosync:hash:${MemoryStore.computeHash(edited)} -->`);
    expect(text2).not.toContain(`<!-- memosync:hash:${expectedHash} -->`);
  });
});
