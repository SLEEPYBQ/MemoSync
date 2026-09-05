import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  ensureStaticMemoryScaffold,
  readStudyStaticMemoryFiles,
  readStaticMemoryFiles,
  hashStaticMemoryFiles,
  buildStaticMemoryBlock,
  buildStaticFocusPayload,
  buildStudyStaticFocusPayload,
  STATIC_MEMORY_FILENAME,
  STATIC_MEMORY_MAX_FILE_CHARS,
  STATIC_MEMORY_MAX_FILES,
  STUDY_STATIC_MEMORY_MAX_FILES,
  STUDY_STATIC_MEMORY_MAX_TOTAL_BYTES,
} from './static-files';
import type { MemoryItem } from './types';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'static-mem-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seed(over: Partial<MemoryItem> & { id: string; content: string }): MemoryItem {
  return {
    scope: 'personal',
    type: 'preference',
    status: 'active',
    abstractionLevel: 'contextual',
    sensitive: false,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...over,
  } as MemoryItem;
}

describe('ensureStaticMemoryScaffold', () => {
  test('creates MEMORY.md with type sections and plain seed bullets (no ids)', () => {
    const created = ensureStaticMemoryScaffold(dir, [
      seed({ id: 'M-01', content: 'Prefers bun over npm' }),
      seed({ id: 'M-02', content: 'Never push to main', type: 'constraint' }),
    ]);
    expect(created).toBe(true);
    const text = readFileSync(join(dir, STATIC_MEMORY_FILENAME), 'utf-8');
    expect(text).toContain('## Preferences');
    expect(text).toContain('- Prefers bun over npm');
    expect(text).toContain('## Constraints');
    expect(text).toContain('- Never push to main');
    expect(text).not.toContain('M-01');
  });

  test('is idempotent: never overwrites an existing (possibly user-edited) file', () => {
    ensureStaticMemoryScaffold(dir, []);
    writeFileSync(join(dir, STATIC_MEMORY_FILENAME), '# mine\n- user edit\n');
    const created = ensureStaticMemoryScaffold(dir, [seed({ id: 'M-09', content: 'late seed' })]);
    expect(created).toBe(false);
    expect(readFileSync(join(dir, STATIC_MEMORY_FILENAME), 'utf-8')).toContain('user edit');
  });
});

describe('readStaticMemoryFiles', () => {
  test('returns MEMORY.md first, then memory/*.md sorted by name', () => {
    writeFileSync(join(dir, STATIC_MEMORY_FILENAME), 'root');
    mkdirSync(join(dir, 'memory'));
    writeFileSync(join(dir, 'memory', 'b.md'), 'bee');
    writeFileSync(join(dir, 'memory', 'a.md'), 'ay');
    writeFileSync(join(dir, 'memory', 'notes.txt'), 'ignored');
    const files = readStaticMemoryFiles(dir);
    expect(files.map((f) => f.relPath)).toEqual(['MEMORY.md', 'memory/a.md', 'memory/b.md']);
    expect(files[0].content).toBe('root');
  });

  test('returns [] when nothing exists', () => {
    expect(readStaticMemoryFiles(dir)).toEqual([]);
  });
});

describe('readStudyStaticMemoryFiles', () => {
  test('returns every canonical file and every decoded character without legacy bounds', () => {
    const rootText = ` \r\n${'x'.repeat(STATIC_MEMORY_MAX_FILE_CHARS + 500)}  \r\n`;
    writeFileSync(join(dir, STATIC_MEMORY_FILENAME), rootText);
    mkdirSync(join(dir, 'memory'));
    for (let index = 0; index < STATIC_MEMORY_MAX_FILES + 1; index += 1) {
      writeFileSync(
        join(dir, 'memory', `f${String(index).padStart(2, '0')}.md`),
        `  note ${index}\r\n`,
      );
    }

    const files = readStudyStaticMemoryFiles(dir);

    expect(files).toHaveLength(STATIC_MEMORY_MAX_FILES + 2);
    expect(files[0]).toEqual({ relPath: STATIC_MEMORY_FILENAME, content: rootText, truncated: false });
    expect(files.at(-1)).toEqual({
      relPath: 'memory/f20.md',
      content: '  note 20\r\n',
      truncated: false,
    });
  });

  test('fails closed instead of silently dropping a non-regular canonical file', () => {
    mkdirSync(join(dir, STATIC_MEMORY_FILENAME));
    expect(() => readStudyStaticMemoryFiles(dir)).toThrow(/not a regular file.*MEMORY\.md/i);
  });

  test('rejects symlinks at every canonical representation path', () => {
    const outside = mkdtempSync(join(tmpdir(), 'static-mem-outside-'));
    try {
      writeFileSync(join(outside, 'outside.md'), 'outside');
      mkdirSync(join(outside, 'memory'));
      writeFileSync(join(outside, 'memory', 'topic.md'), 'outside topic');

      symlinkSync(join(outside, 'outside.md'), join(dir, STATIC_MEMORY_FILENAME));
      expect(() => readStudyStaticMemoryFiles(dir)).toThrow(/symbolic link.*MEMORY\.md/i);
      rmSync(join(dir, STATIC_MEMORY_FILENAME));

      symlinkSync(join(outside, 'memory'), join(dir, 'memory'));
      expect(() => readStudyStaticMemoryFiles(dir)).toThrow(/symbolic link.*memory/i);
      rmSync(join(dir, 'memory'));

      mkdirSync(join(dir, 'memory'));
      symlinkSync(join(outside, 'outside.md'), join(dir, 'memory', 'topic.md'));
      expect(() => readStudyStaticMemoryFiles(dir)).toThrow(/symbolic link.*memory\/topic\.md/i);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('rejects invalid UTF-8 instead of replacing bytes in delivered focus', () => {
    writeFileSync(join(dir, STATIC_MEMORY_FILENAME), Buffer.from([0x23, 0x20, 0xc3, 0x28, 0x0a]));
    expect(() => readStudyStaticMemoryFiles(dir)).toThrow(/invalid UTF-8.*MEMORY\.md/i);
  });

  test('fails the whole study read when explicit provider-context safety limits are exceeded', () => {
    mkdirSync(join(dir, 'memory'));
    for (let index = 0; index < STUDY_STATIC_MEMORY_MAX_FILES + 1; index += 1) {
      writeFileSync(join(dir, 'memory', `f${String(index).padStart(3, '0')}.md`), 'x');
    }
    expect(() => readStudyStaticMemoryFiles(dir)).toThrow(
      new RegExp(`exceeds.*${STUDY_STATIC_MEMORY_MAX_FILES}.*files`, 'i'),
    );

    rmSync(join(dir, 'memory'), { recursive: true, force: true });
    writeFileSync(
      join(dir, STATIC_MEMORY_FILENAME),
      Buffer.alloc(STUDY_STATIC_MEMORY_MAX_TOTAL_BYTES + 1, 0x78),
    );
    expect(() => readStudyStaticMemoryFiles(dir)).toThrow(
      new RegExp(`exceeds.*${STUDY_STATIC_MEMORY_MAX_TOTAL_BYTES}.*bytes`, 'i'),
    );
  });
});

describe('hashStaticMemoryFiles', () => {
  test('is stable for same content and changes when content changes', () => {
    const a = hashStaticMemoryFiles([{ relPath: 'MEMORY.md', content: 'x' }]);
    const b = hashStaticMemoryFiles([{ relPath: 'MEMORY.md', content: 'x' }]);
    const c = hashStaticMemoryFiles([{ relPath: 'MEMORY.md', content: 'y' }]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('robustness (review findings, commit 5922dbb)', () => {
  test('deleting MEMORY.md after scaffolding is respected — never recreated', () => {
    ensureStaticMemoryScaffold(dir, [seed({ id: 'M-01', content: 'seed' })]);
    rmSync(join(dir, STATIC_MEMORY_FILENAME));
    const recreated = ensureStaticMemoryScaffold(dir, [seed({ id: 'M-01', content: 'seed' })]);
    expect(recreated).toBe(false);
    expect(readStaticMemoryFiles(dir)).toEqual([]);
  });

  test('a pre-existing MEMORY.md is adopted without overwriting, and later deletion sticks', () => {
    writeFileSync(join(dir, STATIC_MEMORY_FILENAME), '# mine\n');
    expect(ensureStaticMemoryScaffold(dir, [])).toBe(false);
    rmSync(join(dir, STATIC_MEMORY_FILENAME));
    expect(ensureStaticMemoryScaffold(dir, [])).toBe(false);
  });

  test('unreadable entries are skipped, never thrown (MEMORY.md as a directory)', () => {
    mkdirSync(join(dir, STATIC_MEMORY_FILENAME));
    mkdirSync(join(dir, 'memory'));
    writeFileSync(join(dir, 'memory', 'ok.md'), 'fine');
    const files = readStaticMemoryFiles(dir);
    expect(files.map((f) => f.relPath)).toEqual(['memory/ok.md']);
  });

  test('oversized files are truncated with a visible marker', () => {
    writeFileSync(join(dir, STATIC_MEMORY_FILENAME), 'x'.repeat(STATIC_MEMORY_MAX_FILE_CHARS + 500));
    const files = readStaticMemoryFiles(dir);
    expect(files[0].content.length).toBeLessThan(STATIC_MEMORY_MAX_FILE_CHARS + 200);
    expect(files[0].content).toContain('truncated');
  });

  test('at most STATIC_MEMORY_MAX_FILES files are injected', () => {
    mkdirSync(join(dir, 'memory'));
    for (let i = 0; i < STATIC_MEMORY_MAX_FILES + 3; i++) {
      writeFileSync(join(dir, 'memory', `f${String(i).padStart(2, '0')}.md`), `note ${i}`);
    }
    expect(readStaticMemoryFiles(dir)).toHaveLength(STATIC_MEMORY_MAX_FILES);
  });
});

describe('buildStaticMemoryBlock', () => {
  test('injects file contents verbatim with per-file headers and maintenance guidance', () => {
    const block = buildStaticMemoryBlock([
      { relPath: 'MEMORY.md', content: '- always use tabs' },
      { relPath: 'memory/env.md', content: '- staging port is 4001' },
    ]);
    expect(block).toContain('MEMORY.md');
    expect(block).toContain('- always use tabs');
    expect(block).toContain('memory/env.md');
    expect(block).toContain('- staging port is 4001');
    // The model should surface maintainability to the user in conversation
    // (D6: the system prompts that the files can be maintained/modified).
    expect(block.toLowerCase()).toContain('edit');
    // No MemoSync mechanics leak into this arm.
    expect(block).not.toContain('[M-');
    expect(block).not.toContain('search_memory');
  });

  test('returns empty string with no files', () => {
    expect(buildStaticMemoryBlock([])).toBe('');
  });
});

describe('buildStaticFocusPayload', () => {
  test('maps each participant-controlled source to its exact substring in the delivered text', () => {
    const payload = buildStaticFocusPayload([
      { relPath: 'MEMORY.md', content: '\n- always use tabs\n' },
      { relPath: 'memory/env.md', content: '- staging port is 4001' },
    ]);

    expect(payload.text).toBe(buildStaticMemoryBlock([
      { relPath: 'MEMORY.md', content: '\n- always use tabs\n' },
      { relPath: 'memory/env.md', content: '- staging port is 4001' },
    ]));
    expect(payload.sources.map((source) => ({
      relPath: source.relPath,
      injectedContent: source.injectedContent,
      substring: payload.text.slice(source.start, source.end),
    }))).toEqual([
      { relPath: 'MEMORY.md', injectedContent: '- always use tabs', substring: '- always use tabs' },
      { relPath: 'memory/env.md', injectedContent: '- staging port is 4001', substring: '- staging port is 4001' },
    ]);
  });

  test('keeps fixed wrapper instructions outside every participant-controlled source slice', () => {
    const payload = buildStaticFocusPayload([
      { relPath: 'MEMORY.md', content: '- always use tabs' },
    ]);
    const wrapperOffset = payload.text.indexOf('You maintain these files yourself');

    expect(wrapperOffset).toBeGreaterThanOrEqual(0);
    expect(payload.sources.some((source) => source.start <= wrapperOffset && wrapperOffset < source.end)).toBe(false);
    expect(payload.sources.map((source) => source.injectedContent).join('\n')).not.toContain('You maintain these files yourself');
    expect(payload.text).toContain('0 to 4 total memory entry changes')
    expect(payload.text).toContain('counting additions and in-place revisions together')
    expect(payload.text).toContain('leave an already-correct entry unchanged')
    expect(payload.text).toContain('Revise an existing entry in place')
    expect(payload.text).toContain('More is not better')
    expect(payload.text).toContain('one atomic memory')
  });

  test('returns a deeply immutable delivery snapshot', () => {
    const payload = buildStaticFocusPayload([
      { relPath: 'MEMORY.md', content: '- always use tabs' },
    ]);

    expect(Object.isFrozen(payload)).toBe(true);
    expect(Object.isFrozen(payload.sources)).toBe(true);
    expect(Object.isFrozen(payload.sources[0])).toBe(true);
  });

  test('hashes the exact injected source content with SHA-256', () => {
    const payload = buildStaticFocusPayload([
      { relPath: 'MEMORY.md', content: '\n- always use tabs\n' },
    ]);
    const expected = createHash('sha256').update('- always use tabs', 'utf8').digest('hex');

    expect(payload.sources[0].contentHash).toBe(expected);
    expect(payload.sources[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test('marks truncated sources without exposing the synthetic truncation marker to the atomizer', () => {
    const participantPrefix = 'x'.repeat(STATIC_MEMORY_MAX_FILE_CHARS);
    writeFileSync(join(dir, STATIC_MEMORY_FILENAME), `${participantPrefix}overflow`);
    const payload = buildStaticFocusPayload(readStaticMemoryFiles(dir));
    const source = payload.sources[0];

    expect(source.truncated).toBe(true);
    expect(source.injectedContent).toBe(participantPrefix);
    expect(payload.text.slice(source.start, source.end)).toBe(participantPrefix);
    expect(payload.text).toContain('<!-- truncated: file exceeds the injection size limit -->');
    expect(source.end).toBeLessThan(payload.text.indexOf('<!-- truncated:'));
  });
});

describe('buildStudyStaticFocusPayload', () => {
  test('preserves CRLF and leading/trailing whitespace in source slices, offsets, and hashes', () => {
    const exact = ' \r\n- keep leading and trailing spaces  \r\n\r\n';
    const payload = buildStudyStaticFocusPayload([{ relPath: 'MEMORY.md', content: exact }]);
    const source = payload.sources[0]!;

    expect(source.injectedContent).toBe(exact);
    expect(payload.text.slice(source.start, source.end)).toBe(exact);
    expect(source.contentHash).toBe(createHash('sha256').update(exact, 'utf8').digest('hex'));
    expect(source.truncated).toBe(false);
  });

  test('refuses a legacy-truncated source instead of recording it as exact study focus', () => {
    expect(() => buildStudyStaticFocusPayload([{
      relPath: 'MEMORY.md',
      content: 'bounded\n<!-- truncated -->',
      participantContent: 'bounded',
      truncated: true,
    }])).toThrow(/cannot be built from a truncated memory source/i);
  });
});
