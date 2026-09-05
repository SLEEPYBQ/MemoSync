import { describe, it, expect } from 'bun:test';
import { rankMemories, tokenize } from './retrieval';
import type { MemoryItem } from './types';

function mem(id: string, content: string, over: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id,
    content,
    scope: 'project',
    type: 'lesson',
    status: 'active',
    createdAt: '',
    updatedAt: '',
    usageCount: 0,
    reinforcedCount: 0,
    version: 1,
    citedInCurrentSession: 0,
    abstractionLevel: 'contextual',
    sensitive: false,
    ...over,
  };
}

describe('memory retrieval', () => {
  it('ranks by keyword relevance with rare-term weighting', () => {
    const pool = [
      mem('M-01', 'jest needs --runInBand on this repo'),
      mem('M-02', 'the deploy pipeline uses terraform workspaces'),
      mem('M-03', 'always run prettier before committing'),
    ];
    const ranked = rankMemories('why do the jest tests hang when I run them?', pool);
    expect(ranked[0].memory.id).toBe('M-01');
    expect(ranked.find((r) => r.memory.id === 'M-02')).toBeUndefined(); // zero overlap
  });

  it('outcome boost: a cited memory outranks an equally-matching uncited one', () => {
    const pool = [
      mem('M-10', 'use pytest markers for slow tests', { usageCount: 0 }),
      mem('M-11', 'use pytest fixtures for db tests', { usageCount: 8 }),
    ];
    const ranked = rankMemories('how should I organize pytest tests?', pool);
    expect(ranked[0].memory.id).toBe('M-11');
  });

  it('tokenize drops stopwords and short tokens', () => {
    expect(tokenize('Can you run the tests for app.py')).toEqual(['tests', 'app.py']);
  });
});

describe('CJK tokenization', () => {
  it('tokenizes Chinese text into bigrams so Chinese queries can match', () => {
    expect(tokenize('翻译任务')).toEqual(['翻译', '译任', '任务']);
  });

  it('mixed text keeps latin tokens and adds CJK bigrams', () => {
    const tokens = tokenize('用bun test跑测试');
    expect(tokens).toContain('bun');
    expect(tokens).toContain('test');
    expect(tokens).toContain('测试');
  });

  it('an isolated single CJK char is kept as its own token', () => {
    expect(tokenize('用 bun run')).toContain('用');
  });

  it('ranks a Chinese memory for a Chinese query', () => {
    const pool = [
      mem('M-30', '提交信息一律用中文写'),
      mem('M-31', 'always deploy with terraform'),
    ];
    const ranked = rankMemories('帮我用中文写提交信息', pool);
    expect(ranked[0]?.memory.id).toBe('M-30');
    expect(ranked.find((r) => r.memory.id === 'M-31')).toBeUndefined();
  });
});
