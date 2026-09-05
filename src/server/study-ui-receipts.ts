import { STUDY_BRIEF_VERSION, STUDY_GUIDE_VERSION } from "../shared/studyTasks"

export interface StudyUiReceiptReader {
  has(key: string): boolean
}

export function guideReceiptKey(): string {
  return `guide:${STUDY_GUIDE_VERSION}`
}

export function briefReceiptKey(taskId: string): string {
  return `brief:${taskId}:${STUDY_BRIEF_VERSION}`
}
