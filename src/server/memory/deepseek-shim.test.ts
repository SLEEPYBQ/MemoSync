import { describe, expect, test } from 'bun:test';
import { rewriteChatBody, startDeepSeekChatShim } from './deepseek-shim';

describe('rewriteChatBody', () => {
  test('maps developer role to system, leaves everything else intact', () => {
    const body = {
      model: 'deepseek-v4-flash',
      stream: true,
      messages: [
        { role: 'system', content: 'a' },
        { role: 'developer', content: 'b' },
        { role: 'user', content: 'c' },
        { role: 'assistant', content: 'd', tool_calls: [{ id: 'x' }] },
      ],
      tools: [{ type: 'function', function: { name: 'search_memory' } }],
    };
    const out = rewriteChatBody(JSON.stringify(body));
    const parsed = JSON.parse(out);
    expect(parsed.messages.map((m: any) => m.role)).toEqual(['system', 'system', 'user', 'assistant']);
    expect(parsed.messages[1].content).toBe('b');
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.stream).toBe(true);
  });

  test('passes through non-JSON bodies unchanged', () => {
    expect(rewriteChatBody('not json')).toBe('not json');
  });
});

describe('startDeepSeekChatShim', () => {
  test('forwards chat completions upstream with rewritten roles + auth passthrough', async () => {
    let captured: { url: string; auth: string | null; body: any } | null = null;
    const shim = startDeepSeekChatShim({
      port: 0,
      upstreamBaseUrl: 'https://upstream.example',
      fetchImpl: (async (url: any, init: any) => {
        captured = {
          url: String(url),
          auth: new Headers(init.headers).get('authorization'),
          body: JSON.parse(String(init.body)),
        };
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as typeof fetch,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${shim.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' },
        body: JSON.stringify({ messages: [{ role: 'developer', content: 'rules' }] }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(captured!.url).toBe('https://upstream.example/chat/completions');
      expect(captured!.auth).toBe('Bearer sk-test');
      expect(captured!.body.messages[0].role).toBe('system');
    } finally {
      shim.stop();
    }
  });
});
