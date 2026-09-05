import { getStudyTask } from "../../shared/studyTasks"
import type { StudyWorkspaceSnapshotMetadata } from "../study-workspace-snapshot"
import type {
  BaselineProjectCopyCondition,
  BaselineProjectCopyTransition,
  StudyMemoryStore,
} from "./study-memory-store"

export interface BaselineProjectCopySourceFreezeRef {
  taskId: string
  snapshotId: string
  frozenAt: string
  workspaceSnapshot?: StudyWorkspaceSnapshotMetadata
}

export interface BaselineProjectCopyPrepared {
  sourceRepresentationHash: string
  targetRepresentationHash: string
  /** Adapter-owned, JSON-safe evidence such as file manifests or identity clones. */
  manifest: Record<string, unknown>
}

export interface BaselineProjectCopyAdapter {
  readonly condition: BaselineProjectCopyCondition
  prepare(input: {
    transitionKey: string
    fromTaskId: string
    fromProjectSlug: string
    toTaskId: string
    toProjectSlug: string
    sourceFreezeRef: BaselineProjectCopySourceFreezeRef
  }): Promise<BaselineProjectCopyPrepared>
}

export interface NextSessionPreparationInput {
  fromTaskId: string
  toTaskId: string
  sourceFreezeRef: BaselineProjectCopySourceFreezeRef
}

export interface NextSessionPreparer {
  prepareNextSession(input: NextSessionPreparationInput): Promise<BaselineProjectCopyTransition | null>
}

/**
 * The shared durable seam between post-session completion and condition-owned
 * Baseline Project Copy implementations. The adapter performs the treatment
 * copy; this coordinator records when that copy is safe to unlock exactly once.
 */
export class BaselineProjectCopyCoordinator implements NextSessionPreparer {
  private readonly store: StudyMemoryStore
  private readonly adapter: BaselineProjectCopyAdapter
  private readonly now: () => string
  private readonly inFlight = new Map<string, Promise<BaselineProjectCopyTransition>>()

  constructor(args: {
    store: StudyMemoryStore
    adapter: BaselineProjectCopyAdapter
    now?: () => string
  }) {
    this.store = args.store
    this.adapter = args.adapter
    this.now = args.now ?? (() => new Date().toISOString())
  }

  async prepareNextSession(
    input: NextSessionPreparationInput,
  ): Promise<BaselineProjectCopyTransition | null> {
    const fromTask = getStudyTask(input.fromTaskId)
    const toTask = getStudyTask(input.toTaskId)
    if (!fromTask || !toTask) {
      throw new Error(`Unknown study task in next-session transition ${input.fromTaskId} -> ${input.toTaskId}`)
    }
    if (input.sourceFreezeRef.taskId !== input.fromTaskId) {
      throw new Error(`Source freeze does not belong to task ${input.fromTaskId}`)
    }
    if (fromTask.projectSlug === toTask.projectSlug) return null

    const persistedFreeze = this.store.getFreezeSnapshot(input.sourceFreezeRef.snapshotId)
    if (
      !persistedFreeze
      || persistedFreeze.taskId !== input.fromTaskId
      || persistedFreeze.frozenAt !== input.sourceFreezeRef.frozenAt
    ) {
      throw new Error(`Source freeze is stale for baseline project copy ${input.fromTaskId}`)
    }
    const sourceFreezeRef: BaselineProjectCopySourceFreezeRef = {
      taskId: persistedFreeze.taskId,
      snapshotId: persistedFreeze.snapshotId,
      frozenAt: persistedFreeze.frozenAt,
      ...(persistedFreeze.workspaceSnapshot ? { workspaceSnapshot: persistedFreeze.workspaceSnapshot } : {}),
    }

    const transitionKey = `${input.sourceFreezeRef.snapshotId}:${input.fromTaskId}->${input.toTaskId}`
    const receipt = this.store.beginBaselineProjectCopyTransition({
      fromTaskId: input.fromTaskId,
      toTaskId: input.toTaskId,
      condition: this.adapter.condition,
      sourceSnapshotId: input.sourceFreezeRef.snapshotId,
      sourceFrozenAt: input.sourceFreezeRef.frozenAt,
      startedAt: this.now(),
    })
    if (receipt.status === "ready") return receipt

    const running = this.inFlight.get(transitionKey)
    if (running) return running
    const preparation = this.prepareAdapter({
      transitionKey,
      fromTaskId: input.fromTaskId,
      fromProjectSlug: fromTask.projectSlug,
      toTaskId: input.toTaskId,
      toProjectSlug: toTask.projectSlug,
      sourceFreezeRef,
    })
    this.inFlight.set(transitionKey, preparation)
    try {
      return await preparation
    } finally {
      if (this.inFlight.get(transitionKey) === preparation) this.inFlight.delete(transitionKey)
    }
  }

  private async prepareAdapter(
    input: Parameters<BaselineProjectCopyAdapter["prepare"]>[0],
  ): Promise<BaselineProjectCopyTransition> {
    const result = await this.adapter.prepare(input)
    if (result.sourceRepresentationHash !== result.targetRepresentationHash) {
      throw new Error(
        `Baseline project destination is not an exact copy for ${input.fromTaskId} -> ${input.toTaskId}`,
      )
    }
    return this.store.completeBaselineProjectCopyTransition({
      fromTaskId: input.fromTaskId,
      toTaskId: input.toTaskId,
      preparedAt: this.now(),
      sourceRepresentationHash: result.sourceRepresentationHash,
      targetRepresentationHash: result.targetRepresentationHash,
      manifest: result.manifest,
    })
  }
}
