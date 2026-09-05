import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildStaticFocusPayload,
  readStaticMemoryFiles,
  type StaticFocusPayload,
} from '../memory/static-files';
import { MEMORY_ATOM_SPEC_VERSION } from '../memory/atom-spec';
import {
  createStaticMemoryExtractor,
  STATIC_EXTRACTOR_VERSION,
  type StaticMemoryExtractor,
} from './static-memory-extractor';
import { materializeDeliveredStaticFocus } from './static-focus';
import { resolveFrozenStaticObjectStates } from './static-freeze';
import { StudyMemoryStore } from './study-memory-store';

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function hash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function measuredAtom(content: string, segmentOrdinal: number, atomOrdinal = 0) {
  return {
    content,
    contentHash: hash(content),
    scope: 'project' as const,
    sourceRef: {
      kind: 'static_file' as const,
      relPath: 'MEMORY.md',
      heading: 'Memory',
      segmentOrdinal,
      fileContentHash: 'file-hash',
      segmentHash: `segment-${segmentOrdinal}`,
      sourceStart: 0,
      sourceEnd: 1,
      payloadStart: 0,
      payloadEnd: 1,
      atomOrdinal,
    },
    qualityFlags: [] as string[],
  };
}

function extractorReturning(atoms: ReturnType<typeof measuredAtom>[]): StaticMemoryExtractor {
  return {
    extract: async () => ({
      atomSpecVersion: MEMORY_ATOM_SPEC_VERSION,
      extractorVersion: STATIC_EXTRACTOR_VERSION,
      payloadHash: `freeze-${hash(JSON.stringify(atoms))}`,
      atoms,
      qualityFlags: [],
    }),
  };
}

function focusStaticAtoms(
  store: StudyMemoryStore,
  atoms: ReturnType<typeof measuredAtom>[],
) {
  const resolution = store.resolveStaticAtoms({
    namespace: 'project-1',
    snapshotHash: 'focused-snapshot',
    observedAt: '2026-08-15T10:00:00.000Z',
    atoms,
  });
  store.recordFocusDelivery({
    injectionId: 'focus-1',
    taskId: '038-S1',
    chatId: 'chat-1',
    turnId: 'turn-1',
    turn: 1,
    focusedAt: '2026-08-15T10:00:00.000Z',
    condition: 'static',
    engine: 'claude',
    mode: 'file',
    outcome: 'delivered',
    deliveryStage: 'queued_to_claude',
    deliveryHash: 'delivery-hash',
    visiblePoolHash: 'pool-hash',
    items: resolution.atoms,
  });
  return resolution.atoms.map((atom) => atom.identity);
}

async function freezeRemap(
  store: StudyMemoryStore,
  identities: ReturnType<typeof focusStaticAtoms>,
  finalAtoms: ReturnType<typeof measuredAtom>[],
) {
  writeFileSync(join(dir, 'MEMORY.md'), '- final state\n');
  return resolveFrozenStaticObjectStates({
    taskId: '038-S1',
    identities,
    store,
    extractor: extractorReturning(finalAtoms),
    getWorkspaceDir: () => dir,
    now: () => '2026-08-15T10:10:00.000Z',
  });
}

describe('resolveFrozenStaticObjectStates', () => {
  test('extracts fresh Markdown into final O_i without creating another focus occurrence', async () => {
    dir = mkdtempSync(join(tmpdir(), 'static-freeze-'));
    const store = new StudyMemoryStore(':memory:');
    const extractor = createStaticMemoryExtractor({
      callJson: async ({ user }) => ({
        atoms: [{ content: user.includes('pnpm') ? 'Use pnpm.' : 'Use npm.' }],
      }),
      modelId: 'test',
    });
    writeFileSync(join(dir, 'MEMORY.md'), '- Use npm.\n');
    const firstPayload = buildStaticFocusPayload(readStaticMemoryFiles(dir));
    await materializeDeliveredStaticFocus({
      store,
      extractor,
      logger: { event: () => {} },
      taskId: '038-S1',
      namespace: 'project-1',
      chatId: 'chat-1',
      turnId: 'turn-1',
      turn: 1,
      promptText: firstPayload.text,
      payload: firstPayload,
    });
    const identity = store.listTaskDeliveries('038-S1')[0]!.items[0]!.identity;
    writeFileSync(join(dir, 'MEMORY.md'), '- Use pnpm.\n');

    const states = await resolveFrozenStaticObjectStates({
      taskId: '038-S1',
      identities: [identity],
      store,
      extractor,
      getWorkspaceDir: (namespace) => namespace === 'project-1' ? dir : null,
      now: () => '2026-08-15T10:10:00.000Z',
    });

    expect(states).toEqual([
      expect.objectContaining({
        identity,
        present: true,
        status: 'active',
        version: 2,
        content: 'Use pnpm.',
        scope: 'project',
      }),
    ]);
    expect(store.listTaskDeliveries('038-S1')).toHaveLength(1);
    store.close();
  });

  test('freezes a focused identity as deleted when its Markdown was removed', async () => {
    dir = mkdtempSync(join(tmpdir(), 'static-freeze-'));
    const store = new StudyMemoryStore(':memory:');
    const extractor = createStaticMemoryExtractor({
      callJson: async () => ({ atoms: [{ content: 'Use pnpm.' }] }),
      modelId: 'test',
    });
    writeFileSync(join(dir, 'MEMORY.md'), '- Use pnpm.\n');
    const payload = buildStaticFocusPayload(readStaticMemoryFiles(dir));
    await materializeDeliveredStaticFocus({
      store,
      extractor,
      logger: { event: () => {} },
      taskId: '038-S1',
      namespace: 'project-1',
      chatId: 'chat-1',
      turnId: 'turn-1',
      turn: 1,
      promptText: payload.text,
      payload,
    });
    const identity = store.listTaskDeliveries('038-S1')[0]!.items[0]!.identity;
    unlinkSync(join(dir, 'MEMORY.md'));

    const states = await resolveFrozenStaticObjectStates({
      taskId: '038-S1',
      identities: [identity],
      store,
      extractor,
      getWorkspaceDir: () => dir,
    });

    expect(states[0]).toMatchObject({ identity, present: false, status: 'deleted', content: 'Use pnpm.' });
    store.close();
  });

  test('re-reads the complete exact study representation when constructing final O_i', async () => {
    dir = mkdtempSync(join(tmpdir(), 'static-freeze-exact-'));
    const store = new StudyMemoryStore(':memory:');
    const atom = measuredAtom('Keep the original focused rule.', 0);
    const identities = focusStaticAtoms(store, [atom]);
    const rootText = ` \r\n# Memory\r\n- ${'x'.repeat(30_000)}  \r\n`;
    writeFileSync(join(dir, 'MEMORY.md'), rootText);
    mkdirSync(join(dir, 'memory'));
    for (let index = 0; index < 21; index += 1) {
      writeFileSync(
        join(dir, 'memory', `topic-${String(index).padStart(2, '0')}.md`),
        `  final topic ${index}\r\n`,
      );
    }
    let observedPayload: StaticFocusPayload | null = null;
    const extractor: StaticMemoryExtractor = {
      extract: async (payload) => {
        observedPayload = payload;
        return {
          atomSpecVersion: MEMORY_ATOM_SPEC_VERSION,
          extractorVersion: STATIC_EXTRACTOR_VERSION,
          payloadHash: 'freeze-exact-payload',
          atoms: [atom],
          qualityFlags: [],
        };
      },
    };

    await resolveFrozenStaticObjectStates({
      taskId: '038-S1',
      identities,
      store,
      extractor,
      getWorkspaceDir: () => dir,
    });

    expect(observedPayload!.sources).toHaveLength(22);
    expect(observedPayload!.sources[0]!.injectedContent).toBe(rootText);
    expect(observedPayload!.text.slice(
      observedPayload!.sources[0]!.start,
      observedPayload!.sources[0]!.end,
    )).toBe(rootText);
    expect(observedPayload!.sources.at(-1)).toMatchObject({
      relPath: 'memory/topic-20.md',
      injectedContent: '  final topic 20\r\n',
    });
    store.close();
  });

  test('keeps one focused probe while preserving freeze-only split descendants and flags', async () => {
    dir = mkdtempSync(join(tmpdir(), 'static-freeze-split-'));
    const store = new StudyMemoryStore(':memory:');
    const identities = focusStaticAtoms(store, [measuredAtom('Use pnpm and run tests.', 0)]);

    const states = await freezeRemap(store, identities, [
      measuredAtom('Use pnpm.', 0, 0),
      measuredAtom('Run tests.', 0, 1),
    ]);
    const snapshot = store.createFreezeSnapshot({
      snapshotId: 'snapshot-split',
      taskId: '038-S1',
      frozenAt: '2026-08-15T10:10:00.000Z',
      objectStates: states,
    });

    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]).toMatchObject({
      identity: identities[0],
      object: { present: false, status: 'deleted' },
      qualityFlags: expect.arrayContaining(['static_identity_split']),
    });
    expect(snapshot.items[0]!.finalLineage).toHaveLength(2);
    expect(snapshot.items[0]!.finalLineage?.map((target) => target.descendant.content).sort()).toEqual([
      'Run tests.',
      'Use pnpm.',
    ]);
    expect(snapshot.qualityFlags).toContain('static_identity_split');
    store.close();
  });

  test('maps a freeze-only merge back to both focused probes without adding a probe', async () => {
    dir = mkdtempSync(join(tmpdir(), 'static-freeze-merge-'));
    const store = new StudyMemoryStore(':memory:');
    const identities = focusStaticAtoms(store, [
      measuredAtom('Use pnpm.', 0),
      measuredAtom('Run tests.', 1),
    ]);

    const states = await freezeRemap(store, identities, [
      measuredAtom('Use pnpm and run tests.', 0),
      measuredAtom('Use pnpm and run tests.', 1),
    ]);
    const snapshot = store.createFreezeSnapshot({
      snapshotId: 'snapshot-merge',
      taskId: '038-S1',
      frozenAt: '2026-08-15T10:10:00.000Z',
      objectStates: states,
    });

    expect(snapshot.items).toHaveLength(2);
    for (const item of snapshot.items) {
      expect(item.qualityFlags).toContain('static_identity_merge');
      expect(item.finalLineage).toHaveLength(1);
      expect(item.finalLineage?.[0]).toMatchObject({
        relation: 'merge',
        descendant: { present: true, content: 'Use pnpm and run tests.' },
      });
    }
    store.close();
  });

  test('preserves all freeze-only ambiguous descendants on the original focused probes', async () => {
    dir = mkdtempSync(join(tmpdir(), 'static-freeze-ambiguous-'));
    const store = new StudyMemoryStore(':memory:');
    const identities = focusStaticAtoms(store, [
      measuredAtom('Use pnpm.', 0),
      measuredAtom('Run tests.', 1),
    ]);

    const states = await freezeRemap(store, identities, [
      measuredAtom('Ship safely.', 0, 0),
      measuredAtom('Keep CI green.', 0, 1),
      measuredAtom('Ship safely.', 1, 0),
      measuredAtom('Keep CI green.', 1, 1),
    ]);
    const snapshot = store.createFreezeSnapshot({
      snapshotId: 'snapshot-ambiguous',
      taskId: '038-S1',
      frozenAt: '2026-08-15T10:10:00.000Z',
      objectStates: states,
    });

    expect(snapshot.items).toHaveLength(2);
    for (const item of snapshot.items) {
      expect(item.qualityFlags).toContain('static_identity_ambiguous');
      expect(item.finalLineage).toHaveLength(2);
      expect(item.finalLineage?.every((target) => target.relation === 'ambiguous')).toBe(true);
    }
    store.close();
  });
});
