import { describe, expect, test } from 'bun:test';
import { createDeepSeekJsonCaller, describeLlmJsonFailure } from './deepseek';

function fakeFetch(handler: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    const { status = 200, body } = handler(String(url), init);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { impl, calls };
}

describe('createDeepSeekJsonCaller', () => {
  test('returns null without an api key', () => {
    expect(createDeepSeekJsonCaller({ apiKey: '' })).toBeNull();
  });

  test('POSTs a json_object chat completion and parses the content', async () => {
    const { impl, calls } = fakeFetch(() => ({
      body: { choices: [{ message: { content: '{"candidates":[{"content":"x"}]}' } }] },
    }));
    const call = createDeepSeekJsonCaller({
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com',
      model: 'deepseek-v4-flash',
      fetchImpl: impl,
    })!;
    const out = await call({ system: 'sys', user: 'usr', maxTokens: 123 });
    expect(out).toEqual({ candidates: [{ content: 'x' }] });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.example.com/chat/completions');
    const sent = JSON.parse(String(calls[0].init.body));
    expect(sent.model).toBe('deepseek-v4-flash');
    expect(sent.response_format).toEqual({ type: 'json_object' });
    expect(sent.max_tokens).toBe(123);
    expect(sent.temperature).toBe(0);
    expect(sent.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ]);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
  });

  test('throws on empty content and on non-2xx', async () => {
    const empty = fakeFetch(() => ({ body: { choices: [{ message: { content: '' } }] } }));
    const call1 = createDeepSeekJsonCaller({ apiKey: 'k', fetchImpl: empty.impl, retryDelayMs: 0 })!;
    expect(call1({ system: 's', user: 'u' })).rejects.toThrow();

    const err = fakeFetch(() => ({ status: 500, body: { error: 'boom' } }));
    const call2 = createDeepSeekJsonCaller({ apiKey: 'k', fetchImpl: err.impl, retryDelayMs: 0 })!;
    expect(call2({ system: 's', user: 'u' })).rejects.toThrow();
  });

  test('unwraps a ```json fence if the model adds one', async () => {
    const { impl } = fakeFetch(() => ({
      body: { choices: [{ message: { content: '```json\n{"ok":true}\n```' } }] },
    }));
    const call = createDeepSeekJsonCaller({ apiKey: 'k', fetchImpl: impl })!;
    expect(await call({ system: 's', user: 'u' })).toEqual({ ok: true });
  });

  test('retries a transient 5xx then succeeds (a capture pass is not lost to a blip)', async () => {
    let n = 0;
    const flaky = fakeFetch(() => {
      n++;
      if (n < 3) return { status: 503, body: { error: 'unavailable' } };
      return { body: { choices: [{ message: { content: '{"ok":true}' } }] } };
    });
    const call = createDeepSeekJsonCaller({ apiKey: 'k', fetchImpl: flaky.impl, maxRetries: 2, retryDelayMs: 0 })!;
    expect(await call({ system: 's', user: 'u' })).toEqual({ ok: true });
    expect(flaky.calls).toHaveLength(3);
  });

  test('retries a thrown network error then succeeds', async () => {
    let n = 0;
    const impl = (async () => {
      n++;
      if (n < 2) throw new Error('ECONNRESET');
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
    }) as unknown as typeof fetch;
    const call = createDeepSeekJsonCaller({ apiKey: 'k', fetchImpl: impl, maxRetries: 2, retryDelayMs: 0 })!;
    expect(await call({ system: 's', user: 'u' })).toEqual({ ok: true });
    expect(n).toBe(2);
  });

  test('does NOT retry a 4xx (deterministic client error → fail fast)', async () => {
    const bad = fakeFetch(() => ({ status: 400, body: { error: 'bad request' } }));
    const call = createDeepSeekJsonCaller({ apiKey: 'k', fetchImpl: bad.impl, maxRetries: 3, retryDelayMs: 0 })!;
    await expect(call({ system: 's', user: 'u' })).rejects.toThrow();
    expect(bad.calls).toHaveLength(1);
  });

  test('exposes safe failure categories and HTTP status without provider response content', async () => {
    const limited = fakeFetch(() => ({ status: 429, body: { error: 'account-specific provider text' } }));
    const call = createDeepSeekJsonCaller({ apiKey: 'k', fetchImpl: limited.impl, maxRetries: 0 })!;
    let failure: unknown;
    try {
      await call({ system: 's', user: 'u' });
    } catch (error) {
      failure = error;
    }
    expect(describeLlmJsonFailure(failure)).toEqual({ category: 'rate_limited', httpStatus: 429 });
    expect(String(failure)).not.toContain('account-specific provider text');
  });

  test('does NOT retry malformed JSON (retrying the same prompt won’t fix it)', async () => {
    const bad = fakeFetch(() => ({ body: { choices: [{ message: { content: 'not json' } }] } }));
    const call = createDeepSeekJsonCaller({ apiKey: 'k', fetchImpl: bad.impl, maxRetries: 3, retryDelayMs: 0 })!;
    await expect(call({ system: 's', user: 'u' })).rejects.toThrow();
    expect(bad.calls).toHaveLength(1);
  });

  test('gives up after maxRetries and throws', async () => {
    const err = fakeFetch(() => ({ status: 500, body: { error: 'boom' } }));
    const call = createDeepSeekJsonCaller({ apiKey: 'k', fetchImpl: err.impl, maxRetries: 2, retryDelayMs: 0 })!;
    await expect(call({ system: 's', user: 'u' })).rejects.toThrow();
    expect(err.calls).toHaveLength(3); // 1 + 2 retries
  });
});
