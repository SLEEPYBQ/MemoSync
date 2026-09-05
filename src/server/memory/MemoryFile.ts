// MemoryFile — write the user-visible Markdown projection of memories.
//
// Markdown is a human-readable, lossy EXPORT (SQLite is the source of truth;
// the app is the only write surface — hand edits to these files are never read
// back). Personal memories are grouped by TYPE (## Preferences / ## Lessons /
// ...), project memories are grouped by TOPIC (## Testing / ## Environment /
// ...).
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, readdirSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import type { MemoryItem, MemoryScope, MemoryType } from './types';
import { computeMemoryHash } from './hash';
import { compareMemoryId } from './ids';

/**
 * A project/repo identifier becomes a single path segment under `projects/`.
 * Reject anything that could escape that directory (path separators, `..`,
 * absolute paths, NUL) — otherwise a request-supplied repoId is an arbitrary
 * file-write/read primitive (markdown is written with mkdir -p + writeFile).
 */
export function assertSafeSegment(name: string): string {
  if (
    !name ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('..') ||
    name.includes('\0') ||
    isAbsolute(name)
  ) {
    throw new Error(`unsafe path segment: ${JSON.stringify(name)}`);
  }
  return name;
}

// Section name used to bucket project memories that have no topic. Treated as a
// sentinel (not a real topic) so the write -> read round-trip stays symmetric.
const NO_TOPIC_SECTION = 'General';

/** The subset of a memory recoverable from its Markdown representation. */
export interface ParsedMemory {
  id: string;
  content: string;
  scope: MemoryScope;
  type?: MemoryType; // recovered for personal scope (section = type)
  topic?: string; // recovered for project scope (section = topic)
}

/** A bullet line the user added by hand — no [M-NN] anchor yet. */
export interface ParsedAddition {
  content: string;
  type?: MemoryType;
  topic?: string;
}

export interface ParsedFile {
  items: ParsedMemory[];
  additions: ParsedAddition[];
}

// Everything after this marker is display-only (pending candidates rendered
// for context); the parser stops here so edits below it are never ingested.
const PENDING_MARKER = '<!-- memosync:pending — read-only, decide in the app -->';

type GroupBy = 'type' | 'topic';

const TYPE_TO_SECTION: Record<MemoryType, string> = {
  preference: 'Preferences',
  lesson: 'Lessons',
  constraint: 'Constraints',
  fact: 'Facts',
};

const SECTION_TO_TYPE: Record<string, MemoryType> = {
  Preferences: 'preference',
  Lessons: 'lesson',
  Constraints: 'constraint',
  Facts: 'fact',
};

const ITEM_RE = /^- \[([^\]]+)\]\s*(.*)$/;
const ADDITION_RE = /^- (?!\[)\s*(.+)$/;

export class MemoryFile {
  constructor(private dataDir: string) {}

  personalPath(): string {
    return join(this.dataDir, 'personal', 'memories.md');
  }

  projectPath(repoName: string): string {
    return join(this.dataDir, 'projects', assertSafeSegment(repoName), 'memories.md');
  }

  /** Project projection directories already present on disk (including stale ones). */
  listProjectedProjects(): string[] {
    const root = join(this.dataDir, 'projects');
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => {
        try {
          assertSafeSegment(name);
          return true;
        } catch {
          return false;
        }
      });
  }

  writePersonal(items: MemoryItem[], pending: MemoryItem[] = []): void {
    const content = this.render('# Personal Memories', items, 'type', pending);
    this.writeFile(this.personalPath(), content);
  }

  writeProject(repoName: string, items: MemoryItem[], pending: MemoryItem[] = []): void {
    const content = this.render(`# Project: ${repoName}`, items, 'topic', pending);
    this.writeFile(this.projectPath(repoName), content);
  }

  readPersonal(): ParsedMemory[] {
    return this.parse(this.personalPath(), 'personal', 'type');
  }

  readProject(repoName: string): ParsedMemory[] {
    return this.parse(this.projectPath(repoName), 'project', 'topic');
  }

  // ── Raw text access (read-only viewing/export) ──────────────────────────

  readPersonalRaw(): string {
    const path = this.personalPath();
    return existsSync(path) ? readFileSync(path, 'utf-8') : '';
  }

  readProjectRaw(repoName: string): string {
    const path = this.projectPath(repoName);
    return existsSync(path) ? readFileSync(path, 'utf-8') : '';
  }

  private writeFile(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const tempPath = `${path}.tmp`;
    writeFileSync(tempPath, content, 'utf-8');
    renameSync(tempPath, path);
  }

  private render(title: string, items: MemoryItem[], groupBy: GroupBy, pending: MemoryItem[] = []): string {
    const lines: string[] = [
      title,
      '<!-- generated by MemoSync — edit memories in the app; changes to this file are not read back -->',
      `<!-- memosync:hash:${computeMemoryHash(items)} -->`,
      `<!-- memosync:updated:${new Date().toISOString()} -->`,
      '',
    ];

    // Group preserving first-appearance order of sections.
    const groups = new Map<string, MemoryItem[]>();
    for (const item of items) {
      const key = groupBy === 'type' ? TYPE_TO_SECTION[item.type] : (item.topic ?? NO_TOPIC_SECTION);
      const bucket = groups.get(key);
      if (bucket) bucket.push(item);
      else groups.set(key, [item]);
    }

    for (const [section, bucket] of groups) {
      lines.push(`## ${section}`);
      const sorted = [...bucket].sort((a, b) => compareMemoryId(a.id, b.id));
      for (const item of sorted) lines.push(`- [${item.id}] ${item.content}`);
      lines.push('');
    }

    // A hand-added line does not vanish on sync — it moves down here with its
    // assigned candidate id until the user decides it. Display-only: the
    // parser stops at the marker, so edits below it are never ingested.
    if (pending.length > 0) {
      lines.push(PENDING_MARKER);
      lines.push('## Pending review (decide in the app)');
      const sorted = [...pending].sort((a, b) => compareMemoryId(a.id, b.id));
      for (const item of sorted) lines.push(`- [${item.id}] ${item.content}`);
      lines.push('');
    }

    return lines.join('\n');
  }

  private parse(path: string, scope: MemoryScope, groupBy: GroupBy): ParsedMemory[] {
    return this.parseFull(path, scope, groupBy).items;
  }

  private parseFull(path: string, scope: MemoryScope, groupBy: GroupBy): ParsedFile {
    if (!existsSync(path)) return { items: [], additions: [] };

    const items: ParsedMemory[] = [];
    const additions: ParsedAddition[] = [];
    let section: string | null = null;

    for (const raw of readFileSync(path, 'utf-8').split('\n')) {
      const line = raw.trim();
      // Everything below the pending marker is display-only.
      if (line === PENDING_MARKER) break;
      if (line.startsWith('## ')) {
        section = line.slice(3).trim();
        continue;
      }

      const sectionMeta = (target: ParsedMemory | ParsedAddition) => {
        if (groupBy === 'type' && section) {
          target.type = SECTION_TO_TYPE[section];
        } else if (groupBy === 'topic' && section && section !== NO_TOPIC_SECTION) {
          // 'General' is the no-topic sentinel — leave topic undefined.
          target.topic = section;
        }
      };

      const match = ITEM_RE.exec(line);
      if (match) {
        const parsed: ParsedMemory = { id: match[1].trim(), content: match[2].trim(), scope };
        sectionMeta(parsed);
        items.push(parsed);
        continue;
      }
      // A bullet with no [M-NN] anchor: the user wrote a new memory by hand.
      const added = ADDITION_RE.exec(line);
      if (added && added[1].trim()) {
        const parsed: ParsedAddition = { content: added[1].trim() };
        sectionMeta(parsed);
        additions.push(parsed);
      }
    }

    return { items, additions };
  }
}
