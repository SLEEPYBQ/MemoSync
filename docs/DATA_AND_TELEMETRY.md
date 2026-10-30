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
stamped with the install id. The log describes local memory workflows. It is
purely local — the file is never read by the app itself and never transmitted
automatically.

Event families:

- `memory.*` — memory lifecycle: capture, candidate decisions, injection,
  citations, checkup outcomes, transfers, interrupts/resumes, audit verdicts and
  audit follow-ups (enforce, draft a fix), working-memory selections.
- `ui.monitor` — monitoring acts on memory surfaces (Memory Board visits, audit
  expansion, citation hovers).
- `ui.surface_exposure` — open / close / visible / hidden intervals of memory
  surfaces (Memory Board, Memory Record, review cards).

The log can contain memory content, expected-use text, revision instructions
(`memory.revise_injection.instruction`), and quoted interruption evidence. It
is not a transcript copy and must not be treated as text-free or anonymized.
Chat transcripts are stored separately and included by the data exporter only
with `--full`. Log lines from older versions may contain additional fields.

Set `MEMOSYNC_USAGE_LOG=0` to disable future local usage logging. The old
`EXPERIMENT_LOG=0` remains a compatibility alias when the new variable is unset.
Logging failures never block memory actions.

Deleting `experiments/events.jsonl` removes existing records, but does not
disable future local logging. There is no server-side collection to disable.

## Exporting a bundle

```bash
bun run export-data            # usage log + memory library (default)
bun run export-data --full     # additionally raw historical data and chat logs
bun run export-data --out DIR  # write the archive somewhere specific
DATA_DIR=/path bun run export-data   # export a non-default data directory
```

The default bundle contains only `experiments/events.jsonl`, `install-id`,
`memory.sqlite`, `memories/`, and `settings.json`. Other files under
`experiments/` are excluded by default, including databases left by older
versions (which can contain raw prompts) and workspace snapshots (which can contain
source code). `--full` explicitly includes that entire directory, the JSONL
logs, `snapshot.json`, and `transcripts/`.

Even the default archive can contain private memory contents, settings, and
paths. It is not anonymized: review it before sharing. Nothing is uploaded by
the exporter. The archive is written as
`memosync-export-<install-id>-<timestamp>[-full].tar.gz` in the current
directory (it is gitignored).

## Offline chat exports

The chat transcript export creates a folder with an `index.html` page that
can be opened directly in a browser, without running MemoSync or a web server.
Its viewer code and sanitized transcript data are embedded in the HTML;
`transcript.json` is also retained for other tools. Keep the exported folder
together when copying it, especially its `attachments/` directory when you
choose to bundle attachments. Metadata-only exports do not copy attachment
contents. Transcript exports still contain the conversation you selected, so
review them before sharing too.

Bundled text previews (Markdown, text, JSON, and tables) also work offline.
Previews are limited to the first 1 MiB; the complete original files remain
in `attachments/`. Attachment contents may contain private information.

## Analysing a log

`scripts/analyze-experiment.ts` computes per-session memory metrics from an
`events.jsonl`:

```bash
bun run scripts/analyze-experiment.ts ~/.memosync/data/experiments/events.jsonl --csv out.csv
```

Data written by older MemoSync versions is left in place. Files they kept
under `experiments/` (such as `study.sqlite`) are neither opened nor migrated,
and their settings and environment variables are not read. Existing projects,
chats, memory versions, exclusions, and evolution preferences remain
available. Unknown transcript entries render as read-only JSON; recognized
older gates use the ordinary transcript and stale-gate handling. Older browser
outboxes are ignored; retries use `memosync:usage-outbox:v1`.

The analyzer ignores retired/unknown event types, reports chats by their
original session ids, and keeps labels recorded by older versions only in
`legacyMetadata`. It does not group chats into task windows or relabel older
events. CSV
exports include this metadata; `--include-internal-qa` is retired.
