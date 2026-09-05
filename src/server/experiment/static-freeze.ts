import {
  buildStudyStaticFocusPayload,
  readStudyStaticMemoryFiles,
} from '../memory/static-files';
import type { StaticMemoryExtractor } from './static-memory-extractor';
import type {
  FreezeObjectStateInput,
  FrozenStaticLineageTarget,
  StudyMemoryIdentity,
  StudyMemoryStore,
} from './study-memory-store';

function identityKey(identity: StudyMemoryIdentity): string {
  return `${identity.scheme}\0${identity.id}`;
}

/**
 * Re-read Static Markdown only at the freeze checkpoint to construct final
 * O_i. This materialization updates hidden identity state but deliberately
 * does not create an Injection Occurrence.
 */
export async function resolveFrozenStaticObjectStates(args: {
  taskId: string;
  identities: readonly StudyMemoryIdentity[];
  store: Pick<
    StudyMemoryStore,
    'listTaskDeliveries' | 'resolveStaticAtoms' | 'getStaticObjectStates'
  >;
  extractor: StaticMemoryExtractor;
  getWorkspaceDir(namespace: string): string | null | undefined;
  now?: () => string;
}): Promise<FreezeObjectStateInput[]> {
  const requested = args.identities.filter((identity) => identity.scheme === 'static');
  if (requested.length === 0) return [];
  const requestedKeys = new Set(requested.map(identityKey));
  const namespaceByIdentity = new Map<string, string>();
  for (const delivery of args.store.listTaskDeliveries(args.taskId)) {
    for (const item of delivery.items) {
      const key = identityKey(item.identity);
      if (!requestedKeys.has(key)) continue;
      const namespace = item.sourceRef.namespace;
      if (typeof namespace !== 'string' || !namespace) continue;
      const existing = namespaceByIdentity.get(key);
      if (existing && existing !== namespace) {
        throw new Error(`Static identity ${item.identity.id} has conflicting namespaces`);
      }
      namespaceByIdentity.set(key, namespace);
    }
  }
  const missingNamespace = requested.filter((identity) => !namespaceByIdentity.has(identityKey(identity)));
  if (missingNamespace.length) {
    throw new Error(`Missing Static source namespace for ${missingNamespace.length} focused item(s)`);
  }

  const identitiesByNamespace = new Map<string, StudyMemoryIdentity[]>();
  for (const identity of requested) {
    const namespace = namespaceByIdentity.get(identityKey(identity))!;
    const group = identitiesByNamespace.get(namespace) ?? [];
    group.push(identity);
    identitiesByNamespace.set(namespace, group);
  }

  const states: FreezeObjectStateInput[] = [];
  for (const [namespace, identities] of identitiesByNamespace) {
    const workspaceDir = args.getWorkspaceDir(namespace);
    if (!workspaceDir) throw new Error(`Static workspace is unavailable for ${namespace}`);
    const payload = buildStudyStaticFocusPayload(readStudyStaticMemoryFiles(workspaceDir));
    const extraction = await args.extractor.extract(payload);
    const resolution = args.store.resolveStaticAtoms({
      namespace,
      snapshotHash: extraction.payloadHash,
      observedAt: (args.now ?? (() => new Date().toISOString()))(),
      atoms: extraction.atoms.map((atom) => ({
        content: atom.content,
        contentHash: atom.contentHash,
        sourceRef: atom.sourceRef,
        qualityFlags: atom.qualityFlags,
      })),
    });
    const requestedInNamespace = new Set(identities.map(identityKey));
    const lineageByAncestor = new Map<string, FrozenStaticLineageTarget[]>()
    for (const atom of resolution.atoms) {
      const lineage = atom.sourceRef.lineage
      if (!lineage) continue
      const target: FrozenStaticLineageTarget = {
        relation: lineage.relation,
        descendant: {
          identity: atom.identity,
          present: true,
          status: 'active',
          version: atom.version,
          content: atom.content,
          contentHash: atom.contentHash,
          stateHash: atom.stateHash,
          scope: atom.scope,
          sourceRef: atom.sourceRef,
        },
        qualityFlags: [...atom.qualityFlags],
      }
      for (const ancestor of lineage.ancestors) {
        const key = identityKey(ancestor)
        if (!requestedInNamespace.has(key)) continue
        const targets = lineageByAncestor.get(key) ?? []
        if (!targets.some((candidate) => (
          candidate.relation === target.relation
          && identityKey(candidate.descendant.identity) === identityKey(target.descendant.identity)
        ))) targets.push(target)
        lineageByAncestor.set(key, targets)
      }
    }
    states.push(...args.store.getStaticObjectStates(namespace, identities).map((state) => {
      const finalLineage = lineageByAncestor.get(identityKey(state.identity)) ?? []
      if (finalLineage.length === 0) return state
      finalLineage.sort((left, right) => (
        identityKey(left.descendant.identity).localeCompare(identityKey(right.descendant.identity))
      ))
      return {
        ...state,
        qualityFlags: [...new Set([
          ...(state.qualityFlags ?? []),
          ...finalLineage.flatMap((target) => target.qualityFlags),
        ])],
        finalLineage,
      }
    }));
  }

  const resolved = new Set(states.map((state) => identityKey(state.identity)));
  const missingState = requested.filter((identity) => !resolved.has(identityKey(identity)));
  if (missingState.length) {
    throw new Error(`Missing final Static object state for ${missingState.length} focused item(s)`);
  }
  return states;
}
