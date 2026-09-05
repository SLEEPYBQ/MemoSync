// The experiment's serial gate. Canonical freeze/post-session state comes from
// study.sqlite when a lifecycle reader is available; events.jsonl remains the
// compatibility fallback for older runs. Sessions are TIME WINDOWS, not
// hand-picked chats: a
// task's window runs from the previous task's Session Completion to its own
// freeze, and everything that happened in the instance during that window
// (any chat in the task's assigned project) belongs to that task. The
// instance is per-participant and strictly serial; project admission makes
// "which project / which chat did task X" an enforced fact instead of a
// participant choice.
import { existsSync, readFileSync } from "node:fs"
import { basename } from "node:path"
import { getStudyTask, STUDY_TASKS, type StudyTaskStatus } from "../shared/studyTasks"

export interface StudyProgressEntry {
  id: string
  title: string
  status: StudyTaskStatus
}

export type StudyFreezeState = "open" | "freezing" | "frozen"

/** Minimal canonical lifecycle reader implemented by StudyMemoryStore. */
export interface StudyLifecycleReader {
  getTaskFreezeSnapshot(taskId: string): { snapshotId: string; frozenAt: string } | null
  getQuestionnaireSubmission(snapshotId: string): { submittedAt: string } | null
  getSessionCompletion(taskId: string): { completedAt: string } | null
  getSusSubmission(): { submittedAt: string } | null
}

/** Optional counterbalancing: STUDY_TASK_ORDER="098-S1,098-S2,038-S1,038-S2".
 *  Unknown ids are dropped, missing ids append in catalog order. */
export function resolveStudyOrder(env: string | undefined = process.env.STUDY_TASK_ORDER): string[] {
  const known = STUDY_TASKS.map((task) => task.id)
  const requested = (env ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => known.includes(id))
  return [...requested, ...known.filter((id) => !requested.includes(id))]
}

export class StudyRegistry {
  private readonly order: string[]
  /** taskId → ISO ts of its study.freeze (the window's end). */
  private readonly frozenAtByTask = new Map<string, string>()
  /** taskId → ISO ts when D/A/E and both Raw TLX blocks were submitted. */
  private readonly completedAtByTask = new Map<string, string>()
  private susSubmittedAt: string | null = null
  /** In-process reservation held while the freeze barrier and snapshot run. */
  private readonly freezingTasks = new Set<string>()
  /** taskId -> treatment-memory HTTP mutations admitted before freeze. */
  private readonly memoryMutationsByTask = new Map<string, number>()

  constructor(
    eventsPath?: string,
    order: string[] = resolveStudyOrder(),
    lifecycle?: StudyLifecycleReader,
  ) {
    this.order = order
    if (eventsPath && existsSync(eventsPath)) {
      for (const line of readFileSync(eventsPath, "utf8").split("\n")) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line) as { type?: string; ts?: string; taskId?: string }
          if (typeof event.taskId !== "string") continue
          const ts = typeof event.ts === "string" ? event.ts : new Date(0).toISOString()
          if (event.type === "study.freeze") this.noteFreeze(event.taskId, ts)
          else if (event.type === "study.unfreeze") this.noteUnfreeze(event.taskId)
          else if (event.type === "study.session.complete") this.noteSessionComplete(event.taskId, ts)
          // Compatibility for pre-workload runs. Canonical SQLite recovery
          // below clears this legacy completion when a freeze snapshot exists.
          else if (event.type === "quiz.submit") this.noteSessionComplete(event.taskId, ts)
          else if (event.type === "study.sus.submit") this.noteSusSubmit(ts)
        } catch {
          // Torn tail line — never let it break the gate.
        }
      }
    }
    if (lifecycle) this.recoverCanonicalLifecycle(lifecycle)
  }

  private recoverCanonicalLifecycle(lifecycle: StudyLifecycleReader): void {
    for (const taskId of this.order) {
      const snapshot = lifecycle.getTaskFreezeSnapshot(taskId)
      if (!snapshot) continue
      this.freezingTasks.delete(taskId)
      this.frozenAtByTask.set(taskId, snapshot.frozenAt)
      // A canonical snapshot makes SQLite authoritative for this task. Remove a
      // legacy JSONL completion unless the canonical completion also exists.
      this.completedAtByTask.delete(taskId)
      const completion = lifecycle.getSessionCompletion(taskId)
      if (completion) this.completedAtByTask.set(taskId, completion.completedAt)
    }
    this.susSubmittedAt = lifecycle.getSusSubmission()?.submittedAt ?? null
  }

  noteFreeze(taskId: string, ts: string = new Date().toISOString()): void {
    this.freezingTasks.delete(taskId)
    if (!this.frozenAtByTask.has(taskId)) this.frozenAtByTask.set(taskId, ts)
  }

  freezeState(taskId: string): StudyFreezeState | null {
    if (!this.order.includes(taskId)) return null
    if (this.frozenAtByTask.has(taskId)) return "frozen"
    return this.freezingTasks.has(taskId) ? "freezing" : "open"
  }

  /** Atomically reserve the current task before any asynchronous freeze work. */
  beginFreeze(taskId: string): boolean {
    if (this.taskStatus(taskId) !== "active" || this.freezeState(taskId) !== "open") return false
    if ((this.memoryMutationsByTask.get(taskId) ?? 0) > 0) return false
    this.freezingTasks.add(taskId)
    return true
  }

  /**
   * Reserve one participant-facing treatment-memory mutation. The synchronous
   * admission point and beginFreeze() form a small read/write gate: whichever
   * starts first wins, so a request cannot cross the immutable session edge.
   */
  beginTreatmentMemoryMutation(): (() => void) | null {
    const taskId = this.activeTaskId()
    if (!taskId || this.freezeState(taskId) !== "open") return null
    this.memoryMutationsByTask.set(taskId, (this.memoryMutationsByTask.get(taskId) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const remaining = (this.memoryMutationsByTask.get(taskId) ?? 1) - 1
      if (remaining > 0) this.memoryMutationsByTask.set(taskId, remaining)
      else this.memoryMutationsByTask.delete(taskId)
    }
  }

  hasTreatmentMemoryMutation(taskId: string): boolean {
    return (this.memoryMutationsByTask.get(taskId) ?? 0) > 0
  }

  /** Release a failed in-process freeze reservation so work can resume/retry. */
  cancelFreeze(taskId: string): boolean {
    return this.freezingTasks.delete(taskId)
  }

  /** Experimenter escape hatch: reopen an accidentally ended session. */
  noteUnfreeze(taskId: string): void {
    this.freezingTasks.delete(taskId)
    this.frozenAtByTask.delete(taskId)
  }

  noteSessionComplete(taskId: string, ts: string = new Date().toISOString()): void {
    this.freezingTasks.delete(taskId)
    this.completedAtByTask.set(taskId, ts)
  }

  noteSusSubmit(ts: string = new Date().toISOString()): void {
    this.susSubmittedAt = ts
  }

  /** The one task currently open for work/quiz, or null when all are done. */
  activeTaskId(): string | null {
    return this.order.find((id) => !this.completedAtByTask.has(id)) ?? null
  }

  /** The next serial task after `taskId`, independent of its current lock state. */
  nextTaskIdAfter(taskId: string): string | null {
    const index = this.order.indexOf(taskId)
    return index >= 0 ? this.order[index + 1] ?? null : null
  }

  taskStatus(taskId: string): StudyTaskStatus | null {
    if (!this.order.includes(taskId)) return null
    if (this.completedAtByTask.has(taskId)) return "completed"
    return this.activeTaskId() === taskId ? "active" : "locked"
  }

  /** The active window's start: the latest completion ts, or null at study start. */
  windowStart(): string | null {
    let latest: string | null = null
    for (const ts of this.completedAtByTask.values()) {
      if (latest === null || ts > latest) latest = ts
    }
    return latest
  }

  /**
   * Resolve one durable event timestamp to its serial task window. The task
   * ends at freeze; questionnaire time between freeze and Session Completion
   * belongs to no task. An open active task has no end yet.
   */
  taskWindowAt(timestampMs: number): { taskId: string; startAt: number; endAt: number | null } | null {
    if (!Number.isFinite(timestampMs)) return null
    let startAt = Number.NEGATIVE_INFINITY
    for (const taskId of this.order) {
      const frozenAt = this.frozenAtByTask.get(taskId)
      const endAt = frozenAt ? Date.parse(frozenAt) : null
      if (endAt !== null && Number.isFinite(endAt)) {
        if (timestampMs >= startAt && timestampMs <= endAt) return { taskId, startAt, endAt }
      } else if (this.taskStatus(taskId) === "active" && timestampMs >= startAt) {
        return { taskId, startAt, endAt: null }
      }

      const completedAt = this.completedAtByTask.get(taskId)
      if (!completedAt) break
      const nextStart = Date.parse(completedAt)
      if (!Number.isFinite(nextStart)) break
      startAt = nextStart
    }
    return null
  }

  frozenAt(taskId: string): string | undefined {
    return this.frozenAtByTask.get(taskId)
  }

  /** The active task has frozen and still has required post-session measures. */
  questionnairePending(): boolean {
    const active = this.activeTaskId()
    return active !== null && this.frozenAtByTask.has(active)
  }

  postSessionPending(): boolean {
    return this.questionnairePending()
  }

  susPending(): boolean {
    return this.activeTaskId() === null && this.susSubmittedAt === null
  }

  studyComplete(): boolean {
    return this.activeTaskId() === null && this.susSubmittedAt !== null
  }

  progress(): StudyProgressEntry[] {
    const titles = new Map(STUDY_TASKS.map((task) => [task.id, task.title]))
    return this.order.map((id) => ({
      id,
      title: titles.get(id) ?? id,
      status: this.taskStatus(id) ?? "locked",
    }))
  }

  /**
   * The study-arm prompt gate: a participant-readable refusal, or null when
   * the prompt may proceed. `chatCreatedAtMs` is the target chat's creation
   * time — chats born before the current window belong to a completed
   * session and stay read-only forever. `projectLocalPath`, when supplied by
   * the server admission layer, must match the active task's assigned project.
   */
  promptRefusal(chatCreatedAtMs?: number, projectLocalPath?: string): string | null {
    const active = this.activeTaskId()
    if (active === null) {
      return this.studyComplete()
        ? "The study is complete. Please let the experimenter know."
        : "All sessions are complete. Please finish the final usability questions."
    }
    if (this.freezingTasks.has(active)) {
      return "The current session is ending. Please wait for the end-of-session questions."
    }
    if (this.frozenAtByTask.has(active)) {
      return "The current session has ended. Please finish the end-of-session questions first."
    }
    const start = this.windowStart()
    if (chatCreatedAtMs !== undefined && start !== null && chatCreatedAtMs < Date.parse(start)) {
      return "This chat belongs to a completed session and is read-only. Please start a new chat for the current task."
    }
    if (projectLocalPath !== undefined) {
      const task = getStudyTask(active)
      const projectSlug = basename(projectLocalPath.replace(/[\\/]+$/, ""))
      if (task && projectSlug !== task.projectSlug) {
        return `This session must be completed in the ${task.projectTitle} project. Open the task brief and use its Start button.`
      }
    }
    return null
  }
}
