import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { markdownBulletContent, normalizeContent } from './markdown-content';
import { semanticHash } from './view';
import type { MemoryStore } from './MemoryStore';
import type { ActorMeta, MemoryFileRef } from './types';

const MAX_FILE_SIZE = 1024 * 1024;
const MAX_PATHS = 8;

type RefRow = {
  memory_id: string;
  path: string;
  kind: MemoryFileRef['kind'];
  blob_hash: string;
  line_hash: string | null;
  memory_version: number;
  content_hash: string | null;
  size: number | null;
  mtime_ms: number | null;
  drift: MemoryFileRef['drift'];
  drift_hash: string | null;
};

export function gitBlobHash(bytes: Uint8Array): string {
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function excluded(path: string): boolean {
  return path.split(sep).some(part => part === '.git' || part === 'node_modules');
}

function projectFile(root: string, candidate: string): { path: string; fullPath: string; size: number; mtimeMs: number } | null {
  try {
    const lexical = resolve(root, candidate);
    if (!inside(root, lexical) || excluded(relative(root, lexical))) return null;
    const actual = realpathSync(lexical);
    if (!inside(root, actual) || excluded(relative(root, actual))) return null;
    const stat = statSync(actual);
    if (!stat.isFile()) return null;
    return { path: relative(root, lexical).split(sep).join('/'), fullPath: actual, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

export function extractPaths(text: string, localPath: string): string[] {
  try {
    const root = realpathSync(localPath);
    const found = new Set<string>();
    for (const raw of text.match(/`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|[^\s]+/g) ?? []) {
      const token = raw.replace(/^[`"'([{<]+/, '').replace(/[`"'\])}>.,;:!?]+$/, '').replace(/:\d+(?::\d+)?$/, '');
      if (!token || (!token.includes('/') && !/\.[a-zA-Z0-9_-]+$/.test(token))) continue;
      const file = projectFile(root, token);
      if (!file || file.size > MAX_FILE_SIZE) continue;
      found.add(file.path);
      if (found.size >= MAX_PATHS) break;
    }
    return [...found];
  } catch {
    return [];
  }
}

export function readProjectSource(localPath: string, sourcePath: string): { path: string; bytes: Buffer; size: number; mtimeMs: number } | null {
  try {
    if (isAbsolute(sourcePath)) return null;
    const root = realpathSync(localPath);
    const file = projectFile(root, sourcePath);
    if (!file) return null;
    return { path: file.path, bytes: readFileSync(file.fullPath), size: file.size, mtimeMs: file.mtimeMs };
  } catch {
    return null;
  }
}

export class FileDrift {
  constructor(
    private db: Database,
    private store: MemoryStore,
    private hash: (bytes: Uint8Array) => string = gitBlobHash,
  ) {}

  syncProject(projectId: string, localPath: string): void {
    let root: string;
    try {
      root = realpathSync(localPath);
      if (!statSync(root).isDirectory()) return;
      accessSync(root, constants.R_OK | constants.X_OK);
    } catch {
      return;
    }
    try {
      const items = [
        ...this.store.list({ scope: 'project', projectId, status: 'active' }),
        ...this.store.list({ scope: 'project', projectId, status: 'candidate' }),
      ];
      const rows = this.db.query(`SELECT r.* FROM memory_file_refs r JOIN memories m ON m.id = r.memory_id
        WHERE m.scope = 'project' AND m.project_id = ? AND m.status IN ('active', 'candidate')`)
        .all(projectId) as RefRow[];
      const mentions = new Map<string, RefRow[]>();
      for (const row of rows) if (row.kind === 'mention') {
        const existing = mentions.get(row.memory_id) ?? [];
        existing.push(row);
        mentions.set(row.memory_id, existing);
      }
      for (const item of items) {
        const existing = mentions.get(item.id) ?? [];
        const contentHash = semanticHash([item.content, item.detail ?? '']);
        if (existing.length && existing.every(row => row.memory_version === item.version && row.content_hash === contentHash)) continue;
        const paths = extractPaths(`${item.content}\n${item.detail ?? ''}`, root);
        const refs = paths.flatMap(path => {
          const file = projectFile(root, path);
          if (!file || file.size > MAX_FILE_SIZE) return [];
          try { return [{ ...file, hash: this.hash(readFileSync(file.fullPath)) }]; }
          catch { return []; }
        });
        this.db.transaction(() => {
          this.db.query("DELETE FROM memory_file_refs WHERE memory_id = ? AND kind = 'mention'").run(item.id);
          for (const ref of refs) this.db.query(`INSERT INTO memory_file_refs
            (memory_id, path, kind, blob_hash, memory_version, content_hash, size, mtime_ms, checked_at)
            VALUES (?, ?, 'mention', ?, ?, ?, ?, ?, ?)`)
            .run(item.id, ref.path, ref.hash, item.version, contentHash, ref.size, ref.mtimeMs, new Date().toISOString());
        })();
      }
      const current = this.db.query(`SELECT r.* FROM memory_file_refs r JOIN memories m ON m.id = r.memory_id
        WHERE m.scope = 'project' AND m.project_id = ? AND m.status IN ('active', 'candidate')`)
        .all(projectId) as RefRow[];
      for (const ref of current) {
        try {
          const file = projectFile(root, ref.path);
          if (!file) {
            this.db.query(`UPDATE memory_file_refs SET drift = ?, drift_hash = '', size = NULL, mtime_ms = NULL, checked_at = ?
              WHERE memory_id = ? AND path = ? AND kind = ?`)
              .run(ref.kind === 'source' ? 'line_removed' : 'missing', new Date().toISOString(), ref.memory_id, ref.path, ref.kind);
            continue;
          }
          if (file.size === ref.size && file.mtimeMs === ref.mtime_ms) continue;
          const bytes = readFileSync(file.fullPath);
          const hash = this.hash(bytes);
          const drift = ref.kind === 'mention'
            ? (hash === ref.blob_hash ? null : 'changed')
            : bytes.toString('utf8').split('\n').some(line => {
              const content = markdownBulletContent(line);
              return content !== null && semanticHash(normalizeContent(content)) === ref.line_hash;
            }) ? null : 'line_removed';
          this.db.query(`UPDATE memory_file_refs SET drift = ?, drift_hash = ?, size = ?, mtime_ms = ?, checked_at = ?
            WHERE memory_id = ? AND path = ? AND kind = ?`)
            .run(drift, drift ? hash : null, file.size, file.mtimeMs, new Date().toISOString(), ref.memory_id, ref.path, ref.kind);
        } catch {
          console.warn('[memory] Could not check a referenced file');
        }
      }
    } catch {
      console.warn('[memory] Could not check referenced files');
    }
  }

  addSource(id: string, source: { path: string; bytes: Buffer; size: number; mtimeMs: number }): void {
    const item = this.store.getById(id);
    if (!item || item.scope !== 'project' || !item.projectId || !['active', 'candidate'].includes(item.status)) return;
    this.db.query(`INSERT OR REPLACE INTO memory_file_refs
      (memory_id, path, kind, blob_hash, line_hash, memory_version, size, mtime_ms, checked_at)
      VALUES (?, ?, 'source', ?, ?, ?, ?, ?, ?)`)
      .run(id, source.path, this.hash(source.bytes), semanticHash(normalizeContent(item.content)), item.version, source.size, source.mtimeMs, new Date().toISOString());
  }

  refsFor(ids: readonly string[]): Map<string, MemoryFileRef[]> {
    const result = new Map<string, MemoryFileRef[]>();
    if (!ids.length) return result;
    const rows = this.db.query(`SELECT memory_id, path, kind, drift, mtime_ms FROM memory_file_refs
      WHERE memory_id IN (${ids.map(() => '?').join(',')}) ORDER BY path, kind`).all(...ids) as RefRow[];
    for (const row of rows) {
      const refs = result.get(row.memory_id) ?? [];
      refs.push({ path: row.path, kind: row.kind, drift: row.drift, ...(row.drift === 'changed' && row.mtime_ms != null ? { changedAt: new Date(row.mtime_ms).toISOString() } : {}) });
      result.set(row.memory_id, refs);
    }
    return result;
  }

  driftSignature(id: string): string {
    const rows = this.db.query(`SELECT kind, path, drift, drift_hash FROM memory_file_refs
      WHERE memory_id = ? AND drift IS NOT NULL`).all(id) as RefRow[];
    return rows.map(row => `${row.kind}:${row.path}:${row.drift}:${row.drift_hash ?? ''}`).sort().join('\n');
  }

  acknowledge(id: string, meta: ActorMeta): void {
    this.db.transaction(() => {
      const rows = this.db.query(`SELECT * FROM memory_file_refs WHERE memory_id = ? AND drift IS NOT NULL`).all(id) as RefRow[];
      for (const ref of rows) {
        if (ref.drift === 'missing' || ref.drift === 'line_removed') {
          this.db.query('DELETE FROM memory_file_refs WHERE memory_id = ? AND path = ? AND kind = ?').run(id, ref.path, ref.kind);
        } else {
          this.db.query(`UPDATE memory_file_refs SET blob_hash = ?, drift = NULL, drift_hash = NULL
            WHERE memory_id = ? AND path = ? AND kind = ?`).run(ref.drift_hash, id, ref.path, ref.kind);
        }
      }
      if (rows.length) this.store.recordFileCheck(id, [...new Set(rows.map(row => row.path))], meta);
    })();
  }
}
