# Model access phase 2: protocol translation gateway

## Goal

Today an engine can only use a connection that speaks its native protocol
(`ENGINE_PROTOCOLS` in `src/shared/model-access.ts`): Claude Code needs an
Anthropic Messages endpoint and Codex needs an OpenAI Responses endpoint. The
engine card shows `connection-protocol-unsupported` for anything else.

Phase 2 removes that limit for the two paths that matter most:

1. **Claude Code on an OpenAI Chat Completions endpoint.** The Anthropic
   Messages API goes in and Chat Completions comes out; OpenRouter, Ollama,
   LM Studio and most OpenAI-compatible relays become usable.
2. **Codex on an OpenAI Chat Completions endpoint.** The Responses API goes in
   and Chat Completions comes out; most vendors only offer Chat.

Native endpoints still win: when a connection has the engine's native protocol,
nothing changes and no gateway runs. Translation is the fallback.

## Source to port

Port Magpie's gateway (Go, MIT, © 2026 yetone). The source is at
`/private/tmp/claude-501/-Users-zhangbaiqiao--claude-spares-spare-KNX0eR/17cb0ed9-29c9-497c-b009-9b5615eaf193/scratchpad/external/magpie/internal/gateway`.
Start from `gateway.go` (request routing and the internal request shape,
around lines 806–818, 6631–6682 and 6895–6925), `anthropic.go` (around
1511–1719) and `responses.go` (around 1857–2093), plus the matching `*_test.go`
files.

Port only what these two paths need:

- request parsing into an internal shape;
- the Chat Completions request encoder;
- SSE decoding of Chat Completions streams;
- re-encoding as Anthropic Messages SSE or Responses SSE;
- tool schemas, tool call ids, streamed argument deltas, tool results;
- reasoning (as far as Chat Completions vendors expose it, e.g.
  `reasoning_content`);
- usage, stop reasons, and errors (status plus a body each client understands).

Leave out:

- accounts, subscription bridges, affinity, advisor, caching tricks, and
  vendor quirks for vendors MemoSync doesn't ship;
- anything with no use on these two paths.

Port the Go tests that cover the parts you take as Bun tests, and keep the
fixture data.

Add a "Adapted from Magpie …" header to each ported file, as
`src/server/model-access/runtime.ts` does. Add the ported files to the Magpie
section of `THIRD_PARTY_NOTICES.md`.

## Shape in MemoSync

- **The gateway** is an in-process HTTP server on `127.0.0.1` with a random
  port. It starts lazily on the first runtime that needs it and is shared by
  every turn. Use Bun's built-in server.
- **Each route** is bound to one connection and one target protocol, for
  example `/c/<connectionId>/anthropic/v1/messages`.
- **Auth:** the gateway requires a per-process random token. The child CLI gets
  that token, never the upstream key. The gateway adds the real key from the
  credential store when it calls upstream.
- **Runtime:**
  - `src/server/model-access/runtime.ts` currently fails with
    `connection-protocol-unsupported` when `endpointForEngine` returns null. It
    should resolve to a gateway endpoint when the connection has a translatable
    protocol: claude needs openai-chat; codex needs openai-chat.
  - The child env and args are built exactly as for a native endpoint, but
    pointed at the gateway: claude uses `ANTHROPIC_BASE_URL` plus the token as
    `ANTHROPIC_AUTH_TOKEN`; codex uses the provider `base_url` and a bearer
    token.
  - Isolation stays as it is: connection mode always runs in a MemoSync-owned
    profile.
- **Shared contract:** add a translatable-protocol table next to
  `ENGINE_PROTOCOLS`, for example `ENGINE_TRANSLATED_PROTOCOLS`, and a helper
  that says whether a connection is native, translated, or unsupported for an
  engine.
- **Status:**
  - `service.ts` stops reporting `connection-protocol-unsupported` for
    translated connections.
  - `EngineStatus` gains an optional `translated?: boolean`, or an equivalent
    that fits the code better, so the UI can say the connection goes through
    translation.
  - Client: in `src/client/app/settings/EngineCard.tsx`, connections that need
    translation are selectable. The summary line gets a short note in both
    locales: en "via translation" / zh "经协议转换". Keep it minimal; the
    design owner will restyle it.
- **Test connection** (`test-connection.ts`) already tests each endpoint
  natively. Nothing to change unless something breaks.

## Out of scope

- Anthropic ↔ Responses translation (Claude on a Responses-only endpoint, or
  Codex on an Anthropic-only one).
- Pi: it already speaks Chat and Responses.
- Image inputs and server-side tools that Chat Completions can't express:
  reject them with a clear error, don't approximate.
- Any UI redesign.

## Acceptance

- `bunx tsc --noEmit`, `bun run check` and `bun test src/` all pass.
- **Unit tests** for both translation directions, built from the ported
  fixtures and covering:
  - plain text streaming;
  - a tool call with streamed argument deltas, then the tool result turn;
  - reasoning deltas;
  - usage and stop reason;
  - an upstream 401, 404 and 429 mapped to the client's error shape;
  - a mid-stream upstream disconnect.
- **Integration test:** a fake Chat Completions upstream (a local Bun server)
  driven through the gateway by a real Anthropic-format request and a real
  Responses-format request. Assert the SSE event sequences the clients expect.
- **Runtime tests:**
  - a chat-only connection on claude and on codex resolves to the gateway,
    with no upstream key in the child env;
  - a native connection still bypasses the gateway.
- **Live smoke test (optional):** if you can run Claude Code against the
  gateway with a fake upstream, do it with `MEMOSYNC_ISOLATE_CLI=1` and `HOME`
  pointed at a scratch directory. Never touch the user's own `~/.claude` or
  `~/.codex`, and never use real API keys.

## Rules

- **Work only in this worktree:** `/Users/zhangbaiqiao/Developer/MemoSync-protocol-gateway`,
  branch `feat/protocol-gateway`.
- **Commits:**
  - Author: `baiqiao <771294438@qq.com>`. Pass it with `-c user.name=baiqiao -c user.email=771294438@qq.com`.
  - Messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - Only `git add` specific files.
  - Commit only when the tests are green.
  - Don't push.
- **Don't touch:**
  - `video/`;
  - the settings redesign files (`src/client/app/settings/shared.tsx`,
    `SettingsPage.tsx`, `registry.ts`, `src/client/components/brand/`),
    except the minimal `EngineCard.tsx` change above.
- **Report back:**
  - what you ported, with file mapping;
  - what you left out and why;
  - capability limits a user would hit;
  - test results;
  - anything you were unsure about.
