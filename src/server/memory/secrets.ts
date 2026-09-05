// Deterministic secret heuristic for text that enters the store WITHOUT the
// LLM capture pass (md-import bullets, hand-added projection lines). It cannot
// classify intent the way the capture privacy gate does — it only has to catch
// credential-shaped strings so they enter the review lane as SENSITIVE:
// excluded from the Markdown projection, hard-erased on dismissal. False
// positives cost one extra confirmation; false negatives leak plaintext.

const SECRET_PATTERNS: RegExp[] = [
  // Common provider key prefixes (OpenAI/Anthropic/Stripe, AWS, GitHub
  // classic + fine-grained, GitLab, npm, Slack, Google).
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\bnpm_[A-Za-z0-9]{30,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  // JWTs and PEM blocks.
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // "password = hunter2"-shaped assignments.
  /\b(?:api[_-]?key|access[_-]?key|secret|token|password|passwd|credential)s?\b\s*[:=]\s*\S+/i,
];

/** True when a line of imported text looks like it carries a credential. */
export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}
