import { createHash } from 'node:crypto';
import type { MemoryService } from './index';
import { buildPlainMemoryBlock } from './prompt';
import {
  autoProjectSummaryItemsHash,
  autoProjectSummaryKey,
  buildCanonicalAutoProjectSummary,
  type AutoProjectSummaryProjection,
} from './summary';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export interface AutoProjectCloneRef {
  targetMemoryId: string;
  cloneOf: {
    memoryId: string;
    version: number;
    contentHash: string;
  };
}

export interface AutoProjectCopyReceipt {
  created: boolean;
  transitionKey: string;
  sourceTaskId: string;
  targetTaskId: string;
  sourceProjectId: string;
  targetProjectId: string;
  sourceRepresentationHash: string;
  targetRepresentationHash: string;
  copiedAt: string;
  clones: AutoProjectCloneRef[];
}

export interface AutoProjectCopyInput {
  transitionKey: string;
  sourceTaskId: string;
  targetTaskId: string;
  sourceProjectId: string;
  targetProjectId: string;
}

interface ReceiptRow {
  transition_key: string;
  source_task_id: string;
  target_task_id: string;
  source_project_id: string;
  target_project_id: string;
  source_representation_hash: string;
  target_representation_hash: string;
  copied_at: string;
}

interface LineageRow {
  target_memory_id: string;
  source_memory_id: string;
  source_version: number;
  source_content_hash: string;
}

export interface AutoProjectCopyService {
  copyOnce(input: AutoProjectCopyInput): AutoProjectCopyReceipt;
  getReceipt(transitionKey: string): AutoProjectCopyReceipt | null;
  getCloneRef(targetMemoryId: string): AutoProjectCloneRef['cloneOf'] | null;
}

export function createAutoProjectCopyService(opts: { memory: MemoryService }): AutoProjectCopyService {
  const { memory } = opts;

  const hydrate = (row: ReceiptRow, created: boolean): AutoProjectCopyReceipt => {
    const lineage = memory.db.query(`
      SELECT target_memory_id, source_memory_id, source_version, source_content_hash
        FROM auto_project_copy_lineage
       WHERE transition_key = ?
       ORDER BY ordinal ASC
    `).all(row.transition_key) as LineageRow[];
    return {
      created,
      transitionKey: row.transition_key,
      sourceTaskId: row.source_task_id,
      targetTaskId: row.target_task_id,
      sourceProjectId: row.source_project_id,
      targetProjectId: row.target_project_id,
      sourceRepresentationHash: row.source_representation_hash,
      targetRepresentationHash: row.target_representation_hash,
      copiedAt: row.copied_at,
      clones: lineage.map((entry) => ({
        targetMemoryId: entry.target_memory_id,
        cloneOf: {
          memoryId: entry.source_memory_id,
          version: entry.source_version,
          contentHash: entry.source_content_hash,
        },
      })),
    };
  };

  const receiptByTransition = (transitionKey: string, created = false): AutoProjectCopyReceipt | null => {
    const row = memory.db.query(`
      SELECT * FROM auto_project_copy_receipts WHERE transition_key = ?
    `).get(transitionKey) as ReceiptRow | null;
    return row ? hydrate(row, created) : null;
  };

  const assertSameTransition = (receipt: AutoProjectCopyReceipt, input: AutoProjectCopyInput) => {
    if (
      receipt.sourceTaskId !== input.sourceTaskId
      || receipt.targetTaskId !== input.targetTaskId
      || receipt.sourceProjectId !== input.sourceProjectId
      || receipt.targetProjectId !== input.targetProjectId
    ) {
      throw new Error(`Auto Project Copy transition ${input.transitionKey} already exists with different endpoints`);
    }
  };

  return {
    getReceipt: receiptByTransition,

    getCloneRef(targetMemoryId: string) {
      const row = memory.db.query(`
        SELECT source_memory_id, source_version, source_content_hash
          FROM auto_project_copy_lineage
         WHERE target_memory_id = ?
      `).get(targetMemoryId) as Omit<LineageRow, 'target_memory_id'> | null;
      return row
        ? { memoryId: row.source_memory_id, version: row.source_version, contentHash: row.source_content_hash }
        : null;
    },

    copyOnce(input: AutoProjectCopyInput): AutoProjectCopyReceipt {
      if (input.sourceProjectId === input.targetProjectId) {
        throw new Error('Auto Project Copy transition requires distinct projects');
      }
      const existing = receiptByTransition(input.transitionKey);
      if (existing) {
        assertSameTransition(existing, input);
        return existing;
      }
      const occupiedTarget = memory.db.query(`
        SELECT transition_key FROM auto_project_copy_receipts WHERE target_project_id = ?
      `).get(input.targetProjectId) as { transition_key: string } | null;
      if (occupiedTarget) {
        throw new Error(`Auto Project Copy target ${input.targetProjectId} was already initialized by ${occupiedTarget.transition_key}`);
      }

      const run = memory.db.transaction(() => {
        const raced = receiptByTransition(input.transitionKey);
        if (raced) {
          assertSameTransition(raced, input);
          return raced;
        }
        const destinationRows = memory.store.list({ scope: 'project', projectId: input.targetProjectId });
        if (destinationRows.length > 0) {
          throw new Error(`Auto Project Copy target ${input.targetProjectId} is not empty; refusing to merge`);
        }

        const source = memory.autoProjectMemories(input.sourceProjectId);
        const sourceBlock = buildPlainMemoryBlock(source);
        const sourceRepresentationHash = sha256(sourceBlock);
        const copiedAt = new Date().toISOString();
        const sourceSummaryItemsHash = autoProjectSummaryItemsHash(source);
        const storedSourceSummary = memory.store.getKv<AutoProjectSummaryProjection>(
          autoProjectSummaryKey(input.sourceProjectId),
        );
        const sourceSummary = storedSourceSummary?.itemsHash === sourceSummaryItemsHash
          ? storedSourceSummary
          : {
              text: buildCanonicalAutoProjectSummary(source),
              updatedAt: copiedAt,
              itemsHash: sourceSummaryItemsHash,
            };
        if (sourceSummary !== storedSourceSummary) {
          memory.store.setKv(autoProjectSummaryKey(input.sourceProjectId), sourceSummary);
        }
        const clones = source.map((item) => memory.store.create(
          {
            content: item.content,
            detail: item.detail,
            abstractionLevel: item.abstractionLevel,
            sensitive: item.sensitive,
            scope: 'project',
            type: item.type,
            status: 'active',
            projectId: input.targetProjectId,
            topic: item.topic,
            evidenceClass: item.evidenceClass,
          },
          { actor: 'system' },
        ));
        const targetBlock = buildPlainMemoryBlock(clones);
        const targetRepresentationHash = sha256(targetBlock);
        if (targetBlock !== sourceBlock || targetRepresentationHash !== sourceRepresentationHash) {
          throw new Error('Auto Project Copy clone did not preserve the rendered representation');
        }

        memory.db.query(`
          INSERT INTO auto_project_copy_receipts (
            transition_key, source_task_id, target_task_id,
            source_project_id, target_project_id,
            source_representation_hash, target_representation_hash, copied_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.transitionKey,
          input.sourceTaskId,
          input.targetTaskId,
          input.sourceProjectId,
          input.targetProjectId,
          sourceRepresentationHash,
          targetRepresentationHash,
          copiedAt,
        );
        const insertLineage = memory.db.query(`
          INSERT INTO auto_project_copy_lineage (
            transition_key, ordinal, target_memory_id,
            source_memory_id, source_version, source_content_hash
          ) VALUES (?, ?, ?, ?, ?, ?)
        `);
        source.forEach((item, ordinal) => {
          insertLineage.run(
            input.transitionKey,
            ordinal,
            clones[ordinal]!.id,
            item.id,
            item.version,
            sha256(item.content),
          );
        });
        memory.store.setKv(autoProjectSummaryKey(input.targetProjectId), {
          ...sourceSummary,
          itemsHash: autoProjectSummaryItemsHash(clones),
        });
        return receiptByTransition(input.transitionKey, true)!;
      });

      const receipt = run();
      memory.syncProjection(input.targetProjectId);
      return receipt;
    },
  };
}
