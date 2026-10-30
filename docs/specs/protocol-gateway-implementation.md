# Protocol gateway implementation

Implemented for `feat/protocol-gateway`, following `protocol-gateway.md`.

## Source mapping

Magpie source: commit `cc81ad4ea1ee6a4ceb2e2d4b93f4402332cb7100` from the
local checkout named in the task. All paths below are under
`src/server/model-access/gateway/`.

| MemoSync file | Magpie `internal/gateway/` source | Ported behavior |
| --- | --- | --- |
| `index.ts` | `gateway.go` | Messages/Responses route dispatch, upstream request and translated reply orchestration |
| `request.ts` | `ir.go`, `anthropic.go`, `responses.go`, `chat.go` | Shared text/reasoning/tool request shape, parsing, Chat encoding |
| `stream.ts` | `sse.go`, `chat.go`, `anthropic.go`, `responses.go` | SSE framing, choice locking, reasoning, tool argument deltas, parallel call serialization, usage and terminal events |
| `custom-tool.ts` | `responses.go`, `custom_tool.go` | Custom tool input schema and incremental JSON string decoding |
| `translation.test.ts`, `fixtures/magpie-streams.json` | `translate_stream_test.go` | Original stream chunks and translated assertions for both clients |
| `gateway.test.ts` | `translate_stream_test.go`, `translate_severed_test.go`, `call_args_stream_test.go` | Local HTTP integration, incomplete stream failures, early tool deltas |
| `custom-tool.test.ts` | `call_args_stream_test.go` | Custom input escape/Unicode fragmentation fixtures |

Every ported TypeScript file has the attribution header. JSON fixture attribution
and the one Go/JavaScript string-semantics difference are documented in
`fixtures/README.md`. All ported files are listed in `THIRD_PARTY_NOTICES.md`.

## Integration and isolation

- Native endpoints always take precedence. Pi continues to use its native protocols.
- Claude and Codex fall back to Chat through one lazily started Bun listener on
  `127.0.0.1` with an OS-assigned port. Each service/connection/target has its own
  stable route; requests cannot choose another upstream URL.
- The listener requires a random per-process token. Child env/argv contain the
  gateway URL and token, not the upstream key. Credentials are read from the
  service on each request, so rotation and deletion take effect for existing routes.
- Connection profiles remain MemoSync-owned. Redirects are rejected before any
  credential forwarding. Upstream error bodies are not exposed because vendors
  can echo credentials; the HTTP status and protocol-shaped error are retained.
- The listener is stopped during application shutdown. Stream cancellation aborts
  the upstream request; downstream demand controls streaming reads.
- Shared compatibility is used in engine setup/status, connection testing,
  settings selection, the composer picker, and the server model catalog.
- The only settings layout edit is the connection-row translation note, with
  `via translation` / `经协议转换`. No settings redesign files or `video/` are changed.
- Connection testing still probes the selected upstream protocol natively.

## Deliberate limits and omissions

- Only Messages-to-Chat and Responses-to-Chat are translated. There is no
  Messages-to-Responses, Responses-to-Messages, or Pi translation.
- Inputs are text, exposed reasoning, function calls/results, and Responses
  custom tools (including namespaces). Custom tools become functions with a
  string `input`; their grammar is carried as instructions, not enforced by
  Chat's function schema. Returned calls are restored to the client's tool type.
- Images, files, audio, server-side tools, tool-search items, encrypted/redacted
  reasoning and other unsupported typed content are rejected with a clear 400.
- Responses is stateless: send full input history. `previous_response_id`,
  server conversations and background mode require a native endpoint.
- There is no token-count endpoint, WebSocket transport, stored-response lookup,
  subscription bridge, account routing, affinity, advisor, prompt-cache policy,
  retry/failover, vendor-specific thought tags, or vendor-specific request fixes.
  These are outside the two requested protocol paths.
- Reasoning is limited to what the Chat endpoint exposes in `reasoning_content`
  or `reasoning`; no thinking is fabricated. Standard token usage and reported
  cached/reasoning token counts are mapped, with unknown counts left at zero.
- Interleaved secondary tool calls are held until they can be emitted as complete,
  separate blocks/items. The first call's arguments stream immediately.
- Upstream must honor streaming and return SSE. Non-streaming client requests are
  collected from that stream. An incomplete stream fails, including for buffered
  clients, instead of synthesizing a successful completion.
- Vendor-specific model/tool compatibility is not claimed by fake-upstream tests.
  The optional real Claude Code smoke validates the installed bundled CLI against
  the gateway; it does not establish compatibility with a live vendor.

## Observed compatibility differences

- The installed Claude Agent SDK's bundled CLI appends turn-level `system`
  messages inside `messages`, in addition to the top-level system prompt.
  These are preserved as Chat system messages at the same position; a regression
  test covers the observed shape. This was found by the optional real-CLI smoke.
- macOS scratch paths can resolve from `/var` to `/private/var`. Runtime isolation
  assertions compare canonical paths rather than treating that alias as a failure.
- The existing catalog test expected Codex to exclude Chat-only connections.
  Its assertion now verifies that both connection identities are available.
- Full server tests depend on `dist/client/index.html`. The required build and
  full test suite are run sequentially, after an initial concurrent run exposed
  that dependency; no application change was needed for that build/test ordering.

## Verification

Final validation on 2026-10-30, Bun 1.3.10:

| Command / check | Result |
| --- | --- |
| `bunx tsc --noEmit` | Passed |
| `bun run check` | Passed: typecheck, client production build, export-viewer build |
| `bun test src/` | 1984 passed, 4 skipped, 0 failed; 194 files |
| Gateway tests within that suite | 63 passed: 26 HTTP/runtime tests, 36 translation tests, 1 custom-input test |
| `MA_UI_SKIP_SCREENSHOTS=1 bun test ./src/client/model-access/modelAccess.browser.ts` | 14 passed; English/Chinese translation screenshots inspected |
| `bun scripts/smoke-protocol-gateway.ts` | Passed: real bundled Claude Code, exit 0, one fake-upstream request, `GATEWAY_SMOKE_OK` |
| `git diff --check` | Passed |

The four full-suite skips belong to the existing Next 15 preview fixtures, not
the gateway. Builds report existing Browserslist-data, Node deprecation and
large-chunk notices; they do not fail the checks.

Screenshots: `output/playwright/protocol-gateway/translation-en.png` and
`translation-zh.png` (local generated artifacts, not committed).

The live smoke sets `MEMOSYNC_ISOLATE_CLI=1`, gives the subprocess a scratch
`HOME`, a MemoSync-owned profile and an explicit environment, and disables tools
and user settings. It uses the SDK-bundled executable, so a different locally
installed Claude binary is not substituted implicitly. The fake model is not in
Claude's model catalog; its expected `unrecognized_model` diagnostic does not
prevent successful completion. No real provider keys, user CLI profiles, logins,
or paid upstream calls are used.

No mandatory work remains. Live vendor behavior remains unverified because all
upstreams used in verification were local fakes. No push or deployment is made.
