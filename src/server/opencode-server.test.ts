import { expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { OpencodeLaunchError, startOpencodeServer, type OpencodeServer } from './opencode-server'

const fixture = join(import.meta.dir, 'fixtures/opencode-startup-fixture.ts')

test('reports a sanitized spawn error when the working directory is missing', async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'opencode-startup-')))
  try {
    const failure = await startOpencodeServer({
      executable: fixture, cwd: join(cwd, 'missing'),
      env: { HOME: cwd, PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter) },
    }).then(() => null, error => error)
    expect(failure).toBeInstanceOf(OpencodeLaunchError)
    expect(failure.cause).toEqual({ code: 'ENOENT' })
    expect(failure.launchCause).toEqual({ code: 'ENOENT' })
    expect(failure.problemDetail).toBe('Unable to load OpenCode account configuration.')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

for (const ending of ['lf', 'crlf']) {
  test(`waits for the full port when a listening banner is split (${ending})`, async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'opencode-startup-')))
    let server: OpencodeServer | undefined
    try {
      server = await startOpencodeServer({
        executable: fixture,
        cwd,
        env: {
          HOME: cwd,
          PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
          FAKE_OC_LOG_SPLIT: 'port',
          FAKE_OC_LOG_ENDING: ending,
        },
      })
      expect(server.url).toBe('http://127.0.0.1:12345')
    } finally {
      await server?.close()
      rmSync(cwd, { recursive: true, force: true })
    }
  })
}

test('accepts a complete listening banner', async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'opencode-startup-')))
  let server: OpencodeServer | undefined
  try {
    server = await startOpencodeServer({
      executable: fixture,
      cwd,
      env: { HOME: cwd, PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter) },
    })
    expect(server.url).toBe('http://127.0.0.1:12345')
  } finally {
    await server?.close()
    rmSync(cwd, { recursive: true, force: true })
  }
})
