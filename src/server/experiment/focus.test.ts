import { describe, expect, test } from 'bun:test';
import { StudyMemoryStore } from './study-memory-store';
import { recordDeliveredStoreFocus } from './focus';
import type { ExperimentEvent } from './logger';
import type { MemoryItem } from '../memory/types';

function item(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: 'M-01',
    content: 'Use pnpm for package management.',
    scope: 'project',
    type: 'preference',
    status: 'active',
    projectId: 'project-1',
    abstractionLevel: 'contextual',
    sensitive: false,
    version: 2,
    usageCount: 0,
    reinforcedCount: 0,
    citedInCurrentSession: 0,
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
    ...overrides,
  } as MemoryItem;
}

describe('recordDeliveredStoreFocus', () => {
  test('durably writes the same delivered store focus that it emits to telemetry', () => {
    const studyStore = new StudyMemoryStore(':memory:');
    const events: ExperimentEvent[] = [];

    const event = recordDeliveredStoreFocus({
      logger: { event: (entry) => events.push(entry) },
      studyStore,
      condition: 'memosync',
      taskId: '038-S1',
      chatId: 'chat-1',
      turnId: 'turn-1',
      turn: 1,
      mode: 'skills',
      resumeOfInterruptId: 'interrupt-1',
      promptText: 'prompt sent to Claude',
      visiblePool: [item(), item({ id: 'M-02', content: 'Visible but not selected.' })],
      focusedMemories: [item()],
      injectionId: 'inj-1',
      focusedAt: '2026-08-15T10:00:00.000Z',
    });

    expect(events).toEqual([event]);
    expect(event.deliveryStage).toBe('queued_to_claude');
    expect(studyStore.listTaskDeliveries('038-S1')).toEqual([
      expect.objectContaining({
        injectionId: 'inj-1',
        condition: 'memosync',
        engine: 'claude',
        deliveryStage: 'queued_to_claude',
        resumeOfInterruptId: 'interrupt-1',
        items: [expect.objectContaining({
          identity: { scheme: 'store', id: 'M-01' },
          version: 2,
          content: 'Use pnpm for package management.',
          scope: 'project',
        })],
      }),
    ]);
    expect(studyStore.createFreezeSnapshot({
      snapshotId: 'freeze-1',
      taskId: '038-S1',
      frozenAt: '2026-08-15T10:05:00.000Z',
    })).toMatchObject({
      items: [{
        history: [{
          injectionId: 'inj-1',
          resumeOfInterruptId: 'interrupt-1',
        }],
      }],
    });
    studyStore.close();
  });

  test('does not write non-study deliveries without a task id', () => {
    const studyStore = new StudyMemoryStore(':memory:');
    recordDeliveredStoreFocus({
      logger: { event: () => {} },
      studyStore,
      condition: 'auto',
      taskId: null,
      chatId: 'chat-1',
      turnId: 'turn-1',
      turn: 1,
      mode: 'plain',
      promptText: 'prompt',
      visiblePool: [item()],
      focusedMemories: [item()],
    });

    expect(studyStore.listTaskDeliveries('038-S1')).toEqual([]);
    studyStore.close();
  });
});
