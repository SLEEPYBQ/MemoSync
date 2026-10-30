import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { i18n } from "./client/i18n"

// Preloaded by `bun test` (bunfig.toml). Keeps quick responses (chat titles,
// commit messages) from calling this machine's real LLM provider, Claude or
// Codex when a test leaves them unstubbed. See QuickResponseAdapter.
process.env.MEMOSYNC_QUICK_RESPONSE_OFFLINE = "1"

// Real English resources keep all existing copy assertions deterministic.
void i18n.changeLanguage("en")

// Codex has no bundled fallback, so runtime resolution needs a `codex` on PATH.
// Tests inject their own app-server process; this stub only answers discovery
// probes, so CI without Codex resolves the same way as a machine that has it,
// and no test can reach this machine's real Codex.
const stubDir = mkdtempSync(join(tmpdir(), "memosync-test-bin-"))
writeFileSync(join(stubDir, "codex"), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.200.0"; exit 0; fi\nif [ "$1 $2" = "app-server --help" ]; then exit 0; fi\necho "memosync test stub: codex is not available in tests" >&2\nexit 77\n')
chmodSync(join(stubDir, "codex"), 0o755)
process.env.PATH = `${stubDir}${delimiter}${process.env.PATH ?? ""}`
