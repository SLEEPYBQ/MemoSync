import { fileURLToPath } from 'node:url'

/** Codex can run Windows hooks through either PowerShell or COMSPEC. Keep the
 * outer command free of quoted paths; pass the exact paths as encoded script. */
export function codexBranchGuardCommand(projectRoot: string, denyAllTools: boolean): string {
  const guard = fileURLToPath(new URL('./codex-branch-guard.ts', import.meta.url))
  if (process.platform === 'win32') {
    const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'"
    const script = [
      "$env:BUN_BE_BUN='1'",
      '$OutputEncoding=[Text.UTF8Encoding]::new($false)',
      '[Console]::InputEncoding=$OutputEncoding',
      '$payload=[Console]::In.ReadToEnd()',
      `$payload | & ${quote(process.execPath)} ${quote(guard)} ${quote(projectRoot)}${denyAllTools ? ' --deny-all-tools' : ''}`,
      'exit $LASTEXITCODE',
    ].join('; ')
    return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`
  }
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
  return `BUN_BE_BUN=1 ${quote(process.execPath)} ${quote(guard)} ${quote(projectRoot)}${denyAllTools ? ' --deny-all-tools' : ''}`
}
