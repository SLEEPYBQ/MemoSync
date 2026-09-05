// Extract [M-NN] inline citations from a model's answer text. In MemoSync this
// was part of the streaming StreamParser; here a post-hoc scan of the completed
// assistant text is enough (citations remain plain-text signals on every
// engine). The caller records the cited ids and bumps each memory's usage_count.
const CITATION_RE = /\[(M-\d+)\]/g;

/** Unique memory ids cited in `text`, in first-seen order. */
export function extractCitations(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  for (const m of text.matchAll(CITATION_RE)) seen.add(m[1]);
  return [...seen];
}

/**
 * Record citations found in `text` that correspond to memories injected/available
 * this turn, bumping usage_count. `availableIds` guards against counting a
 * hallucinated or stale id. Returns the ids that were actually counted.
 */
export function recordCitations(
  text: string,
  availableIds: Set<string>,
  bumpUsage: (id: string) => void,
): string[] {
  const counted: string[] = [];
  for (const id of extractCitations(text)) {
    if (availableIds.has(id)) {
      bumpUsage(id);
      counted.push(id);
    }
  }
  return counted;
}
