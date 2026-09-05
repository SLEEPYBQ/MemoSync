// Lexical memory ranking — backs the Board's search box (HTTP
// /api/memories/search). Deliberately boring: keyword overlap with rare-term
// (IDF) weighting, boosted by citation outcomes (memories that actually get
// cited rank up). No embeddings infra — observable, debuggable, fast.
//
// This is a USER-facing search only. The agent has no search tool: the
// injected list is the complete memory surface for a turn.
import type { MemoryItem, ScoredMemory } from './types';

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of',
  'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been', 'this',
  'that', 'it', 'as', 'do', 'does', 'did', 'not', 'no', 'yes', 'you', 'i',
  'we', 'they', 'he', 'she', 'them', 'my', 'your', 'our', 'me', 'us', 'so',
  'if', 'then', 'than', 'when', 'what', 'how', 'why', 'can', 'could', 'should',
  'would', 'will', 'all', 'any', 'use', 'using', 'run', 'make', 'please',
]);

// CJK Unified Ideographs + Extension A. Chinese has no word boundaries to
// split on, so runs are indexed as overlapping bigrams (the standard
// segmentation-free approach); an isolated single char keeps itself.
const CJK_RUN = /[㐀-䶿一-鿿]+/g;

export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const latin = lower
    .split(/[^a-z0-9_./-]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  const cjk: string[] = [];
  for (const run of lower.match(CJK_RUN) ?? []) {
    if (run.length === 1) {
      cjk.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) cjk.push(run.slice(i, i + 2));
  }
  return [...latin, ...cjk];
}

/**
 * Rank `pool` against `query` text. Term weight is inverse document frequency
 * across the pool (a term every memory shares says nothing); the final score
 * folds in the citation outcome boost.
 */
export function rankMemories(query: string, pool: MemoryItem[]): ScoredMemory[] {
  const queryTerms = new Set(tokenize(query));
  if (queryTerms.size === 0 || pool.length === 0) return [];

  // Document frequency per term across the pool. The detailed form is indexed
  // too — a search should find a memory whose short form is generic but whose
  // detail mentions the queried term.
  const df = new Map<string, number>();
  const memTerms = pool.map((m) => {
    const terms = new Set(tokenize(`${m.content} ${m.topic ?? ''} ${m.detail ?? ''}`));
    for (const t of terms) df.set(t, (df.get(t) ?? 0) + 1);
    return terms;
  });

  const n = pool.length;
  const scored: ScoredMemory[] = [];
  for (let i = 0; i < pool.length; i++) {
    let text = 0;
    for (const t of memTerms[i]) {
      if (!queryTerms.has(t)) continue;
      text += Math.log(1 + n / (df.get(t) ?? 1));
    }
    if (text === 0) continue;
    // Outcome boost: cited memories earn rank; it saturates (log) so one
    // popular memory can't drown out a perfect keyword match.
    const boost = 1 + 0.25 * Math.log1p(pool[i].usageCount);
    scored.push({ memory: pool[i], score: text * boost });
  }
  return scored.sort((a, b) => b.score - a.score);
}
