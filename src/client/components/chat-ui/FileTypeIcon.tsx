// Colored per-type file icons for the Files workbench tree and tabs,
// approximating the Codex/Seti look with lucide glyphs.
import type { LucideIcon } from "lucide-react"
import {
  Braces, Cog, Container, Database, File, FileCode, FileText, GitBranch, Hash,
  Image, Lock, Palette, ScrollText, Terminal,
} from "lucide-react"
import { cn } from "../../lib/utils"

interface IconSpec {
  Icon: LucideIcon
  className: string
}

const DEFAULT_SPEC: IconSpec = { Icon: File, className: "text-muted-foreground" }

const BY_BASENAME: Record<string, IconSpec> = {
  "dockerfile": { Icon: Container, className: "text-sky-500" },
  ".dockerignore": { Icon: Container, className: "text-sky-500" },
  "docker-compose.yml": { Icon: Container, className: "text-sky-500" },
  "docker-compose.yaml": { Icon: Container, className: "text-sky-500" },
  ".gitignore": { Icon: GitBranch, className: "text-orange-500" },
  ".gitattributes": { Icon: GitBranch, className: "text-orange-500" },
  ".gitmodules": { Icon: GitBranch, className: "text-orange-500" },
  "license": { Icon: ScrollText, className: "text-muted-foreground" },
  "license.md": { Icon: ScrollText, className: "text-muted-foreground" },
  "makefile": { Icon: Terminal, className: "text-emerald-600 dark:text-emerald-500" },
}

const BY_EXT: Record<string, IconSpec> = {
  ts: { Icon: FileCode, className: "text-blue-500" },
  tsx: { Icon: FileCode, className: "text-blue-500" },
  mts: { Icon: FileCode, className: "text-blue-500" },
  cts: { Icon: FileCode, className: "text-blue-500" },
  js: { Icon: FileCode, className: "text-yellow-500" },
  jsx: { Icon: FileCode, className: "text-yellow-500" },
  mjs: { Icon: FileCode, className: "text-yellow-500" },
  cjs: { Icon: FileCode, className: "text-yellow-500" },
  json: { Icon: Braces, className: "text-amber-500" },
  jsonc: { Icon: Braces, className: "text-amber-500" },
  html: { Icon: Hash, className: "text-orange-500" },
  htm: { Icon: Hash, className: "text-orange-500" },
  css: { Icon: Palette, className: "text-sky-500" },
  scss: { Icon: Palette, className: "text-pink-500" },
  less: { Icon: Palette, className: "text-indigo-500" },
  md: { Icon: FileText, className: "text-sky-600 dark:text-sky-400" },
  mdx: { Icon: FileText, className: "text-sky-600 dark:text-sky-400" },
  markdown: { Icon: FileText, className: "text-sky-600 dark:text-sky-400" },
  py: { Icon: FileCode, className: "text-blue-600 dark:text-blue-400" },
  rs: { Icon: FileCode, className: "text-orange-600" },
  go: { Icon: FileCode, className: "text-cyan-600" },
  java: { Icon: FileCode, className: "text-red-500" },
  kt: { Icon: FileCode, className: "text-purple-500" },
  rb: { Icon: FileCode, className: "text-red-600" },
  c: { Icon: FileCode, className: "text-blue-400" },
  cc: { Icon: FileCode, className: "text-blue-400" },
  cpp: { Icon: FileCode, className: "text-blue-400" },
  h: { Icon: FileCode, className: "text-violet-400" },
  hpp: { Icon: FileCode, className: "text-violet-400" },
  sh: { Icon: Terminal, className: "text-emerald-600 dark:text-emerald-500" },
  bash: { Icon: Terminal, className: "text-emerald-600 dark:text-emerald-500" },
  zsh: { Icon: Terminal, className: "text-emerald-600 dark:text-emerald-500" },
  sql: { Icon: Database, className: "text-amber-600" },
  yml: { Icon: Cog, className: "text-teal-600 dark:text-teal-500" },
  yaml: { Icon: Cog, className: "text-teal-600 dark:text-teal-500" },
  toml: { Icon: Cog, className: "text-teal-600 dark:text-teal-500" },
  ini: { Icon: Cog, className: "text-muted-foreground" },
  cfg: { Icon: Cog, className: "text-muted-foreground" },
  conf: { Icon: Cog, className: "text-muted-foreground" },
  env: { Icon: Cog, className: "text-lime-600 dark:text-lime-500" },
  lock: { Icon: Lock, className: "text-amber-600" },
  png: { Icon: Image, className: "text-purple-500" },
  jpg: { Icon: Image, className: "text-purple-500" },
  jpeg: { Icon: Image, className: "text-purple-500" },
  gif: { Icon: Image, className: "text-purple-500" },
  webp: { Icon: Image, className: "text-purple-500" },
  avif: { Icon: Image, className: "text-purple-500" },
  ico: { Icon: Image, className: "text-purple-500" },
  bmp: { Icon: Image, className: "text-purple-500" },
  svg: { Icon: Image, className: "text-pink-500" },
  pdf: { Icon: FileText, className: "text-red-500" },
}

export function fileIconSpec(name: string): IconSpec {
  const lower = name.toLowerCase()
  const named = BY_BASENAME[lower]
  if (named) return named
  const dot = lower.lastIndexOf(".")
  if (dot < 0) return DEFAULT_SPEC
  return BY_EXT[lower.slice(dot + 1)] ?? DEFAULT_SPEC
}

export function FileTypeIcon({ name, className }: { name: string; className?: string }) {
  const { Icon, className: color } = fileIconSpec(name)
  return <Icon className={cn("size-4 shrink-0", color, className)} />
}
