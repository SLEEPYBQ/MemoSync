// Preloaded by `bun test` (bunfig.toml). Keeps quick responses (chat titles,
// commit messages) from calling this machine's real LLM provider, Claude or
// Codex when a test leaves them unstubbed. See QuickResponseAdapter.
process.env.MEMOSYNC_QUICK_RESPONSE_OFFLINE = "1"
