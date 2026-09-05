<p align="center">
  <img src="assets/icon.svg" alt="MemoSync" width="88" />
</p>

<h1 align="center">MemoSync</h1>

<p align="center">
  <strong>Co-manage your coding agent's memory: see what it remembers, decide what it keeps, choose what it uses, and audit how it used it.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
  <img alt="Bun 1.3.5+" src="https://img.shields.io/badge/bun-%E2%89%A51.3.5-f9f1e1.svg" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.8-3178c6.svg" />
  <img alt="React 19" src="https://img.shields.io/badge/React-19-61dafb.svg" />
  <img alt="Local-first" src="https://img.shields.io/badge/data-local--first-2ea44f.svg" />
</p>

<br />

<p align="center">
  <img src="docs/figures/main-ui.png" alt="MemoSync in the middle of a turn" width="960" />
</p>

<p align="center">
  <sub>MemoSync in the middle of a turn. <b>(A)</b> the pre-turn review of long-term memory, <b>(B)</b> the Memory Board, <b>(C)</b> the working memory confirmed for this turn, <b>(D)</b> inline memory citations with a Stop control, <b>(E)</b> the post-turn Memory Use Audit, <b>(F)</b> the per-turn Memory Record.</sub>
</p>

<br />

## Why MemoSync

Coding agents accumulate memory — `CLAUDE.md` files, auto-extracted notes, session summaries — but the developer rarely knows what is in it, what the agent brought into a turn, or whether the agent followed it. Memory changes behind your back, stale rules from an old project leak into a new one, and a violated constraint only shows up when the tests fail.

MemoSync is a local web workbench for coding agents that treats agent memory as a **shared, operable representation**: a store of versioned memory items that you and the agent both read, propose changes to, and act on. At every stage of a turn the system shows what changed and proposes an action; you review and decide. Nothing is written to memory, injected into a turn, or enforced on the agent without your say-so.

<p align="center">
  <img src="docs/figures/metamemory-loop.png" alt="The metamemory loop, distributed between developer and agent" width="860" />
</p>

<p align="center">
  <sub>The design borrows the <em>metamemory</em> loop from cognitive psychology: meta-level judgements <b>monitor</b> object-level memory processes and <b>control</b> them. With a coding agent, that loop is split across the human–agent boundary — the agent runs the memory processes, but the developer needs to keep the monitoring and control. MemoSync closes the loop at five points: how memory is represented, how it evolves, what is selected for a turn, how it is applied during execution, and what effect it had.</sub>
</p>

Each memory item is a one-line summary with a scope (**personal**, **project**, or **session**) plus metadata that accumulates over time: a detailed form the agent loads on demand, a version number, a status, a usage count, and a history log. The same item takes a different form at each stage of a turn — a proposal card, a working-memory row, an inline citation, an audit verdict — and two persistent views, the Memory Board and the Memory Record, carry it between turns.

## Contents

- [How a turn works](#how-a-turn-works)
  - [1 · Evolution — review changes to long-term memory](#1--evolution--review-changes-to-long-term-memory)
  - [2 · Selection — compose the working memory](#2--selection--compose-the-working-memory)
  - [3 · Execution — trace and interrupt memory use](#3--execution--trace-and-interrupt-memory-use)
  - [4 · Impact — audit memory use and enforce a rule](#4--impact--audit-memory-use-and-enforce-a-rule)
  - [Between turns — Memory Board and Memory Record](#between-turns--memory-board-and-memory-record)
- [Features at a glance](#features-at-a-glance)
- [Quickstart](#quickstart)
- [Configuration](#configuration)
- [Command line](#command-line)
- [How it is built](#how-it-is-built)
- [Development](#development)
- [Data, privacy, and usage logging](#data-privacy-and-usage-logging)
- [Acknowledgements](#acknowledgements)
- [License](#license)

## How a turn works

The walkthrough below follows a developer adding Stripe checkout to a small shop whose store already holds personal habits (`M-02` "Use pnpm, never npm"), project facts (`M-07` "Prices are stored as integer cents, never floats"), and lessons from an earlier payments project.

### 1 · Evolution — review changes to long-term memory

<p align="center">
  <img src="docs/figures/evolution.png" alt="Reviewing changes to long-term memory" width="960" />
</p>

Before a turn starts, MemoSync presents three review steps for proposed changes to long-term memory. Each change needs explicit approval before it is written to the store.

1. **Review New Memory Candidates** — items extracted from the last exchange (including the real work trajectory: files touched, commands run, errors hit), each with a proposed scope. Accept, edit, rescope, or dismiss.
2. **Memory Transfer Suggestions** — rules from *other* projects that may apply here. Copying a rule verbatim drags in source-project details, so transfer is two-staged: an **encoder** abstracts the source rule into a project-independent form, a **decoder** rewrites it against this project's memory and the current task. Source, abstract rule, and rewritten rule sit side by side so every transformation is reviewable.
3. **Review Suggested Changes to Existing Memories** — conflicts between new and old items, redundant pairs to merge, and items that have gone stale, each with a one-line reason. Repeatedly violated items surface here with a revision proposal.

### 2 · Selection — compose the working memory

<p align="center">
  <img src="docs/figures/selection.png" alt="Composing the working memory for a turn" width="960" />
</p>

**Working Memory for This Turn** opens before the agent starts. Each proposed row shows the item, its scope, and a line stating *how the agent is expected to use it* ("Compute the checkout total from stored prices, not the client payload"). Remove a row, add items from the memory pool, or adjust the selection in plain language — "Anything about the API server setup? Drop the commit-style ones" — and the in-card assistant answers with live `M-NN` chips. What you confirm is exactly what the agent is charged against later.

### 3 · Execution — trace and interrupt memory use

<p align="center">
  <img src="docs/figures/execution.png" alt="Tracing and interrupting memory application" width="960" />
</p>

As the reply streams, every place the agent applies a memory item carries an inline citation. Hover a citation for the item's content, scope, version, and usage count. Every citation includes a **Stop** control: press it when the agent does the opposite of what the item says, and the turn stops at that sentence. A recovery card quotes the sentence and asks what should have happened; write the correction, optionally tick **Enforce for this resumed run**, and the agent resumes from where it stopped. The corrected content is stored back to the item.

### 4 · Impact — audit memory use and enforce a rule

<p align="center">
  <img src="docs/figures/impact.png" alt="Auditing memory use after a turn" width="960" />
</p>

When a turn ends, the **Memory Use Audit** reports one of four verdicts for each injected item: **violated**, **shaped** the turn, **not applicable**, or **no visible effect**. To avoid relying on the agent's self-report, a separate judgment of the full exchange runs after the turn, so an item violated without being cited is still caught — verdicts are tagged **audit-found** or **self-reported**. A violated row offers **Where used** (scroll to the judged sentence and the tool call behind it) and **Enforce this next run** (the item becomes a mandatory row in the next turn's working memory that only you can remove). Verdicts are written into each item's history.

### Between turns — Memory Board and Memory Record

<p align="center">
  <img src="docs/figures/memory-board.png" alt="The Memory Board" width="960" />
</p>

The **Memory Board** shows every item as one column per scope. Drag an item between columns to rescope it (dropping into another project runs the same encoder/decoder preview as a transfer); open an item to edit its content and detailed form, change its scope, transfer or archive it, and read its full history; archived items can be restored. The **Memory files** card keeps a Markdown copy of the board in sync, so the accumulated memory stays usable with `CLAUDE.md`-style files and other agents, and can import an existing configuration file as candidates for review.

The **Memory Record** in the sidebar lists, for each turn of a session, what was proposed, selected, cited, interrupted, and audited. It persists independently of the agent's context window, so after the conversation is compacted both you and the agent can still refer to it.

## Features at a glance

- **Versioned memory items** — one line each, optional detail loaded on demand, scoped to personal / project / session, with status, usage count, and full history with revert.
- **Mixed-initiative review at every stage** — the system proposes, you decide: candidates, transfers, conflicts/redundancy/staleness, per-turn selection, audit follow-ups.
- **Cross-project transfer** with an encoder/decoder pair that abstracts and re-localizes rules instead of copying them.
- **Inline citations with per-citation Stop**, correction-and-resume, and one-run enforcement.
- **Independent post-turn audit** with four verdicts and source tags (audit-found / self-reported).
- **Memory Board + Memory files** — drag-to-rescope, search, archive/restore, Markdown projection that syncs both ways, import of existing config files.
- **Memory Record** — a per-turn ledger that survives context compaction.
- **Cache-friendly injection** — memory rides the session as a stable snapshot plus per-turn deltas, so editing memories never rebuilds the agent's prompt cache.
- **Model choice per chat** — DeepSeek V4 Flash / V4 Vision / V4 Pro, optionally GLM-5.3-Flash, with a thinking-strength switch.
- **A full coding workbench underneath** — project-first sidebar, plan mode, rich transcript rendering, embedded terminal, file and git panels, session resumption, local-first persistence.

## Quickstart

Requirements: [Bun](https://bun.sh) 1.3.5 or newer, and a DeepSeek API key from [platform.deepseek.com](https://platform.deepseek.com). No Claude Code install or login is needed — MemoSync bundles the agent runtime and points it at DeepSeek's Anthropic-compatible endpoint.

```bash
git clone <this repository> MemoSync
cd MemoSync
bun install
cp .env.example .env      # then set DEEPSEEK_API_KEY
bun run build
bun run start
```

MemoSync opens at [`localhost:3210`](http://localhost:3210). Add a project folder, send a message, and the first review cards appear before the agent's first turn.

If Bun is not installed:

```bash
curl -fsSL https://bun.sh/install | bash
```

A step-by-step guide in Chinese, written so that an AI coding assistant can execute it end to end, is in [docs/DEPLOY.zh-CN.md](docs/DEPLOY.zh-CN.md).

## Configuration

All configuration is read from `.env` in the project directory (see [`.env.example`](.env.example)).

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | — | **Required.** Runs both the chat engine and the memory passes. |
| `DEEPSEEK_MODEL` | `deepseek-v4-flash` | Default chat model; each chat can switch to `deepseek-v4-flash-vision-exp` or `deepseek-v4-pro` in the picker. |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | Override for proxies or compatible endpoints. |
| `PORT` | `3210` | HTTP port. |
| `GLM_API_KEY` | — | Optional. Enables GLM-5.3-Flash in the picker; only chats that pick a GLM model use it. |
| `GLM_BASE_URL` | `https://open.bigmodel.cn/api/anthropic` | GLM endpoint (`https://api.z.ai/api/anthropic` for the international service). |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | `786432` | Token count at which the engine auto-compacts the conversation. MemoSync selects the 1M context window on every DeepSeek session; a "Context compacted" marker appears in the transcript when compaction happens. |
| `MEMOSYNC_USE_OWN_ANTHROPIC` | — | Set to `1` to run the chat engine on your own exported `ANTHROPIC_*` variables (a real Anthropic key or another Anthropic-compatible endpoint) instead of the derived DeepSeek bundle. |

With `DEEPSEEK_API_KEY` set, MemoSync derives the whole `ANTHROPIC_*` bundle itself and ignores leftover `ANTHROPIC_*` / `CLAUDE_CODE_*` exports from other Claude Code setups in your shell, so a stray `ANTHROPIC_BASE_URL` cannot hijack the engine.

The chat model picker is two-level: choose a vendor on the left (DeepSeek, GLM) and a model on the right. Thinking strength (High / Max) is set per chat.

## Command line

```bash
bun run start                  # localhost:3210, opens the browser
bun run start --port 4000      # custom port
bun run start --no-open        # do not open the browser
bun run start --remote         # bind 0.0.0.0 for LAN / Tailscale access
bun run start --password <s>   # require a password before the app loads
bun run start --share          # temporary public trycloudflare.com URL + QR code
bun run export-data [--full]   # bundle local data into a tar.gz (see below)
```

## How it is built

- **Stack.** React 19 + TypeScript on the client, Bun on the server. Memory items and their histories live in SQLite; projects, chats, and transcripts are append-only JSONL logs with snapshot compaction.
- **Agent runtime.** The coding agent is the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) (which bundles Claude Code), driven through its `query()` interface with an asynchronous prompt queue, session fork handles, system prompts, MCP servers, and tool permissions. MemoSync points it at DeepSeek's Anthropic-compatible endpoint, selects the 1M-token context window, and keeps auto-compaction on so long sessions keep going.
- **Memory tools.** The agent sees the memory store through an MCP server: `load_memory_detail` fetches an item's detailed form on demand and `propose_memory` lets the agent nominate a candidate mid-turn (it still goes through your review).
- **Memory passes without a second model.** Candidate extraction, transfer encoding/decoding, conflict/redundancy/staleness checks, expected-use statements, and the post-turn audit run on a **fork of the live session** using the SDK's fork mechanism. Forks share the main session's context prefix, so they benefit from prompt caching and see the whole project context. When no session exists to fork (for example before the first turn), a pass falls back to a direct DeepSeek JSON call with the same key.
- **Cache-friendly injection.** The memory block rides the session as a stable snapshot plus small per-turn deltas, so editing an item never invalidates the agent's prompt cache.
- **Local-first.** Everything is stored under `~/.memosync/data/`; there is no server component beyond the local Bun process.

```
src/
├── client/                React UI
│   ├── app/               Router, pages (chat, Memory Board, settings), central state
│   ├── components/        Transcript messages, memory cards and gates, chat chrome
│   └── stores/            Zustand stores
├── server/                Bun backend
│   ├── agent.ts           Turn coordination: review gates, injection, interrupt/resume, post-turn passes
│   ├── deepseek-engine-env.ts   Derives the engine's ANTHROPIC_* bundle from DEEPSEEK_API_KEY
│   ├── chat-providers.ts  Per-chat vendor routing (DeepSeek / GLM)
│   ├── memory/            The memory engine
│   │   ├── MemoryStore.ts     Versioned items, events, relations (SQLite)
│   │   ├── capture.ts         Candidate extraction and routing
│   │   ├── checkup.ts         Conflict / redundancy / staleness / promotion checks
│   │   ├── relevance.ts       Per-turn suggestion and expected-use planning
│   │   ├── trace.ts           Post-turn memory-use audit
│   │   ├── transfer.ts        Cross-project transfer (encoder / decoder)
│   │   ├── injection.ts       Snapshot + delta injection planning
│   │   ├── fork-query.ts      Out-of-band questions on a fork of the session
│   │   └── tools.ts           MCP tools exposed to the agent
│   ├── event-store.ts     JSONL persistence, replay, and compaction
│   └── ws-router.ts       WebSocket routing and subscriptions
└── shared/                Types, protocol, tool hydration
```

## Development

```bash
bun run dev          # client (5174) + server (5175) with hot reload
bun test src/        # unit + integration suite (LLM passes are stub-injected; no network)
bun run check        # typecheck + both client builds
```

End-to-end scripts under `scripts/` (`e2e-claude-memory.ts`, `e2e-full-app.ts`, `e2e-memory-matrix.ts`, `ui-flows-check.ts`) drive a live instance with real model calls and are not part of `bun test`.

## Data, privacy, and usage logging

Everything MemoSync produces stays on your machine under `~/.memosync/data/`: the memory store (`memory.sqlite`), its Markdown projection (`memories/`), the chat and project logs, and a local usage log (`experiments/events.jsonl`) that records how the memory features are used — reviews, injections, citations, interrupts, audits, panel visibility — stamped with a random per-install id. **Nothing is uploaded automatically.**

```bash
bun run export-data          # usage log + memory library
bun run export-data --full   # additionally chat/session logs and transcripts
```

The default bundle deliberately excludes chat transcripts and project logs; `--full` is opt-in. See [docs/DATA_AND_TELEMETRY.md](docs/DATA_AND_TELEMETRY.md) for the exact file layout and event families.

## Acknowledgements

MemoSync builds on [Kanna](https://github.com/jakemor/kanna), an open-source agent workbench, and on the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript). The default models are served by [DeepSeek](https://platform.deepseek.com); GLM models by [Zhipu AI](https://bigmodel.cn).

## License

[MIT](LICENSE)
