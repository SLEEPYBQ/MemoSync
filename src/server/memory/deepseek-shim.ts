// In-container chat-completions shim for the Codex engine on DeepSeek.
//
// Why this exists: codex ≥0.84 speaks ONLY the OpenAI Responses API, which
// DeepSeek does not serve (404 on /v1/responses); codex ≤0.81 still speaks
// chat/completions but emits `role: "developer"` messages, which DeepSeek's
// chat API rejects. So the image pins codex 0.81 and points its provider at
// this shim (docker/codex-config.toml → http://127.0.0.1:<port>/v1), which
// rewrites developer→system in the REQUEST and byte-pipes everything else —
// responses (incl. SSE streams) pass through untouched.
//
// This is engine plumbing, not memory logic; it lives here beside deepseek.ts
// because it shares the "DeepSeek runtime" concern. Revisit when DeepSeek
// ships a Responses endpoint or the Codex arm moves to an OpenAI key.

export interface DeepSeekChatShimOptions {
  /** 0 = pick an ephemeral port (tests). */
  port?: number;
  upstreamBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface DeepSeekChatShim {
  port: number;
  stop(): void;
}

/** Rewrite a chat-completions request body: `developer` role → `system`. */
export function rewriteChatBody(raw: string): string {
  try {
    const body = JSON.parse(raw);
    if (body && typeof body === 'object' && Array.isArray(body.messages)) {
      for (const m of body.messages) {
        if (m && typeof m === 'object' && m.role === 'developer') m.role = 'system';
      }
      return JSON.stringify(body);
    }
    return raw;
  } catch {
    return raw;
  }
}

export function startDeepSeekChatShim(opts: DeepSeekChatShimOptions = {}): DeepSeekChatShim {
  const upstream = (opts.upstreamBaseUrl ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com')
    .replace(/\/$/, '')
    .replace(/\/v1$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: opts.port ?? 3979,
    async fetch(req) {
      const url = new URL(req.url);
      // codex calls <base_url>/chat/completions (and /models on startup).
      const path = url.pathname.replace(/^\/v1/, '');
      const forwardHeaders = new Headers();
      const auth = req.headers.get('authorization');
      if (auth) forwardHeaders.set('authorization', auth);
      forwardHeaders.set('content-type', 'application/json');

      const init: RequestInit = { method: req.method, headers: forwardHeaders };
      if (req.method === 'POST') {
        init.body = rewriteChatBody(await req.text());
      }
      const res = await fetchImpl(`${upstream}${path}${url.search}`, init);
      // Byte-pipe the upstream response (SSE streaming included).
      return new Response(res.body, { status: res.status, headers: res.headers });
    },
  });

  return {
    port: server.port ?? 0,
    stop: () => server.stop(true),
  };
}
