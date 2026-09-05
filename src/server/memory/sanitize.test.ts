import { describe, it, expect } from 'bun:test';
import { createSanitizeService } from './sanitize';
import type { DeepSeekJsonRequest, LlmJsonCaller } from './deepseek';

function stubCaller(response: Record<string, unknown> | Error): { call: LlmJsonCaller; calls: DeepSeekJsonRequest[] } {
  const calls: DeepSeekJsonRequest[] = [];
  const call: LlmJsonCaller = async (req) => {
    calls.push(req);
    if (response instanceof Error) throw response;
    return response;
  };
  return { call, calls };
}

const SENSITIVE = {
  content: 'Deploy uses the API key sk-84ee-example and ops@example.com as the contact',
  detail: 'The key sk-84ee-example lives in .env; ping ops@example.com on failures.',
};

describe('createSanitizeService', () => {
  it('asks the LLM to redact and returns the validated proposal', async () => {
    const { call, calls } = stubCaller({
      content: 'Deploy uses the API key <API_KEY> and <EMAIL> as the contact',
      detail: 'The key <API_KEY> lives in .env; ping <EMAIL> on failures.',
      redactions: [
        { placeholder: '<API_KEY>', kind: 'credential' },
        { placeholder: '<EMAIL>', kind: 'contact' },
      ],
    });
    const sanitize = createSanitizeService({ callJson: call });

    const proposal = await sanitize.propose(SENSITIVE);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.system).toMatch(/redact/i);
    expect(calls[0]!.user).toContain('sk-84ee-example');
    expect(proposal.content).toContain('<API_KEY>');
    expect(proposal.content).not.toContain('sk-84ee-example');
    expect(proposal.detail).toContain('<EMAIL>');
    expect(proposal.redactions.map((r) => r.kind)).toEqual(['credential', 'contact']);
  });

  it('rejects a malformed proposal instead of passing raw text through', async () => {
    const { call } = stubCaller({ redactions: [] }); // no content — invalid
    const sanitize = createSanitizeService({ callJson: call });
    await expect(sanitize.propose(SENSITIVE)).rejects.toThrow(/sanitize/i);
  });

  it('propagates LLM failures — a failed redaction must never look like a clean one', async () => {
    const { call } = stubCaller(new Error('Unterminated string'));
    const sanitize = createSanitizeService({ callJson: call });
    await expect(sanitize.propose(SENSITIVE)).rejects.toThrow('Unterminated string');
  });

  it('omitting detail in the source omits it from the prompt and the proposal', async () => {
    const { call, calls } = stubCaller({ content: 'clean', redactions: [] });
    const sanitize = createSanitizeService({ callJson: call });
    const proposal = await sanitize.propose({ content: 'only content with secret-x' });
    expect(calls[0]!.user).not.toContain('Detail:');
    expect(proposal.detail).toBeUndefined();
  });
});
