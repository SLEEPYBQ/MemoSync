# MemoSync memory branches

The normal MemoSync application uses the selected coding CLI for memory reasoning. It does not require a DeepSeek sidecar key. The experimental Auto and Static implementations retain their separate legacy paths.

## Turn lifecycle

1. `AgentCoordinator` starts C (candidate extraction and routing), T (portable-rule extraction, relevance, localization and landing), and M (conflict, redundancy and staleness) together against the same main-session handle and project snapshot.
2. The UI presents Candidate, Transfer and Change reviews sequentially. Candidate decisions continue both T and M. Transfer decisions continue M. Follow-ups resume each original child session and merge stable-ID proposal deltas, including accepted edits, discarded candidates, acknowledged relations and declined transfers.
3. Approved changes are persisted by the existing memory store and review routes. Version and dependency checks reject obsolete results. A separate W conversation selects working memory from the updated store and supplies each item's expected use. Manual planning and natural-language adjustments continue W. Provider failure is displayed as a failed selection with retry controls.
4. Confirmed memories form the main Memory Block. Claude receives a selected boot snapshot and later deltas; Codex receives the selected block, expected uses and enforced items in per-turn `developer_instructions`. Detail tools are restricted to that turn's confirmed IDs. Memory reasoning never enters the main transcript.
5. After successful execution, A forks the completed main session. It audits every injected item against the actual delivered memory snapshot and this turn's reply, tool calls and results. The existing persisted labels map to **Shaped**, **Not applicable**, **No visible effect**, and **Violated**. Malformed or incomplete audit output is a failed audit, not a fabricated verdict. Version checks discard verdicts for memories edited during auditing.
6. A tool-based verdict may contain a validated `toolId` and quote. **Where used** reveals the virtualized transcript row, expands its tool group and body, and highlights that evidence. The citation parser and citation rendering are unchanged. Enforce-next-turn and interruption/correction work with both normal-deployment engines; controlled-study provider restrictions remain unchanged.

Read-only branches retain file search, file reading and bounded read-only shell inspection. They cannot edit the project or commit speculative memory changes. Claude branches load no inherited MCP servers, hooks or plugins. Codex branches read the effective configuration, disable each configured MCP server through per-thread overrides, and disable native subagents and web search; failure to establish these restrictions blocks startup. These overrides do not edit the user's CLI configuration. Cancelling preparation aborts the provider calls and prevents late branch results from advancing a cancelled turn.

## Analysis budgets

Each branch request has a 120-second deadline and a bounded allowance. These limits apply to C/T/M/W/A and auxiliary memory analysis, independently of the main coding agent.

| Request | Model/visible step limit | Read-tool allowance |
| --- | ---: | ---: |
| Initial analysis | 6 | 4 |
| Review or working-memory adjustment | 3 | 1 |
| One schema-only correction | 2 | 0 |

Claude enforces the model-turn limit through SDK `maxTurns` and checks every read call before permission, including parallel calls. Its `StructuredOutput` completion tool does not consume the read allowance. Codex has no native model-turn limit in the app-server interface: MemoSync counts distinct streamed tool calls and completed assistant messages as visible steps, then interrupts and closes on overflow. A native Codex command may already have started when its event arrives, and hidden provider retries are not visible to this counter. The read-only sandbox and deadline remain in force.

Review messages reuse saved analysis rather than restarting project exploration. Only one schema correction is permitted; a second malformed result fails. Budget or provider failures remain visible instead of producing fabricated empty proposals or audit verdicts.

## Runtime boundary

Claude branches use SDK `query({resume, forkSession: true})` once, then `resume` the returned child session. Codex uses `thread/fork` once and subsequent turns on that child. Both keep the parent unchanged.

Before the first main turn, there is no persisted Claude session to fork. Even SDK initialization on an empty asynchronous prompt queue creates no session JSONL. These initial branches start with the same empty history, project tools and new-task input; the `memory.branch` event explicitly records `mode: "empty-history"`. Later branches record `mode: "fork"`. Missing or invalid existing parent handles produce an error rather than silently starting a fresh conversation. No synthetic warm-up turn or fabricated SDK transcript is inserted into the main conversation.

Session forking preserves available parent history. Actual prompt-cache reuse and latency depend on provider/runtime behavior and are not guaranteed by this implementation.

## Isolation and verification

`MEMOSYNC_ISOLATE_CLI=1` uses separate app-specific `CLAUDE_CONFIG_DIR` and `CODEX_HOME` directories. Credentials are explicitly supplied to child processes; inherited OAuth/provider settings are removed. The profile must be outside personal Claude/Codex configuration directories. The GLM key stays in the local environment and is never a source-code constant or a model prompt.

```bash
bun run check
bun test
bun run scripts/smoke-isolated-branches.ts
bun run scripts/smoke-memosync-pipeline.ts claude
bun run scripts/smoke-memosync-pipeline.ts codex
```

The transport smoke creates temporary profiles, verifies inherited context and real project reads across three concurrent branches, resumes a review in its original branch, checks W/A, and proves that branch-only review content does not reach the resumed main conversation. The application smoke exercises the real coordinator, memory services and parsers over two turns with a forbidden sidecar caller. It automatically reviews only the temporary test memories. Offline integration tests cover both engines, cancellation, failed selection/retry, audit evidence and interruption/resume.

The audit evidence navigation was also checked in Chromium against the actual virtualized transcript components, including a previously unmounted row inside a collapsed tool group. This verifies navigation behavior, not a redesign of visual styling.

Validation on 2026-09-10: `bun run check` passed; the full suite reported 2,194 passing tests, 4 skipped, and no failures. GLM transport checks passed for both CLI engines. Both two-turn application smokes passed with 10 branch conversations, 6 real forks, and zero sidecar calls per engine; every request used the budgets above. A separate real Codex startup check used a dummy key and no model turn to confirm that a configured MCP server was not started under the branch overrides. Temporary CLI profiles and test projects were removed after verification.

Primary references: [Claude SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions), [Claude SDK TypeScript options](https://code.claude.com/docs/en/agent-sdk/typescript), [Codex app-server](https://developers.openai.com/codex/app-server/), [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference), and [GLM Coding Plan models and endpoints](https://docs.bigmodel.cn/cn/coding-plan/latest-model).
