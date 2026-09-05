import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyQuestionnaireService } from '../study-questionnaire-service';
import { StudyRegistry } from '../study-registry';
import { createAutoProjectCopyService } from '../memory/auto-project-copy';
import { MemoryService } from '../memory';
import { recordDeliveredStoreFocus } from './focus';
import { StudyMemoryStore } from './study-memory-store';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Auto Project Copy measurement lineage', () => {
  test('starts target focus history at its first turn and preserves cloneOf in the frozen cue and O_i', async () => {
    const root = mkdtempSync(join(tmpdir(), 'auto-copy-measurement-'));
    roots.push(root);
    const memory = new MemoryService({
      dbPath: join(root, 'memory.sqlite'),
      dataDir: join(root, 'projection'),
    });
    const studyStore = new StudyMemoryStore(':memory:');
    const source = memory.store.create(
      {
        content: 'Apartment cancellations require confirmation',
        scope: 'project',
        projectId: 'project-apartment',
        type: 'constraint',
      },
      { actor: 'agent' },
    );
    const transitionKey = 'snapshot-038:038-S2->098-S1';
    const receipt = createAutoProjectCopyService({ memory }).copyOnce({
      transitionKey,
      sourceTaskId: '038-S2',
      targetTaskId: '098-S1',
      sourceProjectId: 'project-apartment',
      targetProjectId: 'project-car',
    });
    const target = memory.autoProjectMemories('project-car')[0]!;
    const expectedProvenance = {
      transitionKey,
      sourceTaskId: '038-S2',
      sourceProjectId: 'project-apartment',
      cloneOf: {
        memoryId: source.id,
        version: source.version,
        contentHash: receipt.clones[0]!.cloneOf.contentHash,
      },
    };
    expect(memory.getAutoProjectCloneRef(source.id)).toBeNull();
    expect(studyStore.listTaskDeliveries('098-S1')).toEqual([]);

    const delivery = recordDeliveredStoreFocus({
      logger: { event: () => {} },
      studyStore,
      condition: 'auto',
      taskId: '098-S1',
      chatId: 'car-chat-1',
      turnId: 'car-turn-1',
      turn: 1,
      mode: 'plain',
      promptText: 'prompt with the complete car-project Auto block',
      focusPayloadText: '# Notes from previous sessions\n\n- Apartment cancellations require confirmation',
      visiblePool: [target],
      focusedMemories: [target],
      getAutoProjectCloneRef: (memoryId) => memory.getAutoProjectCloneRef(memoryId),
      injectionId: 'car-injection-1',
      focusedAt: '2026-08-19T10:00:00.000Z',
    });

    expect(delivery.memories[0]?.sourceRef).toEqual({
      kind: 'auto_store',
      memoryId: target.id,
      storeVersion: 1,
      ...expectedProvenance,
    });
    memory.store.update(
      target.id,
      { content: 'Car cancellations require a two-step confirmation' },
      { actor: 'agent' },
    );
    const registry = new StudyRegistry(undefined, ['098-S1']);
    const questionnaire = new StudyQuestionnaireService({
      store: studyStore,
      registry,
      logger: { event: () => {} },
      memoryStore: memory.store,
      getAutoProjectCloneRef: (memoryId) => memory.getAutoProjectCloneRef(memoryId),
      studyFreezeBlocker: () => null,
      awaitStudyMemorySettled: async () => [],
      now: () => '2026-08-19T10:05:00.000Z',
      randomId: () => 'freeze-car',
    });

    await questionnaire.freeze('098-S1');

    const frozen = studyStore.getTaskFreezeSnapshot('098-S1')!;
    expect(frozen.items).toHaveLength(1);
    expect(frozen.items[0]).toMatchObject({
      identity: { scheme: 'store', id: target.id },
      cue: {
        version: 1,
        scope: 'project',
        sourceRef: expectedProvenance,
      },
      object: {
        version: 2,
        content: 'Car cancellations require a two-step confirmation',
        scope: 'project',
        sourceRef: expectedProvenance,
      },
      history: [{ injectionId: 'car-injection-1', turn: 1 }],
    });
    expect(frozen.items.some((item) => item.identity.id === source.id)).toBe(false);

    studyStore.close();
    memory.close();
  });
});
