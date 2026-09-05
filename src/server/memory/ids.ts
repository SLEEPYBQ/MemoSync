// Memory-id helpers. IDs look like "M-07"; they must sort numerically by the
// numeric suffix (so M-99 precedes M-100), not lexicographically.
// Ported verbatim from MemoSync (apps/backend/src/services/memory/ids.ts).

/** Numeric suffix of a memory id, or +Infinity for a non-conforming id. */
export function memoryIdNum(id: string): number {
  const m = /^M-(\d+)$/.exec(id);
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

/** Compare two memory ids numerically by suffix, falling back to text. */
export function compareMemoryId(a: string, b: string): number {
  const na = memoryIdNum(a);
  const nb = memoryIdNum(b);
  return na !== nb ? na - nb : a.localeCompare(b);
}
