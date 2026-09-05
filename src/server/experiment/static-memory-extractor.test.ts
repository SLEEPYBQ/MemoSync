import { describe, expect, test } from 'bun:test';
import { MEMORY_ATOM_SPEC, MEMORY_ATOM_SPEC_VERSION } from '../memory/atom-spec';
import { buildStaticFocusPayload } from '../memory/static-files';
import type { DeepSeekJsonRequest, LlmJsonCaller } from '../memory/deepseek';
import {
  STATIC_EXTRACTOR_VERSION,
  StaticExtractionError,
  createStaticMemoryExtractor,
  segmentStaticMemorySources,
} from './static-memory-extractor';

function scripted(
  responses: Array<Record<string, unknown>>,
  calls: DeepSeekJsonRequest[],
): LlmJsonCaller {
  return async (request) => {
    calls.push(request);
    const response = responses.shift();
    if (!response) throw new Error('unexpected extractor call');
    return response;
  };
}

describe('segmentStaticMemorySources', () => {
  test('uses participant Markdown only and keeps heading context with exact source offsets', () => {
    const payload = buildStaticFocusPayload([{
      relPath: 'MEMORY.md',
      content: [
        '# Project facts',
        '',
        '<!-- scaffold guidance, not memory -->',
        '- Deploy through staging first.',
        '  Keep the smoke test green.',
        '- Production runs on port 443.',
      ].join('\n'),
    }]);

    const segments = segmentStaticMemorySources(payload);

    expect(segments.map((segment) => ({ heading: segment.heading, text: segment.text }))).toEqual([
      {
        heading: 'Project facts',
        text: '- Deploy through staging first.\n  Keep the smoke test green.',
      },
      { heading: 'Project facts', text: '- Production runs on port 443.' },
    ]);
    for (const segment of segments) {
      expect(payload.text.slice(segment.payloadStart, segment.payloadEnd)).toBe(segment.text);
    }
    expect(segments.map((segment) => segment.text).join('\n')).not.toContain('scaffold guidance');
    expect(segments.map((segment) => segment.text).join('\n')).not.toContain('Maintaining the notes');
  });
});

describe('createStaticMemoryExtractor', () => {
  test('splits a compound bullet into atomic Project-scoped records with exact provenance', async () => {
    const calls: DeepSeekJsonRequest[] = [];
    const payload = buildStaticFocusPayload([{
      relPath: 'MEMORY.md',
      content: '## Preferences\n- Use pnpm, and run accessibility checks before every release.',
    }]);
    const extractor = createStaticMemoryExtractor({
      callJson: scripted([{
        atoms: [
          { content: 'Use pnpm for package management.' },
          { content: 'Run accessibility checks before every release.' },
        ],
      }], calls),
      modelId: 'deepseek-test',
    });

    const result = await extractor.extract(payload);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.system).toContain(MEMORY_ATOM_SPEC);
    expect(result.atomSpecVersion).toBe(MEMORY_ATOM_SPEC_VERSION);
    expect(result.extractorVersion).toBe(STATIC_EXTRACTOR_VERSION);
    expect(result.atoms.map((atom) => ({ content: atom.content, scope: atom.scope }))).toEqual([
      { content: 'Use pnpm for package management.', scope: 'project' },
      { content: 'Run accessibility checks before every release.', scope: 'project' },
    ]);
    expect(result.atoms[0]!.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.atoms[0]!.sourceRef).toMatchObject({
      kind: 'static_file',
      relPath: 'MEMORY.md',
      heading: 'Preferences',
      segmentOrdinal: 0,
      atomOrdinal: 0,
    });
    expect(payload.text.slice(
      result.atoms[0]!.sourceRef.payloadStart,
      result.atoms[0]!.sourceRef.payloadEnd,
    )).toBe('- Use pnpm, and run accessibility checks before every release.');
  });

  test('caches an unchanged segment by model, prompt, and atom-spec versions', async () => {
    const calls: DeepSeekJsonRequest[] = [];
    const payload = buildStaticFocusPayload([{
      relPath: 'MEMORY.md',
      content: '- Always run the unit tests.',
    }]);
    const extractor = createStaticMemoryExtractor({
      callJson: scripted([{ atoms: [{ content: 'Always run the unit tests.' }] }], calls),
      modelId: 'deepseek-test',
    });

    const first = await extractor.extract(payload);
    const second = await extractor.extract(payload);

    expect(second).toEqual(first);
    expect(calls).toHaveLength(1);
  });

  test('does not silently turn malformed extraction into an empty focus set', async () => {
    const payload = buildStaticFocusPayload([{
      relPath: 'MEMORY.md',
      content: '- Always run the unit tests.',
    }]);
    const extractor = createStaticMemoryExtractor({
      callJson: async () => ({ atoms: [{ content: '   ' }] }),
      modelId: 'deepseek-test',
    });

    await expect(extractor.extract(payload)).rejects.toBeInstanceOf(StaticExtractionError);
  });

  test('propagates truncation as a measurement quality flag', async () => {
    const payload = buildStaticFocusPayload([{
      relPath: 'MEMORY.md',
      content: '- Keep the first bounded note.\n\n<!-- truncated: file exceeds the injection size limit -->',
      participantContent: '- Keep the first bounded note.',
      truncated: true,
    }]);
    const extractor = createStaticMemoryExtractor({
      callJson: async () => ({ atoms: [{ content: 'Keep the first bounded note.' }] }),
      modelId: 'deepseek-test',
    });

    const result = await extractor.extract(payload);

    expect(result.qualityFlags).toContain('static_source_truncated:MEMORY.md');
    expect(result.atoms[0]!.qualityFlags).toContain('static_source_truncated');
  });
});
