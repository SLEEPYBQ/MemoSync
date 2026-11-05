import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  NativeDiscoverySkippedEntry,
  NativeMemoryEngine,
  NativeMemoryRoot,
  NativeMemorySource,
  NativeSourceKind,
} from "../../shared/native-memory";
import { looksLikeSecret } from "./secrets";

export const nativeHash = (text: string | Uint8Array): string =>
  createHash("sha256").update(text).digest("hex");

export class NativeMemoryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Credentials are quarantined; contact details only require local review. */
export function nativeTextSensitive(text: string): boolean {
  return (
    looksLikeSecret(text) ||
    /^\s*(?:[-*+]\s+)?["']?(?:api[_-]?key|access[_-]?key|secret|token|password|passwd|credential)s?["']?\s*[:=]\s*(?:[|>][-+]?)?\s*$/im.test(
      text,
    ) ||
    /\b(?:authorization\s*:\s*\S|bearer\s+[A-Za-z0-9._~+/-]{8,})/i.test(text) ||
    /\b(?:api[_-]?key|access[_-]?key|secret|token|password|passwd|credential)s?\b["']?\s*[:=]\s*\S+/i.test(
      text,
    )
  );
}
export function nativeTextPersonal(text: string): boolean {
  return (
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text) ||
    /\b\d{3}-\d{2}-\d{4}\b/.test(text) ||
    /(?:\+\d[\d ()-]{8,}\d)/.test(text) ||
    /\b(?:\d[ -]?){10,19}\b/.test(text)
  );
}

export interface NativeMarkdownBlock {
  startLine: number;
  endLine: number;
  quote: string;
  content: string;
  context?: string;
  kind:
    | "content"
    | "heading"
    | "empty"
    | "frontmatter"
    | "comment"
    | "code"
    | "table"
    | "blockquote";
}

/** One linear pass shared by discovery, local extraction and model screening.
 * List continuation (including nested lists and fenced/comment content) stays
 * with its parent. Unsupported structural blocks are reported, never fragments.
 */
export function nativeMarkdownBlocks(text: string): NativeMarkdownBlock[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  // Keep the BOM in exact evidence even though it does not affect parsing.
  const original = text.split(/\r?\n/);
  const blocks: NativeMarkdownBlock[] = [];
  const headings: Array<{ level: number; title: string }> = [];
  const bullet = (line: string) => line.match(/^(\s*)(?:[-*+]\s+|\d+[.)]\s+)/);
  const heading = (line: string) =>
    line.match(/^ {0,3}(#{1,6})(?:\s+(.+?)\s*#*\s*|\s*)$/);
  const fence = (line: string) => line.match(/^\s*(`{3,}|~{3,})/);
  const special = (line: string) =>
    heading(line) ||
    fence(line) ||
    /^\s*(?:<!--|-->|-----BEGIN [A-Z ]*PRIVATE KEY-----|\||>|(?:[-*_]\s*){3,}$)/.test(
      line,
    );
  let index = 0;
  while (index < lines.length) {
    const start = index,
      first = lines[index]!;
    let kind: NativeMarkdownBlock["kind"] = "content";
    const title = heading(first);
    const setext = lines[index + 1]?.match(/^ {0,3}(=+|-+)\s*$/);
    if (!first.trim()) {
      kind = "empty";
      while (index + 1 < lines.length && !lines[index + 1]!.trim()) index++;
    } else if (index === 0 && /^---\s*$/.test(first)) {
      kind = "frontmatter";
      while (
        ++index < lines.length &&
        !/^(?:---|\.\.\.)\s*$/.test(lines[index]!)
      ) {
        /* whole YAML block */
      }
      index = Math.min(index, lines.length - 1);
    } else if (title || (setext && !bullet(first) && !special(first))) {
      kind = "heading";
      const level = title ? title[1]!.length : setext![1]![0] === "=" ? 1 : 2;
      const name = title ? (title[2] ?? "") : first.trim();
      while (headings.length && headings[headings.length - 1]!.level >= level)
        headings.pop();
      // A credential in a heading must never enter descendant context.
      if (name && !nativeTextSensitive(name))
        headings.push({ level, title: name });
      if (setext && !title) index++;
    } else if (/^\s*(?:<!--|-->)/.test(first)) {
      kind = "comment";
      if (first.includes("<!--") && !first.includes("-->")) {
        while (index + 1 < lines.length && !lines[index]!.includes("-->"))
          index++;
      }
    } else if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(first)) {
      while (
        index + 1 < lines.length &&
        !/-----END [A-Z ]*PRIVATE KEY-----/.test(lines[index]!)
      )
        index++;
    } else if (fence(first)) {
      kind = "code";
      const marker = fence(first)![1]!;
      while (index + 1 < lines.length) {
        index++;
        const close = fence(lines[index]!);
        if (
          close &&
          close[1]![0] === marker[0] &&
          close[1]!.length >= marker.length
        )
          break;
      }
    } else {
      if (/^\s*\|/.test(first)) kind = "table";
      else if (/^\s*>/.test(first)) kind = "blockquote";
      const list = bullet(first),
        indent = list?.[1]!.length ?? 0;
      const credentialDeclaration =
        /^\s*(?:[-*+]\s+)?["']?(?:api[_-]?key|access[_-]?key|secret|token|password|passwd|credential)s?["']?\s*[:=]\s*(?:[|>][-+]?)?\s*$/i.test(
          first,
        );
      let openFence: string | undefined;
      let comment = false,
        privateKey = false;
      for (;;) {
        const current = lines[index]!;
        const marker = fence(current);
        if (marker) {
          if (!openFence) openFence = marker[1]!;
          else if (
            marker[1]![0] === openFence[0] &&
            marker[1]!.length >= openFence.length
          )
            openFence = undefined;
        }
        if (current.includes("<!--") && !current.includes("-->"))
          comment = true;
        if (current.includes("-->")) comment = false;
        if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(current))
          privateKey = true;
        if (/-----END [A-Z ]*PRIVATE KEY-----/.test(current))
          privateKey = false;
        const next = lines[index + 1];
        if (next === undefined) break;
        if (openFence || comment || privateKey) {
          index++;
          continue;
        }
        if (!next.trim()) {
          // Blank-separated, indented continuation belongs to the same bullet.
          let after = index + 1;
          while (after < lines.length && !lines[after]!.trim()) after++;
          if (
            after < lines.length &&
            ((list && lines[after]!.match(/^\s*/)![0].length > indent) ||
              (credentialDeclaration &&
                !bullet(lines[after]!) &&
                !heading(lines[after]!)))
          ) {
            index++;
            continue;
          }
          break;
        }
        const nextBullet = bullet(next);
        if (list) {
          if ((nextBullet && nextBullet[1]!.length <= indent) || heading(next))
            break;
          if (
            special(next) &&
            next.match(/^\s*/)![0].length <= indent &&
            !(
              fence(next) &&
              nativeTextSensitive(lines.slice(start, index + 1).join("\n"))
            )
          )
            break;
        } else if (
          nextBullet ||
          (special(next) &&
            !(
              fence(next) &&
              nativeTextSensitive(lines.slice(start, index + 1).join("\n"))
            )) ||
          /^ {0,3}(?:=+|-+)\s*$/.test(next)
        )
          break;
        index++;
      }
    }
    const quote = original.slice(start, index + 1).join("\n");
    const content = lines
      .slice(start, index + 1)
      .join("\n")
      .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, "")
      .trim();
    blocks.push({
      startLine: start + 1,
      endLine: index + 1,
      quote,
      content,
      kind,
      ...(headings.length && kind !== "heading"
        ? { context: headings.map((value) => value.title).join(" > ") }
        : {}),
    });
    index++;
  }
  return blocks;
}

/** Replace quarantined lines with blanks, preserving original model line numbers. */
export function screenedNativeText(
  text: string,
  blocks = nativeMarkdownBlocks(text),
): string {
  const lines = text.split(/\r?\n/);
  for (const block of blocks) {
    if (nativeTextSensitive(block.quote)) {
      let end = block.endLine;
      if (block.kind === "heading") {
        const level = /^\s*(#+)/.exec(block.quote)?.[1]?.length ?? 1;
        const next = blocks.find(
          (b) =>
            b.startLine > block.endLine &&
            b.kind === "heading" &&
            (/^\s*(#+)/.exec(b.quote)?.[1]?.length ?? 1) <= level,
        );
        end = next ? next.startLine - 1 : lines.length;
      }
      lines.fill("", block.startLine - 1, end);
    }
  }
  return lines.join("\n");
}

// Markdown destinations (including <paths with spaces>) and the plain/backtick
// paths used by native indexes, e.g. rollout_summaries/task.md (cwd=...).
const markdownLink =
  /!?\[[^\[\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^\n]*?["'])?\s*\)/g;
const markdownDefinition =
  /^\s{0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|(\S+))(?:\s+.*)?$/;
const codePath = /`([^`\n]+)`/g;
// Tokenize first, then check the extension; a suffix-search regex can backtrack
// quadratically on long unbroken (but otherwise valid) memory lines.
const bareToken = /[^\s`'"<>()\[\]{},;]+/g;
function memoryPath(value: string): string | undefined {
  try {
    const path = decodeURIComponent(value.split(/[?#]/, 1)[0]!);
    if (
      !path ||
      path.includes("\0") ||
      path.includes("\\") ||
      /^[a-z][a-z\d+.-]*:/i.test(path) ||
      path.startsWith("//") ||
      !/\.md$/i.test(path)
    )
      return;
    return path;
  } catch {
    return;
  }
}
function lineReferences(line: string): string[] {
  const paths: string[] = [];
  const add = (raw: string) => {
    const path = memoryPath(raw);
    if (path) paths.push(path);
  };
  // Strip links/code before finding bare tokens so captions and URL fragments
  // cannot create extra relationships beside the actual destination.
  const definition = line.match(markdownDefinition);
  if (definition) {
    add(definition[1] ?? definition[2]!);
    return paths;
  }
  const plain = line
    .replace(
      markdownLink,
      (_match, angle: string | undefined, bare: string | undefined) => {
        add(angle ?? bare!);
        return "";
      },
    )
    .replace(codePath, (_match, path: string) => {
      add(path);
      return "";
    });
  for (const match of plain.matchAll(bareToken))
    add(match[0].replace(/[.:]+$/, ""));
  return paths;
}
export function nativeReferences(text: string): string[] {
  const paths = new Set<string>();
  let fence: string | undefined;
  for (const line of text
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .split(/\r?\n/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1]!;
      else if (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length)
        fence = undefined;
      continue;
    }
    if (fence || /^\s*(?:>|<!--)/.test(line)) continue;
    for (const path of lineReferences(line)) paths.add(path);
  }
  return [...paths];
}

/** Navigation is not a standalone memory claim. Keep any surrounding prose
 * intact, including claims that happen to contain a link or a code path. */
export function nativeNavigationLine(content: string): boolean {
  if (markdownDefinition.test(content)) return true;
  const remaining = content
    .replace(markdownLink, "")
    .replace(/!?\[[^\[\]\n]+\]\[[^\[\]\n]*\]/g, "")
    .replace(codePath, (match, value: string) =>
      memoryPath(value) ? "" : match,
    )
    .replace(bareToken, (match) =>
      memoryPath(match.replace(/[.:]+$/, "")) ? "" : match,
    )
    .replace(
      /\((?:cwd|rollout_path|updated_at|thread_id)=[^,\n()]+(?:,\s*(?:cwd|rollout_path|updated_at|thread_id)=[^,\n()]+)*\)/g,
      "",
    )
    .replace(/^(?:see|read|refer to)\s+/i, "")
    .trim();
  return /^[\s,;:.–—\-→]*$/.test(remaining);
}

interface DiscoveryStats {
  skippedEntries: NativeDiscoverySkippedEntry[];
}
interface Candidate {
  path: string;
  engine: NativeMemoryEngine;
  kind: NativeSourceKind;
  root: NativeMemoryRoot;
  boundary: string;
  memoryRoot?: string;
  namespace: string;
}
const missing = (error: unknown) =>
  ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
class CandidateReadError extends Error {
  constructor(readonly reason: NativeDiscoverySkippedEntry["reason"]) {
    super(reason);
  }
}
const skipEntry = (
  stats: DiscoveryStats,
  path: string,
  reason: NativeDiscoverySkippedEntry["reason"],
) => stats.skippedEntries.push({ path, reason });
const readFailure = (e: unknown): NativeDiscoverySkippedEntry["reason"] =>
  e instanceof CandidateReadError ? e.reason : "unreadable";
export class NativeMemoryDiscovery {
  readonly claudeConfigDir: string;
  readonly codexHome: string;
  constructor(
    readonly homeDir: string,
    readonly roots: () => NativeMemoryRoot[],
    locations: { claudeConfigDir?: string; codexHome?: string } = {},
  ) {
    this.claudeConfigDir = resolve(
      locations.claudeConfigDir || join(homeDir, ".claude"),
    );
    this.codexHome = resolve(locations.codexHome || join(homeDir, ".codex"));
  }
  allowedRoots(): NativeMemoryRoot[] {
    return this.roots().map((root) => ({
      ...root,
      locations: [root.path],
      memoryLocations:
        root.owner.scope === "personal"
          ? [
              {
                engine: "codex",
                path: join(this.codexHome, "memories"),
              },
              {
                engine: "codex",
                path: join(this.codexHome, "memories_v2"),
              },
              {
                engine: "claude",
                path: join(this.claudeConfigDir, "projects"),
              },
            ]
          : [
              {
                engine: "claude",
                path: join(
                  this.claudeConfigDir,
                  "projects",
                  root.path.replace(/[^a-zA-Z0-9]/g, "-"),
                  "memory",
                ),
              },
            ],
    }));
  }
  private assertPlainPath(path: string, boundary: string): void {
    const rel = relative(boundary, path);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new CandidateReadError("unreadable");
    // The engine home may sit under system or user links (/var -> /private/var,
    // a dotfiles ~/.claude); only links inside it can redirect a memory read.
    let current = resolve(boundary);
    for (const component of rel.split(sep).filter(Boolean)) {
      current = join(current, component);
      if (lstatSync(current).isSymbolicLink())
        throw new CandidateReadError("symlink");
    }
    if (realpathSync(path) !== join(realpathSync(boundary), rel))
      throw new CandidateReadError("symlink");
  }
  private readCandidate(candidate: Candidate): { text: string; bytes: number } {
    for (let attempt = 0; attempt < 3; attempt++) {
      this.assertPlainPath(candidate.path, candidate.boundary);
      const fd = openSync(
        candidate.path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const before = fstatSync(fd);
        if (!before.isFile() || before.nlink !== 1)
          throw new CandidateReadError("unreadable");
        const buffer = readFileSync(fd);
        const after = fstatSync(fd),
          current = lstatSync(candidate.path);
        this.assertPlainPath(candidate.path, candidate.boundary);
        if (
          before.ino !== current.ino ||
          before.dev !== current.dev ||
          before.size !== buffer.length ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs ||
          before.size !== current.size ||
          before.mtimeMs !== current.mtimeMs ||
          before.ctimeMs !== current.ctimeMs
        )
          continue;
        if (buffer.includes(0)) throw new CandidateReadError("binary");
        try {
          return {
            text: new TextDecoder("utf-8", {
              fatal: true,
              ignoreBOM: true,
            }).decode(buffer),
            bytes: buffer.length,
          };
        } catch {
          throw new CandidateReadError("binary");
        }
      } finally {
        closeSync(fd);
      }
    }
    throw new CandidateReadError("unstable");
  }
  private candidates(
    root: NativeMemoryRoot,
    stats: DiscoveryStats,
  ): Candidate[] {
    const base = resolve(root.path),
      result: Candidate[] = [];
    const file = (
      path: string,
      engine: NativeMemoryEngine,
      kind: NativeSourceKind,
      boundary = base,
      memoryRoot?: string,
      namespace = "instructions",
    ) =>
      result.push({
        path,
        engine,
        kind,
        root,
        boundary,
        memoryRoot,
        namespace,
      });
    const walk = (
      dir: string,
      engine: NativeMemoryEngine,
      kind: NativeSourceKind,
      boundary: string,
      memoryRoot?: string,
      namespace = "instructions",
    ) => {
      let handle;
      try {
        this.assertPlainPath(dir, boundary);
        handle = opendirSync(dir);
        for (;;) {
          const entry = handle.readSync();
          if (!entry) break;
          if (
            entry.name.startsWith(".") ||
            entry.name === "phase2_workspace_diff.md" ||
            /\.lock$/i.test(entry.name)
          )
            continue;
          const path = join(dir, entry.name);
          if (entry.isSymbolicLink()) {
            skipEntry(stats, path, "symlink");
            continue;
          }
          if (entry.isDirectory()) {
            if (entry.name === "extensions") {
              walk(
                join(path, "ad_hoc", "notes"),
                engine,
                kind,
                boundary,
                memoryRoot,
                namespace,
              );
              continue;
            }
            walk(
              path,
              engine,
              entry.name === "skills" || kind === "skill" ? "skill" : kind,
              boundary,
              memoryRoot,
              namespace,
            );
          } else if (entry.isFile() && /\.md$/i.test(entry.name))
            file(
              path,
              engine,
              /^SKILL\.md$/i.test(entry.name)
                ? "skill"
                : /^(?:CLAUDE(?:\.local)?|AGENTS)\.md$/i.test(entry.name)
                  ? "project-rule"
                  : kind,
              boundary,
              memoryRoot,
              namespace,
            );
        }
      } catch (e) {
        if (!missing(e)) skipEntry(stats, dir, readFailure(e));
      } finally {
        handle?.closeSync();
      }
    };
    const claude = this.claudeConfigDir,
      codex = this.codexHome;
    if (root.owner.scope === "personal") {
      if (base !== resolve(this.homeDir))
        throw new NativeMemoryError(
          400,
          "INVALID_ROOT",
          "Personal root must be HOME",
        );
      walk(
        join(codex, "memories"),
        "codex",
        "native-memory",
        codex,
        join(codex, "memories"),
        "v1",
      );
      walk(
        join(codex, "memories_v2"),
        "codex",
        "native-memory",
        codex,
        join(codex, "memories_v2"),
        "v2",
      );
      let projects;
      try {
        this.assertPlainPath(join(claude, "projects"), claude);
        projects = opendirSync(join(claude, "projects"));
        for (;;) {
          const entry = projects.readSync();
          if (!entry) break;
          if (entry.isSymbolicLink()) {
            skipEntry(stats, join(claude, "projects", entry.name), "symlink");
            continue;
          }
          if (entry.isDirectory()) {
            const mem = join(claude, "projects", entry.name, "memory");
            walk(
              mem,
              "claude",
              "native-memory",
              claude,
              mem,
              `auto:${entry.name}`,
            );
          }
        }
      } catch (e) {
        if (!missing(e))
          skipEntry(stats, join(claude, "projects"), readFailure(e));
      } finally {
        projects?.closeSync();
      }
      walk(
        join(claude, "agent-memory"),
        "claude",
        "native-memory",
        claude,
        join(claude, "agent-memory"),
        "agent:user",
      );
      for (const [engine, config] of [
        ["claude", claude],
        ["codex", codex],
        ["pi", join(base, ".pi", "agent")],
        ["opencode", join(base, ".config", "opencode")],
      ] as const) {
        file(
          join(config, engine === "claude" ? "CLAUDE.md" : "AGENTS.md"),
          engine,
          "project-rule",
          config,
        );
        walk(join(config, "skills"), engine, "skill", config);
      }
      walk(join(claude, "rules"), "claude", "project-rule", claude);
    } else {
      for (const path of ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md"])
        file(join(base, path), "claude", "project-rule");
      file(join(base, "AGENTS.md"), "codex", "project-rule");
      walk(join(base, ".claude", "rules"), "claude", "project-rule", base);
      for (const [engine, folder] of [
        ["claude", ".claude"],
        ["codex", ".agents"],
        ["pi", ".pi"],
        ["opencode", ".opencode"],
      ] as const)
        walk(join(base, folder, "skills"), engine, "skill", base);
      const mem = join(
        claude,
        "projects",
        base.replace(/[^a-zA-Z0-9]/g, "-"),
        "memory",
      );
      walk(
        mem,
        "claude",
        "native-memory",
        claude,
        mem,
        `auto:${base.replace(/[^a-zA-Z0-9]/g, "-")}`,
      );
      for (const folder of ["agent-memory", "agent-memory-local"]) {
        const path = join(base, ".claude", folder);
        walk(
          path,
          "claude",
          "native-memory",
          base,
          path,
          `agent:${root.id}:${folder}`,
        );
      }
    }
    return result;
  }
  discover(rootIds: string[]): {
    sources: NativeMemorySource[];
    texts: Map<string, string>;
    skippedEntries: NativeDiscoverySkippedEntry[];
  } {
    if (
      !Array.isArray(rootIds) ||
      !rootIds.length ||
      rootIds.some((id) => typeof id !== "string") ||
      new Set(rootIds).size !== rootIds.length
    )
      throw new NativeMemoryError(
        400,
        "BAD_REQUEST",
        "Select distinct allowed root IDs",
      );
    const available = this.allowedRoots();
    const roots = rootIds.map((id) => {
      const root = available.find((r) => r.id === id);
      if (!root)
        throw new NativeMemoryError(
          400,
          "INVALID_ROOT",
          "Unknown allowed root ID",
        );
      return root;
    });
    const stats: DiscoveryStats = { skippedEntries: [] },
      sources: NativeMemorySource[] = [],
      texts = new Map<string, string>();
    const paths = new Set<string>();
    for (const root of roots)
      for (const candidate of this.candidates(root, stats)) {
        if (paths.has(candidate.path)) continue;
        try {
          const read = this.readCandidate(candidate),
            blocks = nativeMarkdownBlocks(read.text);
          paths.add(candidate.path);
          const quarantinedBlocks = blocks.filter((b) =>
            nativeTextSensitive(b.quote),
          ).length;
          const safe = screenedNativeText(read.text, blocks);
          const role: NativeMemorySource["role"] =
            candidate.kind !== "native-memory"
              ? "asset"
              : candidate.path.includes(
                    `${sep}extensions${sep}ad_hoc${sep}notes${sep}`,
                  )
                ? "correction"
                : (/(?:^|[\\/])(?:memory_summary|MEMORY)\.md$/.test(
                      candidate.path,
                    ) &&
                      candidate.engine === "claude") ||
                    /memory_summary\.md$/.test(candidate.path)
                  ? "navigation"
                  : candidate.engine === "codex" &&
                      candidate.namespace === "v1" &&
                      candidate.path !==
                        join(candidate.memoryRoot!, "MEMORY.md")
                    ? "evidence"
                    : candidate.engine === "codex" &&
                        candidate.namespace === "v2" &&
                        !candidate.path.includes(`${sep}rollout_summaries${sep}`)
                      ? "navigation"
                      : "units";
          let metadata: Record<string, unknown> | undefined;
          const frontmatter = nativeMarkdownBlocks(safe).find(
            (b) => b.kind === "frontmatter",
          );
          if (frontmatter?.quote.trim())
            try {
              const value = Bun.YAML.parse(
                frontmatter.quote.split(/\r?\n/).slice(1, -1).join("\n"),
              );
              if (value && typeof value === "object" && !Array.isArray(value))
                metadata = JSON.parse(JSON.stringify(value));
            } catch {
              metadata = { parseAnomaly: "malformed-frontmatter" };
            }
          const source: NativeMemorySource = {
            sourceId: nativeHash(
              JSON.stringify([
                candidate.engine,
                candidate.namespace,
                candidate.path,
              ]),
            ),
            rootId: root.id,
            engine: candidate.engine,
            namespace: candidate.namespace,
            kind: candidate.kind,
            locator: candidate.path,
            memoryRoot: candidate.memoryRoot,
            relativePath: candidate.memoryRoot
              ? relative(candidate.memoryRoot, candidate.path)
              : undefined,
            sourceVersion: 1,
            sourceHash: nativeHash(read.text),
            bytes: read.bytes,
            owner: root.owner,
            trust:
              candidate.kind === "native-memory"
                ? "agent-generated"
                : "imported-unknown",
            screening: quarantinedBlocks
              ? safe.trim()
                ? "partially-blocked"
                : "blocked-sensitive"
              : "clear",
            quarantinedBlocks,
            ...(candidate.kind === "project-rule"
              ? {
                  instructionImports: nativeMarkdownBlocks(safe)
                    .filter((b) => b.kind === "content")
                    .flatMap((b) =>
                      [
                        ...b.quote
                          .replace(/`+[^`]*`+/g, "")
                          .matchAll(/(?:^|\s)@([^\s`]+)/g),
                      ].map((m) => ({
                        path: resolve(candidate.path, "..", m[1]!),
                        base: resolve(candidate.path, ".."),
                        trust: "unverified-source-reference" as const,
                      })),
                    ),
                }
              : {}),
            metadata,
            role,
            importable: role === "units" && !!safe.trim(),
            indexedBy: [],
            isIndex: role === "navigation",
          };
          sources.push(source);
          texts.set(source.sourceId, read.text);
        } catch (e) {
          if (!missing(e)) skipEntry(stats, candidate.path, readFailure(e));
        }
      }
    return {
      sources: sources.sort((a, b) => a.locator.localeCompare(b.locator)),
      texts,
      ...stats,
      skippedEntries: [
        ...new Map(
          stats.skippedEntries.map((e) => [JSON.stringify(e), e]),
        ).values(),
      ],
    };
  }
  readSource(source: NativeMemorySource): string {
    const root = this.allowedRoots().find((r) => r.id === source.rootId);
    if (!root)
      throw new NativeMemoryError(
        409,
        "SOURCE_UNAVAILABLE",
        "Source root is no longer allowed",
      );
    const candidate = this.candidates(root, { skippedEntries: [] }).find(
      (c) =>
        c.path === source.locator &&
        c.namespace === source.namespace &&
        c.kind === source.kind,
    );
    if (!candidate)
      throw new NativeMemoryError(
        409,
        "SOURCE_UNAVAILABLE",
        "Source is outside the current allowlist",
      );
    try {
      return this.readCandidate(candidate).text;
    } catch {
      throw new NativeMemoryError(
        409,
        "SOURCE_UNAVAILABLE",
        "Source is unavailable or unstable",
      );
    }
  }
}
