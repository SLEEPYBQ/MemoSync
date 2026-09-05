// The memory system-prompt fragments. ADDITIVE: Kanna already supplies the
// agent persona + native tools, so this only layers on the memory context, the
// [M-NN] citation rule, and the tool-usage guidance.
//
// Injection model (REDESIGN 2026-08-04, D1/D2): the boot block (rules +
// snapshot) is appended ONCE to Claude's preset system prompt and the session
// is never rebuilt for memory changes — instead every later change rides the
// next user turn as a delta block (`buildMemoryDeltaBlock`) inside a
// <system-reminder>. Items carry versions ("[M-07 v3]"); the stated resolution
// rule is "same id → highest version wins", which is what lets stale snapshot
// lines coexist with fresh delta lines in one context window. Codex still
// receives the full block per turn via developer_instructions.
import type { MemoryItem } from './types';

/** One index line: `[M-07 v3] (scope · type) content [+detail]`. */
export function formatMemoryLine(m: MemoryItem): string {
  return `[${m.id} v${m.version}] (${m.scope} · ${m.type}) ${m.content}${m.detail ? ' [+detail]' : ''}`;
}

/**
 * Format the injected memory list — SHORT forms only ("memory as skills"):
 * one cheap line per item; `[+detail]` marks items whose detailed form can be
 * pulled with load_memory_detail.
 */
export function formatMemoryList(memories: MemoryItem[]): string {
  if (memories.length === 0) return '(none)';
  return memories.map(formatMemoryLine).join('\n');
}

/**
 * Auto-arm injection (STUDY_PLAN §2.2): a content-only markdown list, written
 * to be indistinguishable from an auto-generated CLAUDE.md-style notes file.
 * Deliberately NO ids, NO scope/type labels, NO detail markers, NO citation or
 * tool guidance — the study's auto arm models today's real-world baseline,
 * where memory is a flat file the agent reads but the user never reviews.
 */
export function buildPlainMemoryBlock(memories: MemoryItem[]): string {
  if (memories.length === 0) return '';
  return [
    '# Notes from previous sessions',
    '',
    ...memories.map((m) => `- ${m.content}`),
  ].join('\n');
}

/** An unresolved conflicts_with pair among injected actives (both sides shown). */
export interface MemoryConflictPair {
  id: string;
  otherId: string;
}

export interface MemoryBlockOptions {
  /** Active memories for the session (the boot snapshot). */
  memories: MemoryItem[];
  /** Whether the load_memory_detail tool is registered (default true). */
  tools?: boolean;
  /** Unresolved conflicts among the snapshot items (deduped pairs). */
  conflicts?: MemoryConflictPair[];
}

/**
 * Build the appendable BOOT block: stable rules + the session-start snapshot.
 * The injected index is the COMPLETE memory surface for the session — there is
 * deliberately no search tool reaching past it, so what the user sees in the
 * injection receipt is exactly what the model can use. Returns '' only in the
 * degenerate case of no memories AND no tools.
 */
export function buildMemoryBlock(opts: MemoryBlockOptions): string {
  const tools = opts.tools ?? true;
  const memories = opts.memories ?? [];
  if (memories.length === 0 && !tools) return '';

  const parts: string[] = [];
  parts.push('# Memory (MemoSync)');
  parts.push(
    'You have a persistent, user-controlled memory that spans sessions. ' +
      'The snapshot below lists every memory active at session start, as one-line SHORT forms. ' +
      'Later changes arrive as "Memory changes" notes attached to user messages; those notes are ' +
      'authoritative — they supersede this snapshot and any earlier notes. When the same id appears ' +
      'more than once in the conversation, trust the HIGHEST version (e.g. [M-07 v3] overrides [M-07 v2]).',
  );

  parts.push(
    '\n## Citing memory\nEach memory has an id like [M-07]. Whenever a memory shapes what you do or say — a rule you follow, a preference you honor, a fact you rely on — cite it inline at the point of influence as [M-07]. Do not leave an influence uncited: an uncited memory is invisible to the user.',
  );

  if (tools) {
    parts.push(
      '\n## Loading details\n' +
        'Lines marked `[+detail]` are HEADLINES — a longer, more specific form exists. Before you act on ' +
        'anything such a memory governs (write code it constrains, follow a workflow it describes, answer ' +
        'a question it covers), call `load_memory_detail({ ids: ["M-07"] })` first: the one-line form is ' +
        'not the full rule. Skipping the detail and guessing is the failure mode to avoid; loading none is ' +
        'right only when no [+detail] memory touches the task.',
    );
  }

  parts.push(
    `\n## Memory snapshot (session start)\n${memories.length} ${memories.length === 1 ? 'memory is' : 'memories are'} active:\n${formatMemoryList(memories)}`,
  );

  if (opts.conflicts?.length) {
    parts.push(
      '\n⚠ Unresolved conflicts: ' +
        opts.conflicts.map((c) => `[${c.id}] conflicts with [${c.otherId}]`).join('; ') +
        ' — if both sides apply to the task, ask the user rather than silently picking one.',
    );
  }

  return parts.join('\n');
}

/** One line of a per-turn memory delta. */
export interface MemoryDeltaEntry {
  kind: 'added' | 'edited' | 'removed';
  id: string;
  /** Current version (added/edited). */
  version?: number;
  /** Previous version (edited). */
  fromVersion?: number;
  /** Formatted content line (added/edited): `(scope · type) content [+detail]`. */
  line?: string;
  /** Ids this item now conflicts with (unresolved). */
  conflictsWith?: string[];
}

export interface MemoryDeltaBlockOptions {
  entries: MemoryDeltaEntry[];
  /** Ids injected but excluded for THIS turn only (preview-gate edit). */
  ignoreForTurn?: string[];
}

/**
 * Render the per-turn delta block (WITHOUT the <system-reminder> wrapper —
 * the caller owns the envelope). Returns '' when there is nothing to say, so
 * quiet turns add zero tokens and leave the prompt cache untouched.
 */
export function buildMemoryDeltaBlock(opts: MemoryDeltaBlockOptions): string {
  const { entries, ignoreForTurn } = opts;
  const hasIgnores = Boolean(ignoreForTurn?.length);
  if (entries.length === 0 && !hasIgnores) return '';

  const parts: string[] = [];
  if (entries.length > 0) {
    parts.push(
      'Memory changes since last turn (authoritative — these supersede the session-start snapshot and any earlier change notes; same id → highest version wins):',
    );
    for (const e of entries) {
      const conflictSuffix = e.conflictsWith?.length
        ? ` — ⚠ conflicts with ${e.conflictsWith.map((id) => `[${id}]`).join(', ')} (unresolved; if both apply, ask the user)`
        : '';
      if (e.kind === 'removed') {
        // Covers archive AND session exclusion — either way it left the set.
        parts.push(`- [${e.id}] (no longer in the active set)`);
      } else if (e.kind === 'added') {
        parts.push(`- [${e.id} v${e.version ?? 1}] (added) ${e.line ?? ''}${conflictSuffix}`);
      } else {
        parts.push(
          `- [${e.id} v${e.version ?? 1}] (edited, v${e.fromVersion ?? 1}→v${e.version ?? 1}) ${e.line ?? ''}${conflictSuffix}`,
        );
      }
    }
  }
  if (hasIgnores) {
    parts.push(`For this turn only, ignore: ${ignoreForTurn!.map((id) => `[${id}]`).join(', ')}.`);
  }
  return parts.join('\n');
}
