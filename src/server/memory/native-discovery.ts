import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { NativeMemoryEngine, NativeMemoryRoot, NativeMemorySource, NativeSourceKind } from '../../shared/native-memory';
import { looksLikeSecret } from './secrets';

export const NATIVE_DISCOVERY_LIMITS = { roots: 16, files: 128, fileBytes: 64 * 1024, totalBytes: 1024 * 1024, directoryEntries: 256, items: 128 } as const;
export const nativeHash = (text: string | Uint8Array): string => createHash('sha256').update(text).digest('hex');

export class NativeMemoryError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

/** Screen the whole bounded file before retaining quotes or calling a model.
 * Conservative: even a single suspect value quarantines the entire source.
 */
export function nativeTextSensitive(text: string): boolean {
  return looksLikeSecret(text)
    || /\b(?:authorization\s*:\s*(?:bearer|basic)|bearer\s+[A-Za-z0-9._~+/-]{8,})/i.test(text)
    || /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)
    || /\b\d{3}-\d{2}-\d{4}\b/.test(text)
    || /(?:\+\d[\d ()-]{8,}\d)/.test(text)
    || /\b(?:\d[ -]?){13,19}\b/.test(text)
    || text.includes('\0');
}

interface Candidate {
  path: string;
  boundary: string;
  root: NativeMemoryRoot;
  engine: NativeMemoryEngine;
  kind: NativeSourceKind;
}

/** Only these explicit paths are probed. There is no recursive directory walk,
 * arbitrary-path import, config parsing, or engine invocation.
 * Claude: <HOME>/.claude/projects/<encoded-selected-project>/memory/*.md.
 * Codex: <HOME>/.codex/memories/{MEMORY,memory_summary,raw_memories}.md.
 * Pi/OpenCode have no assumed automatic memory location. Their documented
 * AGENTS.md and one-level SKILL.md locations are independent assets only.
 * Alternate engine homes are deliberately unsupported, rather than reading
 * user configuration to discover them.
 */
export class NativeMemoryDiscovery {
  constructor(readonly homeDir: string, readonly roots: () => NativeMemoryRoot[]) {
    if (!isAbsolute(homeDir)) throw new Error('An absolute home directory is required');
  }

  allowedRoots(): NativeMemoryRoot[] {
    return this.roots().map(root => ({ ...root, locations: root.owner.scope === 'project'
      ? [resolve(root.path), join(this.homeDir, '.claude', 'projects', resolve(root.path).replace(/[^a-zA-Z0-9]/g, '-'), 'memory')]
      : [join(this.homeDir, '.codex', 'memories'), join(this.homeDir, '.claude', 'CLAUDE.md'),
        join(this.homeDir, '.codex', 'AGENTS.md'), join(this.homeDir, '.pi', 'agent', 'AGENTS.md'),
        join(this.homeDir, '.config', 'opencode', 'AGENTS.md'), join(this.homeDir, '.claude', 'skills'),
        join(this.homeDir, '.codex', 'skills'), join(this.homeDir, '.pi', 'agent', 'skills'), join(this.homeDir, '.config', 'opencode', 'skills')],
    }));
  }

  private checkRoot(root: NativeMemoryRoot): string {
    if (!isAbsolute(root.path)) throw new NativeMemoryError(400, 'INVALID_ROOT', 'Root must be absolute');
    const canonical = realpathSync(root.path);
    if (!lstatSync(canonical).isDirectory()) throw new NativeMemoryError(400, 'INVALID_ROOT', 'Root must be a directory');
    return canonical;
  }

  private assertPlainPath(path: string, boundary: string): void {
    const rel = relative(boundary, path);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Outside boundary');
    // Refuse symlinks in every component, including the configured boundary.
    // Also rejects retargeted roots between discovery and commit.
    const absolute = resolve(path);
    let current: string = sep;
    for (const component of absolute.split(sep).filter(Boolean)) {
      current = join(current, component);
      if (lstatSync(current).isSymbolicLink()) throw new Error('Symlink source');
    }
    if (realpathSync(path) !== absolute || realpathSync(boundary) !== resolve(boundary)) throw new Error('Retargeted source');
  }

  private readCandidate(candidate: Candidate): { text: string; bytes: number } {
    this.assertPlainPath(candidate.path, candidate.boundary);
    const fd = openSync(candidate.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1 || before.size > NATIVE_DISCOVERY_LIMITS.fileBytes) throw new Error('Unsupported source');
      const buffer = Buffer.alloc(NATIVE_DISCOVERY_LIMITS.fileBytes + 1);
      const bytes = readSync(fd, buffer, 0, buffer.length, 0);
      const after = fstatSync(fd);
      this.assertPlainPath(candidate.path, candidate.boundary);
      const current = lstatSync(candidate.path);
      if (bytes > NATIVE_DISCOVERY_LIMITS.fileBytes || bytes !== before.size || before.ino !== current.ino
        || before.dev !== current.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs
        || before.ctimeMs !== after.ctimeMs) throw new Error('Source changed during read');
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, bytes));
      return { text, bytes };
    } finally { closeSync(fd); }
  }

  private candidates(root: NativeMemoryRoot, stats: { truncated: boolean }): Candidate[] {
    const base = this.checkRoot(root);
    const result: Candidate[] = [];
    const file = (path: string, engine: NativeMemoryEngine, kind: NativeSourceKind, boundary = base) => result.push({ path, engine, kind, root, boundary });
    const direct = (dir: string, engine: NativeMemoryEngine, kind: NativeSourceKind, boundary = base, skills = false) => {
      let handle;
      try {
        this.assertPlainPath(dir, boundary);
        handle = opendirSync(dir);
        for (let i = 0; i <= NATIVE_DISCOVERY_LIMITS.directoryEntries; i++) {
          const entry = handle.readSync();
          if (!entry) break;
          if (i === NATIVE_DISCOVERY_LIMITS.directoryEntries) { stats.truncated = true; break; }
          if (skills ? entry.isDirectory() : entry.isFile() && entry.name.endsWith('.md')) {
            file(skills ? join(dir, entry.name, 'SKILL.md') : join(dir, entry.name), engine, kind, boundary);
          }
        }
      } catch { /* Missing/linked locations are not discovery targets. */ }
      finally { handle?.closeSync(); }
    };
    if (root.owner.scope === 'personal') {
      // This root must be the server-selected HOME, never an arbitrary file's parent.
      if (base !== realpathSync(this.homeDir)) throw new NativeMemoryError(400, 'INVALID_ROOT', 'Personal root must be HOME');
      for (const name of ['MEMORY.md', 'memory_summary.md', 'raw_memories.md']) file(join(base, '.codex', 'memories', name), 'codex', 'native-memory');
      file(join(base, '.claude', 'CLAUDE.md'), 'claude', 'project-rule');
      file(join(base, '.codex', 'AGENTS.md'), 'codex', 'project-rule');
      file(join(base, '.pi', 'agent', 'AGENTS.md'), 'pi', 'project-rule');
      file(join(base, '.config', 'opencode', 'AGENTS.md'), 'opencode', 'project-rule');
      direct(join(base, '.claude', 'skills'), 'claude', 'skill', base, true);
      direct(join(base, '.codex', 'skills'), 'codex', 'skill', base, true);
      direct(join(base, '.pi', 'agent', 'skills'), 'pi', 'skill', base, true);
      direct(join(base, '.config', 'opencode', 'skills'), 'opencode', 'skill', base, true);
    } else {
      file(join(base, 'CLAUDE.md'), 'claude', 'project-rule');
      file(join(base, '.claude', 'CLAUDE.md'), 'claude', 'project-rule');
      file(join(base, 'AGENTS.md'), 'codex', 'project-rule');
      direct(join(base, '.claude', 'rules'), 'claude', 'project-rule');
      direct(join(base, '.claude', 'skills'), 'claude', 'skill', base, true);
      direct(join(base, '.agents', 'skills'), 'codex', 'skill', base, true);
      direct(join(base, '.pi', 'skills'), 'pi', 'skill', base, true);
      direct(join(base, '.opencode', 'skills'), 'opencode', 'skill', base, true);
      // Only this selected project's encoded directory. Never enumerate ~/.claude/projects.
      const home = realpathSync(this.homeDir);
      const encoded = base.replace(/[^a-zA-Z0-9]/g, '-');
      const nativeRoot = join(home, '.claude', 'projects', encoded, 'memory');
      direct(nativeRoot, 'claude', 'native-memory', nativeRoot);
    }
    return result;
  }

  discover(rootIds: string[]): { sources: Array<Omit<NativeMemorySource, 'sourceVersion'>>; truncated: boolean; skipped: number } {
    if (!Array.isArray(rootIds) || !rootIds.length || rootIds.length > NATIVE_DISCOVERY_LIMITS.roots
      || rootIds.some(id => typeof id !== 'string') || new Set(rootIds).size !== rootIds.length) {
      throw new NativeMemoryError(400, 'BAD_REQUEST', 'Select between 1 and 16 distinct allowed root IDs');
    }
    const available = this.allowedRoots();
    const roots = rootIds.map(id => {
      const root = available.find(r => r.id === id);
      if (!root) throw new NativeMemoryError(400, 'INVALID_ROOT', 'Unknown allowed root ID');
      return root;
    });
    const stats = { truncated: false, skipped: 0 };
    let bytes = 0;
    const sources: Array<Omit<NativeMemorySource, 'sourceVersion'>> = [];
    for (const root of roots) {
      let candidates: Candidate[];
      try { candidates = this.candidates(root, stats); }
      catch (error) { if (error instanceof NativeMemoryError) throw error; stats.skipped++; continue; }
      for (const candidate of candidates) {
        if (sources.length === NATIVE_DISCOVERY_LIMITS.files || bytes + NATIVE_DISCOVERY_LIMITS.fileBytes > NATIVE_DISCOVERY_LIMITS.totalBytes) { stats.truncated = true; break; }
        try {
          const read = this.readCandidate(candidate);
          bytes += read.bytes;
          const screening = nativeTextSensitive(read.text) ? 'blocked-sensitive' : 'clear';
          sources.push({
            sourceId: nativeHash(JSON.stringify([root.id, root.owner, candidate.engine, candidate.kind, candidate.path])),
            rootId: root.id, engine: candidate.engine, kind: candidate.kind, locator: candidate.path,
            sourceHash: nativeHash(read.text), bytes: read.bytes, owner: root.owner,
            trust: candidate.kind === 'native-memory' ? 'agent-generated' : 'imported-unknown',
            screening, importable: candidate.kind === 'native-memory' && screening === 'clear',
          });
        } catch { stats.skipped++; }
      }
    }
    return { sources, ...stats };
  }

  /** Re-derive the allowlist, rather than trusting a persisted locator. */
  readSource(source: NativeMemorySource): string {
    const root = this.allowedRoots().find(root => root.id === source.rootId && JSON.stringify(root.owner) === JSON.stringify(source.owner));
    if (!root) throw new NativeMemoryError(409, 'SOURCE_UNAVAILABLE', 'Source root is no longer allowed');
    let candidate: Candidate | undefined;
    try { candidate = this.candidates(root, { truncated: false }).find(c => c.path === source.locator && c.engine === source.engine && c.kind === source.kind); }
    catch { /* Return a bounded, content-free error. */ }
    if (!candidate) throw new NativeMemoryError(409, 'SOURCE_UNAVAILABLE', 'Source is no longer in the explicit allowlist');
    try { return this.readCandidate(candidate).text; }
    catch { throw new NativeMemoryError(409, 'SOURCE_UNAVAILABLE', 'Source is missing, linked, too large, or changed while reading'); }
  }
}
