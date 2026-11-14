import type { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { MemoryStore } from './MemoryStore';
import { looksLikeSecret } from './secrets';
import type { ActorMeta, MemoryItem } from './types';
import { semanticHash } from './view';

const TEAM_PATH = '.memosync/team.md';
const HEADER = '# Team memory\n<!-- memosync:team v1 — edit through pull requests; MemoSync loads this file read-only -->\n';
const RULE = /^- \[(T-[0-9a-f]{4})\]\s+(.+?)\s*$/;
const CONFLICT = /^(?:<<<<<<<|=======|>>>>>>>)/m;

export interface TeamRule {
  id: string;
  content: string;
  topic?: string;
  expiresAt?: string | null;
}

export interface TeamSyncResult {
  added: string[];
  changed: string[];
  removed: string[];
  conflict: boolean;
}

type TeamLink = { memory_id: string; project_id: string; team_id: string; content_hash: string; removed: number; local_off: number };
type PendingNotice = { added: string[]; changed: string[]; removed: string[]; revision: number };

function localEndOfDay(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const date = new Date(year, month - 1, day, 23, 59, 59, 999);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date.toISOString() : null;
}

function localDate(value: string): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function parseTeamFile(text: string): { rules: TeamRule[]; conflict: boolean } {
  if (CONFLICT.test(text)) return { rules: [], conflict: true };
  const rules: TeamRule[] = [];
  const seen = new Set<string>();
  let topic: string | undefined;
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      const heading = line.slice(3).trim();
      topic = heading && heading !== 'General' ? heading : undefined;
      continue;
    }
    const match = RULE.exec(line.trim());
    if (!match || seen.has(match[1]!)) continue;
    seen.add(match[1]!);
    const raw = match[2]!;
    const suffix = / \(until (\d{4}-\d{2}-\d{2})\)$/.exec(raw);
    const expiresAt = suffix ? localEndOfDay(suffix[1]!) : null;
    const content = suffix && expiresAt ? raw.slice(0, suffix.index).trim() : raw;
    if (content) rules.push({ id: match[1]!, content, ...(topic ? { topic } : {}), ...(expiresAt ? { expiresAt } : {}) });
  }
  return { rules, conflict: false };
}

export function serializeRule(rule: TeamRule): string {
  return `- [${rule.id}] ${rule.content.replace(/\s+/g, ' ').trim()}${rule.expiresAt ? ` (until ${localDate(rule.expiresAt)})` : ''}`;
}

const ruleHash = (rule: TeamRule) => semanticHash([rule.content, rule.topic ?? null, rule.expiresAt ?? null]);
const emptyResult = (): TeamSyncResult => ({ added: [], changed: [], removed: [], conflict: false });
const noticeKey = (projectId: string) => `team_pending_notice:${projectId}`;

export class TeamMemory {
  constructor(private db: Database, private store: MemoryStore, private syncProjection: (projectId: string) => void) {}

  status(_projectId: string, localPath?: string): { exists: boolean; conflict: boolean; path: string; canShare: boolean } {
    if (!localPath) return { exists: false, conflict: false, path: TEAM_PATH, canShare: false };
    try {
      if (!statSync(localPath).isDirectory()) return { exists: false, conflict: false, path: TEAM_PATH, canShare: false };
      try {
        const text = readFileSync(join(localPath, TEAM_PATH), 'utf8');
        return { exists: true, conflict: CONFLICT.test(text), path: TEAM_PATH, canShare: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, conflict: false, path: TEAM_PATH, canShare: true };
        return { exists: false, conflict: false, path: TEAM_PATH, canShare: false };
      }
    } catch {
      return { exists: false, conflict: false, path: TEAM_PATH, canShare: false };
    }
  }

  private read(localPath: string): string | null {
    try { return readFileSync(join(localPath, TEAM_PATH), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private write(localPath: string, text: string): void {
    const path = join(localPath, TEAM_PATH);
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(temp, text, 'utf8');
    renameSync(temp, path);
  }

  refsFor(ids: readonly string[]): Map<string, { id: string }> {
    if (!ids.length) return new Map();
    const rows = this.db.query(`SELECT memory_id, team_id FROM team_memory_links WHERE removed = 0
      AND memory_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Array<{ memory_id: string; team_id: string }>;
    return new Map(rows.map(row => [row.memory_id, { id: row.team_id }]));
  }

  decorate(item: MemoryItem): MemoryItem {
    const team = this.refsFor([item.id]).get(item.id);
    return team ? { ...item, team } : item;
  }

  syncProject(projectId: string, localPath: string): TeamSyncResult {
    const result = emptyResult();
    try {
      if (!statSync(localPath).isDirectory()) return result;
      const text = this.read(localPath);
      const parsed = parseTeamFile(text ?? '');
      if (parsed.conflict) return { ...result, conflict: true };
      const seen = new Set(parsed.rules.map(rule => rule.id));
      let projectionDirty = false;
      const now = new Date().toISOString();
      this.db.transaction(() => {
        for (const rule of parsed.rules) {
          if (looksLikeSecret(rule.content)) continue;
          const link = this.db.query('SELECT * FROM team_memory_links WHERE project_id = ? AND team_id = ?')
            .get(projectId, rule.id) as TeamLink | null;
          const hash = ruleHash(rule);
          if (!link) {
            const item = this.store.create({ content: rule.content, scope: 'project', projectId, status: 'active',
              type: 'constraint', topic: rule.topic, expiresAt: rule.expiresAt ?? null, evidenceClass: 'user_stated' },
            { actor: 'system', via: 'team' });
            this.db.query('INSERT INTO team_memory_links (memory_id, project_id, team_id, content_hash) VALUES (?, ?, ?, ?)')
              .run(item.id, projectId, rule.id, hash);
            this.store.expireIfDue(item.id, now);
            projectionDirty = true;
            result.added.push(item.id);
          } else {
            const item = this.store.getById(link.memory_id);
            if (!item) throw new Error('Linked team memory is missing');
            const changed = item.content !== rule.content
              || (item.topic ?? null) !== (rule.topic ?? null)
              || (item.expiresAt ?? null) !== (rule.expiresAt ?? null);
            const detailChanged = Boolean(item.detail);
            const expired = Boolean(rule.expiresAt && rule.expiresAt <= now);
            const patch: Partial<MemoryItem> = {};
            if (changed) Object.assign(patch, { content: rule.content, topic: rule.topic ?? null, expiresAt: rule.expiresAt ?? null });
            if (detailChanged) Object.assign(patch, { detail: null });
            if (link.local_off && item.status !== 'archived') patch.status = 'archived';
            else if (!link.local_off && !expired && item.status !== 'active') patch.status = 'active';
            if (Object.keys(patch).length) {
              this.store.update(link.memory_id, patch, { actor: 'system', via: 'team' });
              projectionDirty = true;
            }
            if (expired && !link.local_off && this.store.expireIfDue(link.memory_id, now)) projectionDirty = true;
            if (link.content_hash !== hash || link.removed) this.db.query('UPDATE team_memory_links SET content_hash = ?, removed = 0 WHERE memory_id = ?')
              .run(hash, link.memory_id);
            if (changed || detailChanged) result.changed.push(link.memory_id);
          }
        }
        const links = this.db.query('SELECT * FROM team_memory_links WHERE project_id = ? AND removed = 0').all(projectId) as TeamLink[];
        for (const link of links) {
          if (seen.has(link.team_id)) continue;
          this.store.archiveRemovedTeamRule(link.memory_id);
          this.db.query('UPDATE team_memory_links SET removed = 1 WHERE memory_id = ?').run(link.memory_id);
          projectionDirty = true;
          result.removed.push(link.memory_id);
        }
      })();
      if (projectionDirty) this.syncProjection(projectId);
      return result;
    } catch {
      console.warn('[memory] Could not sync team memory');
      return emptyResult();
    }
  }

  private linkFor(id: string): TeamLink | null {
    return this.db.query('SELECT * FROM team_memory_links WHERE memory_id = ? AND removed = 0').get(id) as TeamLink | null;
  }

  private writableText(localPath: string): string {
    const text = this.read(localPath) ?? HEADER;
    if (CONFLICT.test(text)) throw new Error('Team memory has unresolved merge conflicts');
    return text;
  }

  publish(memoryId: string, localPath: string, meta: ActorMeta): MemoryItem {
    const item = this.store.getById(memoryId);
    if (!item || item.scope !== 'project' || !item.projectId || item.status !== 'active' || item.sensitive
      || this.db.query('SELECT 1 FROM team_memory_links WHERE memory_id = ?').get(memoryId)) {
      throw new Error('Only an active, non-sensitive, unlinked project memory can be shared');
    }
    const text = this.writableText(localPath);
    const parsed = parseTeamFile(text);
    const ids = new Set(parsed.rules.map(rule => rule.id));
    const rule: TeamRule = { id: '', content: item.content.replace(/\s+/g, ' ').trim(), topic: item.topic === 'General' ? undefined : item.topic, expiresAt: item.expiresAt };
    if (!rule.content || looksLikeSecret(rule.content)) throw new Error('A sensitive or empty memory cannot be shared');
    if (ids.size >= 65536) throw new Error('Team file has no available rule ids');
    do { rule.id = `T-${randomBytes(2).toString('hex')}`; } while (ids.has(rule.id));
    const section = rule.topic ?? 'General';
    const lines = text.replace(/\s*$/, '').split('\n');
    const heading = lines.findIndex(line => line.trim() === `## ${section}`);
    if (heading < 0) lines.push('', `## ${section}`, serializeRule(rule));
    else {
      let end = heading + 1;
      while (end < lines.length && !lines[end]!.startsWith('## ')) end++;
      while (end > heading + 1 && !lines[end - 1]!.trim()) end--;
      lines.splice(end, 0, serializeRule(rule));
    }
    this.write(localPath, `${lines.join('\n')}\n`);
    const canonical = parseTeamFile(`## ${section}\n${serializeRule(rule)}\n`).rules[0]!;
    this.db.query('INSERT INTO team_memory_links (memory_id, project_id, team_id, content_hash) VALUES (?, ?, ?, ?)')
      .run(item.id, item.projectId, rule.id, ruleHash(canonical));
    if (item.content !== canonical.content || item.detail || (item.topic ?? null) !== (canonical.topic ?? null) || (item.expiresAt ?? null) !== (canonical.expiresAt ?? null)) {
      const patch: Partial<MemoryItem> = { content: canonical.content, expiresAt: canonical.expiresAt ?? null };
      Object.assign(patch, { detail: null, topic: canonical.topic ?? null });
      this.store.update(item.id, patch, { ...meta, via: 'team' });
    }
    this.syncProjection(item.projectId);
    return this.decorate(this.store.getById(item.id)!);
  }

  propose(memoryId: string, content: string, localPath: string, meta: ActorMeta): MemoryItem {
    const link = this.linkFor(memoryId);
    const item = this.store.getById(memoryId);
    if (!link || !item || item.status !== 'active') throw new Error('Team rule is not active');
    const normalized = content.replace(/\s+/g, ' ').trim();
    if (!normalized || looksLikeSecret(normalized)) throw new Error('A sensitive or empty team rule cannot be written');
    const text = this.writableText(localPath);
    const current = parseTeamFile(text).rules.find(rule => rule.id === link.team_id);
    if (!current) throw new Error('Team rule is missing from the file');
    let found = false;
    const lines = text.split('\n').map(line => {
      const match = RULE.exec(line.trim());
      if (!found && match?.[1] === link.team_id) {
        found = true;
        return serializeRule({ ...current, content: normalized });
      }
      return line;
    });
    if (!found) throw new Error('Team rule is missing from the file');
    this.write(localPath, lines.join('\n'));
    const sync = this.syncProject(link.project_id, localPath);
    this.queueNotice(link.project_id, { ...sync, changed: sync.changed.filter(id => id !== memoryId) });
    const updated = this.store.getById(memoryId)!;
    if (updated.content !== normalized) throw new Error('Team file was written, but the local memory could not be updated');
    return this.decorate(updated);
  }

  unshare(memoryId: string, localPath: string, meta: ActorMeta): MemoryItem {
    const link = this.linkFor(memoryId);
    const item = this.store.getById(memoryId);
    if (!link || !item) throw new Error('Memory is not a team rule');
    const text = this.writableText(localPath);
    const lines = text.split('\n').filter(line => RULE.exec(line.trim())?.[1] !== link.team_id);
    this.write(localPath, lines.join('\n'));
    this.db.query('DELETE FROM team_memory_links WHERE memory_id = ?').run(memoryId);
    if (item.status === 'archived') this.store.update(memoryId, { status: 'active' }, meta);
    this.syncProjection(link.project_id);
    return this.store.getById(memoryId)!;
  }

  queueNotice(projectId: string, result: TeamSyncResult): void {
    if (!result.added.length && !result.changed.length && !result.removed.length) return;
    const old = this.store.getKv<PendingNotice>(noticeKey(projectId));
    this.store.setKv(noticeKey(projectId), {
      added: [...new Set([...(old?.added ?? []), ...result.added])],
      changed: [...new Set([...(old?.changed ?? []), ...result.changed])],
      removed: [...new Set([...(old?.removed ?? []), ...result.removed])],
      revision: (old?.revision ?? 0) + 1,
    });
  }

  pendingNotice(projectId: string): PendingNotice | null {
    return this.store.getKv<PendingNotice>(noticeKey(projectId));
  }

  clearNotice(projectId: string, revision: number): void {
    const current = this.pendingNotice(projectId);
    if (current?.revision === revision) this.db.query('DELETE FROM memory_kv WHERE key = ?').run(noticeKey(projectId));
  }
}
