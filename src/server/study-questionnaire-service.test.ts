import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExperimentEvent } from './experiment/logger';
import { StudyMemoryStore } from './experiment/study-memory-store';
import type { MemoryItem } from './memory/types';
import { StudyQuestionnaireError, StudyQuestionnaireService } from './study-questionnaire-service';
import { StudyRegistry } from './study-registry';
import type { StudyWorkspaceSnapshotMetadata } from './study-workspace-snapshot';

const ATTENTION_RESPONSE = {
  checkId: 'attention-038-s1',
  selectedValue: 'option_b',
} as const;

function recordFocus(store: StudyMemoryStore, overrides: {
  injectionId: string;
  turn: number;
  version: number;
  content: string;
  scope?: 'session' | 'project' | 'personal';
}) {
  store.recordFocusDelivery({
    injectionId: overrides.injectionId,
    taskId: '038-S1',
    chatId: 'chat-1',
    turnId: `turn-${overrides.turn}`,
    turn: overrides.turn,
    focusedAt: `2026-08-15T10:0${overrides.turn}:00.000Z`,
    condition: 'memosync',
    engine: 'claude',
    mode: 'skills',
    outcome: 'delivered',
    deliveryStage: 'queued_to_claude',
    deliveryHash: `delivery-${overrides.turn}`,
    visiblePoolHash: `pool-${overrides.turn}`,
    items: [{
      identity: { scheme: 'store', id: 'M-01' },
      version: overrides.version,
      content: overrides.content,
      scope: overrides.scope ?? 'project',
      sourceRef: { kind: 'memosync_store', memoryId: 'M-01', storeVersion: overrides.version },
    }],
  });
}

function memoryItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: 'M-01',
    content: 'Use pnpm in every project.',
    scope: 'personal',
    type: 'preference',
    status: 'archived',
    abstractionLevel: 'general',
    sensitive: false,
    usageCount: 0,
    reinforcedCount: 0,
    citedInCurrentSession: 0,
    version: 3,
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T10:10:00.000Z',
    ...overrides,
  } as MemoryItem;
}

describe('StudyQuestionnaireService', () => {
  test('keeps Finish locked until one prompt, one successful agent turn, a workspace change, and no open interrupt', async () => {
    const store = new StudyMemoryStore(':memory:');
    const registry = new StudyRegistry(undefined, ['038-S1']);
    let workspace = { treeHash: 'starter-tree', fileCount: 43, totalBytes: 72_305 };
    let runEvidence = {
      participantPromptCount: 0,
      completedAgentTurnCount: 0,
      unresolvedMemoryInterruptCount: 0,
    };
    const service = new StudyQuestionnaireService({
      store,
      registry,
      logger: { event: () => {} },
      memoryStore: { getById: () => null },
      studyFreezeBlocker: () => null,
      awaitStudyMemorySettled: async () => [],
      captureWorkspaceState: async () => ({ ...workspace }),
      getTaskRunEvidence: () => ({ ...runEvidence }),
      now: () => '2026-08-22T10:00:00.000Z',
    });

    await service.ensureWorkspaceBaseline('038-S1');
    workspace = { treeHash: 'changed-tree', fileCount: 44, totalBytes: 72_400 };
    expect(await service.completionEligibility('038-S1')).toMatchObject({
      eligible: false,
      participantPromptCount: 0,
      completedAgentTurnCount: 0,
      workspaceChanged: true,
      unresolvedMemoryInterruptCount: 0,
      missing: [
        { code: 'participant_prompt' },
        { code: 'completed_agent_turn' },
      ],
    });

    runEvidence = {
      participantPromptCount: 1,
      completedAgentTurnCount: 1,
      unresolvedMemoryInterruptCount: 1,
    };
    expect(await service.completionEligibility('038-S1')).toMatchObject({
      eligible: false,
      missing: [{ code: 'unresolved_memory_interrupt' }],
    });
    await expect(service.freeze('038-S1')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('Resolve the stopped memory turn'),
    });

    runEvidence.unresolvedMemoryInterruptCount = 0;
    expect(await service.completionEligibility('038-S1')).toMatchObject({ eligible: true, missing: [] });
    store.close();
  });

  test('blocks freeze when transcript-backed participant prompt recovery fails', async () => {
    const store = new StudyMemoryStore(':memory:');
    const registry = new StudyRegistry(undefined, ['038-S1']);
    let attempts = 0;
    const service = new StudyQuestionnaireService({
      store,
      registry,
      logger: { event: () => {} },
      memoryStore: { getById: () => null },
      studyFreezeBlocker: () => null,
      awaitStudyMemorySettled: async () => [],
      reconcileParticipantPrompts: () => {
        attempts += 1;
        throw new Error('simulated SQLite outage after transcript append');
      },
    });

    await expect(service.freeze('038-S1')).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining('participant prompt evidence'),
    });
    expect(attempts).toBe(1);
    expect(store.getTaskFreezeSnapshot('038-S1')).toBeNull();
    expect(registry.freezeState('038-S1')).toBe('open');
    store.close();
  });

  test('persists the scoreable workspace metadata in the freeze and does not recopy on retry', async () => {
    const store = new StudyMemoryStore(':memory:');
    const registry = new StudyRegistry(undefined, ['038-S1']);
    const events: ExperimentEvent[] = [];
    const workspaceSnapshot: StudyWorkspaceSnapshotMetadata = {
      schemaVersion: 1,
      taskId: '038-S1',
      snapshotId: 'freeze-workspace',
      project: { slug: 'apartment', title: 'Apartment rentals' },
      frozenAt: '2026-08-18T15:00:00.000Z',
      exportedPath: 'experiments/workspace-snapshots/038-S1/freeze-workspace/workspace',
      treeHash: 'tree-sha256',
      fileCount: 12,
      totalBytes: 3456,
      exclusions: ['**/node_modules/**'],
    };
    let captures = 0;
    const service = new StudyQuestionnaireService({
      store,
      registry,
      logger: { event: (event) => events.push(event) },
      memoryStore: { getById: () => null },
      studyFreezeBlocker: () => null,
      awaitStudyMemorySettled: async () => [],
      snapshotWorkspace: async (input) => {
        captures += 1;
        expect(input).toEqual({
          taskId: '038-S1',
          snapshotId: 'freeze-workspace',
          frozenAt: '2026-08-18T15:00:00.000Z',
        });
        return workspaceSnapshot;
      },
      now: () => '2026-08-18T15:00:00.000Z',
      randomId: () => 'freeze-workspace',
    });

    await service.freeze('038-S1');
    await service.freeze('038-S1');

    expect(captures).toBe(1);
    expect(store.getTaskFreezeSnapshot('038-S1')?.workspaceSnapshot).toEqual(workspaceSnapshot);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'study.freeze',
      workspaceSnapshotPath: workspaceSnapshot.exportedPath,
      workspaceTreeHash: workspaceSnapshot.treeHash,
    }));
    store.close();
  });

  test('blocks the questionnaire and reopens the freeze gate when workspace capture fails', async () => {
    const store = new StudyMemoryStore(':memory:');
    const registry = new StudyRegistry(undefined, ['038-S1']);
    const service = new StudyQuestionnaireService({
      store,
      registry,
      logger: { event: () => {} },
      memoryStore: { getById: () => null },
      studyFreezeBlocker: () => null,
      awaitStudyMemorySettled: async () => [],
      snapshotWorkspace: async () => {
        throw new Error('source kept changing');
      },
      randomId: () => 'freeze-failed-workspace',
    });

    await expect(service.freeze('038-S1')).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining('source kept changing'),
    });
    expect(store.getTaskFreezeSnapshot('038-S1')).toBeNull();
    expect(registry.freezeState('038-S1')).toBe('open');
    store.close();
  });

  test('uses a new authoritative workspace snapshot after experimenter unfreeze', async () => {
    const store = new StudyMemoryStore(':memory:');
    const registry = new StudyRegistry(undefined, ['038-S1']);
    const ids = ['freeze-before-unfreeze', 'freeze-after-unfreeze'];
    const capturedIds: string[] = [];
    const service = new StudyQuestionnaireService({
      store,
      registry,
      logger: { event: () => {} },
      memoryStore: { getById: () => null },
      studyFreezeBlocker: () => null,
      awaitStudyMemorySettled: async () => [],
      snapshotWorkspace: async ({ taskId, snapshotId, frozenAt }) => {
        capturedIds.push(snapshotId);
        return {
          schemaVersion: 1,
          taskId,
          snapshotId,
          project: { slug: 'apartment', title: 'Apartment rentals' },
          frozenAt,
          exportedPath: `experiments/workspace-snapshots/${taskId}/${snapshotId}/workspace`,
          treeHash: `tree-${snapshotId}`,
          fileCount: 1,
          totalBytes: 1,
          exclusions: [],
        };
      },
      randomId: () => ids.shift()!,
    });

    await service.freeze('038-S1');
    service.unfreeze('038-S1');
    await service.freeze('038-S1');

    expect(capturedIds).toEqual(['freeze-before-unfreeze', 'freeze-after-unfreeze']);
    expect(store.getTaskFreezeSnapshot('038-S1')?.workspaceSnapshot).toMatchObject({
      snapshotId: 'freeze-after-unfreeze',
      treeHash: 'tree-freeze-after-unfreeze',
    });
    store.close();
  });

  test('reserves prompts, waits for settlement, and freezes cue/history separately from final O_i', async () => {
    const store = new StudyMemoryStore(':memory:');
    recordFocus(store, { injectionId: 'inj-1', turn: 1, version: 1, content: 'Use npm.' });
    recordFocus(store, { injectionId: 'inj-2', turn: 2, version: 2, content: 'Use pnpm.' });
    const registry = new StudyRegistry(undefined, ['038-S1', '038-S2']);
    const events: ExperimentEvent[] = [];
    let release!: () => void;
    const settlement = new Promise<void>((resolve) => { release = resolve; });
    const service = new StudyQuestionnaireService({
      store,
      registry,
      logger: { event: (event) => events.push(event) },
      memoryStore: { getById: () => memoryItem() },
      studyFreezeBlocker: () => null,
      awaitStudyMemorySettled: async () => {
        await settlement;
        return [{
          code: 'capture_failed',
          blocking: false,
          taskId: '038-S1',
          chatId: 'chat-1',
          turnId: 'turn-2',
          turn: 2,
        }];
      },
      now: () => '2026-08-15T10:15:00.000Z',
      randomId: () => 'freeze-1',
    });

    const freezing = service.freeze('038-S1');
    expect(registry.freezeState('038-S1')).toBe('freezing');
    expect(registry.promptRefusal()).toContain('ending');
    release();
    const questionnaire = await freezing;

    expect(questionnaire.questionnaireVersion).toBe(2);
    expect(questionnaire.items).toEqual([{
      probeId: expect.any(String),
      snapshotId: 'freeze-1',
      cue: 'Use pnpm.',
    }]);
    const snapshot = store.getTaskFreezeSnapshot('038-S1')!;
    expect(snapshot.qualityFlags).toContain('capture_failed:chat-1:turn-2');
    expect(snapshot.items[0]).toMatchObject({
      cue: { version: 2, content: 'Use pnpm.', scope: 'project' },
      object: {
        present: false,
        status: 'archived',
        version: 3,
        content: 'Use pnpm in every project.',
        scope: 'personal',
      },
      history: [
        { injectionId: 'inj-1', version: 1, content: 'Use npm.' },
        { injectionId: 'inj-2', version: 2, content: 'Use pnpm.' },
      ],
    });
    expect(registry.freezeState('038-S1')).toBe('frozen');
    expect(events[0]).toMatchObject({ type: 'study.freeze', taskId: '038-S1', snapshotId: 'freeze-1' });

    // Loading never re-reads the live object.
    expect(service.get('038-S1')).toEqual(questionnaire);
    store.close();
  });

  test('releases the reservation and blocks the questionnaire on a critical measurement failure', async () => {
    const store = new StudyMemoryStore(':memory:');
    const registry = new StudyRegistry(undefined, ['038-S1']);
    const service = new StudyQuestionnaireService({
      store,
      registry,
      logger: { event: () => {} },
      memoryStore: { getById: () => null },
      studyFreezeBlocker: () => null,
      awaitStudyMemorySettled: async () => [{
        code: 'focus_persistence_failed',
        blocking: true,
        taskId: '038-S1',
        chatId: 'chat-1',
        turnId: 'turn-1',
      }],
    });

    await expect(service.freeze('038-S1')).rejects.toMatchObject({ status: 503 });
    expect(registry.freezeState('038-S1')).toBe('open');
    expect(store.getTaskFreezeSnapshot('038-S1')).toBeNull();
    store.close();
  });

  test('accepts an immutable zero-item snapshot and an empty answer set', async () => {
    const store = new StudyMemoryStore(':memory:');
    const registry = new StudyRegistry(undefined, ['038-S1', '038-S2']);
    const service = new StudyQuestionnaireService({
      store,
      registry,
      logger: { event: () => {} },
      memoryStore: { getById: () => null },
      studyFreezeBlocker: () => null,
      awaitStudyMemorySettled: async () => [],
      randomId: () => 'freeze-empty',
    });
    const frozen = await service.freeze('038-S1');

    expect(frozen.items).toEqual([]);
    expect(service.submit({ taskId: '038-S1', snapshotId: 'freeze-empty', answers: [], attentionCheck: ATTENTION_RESPONSE })).toMatchObject({ recorded: 0 });
    expect(registry.taskStatus('038-S2')).toBe('locked');
    store.close();
  });

  test('reopens and submits an unfinished legacy v1 freeze through its explicit public version', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'memosync-questionnaire-v1-'));
    const dbPath = join(tempDir, 'study.sqlite');
    try {
      const first = new StudyMemoryStore(dbPath);
      recordFocus(first, { injectionId: 'legacy-inj', turn: 1, version: 1, content: 'Use pnpm.' });
      first.createFreezeSnapshot({
        snapshotId: 'freeze-legacy-unfinished',
        taskId: '038-S1',
        frozenAt: '2026-08-15T10:00:00.000Z',
        objectStates: [{
          identity: { scheme: 'store', id: 'M-01' },
          present: true,
          status: 'active',
          version: 1,
          content: 'Use pnpm.',
          scope: 'project',
        }],
      });
      first.close();

      const legacy = new Database(dbPath);
      const row = legacy.query('SELECT payload_json FROM study_freeze_snapshots WHERE snapshot_id = ?')
        .get('freeze-legacy-unfinished') as { payload_json: string };
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      delete payload.questionnaireVersion;
      legacy.query('UPDATE study_freeze_snapshots SET payload_json = ? WHERE snapshot_id = ?')
        .run(JSON.stringify(payload), 'freeze-legacy-unfinished');
      legacy.close();

      const reopened = new StudyMemoryStore(dbPath);
      const registry = new StudyRegistry(undefined, ['038-S1']);
      const service = new StudyQuestionnaireService({
        store: reopened,
        registry,
        logger: { event: () => {} },
        memoryStore: { getById: () => memoryItem({ status: 'active' }) },
        studyFreezeBlocker: () => null,
        awaitStudyMemorySettled: async () => [],
        randomId: () => 'legacy-submission',
      });
      const publicPayload = service.get('038-S1');
      expect(publicPayload.questionnaireVersion).toBe(1);
      const answer = {
        probeId: publicPayload.items[0]!.probeId,
        snapshotId: publicPayload.snapshotId,
        desired: { kind: 'accurate', presence: 'present', scope: 'project' },
        assessed: { kind: 'unsure', presence: 'unknown', scope: 'unsure' },
        execution: 'unsure',
      } as const;
      expect(service.submit({ taskId: '038-S1', snapshotId: publicPayload.snapshotId, answers: [answer], attentionCheck: ATTENTION_RESPONSE }))
        .toMatchObject({ recorded: 1, created: true });
      expect(reopened.getQuestionnaireSubmission(publicPayload.snapshotId)).toMatchObject({
        questionnaireVersion: 1,
        answers: [answer],
      });
      reopened.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('requires the exact probe set and the current snapshot id', async () => {
    const store = new StudyMemoryStore(':memory:');
    recordFocus(store, { injectionId: 'inj-1', turn: 1, version: 1, content: 'Use pnpm.' });
    const registry = new StudyRegistry(undefined, ['038-S1']);
    const service = new StudyQuestionnaireService({
      store,
      registry,
      logger: { event: () => {} },
      memoryStore: { getById: () => memoryItem({ status: 'active' }) },
      studyFreezeBlocker: () => null,
      awaitStudyMemorySettled: async () => [],
      randomId: () => 'freeze-exact',
    });
    const frozen = await service.freeze('038-S1');
    const answer = {
      probeId: frozen.items[0]!.probeId,
      snapshotId: 'freeze-exact',
      desired: { rating: 5, presence: 'present', correctedContent: null, scope: 'project' },
      assessed: { rating: 1, presence: 'absent', believedContent: null, scope: null },
      execution: 1,
    } as const;

    expect(() => service.submit({ taskId: '038-S1', snapshotId: 'stale', answers: [answer], attentionCheck: ATTENTION_RESPONSE }))
      .toThrow(StudyQuestionnaireError);
    expect(() => service.submit({ taskId: '038-S1', snapshotId: 'freeze-exact', answers: [], attentionCheck: ATTENTION_RESPONSE }))
      .toThrow(/exactly once/);
    expect(service.submit({ taskId: '038-S1', snapshotId: 'freeze-exact', answers: [answer], attentionCheck: ATTENTION_RESPONSE }))
      .toMatchObject({ recorded: 1 });
    // Lost HTTP response: the exact retry is idempotent while workload remains pending.
    expect(service.submit({ taskId: '038-S1', snapshotId: 'freeze-exact', answers: [answer], attentionCheck: ATTENTION_RESPONSE }))
      .toMatchObject({ recorded: 1, created: false });
    store.close();
  });

  test('admin unfreeze removes the unanswered snapshot and reopens the task', async () => {
    const store = new StudyMemoryStore(':memory:');
    const registry = new StudyRegistry(undefined, ['038-S1']);
    const events: ExperimentEvent[] = [];
    const service = new StudyQuestionnaireService({
      store,
      registry,
      logger: { event: (event) => events.push(event) },
      memoryStore: { getById: () => null },
      studyFreezeBlocker: () => null,
      awaitStudyMemorySettled: async () => [],
      randomId: () => 'freeze-unfreeze',
    });
    await service.freeze('038-S1');

    service.unfreeze('038-S1');

    expect(store.getTaskFreezeSnapshot('038-S1')).toBeNull();
    expect(registry.freezeState('038-S1')).toBe('open');
    expect(events.at(-1)).toEqual({ type: 'study.unfreeze', taskId: '038-S1' });
    store.close();
  });
});
