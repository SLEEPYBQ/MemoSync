import { describe, expect, test } from 'bun:test';
import { buildMemoryBlock } from './prompt';
import type { MemoryItem } from './types';

function item(over: Partial<MemoryItem> & { id: string; content: string }): MemoryItem {
  return {
    scope: 'personal',
    type: 'preference',
    status: 'active',
    abstractionLevel: 'contextual',
    sensitive: false,
    version: 1,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...over,
  } as MemoryItem;
}

const MEMORIES = [
  item({ id: 'M-01', content: 'Prefers bun over npm', detail: 'Always bun, even for scripts' }),
  item({ id: 'M-02', content: 'Never push to main without asking', scope: 'project', type: 'constraint' }),
];

describe('buildMemoryBlock tools flag', () => {
  test('tools:false omits the search/detail guidance but keeps the citation rule', () => {
    const block = buildMemoryBlock({ memories: MEMORIES, tools: false });
    expect(block).toContain('[M-01 v1]');
    expect(block).toContain('Citing memory');
    expect(block).not.toContain('search_memory');
    expect(block).not.toContain('load_memory_detail');
  });
});
