# Native file actions

`memosync_open_file` requests a bounded, immutable, read-only source or Markdown
snapshot in the originating MemoSync window. `memosync_action_status` reads its
durable receipt. Acceptance means the request was admitted; only the matching
GUI acknowledgement records presentation. Neither is evidence that a person
read the file. Without an eligible originating client the result is unavailable.

All four adapters retain their native execution loops and session mechanisms:

- Claude joins an echoed SDK input UUID to its native `tool_use` ID, then joins
  that ID to the SDK MCP handler's `claudecode/toolUseId` metadata. The dispatch
  closure belongs to the submitted prompt. Unknown inputs and subagent calls
  cannot acquire the foreground window. Cancelled/completed prompts are revoked.
- OpenCode submits a unique native message ID. A private, temporary native
  `tool.execute.before` plugin obtains a ticket only after the authenticated
  event stream identifies the same session, call and assistant's prompt parent.
  The ticket binds the validated arguments and original dispatch. Ordinary MCP
  credentials cannot mint tickets. Native permission checks still run before
  the MCP tool executes. Replacing or finishing a turn invalidates its tickets.
- Codex uses its app-server process/thread/turn/call identity; Pi uses its native
  session/custom-tool callback identity.

Identity fields are never requested from the model. Memory-disabled turns still
have file actions. Each adapter feeds the existing host-action service, which
retains workspace-host resolution, window authentication, durable idempotency,
snapshot integrity and cancellation/presentation rules. Manual editable tabs
remain independent from agent-requested snapshots.

The first turn resolves its executable version before freezing the capability
revision. Later policy/version changes invalidate admission rather than rebinding
an old operation. Unverified runtime versions report unknown capability.

## Evidence and reproduction

Native loopback probes cover Claude Agent SDK 0.3.241 with Claude Code 2.1.241
and 2.1.325, and OpenCode 1.17.4 and 1.19.5. They use temporary profiles,
synthetic files and a scripted Anthropic-compatible endpoint. They verify actual
native tool IDs (including concurrent calls with identical arguments), durable
receipts, OpenCode slash-command prompt parents, and the acceptance/presentation distinction. They do not establish
external inference quality or provider cache behavior. OpenCode may install its
own plugin dependencies on the first plugin load.

```sh
# Explicit paths prevent tests from accidentally using account configurations.
MEMOSYNC_CLAUDE_TEST_BIN=/absolute/path/to/claude \
MEMOSYNC_OPENCODE_TEST_BIN=/absolute/path/to/opencode \
bun test src/server/host-actions.native.test.ts

bun test src/server/claude-host-actions.test.ts \
  src/server/opencode-host-actions.test.ts src/server/host-actions.adapters.test.ts \
  src/server/host-actions.integration.test.ts src/server/host-actions.test.ts \
  src/server/opencode-agent.test.ts src/server/claude-execution-policy.test.ts
```

The offline regressions cover callback/stream reordering, forged/missing
identity, cross-session and old-parent calls, cancelled/completed prompts,
dispatch replacement during a pending binding, policy revocation, duplicate
delivery, disconnects, late presentation acknowledgements and dirty-buffer
isolation in the existing workbench tests.
