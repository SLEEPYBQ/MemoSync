import { randomUUID } from 'node:crypto';
import {
  parseStudyQuestionnaireAnswer,
  parseStudyQuestionnaireAnswerV2,
  type StudyQuestionnaireAnswer,
  type StudyQuestionnaireAnswerV2,
  type StudyQuestionnaireItem,
} from '../shared/studyTasks';
import {
  getPublicStudyAttentionCheck,
  scoreStudyAttentionCheck,
  type PublicStudyAttentionCheck,
} from '../shared/studyAttentionChecks';
import { freezeQuestionnaireVersion } from './experiment/study-memory-store';
import type { ExperimentLogger } from './experiment/logger';
import type {
  FreezeObjectStateInput,
  StudyFreezeSnapshot,
  StudyMemoryIdentity,
  StudyMemoryStore,
} from './experiment/study-memory-store';
import type { MemoryItem } from './memory/types';
import type { AutoProjectCloneProvenance } from './memory';
import type { StudyRegistry } from './study-registry';
import type { StudyWorkspaceSnapshotMetadata } from './study-workspace-snapshot';
import type { StudyWorkspaceTreeState } from './study-workspace-snapshot';

export interface StudySettlementFlag {
  code: string;
  blocking: boolean;
  taskId: string;
  chatId: string;
  turnId: string;
  turn?: number;
}

export interface PublicStudyQuestionnaire {
  snapshotId: string;
  taskId: string;
  frozenAt: string;
  questionnaireVersion: 1 | 2;
  attentionCheck: PublicStudyAttentionCheck;
  items: StudyQuestionnaireItem[];
  submitted: boolean;
}

export interface StudyTaskRunEvidence {
  participantPromptCount: number;
  completedAgentTurnCount: number;
  unresolvedMemoryInterruptCount: number;
}

export type StudyCompletionRequirementCode =
  | 'participant_prompt'
  | 'completed_agent_turn'
  | 'workspace_changed'
  | 'unresolved_memory_interrupt';

export interface StudyCompletionEligibility extends StudyTaskRunEvidence {
  taskId: string;
  eligible: boolean;
  workspaceChanged: boolean;
  missing: Array<{ code: StudyCompletionRequirementCode; message: string }>;
}

export class StudyQuestionnaireError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'StudyQuestionnaireError';
  }
}

function identityKey(identity: StudyMemoryIdentity): string {
  return `${identity.scheme}\0${identity.id}`;
}

function publicQuestionnaire(snapshot: StudyFreezeSnapshot, submitted: boolean): PublicStudyQuestionnaire {
  const attentionCheck = getPublicStudyAttentionCheck(snapshot.taskId);
  if (!attentionCheck) throw new StudyQuestionnaireError(`No attention check is configured for ${snapshot.taskId}.`, 500);
  return {
    snapshotId: snapshot.snapshotId,
    taskId: snapshot.taskId,
    frozenAt: snapshot.frozenAt,
    questionnaireVersion: freezeQuestionnaireVersion(snapshot),
    attentionCheck,
    submitted,
    items: snapshot.items.map((item) => ({
      probeId: item.probeId,
      snapshotId: snapshot.snapshotId,
      cue: item.cue.content,
    })),
  };
}

export class StudyQuestionnaireService {
  private readonly store: StudyMemoryStore;
  private readonly registry: StudyRegistry;
  private readonly logger: Pick<ExperimentLogger, 'event'>;
  private readonly memoryStore: { getById(id: string): MemoryItem | undefined | null };
  private readonly getAutoProjectCloneRef: (memoryId: string) => AutoProjectCloneProvenance | null;
  private readonly studyFreezeBlocker: () => string | null;
  private readonly awaitStudyMemorySettled: (taskId: string) => Promise<StudySettlementFlag[]>;
  private readonly retireStudyTaskRuntime: (taskId: string) => Promise<void>;
  private readonly reconcileParticipantPrompts: () => void | Promise<void>;
  private readonly resolveAdditionalObjectStates: (
    taskId: string,
    identities: StudyMemoryIdentity[],
  ) => Promise<FreezeObjectStateInput[]>;
  private readonly getChatInfo?: (chatId: string) => { title?: string; projectId?: string } | undefined;
  private readonly snapshotWorkspace?: (input: {
    taskId: string;
    snapshotId: string;
    frozenAt: string;
  }) => Promise<StudyWorkspaceSnapshotMetadata>;
  private readonly captureWorkspaceState?: (taskId: string) => Promise<StudyWorkspaceTreeState>;
  private readonly getTaskRunEvidence?: (taskId: string) => StudyTaskRunEvidence | Promise<StudyTaskRunEvidence>;
  private readonly now: () => string;
  private readonly randomId: () => string;

  constructor(args: {
    store: StudyMemoryStore;
    registry: StudyRegistry;
    logger: Pick<ExperimentLogger, 'event'>;
    memoryStore: { getById(id: string): MemoryItem | undefined | null };
    getAutoProjectCloneRef?: (memoryId: string) => AutoProjectCloneProvenance | null;
    studyFreezeBlocker: () => string | null;
    awaitStudyMemorySettled: (taskId: string) => Promise<StudySettlementFlag[]>;
    retireStudyTaskRuntime?: (taskId: string) => Promise<void>;
    reconcileParticipantPrompts?: () => void | Promise<void>;
    resolveAdditionalObjectStates?: (
      taskId: string,
      identities: StudyMemoryIdentity[],
    ) => Promise<FreezeObjectStateInput[]>;
    getChatInfo?: (chatId: string) => { title?: string; projectId?: string } | undefined;
    snapshotWorkspace?: (input: {
      taskId: string;
      snapshotId: string;
      frozenAt: string;
    }) => Promise<StudyWorkspaceSnapshotMetadata>;
    captureWorkspaceState?: (taskId: string) => Promise<StudyWorkspaceTreeState>;
    getTaskRunEvidence?: (taskId: string) => StudyTaskRunEvidence | Promise<StudyTaskRunEvidence>;
    now?: () => string;
    randomId?: () => string;
  }) {
    this.store = args.store;
    this.registry = args.registry;
    this.logger = args.logger;
    this.memoryStore = args.memoryStore;
    this.getAutoProjectCloneRef = args.getAutoProjectCloneRef ?? (() => null);
    this.studyFreezeBlocker = args.studyFreezeBlocker;
    this.awaitStudyMemorySettled = args.awaitStudyMemorySettled;
    this.retireStudyTaskRuntime = args.retireStudyTaskRuntime ?? (async () => {});
    this.reconcileParticipantPrompts = args.reconcileParticipantPrompts ?? (() => {});
    this.resolveAdditionalObjectStates = args.resolveAdditionalObjectStates ?? (async () => []);
    this.getChatInfo = args.getChatInfo;
    this.snapshotWorkspace = args.snapshotWorkspace;
    this.captureWorkspaceState = args.captureWorkspaceState;
    this.getTaskRunEvidence = args.getTaskRunEvidence;
    this.now = args.now ?? (() => new Date().toISOString());
    this.randomId = args.randomId ?? randomUUID;
  }

  get(taskId: string): PublicStudyQuestionnaire {
    const snapshot = this.store.getTaskFreezeSnapshot(taskId);
    if (!snapshot) throw new StudyQuestionnaireError('End the session before loading its questionnaire.', 409);
    const submitted = this.store.getQuestionnaireSubmission(snapshot.snapshotId) !== null;
    return publicQuestionnaire(snapshot, submitted);
  }

  async ensureWorkspaceBaseline(taskId: string): Promise<void> {
    if (!this.captureWorkspaceState || this.store.getWorkspaceBaseline(taskId)) return;
    const state = await this.captureWorkspaceState(taskId);
    this.store.recordWorkspaceBaseline({
      taskId,
      capturedAt: this.now(),
      ...state,
    });
  }

  async completionEligibility(taskId: string): Promise<StudyCompletionEligibility> {
    if (!this.captureWorkspaceState || !this.getTaskRunEvidence) {
      return {
        taskId,
        eligible: true,
        participantPromptCount: 1,
        completedAgentTurnCount: 1,
        workspaceChanged: true,
        unresolvedMemoryInterruptCount: 0,
        missing: [],
      };
    }
    await this.ensureWorkspaceBaseline(taskId);
    const baseline = this.store.getWorkspaceBaseline(taskId);
    if (!baseline) throw new StudyQuestionnaireError('Could not establish the session workspace baseline.', 503);
    const [current, evidence] = await Promise.all([
      this.captureWorkspaceState(taskId),
      this.getTaskRunEvidence(taskId),
    ]);
    const workspaceChanged = current.treeHash !== baseline.treeHash
      || current.fileCount !== baseline.fileCount
      || current.totalBytes !== baseline.totalBytes;
    const missing: StudyCompletionEligibility['missing'] = [];
    if (evidence.participantPromptCount < 1) {
      missing.push({ code: 'participant_prompt', message: 'Send at least one task prompt to the agent.' });
    }
    if (evidence.completedAgentTurnCount < 1) {
      missing.push({ code: 'completed_agent_turn', message: 'Let at least one agent run finish normally.' });
    }
    if (!workspaceChanged) {
      missing.push({ code: 'workspace_changed', message: 'Make a real change to the assigned project.' });
    }
    if (evidence.unresolvedMemoryInterruptCount > 0) {
      missing.push({
        code: 'unresolved_memory_interrupt',
        message: 'Resolve the stopped memory turn with a correction and Resume.',
      });
    }
    return { taskId, eligible: missing.length === 0, workspaceChanged, ...evidence, missing };
  }

  async freeze(taskId: string): Promise<PublicStudyQuestionnaire> {
    const existing = this.store.getTaskFreezeSnapshot(taskId);
    if (existing) {
      this.registry.noteFreeze(taskId, existing.frozenAt);
      return publicQuestionnaire(
        existing,
        this.store.getQuestionnaireSubmission(existing.snapshotId) !== null,
      );
    }
    if (this.registry.taskStatus(taskId) !== 'active') {
      throw new StudyQuestionnaireError('Only the current session can be ended.', 409);
    }
    if (!this.registry.beginFreeze(taskId)) {
      if (this.registry.freezeState(taskId) === 'open' && this.registry.hasTreatmentMemoryMutation(taskId)) {
        throw new StudyQuestionnaireError('A memory change is still saving. Please wait and try again.', 409);
      }
      throw new StudyQuestionnaireError('This session is already ending. Please wait.', 409);
    }

    try {
      const blocker = this.studyFreezeBlocker();
      if (blocker) throw new StudyQuestionnaireError(blocker, 409);
      try {
        await this.reconcileParticipantPrompts();
      } catch (error) {
        throw new StudyQuestionnaireError(
          error instanceof Error
            ? `Could not preserve participant prompt evidence: ${error.message}`
            : 'Could not preserve participant prompt evidence.',
          503,
        );
      }
      const eligibility = await this.completionEligibility(taskId);
      if (!eligibility.eligible) {
        throw new StudyQuestionnaireError(eligibility.missing.map((item) => item.message).join(' '), 409);
      }
      const settlementFlags = await this.awaitStudyMemorySettled(taskId);
      const blocking = settlementFlags.filter((flag) => flag.blocking);
      if (blocking.length) {
        throw new StudyQuestionnaireError(
          'The injected-memory record is incomplete. Please retry or let the experimenter know.',
          503,
        );
      }

      // Quiesce invisible Claude continuations and their preview descendants
      // before the immutable workspace snapshot is taken.
      await this.retireStudyTaskRuntime(taskId);

      const identities = this.focusedIdentities(taskId);
      const objectStates: FreezeObjectStateInput[] = [];
      for (const identity of identities) {
        if (identity.scheme !== 'store') continue;
        const memory = this.memoryStore.getById(identity.id);
        const cloneRef = memory ? this.getAutoProjectCloneRef(memory.id) : null;
        objectStates.push(memory
          ? {
              identity,
              present: memory.status === 'active',
              status: memory.status,
              version: memory.version,
              content: memory.content,
              scope: memory.scope,
              sourceRef: {
                kind: 'store_freeze',
                memoryId: memory.id,
                storeVersion: memory.version,
                projectId: memory.projectId ?? null,
                sessionId: memory.sessionId ?? null,
                ...(cloneRef ?? {}),
              },
            }
          : {
              identity,
              present: false,
              status: 'deleted',
            });
      }
      objectStates.push(...await this.resolveAdditionalObjectStates(taskId, identities));

      const covered = new Set(objectStates.map((state) => identityKey(state.identity)));
      const missing = identities.filter((identity) => !covered.has(identityKey(identity)));
      if (missing.length) {
        throw new StudyQuestionnaireError(
          `Could not freeze final memory state for ${missing.length} injected item(s).`,
          503,
        );
      }

      const frozenAt = this.now();
      const snapshotId = this.randomId();
      let workspaceSnapshot: StudyWorkspaceSnapshotMetadata | undefined;
      if (this.snapshotWorkspace) {
        try {
          workspaceSnapshot = await this.snapshotWorkspace({ taskId, snapshotId, frozenAt });
        } catch (error) {
          throw new StudyQuestionnaireError(
            error instanceof Error
              ? `Could not preserve the project source for scoring: ${error.message}`
              : 'Could not preserve the project source for scoring.',
            503,
          );
        }
      }
      const snapshot = this.store.createFreezeSnapshot({
        snapshotId,
        taskId,
        frozenAt,
        qualityFlags: settlementFlags.map((flag) => `${flag.code}:${flag.chatId}:${flag.turnId}`),
        objectStates,
        workspaceSnapshot,
      });
      this.logger.event({
        type: 'study.freeze',
        taskId,
        snapshotId: snapshot.snapshotId,
        qualityFlags: snapshot.qualityFlags,
        ...(snapshot.workspaceSnapshot
          ? {
              workspaceSnapshotPath: snapshot.workspaceSnapshot.exportedPath,
              workspaceTreeHash: snapshot.workspaceSnapshot.treeHash,
            }
          : {}),
      });
      this.registry.noteFreeze(taskId, snapshot.frozenAt);
      return publicQuestionnaire(snapshot, false);
    } catch (error) {
      this.registry.cancelFreeze(taskId);
      throw error;
    }
  }

  submit(input: {
    taskId: string;
    snapshotId: string;
    answers: unknown;
    attentionCheck: unknown;
  }): { recorded: number; created: boolean; submissionId: string } {
    const snapshot = this.store.getTaskFreezeSnapshot(input.taskId);
    if (!snapshot) throw new StudyQuestionnaireError('End the session before submitting its questionnaire.', 409);
    if (snapshot.snapshotId !== input.snapshotId) {
      throw new StudyQuestionnaireError('This questionnaire snapshot is stale. Reload the questions.', 409);
    }
    if (!Array.isArray(input.answers)) throw new StudyQuestionnaireError('answers must be an array', 400);
    const attentionCheck = scoreStudyAttentionCheck(input.taskId, input.attentionCheck);
    if (!attentionCheck) throw new StudyQuestionnaireError('A valid attention-check response is required.', 400);
    // The immutable snapshot decides which questionnaire instrument its
    // answers must use. The two encodings are never cross-parsed: a v1
    // categorical answer cannot land on a v2 snapshot, and vice versa.
    const questionnaireVersion = freezeQuestionnaireVersion(snapshot);
    const answers: Array<StudyQuestionnaireAnswer | StudyQuestionnaireAnswerV2> = [];
    for (const raw of input.answers) {
      const answer = questionnaireVersion === 2
        ? parseStudyQuestionnaireAnswerV2(raw)
        : parseStudyQuestionnaireAnswer(raw);
      if (!answer || answer.snapshotId !== snapshot.snapshotId) {
        throw new StudyQuestionnaireError('malformed answer', 400);
      }
      answers.push(answer);
    }
    const expected = new Set(snapshot.items.map((item) => item.probeId));
    const received = new Set(answers.map((answer) => answer.probeId));
    if (
      received.size !== answers.length
      || received.size !== expected.size
      || [...expected].some((probeId) => !received.has(probeId))
    ) {
      throw new StudyQuestionnaireError('Every frozen questionnaire item must be answered exactly once.', 400);
    }

    const submittedAt = this.now();
    let result;
    try {
      result = this.store.recordQuestionnaireSubmission({
        submissionId: this.randomId(),
        snapshotId: snapshot.snapshotId,
        submittedAt,
        questionnaireVersion,
        answers,
        attentionCheck,
      });
    } catch (error) {
      throw new StudyQuestionnaireError(
        error instanceof Error ? error.message : 'Questionnaire submission failed.',
        409,
      );
    }

    if (result.created) {
      const itemsByProbe = new Map(snapshot.items.map((item) => [item.probeId, item]));
      for (const answer of answers) {
        const item = itemsByProbe.get(answer.probeId)!;
        this.logger.event({
          type: 'quiz.answer',
          schemaVersion: 2,
          questionnaireVersion,
          taskId: input.taskId,
          snapshotId: snapshot.snapshotId,
          probeId: answer.probeId,
          cue: item.cue.content,
          desired: answer.desired,
          assessed: answer.assessed,
          execution: answer.execution,
          object: { ...item.object },
          ...(item.qualityFlags.length ? { qualityFlags: [...item.qualityFlags] } : {}),
          ...(item.finalLineage?.length ? { finalLineage: item.finalLineage } : {}),
          // v2 removed not_intended: D_i is always present, so Control
          // Accuracy is never made N/A by the desired branch.
          controlApplicable: 'kind' in answer.desired ? answer.desired.kind !== 'not_intended' : true,
        });
      }
      const chatIds = [...new Set(snapshot.items.flatMap((item) => item.history.map((entry) => entry.chatId)))];
      this.logger.event({
        type: 'quiz.submit',
        taskId: input.taskId,
        snapshotId: snapshot.snapshotId,
        submissionId: result.submission.submissionId,
        items: answers.length,
        attentionCheck,
        chats: chatIds.map((chatId) => ({ chatId, ...this.getChatInfo?.(chatId) })),
      });
    }
    return {
      recorded: answers.length,
      created: result.created,
      submissionId: result.submission.submissionId,
    };
  }

  unfreeze(taskId: string): void {
    const snapshot = this.store.getTaskFreezeSnapshot(taskId);
    if (!snapshot || this.registry.taskStatus(taskId) !== 'active') {
      throw new StudyQuestionnaireError("This task's session is not currently ended.", 409);
    }
    if (this.store.getQuestionnaireSubmission(snapshot.snapshotId)) {
      throw new StudyQuestionnaireError('A submitted questionnaire cannot be reopened.', 409);
    }
    if (!this.store.removeTaskFreezeSnapshot(taskId)) {
      throw new StudyQuestionnaireError('Could not reopen the session.', 409);
    }
    this.registry.noteUnfreeze(taskId);
    this.logger.event({ type: 'study.unfreeze', taskId });
  }

  private focusedIdentities(taskId: string): StudyMemoryIdentity[] {
    const identities = new Map<string, StudyMemoryIdentity>();
    for (const delivery of this.store.listTaskDeliveries(taskId)) {
      if (delivery.outcome !== 'delivered') continue;
      for (const item of delivery.items) {
        if (!item.actualFocus) continue;
        identities.set(identityKey(item.identity), item.identity);
      }
    }
    return [...identities.values()];
  }
}
