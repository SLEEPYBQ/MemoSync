/** Native Codex PreToolUse command; no network, credentials, or workspace writes. */
import { isReadOnlyBranchCommand } from './branch-read-policy'

// Codex hooks fail open on malformed output. This guard always emits an explicit
// decision, including invalid inputs; the native read-only sandbox is retained.
let allow = false
try {
  const event = JSON.parse(await Bun.stdin.text())
  const input = typeof event.tool_input === 'string' ? JSON.parse(event.tool_input) : event.tool_input
  allow = ['exec_command', 'shell_command', 'Bash'].includes(event.tool_name)
    && typeof (input?.cmd ?? input?.command) === 'string'
    && isReadOnlyBranchCommand(input.cmd ?? input.command)
    // No alternate executable or interactive/login shell supplied by the model.
    && input.shell === undefined && input.tty !== true && input.login !== true
} catch { /* explicit deny below */ }
console.log(JSON.stringify(allow ? {} : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
  permissionDecisionReason: 'Memory branches may only run allowlisted read commands.' } }))
