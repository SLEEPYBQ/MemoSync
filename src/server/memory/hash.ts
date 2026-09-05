// Memory-set hash: sha1(sorted [id, content] pairs).slice(0, 8).
// Ported from MemoSync (apps/backend/src/services/memory/hash.ts).
import { createHash } from 'node:crypto';
import type { MemoryItem } from './types';

type HashableMemory = Pick<MemoryItem, 'id' | 'content'>;

/**
 * Deterministic 8-char hash of a memory set. Order-independent (sorts by id),
 * and changes whenever any memory is added, edited, or removed.
 */
export function computeMemoryHash(items: HashableMemory[]): string {
  const sorted = [...items].sort((a, b) => a.id.localeCompare(b.id));
  // JSON-encode each [id, content] pair so field/row boundaries are
  // unambiguous (a ':' or newline inside content cannot cause a collision).
  const payload = sorted.map((m) => JSON.stringify([m.id, m.content])).join('\n');
  return createHash('sha1').update(payload).digest('hex').slice(0, 8);
}
