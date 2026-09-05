import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAutoProjectCopyAdapter } from './auto-project-copy-adapter';
import { createAutoProjectCopyService } from './auto-project-copy';
import { MemoryService } from './index';
import { buildPlainMemoryBlock } from './prompt';
import {
  autoProjectSummaryKey,
  createSummaryService,
  type AutoProjectSummaryProjection,
} from './summary';

let dir: string;
let memory: MemoryService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'auto-project-copy-adapter-'));
  memory = new MemoryService({ dbPath: join(dir, 'memory.sqlite'), dataDir: join(dir, 'projection') });
});

afterEach(() => {
  memory.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Auto BaselineProjectCopyAdapter', () => {
  test('materializes the final source summary locally and returns an exact, retry-safe clone manifest', async () => {
    memory.store.create(
      {
        content: 'Apartment bookings require a cancellation confirmation',
        scope: 'project',
        projectId: 'project-apartment',
        type: 'constraint',
      },
      { actor: 'agent' },
    );
    let summaryCalls = 0;
    const summaries = createSummaryService({
      memory,
      callJson: async () => {
        summaryCalls += 1;
        throw new Error('Project Copy must not call the summary provider');
      },
    });
    const adapter = createAutoProjectCopyAdapter({
      memory,
      summaries,
      resolveProject: (slug) => {
        const projectId = ({
          apartment: 'project-apartment',
          car: 'project-car',
        })[slug];
        return projectId ? { projectId, starterReady: true } : undefined;
      },
    });
    const input = {
      transitionKey: 'snapshot-038:038-S2->098-S1',
      fromTaskId: '038-S2',
      fromProjectSlug: 'apartment',
      toTaskId: '098-S1',
      toProjectSlug: 'car',
      sourceFreezeRef: {
        taskId: '038-S2',
        snapshotId: 'snapshot-038',
        frozenAt: '2026-08-19T09:00:00.000Z',
      },
    };
    const sourceBlock = buildPlainMemoryBlock(memory.autoProjectMemories('project-apartment'));

    const first = await adapter.prepare(input);

    expect(adapter.condition).toBe('auto');
    expect(first.sourceRepresentationHash).toBe(first.targetRepresentationHash);
    expect(buildPlainMemoryBlock(memory.autoProjectMemories('project-car'))).toBe(sourceBlock);
    expect(summaryCalls).toBe(0);
    expect(summaries.get('project-car')).toEqual(summaries.get('project-apartment'));
    const sourceProjection = memory.store.getKv<AutoProjectSummaryProjection>(
      autoProjectSummaryKey('project-apartment'),
    );
    const targetProjection = memory.store.getKv<AutoProjectSummaryProjection>(
      autoProjectSummaryKey('project-car'),
    );
    expect(targetProjection).toMatchObject({
      text: sourceProjection!.text,
      updatedAt: sourceProjection!.updatedAt,
    });
    expect(sourceProjection!.text).toContain('Apartment bookings require a cancellation confirmation');
    expect(targetProjection!.itemsHash).not.toBe(sourceProjection!.itemsHash);
    expect(first.manifest).toMatchObject({
      schemaVersion: 1,
      kind: 'auto_project_memory_block',
      outcome: 'copied',
      sourceProjectId: 'project-apartment',
      targetProjectId: 'project-car',
      sourceSnapshotId: 'snapshot-038',
      clones: [
        {
          targetMemoryId: expect.any(String),
          cloneOf: {
            memoryId: expect.any(String),
            version: 1,
            contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        },
      ],
      summaryTextHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(() => JSON.stringify(first.manifest)).not.toThrow();
    const targetIds = memory.autoProjectMemories('project-car').map((item) => item.id);

    const retry = await adapter.prepare(input);

    expect(retry).toEqual({
      ...first,
      manifest: { ...first.manifest, outcome: 'already_present' },
    });
    expect(summaryCalls).toBe(0);
    expect(memory.autoProjectMemories('project-car').map((item) => item.id)).toEqual(targetIds);
    expect(createAutoProjectCopyService({ memory }).getReceipt(input.transitionKey)?.created).toBe(false);
  });

  test('rejects an unregistered project slug before creating a destination copy', async () => {
    const summaries = createSummaryService({ memory, callJson: async () => ({ summary: '' }) });
    const adapter = createAutoProjectCopyAdapter({
      memory,
      summaries,
      resolveProject: (slug) => slug === 'apartment'
        ? { projectId: 'project-apartment', starterReady: true }
        : undefined,
    });

    await expect(adapter.prepare({
      transitionKey: 'snapshot-038:038-S2->098-S1',
      fromTaskId: '038-S2',
      fromProjectSlug: 'apartment',
      toTaskId: '098-S1',
      toProjectSlug: 'car',
      sourceFreezeRef: {
        taskId: '038-S2',
        snapshotId: 'snapshot-038',
        frozenAt: '2026-08-19T09:00:00.000Z',
      },
    })).rejects.toThrow(/registered study project.*car/i);
    expect(memory.store.list({ scope: 'project' })).toEqual([]);
  });

  test('rejects an unready source or target before creating summary or copy state', async () => {
    memory.store.create(
      {
        content: 'Apartment bookings require a cancellation confirmation',
        scope: 'project',
        projectId: 'project-apartment',
        type: 'constraint',
      },
      { actor: 'agent' },
    );
    let summaryCalls = 0;
    const summaries = createSummaryService({
      memory,
      callJson: async () => {
        summaryCalls += 1;
        return { summary: 'This must never be generated for an unready transition.' };
      },
    });
    const baseInput = {
      fromTaskId: '038-S2',
      fromProjectSlug: 'apartment',
      toTaskId: '098-S1',
      toProjectSlug: 'car',
      sourceFreezeRef: {
        taskId: '038-S2',
        snapshotId: 'snapshot-038',
        frozenAt: '2026-08-19T09:00:00.000Z',
      },
    };

    for (const unreadySlug of ['apartment', 'car']) {
      const transitionKey = `snapshot-038:${unreadySlug}-unready`;
      const adapter = createAutoProjectCopyAdapter({
        memory,
        summaries,
        resolveProject: (slug) => ({
          projectId: slug === 'apartment' ? 'project-apartment' : 'project-car',
          starterReady: slug !== unreadySlug,
        }),
      });

      await expect(adapter.prepare({ ...baseInput, transitionKey }))
        .rejects.toThrow(new RegExp(`registered study project.*${unreadySlug}.*not ready`, 'i'));
      expect(createAutoProjectCopyService({ memory }).getReceipt(transitionKey)).toBeNull();
      expect(memory.store.list({ scope: 'project', projectId: 'project-car' })).toEqual([]);
      expect(memory.store.getKv(autoProjectSummaryKey('project-apartment'))).toBeNull();
      expect(memory.store.getKv(autoProjectSummaryKey('project-car'))).toBeNull();
    }
    expect(summaryCalls).toBe(0);
  });
});
