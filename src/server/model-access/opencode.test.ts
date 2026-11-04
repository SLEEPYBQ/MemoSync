import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, realpathSync } from 'node:fs'
import { join, delimiter } from 'node:path'
import { tmpdir } from 'node:os'
import { whitelistOpencodeProviders, probeOpencodeAccount, cleanOpencodeProblemDetail } from './opencode-account'
import { buildOpencodeProviderConfig, resolveEngineRuntime } from './runtime'
import { createExecutableResolver } from './resolver'
import { ModelAccessService } from './service'

const roots: string[] = []
function root() { const path = realpathSync(mkdtempSync(join(tmpdir(), 'opencode-access-'))); roots.push(path); return path }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })
const fixture = join(import.meta.dir, '../fixtures/opencode-server-fixture.ts')

test('provider projection drops keys, options and unknown fields at every level', () => {
  const raw = { key: 'TOP-SECRET', providers: [{ id: 'p', name: 'Provider', key: 'PROVIDER-SECRET', options: { apiKey: 'NESTED-SECRET' }, models: { 'vendor/m': { id: 'vendor/m', name: 'Model', key: 'MODEL-SECRET', limit: { context: 100, output: 20, key: 'LIMIT-SECRET' }, capabilities: { reasoning: true, input: { image: true }, key: 'CAPABILITY-SECRET' } } } }], default: { p: 'vendor/m' } }
  const result = whitelistOpencodeProviders(raw)
  expect(result).toEqual({ accountModels: [{ id: 'p/vendor/m', label: 'Provider / Model', contextWindow: 100, maxOutputTokens: 20, supportsReasoning: true, supportsImages: true }], accountDefaultModel: 'p/vendor/m' })
  expect(JSON.stringify(result)).not.toMatch(/SECRET|apiKey|"key"|options/)
  expect(whitelistOpencodeProviders(raw, 'other/custom/model').accountDefaultModel).toBe('other/custom/model')
  expect(whitelistOpencodeProviders({ providers: [null, { key: 'SECRET' }] })).toEqual({ accountModels: [] })
})
test('configuration diagnostics strip ANSI, home, unrelated stderr and enforce length', () => {
  const detail = cleanOpencodeProblemDetail('key SECRET\n\x1b[31mConfiguration is invalid at /home/test/opencode.json\x1b[0m\n  ↳ unknown field\nSECRET footer', '/home/test')
  expect(detail).toBe('Configuration is invalid at ~/opencode.json\n↳ unknown field')
  expect(cleanOpencodeProblemDetail('SECRET only')).toBe('Unable to load OpenCode account configuration.')
  expect(cleanOpencodeProblemDetail(`Configuration is invalid\n↳ ${'x'.repeat(500)}`)).toHaveLength(300)
})
for (const [protocol, npm] of [['openai-chat', '@ai-sdk/openai-compatible'], ['openai-responses', '@ai-sdk/openai'], ['anthropic-messages', '@ai-sdk/anthropic']] as const) {
  test(`provider config uses ${protocol} without changing model IDs or embedding keys`, () => {
    expect(buildOpencodeProviderConfig({ protocol, baseUrl: 'http://127.0.0.1:9999/v1' }, { id: 'z-ai/glm-5.3-flash', contextWindow: 12345, maxOutputTokens: 456, supportsReasoning: true, supportsImages: true })).toEqual({
      provider: { memosync: { name: 'MemoSync', npm, options: { baseURL: 'http://127.0.0.1:9999/v1', [protocol === 'anthropic-messages' ? 'authToken' : 'apiKey']: '{env:MEMOSYNC_MODEL_API_KEY}' }, models: { 'z-ai/glm-5.3-flash': { name: 'z-ai/glm-5.3-flash', tool_call: true, limit: { context: 12345, output: 456 }, reasoning: true, attachment: true } } } }, enabled_providers: ['memosync'], model: 'memosync/z-ai/glm-5.3-flash', small_model: 'memosync/z-ai/glm-5.3-flash',
    })
  })
}
test('Anthropic provider URLs append /v1 once and strip trailing slashes', () => {
  for (const [url, expected] of [
    ['https://api.anthropic.com', 'https://api.anthropic.com/v1'],
    ['https://proxy.test/anthropic', 'https://proxy.test/anthropic/v1'],
    ['https://proxy.test/anthropic///', 'https://proxy.test/anthropic/v1'],
    ['https://proxy.test/anthropic/v1', 'https://proxy.test/anthropic/v1'],
    ['https://proxy.test/anthropic/v1///', 'https://proxy.test/anthropic/v1'],
  ]) {
    const config = buildOpencodeProviderConfig({ protocol: 'anthropic-messages', baseUrl: url! }, { id: 'vendor/m' })
    expect(config.provider).toMatchObject({ memosync: { options: { baseURL: expected } } })
  }
})
test('Anthropic uses exactly one env credential matching the selected authentication header', () => {
  for (const authHeader of [undefined, 'bearer', 'x-api-key'] as const) {
    const config = buildOpencodeProviderConfig({ protocol: 'anthropic-messages', baseUrl: 'https://proxy.test/anthropic', authHeader }, { id: 'vendor/m' })
    expect(config.provider).toMatchObject({ memosync: { npm: '@ai-sdk/anthropic' } })
    expect((config.provider as Record<string, { options: unknown }>).memosync!.options).toEqual({
      baseURL: 'https://proxy.test/anthropic/v1',
      [authHeader === 'x-api-key' ? 'apiKey' : 'authToken']: '{env:MEMOSYNC_MODEL_API_KEY}',
    })
  }
})
test('OpenAI provider URLs and apiKey mapping retain their existing behavior', () => {
  for (const protocol of ['openai-chat', 'openai-responses'] as const) {
    for (const authHeader of [undefined, 'bearer', 'x-api-key'] as const) {
      const config = buildOpencodeProviderConfig({ protocol, baseUrl: 'https://proxy.test/custom///', authHeader }, { id: 'vendor/m' })
      expect((config.provider as Record<string, { options: unknown }>).memosync!.options).toEqual({
        baseURL: 'https://proxy.test/custom///', apiKey: '{env:MEMOSYNC_MODEL_API_KEY}',
      })
    }
  }
})
test('discovery skips obsolete PATH candidates and finds ~/.opencode/bin at the minimum version', async () => {
  const home = root(), oldDir = join(home, 'old'), bin = join(home, '.opencode/bin')
  for (const [dir, version] of [[oldDir, '1.1.35'], [bin, '1.17.4']]) {
    mkdirSync(dir!, { recursive: true }); const file = join(dir!, 'opencode'); writeFileSync(file, `#!/bin/sh\necho ${version}\n`); chmodSync(file, 0o755)
  }
  const resolver = createExecutableResolver()
  const env = { HOME: home, PATH: oldDir }
  expect(await resolver.resolveEngineExecutable('opencode', undefined, env)).toMatchObject({ state: 'ready', path: join(bin, 'opencode'), minimumVersion: '1.17.4' })
  expect(await resolver.resolveEngineExecutable('opencode', { executablePath: join(oldDir, 'opencode') }, env)).toMatchObject({ state: 'incompatible', version: '1.1.35' })
  expect(await resolver.resolveEngineExecutable('opencode', undefined, { ...env, PATH: [oldDir, bin].join(delimiter) })).toMatchObject({ state: 'ready', source: 'path' })
})
test('account refresh probes connected models, keeps secrets out of snapshots and re-probes errors', async () => {
  const home = root(), env = { HOME: home, PATH: process.env.PATH, FAKE_OC_CONFIG: '', FAKE_OC_MODEL: 'connected/vendor/m' }
  const service = await new ModelAccessService({ dataDir: join(home, 'store'), env, readLegacyPi: async () => null,
    resolveExecutable: async engine => engine === 'opencode' ? { state: 'ready', path: fixture } : { state: 'missing' },
  }).initialize()
  expect(service.getSnapshot().engines.opencode).toMatchObject({ ready: true, accountDefaultModel: 'connected/vendor/m', accountModels: [{ id: 'connected/vendor/m' }] })
  expect(JSON.stringify(service.getSnapshot())).not.toContain('FAKE-SECRET')
  env.FAKE_OC_CONFIG = 'invalid'
  await service.refreshExecutables()
  const status = service.getSnapshot().engines.opencode
  expect(status).toMatchObject({ ready: false, problem: 'account-config-invalid' })
  expect(status.problemDetail).toBe('Configuration is invalid at ~/bad.json\n↳ Unrecognized key: "invalid"')
  expect(JSON.stringify(status)).not.toContain('FAKE-SECRET')
  const connection = await service.saveConnection({ name: 'Fake', endpoints: [{ protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:9' }], models: [{ id: 'm' }] })
  await service.setEngine('opencode', { access: { mode: 'connection', connectionId: connection.id } })
  expect(service.getSnapshot().engines.opencode).toMatchObject({ ready: true })
  expect(service.getSnapshot().engines.opencode.accountModels).toBeUndefined()
  const runtime = await resolveEngineRuntime({ engine: 'opencode', service })
  expect(runtime.env.XDG_CONFIG_HOME).toStartWith(join(home, 'store/cli-profiles/opencode'))
  expect(runtime.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1')
}, 15_000)
test('account isolation refuses without consulting an invalid account config', async () => {
  const home = root()
  const service = await new ModelAccessService({ dataDir: home, env: { HOME: home, MEMOSYNC_ISOLATE_CLI: '1' }, readLegacyPi: async () => null, resolveExecutable: async engine => engine === 'opencode' ? { state: 'ready', path: fixture } : { state: 'missing' } }).initialize()
  expect(service.getSnapshot().engines.opencode).toMatchObject({ problem: 'account-signed-out', accountIsolated: true })
})
test('account probe failure never returns raw process stderr', async () => {
  expect(await probeOpencodeAccount('/nonexistent/opencode', { HOME: root() })).toEqual({ accountModels: [], problem: 'account-config-invalid', problemDetail: 'Unable to load OpenCode account configuration.' })
})
