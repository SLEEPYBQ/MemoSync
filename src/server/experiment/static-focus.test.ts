import { describe, expect, test } from 'bun:test';
import { buildStaticFocusPayload } from '../memory/static-files';
import { createStaticMemoryExtractor } from './static-memory-extractor';
import { StudyMemoryStore } from './study-memory-store';
import { materializeDeliveredStaticFocus } from './static-focus';
import type { ExperimentEvent } from './logger';

describe('materializeDeliveredStaticFocus', () => {
  test('records atoms from the exact queued text as one durable Static focus delivery', async () => {
    const studyStore = new StudyMemoryStore(':memory:');
    const events: ExperimentEvent[] = [];
    const payload = buildStaticFocusPayload([{
      relPath: 'MEMORY.md',
      content: '## Tooling\n- Use pnpm and run tests before release.',
    }]);
    const extractor = createStaticMemoryExtractor({
      callJson: async () => ({
        atoms: [
          { content: 'Use pnpm.' },
          { content: 'Run tests before release.' },
        ],
      }),
      modelId: 'deepseek-test',
    });

    const event = await materializeDeliveredStaticFocus({
      store: studyStore,
      extractor,
      logger: { event: (entry) => events.push(entry) },
      taskId: '038-S1',
      namespace: 'project-1',
      chatId: 'chat-1',
      turnId: 'turn-1',
      turn: 1,
      injectionId: 'static-inj-1',
      focusedAt: '2026-08-15T10:00:00.000Z',
      promptText: `user prompt\n${payload.text}`,
      payload,
    });

    expect(events).toEqual([event]);
    expect(event).toMatchObject({
      type: 'memory.inject',
      schemaVersion: 2,
      semantics: 'turn_focus',
      injectionId: 'static-inj-1',
      taskId: '038-S1',
      mode: 'file',
      deliveryStage: 'queued_to_claude',
      outcome: 'delivered',
      memories: [
        expect.objectContaining({
          identity: { scheme: 'static', id: expect.any(String) },
          version: 1,
          content: 'Use pnpm.',
          scope: 'project',
          actualFocus: true,
          sourceRef: expect.objectContaining({ namespace: 'project-1' }),
        }),
        expect.objectContaining({ content: 'Run tests before release.' }),
      ],
    });
    expect(event.focusPayloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(studyStore.listTaskDeliveries('038-S1')).toEqual([
      expect.objectContaining({
        condition: 'static',
        mode: 'file',
        injectionId: 'static-inj-1',
        items: [
          expect.objectContaining({ content: 'Use pnpm.' }),
          expect.objectContaining({ content: 'Run tests before release.' }),
        ],
      }),
    ]);
    studyStore.close();
  });

  test('records a legitimate empty delivery when dispatched Markdown has no memory atoms', async () => {
    const studyStore = new StudyMemoryStore(':memory:');
    const payload = buildStaticFocusPayload([{ relPath: 'MEMORY.md', content: '# Empty\n<!-- no notes -->' }]);
    const event = await materializeDeliveredStaticFocus({
      store: studyStore,
      extractor: createStaticMemoryExtractor({ callJson: async () => ({ atoms: [] }), modelId: 'test' }),
      logger: { event: () => {} },
      taskId: '038-S1',
      namespace: 'project-1',
      chatId: 'chat-1',
      turnId: 'turn-1',
      turn: 1,
      promptText: payload.text,
      payload,
    });

    expect(event.outcome).toBe('empty');
    expect(studyStore.listTaskDeliveries('038-S1')[0]!.items).toEqual([]);
    studyStore.close();
  });
});
