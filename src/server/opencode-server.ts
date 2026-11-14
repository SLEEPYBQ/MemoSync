import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { executableLauncher } from './model-access/launcher'
import type { RuntimeEnv } from './model-access/legacy'

export type OpencodeConfig = Record<string, unknown>
export const OPENCODE_BRANCH_AGENT = {
  mode: 'primary',
  permission: { '*': 'deny', read: 'ask', grep: 'ask', glob: 'ask', list: 'ask', external_directory: 'deny' },
}

/** Only the two diagnostic lines are allowed across the subprocess boundary. */
export function cleanOpencodeProblemDetail(stderr: string, home = homedir()): string {
  const lines = stderr.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/)
  const index = lines.findIndex(line => line.includes('Configuration is invalid'))
  if (index < 0) return 'Unable to load OpenCode account configuration.'
  const first = lines[index]!.slice(lines[index]!.indexOf('Configuration is invalid'))
  const next = lines[index + 1]?.trim()
  return [first, next?.startsWith('↳') ? next : ''].filter(Boolean).join('\n')
    .split(home).join('~').slice(0, 300)
}

export class OpencodeLaunchError extends Error {
  constructor(readonly problemDetail: string, readonly launchCause?: unknown) { super('account-config-invalid', { cause: launchCause }) }
}

export interface OpencodeServer {
  child: ChildProcess
  url: string
  authorization: string
  close(): Promise<void>
}

/** Kill the entire wrapper/server group, even when the npm wrapper exited first. */
export async function stopOpencodeProcess(child: ChildProcess): Promise<void> {
  if (!child.pid) return
  const pid = child.pid
  const kill = (signal: NodeJS.Signals | 0) => {
    try { process.kill(process.platform === 'win32' ? pid : -pid, signal); return true } catch { return false }
  }
  kill('SIGTERM')
  const end = Date.now() + 1000
  while (kill(0) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 25))
  if (kill(0)) kill('SIGKILL')
  const killed = Date.now() + 1000
  while (kill(0) && Date.now() < killed) await new Promise(resolve => setTimeout(resolve, 25))
}

export async function startOpencodeServer(args: {
  executable: string; cwd: string; env: RuntimeEnv; config?: OpencodeConfig; signal?: AbortSignal
}): Promise<OpencodeServer> {
  args.signal?.throwIfAborted()
  const launcher = await executableLauncher(args.executable, args.env)
  args.signal?.throwIfAborted()
  const password = randomUUID()
  const child = spawn(launcher.command, [...launcher.args, 'serve', '--hostname=127.0.0.1', '--port=0'], {
    cwd: args.cwd, env: { ...args.env, OPENCODE_CLIENT: 'app', OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...args.config, share: 'disabled', autoupdate: false }) },
    detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  })
  let closing: Promise<void> | undefined
  const close = () => closing ??= stopOpencodeProcess(child)
  let stderr = ''
  const collect = (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192) }
  child.stderr!.on('data', collect)
  try {
    let cleanup = () => {}
    const url = await new Promise<string>((resolve, reject) => {
      let output = ''
      const fail = (cause?: unknown) => reject(new OpencodeLaunchError(cleanOpencodeProblemDetail(stderr, args.env.HOME), cause))
      const spawnError = (error: NodeJS.ErrnoException) => fail({ code: error.code ?? 'SPAWN_FAILED' })
      const earlyExit = (exitCode: number | null, signal: NodeJS.Signals | null) => fail({ exitCode, signal })
      const abort = () => reject(args.signal?.reason ?? new Error('OpenCode start cancelled'))
      const timer = setTimeout(() => fail({ code: 'STARTUP_TIMEOUT' }), 9000)
      const data = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-4096)
        const match = /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)\r?\n/.exec(output)
        if (match) resolve(match[1]!)
      }
      child.stdout!.on('data', data)
      child.once('error', spawnError)
      child.once('exit', earlyExit)
      args.signal?.addEventListener('abort', abort, { once: true })
      cleanup = () => {
        clearTimeout(timer); child.stdout!.off('data', data); child.off('error', spawnError); child.off('exit', earlyExit)
        args.signal?.removeEventListener('abort', abort)
      }
    }).finally(() => cleanup())
    child.stderr!.off('data', collect)
    child.stderr!.resume()
    child.stdout!.resume()
    return { child, url, authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`, close }
  } catch (error) {
    await close()
    throw error
  }
}
