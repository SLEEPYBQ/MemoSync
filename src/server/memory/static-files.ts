// Static-arm memory files (STUDY_PLAN §2.3, D6): in the "static" study
// condition the participant-maintained workspace markdown IS the memory —
// there is no items library in play. The controlled study starts with an empty
// scaffold and later projects receive an exact copy at the project boundary.
// Every turn reads the complete canonical Markdown representation; legacy
// non-study file injection retains its bounded reader. Edits take effect on
// the next turn; the coordinator rebuilds when the content hash moves.
//
// Deliberately NOT named CLAUDE.md: the Claude SDK auto-reads workspace
// CLAUDE.md through settingSources, which would bypass this controlled
// injection channel (see ConditionPolicy.studyMode).
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { MemoryItem, MemoryType } from './types';

export const STATIC_MEMORY_FILENAME = 'MEMORY.md';
export const STATIC_MEMORY_DIR = 'memory';
/** Hidden marker: the scaffold was generated once — a participant deleting MEMORY.md is intent, not a reason to regenerate. */
export const STATIC_MEMORY_SCAFFOLD_MARKER = '.memosync-scaffolded';
/** Legacy non-study injection guards; controlled-study Static never truncates or drops files. */
export const STATIC_MEMORY_MAX_FILE_CHARS = 24_000;
export const STATIC_MEMORY_MAX_FILES = 20;
/** Whole-turn study safety bounds: reject the representation; never truncate or omit a file. */
export const STUDY_STATIC_MEMORY_MAX_FILES = 128;
export const STUDY_STATIC_MEMORY_MAX_TOTAL_BYTES = 512 * 1024;

export interface StaticMemoryFile {
  /** Path relative to the workspace root, e.g. "MEMORY.md" or "memory/env.md". */
  relPath: string;
  /** Decoded text rendered into the Claude focus block; legacy mode may append a synthetic truncation marker. */
  content: string;
  /** Participant-controlled prefix when content also contains a synthetic marker. */
  participantContent?: string;
  truncated?: boolean;
}

export interface StaticFocusSourceSlice {
  /** Workspace-relative file whose participant-controlled text appears here. */
  readonly relPath: string;
  /** Exact file content substring included in the delivered text block. */
  readonly injectedContent: string;
  /** SHA-256 of injectedContent, for cache keys and provenance. */
  readonly contentHash: string;
  /** True when the delivered file section was capped before this payload was built. */
  readonly truncated: boolean;
  /** Half-open UTF-16 offsets into StaticFocusPayload.text. */
  readonly start: number;
  readonly end: number;
}

export interface StaticFocusPayload {
  /** Complete plain-text block delivered to Claude for this turn. */
  readonly text: string;
  /** Participant-controlled slices only; fixed wrapper text is deliberately absent. */
  readonly sources: readonly StaticFocusSourceSlice[];
}

function freezeStaticFocusPayload(text: string, sources: StaticFocusSourceSlice[]): StaticFocusPayload {
  const frozenSources = Object.freeze(sources.map((source) => Object.freeze(source)));
  return Object.freeze({ text, sources: frozenSources });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isMissingPath(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}

class StudyStaticMemoryReadError extends Error {}

const TYPE_SECTIONS: Array<[MemoryType, string]> = [
  ['preference', 'Preferences'],
  ['constraint', 'Constraints'],
  ['lesson', 'Lessons'],
  ['fact', 'Facts'],
];

/**
 * Create the MEMORY.md scaffold exactly ONCE per workspace. A hidden marker
 * records that generation happened: if the participant later deletes
 * MEMORY.md, that is intent ("forget everything") and must stick — the
 * scaffold header itself promises "delete anything". A pre-existing
 * MEMORY.md is adopted (marker written, file untouched). Seeds are rendered
 * as plain content bullets — ids are a system concept and would be noise in
 * a file the participant owns. Returns true only when the scaffold was
 * actually written. Never throws (a broken workspace degrades to no memory,
 * not a dead chat).
 */
export function ensureStaticMemoryScaffold(workspaceDir: string, seeds: MemoryItem[] = []): boolean {
  try {
    const markerPath = join(workspaceDir, STATIC_MEMORY_SCAFFOLD_MARKER);
    if (existsSync(markerPath)) return false;
    const path = join(workspaceDir, STATIC_MEMORY_FILENAME);
    mkdirSync(workspaceDir, { recursive: true });
    if (existsSync(path)) {
      writeFileSync(markerPath, `${new Date().toISOString()} adopted existing file\n`, 'utf-8');
      return false;
    }

    const lines: string[] = [
      '# Memory',
      '',
      '<!-- Notes the assistant reads at the start of every turn. Edit freely:',
      '     add, rewrite, or delete anything — changes apply from your next',
      '     message. You can also split notes into memory/*.md files. -->',
      '',
    ];
    for (const [type, section] of TYPE_SECTIONS) {
      lines.push(`## ${section}`);
      for (const item of seeds.filter((s) => s.type === type)) {
        lines.push(`- ${item.content}`);
      }
      lines.push('');
    }

    writeFileSync(path, lines.join('\n'), 'utf-8');
    writeFileSync(markerPath, `${new Date().toISOString()} scaffold generated\n`, 'utf-8');
    return true;
  } catch (error) {
    console.warn(`[memory] static scaffold failed in ${workspaceDir}:`, error);
    return false;
  }
}

/**
 * Read MEMORY.md plus memory/*.md (sorted by name), fresh from disk.
 * Fail-soft by design: an unreadable entry (permissions, a directory named
 * *.md, races) is skipped with a warning — a participant can break their
 * memory files, but never their chat. Oversized files are truncated and the
 * file count capped so the injection block stays bounded.
 */
export function readStaticMemoryFiles(workspaceDir: string): StaticMemoryFile[] {
  return readStaticMemoryFilesInternal(workspaceDir, false);
}

/**
 * Controlled-study reader: return the complete canonical Static
 * representation or throw before a Claude turn can start. Unlike the legacy
 * product reader, this path never caps file count, truncates content, or
 * silently drops an unreadable canonical Markdown file.
 */
export function readStudyStaticMemoryFiles(workspaceDir: string): StaticMemoryFile[] {
  return readStaticMemoryFilesInternal(workspaceDir, true);
}

function readStaticMemoryFilesInternal(workspaceDir: string, studyExact: boolean): StaticMemoryFile[] {
  const files: StaticMemoryFile[] = [];
  let studyTotalBytes = 0;
  const push = (relPath: string, absPath: string) => {
    if (!studyExact && files.length >= STATIC_MEMORY_MAX_FILES) return;
    try {
      if (studyExact) {
        if (files.length >= STUDY_STATIC_MEMORY_MAX_FILES) {
          throw new StudyStaticMemoryReadError(
            `Study Static memory representation exceeds the safety limit of ${STUDY_STATIC_MEMORY_MAX_FILES} files`,
          );
        }
        const info = lstatSync(absPath);
        if (info.isSymbolicLink()) {
          throw new StudyStaticMemoryReadError(`Study Static memory path is a symbolic link (${relPath})`);
        }
        if (!info.isFile()) {
          throw new StudyStaticMemoryReadError(`Study Static memory path is not a regular file (${relPath})`);
        }
      }
      let content: string;
      if (studyExact) {
        const bytes = readFileSync(absPath);
        if (studyTotalBytes + bytes.byteLength > STUDY_STATIC_MEMORY_MAX_TOTAL_BYTES) {
          throw new StudyStaticMemoryReadError(
            `Study Static memory representation exceeds the safety limit of ${STUDY_STATIC_MEMORY_MAX_TOTAL_BYTES} bytes`,
          );
        }
        try {
          content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        } catch {
          throw new StudyStaticMemoryReadError(`Study Static memory file has invalid UTF-8 (${relPath})`);
        }
        studyTotalBytes += bytes.byteLength;
      } else {
        content = readFileSync(absPath, 'utf-8');
      }
      let participantContent: string | undefined;
      let truncated = false;
      if (!studyExact && content.length > STATIC_MEMORY_MAX_FILE_CHARS) {
        participantContent = content.slice(0, STATIC_MEMORY_MAX_FILE_CHARS);
        content = `${participantContent}\n\n<!-- truncated: file exceeds the injection size limit -->`;
        truncated = true;
      }
      files.push({ relPath, content, ...(participantContent === undefined ? {} : { participantContent }), truncated });
    } catch (error) {
      if (studyExact) {
        if (error instanceof StudyStaticMemoryReadError) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        throw new StudyStaticMemoryReadError(`Study Static memory file is unreadable (${relPath}): ${detail}`);
      }
      console.warn(`[memory] skipping unreadable static memory file ${relPath}:`, error);
    }
  };

  const rootPath = join(workspaceDir, STATIC_MEMORY_FILENAME);
  if (studyExact) {
    try {
      lstatSync(rootPath);
      push(STATIC_MEMORY_FILENAME, rootPath);
    } catch (error) {
      if (!isMissingPath(error)) throw error;
    }
  } else if (existsSync(rootPath)) push(STATIC_MEMORY_FILENAME, rootPath);

  const dirPath = join(workspaceDir, STATIC_MEMORY_DIR);
  const readMemoryDirectory = () => {
    if (studyExact) {
      let directoryInfo;
      try {
        directoryInfo = lstatSync(dirPath);
      } catch (error) {
        if (isMissingPath(error)) return;
        throw error;
      }
      if (directoryInfo.isSymbolicLink()) {
        throw new StudyStaticMemoryReadError(`Study Static memory path is a symbolic link (${STATIC_MEMORY_DIR})`);
      }
      if (!directoryInfo.isDirectory()) {
        throw new StudyStaticMemoryReadError(`Study Static memory path is not a regular directory (${STATIC_MEMORY_DIR})`);
      }
    } else if (!existsSync(dirPath)) return;

    const names = readdirSync(dirPath)
      .filter((name) => name.endsWith('.md'))
      .sort();
    for (const name of names) push(`${STATIC_MEMORY_DIR}/${name}`, join(dirPath, name));
  };
  if (studyExact) {
    try {
      readMemoryDirectory();
    } catch (error) {
      if (error instanceof StudyStaticMemoryReadError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new StudyStaticMemoryReadError(`Study Static ${STATIC_MEMORY_DIR}/ directory is unreadable: ${detail}`);
    }
  } else {
    try {
      readMemoryDirectory();
    } catch (error) {
      console.warn(`[memory] skipping unreadable ${STATIC_MEMORY_DIR}/ directory:`, error);
    }
  }
  return files;
}

/** Stable fingerprint of the file set — drives session rebuild on edit. */
export function hashStaticMemoryFiles(files: StaticMemoryFile[]): string {
  // FNV-1a over path + content; cheap, deterministic, no crypto dependency.
  let hash = 0x811c9dc5;
  const feed = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      hash ^= s.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  };
  for (const f of files) {
    feed(f.relPath);
    feed('\0');
    feed(f.content);
    feed('\0');
  }
  return hash.toString(16);
}

/**
 * The static-arm injection block: file contents verbatim, plus guidance that
 * (a) these are the user's standing notes and (b) the model should remind the
 * user in conversation that the files are editable (D6's "提示可以维护/修改"
 * — surfaced through the model, since this arm has no memory UI).
 */
export function buildStaticFocusPayload(files: StaticMemoryFile[]): StaticFocusPayload {
  return buildStaticFocusPayloadInternal(files, false);
}

/** Preserve every decoded character in each study source slice and its hash. */
export function buildStudyStaticFocusPayload(files: StaticMemoryFile[]): StaticFocusPayload {
  return buildStaticFocusPayloadInternal(files, true);
}

function buildStaticFocusPayloadInternal(
  files: StaticMemoryFile[],
  studyExact: boolean,
): StaticFocusPayload {
  if (files.length === 0) return freezeStaticFocusPayload('', []);
  if (studyExact && files.some((file) => file.truncated || file.participantContent !== undefined)) {
    throw new Error('Study Static focus cannot be built from a truncated memory source');
  }
  const fileList = files.map((f) => f.relPath).join(', ');
  const parts: string[] = [
    '# Memory (workspace notes)',
    `You and the user SHARE standing notes — preferences, constraints, lessons, facts — in these workspace files: ${fileList}. ` +
      'They are read fresh at the start of every turn; treat them as instructions that apply across sessions.',
    // Baseline B2 (Claude Code-style): the agent maintains the file LIVE in
    // the main conversation, and narrates each write so the user can follow
    // along in the memory panel.
    '## Maintaining the notes\n' +
      'You maintain these files yourself, during the conversation, with your normal file tools (Edit/Write):\n' +
      '- When you learn something durable — a standing preference, a hard constraint, a lesson from a failure, ' +
      'a stable fact or pointer — update MEMORY.md RIGHT AWAY, in the same turn. Do not wait to be asked.\n' +
      '- Make 0 to 4 total memory entry changes per completed turn, counting additions and in-place revisions together. ' +
      'More is not better; change only what the turn supports. Revise an existing entry in place when its meaning changes, ' +
      'and leave an already-correct entry unchanged when the turn only reaffirms it.\n' +
      '- Keep every Markdown bullet or standalone entry to one atomic memory: one independently judgeable fact, preference, constraint, or lesson.\n' +
      '- Keep the file organized under short markdown headings (e.g. Preferences, Constraints, Project facts, Lessons); ' +
      'merge into existing sections rather than appending duplicates; rewrite entries that changed; delete ones the user retracts.\n' +
      '- After every memory edit, tell the user in ONE short line what you added or changed ' +
      '(e.g. "Noted in MEMORY.md: deploys go through staging."). The user sees the file live in their memory panel.\n' +
      '- If a note looks stale, wrong, or in conflict with the current request, say so — and fix the file once the user confirms.',
  ];
  let text = parts.join('\n');
  const sources: StaticFocusSourceSlice[] = [];
  for (const f of files) {
    text += `\n\n## ${f.relPath}\n`;
    const deliveredContent = studyExact ? f.content : f.content.trim();
    const injectedContent = studyExact ? f.content : (f.participantContent ?? f.content).trim();
    const start = text.length;
    text += deliveredContent;
    sources.push({
      relPath: f.relPath,
      injectedContent,
      contentHash: sha256(injectedContent),
      truncated: f.truncated === true,
      start,
      end: start + injectedContent.length,
    });
  }
  return freezeStaticFocusPayload(text, sources);
}

export function buildStaticMemoryBlock(files: StaticMemoryFile[]): string {
  return buildStaticFocusPayload(files).text;
}
