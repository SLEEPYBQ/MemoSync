// Sensitive-candidate anonymization (SPEC §4.2, DG1 "exclude or confirm" —
// the confirm branch): before accepting a capture candidate flagged
// sensitive, the user can ask for a redacted version. One DeepSeek pass
// proposes the same durable knowledge with secrets/credentials/personal data
// replaced by typed placeholders; the user reviews and edits before it is
// stored. Failures PROPAGATE — a failed redaction must never be mistaken for
// a clean one (the caller falls back to manual editing, not to raw text).
import type { LlmJsonCaller } from './deepseek';

export interface SanitizeInput {
  content: string;
  detail?: string;
}

export interface SanitizeProposal {
  content: string;
  detail?: string;
  redactions: Array<{ placeholder: string; kind: string }>;
}

export interface SanitizeService {
  propose(input: SanitizeInput): Promise<SanitizeProposal>;
}

const SANITIZE_SYSTEM = `A memory item extracted from a developer's coding session was flagged as \
containing sensitive information. Rewrite it so the durable knowledge is kept but every piece of \
sensitive data is REDACTED: secrets, API keys, tokens, passwords, credentials, e-mail addresses, phone \
numbers, personal names, account ids, internal hostnames/URLs, and file paths that embed a username. \
Replace each with a SHORT UPPERCASE placeholder in angle brackets naming its kind, e.g. <API_KEY>, \
<EMAIL>, <NAME>, <HOSTNAME>, <PATH>. Keep everything non-sensitive verbatim; do not summarize or \
embellish. If a detail text is provided, redact it the same way.

Respond with strict JSON only:
{"content": "<redacted one-liner>", "detail": "<redacted detail, only if a detail was provided>", \
"redactions": [{"placeholder": "<API_KEY>", "kind": "credential"}, ...]}.`;

export function createSanitizeService(opts: { callJson: LlmJsonCaller }): SanitizeService {
  return {
    async propose(input: SanitizeInput): Promise<SanitizeProposal> {
      const user =
        `Content:\n${input.content}` + (input.detail ? `\n\nDetail:\n${input.detail}` : '');
      const raw = await opts.callJson({ system: SANITIZE_SYSTEM, user });

      const content = typeof raw.content === 'string' ? raw.content.trim() : '';
      if (!content) throw new Error('sanitize: proposal missing content');
      // If a detail was submitted for redaction but the model returned none, the
      // ORIGINAL (still-sensitive) detail would otherwise silently stay in the
      // stored memory. Fail loudly instead — a missing redaction must never be
      // mistaken for a clean one (BUG MEMSRV-4; the caller falls back to manual
      // editing, not to raw text).
      let detail: string | undefined;
      if (input.detail) {
        if (typeof raw.detail !== 'string' || !raw.detail.trim()) {
          throw new Error('sanitize: proposal missing redacted detail');
        }
        detail = raw.detail.trim();
      }
      const redactions = Array.isArray(raw.redactions)
        ? (raw.redactions as unknown[])
            .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object')
            .map((r) => ({
              placeholder: typeof r.placeholder === 'string' ? r.placeholder : '',
              kind: typeof r.kind === 'string' ? r.kind : 'sensitive',
            }))
            .filter((r) => r.placeholder)
        : [];

      return { content, detail, redactions };
    },
  };
}
