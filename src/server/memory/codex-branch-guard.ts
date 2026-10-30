/** Native Codex PreToolUse command; no network, credentials, or workspace writes. */
import { isAbsolute } from 'node:path'
import { BRANCH_READ_DENIAL, isProjectBranchPath, isReadOnlyBranchCommand } from './branch-read-policy'

// Codex hooks fail open on malformed output. This guard always emits an explicit
// decision, including invalid inputs; the native read-only sandbox is retained.
let allow = false
try {
  const event = JSON.parse(await Bun.stdin.text())
  const input = typeof event.tool_input === 'string' ? JSON.parse(event.tool_input) : event.tool_input
  // Supplied by the host, safely quoted in the hook declaration. Never trust
  // a model-selected workdir (or the hook process's own cwd) as the boundary.
  const projectRoot = process.argv[2]
  const requestedCwd = input?.workdir ?? input?.cwd ?? event.cwd ?? projectRoot
  const cwd = typeof requestedCwd === 'string' && !isAbsolute(requestedCwd) ? `${projectRoot}/${requestedCwd}` : requestedCwd
  allow = typeof projectRoot === 'string' && typeof cwd === 'string'
    && isProjectBranchPath(cwd, projectRoot)
    && ['exec_command', 'shell_command', 'Bash'].includes(event.tool_name)
    && typeof (input?.cmd ?? input?.command) === 'string'
    && isReadOnlyBranchCommand(input.cmd ?? input.command, projectRoot, cwd)
    // No alternate executable or interactive/login shell supplied by the model.
    && input.shell === undefined && input.tty !== true && input.login !== true
} catch { /* explicit deny below */ }
console.log(JSON.stringify(allow ? {} : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
  permissionDecisionReason: BRANCH_READ_DENIAL } }))
