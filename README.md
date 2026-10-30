<p align="center">
  <img src="assets/icon.svg" alt="MemoSync" width="88" />
</p>

<h1 align="center">MemoSync</h1>

<p align="center">
  <strong>See what your coding agent remembers, decide what it keeps, choose what it uses, and check how it used it.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
  <img alt="Bun 1.3.5+" src="https://img.shields.io/badge/bun-%E2%89%A51.3.5-f9f1e1.svg" />
  <img alt="Local-first" src="https://img.shields.io/badge/data-local--first-2ea44f.svg" />
</p>

<p align="center">
  <b>English</b> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="docs/figures/main-ui.png" alt="MemoSync in the middle of a turn" width="960" />
</p>

https://github.com/user-attachments/assets/488a1e41-5a01-4c01-ac76-5c37b8e764f0

---

Coding agents keep memory: `CLAUDE.md` files, notes they extract, lessons from earlier sessions. You rarely see what is in it, what the agent took into this task, or whether it followed it. MemoSync is a local workbench for Claude Code, Codex and Pi that puts that memory on screen.

- Every change to memory waits for your review.
- Before each turn, you confirm what goes in.
- While the agent works, its replies cite the memories they use.
- After the turn, a separate check reports what was followed and what was ignored.

<p align="center">
  <img src="docs/figures/metamemory-loop.png" alt="Monitoring and control of memory, shared between developer and agent" width="820" />
</p>

## A turn with memory

Memory is a set of short items. Each has a scope (**personal**, **project** or **session**), a version and a history. The same item shows up in four places during a turn.

### 1. Review what the agent learned

<p align="center"><img src="docs/figures/evolution.png" alt="Reviewing proposed memory changes" width="900" /></p>

Before a turn starts, MemoSync shows the memory changes it proposes, in three groups. Accept, edit, rescope or dismiss each one. Nothing reaches the store until you do.

- **New candidates:** taken from your last exchange and from what the agent actually did (files, commands, errors).
- **Transfers from other projects:** a rule from another project is first rewritten in general terms, then adapted to this project. You see all three versions side by side.
- **Fixes to existing items:** conflicts, duplicates to merge, and rules that have gone stale or keep being broken.

### 2. Choose the working memory

<p align="center"><img src="docs/figures/selection.png" alt="Choosing working memory for a turn" width="900" /></p>

**Working Memory for This Turn** lists the items the agent intends to use, each with one line saying how. Remove rows or add others from your library. You can also ask in plain words, for example "drop the commit-style ones". The agent starts only after you confirm, and the audit later checks it against exactly this list.

### 3. Follow it while it works

<p align="center"><img src="docs/figures/execution.png" alt="Inspecting a citation and stopping the turn" width="900" /></p>

Replies cite the memories they apply (`M-07`). Hover a citation to see the item.

If the agent is doing the opposite of a memory:
1. Press **Stop** on that citation.
2. Write what should have happened.
3. Optionally enforce the item for the rest of the run.

The agent resumes from the sentence where you stopped it, and your correction is saved to the item.

Citations are what the agent says it used, not proof that it did. That is why step 4 exists.

### 4. Check the result

<p align="center"><img src="docs/figures/impact.png" alt="Memory use audit after a turn" width="900" /></p>

When the turn ends, a separate pass reads the whole exchange and rates every selected item: **violated**, **shaped** the turn, **not applicable**, or **no visible effect**. Each verdict says whether the audit found it or the agent reported it, so a violation the agent never cited still shows up.

For a violated item:
- **Where used** jumps to the sentence and tool call behind the verdict.
- **Enforce this next run** makes the item a required row in the next turn. Only you can remove it.

The audit is a model judgment and can be wrong.

### Between turns

<p align="center"><img src="docs/figures/memory-board.png" alt="The Memory Board" width="900" /></p>

**The Memory Board** is the whole library, one column per scope.
- Drag an item to change its scope.
- Open an item to edit it, read its history, or archive it.
- **Memory files** keeps a Markdown copy for other tools, and imports an existing `CLAUDE.md` as candidates for review.

**The Memory Record**, on the right of every chat, logs each turn: what was proposed, selected, cited, stopped and audited. It survives context compaction, so you and the agent can still refer back to it.

## Quick start

You need [Bun](https://bun.sh) 1.3.5 or newer, plus one of:
- Claude Code or Codex already signed in, or
- an API key from any provider.

```bash
git clone https://github.com/SLEEPYBQ/MemoSync.git
cd MemoSync
bun install
bun run build
bun run start
```

MemoSync opens at <http://localhost:3210>. Then:

1. Open **Settings → Models**, pick an engine and give it access (see the next section).
2. Click **+** in the sidebar, then **Add project** to open a folder.
3. Send a task. Your library starts empty, so the first turns are mostly proposals. Review them, and the memory builds up as you work.

## Connect a model

An **engine** is the agent that does the work. **Access** is how it reaches a model. Both are set in **Settings → Models**.

| Engine | What it runs | Access |
| --- | --- | --- |
| **Claude Code** | Your installed `claude`, or the copy bundled with the Agent SDK | Your sign-in, or an API connection that speaks the Anthropic API |
| **Codex** | Your installed `codex` (required) | Your sign-in, or an API connection that speaks the OpenAI Responses API |
| **Pi** | Built into MemoSync | An API connection that speaks OpenAI Chat or Responses |

**Your sign-in.** The engine uses the login and settings you already have, and MemoSync adds nothing to them. If the engine shows **Not signed in**, sign in from your terminal, then press **Detect again**.

**API connection.**
1. Click **Add connection**.
2. Either pick a provider or choose **Custom endpoint**:
   - **A provider** from the built-in list: more than seventy vendors, relays and local servers, with endpoints and models filled in. Paste your key.
   - **Custom endpoint:** enter a base URL, its protocol, a key and model IDs.
3. Press **Test** to send one small request and confirm the endpoint answers.
4. Back on the engine, choose the connection and a default model.

Engines on an API connection run in a separate profile under `~/.memosync/data/cli-profiles`, so your own `~/.claude` and `~/.codex` are never read or changed. Keys are stored in `~/.memosync/data/credentials.json`, readable only by you, and are never sent back to the browser.

MemoSync finds `claude` and `codex` on your `PATH` and in the usual install folders. To point an engine at a specific executable, set its path on the engine's card.

## Everyday controls

**In the composer**, under the message box:
- the project;
- memory on or off for this chat;
- the engine and the model;
- reasoning effort;
- Plan Mode, where the agent proposes a plan and waits for you before it acts.

**In Settings → Memory:**

| Setting | What it does |
| --- | --- |
| **Use Memory** | Turn memory off everywhere. Your library stays on the Memory Board. |
| **Learn From Chats** | Keep using memory, but stop proposing new items. |
| **Memory Changes** | **Ask First** holds every proposal for review. **Apply Automatically** applies non-sensitive ones right away, each with a one-click Revert. Sensitive proposals always ask. |
| **Memory Preview** | Show the working memory card before each turn, or skip it when nothing applies. |

**Elsewhere in Settings:**
- **Appearance:** language (English or 简体中文) and theme.
- **Notifications:** sounds and system notifications when a chat needs you.
- **Keybindings:** all shortcuts.
- **Skills:** globally installed agent skills.

## Run it elsewhere

```bash
bun run start --port 4000        # another port
bun run start --no-open          # don't open a browser
bun run start --remote           # listen on 0.0.0.0 (LAN, Tailscale)
bun run start --password <pw>    # ask for a password before the app loads
bun run start --share            # temporary public URL with a QR code
```

`bun run start --help` lists every option.

## Data and privacy

Everything MemoSync stores lives under `~/.memosync/data/` on your machine:
- memories (SQLite, plus the Markdown copy);
- chats and settings;
- API connections;
- a local usage log of how the memory features are used.

Nothing is uploaded by MemoSync. Your model provider does receive the conversation, the selected memories and the project context the agent reads.

The agent and its terminals run as your user, with access to your files. Profile isolation separates configuration, not the filesystem.

To stop the usage log, set `MEMOSYNC_USAGE_LOG=0`. To bundle your data into an archive:

```bash
bun run export-data          # usage log, memories and settings
bun run export-data --full   # also chat transcripts
```

[docs/DATA_AND_TELEMETRY.md](docs/DATA_AND_TELEMETRY.md) describes each file and event.

## Development

```bash
bun run dev       # client :5174 + server :5175, hot reload
bun test src/     # unit and integration tests, no network
bun run check     # typecheck + client builds
```

The server code is in `src/server/`:
- `agent.ts` coordinates a turn;
- `memory/` holds the memory engine: capture, checkup, selection, audit and transfer;
- `model-access/` resolves engines and connections.

The client is a React app in `src/client/`. Development data goes to `~/.memosync-dev/`.

## Acknowledgements

MemoSync started as a fork of [Kanna](https://github.com/jakemor/kanna). It runs:
- [Claude Code](https://github.com/anthropics/claude-agent-sdk-typescript) through the Agent SDK;
- [Codex](https://developers.openai.com/codex/app-server/) through `codex app-server`;
- [Pi](https://github.com/badlogic/pi-mono).

Provider presets and engine discovery are adapted from [Magpie](https://github.com/yetone/magpie). Provider marks come from [Lobe Icons](https://github.com/lobehub/lobe-icons). Licenses are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

[MIT](LICENSE)
