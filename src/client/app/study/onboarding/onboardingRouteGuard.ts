import { STUDY_ONBOARDING_PATH, type StudyOnboardingStage } from "./onboardingApi"

export type OnboardingRouteAccess =
  | { kind: "allow" }
  | { kind: "wait" }
  | { kind: "redirect"; to: string }

interface OnboardingRouteAccessInput {
  pathname: string
  checkedPathname: string | null
  stage: StudyOnboardingStage | null
}

/** Keep unfinished study enrollment ahead of the Guide, task, and chat UI. */
export function resolveOnboardingRouteAccess(input: OnboardingRouteAccessInput): OnboardingRouteAccess {
  if (input.checkedPathname !== input.pathname || input.stage === null) return { kind: "wait" }
  if (input.stage !== "complete") {
    return input.pathname === STUDY_ONBOARDING_PATH
      ? { kind: "allow" }
      : { kind: "redirect", to: STUDY_ONBOARDING_PATH }
  }
  return input.pathname === STUDY_ONBOARDING_PATH
    ? { kind: "redirect", to: "/guide" }
    : { kind: "allow" }
}
