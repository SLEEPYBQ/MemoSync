import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAutoProjectCopyService } from './auto-project-copy';
import { MemoryService } from './index';
import { buildPlainMemoryBlock } from './prompt';
import { createSummaryService } from './summary';

let dir: string;
let memory: MemoryService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'auto-project-copy-'));
  memory = new MemoryService({ dbPath: join(dir, 'memory.sqlite'), dataDir: join(dir, 'projection') });
});

afterEach(() => {
  memory.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Auto Project Copy transition', () => {
  test('copies the final rendered block once into new v1 identities that evolve independently', () => {
    const first = memory.store.create(
      {
        content: 'Apartment cancellations require confirmation',
        detail: 'Open a confirmation dialog before deleting the booking.',
        scope: 'project',
        projectId: 'apartment',
        type: 'constraint',
        topic: 'Bookings',
      },
      { actor: 'agent', sessionId: '038-S1-chat', turn: 1 },
    );
    memory.store.create(
      {
        content: 'Apartment filters stay in the URL',
        scope: 'project',
        projectId: 'apartment',
        type: 'fact',
      },
      { actor: 'agent', sessionId: '038-S2-chat', turn: 2 },
    );
    memory.store.update(
      first.id,
      { content: 'Apartment cancellations require an explicit confirmation dialog' },
      { actor: 'agent', sessionId: '038-S2-chat', turn: 3 },
    );
    const sourceBefore = memory.autoProjectMemories('apartment');
    const sourceBlock = buildPlainMemoryBlock(sourceBefore);
    const service = createAutoProjectCopyService({ memory });

    const receipt = service.copyOnce({
      transitionKey: 'auto:038-S2->098-S1',
      sourceTaskId: '038-S2',
      targetTaskId: '098-S1',
      sourceProjectId: 'apartment',
      targetProjectId: 'car',
    });

    const target = memory.autoProjectMemories('car');
    expect(receipt.created).toBe(true);
    expect(receipt.sourceRepresentationHash).toBe(receipt.targetRepresentationHash);
    expect(buildPlainMemoryBlock(target)).toBe(sourceBlock);
    expect(target.map((item) => item.id)).not.toEqual(sourceBefore.map((item) => item.id));
    expect(target.map((item) => item.version)).toEqual([1, 1]);
    expect(target).toEqual(target.map((item) => expect.objectContaining({ scope: 'project', projectId: 'car' })));
    expect(receipt.clones).toEqual(target.map((item, index) => ({
      targetMemoryId: item.id,
      cloneOf: {
        memoryId: sourceBefore[index]!.id,
        version: sourceBefore[index]!.version,
        contentHash: expect.any(String),
      },
    })));

    memory.store.update(target[0]!.id, { content: 'Car cancellations use a two-step confirmation' }, { actor: 'user' });
    expect(memory.store.getById(sourceBefore[0]!.id)?.content).toBe(
      'Apartment cancellations require an explicit confirmation dialog',
    );
  });

  test('copies the current summary projection, then lets the target summary become stale independently', async () => {
    memory.store.create(
      {
        content: 'Apartment listings use compact cards',
        scope: 'project',
        projectId: 'apartment',
        type: 'fact',
      },
      { actor: 'agent' },
    );
    const summaries = createSummaryService({
      memory,
      callJson: async () => ({ summary: 'You use compact listing cards.' }),
    });
    await summaries.refresh('apartment');
    const sourceSummary = summaries.get('apartment');

    createAutoProjectCopyService({ memory }).copyOnce({
      transitionKey: 'auto:038-S2->098-S1',
      sourceTaskId: '038-S2',
      targetTaskId: '098-S1',
      sourceProjectId: 'apartment',
      targetProjectId: 'car',
    });

    expect(summaries.get('car')).toEqual(sourceSummary);
    const target = memory.autoProjectMemories('car')[0]!;
    memory.store.update(target.id, { content: 'Car listings use spacious cards' }, { actor: 'user' });
    expect(summaries.get('car').stale).toBe(true);
    expect(summaries.get('apartment').stale).toBe(false);
  });

  test('persists an empty-copy receipt so restart and source changes cannot recopy the target', () => {
    const input = {
      transitionKey: 'auto:038-S2->098-S1',
      sourceTaskId: '038-S2',
      targetTaskId: '098-S1',
      sourceProjectId: 'apartment',
      targetProjectId: 'car',
    };
    const first = createAutoProjectCopyService({ memory }).copyOnce(input);

    expect(first).toMatchObject({
      created: true,
      clones: [],
      sourceRepresentationHash: first.targetRepresentationHash,
    });
    expect(memory.autoProjectMemories('car')).toEqual([]);

    memory.close();
    memory = new MemoryService({ dbPath: join(dir, 'memory.sqlite'), dataDir: join(dir, 'projection') });
    memory.store.create(
      { content: 'Learned after the transition receipt', scope: 'project', projectId: 'apartment', type: 'fact' },
      { actor: 'agent' },
    );
    const retry = createAutoProjectCopyService({ memory }).copyOnce(input);

    expect(retry.created).toBe(false);
    expect(retry.copiedAt).toBe(first.copiedAt);
    expect(memory.autoProjectMemories('car')).toEqual([]);
  });

  test('returns the original receipt on an identical retry and rejects changed endpoints', () => {
    memory.store.create(
      { content: 'Apartment memory', scope: 'project', projectId: 'apartment', type: 'fact' },
      { actor: 'agent' },
    );
    const service = createAutoProjectCopyService({ memory });
    const input = {
      transitionKey: 'auto:038-S2->098-S1',
      sourceTaskId: '038-S2',
      targetTaskId: '098-S1',
      sourceProjectId: 'apartment',
      targetProjectId: 'car',
    };
    const first = service.copyOnce(input);
    const targetIds = memory.autoProjectMemories('car').map((item) => item.id);

    const retry = service.copyOnce(input);
    expect(retry).toEqual({ ...first, created: false });
    expect(memory.autoProjectMemories('car').map((item) => item.id)).toEqual(targetIds);
    expect(() => service.copyOnce({ ...input, targetProjectId: 'car-v2' })).toThrow(/different endpoints/);
    expect(memory.autoProjectMemories('car-v2')).toEqual([]);
  });

  test('refuses to merge when the destination contains even a non-active memory row', () => {
    memory.store.create(
      { content: 'Source memory', scope: 'project', projectId: 'apartment', type: 'fact' },
      { actor: 'agent' },
    );
    const preexisting = memory.store.create(
      { content: 'Unexpected destination memory', scope: 'project', projectId: 'car', type: 'fact' },
      { actor: 'agent' },
    );
    memory.store.archive(preexisting.id, { actor: 'user' });

    // Auto injection hides archived rows, but Project Copy must still treat
    // their identities/history as an initialized destination and fail closed.
    expect(memory.autoProjectMemories('car')).toEqual([]);

    expect(() => createAutoProjectCopyService({ memory }).copyOnce({
      transitionKey: 'auto:038-S2->098-S1',
      sourceTaskId: '038-S2',
      targetTaskId: '098-S1',
      sourceProjectId: 'apartment',
      targetProjectId: 'car',
    })).toThrow(/refusing to merge/);
    expect(memory.store.getById(preexisting.id)).toMatchObject({ id: preexisting.id, status: 'archived' });
  });
});
