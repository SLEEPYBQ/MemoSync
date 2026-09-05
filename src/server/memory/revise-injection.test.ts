import { describe, it, expect } from 'bun:test';
import { createReviseInjectionService } from './revise-injection';
import type { LlmJsonCaller } from './deepseek';

const POOL = [
  { id: 'M-01', content: 'Use bun for scripts' },
  { id: 'M-02', content: 'UI buttons use the juicy variant' },
  { id: 'M-03', content: 'APIs need tests' },
];

describe('createReviseInjectionService (Step 2 "ask agent to revise")', () => {
  it('applies the model selection, filters hallucinated ids, keeps the reply', async () => {
    const call: LlmJsonCaller = async (req) => {
      expect(req.disableThinking).toBe(true);
      expect(req.user).toContain('drop the UI one');
      return { selectedIds: ['M-01', 'M-03', 'M-99', 'M-01'], reply: 'Removed [M-02]; added [M-03].' };
    };
    const svc = createReviseInjectionService({ callJson: call });
    const result = await svc.revise({ instruction: 'drop the UI one, add testing', pool: POOL, selectedIds: ['M-01', 'M-02'] });
    expect(result.selectedIds).toEqual(['M-01', 'M-03']);
    expect(result.reply).toBe('Removed [M-02]; added [M-03].');
  });

  it('allows concise Markdown replies with meaningful line breaks', async () => {
    const call: LlmJsonCaller = async (req) => {
      expect(req.system).toContain('Markdown');
      expect(req.system).toContain('line breaks');
      return {
        selectedIds: ['M-01', 'M-03'],
        reply: '**Most relevant**\n\n- [M-01]\n- [M-03]',
      };
    };
    const svc = createReviseInjectionService({ callJson: call });
    const result = await svc.revise({ instruction: 'show the two most relevant items', pool: POOL, selectedIds: ['M-01', 'M-03'] });
    expect(result.reply).toBe('**Most relevant**\n\n- [M-01]\n- [M-03]');
  });

  it('degrades to the unchanged selection on failure', async () => {
    const call: LlmJsonCaller = async () => {
      throw new Error('timeout');
    };
    const svc = createReviseInjectionService({ callJson: call });
    const result = await svc.revise({ instruction: 'whatever', pool: POOL, selectedIds: ['M-02'] });
    expect(result.selectedIds).toEqual(['M-02']);
    expect(result.reply).toContain('unchanged');
  });
});
