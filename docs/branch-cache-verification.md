# Memory branch prefix verification

The implementation preserves the recorded parent launch and enforces read-only tool execution. **The literal all-engine byte-identical acceptance condition is not fully met:** Codex's server-side web tool must still be removed. The default smoke intentionally exits 1 and reports this difference. This is the safety-first exception allowed by requirement 3, not a cache-equivalence pass.

## Engine results

| Engine | Before | Now | Enforcement |
| --- | --- | --- | --- |
| Claude | Reduced tools, missing memory MCP, branch system append, synthetic StructuredOutput tool, no settings sources | Parent model/effort, tools, system append, settings sources and memory MCP schemas retained. Branch contract/schema/budget are user-message text. | Programmatic SDK PreToolUse denies all except Read/Glob/Grep and allowlisted Bash. Disk hooks disabled; callback gate still runs. Memory MCP uses fresh transports and inert handlers. |
| Codex | Cleared dynamic tools, branch developer instructions, schema output, disabled MCP/web/subagents, read-only sandbox | Retains parent model/effort, developer instructions, collaboration mode and dynamic schemas. Contract/schema move to user text. Read-only sandbox and external-tool restrictions retained. | Native PreToolUse command gate with a process-local declaration trust hash; memory dispatch also denies. Native sandbox remains read-only and approvals are never granted. |
| Pi | Reduced tools changed generated system prompt | Full parent built-ins and memory schemas, effective model metadata/effort and frozen system prompt retained | Agent.beforeToolCall blocks write/edit/bash/memory/unknown tools before execution; per-request read budget lives in this gate. Memory dispatch also denies. |

Snapshots are held per chat and session token in the coordinator, not serialized with credentials. They follow Claude model/permission updates and Pi's effective effort normalization. Branches copy the snapshot at creation. A server restart or an old session without a captured launch retains a safe fallback; exact cache equivalence is **not** promised for that case. First-turn branches have no parent history to reuse.

Claude preserves configured MCP discovery through the parent's setting sources and recreates MemoSync's in-process MCP server from its original specs. The smoke exercises the MemoSync MCP definitions, not arbitrary third-party servers. Changes to external configuration/resources while a Claude parent remains open can still change what a newly forked CLI discovers.

## Installed-runtime evidence

Validated on macOS arm64 with Claude Agent SDK **0.3.241 / bundled Claude Code 2.1.241**, Codex **0.165.0-alpha.1.2**, and Pi **0.73.1**. The smoke uses the bundled platform Claude binary, not a separately installed `claude` from PATH. Codex is the installed `codex` executable.

Claude's installed `sdk.d.ts` declares `Options.hooks`, `PreToolUseHookSpecificOutput.permissionDecision`, and Settings.disableAllHooks. The installed `sdk.mjs` routes `hook_callback` control requests to registered callbacks. The bundled CLI is native compiled code, so its permission ordering cannot be honestly claimed as a readable-JavaScript source audit. The executable proof uses user settings allowing Write/Bash/memory, the parent's acceptEdits mode, and disableAllHooks=true simultaneously: every requested Write/Bash/memory/web call returns the branch deny message, and neither sentinel file exists. Tools, system, earlier messages (including cache markers), model and thinking/effort options match the parent's next request exactly.

Pi's installed `pi-agent-core/dist/agent-loop.js`, `prepareToolCall`, calls `beforeToolCall` before `executePreparedToolCall`. `{ block: true }` produces an error result; exceptions also produce an error result. `pi-coding-agent/dist/core/agent-session.js` installs its own hook; MemoSync chains it **after** its branch guard. The real-SDK smoke also changes AGENTS.md after the parent launch and proves the recorded system prompt is retained by the branch.

Codex's installed protocol was generated with `codex app-server generate-ts --experimental`. A normal fork retains history but does not promise a byte-identical request. Its newer experimentalPredictionMode requires a loaded, ephemeral parent fork and disallows the safety configuration overrides needed here. The installed protocol's fork no longer declares dynamicTools; it inherits them from the parent. MemoSync retains the field for older supported protocols, and the native smoke proves the inherited memory schema remains present.

The following official source was inspected at commit `13ab0b254e7b9ed0ab473d38d978fa100bf417ae` (source evidence complements, rather than substitutes for, the installed-binary test):

- [Hook discovery and trust](https://github.com/openai/codex/blob/13ab0b254e7b9ed0ab473d38d978fa100bf417ae/codex-rs/hooks/src/engine/discovery.rs): session-flag hooks need an enabled state and matching declaration hash; adding a hook alone silently leaves it untrusted.
- [Configuration fingerprint](https://github.com/openai/codex/blob/13ab0b254e7b9ed0ab473d38d978fa100bf417ae/codex-rs/config/src/fingerprint.rs): sorted JSON SHA-256 over the normalized TOML identity. Only the host-generated guard is trusted, through fork config; no user file/account setting is edited.
- [PreToolUse decisions](https://github.com/openai/codex/blob/13ab0b254e7b9ed0ab473d38d978fa100bf417ae/codex-rs/hooks/src/events/pre_tool_use.rs): explicit deny blocks execution. Hook errors/malformed output fail open; the implementation therefore retains native read-only sandboxing and removes external capabilities. The command gate is verified on the installed version, not promised for unsupported CLI versions/policies.
- [Tool router](https://github.com/openai/codex/blob/13ab0b254e7b9ed0ab473d38d978fa100bf417ae/codex-rs/core/src/tools/router.rs): WebSearch is a server-side tool specification, not an ordinary local function protected by this hook.

Native captured Codex requests show the read-only permissions and environment messages **appended after all inherited history**. They do not rewrite the original permissions message. Keeping the original developer instructions avoids an unnecessary collaboration-mode update. Tool schema removal happens at `tools[9]` in this fixture and breaks the earlier prefix. Configured external MCP/subagent removal may introduce additional tool differences in other profiles; those restrictions intentionally remain.

Codex regenerates some message `id` fields across processes/forks. The smoke preserves raw bodies in its artifacts and excludes only these top-level item IDs when comparing history content. It does not normalize tools, schema text, instructions, model, reasoning, or the actual message content. This is a content-prefix proof, not literal JSON-body byte equality.

## Reproduction

All upstreams bind 127.0.0.1; credentials and CLI homes are temporary/fake. No paid inference is used. Requests are saved in the printed temporary evidence directory.

```sh
bun run check
bun test src/
bun scripts/smoke-branch-prefix.ts
bun scripts/smoke-branch-prefix.ts --codex-no-web
```

Default smoke (exit 1, expected unresolved safety exception):

```text
Claude PASS: tools (including memory MCP), system, history, model/effort; Write/Bash/memory/web denied despite allow rules + disableAllHooks
Codex PREFIX FAIL: $.tools[9] (server-side web_search removed for safety); SAFETY PASS: native hook denies command + memory calls
Codex HISTORY PASS: sandbox/environment changes append after history; generated message IDs excluded from content comparison
Pi PASS: real SDK requests have identical tools/system/history/model/effort; write/bash/memory denied
```

`--codex-no-web` starts the *temporary parent fixture* with web search disabled. It does not change production main-session settings. This case exits 0 and reports `Codex PREFIX PASS (parent web disabled)`; it demonstrates that the local function/dynamic schemas and historical content remain compatible when the parent already lacks the unguardable server tool.

The script runs real MemoSync `startClaudeSession`, `CodexAppServerManager.startSession/startTurn`, and `PiAgentManager.startTurn` launch paths followed by `createMemoryBranch`. Pi is covered by actual captured OpenAI-compatible requests, not just a mock unit test. Unit tests additionally cover coordinator snapshot propagation, all three engine launch-option matches, read budgets/schema repair, and rejection of write/Bash/memory calls.

## Final validation

- `bun run check`: exit 0 (TypeScript and both production bundles).
- `bun test src/`: 1,968 pass, 4 existing skips, 0 failures; 1,972 tests across 191 files.
- Default native smoke: exit 1, with the exact documented Codex `$.tools[9]` difference; Claude/Pi and all denial probes pass.
- Native smoke with `--codex-no-web`: exit 0; all three engines pass the stated content-prefix comparisons.
- `git diff --check`: clean.

The first full test run preceded the build and failed two integration tests because the client/export bundles did not exist. Both passed after the required build; no unrelated application code was changed to address them.

## Remaining acceptance gaps

- Default Codex tools are not cache-identical while server-side web search is enabled in the parent. Enabling that tool on a branch would violate the requested read-only/no-web contract.
- Codex's generated transport IDs prevent literal request-body byte equality even in the no-web case. Prompt content is separately verified.
- Old/restarted sessions without an in-memory launch snapshot, and externally changed Claude settings/MCP discovery, do not have an exact-prefix guarantee.
- Native hook behavior/trust is version-sensitive. Codex's sandbox/external-tool restrictions remain necessary; an arbitrary hook-runtime failure is not a proof that all non-allowlisted commands are intercepted.
