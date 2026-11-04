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
