import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { StartCodexSessionArgs, StartCodexTurnArgs } from '../codex-app-server'
import type { StartOpencodeTurnArgs } from '../opencode-agent'
import type { StartPiTurnArgs } from '../pi-agent'
import type { MemoryToolSpec } from './tools'

/** In-process launch snapshots. Never serialize credentials or live MCP transports. */
export interface ClaudeParentLaunch {
  provider: 'claude'
  options: Pick<Options, 'model' | 'effort' | 'tools' | 'systemPrompt' | 'settingSources' | 'settings' | 'permissionMode' | 'env' | 'pathToClaudeCodeExecutable'>
  memorySpecs: MemoryToolSpec[]
}
export interface CodexParentLaunch {
  provider: 'codex'
  session: Pick<StartCodexSessionArgs, 'model' | 'serviceTier' | 'dynamicTools' | 'sandbox' | 'runtime' | 'subprocessEnv'>
  turn: Pick<StartCodexTurnArgs, 'model' | 'effort' | 'serviceTier' | 'planMode' | 'developerInstructions'>
}
export interface PiParentLaunch {
  provider: 'pi'
  options: Pick<StartPiTurnArgs, 'model' | 'effort' | 'connection' | 'toolNames' | 'memorySpecs' | 'modelCard' | 'systemPrompt'>
}
export interface OpencodeParentLaunch {
  provider: 'opencode'
  options: Pick<StartOpencodeTurnArgs, 'model' | 'runtime' | 'systemPrompt' | 'memorySpecs'>
}
export type ParentLaunch = ClaudeParentLaunch | CodexParentLaunch | PiParentLaunch | OpencodeParentLaunch

/** Copy data at the turn boundary. Only inert tool definitions retain handlers;
 * live transports/callbacks are deliberately absent from ParentLaunch. */
export function snapshotParentLaunch(source: ParentLaunch): ParentLaunch {
  // Zod nodes and handlers are immutable definitions, not structured-cloneable
  // launch data. Copy their containers while retaining those definitions.
  const copySpecs = (specs?: MemoryToolSpec[]) => specs?.map(spec => ({ ...spec, schema: { ...spec.schema } }))
  if (source.provider === 'codex') return structuredClone(source)
  if (source.provider === 'claude') return { provider: 'claude', options: structuredClone(source.options), memorySpecs: copySpecs(source.memorySpecs)! }
  const { memorySpecs, ...options } = source.options
  return { provider: source.provider, options: { ...structuredClone(options), memorySpecs: copySpecs(memorySpecs) } } as ParentLaunch
}
