import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

export const BRANCH_READ_DENIAL = 'Memory-analysis branches may only inspect files and run simple read-only commands. Reads are limited to the project.'

/** Resolve components before .. so a symlink followed by .. cannot be normalized away.
 * Missing leaves are safe to attempt; broken links and other resolution errors fail closed.
 */
export function isProjectBranchPath(path: unknown, projectRoot: string, cwd = projectRoot): boolean {
  if (path === undefined) path = '.'
  if (typeof path !== 'string' || path.includes('\0') || path.startsWith('~')) return false
  try {
    const root = realpathSync(projectRoot)
    const inside = (value: string) => { const tail = relative(root, value); return tail !== '..' && !tail.startsWith(`..${sep}`) && !isAbsolute(tail) }
    let current = isAbsolute(path) ? parse(path).root : realpathSync(cwd)
    if (!isAbsolute(path) && !inside(current)) return false
    for (const part of path.split(sep)) {
      if (!part || part === '.') continue
      if (part === '..') current = dirname(current)
      else {
        const next = join(current, part)
        try { current = realpathSync(next) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
          // realpath also reports ENOENT for a dangling symlink.
          try { if (lstatSync(next).isSymbolicLink()) return false } catch { /* missing leaf */ }
          current = next
        }
      }
      if (!isAbsolute(path) && !inside(current)) return false
    }
    return inside(current)
  } catch { return false }
}

/** Match Pi's path normalization and read-tool filename fallbacks before checking
 * realpath. Otherwise a missing ASCII name could select an outside curly/NFD link.
 */
export function isPiBranchPath(path: unknown, projectRoot: string, readFallbacks: boolean): boolean {
  if (typeof path !== 'string') return isProjectBranchPath(path, projectRoot)
  const normalized = path.replace(/^@/, '').replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
  if (!isProjectBranchPath(normalized, projectRoot)) return false
  if (!readFallbacks) return true
  const full = resolve(projectRoot, normalized)
  const nfd = full.normalize('NFD')
  const variants = [full, full.replace(/ (AM|PM)\./gi, '\u202F$1.'), nfd, full.replace(/'/g, '’'), nfd.replace(/'/g, '’')]
  return isProjectBranchPath(variants.find(candidate => existsSync(candidate)) ?? full, projectRoot)
}

/** Conservative shell subset; no composition, expansion, executable helpers or
 * recursive symlink following. Check every operand, including option values.
 */
export function isReadOnlyBranchCommand(command: string, projectRoot = process.cwd(), cwd = projectRoot): boolean {
  if (!command.trim() || /[\n\r;&|<>`$\\(){}]/.test(command) || !isProjectBranchPath(cwd, projectRoot)) return false
  const tokens = command.match(/"[^"\n]*"|'[^'\n]*'|[^\s"']+/g)
  if (!tokens || tokens.join(' ').replace(/\s+/g, ' ') !== command.trim().replace(/\s+/g, ' ')) return false
  const words = tokens.map(token => token.replace(/^(['"])(.*)\1$/, '$2'))
  const executable = words[0]
  if (!['pwd', 'ls', 'cat', 'head', 'tail', 'wc', 'rg', 'grep'].includes(executable)) return false
  for (let index = 1; index < words.length; index++) {
    const word = words[index]!
    // Unquoted globbing can expand to an outside-project symlink at execution.
    if (!/^['"]/.test(tokens[index]!) && /[*?\[]/.test(word)) return false
    if (/^--(?:pre(?:-glob)?|hostname-bin|files0-from|follow|dereference(?:-recursive)?)(?:=|$)/.test(word)) return false
    if ((executable === 'rg' && /^-[^-]*L/.test(word))
      || (executable === 'grep' && /^-[^-]*[rR]/.test(word))
      || (executable === 'ls' && (/^-[^-]*[HL]/.test(word) || /^--dereference/.test(word)))) return false
    // -fFILE (also bundled as -nfFILE) reads a pattern file.
    const shortFile = ['rg', 'grep'].includes(executable) ? word.match(/^-[^-]*?f(.*)$/) : null
    const value = word.includes('=') && word.startsWith('-') ? word.slice(word.indexOf('=') + 1)
      : shortFile ? shortFile[1]! : word
    if (isAbsolute(value) || value.startsWith('~') || !isProjectBranchPath(value, projectRoot, cwd)) return false
  }
  return true
}
