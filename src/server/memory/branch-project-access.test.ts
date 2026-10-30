import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { query, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { StartPiTurnArgs } from '../pi-agent'
import { createMemoryBranch, isReadOnlyBranchCommand } from './branch-runtime'

function fixture(prefix = "branch project 'quote-") {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const project = join(root, 'project')
  mkdirSync(project)
  mkdirSync(join(project, 'nested'))
  writeFileSync(join(project, 'inside.txt'), 'inside')
  writeFileSync(join(root, 'outside.txt'), 'OUTSIDE_READ_MUST_BE_DENIED')
  symlinkSync(root, join(project, 'escape'))
  symlinkSync(join(project, 'inside.txt'), join(project, 'safe-link'))
  return { root, project, paths: [join(root, 'outside.txt'), '../outside.txt', 'escape/outside.txt', 'escape/../outside.txt'] }
}

describe('memory branch project read boundary', () => {
  test('Claude native PreToolUse scopes Read, Glob, Grep and Bash to the project', async () => {
    const f = fixture()
    let call!: Parameters<typeof query>[0]
    const claudeQuery: typeof query = input => {
      call = input
      return Object.assign((async function* () {
        yield { type: 'result', subtype: 'success', is_error: false, session_id: 'child', result: '{}' } as SDKMessage
      })(), { close() {} }) as Query
    }
    const branch = createMemoryBranch({ provider: 'claude', model: 'fake', localPath: f.project, parentSessionToken: 'parent',
      runtime: { engine: 'claude', model: 'fake', args: [], env: {}, isolated: true, executable: { state: 'ready', path: '/fake/claude' } } }, { claudeQuery })
    try {
      await branch.ask('Inspect', { budget: { maxToolCalls: 100 } })
      const hook = call.options!.hooks!.PreToolUse![0]!.hooks[0]!
      let index = 0
      const check = async (name: string, input: Record<string, unknown>) => (await hook({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: input, tool_use_id: `tool-${++index}` } as any, `tool-${index}`, { signal: new AbortController().signal }) as any).hookSpecificOutput
      for (const path of f.paths) {
        for (const name of ['Read', 'Glob', 'Grep']) {
          const result = await check(name, { [name === 'Read' ? 'file_path' : 'path']: path })
          expect(result.permissionDecision).toBe('deny')
          expect(result.permissionDecisionReason).toContain('project')
        }
        expect((await check('Bash', { command: `cat '${path}'` })).permissionDecision).toBe('deny')
      }
      for (const path of ['inside.txt', 'nested/../inside.txt', 'safe-link', join(f.project, 'inside.txt')]) {
        expect((await check('Read', { file_path: path })).permissionDecision).toBe('allow')
      }
      for (const name of ['Glob', 'Grep']) expect((await check(name, { pattern: 'inside' })).permissionDecision).toBe('allow')
    } finally { branch.dispose(); rmSync(f.root, { recursive: true, force: true }) }
  })

  test('Pi beforeToolCall scopes every read path, including its @ prefix', async () => {
    const f = fixture('branch-project-')
    let call!: StartPiTurnArgs
    const branch = createMemoryBranch({ provider: 'pi', model: 'fake', localPath: f.project, parentSessionToken: 'parent' }, {
      resolvePiConnection: async () => ({ provider: 'custom', baseUrl: 'http://localhost', apiKey: 'fake' }),
      piManager: { closeChat() {}, async startTurn(args) {
        call = args
        return { provider: 'pi', close() {}, async interrupt() {}, stream: (async function* () {
          yield { type: 'session_token' as const, sessionToken: 'child' }
          yield { type: 'transcript' as const, entry: { _id: 'result', createdAt: Date.now(), kind: 'result' as const, subtype: 'success', isError: false, result: '{}', durationMs: 0 } }
        })() }
      } },
    })
    try {
      await branch.ask('Inspect', { budget: { maxToolCalls: 100 } })
      for (const path of [...f.paths, '@../outside.txt']) for (const name of ['read', 'grep', 'find', 'ls']) {
        const result = await call.beforeToolCall!(name, { path })
        expect(result?.block).toBe(true)
        expect(result?.reason).toContain('project')
      }
      for (const path of ['inside.txt', 'nested/../inside.txt', 'safe-link', join(f.project, 'inside.txt')]) {
        expect(await call.beforeToolCall!('read', { path })).toBeUndefined()
      }
      // Pi's read tool retries curly-quote/NFD/screenshot filename variants.
      // A missing, harmless-looking name must not select an outside symlink.
      symlinkSync(join(f.root, 'outside.txt'), join(f.project, 'quote’file'))
      expect((await call.beforeToolCall!('read', { path: "quote'file" }))?.block).toBe(true)
      writeFileSync(join(f.project, 'safe’file'), 'inside')
      expect(await call.beforeToolCall!('read', { path: "safe'file" })).toBeUndefined()
      for (const name of ['grep', 'find', 'ls']) expect(await call.beforeToolCall!(name, {})).toBeUndefined()
    } finally { branch.dispose(); rmSync(f.root, { recursive: true, force: true }) }
  })

  test('Codex separate-process guard rejects outside operands and alternate cwd', async () => {
    const f = fixture()
    const guard = fileURLToPath(new URL('./codex-branch-guard.ts', import.meta.url))
    const run = async (input: Record<string, unknown>, projectRoot: string | undefined = f.project) => {
      const child = Bun.spawn([process.execPath, guard, ...(projectRoot ? [projectRoot] : [])], {
        stdin: new Blob([JSON.stringify({ tool_name: 'exec_command', tool_input: input, cwd: f.project })]), stdout: 'pipe', stderr: 'pipe', env: { ...process.env, BUN_BE_BUN: '1' },
      })
      const result = JSON.parse(await new Response(child.stdout).text())
      expect(await child.exited).toBe(0)
      return result.hookSpecificOutput
    }
    try {
      for (const command of [
        ...f.paths.map(path => `cat "${path}"`), `cat "${f.project}/inside.txt"`, 'cat ~/outside.txt', 'rg --file=../outside.txt pattern',
        'cat escape/../outside.txt', 'rg -nf../outside.txt pattern', 'cat *', 'rg --follow pattern .', 'grep -R pattern .', 'rg -L pattern .',
      ]) {
        expect(isReadOnlyBranchCommand(command, f.project)).toBe(false)
        const result = await run({ cmd: command })
        expect(result.permissionDecision).toBe('deny')
        expect(result.permissionDecisionReason).toContain('project')
      }
      expect((await run({ cmd: 'cat outside.txt', workdir: f.root })).permissionDecision).toBe('deny')
      expect((await run({ cmd: 'cat outside.txt', cwd: f.root })).permissionDecision).toBe('deny')
      expect((await run({ cmd: 'pwd' }, '')).permissionDecision).toBe('deny')
      expect(await run({ cmd: 'cat ../inside.txt', workdir: 'nested' })).toBeUndefined()
      for (const command of ['pwd', 'cat inside.txt', 'cat nested/../inside.txt', 'cat safe-link', "rg -n 'memory item' ."]) {
        expect(isReadOnlyBranchCommand(command, f.project)).toBe(true)
        expect(await run({ cmd: command })).toBeUndefined()
      }
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })
})
