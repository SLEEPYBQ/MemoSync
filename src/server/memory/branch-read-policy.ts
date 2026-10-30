/**
 * Conservative shell subset. Claude's Bash tool is retained for inspection,
 * but no shell composition, expansion, interpreter, or executable helper is
 * permitted. Read/Glob/Grep remain available for everything else.
 */
export function isReadOnlyBranchCommand(command: string): boolean {
  if (!command.trim() || /[\n\r;&|<>`$\\(){}]/.test(command)) return false
  const tokens = command.match(/"[^"\n]*"|'[^'\n]*'|[^\s"']+/g)
  if (!tokens || tokens.join(" ").replace(/\s+/g, " ") !== command.trim().replace(/\s+/g, " ")) return false
  const words = tokens.map((token) => token.replace(/^(['"])(.*)\1$/, "$2"))
  const executable = words[0]
  if (!["pwd", "ls", "cat", "head", "tail", "wc", "rg", "grep"].includes(executable)) return false
  if (executable === "rg" && words.some((word) => /^--(?:pre(?:-glob)?|hostname-bin)(?:=|$)/.test(word))) return false
  return true
}
