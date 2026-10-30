# Third-party notices

## Magpie

Parts of model access are adapted from [Magpie](https://github.com/yetone/magpie):

- `src/server/model-access/discovery-paths.ts` — installation directories (`internal/proc/path_other.go`)
- `src/server/model-access/presets.ts` — provider presets and model data (`internal/provider/presets.go`, catalog test data)
- `src/server/model-access/runtime.ts` — Claude Code and Codex provider mapping (`internal/agent/claude.go`, `codex.go`)
- `src/server/model-access/test-connection.ts` — connection test requests (`internal/provider/test.go`)
- `src/server/model-access/gateway/index.ts` — translation routing/orchestration (`internal/gateway/gateway.go`)
- `src/server/model-access/gateway/request.ts` — shared request shape, Messages/Responses parsing and Chat encoding (`internal/gateway/ir.go`, `anthropic.go`, `responses.go`, `chat.go`)
- `src/server/model-access/gateway/stream.ts` — SSE reader, Chat decoding and client event encoding (`internal/gateway/sse.go`, `chat.go`, `anthropic.go`, `responses.go`)
- `src/server/model-access/gateway/custom-tool.ts` — custom tool schema and streamed input decoding (`internal/gateway/responses.go`, `custom_tool.go`)
- `src/server/model-access/gateway/translation.test.ts`, `gateway.test.ts`, `custom-tool.test.ts`, and `fixtures/magpie-streams.json` — adapted tests and original fixture data (`internal/gateway/translate_stream_test.go`, `translate_severed_test.go`, `call_args_stream_test.go`)

The gateway subset was ported from Magpie commit `cc81ad4ea1ee6a4ceb2e2d4b93f4402332cb7100`.

No embedded prompts are included.

MIT License

Copyright (c) 2026 yetone

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## DispatchDock

Bounded installation-directory discovery and JS/symlink launcher handling in
`src/server/model-access/discovery-paths.ts` and `launcher.ts` are adapted from
[DispatchDock](https://github.com/LBEILC/DispatchDock),
`skills/codex-dispatch/lib/launcher-paths.mjs` and `adapters/codex.mjs`.

MIT License

Copyright (c) 2026 LBEILC

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## lobe-icons

Vendor marks in `src/client/components/brand/brand-svgs.ts` are taken from
[lobe-icons](https://github.com/lobehub/lobe-icons) (`@lobehub/icons-static-svg` 1.95.1). They identify the
providers and engines a user connects; the trademarks belong to their owners.

MIT License

Copyright (c) 2023 LobeHub

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
