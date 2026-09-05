# Data storage, privacy, and usage logging

MemoSync is local-first. Everything it produces lives on your machine under
`~/.memosync/data/` (or `~/.memosync-dev/data/` when started with
`bun run dev`). Nothing is uploaded anywhere automatically.

## What is stored

| Path (under `~/.memosync/data/`) | Contents |
| --- | --- |
| `memory.sqlite` | Memory items, their versions, status, usage counts, relations, and the full per-item event history |
| `memories/` | Markdown projection of the memory store (personal + per-project files) that the Memory files card keeps in sync |
| `projects.jsonl`, `chats.jsonl`, `messages.jsonl`, `queued-messages.jsonl`, `turns.jsonl` | Append-only event logs for projects, chats, transcripts, and turn lifecycle |
| `snapshot.json` | Periodic compaction of the logs above (the `.jsonl` files are truncated after a snapshot) |
| `transcripts/` | Per-chat transcript entries |
| `settings.json` | App settings |
| `install-id` | A random per-install identifier (`local-<uuid>`) generated on first run |
| `experiments/events.jsonl` | The usage log described below |

## Usage log (`experiments/events.jsonl`)

MemoSync records how its memory features are used, one JSON object per line,
stamped with the install id. The intent is to let a team that deploys MemoSync
study how people monitor and control agent memory over time. It is purely
local — the file is never read by the app itself and never transmitted.

Event families:

- `memory.*` — memory lifecycle: capture, candidate decisions, injection,
  citations, checkup outcomes, transfers, interrupts/resumes, audit verdicts and
  audit follow-ups (enforce, draft a fix), working-memory selections.
- `ui.monitor` — monitoring acts on memory surfaces (Memory Board visits, audit
  expansion, citation hovers).
- `ui.surface_exposure` — open / close / visible / hidden intervals of memory
  surfaces (Memory Board, Memory Record, review cards).

Raw prompt text is **not** part of this stream. Chat transcripts are stored
separately (see the table above) and are only bundled by the exporter when you
explicitly ask for them.

To turn logging off entirely, delete `experiments/events.jsonl` after use or
avoid running the exporter; there is no server-side collection to disable.

## Exporting a bundle

```bash
bun run export-data            # usage log + memory library (default)
bun run export-data --full     # additionally chat/session logs and transcripts
bun run export-data --out DIR  # write the archive somewhere specific
DATA_DIR=/path bun run export-data   # export a non-default data directory
```

The default bundle contains `experiments/`, `install-id`, `memory.sqlite`,
`memories/`, and `settings.json`. `--full` adds the JSONL logs, `snapshot.json`,
and `transcripts/`. The archive is written as
`memosync-export-<install-id>-<timestamp>[-full].tar.gz` in the current
directory (it is gitignored).

## Analysing a log

`scripts/analyze-experiment.ts` computes per-session memory metrics from an
`events.jsonl`:

```bash
bun run scripts/analyze-experiment.ts ~/.memosync/data/experiments/events.jsonl --csv out.csv
```
