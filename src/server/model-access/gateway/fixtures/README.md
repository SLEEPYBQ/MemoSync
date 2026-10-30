Adapted from Magpie (https://github.com/yetone/magpie), MIT License,
Copyright (c) 2026 yetone. See THIRD_PARTY_NOTICES.md for the full license.

`magpie-streams.json` retains the original JSON chunk strings from
`internal/gateway/translate_stream_test.go` at commit
`cc81ad4ea1ee6a4ceb2e2d4b93f4402332cb7100`. Keys are the original Go test
names, plus the shared `interleavedCalls` fixture. The Bun tests exercise
both encoders, the first-choice decoder contract, repeated tool IDs,
argument interleaving, and reasoning aliases.

The first-choice fixture deliberately appends ` more` to tool arguments;
it tests the decoder, not final JSON validation. It is therefore asserted
at that boundary rather than treated as a valid completed tool call.

`custom-tool.test.ts` retains the valid-input and non-input cases from
`call_args_stream_test.go::TestCustomInputStreams`. JavaScript strings use
UTF-16; tests split both escape sequences and actual surrogate pairs.
The Go-specific isolated-surrogate replacement case is omitted: JavaScript
JSON parsing preserves an isolated surrogate rather than replacing it.

`gateway.test.ts` adapts the completion-vs-severed-stream assertions from
`translate_severed_test.go` to the selected Chat-upstream paths, with local
Bun HTTP fixtures and SDK consumers. It also adapts the gated argument
streaming check from `call_args_stream_test.go` to Chat deltas.
