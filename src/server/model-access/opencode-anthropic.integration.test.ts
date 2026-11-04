import { describe, expect, test } from 'bun:test'
import { createOpencodeClient } from '@opencode-ai/sdk/v2'
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConnectionEndpoint } from '../../shared/model-access'
import { startOpencodeServer, type OpencodeServer } from '../opencode-server'
import { buildOpencodeProviderConfig } from './runtime'

// Opt in with an absolute binary path. All model traffic stays on loopback;
// HOME, XDG directories and the child environment contain only test data.
const binary = process.env.MEMOSYNC_OPENCODE_TEST_BIN
const integration = binary ? describe : describe.skip
const apiKey = 'fake-anthropic-protocol-key'
const modelID = 'vendor/fake-anthropic'
const reply = 'Local Anthropic protocol accepted.'

function createAnthropicFixture() {
  const requests: Array<{ path: string; authorization: string | null; apiKey: string | null; body: Record<string, unknown> }> = []
  const event = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      const body = await request.json() as Record<string, unknown>
      requests.push({ path, authorization: request.headers.get('authorization'), apiKey: request.headers.get('x-api-key'), body })
      if (path !== '/anthropic/v1/messages') {
        return Response.json({ type: 'error', error: { type: 'not_found_error', message: `Unexpected model path: ${path}` } }, { status: 404 })
      }
      const message = { id: 'msg_fake_anthropic', type: 'message', role: 'assistant', model: modelID, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 11, output_tokens: 0 } }
      return new Response(
        event('message_start', { message })
        + event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
        + event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: reply } })
        + event('content_block_stop', { index: 0 })
        + event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } })
        + event('message_stop', {}),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })
  return { baseUrl: `http://127.0.0.1:${server.port}/anthropic`, requests, close() { server.stop(true) } }
}

integration('OpenCode Anthropic wire protocol with a local scripted model', () => {
  const cases: Array<{ name: string; suffix: string; authHeader?: ConnectionEndpoint['authHeader'] }> = [
    { name: 'custom root with default Bearer', suffix: '' },
    { name: 'custom root with trailing slashes and explicit Bearer', suffix: '///', authHeader: 'bearer' },
    { name: 'custom root with explicit x-api-key', suffix: '', authHeader: 'x-api-key' },
    { name: 'existing /v1 with Bearer', suffix: '/v1/', authHeader: 'bearer' },
    { name: 'existing /v1 with x-api-key', suffix: '/v1///', authHeader: 'x-api-key' },
  ]
  for (const scenario of cases) {
    test(scenario.name, async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'memosync-anthropic-wire-')))
      const project = join(root, 'project')
      mkdirSync(project)
      const fake = createAnthropicFixture()
      let server: OpencodeServer | undefined
      try {
        const config = buildOpencodeProviderConfig({ protocol: 'anthropic-messages', baseUrl: fake.baseUrl + scenario.suffix, authHeader: scenario.authHeader }, { id: modelID })
        expect(JSON.stringify(config)).not.toContain(apiKey)
        server = await startOpencodeServer({
          executable: binary!, cwd: project,
          env: {
            HOME: root, PATH: process.env.PATH, TMPDIR: root,
            XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
            XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
            MEMOSYNC_MODEL_API_KEY: apiKey,
            OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
            OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
            OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
            OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: '1',
          },
          config: { ...config, permission: { '*': 'deny' } },
          signal: AbortSignal.timeout(15_000),
        })
        const client = createOpencodeClient({ baseUrl: server.url, directory: project, headers: { Authorization: server.authorization } })
        const session = await client.session.create({ title: 'Local Anthropic protocol test' }, { throwOnError: true, signal: AbortSignal.timeout(5_000) })
        const result = await client.session.prompt({
          sessionID: session.data.id,
          model: { providerID: 'memosync', modelID },
          parts: [{ type: 'text', text: 'Reply using the local scripted model.' }],
        }, { throwOnError: true, signal: AbortSignal.timeout(15_000) })
        expect(result.data.info.error).toBeUndefined()
        expect(result.data.info.finish).toBe('stop')
        expect(result.data.parts.filter(part => part.type === 'text').map(part => part.text).join('')).toBe(reply)
        expect(fake.requests.length).toBeGreaterThan(0)
        for (const request of fake.requests) {
          expect(request.path).toBe('/anthropic/v1/messages')
          expect(request.body.model).toBe(modelID)
          expect(request.body.stream).toBe(true)
          expect(request.authorization).toBe(scenario.authHeader === 'x-api-key' ? null : `Bearer ${apiKey}`)
          expect(request.apiKey).toBe(scenario.authHeader === 'x-api-key' ? apiKey : null)
        }
      } finally {
        await server?.close()
        fake.close()
        rmSync(root, { recursive: true, force: true })
      }
    }, 35_000)
  }
})
