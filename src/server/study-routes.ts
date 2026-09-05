// Participant-facing study shell routes. Memory focus, freeze snapshots, and
// questionnaire submissions are delegated to StudyQuestionnaireService so
// HTTP handlers never infer a DV from JSONL or re-read a live memory store.
import { getStudyTask, STUDY_BRIEF_VERSION, STUDY_GUIDE_VERSION } from '../shared/studyTasks';
import { STUDY_BRIEFS } from './study-briefs';
import type { StudyQuestionnaireService } from './study-questionnaire-service';
import { StudyQuestionnaireError } from './study-questionnaire-service';
import type { StudyRegistry } from './study-registry';
import type { StudySurveyService } from './study-survey-service';
import { StudySurveyError } from './study-survey-service';
import { StudyOnboardingError, type StudyOnboardingService } from './study-onboarding';
import { briefReceiptKey, guideReceiptKey } from './study-ui-receipts';
import { StudyTelemetryError, type StudyTelemetryService } from './study-telemetry';

export interface StudyRouteDeps {
  registry: StudyRegistry;
  questionnaire: StudyQuestionnaireService | null;
  survey: StudySurveyService | null;
  /** Durable pre-guide intake. Absent only on an invalid/non-participant study runtime. */
  onboarding: StudyOnboardingService | null;
  /** Authoritative participant interaction/timing sink. */
  telemetry?: StudyTelemetryService | null;
  /** STUDY_ADMIN_KEY env — enables the experimenter's unfreeze endpoint. */
  adminKey?: string;
  instructionGuard?: {
    recordUiAttempt: (attempt: {
      taskId: string;
      action: 'copy' | 'cut' | 'contextmenu' | 'selectstart' | 'dragstart' | 'keyboard_copy' | 'devtools_shortcut';
      surface: 'task_page' | 'task_dialog';
    }) => void;
  };
  uiReceipts?: {
    has: (key: string) => boolean;
    record: (key: string) => void;
  };
  assignedProject?: (taskId: string) => { projectId: string; starterReady: boolean } | null;
}

function ok(data: unknown, status = 200): Response {
  return Response.json({ data }, { status });
}

function bad(status: number, message: string): Response {
  return Response.json({ error: { message } }, { status });
}

async function bodyRecord(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await req.json();
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function serviceError(error: unknown): Response {
  if (error instanceof StudyQuestionnaireError) return bad(error.status, error.message);
  if (error instanceof StudySurveyError) return bad(error.status, error.message);
  if (error instanceof StudyOnboardingError) return bad(error.status, error.message);
  if (error instanceof StudyTelemetryError) return bad(error.status, error.message);
  return bad(500, error instanceof Error ? error.message : 'Study questionnaire failed.');
}

function studySessionAdmission(deps: StudyRouteDeps): Response | null {
  if (!deps.onboarding) return bad(503, 'Study onboarding is unavailable for this participant instance.');
  if (!deps.onboarding.isBriefingComplete()) {
    return bad(409, 'Complete the study briefing before opening a study session.');
  }
  if (!deps.uiReceipts?.has(guideReceiptKey())) {
    return bad(409, 'Complete the current study guide before opening a study session.');
  }
  return null;
}

export async function handleStudyRequest(
  req: Request,
  url: URL,
  deps: StudyRouteDeps,
): Promise<Response | null> {
  const { pathname } = url;
  if (!pathname.startsWith('/api/study/')) return null;
  const { registry, questionnaire } = deps;

  // A null telemetry service is a PERMANENT property of this deployment
  // (non-study boot), not a transient outage — answer 404, not 503. The
  // client outbox acknowledges-and-drops 4xx but retries 5xx forever, so a
  // 503 here wedged the whole durable telemetry queue head-of-line the first
  // time a normal-mode Files-panel edit touched a memory markdown file.
  if (pathname === '/api/study/telemetry' && req.method === 'POST') {
    if (!deps.telemetry) return bad(404, 'Study telemetry does not exist in this deployment.');
    const body = await bodyRecord(req);
    try {
      return ok(deps.telemetry.recordClient(body));
    } catch (error) {
      return serviceError(error);
    }
  }

  if (pathname === '/api/study/static-edit-entered' && req.method === 'POST') {
    if (!deps.telemetry) return bad(404, 'Study telemetry does not exist in this deployment.');
    const body = await bodyRecord(req);
    try {
      return ok(deps.telemetry.recordStaticEditEntered(body));
    } catch (error) {
      return serviceError(error);
    }
  }

  if (pathname === '/api/study/onboarding' && req.method === 'GET') {
    if (!deps.onboarding) return bad(503, 'Study onboarding is unavailable for this participant instance.');
    try {
      const status = deps.onboarding.status();
      if (status.stage === 'information') deps.telemetry?.recordServerStageEntered('information');
      return ok(status);
    } catch (error) {
      return serviceError(error);
    }
  }

  if (pathname === '/api/study/onboarding/information' && req.method === 'PUT') {
    if (!deps.onboarding) return bad(503, 'Study onboarding is unavailable for this participant instance.');
    const body = await bodyRecord(req);
    // Allocation identity is server-owned. It must never be accepted from a
    // participant browser, even if it happens to match the current instance.
    if (!body || 'participantId' in body || 'participant_id' in body) {
      return bad(400, 'participant identity is assigned by the study server');
    }
    try {
      return ok(deps.onboarding.saveInformation(body));
    } catch (error) {
      return serviceError(error);
    }
  }

  if (pathname === '/api/study/onboarding/consent' && req.method === 'POST') {
    if (!deps.onboarding) return bad(503, 'Study onboarding is unavailable for this participant instance.');
    const body = await bodyRecord(req);
    if (!body || body.consented !== true || Object.keys(body).some((key) => key !== 'consented')) {
      return bad(400, 'explicit consent is required');
    }
    try {
      return ok(deps.onboarding.recordConsent());
    } catch (error) {
      return serviceError(error);
    }
  }

  if (pathname === '/api/study/onboarding/briefing' && req.method === 'POST') {
    if (!deps.onboarding) return bad(503, 'Study onboarding is unavailable for this participant instance.');
    const body = await bodyRecord(req);
    if (!body || Object.keys(body).length !== 0) return bad(400, 'briefing does not accept a request payload');
    try {
      return ok(deps.onboarding.recordBriefing());
    } catch (error) {
      return serviceError(error);
    }
  }

  if (pathname === '/api/study/progress' && req.method === 'GET') {
    const refused = studySessionAdmission(deps);
    if (refused) return refused;
    return ok({
      tasks: registry.progress(),
      activeTaskId: registry.activeTaskId(),
      questionnairePending: registry.questionnairePending(),
      postSessionPending: registry.postSessionPending(),
      susPending: registry.susPending(),
      studyComplete: registry.studyComplete(),
      freezeState: registry.activeTaskId() ? registry.freezeState(registry.activeTaskId()!) : null,
    });
  }

  if (pathname === '/api/study/guide-status' && req.method === 'GET') {
    if (!deps.uiReceipts) return bad(503, 'Study guide state is unavailable.');
    return ok({ version: STUDY_GUIDE_VERSION, completed: deps.uiReceipts.has(guideReceiptKey()) });
  }

  if (pathname === '/api/study/guide-complete' && req.method === 'POST') {
    if (!deps.onboarding) return bad(503, 'Study onboarding is unavailable for this participant instance.');
    if (!deps.onboarding.isBriefingComplete()) {
      return bad(409, 'Complete the study briefing before completing the Guide.');
    }
    if (!deps.uiReceipts) return bad(503, 'Study guide state is unavailable.');
    deps.uiReceipts.record(guideReceiptKey());
    return ok({ version: STUDY_GUIDE_VERSION, completed: true });
  }

  if (pathname === '/api/study/instruction-guard-event' && req.method === 'POST') {
    const refused = studySessionAdmission(deps);
    if (refused) return refused;
    const taskId = registry.activeTaskId();
    if (!taskId) return bad(409, 'There is no active study session.');
    if (!deps.instructionGuard) return bad(503, 'Instruction protection is unavailable.');
    const body = await bodyRecord(req);
    const actions = new Set(['copy', 'cut', 'contextmenu', 'selectstart', 'dragstart', 'keyboard_copy', 'devtools_shortcut']);
    const surfaces = new Set(['task_page', 'task_dialog']);
    if (!body || typeof body.action !== 'string' || !actions.has(body.action) || typeof body.surface !== 'string' || !surfaces.has(body.surface)) {
      return bad(400, 'invalid instruction-guard event');
    }
    deps.instructionGuard.recordUiAttempt({
      taskId,
      action: body.action as 'copy' | 'cut' | 'contextmenu' | 'selectstart' | 'dragstart' | 'keyboard_copy' | 'devtools_shortcut',
      surface: body.surface as 'task_page' | 'task_dialog',
    });
    return ok({ recorded: true });
  }

  const taskMatch = pathname.match(/^\/api\/study\/task\/([^/]+)$/);
  if (taskMatch && req.method === 'GET') {
    const refused = studySessionAdmission(deps);
    if (refused) return refused;
    const taskId = decodeURIComponent(taskMatch[1]!);
    const task = getStudyTask(taskId);
    const brief = STUDY_BRIEFS[taskId];
    if (!task || !brief) return bad(404, 'unknown task');
    const status = registry.taskStatus(taskId);
    if (status === 'locked') return bad(403, 'This session is not available yet.');
    const assignedProject = deps.assignedProject?.(task.id) ?? null;
    if (registry.activeTaskId() === task.id) {
      try {
        await questionnaire?.ensureWorkspaceBaseline(task.id);
        deps.telemetry?.recordServerStageEntered('session_exposure', task.id);
      } catch (error) {
        return serviceError(error);
      }
    }
    return ok({
      id: task.id,
      title: task.title,
      status,
      brief,
      projectSlug: task.projectSlug,
      projectTitle: task.projectTitle,
      projectId: assignedProject?.projectId ?? null,
      starterReady: assignedProject?.starterReady ?? false,
      briefVersion: STUDY_BRIEF_VERSION,
      briefAcknowledged: deps.uiReceipts?.has(briefReceiptKey(task.id)) ?? false,
    });
  }

  if (pathname === '/api/study/completion-eligibility' && req.method === 'GET') {
    const refused = studySessionAdmission(deps);
    if (refused) return refused;
    const taskId = url.searchParams.get('taskId');
    if (!taskId || !getStudyTask(taskId)) return bad(400, 'taskId is required');
    if (registry.taskStatus(taskId) !== 'active') return bad(409, 'Only the current session has a Finish gate.');
    if (!questionnaire) return bad(503, 'Study measurement is unavailable.');
    try {
      return ok(await questionnaire.completionEligibility(taskId));
    } catch (error) {
      return serviceError(error);
    }
  }

  const taskAcknowledgeMatch = pathname.match(/^\/api\/study\/task\/([^/]+)\/acknowledge$/);
  if (taskAcknowledgeMatch && req.method === 'POST') {
    const refused = studySessionAdmission(deps);
    if (refused) return refused;
    if (!deps.uiReceipts) return bad(503, 'Study brief state is unavailable.');
    const taskId = decodeURIComponent(taskAcknowledgeMatch[1]!);
    if (!getStudyTask(taskId)) return bad(404, 'unknown task');
    if (registry.taskStatus(taskId) === 'locked') return bad(403, 'This session is not available yet.');
    deps.uiReceipts.record(briefReceiptKey(taskId));
    return ok({ taskId, acknowledged: true, version: STUDY_BRIEF_VERSION });
  }

  if (pathname === '/api/study/freeze' && req.method === 'POST') {
    const refused = studySessionAdmission(deps);
    if (refused) return refused;
    const body = await bodyRecord(req);
    if (!body) return bad(400, 'invalid JSON body');
    const taskId = body.taskId;
    if (typeof taskId !== 'string' || !getStudyTask(taskId)) return bad(400, 'unknown taskId');
    if (!questionnaire) return bad(503, 'Study measurement is unavailable.');
    try {
      const result = await questionnaire.freeze(taskId);
      deps.telemetry?.recordServerStageEntered('memory_questionnaire', taskId);
      return ok(result);
    } catch (error) {
      return serviceError(error);
    }
  }

  if (pathname === '/api/study/unfreeze' && req.method === 'POST') {
    if (!deps.adminKey) return bad(404, 'not found');
    if (req.headers.get('x-study-admin') !== deps.adminKey) return bad(403, 'forbidden');
    const body = await bodyRecord(req);
    if (!body) return bad(400, 'invalid JSON body');
    const taskId = body.taskId;
    if (typeof taskId !== 'string' || !getStudyTask(taskId)) return bad(400, 'unknown taskId');
    if (!questionnaire) return bad(503, 'Study measurement is unavailable.');
    try {
      questionnaire.unfreeze(taskId);
      return ok({ unfrozen: true });
    } catch (error) {
      return serviceError(error);
    }
  }

  // `/injected` remains a short compatibility alias for older clients. Both
  // routes return only the immutable public projection, never O_i/history.
  if (
    (pathname === '/api/study/questionnaire' || pathname === '/api/study/injected')
    && req.method === 'GET'
  ) {
    const refused = studySessionAdmission(deps);
    if (refused) return refused;
    const taskId = url.searchParams.get('taskId');
    if (!taskId || !getStudyTask(taskId)) return bad(400, 'taskId is required');
    if (!questionnaire) return bad(503, 'Study measurement is unavailable.');
    try {
      const result = questionnaire.get(taskId);
      if (!result.submitted) deps.telemetry?.recordServerStageEntered('memory_questionnaire', taskId);
      return ok(result);
    } catch (error) {
      return serviceError(error);
    }
  }

  if (pathname === '/api/study/quiz' && req.method === 'POST') {
    const refused = studySessionAdmission(deps);
    if (refused) return refused;
    const body = await bodyRecord(req);
    if (!body) return bad(400, 'invalid JSON body');
    const taskId = body.taskId;
    const snapshotId = body.snapshotId;
    if (typeof taskId !== 'string' || !getStudyTask(taskId)) return bad(400, 'unknown taskId');
    if (typeof snapshotId !== 'string' || !snapshotId) return bad(400, 'snapshotId is required');
    if (!questionnaire) return bad(503, 'Study measurement is unavailable.');
    try {
      deps.telemetry?.recordServerStageEntered('memory_questionnaire', taskId);
      const result = questionnaire.submit({
        taskId,
        snapshotId,
        answers: body.answers,
        attentionCheck: body.attentionCheck,
      });
      deps.telemetry?.recordServerStageEntered('monitoring_tlx', taskId);
      return ok(result);
    } catch (error) {
      return serviceError(error);
    }
  }

  if (pathname === '/api/study/post-session' && req.method === 'GET') {
    const refused = studySessionAdmission(deps);
    if (refused) return refused;
    const taskId = url.searchParams.get('taskId');
    if (!taskId || !getStudyTask(taskId)) return bad(400, 'taskId is required');
    if (!deps.survey) return bad(503, 'Study workload measurement is unavailable.');
    try {
      const result = deps.survey.get(taskId);
      if (result.requiredStep === 'monitoring_tlx' || result.requiredStep === 'control_tlx') {
        deps.telemetry?.recordServerStageEntered(result.requiredStep, taskId);
      } else if (result.requiredStep === 'sus') {
        deps.telemetry?.recordServerStageEntered('sus');
      }
      return ok(result);
    } catch (error) {
      return serviceError(error);
    }
  }

  if (pathname === '/api/study/raw-tlx' && req.method === 'POST') {
    const refused = studySessionAdmission(deps);
    if (refused) return refused;
    const body = await bodyRecord(req);
    if (!body) return bad(400, 'invalid JSON body');
    const taskId = body.taskId;
    const snapshotId = body.snapshotId;
    if (typeof taskId !== 'string' || !getStudyTask(taskId)) return bad(400, 'unknown taskId');
    if (typeof snapshotId !== 'string' || !snapshotId) return bad(400, 'snapshotId is required');
    if (!deps.survey) return bad(503, 'Study workload measurement is unavailable.');
    try {
      const before = deps.survey.get(taskId);
      if (before.requiredStep !== 'monitoring_tlx' && before.requiredStep !== 'control_tlx') {
        return bad(409, 'The requested workload stage is not open.');
      }
      deps.telemetry?.recordServerStageEntered(before.requiredStep, taskId);
      const result = await deps.survey.submitRawTlx({ taskId, snapshotId, response: body.response });
      if (result.requiredStep === 'control_tlx') {
        deps.telemetry?.recordServerStageEntered('control_tlx', taskId);
      } else if (result.requiredStep === 'sus') {
        deps.telemetry?.recordServerStageEntered('sus');
      }
      return ok(result);
    } catch (error) {
      return serviceError(error);
    }
  }

  if (pathname === '/api/study/sus' && req.method === 'POST') {
    const refused = studySessionAdmission(deps);
    if (refused) return refused;
    const body = await bodyRecord(req);
    if (!body) return bad(400, 'invalid JSON body');
    const taskId = body.taskId;
    if (typeof taskId !== 'string' || !getStudyTask(taskId)) return bad(400, 'unknown taskId');
    if (!deps.survey) return bad(503, 'Study usability measurement is unavailable.');
    try {
      deps.telemetry?.recordServerStageEntered('sus');
      return ok(deps.survey.submitSus({ taskId, response: body.response }));
    } catch (error) {
      return serviceError(error);
    }
  }

  return null;
}
